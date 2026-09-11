/**
 * Heir probe (docs/DESIGN.md section 9.2) - the anti-split-brain check.
 *
 * Before a peer that lost the host concludes "the host is really gone", it asks
 * the designated heir a single question over UDP: "is your link to the host
 * still alive?". If the heir says yes, the asking peer is merely isolated and
 * must NOT trigger a failover; it just reconnects.
 *
 * Deviation from the design's "warm authenticated WebSocket" note: a
 * `w`-authenticated UDP request/reply is functionally equivalent for this one
 * question, needs no standing connections (N idle authenticated sockets), and
 * costs one round-trip. Both request and reply carry an HMAC keyed by material
 * derived from the room password, so a party without `w` can neither forge a
 * reply nor use the responder as an oracle.
 */

import { createSocket } from 'node:dgram';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { expandKey } from '../src/main/crypto/kdf.js';
import { concatBytes } from '../src/main/crypto/lv.js';

export class HeirProbeError extends Error {
  override name = 'HeirProbeError';
}

export interface HeirStatus {
  readonly hostAlive: boolean;
  readonly epoch: number;
}

function probeKey(w: Uint8Array): Uint8Array {
  return expandKey(w, 'heir-probe/v1', 32);
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

function reqMac(
  key: Uint8Array,
  roomId: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  return hmac(sha256, key, concatBytes(utf8ToBytes('heir-req'), roomId, nonce));
}

function replyMac(
  key: Uint8Array,
  nonce: Uint8Array,
  status: HeirStatus,
): Uint8Array {
  return hmac(
    sha256,
    key,
    concatBytes(
      utf8ToBytes('heir-reply'),
      nonce,
      Uint8Array.of(status.hostAlive ? 1 : 0),
      u32(status.epoch),
    ),
  );
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

interface WireRequest {
  t: 'heir_probe';
  roomId: string;
  nonce: string;
  mac: string;
}
interface WireReply {
  t: 'heir_probe_reply';
  nonce: string;
  hostAlive: boolean;
  epoch: number;
  mac: string;
}

/** Always-on responder every peer runs on its inbound UDP port. */
export class HeirProbeResponder {
  readonly #key: Uint8Array;
  readonly #roomId: Uint8Array;
  #status: HeirStatus = { hostAlive: true, epoch: 0 };
  #socket: ReturnType<typeof createSocket> | undefined;
  readonly #recent = new Map<string, number>();

  constructor(w: Uint8Array, roomId: Uint8Array) {
    this.#key = probeKey(w);
    this.#roomId = roomId;
  }

  setStatus(status: HeirStatus): void {
    this.#status = status;
  }

  async listen(port: number, address = '0.0.0.0'): Promise<{ port: number }> {
    const socket = createSocket('udp4');
    this.#socket = socket;
    socket.on('message', (msg, rinfo) => this.#onMessage(msg, rinfo.address, rinfo.port));
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, address, () => resolve());
    });
    const addr = socket.address();
    return { port: addr.port };
  }

  close(): void {
    this.#socket?.close();
    this.#socket = undefined;
  }

  #onMessage(msg: Buffer, fromAddr: string, fromPort: number): void {
    // crude flood guard: at most ~5 replies per source IP per second
    const now = Date.now();
    const seen = this.#recent.get(fromAddr) ?? 0;
    if (now - seen < 200) return;
    this.#recent.set(fromAddr, now);

    let req: WireRequest;
    try {
      req = JSON.parse(msg.toString('utf8')) as WireRequest;
      if (req.t !== 'heir_probe') return;
    } catch {
      return;
    }
    if (req.roomId !== bytesToHex(this.#roomId)) return;

    let nonce: Uint8Array;
    let mac: Uint8Array;
    try {
      nonce = hexToBytes(req.nonce);
      mac = hexToBytes(req.mac);
    } catch {
      return;
    }
    if (nonce.length !== 16) return;
    if (!eq(mac, reqMac(this.#key, this.#roomId, nonce))) return;

    const reply: WireReply = {
      t: 'heir_probe_reply',
      nonce: req.nonce,
      hostAlive: this.#status.hostAlive,
      epoch: this.#status.epoch,
      mac: bytesToHex(replyMac(this.#key, nonce, this.#status)),
    };
    this.#socket?.send(JSON.stringify(reply), fromPort, fromAddr);
  }
}

/** Ask one heir whether it still sees the host. */
export function heirProbe(
  host: string,
  port: number,
  w: Uint8Array,
  roomId: Uint8Array,
  opts: { timeoutMs?: number; retries?: number } = {},
): Promise<HeirStatus> {
  const key = probeKey(w);
  const timeoutMs = opts.timeoutMs ?? 800;
  const retries = opts.retries ?? 2;
  const nonce = new Uint8Array(randomBytes(16));
  const request: WireRequest = {
    t: 'heir_probe',
    roomId: bytesToHex(roomId),
    nonce: bytesToHex(nonce),
    mac: bytesToHex(reqMac(key, roomId, nonce)),
  };
  const payload = Buffer.from(JSON.stringify(request));

  return new Promise<HeirStatus>((resolve, reject) => {
    const socket = createSocket('udp4');
    let attempts = 0;
    let retransmit: NodeJS.Timeout | undefined;
    let overall: NodeJS.Timeout | undefined;

    const done = (err: Error | null, value?: HeirStatus) => {
      if (retransmit) clearTimeout(retransmit);
      if (overall) clearTimeout(overall);
      socket.removeAllListeners();
      socket.close();
      if (err) reject(err);
      else resolve(value!);
    };

    socket.on('message', (msg) => {
      let reply: WireReply;
      try {
        reply = JSON.parse(msg.toString('utf8')) as WireReply;
      } catch {
        return;
      }
      if (reply.t !== 'heir_probe_reply' || reply.nonce !== request.nonce) return;
      const status: HeirStatus = {
        hostAlive: Boolean(reply.hostAlive),
        epoch: Number(reply.epoch) | 0,
      };
      if (!eq(hexToBytes(reply.mac), replyMac(key, nonce, status))) {
        done(new HeirProbeError('heir reply failed authentication'));
        return;
      }
      done(null, status);
    });
    socket.on('error', (err) => done(err));

    const send = () => {
      attempts++;
      socket.send(payload, port, host);
      if (attempts <= retries) retransmit = setTimeout(send, timeoutMs);
    };
    overall = setTimeout(
      () => done(new HeirProbeError(`no reply from heir ${host}:${port}`)),
      timeoutMs * (retries + 2),
    );
    send();
  });
}
