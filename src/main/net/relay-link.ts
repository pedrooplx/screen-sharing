/**
 * Client links to the signaling relay (docs/DESIGN.md section 2.2).
 *
 *   RelayPeerLink  - a peer's single WS, exposed as one Transport (the
 *                    control-plane connection to the host).
 *   RelayHostLink  - the host's single WS, exposed as a ConnectionSource that
 *                    yields one virtual Transport per remote peer.
 *
 * Neither reads a payload - CPace and the AES-256-GCM frames pass through.
 */

import { WebSocket } from 'ws';
import {
  type ConnectionSource,
  type Transport,
} from './transport.js';
import {
  decodeRelayFrame,
  encodeDataH,
  encodeDataP,
  encodeHello,
  encodeKick,
  encodePing,
} from './relay-wire.js';

export class RelayLinkError extends Error {
  override name = 'RelayLinkError';
  /** the relay's REJECT reason, when it sent one (see server/src/wire.ts) */
  readonly reason: string | undefined;

  constructor(message: string, reason?: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * REJECT reasons the caller should NOT retry: the situation will not fix itself
 * by dialing again (a peer only ever tries to join a code after the host
 * already exists, so `no_such_room` means a wrong/stale code, not a race).
 * Everything else - connection refused, no READY, `rate_limited`, `server_full`
 * - is worth a backed-off retry, which is also how a sleeping relay is waited
 * out.
 */
const FATAL_REJECT_REASONS = new Set([
  'room_exists',
  'no_such_room',
  'room_full',
  'bad_hello',
  'proto_mismatch',
]);

export function isRetriableRelayError(err: unknown): boolean {
  if (!(err instanceof RelayLinkError)) return true; // connect-level failure
  return err.reason === undefined || !FATAL_REJECT_REASONS.has(err.reason);
}

export interface OpenWithRetryOptions {
  /** give up after this long from the first attempt (default 75s: a free-tier
   *  Render cold start is 30-50s; leave margin for a couple of retries) */
  readonly budgetMs?: number;
  /** called once, the first time a retry looks like a cold start rather than a
   *  blip - the caller uses this to show "waking the server..." */
  readonly onWaking?: () => void;
  readonly wakingAfterAttempts?: number;
}

/**
 * Retries `open()` with backoff until it succeeds, the budget runs out, or the
 * failure is one retrying cannot fix (see `isRetriableRelayError`). This is what
 * lets the app wait out a sleeping free-tier relay instead of failing the first
 * `host()`/`join()` a user tries after 15 minutes of nobody using the room.
 */
export async function openWithRetry<T>(
  open: () => Promise<T>,
  opts: OpenWithRetryOptions = {},
): Promise<T> {
  const budgetMs = opts.budgetMs ?? 75_000;
  const wakingAfter = opts.wakingAfterAttempts ?? 2;
  const deadline = Date.now() + budgetMs;
  let attempt = 0;
  let notified = false;
  for (;;) {
    attempt++;
    try {
      return await open();
    } catch (err) {
      if (!isRetriableRelayError(err) || Date.now() >= deadline) throw err;
      if (!notified && attempt >= wakingAfter) {
        notified = true;
        opts.onWaking?.();
      }
      await new Promise((r) => setTimeout(r, Math.min(1_500 * attempt, 6_000)));
    }
  }
}

const OPEN_TIMEOUT_MS = 12_000;
const KEEPALIVE_MS = 25_000;

interface Handlers {
  onMessage?: (data: Buffer, isBinary: boolean) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (err: Error) => void;
}

function connectWs(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('error', () => {});
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new RelayLinkError(`relay did not accept the connection in ${timeoutMs}ms`));
    }, timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// --- peer ----------------------------------------------------------------

export class RelayPeerLink implements Transport {
  #ws: WebSocket;
  #h: Handlers = {};
  #closed = false;
  #keepalive: NodeJS.Timeout;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const frame = decodeRelayFrame(data);
      if (!frame) return;
      if (frame.t === 'data') {
        this.#h.onMessage?.(Buffer.from(frame.payload), frame.isBinary);
      } else if (frame.t === 'host_gone') {
        this.#fail(1001, 'host gone');
      }
    });
    ws.on('close', (code: number, reason: Buffer) =>
      this.#fail(code, reason.toString() || 'relay closed'),
    );
    ws.on('error', (err: Error) => this.#h.onError?.(err));
    this.#keepalive = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(encodePing(), { binary: true });
    }, KEEPALIVE_MS);
    this.#keepalive.unref();
  }

  static async open(
    url: string,
    roomId: string,
    appVersion: string,
    timeoutMs = OPEN_TIMEOUT_MS,
  ): Promise<RelayPeerLink> {
    const ws = await connectWs(url, timeoutMs);
    ws.send(encodeHello({ role: 'peer', roomId, app: appVersion }), { binary: true });
    await waitReady(ws, timeoutMs);
    return new RelayPeerLink(ws);
  }

  get closed(): boolean {
    return this.#closed || this.#ws.readyState > 1;
  }
  send(data: string | Uint8Array, isBinary: boolean): void {
    if (this.#closed) return;
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.#ws.send(encodeDataP(isBinary, payload), { binary: true });
  }
  close(_code: number, _reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#keepalive);
    try {
      this.#ws.close(1000, '');
    } catch {
      /* gone */
    }
  }
  onMessage(cb: (data: Buffer, isBinary: boolean) => void): void {
    this.#h.onMessage = cb;
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.#h.onClose = cb;
  }
  onError(cb: (err: Error) => void): void {
    this.#h.onError = cb;
  }

  #fail(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#keepalive);
    this.#h.onClose?.(code, reason);
  }
}

