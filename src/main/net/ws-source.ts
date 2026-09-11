/**
 * A ConnectionSource backed by a local WebSocketServer. Used directly by
 * signaling-layer tests (host and peers on 127.0.0.1, no relay involved);
 * production signaling (RoomSession) goes through the relay instead - see
 * src/main/net/relay-link.ts.
 */

import { WebSocketServer } from 'ws';
import { type ConnectionSource, type Transport, WsTransport } from './transport.js';

export class WsConnectionSource implements ConnectionSource {
  #wss: WebSocketServer | undefined;
  #onConnection: ((t: Transport, ip: string) => void) | undefined;
  #onClosed: ((reason: string) => void) | undefined;

  async listen(bindAddress: string, port: number): Promise<{ port: number }> {
    const wss = new WebSocketServer({ host: bindAddress, port });
    this.#wss = wss;
    wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress ?? 'unknown';
      this.#onConnection?.(new WsTransport(ws), ip);
    });
    wss.on('error', (err) => this.#onClosed?.(err.message));
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    const addr = wss.address();
    if (typeof addr === 'string' || addr === null) {
      throw new Error('WebSocketServer did not bind a TCP port');
    }
    return { port: addr.port };
  }

  onConnection(cb: (transport: Transport, ip: string) => void): void {
    this.#onConnection = cb;
  }
  onClosed(cb: (reason: string) => void): void {
    this.#onClosed = cb;
  }
  async close(): Promise<void> {
    const wss = this.#wss;
    this.#wss = undefined;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
  /** abrupt: drop the listener without closing connections cleanly (crash sim) */
  terminate(): void {
    this.#wss?.close();
    this.#wss = undefined;
  }
}
