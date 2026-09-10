import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { AeadError, open, seal } from '../../src/main/crypto/aead.js';

const key = new Uint8Array(randomBytes(32));
const nonce = new Uint8Array(randomBytes(12));
const aad = new Uint8Array([1, 2, 3, 4]);
const msg = Buffer.from('mensagem de teste');

describe('aead seal/open', () => {
  it('round-trips', () => {
    const sealed = seal(key, nonce, msg, aad);
    expect(Buffer.from(open(key, nonce, sealed, aad)).toString()).toBe(
      msg.toString(),
    );
  });

  it('rejects a flipped ciphertext bit', () => {
    const sealed = seal(key, nonce, msg, aad);
    sealed[2]! ^= 0x01;
    expect(() => open(key, nonce, sealed, aad)).toThrow(AeadError);
  });

  it('rejects altered AAD', () => {
    const sealed = seal(key, nonce, msg, aad);
    expect(() => open(key, nonce, sealed, new Uint8Array([9, 9, 9, 9]))).toThrow(
      AeadError,
    );
  });

  it('rejects a wrong key', () => {
    const sealed = seal(key, nonce, msg, aad);
    expect(() =>
      open(new Uint8Array(randomBytes(32)), nonce, sealed, aad),
    ).toThrow(AeadError);
  });

  it('rejects a wrong nonce', () => {
    const sealed = seal(key, nonce, msg, aad);
    expect(() =>
      open(key, new Uint8Array(randomBytes(12)), sealed, aad),
    ).toThrow(AeadError);
  });

  it('validates key and nonce sizes', () => {
    expect(() => seal(new Uint8Array(16), nonce, msg, aad)).toThrow(AeadError);
    expect(() => seal(key, new Uint8Array(8), msg, aad)).toThrow(AeadError);
  });
});
