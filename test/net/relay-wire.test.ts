import { describe, expect, it } from 'vitest';
import {
  RELAY_PROTOCOL_VERSION,
  T,
  decodeRelayFrame,
  encodeDataH,
  encodeDataP,
  encodeHello,
  encodeKick,
  encodePing,
} from '../../src/main/net/relay-wire.js';

describe('relay-wire (client side)', () => {
  it('encodes HELLO as a type-prefixed JSON body', () => {
    const buf = encodeHello({ role: 'peer', roomId: 'deadbeef', app: '0.1.0' });
    expect(buf[0]).toBe(T.HELLO);
    const obj = JSON.parse(buf.subarray(1).toString('utf8'));
    expect(obj).toEqual({
      role: 'peer',
      roomId: 'deadbeef',
      app: '0.1.0',
      proto: RELAY_PROTOCOL_VERSION,
    });
  });

  it('includes hostToken in HELLO only when given', () => {
    const withToken = encodeHello({
      role: 'host',
      roomId: 'deadbeef',
      app: '0.1.0',
      hostToken: 'abc123',
    });
    expect(JSON.parse(withToken.subarray(1).toString('utf8')).hostToken).toBe('abc123');
    const without = encodeHello({ role: 'host', roomId: 'deadbeef', app: '0.1.0' });
    expect(JSON.parse(without.subarray(1).toString('utf8'))).not.toHaveProperty(
      'hostToken',
    );
  });

  it('decodes READY with a connId (peer) and with a hostToken (host)', () => {
    const forPeer = Buffer.concat([
      Buffer.from([T.READY]),
      Buffer.from(JSON.stringify({ connId: 7 })),
    ]);
    expect(decodeRelayFrame(forPeer)).toEqual({ t: 'ready', connId: 7 });

    const forHost = Buffer.concat([
      Buffer.from([T.READY]),
      Buffer.from(JSON.stringify({ hostToken: 'tok' })),
    ]);
    expect(decodeRelayFrame(forHost)).toEqual({ t: 'ready', hostToken: 'tok' });
  });

  it('decodes REJECT, PEER_UP, PEER_DOWN, HOST_GONE, PONG', () => {
    const reject = Buffer.concat([
      Buffer.from([T.REJECT]),
      Buffer.from(JSON.stringify({ reason: 'room_full' })),
    ]);
    expect(decodeRelayFrame(reject)).toEqual({ t: 'reject', reason: 'room_full' });

    const up = Buffer.concat([
      Buffer.from([T.PEER_UP]),
      Buffer.from(JSON.stringify({ connId: 3 })),
    ]);
    expect(decodeRelayFrame(up)).toEqual({ t: 'peer_up', connId: 3 });

    const down = Buffer.concat([
      Buffer.from([T.PEER_DOWN]),
      Buffer.from(JSON.stringify({ connId: 3 })),
    ]);
    expect(decodeRelayFrame(down)).toEqual({ t: 'peer_down', connId: 3 });

    expect(decodeRelayFrame(Buffer.from([T.HOST_GONE]))).toEqual({ t: 'host_gone' });
    expect(decodeRelayFrame(Buffer.from([T.PONG]))).toEqual({ t: 'pong' });
  });

  it('round-trips DATA_H (host -> relay -> peer, tagged with connId)', () => {
    const payload = Buffer.from('hello peer');
    const frame = encodeDataH(42, true, payload);
    expect(decodeRelayFrame(frame)).toEqual({
      t: 'data',
      connId: 42,
      isBinary: true,
      payload,
    });
  });

  it('round-trips DATA_P (peer -> relay -> host, no connId of its own)', () => {
    const payload = Buffer.from('hello host');
    const frame = encodeDataP(false, payload);
    const decoded = decodeRelayFrame(frame);
    expect(decoded).toEqual({ t: 'data', isBinary: false, payload });
    expect(decoded).not.toHaveProperty('connId');
  });

  it('encodes KICK as a fixed 5-byte frame', () => {
    const buf = encodeKick(1000);
    expect(buf).toHaveLength(5);
    expect(buf[0]).toBe(T.KICK);
    expect(buf.readUInt32BE(1)).toBe(1000);
  });

  it('encodes PING as a single byte', () => {
    expect(encodePing()).toEqual(Buffer.from([T.PING]));
  });

  it('returns null for garbage, empty, unknown type, or truncated frames', () => {
    expect(decodeRelayFrame(Buffer.alloc(0))).toBeNull();
    expect(decodeRelayFrame(Buffer.from([0xff]))).toBeNull();
    expect(decodeRelayFrame(Buffer.from([T.DATA_H, 0, 0]))).toBeNull(); // too short
    expect(decodeRelayFrame(Buffer.from([T.READY, ...Buffer.from('not json')]))).toBeNull();
  });
});
