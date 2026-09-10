/**
 * AES-256-GCM sealing for the control-plane frame codec.
 *
 * Uses Node's native crypto (fast, zero dependency). The tag is appended to the
 * ciphertext. `open` throws on any authentication failure - callers treat that
 * as a fatal protocol error and drop the connection.
 */

import { createCipheriv, createDecipheriv } from 'node:crypto';

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

export class AeadError extends Error {
  override name = 'AeadError';
}

export function seal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.length !== KEY_BYTES) throw new AeadError('key must be 32 bytes');
  if (nonce.length !== NONCE_BYTES) throw new AeadError('nonce must be 12 bytes');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([body, tag]);
}

export function open(
  key: Uint8Array,
  nonce: Uint8Array,
  sealed: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.length !== KEY_BYTES) throw new AeadError('key must be 32 bytes');
  if (nonce.length !== NONCE_BYTES) throw new AeadError('nonce must be 12 bytes');
  if (sealed.length < TAG_BYTES) throw new AeadError('sealed payload too short');
  const body = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new AeadError('authentication failed');
  }
}
