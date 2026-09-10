import { describe, expect, it } from 'vitest';
import { leb128, prependLen, lvCat } from '../../src/main/crypto/lv.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('leb128', () => {
  it('encodes small values in one byte', () => {
    expect([...leb128(0)]).toEqual([0]);
    expect([...leb128(127)]).toEqual([0x7f]);
  });
  it('encodes multi-byte values (spec example)', () => {
    // prepend_len(b"1234") == 04 31 32 33 34
    expect(hex(prependLen(Buffer.from('1234')))).toBe('0431323334');
  });
  it('encodes 128 as 0x80 0x01', () => {
    expect([...leb128(128)]).toEqual([0x80, 0x01]);
  });
  it('rejects negatives', () => {
    expect(() => leb128(-1)).toThrow();
  });
});

describe('lvCat', () => {
  it('length-prefixes each field', () => {
    expect(hex(lvCat(Buffer.from('ab'), Buffer.from('cde')))).toBe(
      '02' + '6162' + '03' + '636465',
    );
  });
  it('is empty for no fields', () => {
    expect(lvCat().length).toBe(0);
  });
});
