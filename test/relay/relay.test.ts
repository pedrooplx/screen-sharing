import { describe, expect, it } from 'vitest';
import { Relay, type Socket } from '../../server/src/relay.js';
import {
  RELAY_PROTOCOL_VERSION,
  T,
  dataToHost,
  dataToPeer,
  decodeDataFromHost,
  decodeDataFromPeer,
  kick,
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

  it('drops one peer on KICK without touching the others or the room', () => {
    const relay = new Relay();
    const host = new FakeSocket();
    relay.onHello(host, hello('host'));
    const a = new FakeSocket();
    const b = new FakeSocket();
    relay.onHello(a, hello('peer')); // connId 1
    relay.onHello(b, hello('peer')); // connId 2

    relay.onMessage(host, kick(1));

    expect(a.closed).toBe(true);
    expect(a.closeReason).toBe('kicked');
    expect(b.closed).toBe(false);
    expect(relay.peerCount('deadbeef')).toBe(1);
    expect(relay.roomCount).toBe(1);
  });

  it('ignores a KICK for an unknown connId (already gone, or bogus)', () => {
    const relay = new Relay();
    const host = new FakeSocket();
    relay.onHello(host, hello('host'));
    expect(() => relay.onMessage(host, kick(999))).not.toThrow();
    expect(relay.roomCount).toBe(1);
  });

  it('ignores a KICK sent by a peer (only the host may kick)', () => {
    const relay = new Relay();
    relay.onHello(new FakeSocket(), hello('host'));
    const peer = new FakeSocket();
    relay.onHello(peer, hello('peer'));
    const other = new FakeSocket();
    relay.onHello(other, hello('peer'));

    // KICK is only interpreted in the `role === 'host'` branch; from a peer
    // it fails to decode as DATA_P and is silently dropped - a peer can never
    // drop another peer.
    relay.onMessage(peer, kick(2));
    expect(other.closed).toBe(false);
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

describe('graceful handoff', () => {
  const handoff = Buffer.from([T.HANDOFF]);

  it('does not touch peers or the room by itself', () => {
    const relay = new Relay();
    const host = new FakeSocket();
    relay.onHello(host, hello('host'));
    const peer = new FakeSocket();
    relay.onHello(peer, hello('peer'));
    peer.sent.length = 0;

    relay.onMessage(host, handoff);

    expect(peer.sent).toHaveLength(0);
    expect(peer.closed).toBe(false);
    expect(relay.roomCount).toBe(1);
  });

  it('lets a new host claim the room instead of rejecting room_exists', () => {
    const relay = new Relay();
    const host = new FakeSocket('host-ip');
    relay.onHello(host, hello('host'));
    const peer = new FakeSocket('peer-ip');
    relay.onHello(peer, hello('peer'));
    peer.sent.length = 0;

    relay.onMessage(host, handoff);
    const successor = new FakeSocket('successor-ip');
    relay.onHello(successor, hello('host'));

    // READY comes first, then a PEER_UP for the still-connected survivor
    expect(successor.sent[0]?.[0]).toBe(T.READY);
    expect((successor.json(0) as { hostToken: string }).hostToken).toMatch(/^[0-9a-f]{32}$/);
    expect(relay.roomCount).toBe(1);
    expect(successor.sent.some((b) => b[0] === T.PEER_UP)).toBe(true);

    // the survivor's OWN socket gets told directly, so it knows precisely
    // when to retry instead of guessing (RoomSession#rehome) - it must not
    // have to wait for anything routed through the new host first.
    expect(peer.sent.some((b) => b[0] === T.HOST_CLAIMED)).toBe(true);
  });

  it('does not tear the room down when the old host disconnects mid-handoff', () => {
    const relay = new Relay();
    const host = new FakeSocket();
    relay.onHello(host, hello('host'));
    const peer = new FakeSocket();
    relay.onHello(peer, hello('peer'));
    peer.sent.length = 0;

    relay.onMessage(host, handoff);
    relay.onClose(host);

    expect(peer.sent).toHaveLength(0);
    expect(peer.closed).toBe(false);
    expect(relay.roomCount).toBe(1);
  });

  it('routes a claiming host to survivors, and a later peer join still works', () => {
    const relay = new Relay();
    const host = new FakeSocket();
    relay.onHello(host, hello('host'));
    const peer = new FakeSocket();
    relay.onHello(peer, hello('peer')); // connId 1

    relay.onMessage(host, handoff);
    const successor = new FakeSocket();
    relay.onHello(successor, hello('host'));
    successor.sent.length = 0;

    // the survivor's traffic now reaches the new host
    relay.onMessage(peer, dataToPeer(true, Buffer.from('hello')));
    const toHost = decodeDataFromHost(successor.sent.at(-1)!)!;
    expect(toHost.connId).toBe(1);
    expect(toHost.payload.toString()).toBe('hello');

    // a brand new peer can still join the claimed room normally
    const carol = new FakeSocket();
    relay.onHello(carol, hello('peer'));
    expect(carol.lastType()).toBe(T.READY);
    expect(relay.peerCount('deadbeef')).toBe(2);
  });

  it('tears the room down via sweep() once the grace window elapses unclaimed', () => {
    let now = 0;
    const relay = new Relay(
      {
        maxRooms: 100,
        maxPeersPerRoom: 24,
        roomCreatesPerWindow: 10,
        joinsPerWindow: 40,
        rateWindowMs: 60_000,
      },
      () => now,
    );
    const host = new FakeSocket();
    relay.onHello(host, hello('host'));
    const peer = new FakeSocket();
    relay.onHello(peer, hello('peer'));
    peer.sent.length = 0;

    relay.onMessage(host, handoff);
    relay.onClose(host);
    relay.sweep(); // still well inside the grace window
    expect(relay.roomCount).toBe(1);
    expect(peer.closed).toBe(false);

    now += 9_000; // past HANDOFF_GRACE_MS
    relay.sweep();

    expect(relay.roomCount).toBe(0);
    expect(peer.lastType()).toBe(T.HOST_GONE);
    expect(peer.closed).toBe(true);
  });

  it('a peer sending HANDOFF is ignored (only the host may hand off)', () => {
    const relay = new Relay();
    const host = new FakeSocket();
    relay.onHello(host, hello('host'));
    const peer = new FakeSocket();
    relay.onHello(peer, hello('peer'));

    relay.onMessage(peer, handoff);
    const impostor = new FakeSocket();
    relay.onHello(impostor, hello('host'));

    // no handoff was actually armed, so a second host is still rejected
    expect((impostor.json() as { reason: string }).reason).toBe('room_exists');
  });

  it('ignores HANDOFF from a stale host reference no longer owning the room', () => {
    const relay = new Relay();
    const host = new FakeSocket();
    relay.onHello(host, hello('host'));
    relay.onHello(new FakeSocket(), hello('peer'));

    relay.onMessage(host, handoff);
    const successor = new FakeSocket();
    relay.onHello(successor, hello('host')); // claims the room

    // the original host is now stale; its own (late) HANDOFF must not affect
    // the room the successor just took over
    relay.onMessage(host, handoff);
    const impostor = new FakeSocket();
    relay.onHello(impostor, hello('host'));
    expect((impostor.json() as { reason: string }).reason).toBe('room_exists');
  });
});
