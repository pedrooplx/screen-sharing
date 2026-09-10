/**
 * Key derivation for the control plane.
 *
 * Chain (see docs/DESIGN.md section 6):
 *
 *   argonSalt   = HKDF-SHA256(roomId ‖ codeSalt, info="argon-salt/v1", 16)
 *   w           = Argon2id(prep(password), argonSalt, 64 MiB / t=3 / p=1) -> 32 bytes
 *   ISK         = <produced by CPace, see cpace.ts>
 *   k_c2s / k_s2c = HKDF-SHA512(ISK, info "frame-c2s/v1" | "frame-s2c/v1", 32)
 *   roomMediaKey= HKDF-SHA512(w,  info="media-key/v1", 32)
 *
 * `w` depends only on (password, salt) so it is computed once per process and
 * reused for every handshake, reconnect and failover. `roomMediaKey` derives
 * from `w` (not from a session key) precisely so it is identical for every
 * participant and survives a host change without any secret being transferred.
 */

import { argon2id } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { concatBytes } from './lv.js';

const DOMAIN = 'erros-share/';

/** Argon2id parameters. Versioned: the host announces these in `hello_ack` and
 *  peers follow, so they can be retuned without a protocol break. */
export interface ArgonParams {
  /** memory in KiB */
  readonly m: number;
  /** iterations */
  readonly t: number;
  /** parallelism (pure-JS impl is single-threaded regardless) */
  readonly p: number;
}

export const DEFAULT_ARGON_PARAMS: ArgonParams = { m: 65536, t: 3, p: 1 };

/** OWASP-minimum floor. A peer refuses parameters weaker than this to stop a
 *  malicious host from downgrading the password hardening. */
export const MIN_ARGON_PARAMS: ArgonParams = { m: 19456, t: 2, p: 1 };

export function argonParamsAcceptable(p: ArgonParams): boolean {
  return (
    Number.isInteger(p.m) &&
    Number.isInteger(p.t) &&
    Number.isInteger(p.p) &&
    p.m >= MIN_ARGON_PARAMS.m &&
    p.t >= MIN_ARGON_PARAMS.t &&
    p.p >= 1 &&
    p.m <= 1_048_576 &&
    p.t <= 16 &&
    p.p <= 4
  );
}

/**
 * Non-ASCII space characters (Unicode "Zs" category plus the tab-adjacent
 * ones) that RFC 8265's OpaqueString profile maps to U+0020.
 */
const NON_ASCII_SPACE = new RegExp(
  '[' +
    [
      0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
      0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000,
    ]
      .map((cp) => '\\u' + cp.toString(16).padStart(4, '0'))
      .join('') +
    ']',
  'g',
);

/**
 * Prepare a password for hashing, following the spirit of RFC 8265's
 * OpaqueString profile: map every Unicode space to U+0020, normalize to NFC,
 * do NOT case-fold. This keeps the same typed password stable across keyboards
 * and operating systems without weakening it.
 */
export function preparePassword(password: string): Uint8Array {
  return utf8ToBytes(password.replace(NON_ASCII_SPACE, ' ').normalize('NFC'));
}

/** HKDF-Expand-ish helper over SHA-512 with our domain prefix on the info. */
export function expandKey(
  ikm: Uint8Array,
  info: string,
  length = 32,
): Uint8Array {
  return hkdf(sha512, ikm, undefined, utf8ToBytes(DOMAIN + info), length);
}

/**
 * Derive the 16-byte Argon2id salt from public room parameters. Not secret;
 * its only job is to make the same password in different rooms hash to
 * different keys. 80 bits of entropy (roomId ‖ codeSalt) is plenty because the
 * dictionary attack here is strictly online (section 6.4).
 */
export function deriveArgonSalt(
  roomId: Uint8Array,
  codeSalt: Uint8Array,
): Uint8Array {
  return hkdf(
    sha256,
    concatBytes(roomId, codeSalt),
    undefined,
    utf8ToBytes(DOMAIN + 'argon-salt/v1'),
    16,
  );
}

/**
 * The password-derived key `w`. Expensive (~1 s) and intentionally so; compute
 * it once and cache it for the lifetime of the room membership.
 */
export function derivePasswordKey(
  password: string,
  argonSalt: Uint8Array,
  params: ArgonParams = DEFAULT_ARGON_PARAMS,
): Uint8Array {
  return argon2id(preparePassword(password), argonSalt, {
    m: params.m,
    t: params.t,
    p: params.p,
    dkLen: 32,
  });
}

export interface TransportKeys {
  /** peer -> host frames */
  readonly c2s: { key: Uint8Array; nonceSalt: Uint8Array };
  /** host -> peer frames */
  readonly s2c: { key: Uint8Array; nonceSalt: Uint8Array };
}

/** Split the CPace ISK into per-direction AEAD keys + nonce salts. */
export function deriveTransportKeys(isk: Uint8Array): TransportKeys {
  return {
    c2s: {
      key: expandKey(isk, 'frame-c2s/v1', 32),
      nonceSalt: expandKey(isk, 'frame-c2s-salt/v1', 4),
    },
    s2c: {
      key: expandKey(isk, 'frame-s2c/v1', 32),
      nonceSalt: expandKey(isk, 'frame-s2c-salt/v1', 4),
    },
  };
}

/** The room-wide media key (E2EE extension point, section 8.4). Same for all. */
export function deriveRoomMediaKey(w: Uint8Array): Uint8Array {
  return expandKey(w, 'media-key/v1', 32);
}

/** Best-effort zeroing of sensitive buffers. */
export function wipe(...buffers: Uint8Array[]): void {
  for (const b of buffers) b.fill(0);
}
