import { describe, expect, it } from 'vitest';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  argonParamsAcceptable,
  deriveArgonSalt,
  deriveRoomMediaKey,
  deriveTransportKeys,
  derivePasswordKey,
  expandKey,
  MIN_ARGON_PARAMS,
  preparePassword,
} from '../../src/main/crypto/kdf.js';

const roomId = utf8ToBytes('room');
const codeSalt = utf8ToBytes('saltxx');

describe('preparePassword', () => {
  it('maps a non-ASCII space to U+0020', () => {
    expect(bytesToHex(preparePassword('a b'))).toBe(
      bytesToHex(preparePassword('a b')),
    );
  });
  it('normalizes to NFC', () => {
    // "é" as U+0065 U+0301 vs U+00E9
    expect(bytesToHex(preparePassword('é'))).toBe(
      bytesToHex(preparePassword('é')),
    );
  });
  it('does NOT case-fold', () => {
    expect(bytesToHex(preparePassword('Secret'))).not.toBe(
      bytesToHex(preparePassword('secret')),
    );
  });
});

describe('deriveArgonSalt', () => {
  it('is deterministic and 16 bytes', () => {
    const a = deriveArgonSalt(roomId, codeSalt);
    const b = deriveArgonSalt(roomId, codeSalt);
    expect(a.length).toBe(16);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });
  it('changes with the room parameters', () => {
    expect(bytesToHex(deriveArgonSalt(roomId, codeSalt))).not.toBe(
      bytesToHex(deriveArgonSalt(utf8ToBytes('rooM'), codeSalt)),
    );
  });
});

describe('derivePasswordKey (w)', () => {
  it('is deterministic for the same inputs', () => {
    const salt = deriveArgonSalt(roomId, codeSalt);
    const w1 = derivePasswordKey('hunter2', salt, MIN_ARGON_PARAMS);
    const w2 = derivePasswordKey('hunter2', salt, MIN_ARGON_PARAMS);
    expect(w1.length).toBe(32);
    expect(bytesToHex(w1)).toBe(bytesToHex(w2));
  });
  it('differs for a different password', () => {
    const salt = deriveArgonSalt(roomId, codeSalt);
    expect(bytesToHex(derivePasswordKey('a', salt, MIN_ARGON_PARAMS))).not.toBe(
      bytesToHex(derivePasswordKey('b', salt, MIN_ARGON_PARAMS)),
    );
  });
});

describe('session key expansion', () => {
  const isk = utf8ToBytes('x'.repeat(64));
  it('produces distinct, domain-separated keys', () => {
    const keys = deriveTransportKeys(isk);
    const all = [
      bytesToHex(keys.c2s.key),
      bytesToHex(keys.s2c.key),
      bytesToHex(keys.c2s.nonceSalt),
      bytesToHex(keys.s2c.nonceSalt),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(keys.c2s.key.length).toBe(32);
    expect(keys.c2s.nonceSalt.length).toBe(4);
  });
  it('roomMediaKey depends on w, not on the session', () => {
    const w = utf8ToBytes('w'.repeat(32));
    expect(bytesToHex(deriveRoomMediaKey(w))).toBe(
      bytesToHex(deriveRoomMediaKey(w)),
    );
    expect(bytesToHex(deriveRoomMediaKey(w))).not.toBe(
      bytesToHex(expandKey(w, 'frame-c2s/v1', 32)),
    );
  });
});

describe('argonParamsAcceptable', () => {
  it('accepts the minimum', () => {
    expect(argonParamsAcceptable(MIN_ARGON_PARAMS)).toBe(true);
  });
  it('rejects a downgrade below the floor', () => {
    expect(argonParamsAcceptable({ m: 1024, t: 1, p: 1 })).toBe(false);
    expect(argonParamsAcceptable({ m: 65536, t: 1, p: 1 })).toBe(false);
  });
});