// --- host ----------------------------------------------------------------

class VirtualTransport implements Transport {
  #h: Handlers = {};
  #closed = false;

  constructor(
    private readonly connId: number,
    private readonly link: RelayHostLink,
  ) {}

  get closed(): boolean {
    return this.#closed || this.link.closed;
  }
  send(data: string | Uint8Array, isBinary: boolean): void {
    if (this.#closed) return;
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.link._sendToPeer(this.connId, isBinary, payload);
  }
  close(_code: number, _reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.link._kick(this.connId);
    // Unlike a real WebSocket (whose own `close` event always fires
    // eventually, even for a self-initiated close), there is no echo back
    // from the relay for a host-initiated kick - it already knows. Without
    // this, Connection/SignalingServer would never hear their own
    // `conn.close()` and the roster entry would never clear.
    this.#h.onClose?.(1000, 'closed by host');
  }
  onMessage(cb: (data: Buffer, isBinary: boolean) => void): void {
    this.#h.onMessage = cb;
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.#h.onClose = cb;
  }
  onError(cb: (err: Error) => void): void {
    this.#h.onError = cb;
  }
  _deliver(data: Buffer, isBinary: boolean): void {
    this.#h.onMessage?.(data, isBinary);
  }
  _dropped(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#h.onClose?.(1001, reason);
  }
}

export class RelayHostLink implements ConnectionSource {
  #ws: WebSocket;
  #peers = new Map<number, VirtualTransport>();
  #onConnection: ((t: Transport, ip: string) => void) | undefined;
  #onClosed: ((reason: string) => void) | undefined;
  #closed = false;
  #keepalive: NodeJS.Timeout;
  readonly hostToken: string;

  private constructor(ws: WebSocket, hostToken: string) {
    this.#ws = ws;
    this.hostToken = hostToken;
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const frame = decodeRelayFrame(data);
      if (!frame) return;
      if (frame.t === 'peer_up') {
        const vt = new VirtualTransport(frame.connId, this);
        this.#peers.set(frame.connId, vt);
        this.#onConnection?.(vt, 'relay');
      } else if (frame.t === 'peer_down') {
        this.#peers.get(frame.connId)?._dropped('peer left');
        this.#peers.delete(frame.connId);
      } else if (frame.t === 'data' && frame.connId !== undefined) {
        this.#peers.get(frame.connId)?._deliver(Buffer.from(frame.payload), frame.isBinary);
      }
    });
    ws.on('close', () => this.#tearDown('relay link closed'));
    ws.on('error', () => {});
    this.#keepalive = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(encodePing(), { binary: true });
    }, KEEPALIVE_MS);
    this.#keepalive.unref();
  }

  static async open(
    url: string,
    roomId: string,
    appVersion: string,
    timeoutMs = OPEN_TIMEOUT_MS,
  ): Promise<RelayHostLink> {
    const ws = await connectWs(url, timeoutMs);
    ws.send(encodeHello({ role: 'host', roomId, app: appVersion }), { binary: true });
    const ready = await waitReady(ws, timeoutMs);
    return new RelayHostLink(ws, ready.hostToken ?? '');
  }

  get closed(): boolean {
    return this.#closed;
  }
  onConnection(cb: (transport: Transport, ip: string) => void): void {
    this.#onConnection = cb;
  }
  onClosed(cb: (reason: string) => void): void {
    this.#onClosed = cb;
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#keepalive);
    try {
      this.#ws.close(1000, '');
    } catch {
      /* gone */
    }
  }

  _sendToPeer(connId: number, isBinary: boolean, payload: Uint8Array): void {
    if (this.#ws.readyState === this.#ws.OPEN) {
      this.#ws.send(encodeDataH(connId, isBinary, payload), { binary: true });
    }
  }
  _kick(connId: number): void {
    if (this.#ws.readyState === this.#ws.OPEN) {
      this.#ws.send(encodeKick(connId), { binary: true });
    }
    this.#peers.delete(connId);
  }

  #tearDown(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#keepalive);
    for (const vt of this.#peers.values()) vt._dropped(reason);
    this.#peers.clear();
    this.#onClosed?.(reason);
  }
}

// --- shared -----------------------------------------------------------

function waitReady(
  ws: WebSocket,
  timeoutMs: number,
): Promise<{ connId?: number; hostToken?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new RelayLinkError('relay never sent READY'));
    }, timeoutMs);
    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const frame = decodeRelayFrame(data);
      if (!frame) return;
      if (frame.t === 'ready') {
        cleanup();
        resolve({
          ...(frame.connId !== undefined ? { connId: frame.connId } : {}),
          ...(frame.hostToken !== undefined ? { hostToken: frame.hostToken } : {}),
        });
      } else if (frame.t === 'reject') {
        cleanup();
        reject(new RelayLinkError(`relay rejected: ${frame.reason}`, frame.reason));
      }
    };
    const onClose = () => {
      cleanup();
      reject(new RelayLinkError('relay closed before READY'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    };
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}
