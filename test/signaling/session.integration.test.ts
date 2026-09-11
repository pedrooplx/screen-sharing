import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { WebSocket } from 'ws';
import { SignalingServer } from '../../src/main/signaling/server.js';
import { SignalingClient } from '../../src/main/signaling/client.js';
import { Connection } from '../../src/main/net/connection.js';
import { WsTransport } from '../../src/main/net/transport.js';
import { runPeerHandshake } from '../../src/main/signaling/handshake.js';
import type { RoomParams } from '../../src/shared/protocol.js';

const roomId = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
const W = new Uint8Array(randomBytes(32));

const roomParams: RoomParams = {
  maxParticipants: 4,
  maxRecommendedSubscriptions: 2,
  videoBitrateKbps: 2500,
};

function waitEvent<T>(emitter: any, event: string): Promise<T> {
  return new Promise((resolve) => emitter.once(event, resolve));
}
const settle = () => new Promise((r) => setTimeout(r, 60));

let servers: SignalingServer[] = [];
let clients: SignalingClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  for (const s of servers) await s.close();
  servers = [];
  clients = [];
});

async function startServer(overrides: Partial<Parameters<typeof makeOpts>[0]> = {}) {
  const server = new SignalingServer(makeOpts(overrides));
  servers.push(server);
  const { port } = await server.listen();
  return { server, port };
}

function makeOpts(o: {
  w?: Uint8Array;
  roomParams?: RoomParams;
  rateLimit?: any;
  heartbeatIntervalMs?: number;
  heartbeatMaxMissed?: number;
  verifyInbound?: boolean;
} = {}) {
  return {
    roomId,
    w: o.w ?? W,
    roomParams: o.roomParams ?? roomParams,
    hostNickname: 'host-pedro',
    ...(o.rateLimit ? { rateLimit: o.rateLimit } : {}),
    ...(o.heartbeatIntervalMs ? { heartbeatIntervalMs: o.heartbeatIntervalMs } : {}),
    ...(o.heartbeatMaxMissed ? { heartbeatMaxMissed: o.heartbeatMaxMissed } : {}),
    ...(o.verifyInbound ? { verifyInbound: true } : {}),
  };
}

/** Open a raw WS to the local test server and hand it to SignalingClient as a
 *  Transport - this is the local-testing analogue of what RelayPeerLink.open()
 *  does against the hosted relay: open the transport, THEN construct the
 *  client, since SignalingClient no longer opens its own socket. */
function openWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function connectPeer(
  port: number,
  nickname: string,
  secretW = W,
): Promise<SignalingClient> {
  const ws = await openWs(port);
  const client = new SignalingClient({
    transport: new WsTransport(ws),
    roomId,
    secret: { w: secretW },
    nickname,
  });
  clients.push(client);
  return client;
}

