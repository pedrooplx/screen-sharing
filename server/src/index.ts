/**
 * erros-share signaling relay. A tiny WebSocket multiplexer that lets a room
 * host and its peers reach each other without anyone opening a port. It relays
 * opaque bytes only - CPace and the AES-256-GCM control frames are end to end,
 * so this process never sees the room password, SDP, ICE, media, or nicknames.
 *
 * Deploy target: a free hosted Node service (e.g. Render). It sleeps when idle;
 * the client retries the first connection and pings while a room is live.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_LIMITS, Relay, type RelayLimits, type Socket } from './relay.js';
import { decodeHello } from './wire.js';

const IDLE_TIMEOUT_MS = 70_000;

export interface RelayHttpServer {
  readonly http: HttpServer;
  readonly relay: Relay;
  /** the bound port (useful when `port: 0` asked for an ephemeral one) */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Build and start the relay's HTTP+WS server. Exported (not just run as a
 * script) so tests can boot a real relay in-process on `127.0.0.1:0` - see
 * `test/helpers/relay.ts` - instead of re-implementing its wire handling.
 */
export async function createRelayHttpServer(
  opts: { readonly port?: number; readonly limits?: RelayLimits } = {},
): Promise<RelayHttpServer> {
  const relay = new Relay(opts.limits ?? DEFAULT_LIMITS);
  // 2s, not 60s: sweep() also expires an abandoned graceful handoff
  // (Relay.HANDOFF_GRACE_MS, ~8s) - the old 60s cadence was fine for its
  // original job (idle rate-limit buckets) but would leave a room's
  // surviving peers waiting up to a minute past a failed handoff before
  // being told the room is actually gone.
  const sweeper = setInterval(() => relay.sweep(), 2_000);
  sweeper.unref?.();

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
    idle.unref?.();

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

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port ?? 8787, resolve);
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : (opts.port ?? 8787);

  return {
    http,
    relay,
    port,
    close: async () => {
      clearInterval(sweeper);
      // wss.close()'s callback only fires once every tracked client has
      // disconnected on its own - which never happens unless we terminate
      // them first (a graceful process shutdown, or a test tearing a room
      // down mid-session).
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

// Run as a standalone process (the deployed target) unless imported for tests.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(process.env['PORT'] ?? 8787);
  const server = await createRelayHttpServer({ port });
  // eslint-disable-next-line no-console
  console.log(`erros-share relay listening on :${server.port}`);
}
