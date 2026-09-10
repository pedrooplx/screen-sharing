/**
 * CPace (draft-irtf-cfrg-cpace-21) over group ristretto255, hash SHA-512.
 *
 * CPace is a balanced PAKE: both sides prove knowledge of the same low-entropy
 * secret (here `w` = Argon2id(password)) without revealing it, and an attacker
 * who records a full transcript CANNOT mount an offline dictionary attack. That
 * last property is why a plain challenge-response with Argon2id is not enough
 * (see docs/DESIGN.md section 6.1).
 *
 * Verified against the CFRG draft ristretto255 test vector in
 * test/crypto/cpace.test.ts:
 *   - generator  = ristretto255_deriveToCurve( SHA-512(generator_string) )
 *   - ISK        = SHA-512( lv_cat(DSI_ISK, sid, K) || lv_cat(Ya,ADa) || lv_cat(Yb,ADb) )
 *
 * On top of bare CPace we add explicit mutual key confirmation (MAC_host /
 * MAC_peer) so neither side sends application data until both have proven the
 * shared key. A wrong password simply fails confirmation; the connection dies
 * before any room information is exposed.
 */

import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { concatBytes, lvCat } from './lv.js';
import { expandKey } from './kdf.js';

const Point = ristretto255.Point;
type RPoint = ReturnType<typeof Point.fromBytes>;
const deriveToCurve = ristretto255_hasher.deriveToCurve as (msg: Uint8Array) => RPoint;
const GROUP_ORDER = Point.Fn.ORDER;

const DSI = utf8ToBytes('CPaceRistretto255');
const DSI_ISK = utf8ToBytes('CPaceRistretto255_ISK');
/** Zero-padding target: push PRS into its own SHA-512 input block. */
const ZPAD_TARGET = 128;

export const SID_BYTES = 16;
export const POINT_BYTES = 32;
export const MAC_BYTES = 32;

export class CpaceError extends Error {
  override name = 'CpaceError';
}

/** Public, non-secret inputs that bind the session to this room + version. */
export interface CpaceBinding {
  /** 4-byte room identifier from the room code */
  readonly roomId: Uint8Array;
  readonly protocolVersion: number;
}

function channelId(b: CpaceBinding): Uint8Array {
  return concatBytes(
    utf8ToBytes(`erros-share/v${b.protocolVersion}/`),
    b.roomId,
  );
}

function generatorString(w: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  const prsField = lvLen(w.length) + w.length;
  const dsiField = lvLen(DSI.length) + DSI.length;
  const zpadLen = Math.max(0, ZPAD_TARGET - 1 - prsField - dsiField);
  return lvCat(DSI, w, new Uint8Array(zpadLen), ci, sid);
}

/** Byte length that LEB128(n) occupies, for the zero-pad computation. */
function lvLen(n: number): number {
  let len = 1;
  let v = Math.floor(n / 128);
  while (v > 0) {
    len += 1;
    v = Math.floor(v / 128);
  }
  return len;
}

function calculateGenerator(
  w: Uint8Array,
  binding: CpaceBinding,
  sid: Uint8Array,
): RPoint {
  const gs = generatorString(w, channelId(binding), sid);
  return deriveToCurve(sha512(gs));
}

function randomScalar(): bigint {
  for (;;) {
    const bytes = randomBytes(64);
    let n = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
    const s = n % GROUP_ORDER;
    if (s >= 1n) return s;
  }
}

function deriveIsk(
  sid: Uint8Array,
  k: Uint8Array,
  msgA: Uint8Array,
  adA: Uint8Array,
  msgB: Uint8Array,
  adB: Uint8Array,
): Uint8Array {
  const input = concatBytes(
    lvCat(DSI_ISK, sid, k),
    lvCat(msgA, adA),
    lvCat(msgB, adB),
  );
  return sha512(input);
}

function decodeShare(bytes: Uint8Array, who: string): RPoint {
  if (bytes.length !== POINT_BYTES) {
    throw new CpaceError(`${who} share has wrong length ${bytes.length}`);
  }
  let p: RPoint;
  try {
    p = Point.fromBytes(bytes);
  } catch {
    throw new CpaceError(`${who} share is not a valid ristretto255 point`);
  }
  if (p.is0()) throw new CpaceError(`${who} share is the identity element`);
  return p;
}

