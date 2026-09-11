/**
 * Client half of the relay wire format. The server half lives in
 * `server/src/wire.ts` - the two are deliberately kept in sync by hand (a
 * frozen ~100-line framing) and `test/relay/wire-compat.test.ts` asserts they
 * agree byte for byte. Duplicating it keeps `server/` a standalone deployable.
 *
 * See server/src/wire.ts for the message table.
 */

export const RELAY_PROTOCOL_VERSION = 1;

export const T = {
  HELLO: 0x01,
  READY: 0x02,
  REJECT: 0x03,
  PEER_UP: 0x04,
  PEER_DOWN: 0x05,
  HOST_GONE: 0x06,
  KICK: 0x07,
  DATA_H: 0x10,
  DATA_P: 0x11,
  PING: 0x20,
  PONG: 0x21,
} as const;

export type RelayRole = 'host' | 'peer';

export interface RelayHelloFields {
  readonly role: RelayRole;
  readonly roomId: string; // 8 hex chars
  readonly app: string;
  readonly hostToken?: string;
}

export function encodeHello(f: RelayHelloFields): Buffer {
  const body = Buffer.from(
    JSON.stringify({
      role: f.role,
      roomId: f.roomId,
      app: f.app,
      proto: RELAY_PROTOCOL_VERSION,
      ...(f.hostToken ? { hostToken: f.hostToken } : {}),
    }),
    'utf8',
  );
  return Buffer.concat([Buffer.from([T.HELLO]), body]);
}

export type RelayControl =
  | { t: 'ready'; connId?: number; hostToken?: string }
  | { t: 'reject'; reason: string }
  | { t: 'peer_up'; connId: number }
  | { t: 'peer_down'; connId: number }
  | { t: 'host_gone' }
  | { t: 'pong' }
  | { t: 'data'; connId?: number; isBinary: boolean; payload: Buffer };

/** Parse one relay frame the client received. Returns null on garbage. */
export function decodeRelayFrame(buf: Buffer): RelayControl | null {
  if (buf.length === 0) return null;
  const type = buf[0];
  switch (type) {
    case T.READY:
    case T.REJECT:
    case T.PEER_UP:
    case T.PEER_DOWN: {
      try {
        const obj = JSON.parse(buf.subarray(1).toString('utf8')) as Record<
          string,
          unknown
        >;
        if (type === T.READY) {
          return {
            t: 'ready',
            ...(typeof obj['connId'] === 'number' ? { connId: obj['connId'] } : {}),
            ...(typeof obj['hostToken'] === 'string'
              ? { hostToken: obj['hostToken'] }
              : {}),
          };
        }
        if (type === T.REJECT) {
          return { t: 'reject', reason: String(obj['reason'] ?? 'unknown') };
        }
        const connId = obj['connId'];
        if (typeof connId !== 'number') return null;
        return { t: type === T.PEER_UP ? 'peer_up' : 'peer_down', connId };
      } catch {
        return null;
      }
    }
    case T.HOST_GONE:
      return { t: 'host_gone' };
    case T.PONG:
      return { t: 'pong' };
    case T.DATA_H: {
      if (buf.length < 6) return null;
      return {
        t: 'data',
        connId: buf.readUInt32BE(1),
        isBinary: buf[5] === 1,
        payload: buf.subarray(6),
      };
    }
    case T.DATA_P: {
      if (buf.length < 2) return null;
      return { t: 'data', isBinary: buf[1] === 1, payload: buf.subarray(2) };
    }
    default:
      return null;
  }
}

/** peer -> relay */
export function encodeDataP(isBinary: boolean, payload: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from([T.DATA_P, isBinary ? 1 : 0]),
    Buffer.from(payload),
  ]);
}

/** host -> relay */
export function encodeDataH(
  connId: number,
  isBinary: boolean,
  payload: Uint8Array,
): Buffer {
  const head = Buffer.alloc(6);
  head[0] = T.DATA_H;
  head.writeUInt32BE(connId, 1);
  head[5] = isBinary ? 1 : 0;
  return Buffer.concat([head, Buffer.from(payload)]);
}

export function encodeKick(connId: number): Buffer {
  const b = Buffer.alloc(5);
  b[0] = T.KICK;
  b.writeUInt32BE(connId, 1);
  return b;
}

export const encodePing = (): Buffer => Buffer.from([T.PING]);
