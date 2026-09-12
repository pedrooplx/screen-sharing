/**
 * The relay's own wire format. It multiplexes many peer<->host control-plane
 * connections over two physical WebSockets (the host's, and one per peer). The
 * relay NEVER looks inside a payload - CPace and the AES-256-GCM frames flow
 * through opaque.
 *
 * Every relay message is binary with a 1-byte type prefix.
 *   0x01 HELLO      client->relay, first message, rest is JSON
 *   0x02 READY      relay->client, rest is JSON
 *   0x03 REJECT     relay->client (then close), rest is JSON {reason}
 *   0x04 PEER_UP    relay->host, JSON {connId}
 *   0x05 PEER_DOWN  relay->host, JSON {connId}
 *   0x06 HOST_GONE  relay->peer (then close)
 *   0x07 KICK       host->relay:   [0x07][connId u32 BE]  (drop one peer)
 *   0x08 HANDOFF    host->relay, no body (graceful "I'm about to leave, hold
 *                   this room open for a successor" - see Relay#onHandoff)
 *   0x10 DATA_H     host<->relay:  [0x10][connId u32 BE][isBinary u8][payload]
 *   0x11 DATA_P     peer<->relay:  [0x11][isBinary u8][payload]
 *   0x20 PING / 0x21 PONG   either direction, no body (relay-level keep-alive)
 */

import { z } from 'zod';

export const RELAY_PROTOCOL_VERSION = 1;

export const T = {
  HELLO: 0x01,
  READY: 0x02,
  REJECT: 0x03,
  PEER_UP: 0x04,
  PEER_DOWN: 0x05,
  HOST_GONE: 0x06,
  KICK: 0x07,
  HANDOFF: 0x08,
  DATA_H: 0x10,
  DATA_P: 0x11,
  PING: 0x20,
  PONG: 0x21,
} as const;

export const helloSchema = z.object({
  role: z.enum(['host', 'peer']),
  roomId: z.string().regex(/^[0-9a-f]{8}$/),
  app: z.string().max(32),
  proto: z.number().int(),
  hostToken: z.string().max(64).optional(),
});
export type Hello = z.infer<typeof helloSchema>;

export type RejectReason =
  | 'room_exists'
  | 'no_such_room'
  | 'host_absent'
  | 'room_full'
  | 'rate_limited'
  | 'bad_hello'
  | 'proto_mismatch'
  | 'server_full';

export function decodeHello(buf: Buffer): Hello | null {
  if (buf.length < 2 || buf[0] !== T.HELLO) return null;
  try {
    const parsed = helloSchema.safeParse(JSON.parse(buf.subarray(1).toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function jsonFrame(type: number, obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  return Buffer.concat([Buffer.from([type]), body]);
}

export const ready = (obj: { connId?: number; hostToken?: string }) =>
  jsonFrame(T.READY, obj);
export const reject = (reason: RejectReason) => jsonFrame(T.REJECT, { reason });
export const peerUp = (connId: number) => jsonFrame(T.PEER_UP, { connId });
export const peerDown = (connId: number) => jsonFrame(T.PEER_DOWN, { connId });
export const hostGone = () => Buffer.from([T.HOST_GONE]);
export const pong = () => Buffer.from([T.PONG]);

/** host -> relay -> peer: strip the connId, deliver as DATA_P */
export function decodeDataFromHost(
  buf: Buffer,
): { connId: number; isBinary: boolean; payload: Buffer } | null {
  if (buf.length < 6 || buf[0] !== T.DATA_H) return null;
  return {
    connId: buf.readUInt32BE(1),
    isBinary: buf[5] === 1,
    payload: buf.subarray(6),
  };
}

/** peer -> relay -> host: add the connId, deliver as DATA_H */
export function decodeDataFromPeer(
  buf: Buffer,
): { isBinary: boolean; payload: Buffer } | null {
  if (buf.length < 2 || buf[0] !== T.DATA_P) return null;
  return { isBinary: buf[1] === 1, payload: buf.subarray(2) };
}

export function dataToPeer(isBinary: boolean, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([T.DATA_P, isBinary ? 1 : 0]), payload]);
}

export function dataToHost(
  connId: number,
  isBinary: boolean,
  payload: Buffer,
): Buffer {
  const head = Buffer.alloc(6);
  head[0] = T.DATA_H;
  head.writeUInt32BE(connId, 1);
  head[5] = isBinary ? 1 : 0;
  return Buffer.concat([head, payload]);
}

export function kick(connId: number): Buffer {
  const b = Buffer.alloc(5);
  b[0] = T.KICK;
  b.writeUInt32BE(connId, 1);
  return b;
}

export function decodeKick(buf: Buffer): number | null {
  if (buf.length < 5 || buf[0] !== T.KICK) return null;
  return buf.readUInt32BE(1);
}

export function isHandoff(buf: Buffer): boolean {
  return buf.length >= 1 && buf[0] === T.HANDOFF;
}
