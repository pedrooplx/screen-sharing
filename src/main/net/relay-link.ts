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
  encodeHandoff,
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

/**
 * Resolved/rejected by whichever permanent message handler sees the READY or
 * REJECT frame that answers this connection's HELLO.
 *
 * Both link classes used to wait for READY with a SEPARATE, temporary
 * `ws.on('message', ...)` listener, torn down as soon as READY arrived, with
 * the class's own permanent listener only attached afterward (once the
 * `open()` promise resumed - at least one microtask later). That gap is
 * invisible for a plain room creation, where READY is the only thing the
 * relay ever sends unprompted. It is not invisible for a graceful-handoff
 * claim (server/src/relay.ts's #claimHandoff): the relay sends READY and
 * then one PEER_UP per still-connected survivor, back to back, synchronously,
 * in the same call. If both arrive in the same WebSocket read - entirely
 * normal - the temporary listener catches READY and removes itself; the
 * permanent one doesn't exist yet; PEER_UP lands with no listener at all and
 * is silently gone (confirmed by hand: a promoted host that stops timing out
 * on `waitFor hello_ack` the moment this was fixed). The fix is structural,
 * not a delay: construct the link and attach its ONE permanent handler
 * before sending HELLO at all, so there is no interval, ever, during which a
 * frame can arrive uncaught.
 */
interface PendingOpen {
  resolve(frame: { connId?: number; hostToken?: string }): void;
  reject(err: Error): void;
}

function waitPendingOpen(
  ws: WebSocket,
  timeoutMs: number,
  setPending: (p: PendingOpen | undefined) => void,
): Promise<{ connId?: number; hostToken?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      setPending(undefined);
      reject(new RelayLinkError('relay never sent READY'));
    }, timeoutMs);
    setPending({
      resolve: (frame) => {
        clearTimeout(timer);
        setPending(undefined);
        resolve(frame);
      },
      reject: (err) => {
        clearTimeout(timer);
        setPending(undefined);
        reject(err);
      },
    });
    ws.once('close', () => {
      clearTimeout(timer);
      setPending(undefined);
      reject(new RelayLinkError('relay closed before READY'));
    });
  });
}

// --- peer ----------------------------------------------------------------

export class RelayPeerLink implements Transport {
  #ws: WebSocket;
  #h: Handlers = {};
  #closed = false;
  #keepalive: NodeJS.Timeout;
  #pendingOpen: PendingOpen | undefined;
  #onHandoffReady: (() => void) | undefined;
  /**
   * True if HOST_CLAIMED arrived before RoomSession#rehome() got around to
   * calling onHandoffReady() - the same kind of gap #pendingPeers closes for
   * RelayHostLink below, just for a one-shot signal instead of a queue: the
   * relay can send this the instant a successor claims, which is often
   * sooner than the survivor has finished reacting to host_transfer.
   */
  #handoffAlreadyClaimed = false;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const frame = decodeRelayFrame(data);
      if (!frame) return;
      if (frame.t === 'ready') {
        this.#pendingOpen?.resolve(frame);
      } else if (frame.t === 'reject') {
        this.#pendingOpen?.reject(
          new RelayLinkError(`relay rejected: ${frame.reason}`, frame.reason),
        );
      } else if (frame.t === 'data') {
        this.#h.onMessage?.(Buffer.from(frame.payload), frame.isBinary);
      } else if (frame.t === 'host_gone') {
        this.#fail(1001, 'host gone');
      } else if (frame.t === 'host_claimed') {
        if (this.#onHandoffReady) this.#onHandoffReady();
        else this.#handoffAlreadyClaimed = true;
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
    const link = new RelayPeerLink(ws);
    const ready = waitPendingOpen(ws, timeoutMs, (p) => (link.#pendingOpen = p));
    ws.send(encodeHello({ role: 'peer', roomId, app: appVersion }), { binary: true });
    await ready;
    return link;
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
  /**
   * Fires once, the moment a graceful handoff's successor claims the room
   * (HOST_CLAIMED) - RoomSession#rehome() waits on this instead of guessing
   * a fixed delay before its one allowed handshake attempt. If the claim
   * already happened before this was called, fires immediately.
   */
  onHandoffReady(cb: () => void): void {
    this.#onHandoffReady = cb;
    if (this.#handoffAlreadyClaimed) {
      this.#handoffAlreadyClaimed = false;
      cb();
    }
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
  /**
   * peer_up's whose VirtualTransport exists but couldn't be handed to a
   * caller yet because onConnection() isn't wired up. Only possible right
   * after open(): SignalingServer#listen() calls onConnection() the moment
   * open()'s promise resolves, but that resumption is a microtask, and the
   * relay can send peer_up frames synchronously right behind READY in the
   * same call (#claimHandoff, for every survivor of a graceful handoff) -
   * both arrive in the same synchronous message-handling pass, before any
   * microtask (including open()'s own awaiter) gets a turn. Buffer instead
   * of dropping; flush the moment onConnection() is actually set.
   */
  #pendingPeers: VirtualTransport[] = [];
  #onClosed: ((reason: string) => void) | undefined;
  #closed = false;
  #keepalive: NodeJS.Timeout;
  #pendingOpen: PendingOpen | undefined;
  hostToken = '';

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const frame = decodeRelayFrame(data);
      if (!frame) return;
      if (frame.t === 'ready') {
        this.#pendingOpen?.resolve(frame);
        return;
      }
      if (frame.t === 'reject') {
        this.#pendingOpen?.reject(
          new RelayLinkError(`relay rejected: ${frame.reason}`, frame.reason),
        );
        return;
      }
      if (frame.t === 'peer_up') {
        const vt = new VirtualTransport(frame.connId, this);
        this.#peers.set(frame.connId, vt);
        if (this.#onConnection) {
          this.#onConnection(vt, 'relay');
        } else {
          this.#pendingPeers.push(vt);
        }
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
    const link = new RelayHostLink(ws);
    const ready = waitPendingOpen(ws, timeoutMs, (p) => (link.#pendingOpen = p));
    ws.send(encodeHello({ role: 'host', roomId, app: appVersion }), { binary: true });
    const frame = await ready;
    link.hostToken = frame.hostToken ?? '';
    return link;
  }

  get closed(): boolean {
    return this.#closed;
  }
  onConnection(cb: (transport: Transport, ip: string) => void): void {
    this.#onConnection = cb;
    if (this.#pendingPeers.length > 0) {
      const pending = this.#pendingPeers;
      this.#pendingPeers = [];
      for (const vt of pending) cb(vt, 'relay');
    }
  }
  onClosed(cb: (reason: string) => void): void {
    this.#onClosed = cb;
  }
  /**
   * Tell the relay this host is leaving gracefully: hold the room open for a
   * successor instead of tearing it down the instant this link closes (see
   * server/src/relay.ts's HANDOFF handling). Does not close anything itself -
   * follow with a normal close() once the app-level handoff broadcast has had
   * a moment to reach peers over their still-open connections.
   */
  handoff(): void {
    if (this.#ws.readyState === this.#ws.OPEN) {
      this.#ws.send(encodeHandoff(), { binary: true });
    }
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