describe('signaling session (Phase 1)', () => {
  it('admits three peers and converges the roster', async () => {
    const { server, port } = await startServer();

    const a = await connectPeer(port, 'alice');
    const ra = await a.connect();
    expect(ra.roster.map((e) => e.nickname).sort()).toEqual(['alice', 'host-pedro']);

    const b = await connectPeer(port, 'bob');
    await b.connect();
    const c = await connectPeer(port, 'carol');
    await c.connect();

    await settle();

    for (const client of [a, b, c]) {
      expect(client.roster.map((e) => e.nickname).sort()).toEqual([
        'alice',
        'bob',
        'carol',
        'host-pedro',
      ]);
    }
    expect(server.roster).toHaveLength(4);
    // host is always joinSeq 0
    expect(server.roster[0]?.isHost).toBe(true);
  });

  it('rejects a peer with the wrong password at the handshake', async () => {
    const { server, port } = await startServer();
    const rejected = waitEvent<{ reason: string }>(server, 'peer-rejected');

    const bad = await connectPeer(port, 'mallory', new Uint8Array(randomBytes(32)));
    await expect(bad.connect()).rejects.toThrow(/confirmation failed|wrong password/i);
    expect((await rejected).reason).toBe('bad_password');
    expect(server.roster).toHaveLength(1);
  });

  it('rejects a duplicate nickname', async () => {
    const { port } = await startServer();
    await (await connectPeer(port, 'sam')).connect();
    await expect((await connectPeer(port, 'SAM')).connect()).rejects.toThrow(/duplicate/i);
  });

  it('rejects joins once the room is full', async () => {
    const { port } = await startServer({
      roomParams: { ...roomParams, maxParticipants: 2 },
    });
    await (await connectPeer(port, 'first')).connect();
    await expect((await connectPeer(port, 'second')).connect()).rejects.toThrow(
      /room_full/i,
    );
  });

  it('broadcasts a roster_update when a peer leaves', async () => {
    const { server, port } = await startServer();
    const a = await connectPeer(port, 'alice');
    await a.connect();
    const b = await connectPeer(port, 'bob');
    await b.connect();
    await settle();

    const left = waitEvent<{ nickname: string }>(server, 'peer-left');
    const rosterChanged = waitEvent<any>(a, 'roster');
    b.close();

    expect((await left).nickname).toBe('bob');
    await rosterChanged;
    await settle();
    expect(a.roster.map((e) => e.nickname).sort()).toEqual(['alice', 'host-pedro']);
  });

  it('keeps the session alive while heartbeats are answered', async () => {
    const { port } = await startServer({ heartbeatIntervalMs: 20, heartbeatMaxMissed: 3 });
    const ws = await openWs(port);
    const a = new SignalingClient({
      transport: new WsTransport(ws),
      roomId,
      secret: { w: W },
      nickname: 'alice',
      heartbeatIntervalMs: 20,
      heartbeatMaxMissed: 3,
    });
    clients.push(a);
    let lost = false;
    a.on('host-lost', () => {
      lost = true;
    });
    await a.connect();
    await new Promise((r) => setTimeout(r, 200)); // ~10 heartbeat cycles
    expect(lost).toBe(false);
    expect(a.roster).toHaveLength(2);
  });

  it('rate-limits repeated failed handshake attempts from one address', async () => {
    const { server, port } = await startServer({
      rateLimit: {
        burst: 2,
        windowMs: 60_000,
        baseBackoffMs: 60_000,
        maxBackoffMs: 60_000,
      },
    });
    const seen: string[] = [];
    server.on('peer-rejected', (r) => seen.push(r.reason));
    const wrong = new Uint8Array(randomBytes(32));

    // two wrong-password attempts consume the burst...
    await expect((await connectPeer(port, 'x1', wrong)).connect()).rejects.toThrow();
    await expect((await connectPeer(port, 'x2', wrong)).connect()).rejects.toThrow();
    // ...the third is blocked before CPace even runs
    await expect((await connectPeer(port, 'x3', wrong)).connect()).rejects.toThrow();
    await settle();

    expect(seen.filter((r) => r === 'bad_password')).toHaveLength(2);
    expect(seen).toContain('rate_limited');
  });

  it('declares a silent peer dead via heartbeat', async () => {
    const { server, port } = await startServer({
      heartbeatIntervalMs: 25,
      heartbeatMaxMissed: 3,
    });

    // a raw peer that completes the handshake and join but never sends a pong
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    const conn = new Connection(new WsTransport(ws), 'peer');
    await runPeerHandshake(conn, { roomId, deriveW: () => W });
    conn.outboundFrom = 'ghost';
    conn.send({
      type: 'join',
      nickname: 'ghost',
      clientCaps: { canHost: false, inboundPort: 0 },
    });
    await new Promise<void>((res) => {
      conn.on('message', (env) => {
        if (env.body.type === 'joined') res();
      });
    });

    const left = await waitEvent<{ nickname: string; reason: string }>(
      server,
      'peer-left',
    );
    expect(left.nickname).toBe('ghost');
    expect(left.reason).toBe('timeout');
    ws.terminate();
  });

  it('sets inboundVerified when the peer port is reachable', async () => {
    // a stand-in for the peer's own inbound listener
    const listener: Server = createServer();
    await new Promise<void>((res) => listener.listen(0, '127.0.0.1', res));
    const inboundPort = (listener.address() as { port: number }).port;

    const { port } = await startServer({ verifyInbound: true });
    const watcher = await connectPeer(port, 'watcher');
    await watcher.connect();

    const ws = await openWs(port);
    const probed = new SignalingClient({
      transport: new WsTransport(ws),
      roomId,
      secret: { w: W },
      nickname: 'reachable',
      inboundPort,
    });
    clients.push(probed);
    await probed.connect();

    // wait for the roster_update carrying inboundVerified
    await new Promise<void>((resolve) => {
      const check = () => {
        if (watcher.roster.find((e) => e.nickname === 'reachable')?.inboundVerified) {
          resolve();
        }
      };
      watcher.on('roster', check);
      check();
    });

    listener.close();
  });
});
