import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from 'werift';
import { SignalingServer } from '../src/main/signaling/server.js';
import { PeerNode } from './peer-node.js';
import { freePort } from '../test/helpers/free-port.js';
import type { MediaBody } from '../src/shared/ipc.js';
import type { RoomParams } from '../src/shared/protocol.js';

const roomId = new Uint8Array([0xfa, 0x11, 0x00, 0x77]);
const W = new Uint8Array(randomBytes(32));
const roomParams: RoomParams = {
  maxParticipants: 8,
  maxRecommendedSubscriptions: 2,
  videoBitrateKbps: 2500,
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await wait(25);
  }
}

let servers: SignalingServer[] = [];
let nodes: PeerNode[] = [];

afterEach(async () => {
  for (const n of nodes) await n.stop().catch(() => {});
  for (const s of servers) await s.close().catch(() => {});
  servers = [];
  nodes = [];
});

describe('host failover', () => {
  it('promotes the heir and re-homes the other peers when the host crashes', async () => {
    const host = new SignalingServer({
      roomId,
      w: W,
      roomParams,
      hostNickname: 'host',
      verifyInbound: true,
      heartbeatIntervalMs: 40,
      heartbeatMaxMissed: 3,
    });
    servers.push(host);
    const { port: hostPort } = await host.listen();

    const names = ['alice', 'bob', 'carol'];
    for (const nickname of names) {
      const node = new PeerNode({
        host: '127.0.0.1',
        port: hostPort,
        roomId,
        w: W,
        roomParams,
        nickname,
        inboundPort: await freePort(),
        heartbeatIntervalMs: 40,
        heartbeatMaxMissed: 3,
        staggerMs: 150,
        reconnectDelayMs: 150,
      });
      nodes.push(node);
      await node.start();
    }

    // wait until the host has verified every peer's inbound path
    await until(() =>
      host.roster
        .filter((e) => !e.isHost)
        .every((e) => e.inboundVerified && e.inboundEndpoint !== null),
    );
    expect(host.roster).toHaveLength(4);

    const events = nodes.map((n) => {
      const rec = { promoted: false, migrated: false, closed: false };
      n.on('promoted', () => (rec.promoted = true));
      n.on('migrated', () => (rec.migrated = true));
      n.on('room-closed', () => (rec.closed = true));
      return rec;
    });

    // kill the host abruptly
    host.crash();

    // exactly one node promotes; the others migrate
    await until(() => events.filter((e) => e.promoted).length === 1, 12000);
    await until(() => events.filter((e) => e.migrated).length === 2, 12000);

    expect(events.filter((e) => e.closed)).toHaveLength(0);

    const newHost = nodes.find((n) => n.isHost)!;
    expect(newHost).toBeDefined();
    expect(newHost.epoch).toBe(1);

    // the roster reconverges around the new host
    await until(() =>
      nodes.every(
        (n) =>
          n.roster.length === 3 &&
          n.roster.some((e) => e.isHost && e.peerId === newHost.peerId),
      ),
    );

    // and the deterministic winner is the earliest-joined verified peer (alice)
    expect(newHost).toBe(nodes[0]);
  });

  it('hands off gracefully without a heartbeat timeout', async () => {
    const host = new SignalingServer({
      roomId,
      w: W,
      roomParams,
      hostNickname: 'host',
      verifyInbound: true,
      heartbeatIntervalMs: 50,
    });
    servers.push(host);
    const { port: hostPort } = await host.listen();

    for (const nickname of ['dave', 'erin']) {
      const node = new PeerNode({
        host: '127.0.0.1',
        port: hostPort,
        roomId,
        w: W,
        roomParams,
        nickname,
        inboundPort: await freePort(),
        heartbeatIntervalMs: 50,
        staggerMs: 150,
        reconnectDelayMs: 150,
      });
      nodes.push(node);
      await node.start();
    }

    await until(() =>
      host.roster.filter((e) => !e.isHost).every((e) => e.inboundVerified),
    );

    let promoted = 0;
    let migrated = 0;
    nodes.forEach((n) => {
      n.on('promoted', () => promoted++);
      n.on('migrated', () => migrated++);
    });

    await host.transferHost(300);

    await until(() => promoted === 1 && migrated === 1, 8000);
    const newHost = nodes.find((n) => n.isHost)!;
    expect(newHost.epoch).toBe(1);
  });

  it('the promoted node runs an SFU, so publishing works after failover', async () => {
    const host = new SignalingServer({
      roomId,
      w: W,
      roomParams,
      hostNickname: 'host',
      verifyInbound: true,
      heartbeatIntervalMs: 40,
      heartbeatMaxMissed: 3,
    });
    servers.push(host);
    const { port: hostPort } = await host.listen();

    for (const nickname of ['ana', 'bento']) {
      const node = new PeerNode({
        host: '127.0.0.1',
        port: hostPort,
        roomId,
        w: W,
        roomParams,
        nickname,
        inboundPort: await freePort(),
        sfu: { videoBitrateKbps: 2500 },
        heartbeatIntervalMs: 40,
        heartbeatMaxMissed: 3,
        staggerMs: 100,
        reconnectDelayMs: 120,
      });
      nodes.push(node);
      await node.start();
    }

    await until(() =>
      host.roster.filter((e) => !e.isHost).every((e) => e.inboundVerified),
    );

    let promotedCount = 0;
    nodes.forEach((n) => n.on('promoted', () => promotedCount++));
    host.crash();
    await until(() => promotedCount === 1, 12000);

    const newHost = nodes.find((n) => n.isHost)!;
    const replies: MediaBody[] = [];
    newHost.on('media', (b) => replies.push(b));

    // publish a synthetic stream straight into the promoted node's SFU
    const pc = new RTCPeerConnection({
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: 'video/VP8',
            clockRate: 90000,
            rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }],
            payloadType: 96,
          }),
        ],
      },
    });
    pc.addTransceiver(new MediaStreamTrack({ kind: 'video' }), {
      direction: 'sendonly',
    });
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise<void>((r) => {
      if (pc.iceGatheringState === 'complete') return r();
      const t = setTimeout(r, 3000);
      pc.iceGatheringStateChange.subscribe((s: string) => {
        if (s === 'complete') {
          clearTimeout(t);
          r();
        }
      });
    });

    newHost.sendMedia({
      type: 'publish_offer',
      streamId: 'post-failover',
      video: true,
      audio: false,
      sdp: pc.localDescription!.sdp,
    });

    await until(() => replies.some((b) => b.type === 'publish_answer'), 8000);
    expect(newHost.streams.map((s) => s.streamId)).toContain('post-failover');
    pc.close();
  }, 30000);
});
