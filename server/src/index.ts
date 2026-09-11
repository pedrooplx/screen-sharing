/**
 * erros-share signaling relay. A tiny WebSocket multiplexer that lets a room
 * host and its peers reach each other without anyone opening a port. It relays
 * opaque bytes only - CPace and the AES-256-GCM control frames are end to end,
 * so this process never sees the room password, SDP, ICE, media, or nicknames.
 *
 * Deploy target: a free hosted Node service (e.g. Render). It sleeps when idle;
 * the client retries the first connection and pings while a room is live.
 */

import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_LIMITS, Relay, type Socket } from './relay.js';
import { decodeHello } from './wire.js';

const PORT = Number(process.env['PORT'] ?? 8787);
const IDLE_TIMEOUT_MS = 70_000;

const relay = new Relay(DEFAULT_LIMITS);
setInterval(() => relay.sweep(), 60_000).unref();

const http = createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: relay.roomCount }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: http, maxPayload: 512 * 1024 });

wss.on('connection', (ws: WebSocket, req) => {
  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';

  const socket: Socket = {
    ip,
    send: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data, { binary: true });
    },
    close: (code, reason) => {
      try {
        ws.close(code ?? 1000, reason ?? '');
      } catch {
        /* already gone */
      }
    },
  };

  let greeted = false;
  let alive = true;
  ws.on('pong', () => (alive = true));
  const idle = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }, IDLE_TIMEOUT_MS / 2);
  idle.unref();

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      ws.close(1003, 'binary only');
      return;
    }
    if (!greeted) {
      const hello = decodeHello(data);
      if (!hello) {
        ws.close(1008, 'bad hello');
        return;
      }
      greeted = true;
      relay.onHello(socket, hello);
      return;
    }
    relay.onMessage(socket, data);
  });

  ws.on('close', () => {
    clearInterval(idle);
    relay.onClose(socket);
  });
  ws.on('error', () => ws.terminate());
});

http.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`erros-share relay listening on :${PORT}`);
});
