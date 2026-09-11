/**
 * The mini-SFU that runs inside the host process (docs/DESIGN.md section 8.4).
 *
 * Topology: one werift RTCPeerConnection per publisher (peer -> SFU), one per
 * subscription (SFU -> subscriber). RTP is forwarded packet-for-packet from a
 * publisher's inbound track to each subscriber's outbound track - no decode, no
 * re-encode (the spike in docs/SPIKE-SFU.md showed this sustains the load).
 *
 * Selective forwarding (section 8.5): a publisher stream with zero subscribers
 * has no outbound PCs, so nothing is forwarded. The "tell the publisher to stop
 * encoding" half is added with the governor in a later checkpoint.
 *
 * Negotiation is non-trickle: each side gathers ICE candidates before it sends
 * its SDP. The peer is the offerer for publishing; the SFU is the offerer for
 * subscribing.
 */

import { EventEmitter } from 'node:events';
import {
  MediaStreamTrack,
  RTCPeerConnection,
  type RTCIceServer,
  type RtpPacket,
} from 'werift';
import { AUDIO_CODECS, VIDEO_CODECS } from './codecs.js';
import type { StreamInfo } from '../../shared/protocol.js';

export class SfuError extends Error {
  override name = 'SfuError';
}

export interface SfuOptions {
  readonly iceServers?: RTCIceServer[];
  /** the host's public IPv4, added as an ICE host candidate when behind NAT */
  readonly announceIp?: string;
  readonly udpPortRange?: readonly [number, number];
}

export interface SfuRouterEvents {
  'stream-live': [StreamInfo];
  'stream-ended': [{ streamId: string }];
  /** subscriber count for a stream crossed 0<->1 - the owner should
   *  start/stop encoding (selective forwarding, docs/DESIGN.md 8.5) */
  'demand-changed': [{ streamId: string; ownerPeerId: string; subscribers: number }];
  error: [Error];
}

type Kind = 'video' | 'audio';

/** min gap between PLIs forwarded to one publisher (docs/DESIGN.md 8.4:
 *  "no máximo 1 por segundo por fluxo") - several subscribers requesting a
 *  keyframe around the same time must not flood the publisher. */
const PLI_MIN_INTERVAL_MS = 1000;

interface Publisher {
  readonly pc: RTCPeerConnection;
  readonly info: StreamInfo;
  readonly tracks: Partial<Record<Kind, MediaStreamTrack>>;
  lastPliAt: number;
}

interface Subscription {
  readonly pc: RTCPeerConnection;
  readonly disposers: Array<() => void>;
}

function subKey(peerId: string, streamId: string): string {
  return `${peerId}::${streamId}`;
}

export class SfuRouter extends EventEmitter<SfuRouterEvents> {
  readonly #opts: SfuOptions;
  readonly #publishers = new Map<string, Publisher>();
  readonly #subscriptions = new Map<string, Subscription>();
  #closed = false;

  constructor(opts: SfuOptions = {}) {
    super();
    this.#opts = opts;
  }

  #newPc(): RTCPeerConnection {
    return new RTCPeerConnection({
      codecs: { video: VIDEO_CODECS, audio: AUDIO_CODECS },
      ...(this.#opts.iceServers ? { iceServers: this.#opts.iceServers } : {}),
      ...(this.#opts.announceIp ? { iceAdditionalHostAddresses: [this.#opts.announceIp] } : {}),
      ...(this.#opts.udpPortRange
        ? { icePortRange: [...this.#opts.udpPortRange] as [number, number] }
        : {}),
      bundlePolicy: 'max-bundle',
    });
  }

  // --- publish (peer offers, SFU answers) ------------------------------

  async publish(
    ownerPeerId: string,
    streamId: string,
    offerSdp: string,
    kinds: { video: boolean; audio: boolean },
  ): Promise<{ answerSdp: string }> {
    if (this.#closed) throw new SfuError('sfu closed');
    if (this.#publishers.has(streamId)) {
      throw new SfuError(`stream ${streamId} already published`);
    }

    const pc = this.#newPc();
    const tracks: Publisher['tracks'] = {};
    const info: StreamInfo = {
      streamId,
      ownerPeerId,
      video: kinds.video,
      audio: kinds.audio,
    };

    pc.onTrack.subscribe((track) => {
      tracks[track.kind as Kind] = track;
    });

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await gatheringComplete(pc);
    } catch (err) {
      pc.close();
      throw new SfuError(`publish negotiation failed: ${(err as Error).message}`);
    }

    pc.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.unpublish(streamId);
      }
    });

    this.#publishers.set(streamId, { pc, info, tracks, lastPliAt: 0 });
    this.emit('stream-live', info);
    return { answerSdp: mustSdp(pc) };
  }

