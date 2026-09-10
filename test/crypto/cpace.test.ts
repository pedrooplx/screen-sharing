import { describe, expect, it } from 'vitest';
import { sha512 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { ristretto255_hasher as _h } from '@noble/curves/ed25519.js';
import { lvCat, concatBytes } from '../../src/main/crypto/lv.js';
import {
  _internal,
  hostRespond,
  newSid,
  peerBegin,
  type CpaceBinding,
} from '../../src/main/crypto/cpace.js';

const deriveToCurve = _h.deriveToCurve as (m: Uint8Array) => { toBytes(): Uint8Array };

/**
 * CFRG draft-irtf-cfrg-cpace ristretto255 (SHA-512) test vector.
 * Source: https://github.com/cfrg/draft-irtf-cfrg-cpace/blob/master/testvectors.md
 */
const VEC = {
  prs: utf8ToBytes('Password'),
  ci: hexToBytes('6f630b425f726573706f6e6465720b415f696e69746961746f72'),
  sid: hexToBytes('7e4b4791d6a8ef019b936c79fb7f2c57'),
  ada: utf8ToBytes('ADa'),
  adb: utf8ToBytes('ADb'),
  g: 'a6fc82c3b8968fbb2e06fee81ca858586dea50d248f0c7ca6a18b0902a30b36b',
  ya: 'd40fb265a7abeaee7939d91a585fe59f7053f982c296ec413c624c669308f87a',
  yb: '08bcf6e9777a9c313a3db6daa510f2d398403319c2341bd506a92e672eb7e307',
  k: 'e22b1ef7788f661478f3cddd4c600774fc0f41e6b711569190ff88fa0e607e09',
  isk: '4c5469a16b2364c4b944ebc1a79e51d1674ad47db26e8718154f59faebfaa52d8346f30aa58377117eb20d527f2cbc5c76381f7fd372e89df8239f87f2e02ed1',
};

describe('CPace draft test vector (ristretto255 / SHA-512)', () => {
  it('derives the generator string and generator point', () => {
    const gs = _internal.generatorString(VEC.prs, VEC.ci, VEC.sid);
    const g = deriveToCurve(sha512(gs));
    expect(bytesToHex(g.toBytes())).toBe(VEC.g);
  });

  it('derives ISK from the ordered transcript', () => {
    const input = concatBytes(
      lvCat(utf8ToBytes('CPaceRistretto255_ISK'), VEC.sid, hexToBytes(VEC.k)),
      lvCat(hexToBytes(VEC.ya), VEC.ada),
      lvCat(hexToBytes(VEC.yb), VEC.adb),
    );
    expect(bytesToHex(sha512(input))).toBe(VEC.isk);
    // and the module's own helper agrees
    expect(
      bytesToHex(
        _internal.deriveIsk(
          VEC.sid,
          hexToBytes(VEC.k),
          hexToBytes(VEC.ya),
          VEC.ada,
          hexToBytes(VEC.yb),
          VEC.adb,
        ),
      ),
    ).toBe(VEC.isk);
  });
});

const binding: CpaceBinding = {
  roomId: hexToBytes('0a0b0c0d'),
  protocolVersion: 1,
};
const W = sha512(utf8ToBytes('shared room password')).slice(0, 32);

describe('CPace handshake', () => {
  it('produces an equal ISK for both sides when the password matches', () => {
    const sid = newSid();
    const peer = peerBegin(W, binding, sid);
    const host = hostRespond(W, binding, sid, peer.ya);
    const result = peer.finish(host.yb, host.macHost);
    expect(bytesToHex(result.isk)).toBe(bytesToHex(host.isk));
    expect(host.verifyPeer(result.macPeer)).toBe(true);
  });

  it('does not confirm the host when the peer uses the wrong password', () => {
    const sid = newSid();
    const wrongW = sha512(utf8ToBytes('WRONG password')).slice(0, 32);
    const peer = peerBegin(wrongW, binding, sid);
    const host = hostRespond(W, binding, sid, peer.ya);
    const result = peer.finish(host.yb, host.macHost);
    expect(result.hostConfirmed).toBe(false);
    expect(host.verifyPeer(result.macPeer)).toBe(false);
  });

  it('does not confirm when the room binding differs', () => {
    const sid = newSid();
    const peer = peerBegin(W, binding, sid);
    const host = hostRespond(
      W,
      { roomId: hexToBytes('ffffffff'), protocolVersion: 1 },
      sid,
      peer.ya,
    );
    expect(peer.finish(host.yb, host.macHost).hostConfirmed).toBe(false);
  });

  it('rejects the identity element as a share', () => {
    const sid = newSid();
    const identity = new Uint8Array(32); // ristretto encoding of the identity
    expect(() => hostRespond(W, binding, sid, identity)).toThrow(/identity/i);
  });

  it('rejects a malformed share', () => {
    const sid = newSid();
    const junk = new Uint8Array(32).fill(0xff);
    expect(() => hostRespond(W, binding, sid, junk)).toThrow();
  });

  it('a tampered host MAC is not confirmed', () => {
    const sid = newSid();
    const peer = peerBegin(W, binding, sid);
    const host = hostRespond(W, binding, sid, peer.ya);
    const badMac = Uint8Array.from(host.macHost);
    badMac[0]! ^= 0xff;
    expect(peer.finish(host.yb, badMac).hostConfirmed).toBe(false);
  });
});
