/**
 * The byte pipe a `Connection` rides on. Abstracted so a Connection can run
 * over a direct WebSocket (local testing) or multiplexed over a shared relay
 * link (docs/DESIGN.md section 2.2 - the hosted relay). The Connection layer
 * only ever sees ordered messages tagged text-or-binary.
 */

import type { WebSocket } from 'ws';

export interface Transport {
  send(data: string | Uint8Array, isBinary: boolean): void;
  close(code: number, reason: string): void;
  readonly closed: boolean;
  onMessage(cb: (data: Buffer, isBinary: boolean) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  onError(cb: (err: Error) => void): void;
}

/**
 * Something a SignalingServer consumes to get its inbound Connections. Either a
 * local WebSocketServer (WsConnectionSource) or the shared relay link
 * (RelayHostLink), which yields one Transport per remote peer.
 */
export interface ConnectionSource {
  onConnection(cb: (transport: Transport, ip: string) => void): void;
  /** the whole source went down (relay link dropped, wss closed) */
  onClosed(cb: (reason: string) => void): void;
  close(): Promise<void>;
}

/** A Transport backed 1:1 by a real ws WebSocket. */
export class WsTransport implements Transport {
  #closed = false;

  constructor(private readonly ws: WebSocket) {}

  get closed(): boolean {
    return this.#closed || this.ws.readyState > 1;
  }

  send(data: string | Uint8Array, isBinary: boolean): void {
    this.ws.send(data, { binary: isBinary });
  }

  close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.ws.close(code, reason);
    } catch {
      /* already gone */
    }
  }

  onMessage(cb: (data: Buffer, isBinary: boolean) => void): void {
    this.ws.on('message', (data: Buffer, isBinary: boolean) => cb(data, isBinary));
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.ws.on('close', (code: number, reason: Buffer) => {
      this.#closed = true;
      cb(code, reason.toString());
    });
  }

  onError(cb: (err: Error) => void): void {
    this.ws.on('error', cb);
  }
}

/**
 * An in-memory Transport pair for tests: `[a, b]` where anything written to `a`
 * arrives on `b` and vice versa, next tick.
 */
export function transportPair(): [Transport, Transport] {
  const a = new MemoryTransport();
  const b = new MemoryTransport();
  a.link(b);
  b.link(a);
  return [a, b];
}

class MemoryTransport implements Transport {
  peer: MemoryTransport | undefined;
  msg: ((data: Buffer, isBinary: boolean) => void) | undefined;
  closeCb: ((code: number, reason: string) => void) | undefined;
  #closed = false;

  link(peer: MemoryTransport): void {
    this.peer = peer;
  }
  get closed(): boolean {
    return this.#closed;
  }
  send(data: string | Uint8Array, isBinary: boolean): void {
    if (this.#closed) return;
    const buf =
      typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    queueMicrotask(() => this.peer?.msg?.(buf, isBinary));
  }
  close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    queueMicrotask(() => this.peer?.markClosedBy(code, reason));
  }
  markClosedBy(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.closeCb?.(code, reason);
  }
  onMessage(cb: (data: Buffer, isBinary: boolean) => void): void {
    this.msg = cb;
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCb = cb;
  }
  onError(): void {
    /* memory transport never errors */
  }
}