function confirmKey(isk: Uint8Array): Uint8Array {
  return expandKey(isk, 'cpace-confirm/v1', 32);
}

function macFor(isk: Uint8Array, tag: 'host' | 'peer', sid: Uint8Array, ya: Uint8Array, yb: Uint8Array): Uint8Array {
  return hmac(sha256, confirmKey(isk), concatBytes(utf8ToBytes(tag), sid, ya, yb));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const EMPTY_AD = new Uint8Array(0);

// --- Peer (initiator) -------------------------------------------------------

export interface PeerHandshake {
  /** MSGa: the peer's public share, sent to the host */
  readonly ya: Uint8Array;
  /**
   * Process the host's reply. Throws CpaceError only on a malformed/identity
   * share. On a wrong password the returned `hostConfirmed` is false: the peer
   * still sends its `macPeer` (so the host is not left hanging and also rejects)
   * and then aborts.
   */
  finish(yb: Uint8Array, macHost: Uint8Array): PeerResult;
}

export interface PeerResult {
  readonly isk: Uint8Array;
  /** MSGb confirmation to send back to the host */
  readonly macPeer: Uint8Array;
  /** whether the host's confirmation MAC verified (i.e. passwords match) */
  readonly hostConfirmed: boolean;
}

export function peerBegin(
  w: Uint8Array,
  binding: CpaceBinding,
  sid: Uint8Array,
): PeerHandshake {
  if (sid.length !== SID_BYTES) throw new CpaceError('sid must be 16 bytes');
  const g = calculateGenerator(w, binding, sid);
  const scalar = randomScalar();
  const yaPoint = g.multiply(scalar);
  const ya = yaPoint.toBytes();

  return {
    ya,
    finish(yb, macHost) {
      const ybPoint = decodeShare(yb, 'host');
      const kPoint = ybPoint.multiply(scalar);
      if (kPoint.is0()) throw new CpaceError('shared secret is the identity element');
      const k = kPoint.toBytes();
      const isk = deriveIsk(sid, k, ya, EMPTY_AD, yb, EMPTY_AD);
      const hostConfirmed = constantTimeEqual(
        macHost,
        macFor(isk, 'host', sid, ya, yb),
      );
      return {
        isk,
        macPeer: macFor(isk, 'peer', sid, ya, yb),
        hostConfirmed,
      };
    },
  };
}

// --- Host (responder) ------------------------------------------------------

export interface HostHandshake {
  /** MSGb: the host's public share, sent to the peer */
  readonly yb: Uint8Array;
  /** host confirmation MAC, sent alongside `yb` */
  readonly macHost: Uint8Array;
  readonly isk: Uint8Array;
  /** Verify the peer's confirmation. Returns false on mismatch; the caller
   *  must drop the connection and count a failed attempt. */
  verifyPeer(macPeer: Uint8Array): boolean;
}

export function newSid(): Uint8Array {
  return randomBytes(SID_BYTES);
}

export function hostRespond(
  w: Uint8Array,
  binding: CpaceBinding,
  sid: Uint8Array,
  ya: Uint8Array,
): HostHandshake {
  if (sid.length !== SID_BYTES) throw new CpaceError('sid must be 16 bytes');
  const g = calculateGenerator(w, binding, sid);
  const yaPoint = decodeShare(ya, 'peer');
  const scalar = randomScalar();
  const yb = g.multiply(scalar).toBytes();
  const kPoint = yaPoint.multiply(scalar);
  if (kPoint.is0()) throw new CpaceError('shared secret is the identity element');
  const k = kPoint.toBytes();
  const isk = deriveIsk(sid, k, ya, EMPTY_AD, yb, EMPTY_AD);
  const macHost = macFor(isk, 'host', sid, ya, yb);
  const expectedPeer = macFor(isk, 'peer', sid, ya, yb);

  return {
    yb,
    macHost,
    isk,
    verifyPeer(macPeer) {
      return constantTimeEqual(macPeer, expectedPeer);
    },
  };
}

// Exposed for the test vector only.
export const _internal = {
  generatorString,
  calculateGenerator,
  deriveIsk,
  channelId,
};
