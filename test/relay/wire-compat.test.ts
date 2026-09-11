/**
 * `server/src/wire.ts` and `src/main/net/relay-wire.ts` are two independent
 * files (server/ is a standalone deployable - see its README) that must agree
 * on the wire format byte for byte. This test is what keeps them honest: every
 * frame one side encodes must decode cleanly on the other.
 */
import { describe, expect, it } from 'vitest';
import * as serverWire from '../../server/src/wire.js';
import * as clientWire from '../../src/main/net/relay-wire.js';

describe('wire compat: server/src/wire.ts <-> src/main/net/relay-wire.ts', () => {
  it('agree on the protocol version and the type-byte table', () => {
    expect(clientWire.RELAY_PROTOCOL_VERSION).toBe(serverWire.RELAY_PROTOCOL_VERSION);
    expect(clientWire.T).toEqual(serverWire.T);
  });

  it('client HELLO decodes on the server, with and without a hostToken', () => {
    const noToken = clientWire.encodeHello({
      role: 'peer',
      roomId: 'deadbeef',
      app: '0.1.0',
    });
    expect(serverWire.decodeHello(noToken)).toEqual({
      role: 'peer',
      roomId: 'deadbeef',
      app: '0.1.0',
      proto: serverWire.RELAY_PROTOCOL_VERSION,
    });

    const withToken = clientWire.encodeHello({
      role: 'host',
      roomId: 'deadbeef',
      app: '0.1.0',
      hostToken: 'a'.repeat(32),
    });
    expect(serverWire.decodeHello(withToken)).toMatchObject({
      role: 'host',
      hostToken: 'a'.repeat(32),
    });
  });

  it('server READY (both shapes) decodes on the client', () => {
    const forPeer = serverWire.ready({ connId: 9 });
    expect(clientWire.decodeRelayFrame(forPeer)).toEqual({ t: 'ready', connId: 9 });

    const forHost = serverWire.ready({ hostToken: 'tok' });
    expect(clientWire.decodeRelayFrame(forHost)).toEqual({ t: 'ready', hostToken: 'tok' });
  });

  it('server REJECT / PEER_UP / PEER_DOWN / HOST_GONE / PONG decode on the client', () => {
    expect(clientWire.decodeRelayFrame(serverWire.reject('room_full'))).toEqual({
      t: 'reject',
      reason: 'room_full',
    });
    expect(clientWire.decodeRelayFrame(serverWire.peerUp(5))).toEqual({
      t: 'peer_up',
      connId: 5,
    });
    expect(clientWire.decodeRelayFrame(serverWire.peerDown(5))).toEqual({
      t: 'peer_down',
      connId: 5,
    });
    expect(clientWire.decodeRelayFrame(serverWire.hostGone())).toEqual({ t: 'host_gone' });
    expect(clientWire.decodeRelayFrame(serverWire.pong())).toEqual({ t: 'pong' });
  });

  it('a peer-bound DATA_P frame is identical whichever side encodes it', () => {
    const payload = Buffer.from('opaque cpace/frame bytes');
    const fromClient = clientWire.encodeDataP(true, payload);
    const fromServer = serverWire.dataToPeer(true, payload);
    expect(fromClient).toEqual(fromServer);
    expect(clientWire.decodeRelayFrame(fromServer)).toEqual({
      t: 'data',
      isBinary: true,
      payload,
    });
  });

  it('a host-bound DATA_H frame round-trips connId + payload both ways', () => {
    const payload = Buffer.from('opaque frame bytes');
    const fromClient = clientWire.encodeDataH(123, false, payload);
    const fromServer = serverWire.dataToHost(123, false, payload);
    expect(fromClient).toEqual(fromServer);

    // the server is the one that actually parses a peer's DATA_P and a host's
    // DATA_H - confirm it accepts what the client encodes.
    const peerPayload = Buffer.from('peer -> relay');
    expect(serverWire.decodeDataFromPeer(clientWire.encodeDataP(false, peerPayload))).toEqual({
      isBinary: false,
      payload: peerPayload,
    });
    expect(serverWire.decodeDataFromHost(fromClient)).toEqual({
      connId: 123,
      isBinary: false,
      payload,
    });
  });

  it('client KICK decodes on the server', () => {
    const buf = clientWire.encodeKick(77);
    expect(serverWire.decodeKick(buf)).toBe(77);
  });

  it('PING is a single byte on both sides', () => {
    expect(clientWire.encodePing()).toEqual(Buffer.from([serverWire.T.PING]));
  });
});
