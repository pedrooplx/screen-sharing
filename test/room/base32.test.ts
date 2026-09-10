import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  Base32Error,
  base32Decode,
  base32Encode,
} from '../../src/main/room/base32.js';

describe('crockford base32', () => {
  it('round-trips arbitrary byte lengths', () => {
    for (const len of [1, 4, 5, 20, 32, 100]) {
      const bytes = new Uint8Array(randomBytes(len));
      expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
    }
  });

  it('encodes 20 bytes as 32 symbols', () => {
    expect(base32Encode(new Uint8Array(20)).length).toBe(32);
  });

  it('omits I, L, O, U from the alphabet', () => {
    const s = base32Encode(new Uint8Array(randomBytes(64)));
    expect(s).not.toMatch(/[ILOU]/);
  });

  it('accepts confusable characters on decode', () => {
    const canonical = base32Encode(Uint8Array.from([0x10, 0x11, 0x00]));
    const withConfusables = canonical
      .replace(/0/g, 'O')
      .replace(/1/g, 'I');
    expect([...base32Decode(withConfusables)]).toEqual([
      ...base32Decode(canonical),
    ]);
  });

  it('ignores hyphens, spaces and case', () => {
    const s = base32Encode(Uint8Array.from([1, 2, 3, 4, 5]));
    expect([...base32Decode(`  ${s.toLowerCase().replace(/(.{2})/g, '$1-')} `)]).toEqual(
      [...base32Decode(s)],
    );
  });

  it('rejects an unknown symbol', () => {
    expect(() => base32Decode('!!!!')).toThrow(Base32Error);
  });

  it('rejects non-zero trailing bits', () => {
    // 'ZZ' = 10 bits all set -> 1 byte + 2 leftover bits that are non-zero
    expect(() => base32Decode('ZZ')).toThrow(Base32Error);
  });
});