  unpublish(streamId: string): void {
    const pub = this.#publishers.get(streamId);
    if (!pub) return;
    this.#publishers.delete(streamId);
    for (const [key, sub] of this.#subscriptions) {
      if (key.endsWith(`::${streamId}`)) this.#dropSubscription(key, sub);
    }
    safeClose(pub.pc);
    this.emit('stream-ended', { streamId });
  }

  // --- subscribe (SFU offers, peer answers) ---------------------------

  async subscribe(
    subscriberPeerId: string,
    streamId: string,
  ): Promise<{ offerSdp: string }> {
    if (this.#closed) throw new SfuError('sfu closed');
    const pub = this.#publishers.get(streamId);
    if (!pub) throw new SfuError(`no such stream: ${streamId}`);

    const key = subKey(subscriberPeerId, streamId);
    if (this.#subscriptions.has(key)) {
      throw new SfuError('already subscribed');
    }

    const pc = this.#newPc();
    const disposers: Array<() => void> = [];
    let videoTransceiver: ReturnType<RTCPeerConnection['addTransceiver']> | undefined;

    for (const kind of ['video', 'audio'] as const) {
      const source = pub.tracks[kind];
      if (!source) continue;
      const relay = new MediaStreamTrack({ kind });
      const transceiver = pc.addTransceiver(relay, { direction: 'sendonly' });
      if (kind === 'video') videoTransceiver = transceiver;
      const rtpSub = source.onReceiveRtp.subscribe((rtp: RtpPacket) => {
        try {
          relay.writeRtp(rtp);
        } catch {
          /* subscriber PC gone or not ready yet */
        }
      });
      disposers.push(() => unsub(rtpSub));
    }

    if (disposers.length === 0) {
      pc.close();
      throw new SfuError('stream has no forwardable tracks yet');
    }

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await gatheringComplete(pc);
    } catch (err) {
      pc.close();
      for (const d of disposers) d();
      throw new SfuError(`subscribe offer failed: ${(err as Error).message}`);
    }

    // Forward this subscriber's own keyframe requests to the publisher too
    // (docs/DESIGN.md 8.4) - belt-and-braces in case the connect-time PLI
    // below still gets lost, or the subscriber's decoder needs a fresh one
    // later (e.g. after a network blip).
    if (videoTransceiver) {
      const pliSub = videoTransceiver.sender.onPictureLossIndication.subscribe(() => {
        this.#requestKeyframe(pub);
      });
      disposers.push(() => unsub(pliSub));
    }

    pc.connectionStateChange.subscribe((state) => {
      if (state === 'connected') {
        // Only NOW is it safe to ask the publisher for a keyframe: asking any
        // earlier (e.g. right after subscribe(), as this used to) races this
        // subscriber's own ICE/DTLS setup - a keyframe that arrives at the
        // SFU before this PC can carry it is silently dropped, and the
        // subscriber is left with only delta frames (nothing to decode)
        // until the encoder's next spontaneous keyframe, which for mostly
        // static screen-share content can be minutes away or never.
        this.#requestKeyframe(pub);
      } else if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.unsubscribe(subscriberPeerId, streamId);
      }
    });

