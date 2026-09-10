/**
 * Wire protocol for the control plane (docs/DESIGN.md section 7).
 *
 * Every message that arrives from the network is parsed with these zod schemas
 * BEFORE it reaches any logic. This is a security control, not a convenience:
 * an unparseable or out-of-shape message is a fatal protocol error.
 *
 * Two phases:
 *   1. Handshake (messages 1-5) travel as plaintext JSON over ws text frames.
 *      CPace is designed to run in the clear.
 *   2. Everything after `pake_confirm` travels inside AES-256-GCM frames
 *      (see src/main/net/frame-codec.ts) as ws binary frames. Those payloads
 *      are the `Envelope` below.
 */

import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const APP_VERSION = '0.1.0';

const hex = (bytes: number) =>
  z
    .string()
    .regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`), `expected ${bytes}-byte hex`);

const hexVar = z.string().regex(/^[0-9a-f]*$/).max(4096);

export const argonParamsSchema = z.object({
  m: z.number().int().positive(),
  t: z.number().int().positive(),
  p: z.number().int().positive(),
});
export type ArgonParamsWire = z.infer<typeof argonParamsSchema>;

// --- Handshake (plaintext) -------------------------------------------------

export const helloSchema = z.object({
  type: z.literal('hello'),
  appVersion: z.string().max(32),
  protoVersion: z.number().int(),
  roomId: hex(4),
});

export const helloAckSchema = z.object({
  type: z.literal('hello_ack'),
  protoVersion: z.number().int(),
  sid: hex(16),
  argonParams: argonParamsSchema,
});

export const pakePeerSchema = z.object({
  type: z.literal('pake_peer'),
  ya: hex(32),
});

export const pakeHostSchema = z.object({
  type: z.literal('pake_host'),
  yb: hex(32),
  macHost: hex(32),
});

export const pakeConfirmSchema = z.object({
  type: z.literal('pake_confirm'),
  macPeer: hex(32),
});

/** Sent in the clear when the handshake cannot even begin. */
export const handshakeRejectSchema = z.object({
  type: z.literal('handshake_reject'),
  reason: z.enum([
    'room_id_mismatch',
    'version_mismatch',
    'rate_limited',
    'too_many_handshakes',
    'room_closing',
    'bad_message',
  ]),
});

export const handshakeMessageSchema = z.discriminatedUnion('type', [
  helloSchema,
  helloAckSchema,
  pakePeerSchema,
  pakeHostSchema,
  pakeConfirmSchema,
  handshakeRejectSchema,
]);
export type HandshakeMessage = z.infer<typeof handshakeMessageSchema>;

// --- Encrypted envelope --------------------------------------------------

export const roomParamsSchema = z.object({
  maxParticipants: z.number().int().positive(),
  maxRecommendedSubscriptions: z.number().int().positive(),
  videoBitrateKbps: z.number().int().positive(),
});
export type RoomParams = z.infer<typeof roomParamsSchema>;

export const publishingSchema = z.object({
  video: z.boolean(),
  audio: z.boolean(),
  streamId: z.string().max(64),
});

export const inboundEndpointSchema = z.object({
  address: z.string().max(64),
  port: z.number().int().min(1).max(65535),
});
export type InboundEndpoint = z.infer<typeof inboundEndpointSchema>;

export const rosterEntrySchema = z.object({
  peerId: z.string().max(64),
  nickname: z.string().max(48),
  joinSeq: z.number().int().nonnegative(),
  isHost: z.boolean(),
  inboundVerified: z.boolean(),
  /** where the host could reach this peer's own listener (for succession) */
  inboundEndpoint: inboundEndpointSchema.nullable(),
  publishing: publishingSchema.nullable(),
});
export type RosterEntry = z.infer<typeof rosterEntrySchema>;

export const joinSchema = z.object({
  type: z.literal('join'),
  nickname: z.string().min(1).max(48),
  clientCaps: z.object({
    canHost: z.boolean(),
    inboundPort: z.number().int().min(0).max(65535),
  }),
});

/** A stream currently published in the room. */
export const streamInfoSchema = z.object({
  streamId: z.string().min(1).max(64),
  ownerPeerId: z.string().max(64),
  video: z.boolean(),
  audio: z.boolean(),
});
export type StreamInfo = z.infer<typeof streamInfoSchema>;

export const joinedSchema = z.object({
  type: z.literal('joined'),
  peerId: z.string().max(64),
  joinSeq: z.number().int().nonnegative(),
  /** host generation; a peer rejects a `joined` whose epoch <= what it knows */
  epoch: z.number().int().nonnegative(),
  roomParams: roomParamsSchema,
  roster: z.array(rosterEntrySchema).max(64),
  streams: z.array(streamInfoSchema).max(64),
});

/** Graceful handoff: the host is leaving and names its successor. */
export const hostTransferSchema = z.object({
  type: z.literal('host_transfer'),
  successorPeerId: z.string().max(64),
  epoch: z.number().int().nonnegative(),
});

export const rosterUpdateSchema = z.object({
  type: z.literal('roster_update'),
  added: z.array(rosterEntrySchema).max(64),
  removed: z.array(z.string().max(64)).max(64),
  changed: z.array(rosterEntrySchema).max(64),
});

export const rejectedSchema = z.object({
  type: z.literal('rejected'),
  reason: z.enum(['room_full', 'duplicate_nickname', 'room_closing', 'bad_message']),
});

export const pingSchema = z.object({
  type: z.literal('ping'),
  nonce: z.number().int(),
  sentAt: z.number(),
});
export const pongSchema = z.object({
  type: z.literal('pong'),
  nonce: z.number().int(),
  sentAt: z.number(),
});

export const byeSchema = z.object({
  type: z.literal('bye'),
  reason: z.string().max(120),
});

// --- Media negotiation (docs/DESIGN.md section 7.3) -------------------
//
// Non-trickle ICE: each side gathers candidates before sending its SDP, so
// there are no separate ICE-candidate messages yet. The peer is always the
// offerer for publishing; the host (SFU) is always the offerer for subscribing.

const SDP = z.string().min(1).max(60_000);

/** peer -> host: I want to publish; here is my offer. streamId is peer-chosen. */
export const publishOfferSchema = z.object({
  type: z.literal('publish_offer'),
  streamId: z.string().min(1).max(64),
  video: z.boolean(),
  audio: z.boolean(),
  sdp: SDP,
});
export const publishAnswerSchema = z.object({
  type: z.literal('publish_answer'),
  streamId: z.string().min(1).max(64),
  sdp: SDP,
});
export const unpublishSchema = z.object({
  type: z.literal('unpublish'),
  streamId: z.string().min(1).max(64),
});

/** peer -> host: start sending me this stream. */
export const subscribeSchema = z.object({
  type: z.literal('subscribe'),
  streamId: z.string().min(1).max(64),
});
/** host -> peer: here is the SFU's offer for the stream you asked for. */
export const subscribeOfferSchema = z.object({
  type: z.literal('subscribe_offer'),
  streamId: z.string().min(1).max(64),
  sdp: SDP,
});
export const subscribeAnswerSchema = z.object({
  type: z.literal('subscribe_answer'),
  streamId: z.string().min(1).max(64),
  sdp: SDP,
});
export const unsubscribeSchema = z.object({
  type: z.literal('unsubscribe'),
  streamId: z.string().min(1).max(64),
});

/** host -> everyone: a stream started or ended. */
export const streamStateSchema = z.object({
  type: z.literal('stream_state'),
  stream: streamInfoSchema,
  state: z.enum(['live', 'ended']),
});

/** host -> peer: media negotiation failed; drop the local PC for this stream. */
export const mediaErrorSchema = z.object({
  type: z.literal('media_error'),
  streamId: z.string().min(1).max(64),
  reason: z.string().max(160),
});

/**
 * host -> the publishing peer: encode this stream at most this hard.
 * `maxKbps: 0` means "nobody is watching, stop sending". The peer applies it
 * via RTCRtpSender parameters / replaceTrack.
 */
export const qualityDirectiveSchema = z.object({
  type: z.literal('quality_directive'),
  streamId: z.string().min(1).max(64),
  maxKbps: z.number().int().min(0).max(20_000),
  maxFps: z.number().int().min(0).max(120),
  /** RTCRtpEncodingParameters.scaleResolutionDownBy (>= 1) */
  scaleDownBy: z.number().min(1).max(8),
  reason: z.enum(['no_viewers', 'restored', 'bandwidth', 'cpu']),
});

/** peer -> host: periodic quality telemetry for the governor (section 8.5). */
export const statsReportSchema = z.object({
  type: z.literal('stats_report'),
  subscriptions: z
    .array(
      z.object({
        streamId: z.string().min(1).max(64),
        fractionLost: z.number().min(0).max(1),
        jitterMs: z.number().min(0).max(10_000),
        rttMs: z.number().min(0).max(10_000),
        fps: z.number().min(0).max(240),
      }),
    )
    .max(32),
  publications: z
    .array(
      z.object({
        streamId: z.string().min(1).max(64),
        /** 1 when Chromium reports qualityLimitationReason === 'cpu' */
        cpuPressure: z.number().min(0).max(1),
        fps: z.number().min(0).max(240),
      }),
    )
    .max(8),
});

export const bodySchema = z.discriminatedUnion('type', [
  joinSchema,
  joinedSchema,
  hostTransferSchema,
  rosterUpdateSchema,
  rejectedSchema,
  pingSchema,
  pongSchema,
  byeSchema,
  publishOfferSchema,
  publishAnswerSchema,
  unpublishSchema,
  subscribeSchema,
  subscribeOfferSchema,
  subscribeAnswerSchema,
  unsubscribeSchema,
  streamStateSchema,
  mediaErrorSchema,
  qualityDirectiveSchema,
  statsReportSchema,
]);
export type Body = z.infer<typeof bodySchema>;

export const envelopeSchema = z.object({
  v: z.number().int(),
  epoch: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  from: z.string().max(64),
  body: bodySchema,
});
export type Envelope = z.infer<typeof envelopeSchema>;

export function parseJson<T>(schema: z.ZodType<T>, raw: string): T {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new ProtocolError('message is not valid JSON');
  }
  const result = schema.safeParse(obj);
  if (!result.success) {
    throw new ProtocolError(`message failed schema: ${result.error.message}`);
  }
  return result.data;
}

export class ProtocolError extends Error {
  override name = 'ProtocolError';
}
