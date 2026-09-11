import { describe, expect, it } from 'vitest';
import { Relay, type Socket } from '../../server/src/relay.js';
import {
  RELAY_PROTOCOL_VERSION,
  T,
  dataToHost,
  dataToPeer,
  decodeDataFromHost,
  decodeDataFromPeer,
  peerUp,
} from '../../server/src/wire.js';

class FakeSocket implements Socket {
  readonly sent: Buffer[] = [];
  closed = false;
  closeReason = '';
  constructor(readonly ip = '1.2.3.4') {}
  send(data: Buffer): void {
    this.sent.push(Buffer.from(data));
  }
  close(_code?: number, reason?: string): void {
    this.closed = true;
    this.closeReason = reason ?? '';
  }
  lastType(): number | undefined {
    return this.sent.at(-1)?.[0];
  }
  json(i = -1): unknown {
    const b = this.sent.at(i)!;
    return JSON.parse(b.subarray(1).toString('utf8'));
  }
}

const hello = (role: 'host' | 'peer', roomId = 'deadbeef') => ({
  role,
  roomId,
  app: '0.1.0',
  proto: RELAY_PROTOCOL_VERSION,
});

describe('Relay', () => {
  it('creates a room and hands the host a token', () => {
    const relay = new Relay();
    const host = new FakeSocket();
    relay.onHello(host, hello('host'));
    expect(host.lastType()).toBe(T.READY);
    expect((host.json() as { hostToken: string }).hostToken).toMatch(/^[0-9a-f]{32}$/);
    expect(relay.roomCount).toBe(1);
  });

  it('rejects a second host for the same room', () => {
    const relay = new Relay();
    relay.onHello(new FakeSocket('a'), hello('host'));
    const dup = new FakeSocket('b');
    relay.onHello(dup, hello('host'));
    expect(dup.lastType()).toBe(T.REJECT);
    expect((dup.json() as { reason: string }).reason).toBe('room_exists');
    expect(dup.closed).toBe(true);
  });

  it('rejects a peer for a room that does not exist', () => {
    const relay = new Relay();
    const peer = new FakeSocket();
    relay.onHello(peer, hello('peer'));
    expect((peer.json() as { reason: string }).reason).toBe('no_such_room');
  });

  it('notifies the host with PEER_UP and assigns a connId', () => {
    const relay = new Relay();
    const host = new FakeSocket();
    relay.onHello(host, hello('host'));
    const peer = new FakeSocket();
    relay.onHello(peer, hello('peer'));

    expect((peer.json() as { connId: number }).connId).toBe(1);
    const up = host.sent.at(-1)!;
    expect(up[0]).toBe(T.PEER_UP);
    expect((JSON.parse(up.subarray(1).toString()) as { connId: number }).connId).toBe(1);
  });

  it('relays payloads both ways without inspecting them', () => {
    const relay = new Relay();
    const host = new FakeSocket();
    relay.onHello(host, hello('host'));
    const peer = new FakeSocket();
    relay.onHello(peer, hello('peer'));
    host.sent.length = 0;
    peer.sent.length = 0;

    // peer -> host
    relay.onMessage(peer, dataToPeer(true, Buffer.from('cpace-ya')));
    const toHost = decodeDataFromHost(host.sent.at(-1)!)!;
    expect(toHost.connId).toBe(1);
    expect(toHost.isBinary).toBe(true);
    expect(toHost.payload.toString()).toBe('cpace-ya');

    // host -> peer
    relay.onMessage(host, dataToHost(1, false, Buffer.from('{"type":"hello_ack"}')));
    const toPeer = decodeDataFromPeer(peer.sent.at(-1)!)!;
    expect(toPeer.isBinary).toBe(false);
    expect(toPeer.payload.toString()).toBe('{"type":"hello_ack"}');
  });

  it('does not deliver a peer frame to the wrong peer', () => {
    const relay = new Relay();
    const host = new FakeSocket();
    relay.onHello(host, hello('host'));
    const a = new FakeSocket();
    const b = new FakeSocket();
    relay.onHello(a, hello('peer'));
    relay.onHello(b, hello('peer'));
    a.sent.length = 0;
    b.sent.length = 0;

    relay.onMessage(host, dataToHost(1, true, Buffer.from('for-a')));
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);
  });

  it('tears the room down when the host disconnects', () => {
    const relay = new Relay();
    const host = new FakeSocket();
    relay.onHello(host, hello('host'));
    const peer = new FakeSocket();
    relay.onHello(peer, hello('peer'));

    relay.onClose(host);
    expect(relay.roomCount).toBe(0);
    expect(peer.lastType()).toBe(T.HOST_GONE);
    expect(peer.closed).toBe(true);
  });

  it('tells the host PEER_DOWN when a peer disconnects', () => {
    const relay = new Relay();
    const host = new FakeSocket();
    relay.onHello(host, hello('host'));
    const peer = new FakeSocket();
    relay.onHello(peer, hello('peer'));
    host.sent.length = 0;

    relay.onClose(peer);
    expect(host.sent.at(-1)![0]).toBe(T.PEER_DOWN);
    expect(relay.peerCount('deadbeef')).toBe(0);
  });

  it('answers a PING with a PONG', () => {
    const relay = new Relay();
    const s = new FakeSocket();
    relay.onMessage(s, Buffer.from([T.PING]));
    expect(s.sent.at(-1)![0]).toBe(T.PONG);
  });

  it('rate-limits room creation per IP', () => {
    let now = 0;
    const relay = new Relay(
      {
        maxRooms: 100,
        maxPeersPerRoom: 24,
        roomCreatesPerWindow: 2,
        joinsPerWindow: 40,
        rateWindowMs: 60_000,
      },
      () => now,
    );
    relay.onHello(new FakeSocket('x'), hello('host', 'aaaaaaaa'));
    relay.onHello(new FakeSocket('x'), hello('host', 'bbbbbbbb'));
    const third = new FakeSocket('x');
    relay.onHello(third, hello('host', 'cccccccc'));
    expect((third.json() as { reason: string }).reason).toBe('rate_limited');
  });

  it('rejects a protocol-version mismatch', () => {
    const relay = new Relay();
    const s = new FakeSocket();
    relay.onHello(s, { ...hello('host'), proto: 99 });
    expect((s.json() as { reason: string }).reason).toBe('proto_mismatch');
  });

  it('enforces max peers per room', () => {
    const relay = new Relay({
      maxRooms: 10,
      maxPeersPerRoom: 1,
      roomCreatesPerWindow: 10,
      joinsPerWindow: 40,
      rateWindowMs: 60_000,
    });
    relay.onHello(new FakeSocket(), hello('host'));
    relay.onHello(new FakeSocket(), hello('peer'));
    const overflow = new FakeSocket();
    relay.onHello(overflow, hello('peer'));
    expect((overflow.json() as { reason: string }).reason).toBe('room_full');
  });

  it('wire helpers round-trip', () => {
    const up = peerUp(7);
    expect(up[0]).toBe(T.PEER_UP);
    const rt = decodeDataFromHost(dataToHost(42, true, Buffer.from('x')))!;
    expect(rt).toMatchObject({ connId: 42, isBinary: true });
  });
});