    this.#subscriptions.set(key, { pc, disposers });
    this.#emitDemand(streamId, pub.info.ownerPeerId);
    return { offerSdp: mustSdp(pc) };
  }

  /** Ask the publisher for a fresh keyframe, rate-limited per stream. */
  #requestKeyframe(pub: Publisher): void {
    const source = pub.tracks.video;
    if (!source) return;
    const now = Date.now();
    if (now - pub.lastPliAt < PLI_MIN_INTERVAL_MS) return;
    pub.lastPliAt = now;

    const send = (ssrc: number) => {
      try {
        pub.pc.getTransceivers().forEach((t) => {
          if (t.receiver.track?.kind === 'video') void t.receiver.sendRtcpPLI(ssrc);
        });
      } catch {
        /* best effort */
      }
    };
    if (source.ssrc) send(source.ssrc);
    else source.onReceiveRtp.once((rtp: RtpPacket) => send(source.ssrc ?? rtp.header.ssrc));
  }

  #emitDemand(streamId: string, ownerPeerId: string): void {
    this.emit('demand-changed', {
      streamId,
      ownerPeerId,
      subscribers: this.subscriberCount(streamId),
    });
  }

  async completeSubscribe(
    subscriberPeerId: string,
    streamId: string,
    answerSdp: string,
  ): Promise<void> {
    const sub = this.#subscriptions.get(subKey(subscriberPeerId, streamId));
    if (!sub) throw new SfuError('no pending subscription');
    await sub.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  unsubscribe(subscriberPeerId: string, streamId: string): void {
    const key = subKey(subscriberPeerId, streamId);
    const sub = this.#subscriptions.get(key);
    if (!sub) return;
    this.#dropSubscription(key, sub);
    const pub = this.#publishers.get(streamId);
    if (pub) this.#emitDemand(streamId, pub.info.ownerPeerId);
  }

  #dropSubscription(key: string, sub: Subscription): void {
    this.#subscriptions.delete(key);
    for (const dispose of sub.disposers) dispose();
    safeClose(sub.pc);
  }

  // --- lifecycle ----------------------------------------------------

  /** Drop a peer's publisher stream and every subscription it holds. */
  removePeer(peerId: string): void {
    for (const [streamId, pub] of this.#publishers) {
      if (pub.info.ownerPeerId === peerId) this.unpublish(streamId);
    }
    const touched = new Set<string>();
    for (const [key, sub] of this.#subscriptions) {
      if (key.startsWith(`${peerId}::`)) {
        this.#dropSubscription(key, sub);
        touched.add(key.slice(peerId.length + 2));
      }
    }
    for (const streamId of touched) {
      const pub = this.#publishers.get(streamId);
      if (pub) this.#emitDemand(streamId, pub.info.ownerPeerId);
    }
  }

  listStreams(): StreamInfo[] {
    return [...this.#publishers.values()].map((p) => p.info);
  }

  subscriberCount(streamId: string): number {
    let n = 0;
    for (const key of this.#subscriptions.keys()) {
      if (key.endsWith(`::${streamId}`)) n++;
    }
    return n;
  }

  close(): void {
    this.#closed = true;
    for (const [key, sub] of this.#subscriptions) this.#dropSubscription(key, sub);
    for (const pub of this.#publishers.values()) safeClose(pub.pc);
    this.#publishers.clear();
  }
}

function mustSdp(pc: RTCPeerConnection): string {
  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new SfuError('no local description after negotiation');
  return sdp;
}

/**
 * werift's `Event.subscribe()` returns `{ unSubscribe, disposer }` (capital
 * S) - NOT the `unsubscribe` spelling this checked for previously, which
 * made every disposer built from it a silent no-op. That leaked the
 * publisher-side `onReceiveRtp` listener for the lifetime of the publisher:
 * a subscriber that unsubscribed (or whose PC failed/closed) kept getting
 * `relay.writeRtp(rtp)` called on its now-closed track forever, alongside
 * every other listener that piled up the same way. Accepts a plain disposer
 * function too, for non-werift subscriptions.
 */
function unsub(subscription: unknown): void {
  const s = subscription as { unSubscribe?: () => void } | (() => void);
  if (typeof s === 'function') s();
  else if (s && typeof s.unSubscribe === 'function') s.unSubscribe();
}

function safeClose(pc: RTCPeerConnection): void {
  try {
    pc.close();
  } catch {
    /* already closed */
  }
}

/** Resolve once ICE candidate gathering has finished (non-trickle). */
function gatheringComplete(pc: RTCPeerConnection, timeoutMs = 3000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    const subscription = pc.iceGatheringStateChange.subscribe((state: string) => {
      if (state === 'complete') finish();
    });
    function finish(): void {
      clearTimeout(timer);
      unsub(subscription);
      resolve();
    }
  });
}
