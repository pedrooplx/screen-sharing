/**
 * Authenticated framing for the control plane (docs/DESIGN.md section 6.3).
 *
 * One WebSocket message == one frame. Layout:
 *
 *   [0]      version   (u8, = 1)
 *   [1]      direction (u8, 1 = client-to-server, 2 = server-to-client)
 *   [2..10)  counter   (u64 big-endian, per-direction, strictly increasing)
 *   [10..]   AES-256-GCM(ciphertext ‖ tag)
 *
 *   nonce = nonceSalt(4) ‖ counter(8)
 *   aad   = the 10 header bytes
 *
 * The session keys come from the CPace ISK and are unique per connection, so
 * the (key, direction) pair plus a monotonic counter guarantees nonce
 * uniqueness. Any counter that does not advance is a replay or reorder and is
 * rejected fatally (the transport is TCP-ordered, so gaps are never legitimate).
 */

import { open, seal } from '../crypto/aead.js';

export const FRAME_VERSION = 1;
export const HEADER_BYTES = 10;
export const MAX_PLAINTEXT_BYTES = 256 * 1024;

export enum Direction {
  ClientToServer = 1,
  ServerToClient = 2,
}

export class FrameError extends Error {
  override name = 'FrameError';
}
export class ReplayError extends FrameError {
  override name = 'ReplayError';
}

const MAX_U64 = (1n << 64n) - 1n;

function header(direction: Direction, counter: bigint): Uint8Array {
  const h = Buffer.alloc(HEADER_BYTES);
  h.writeUInt8(FRAME_VERSION, 0);
  h.writeUInt8(direction, 1);
  h.writeBigUInt64BE(counter, 2);
  return h;
}

function nonce(nonceSalt: Uint8Array, counterBytes: Uint8Array): Uint8Array {
  const n = new Uint8Array(12);
  n.set(nonceSalt.subarray(0, 4), 0);
  n.set(counterBytes.subarray(0, 8), 4);
  return n;
}

export class FrameEncoder {
  #key: Uint8Array;
  #salt: Uint8Array;
  #direction: Direction;
  #counter = 0n;

  constructor(key: Uint8Array, nonceSalt: Uint8Array, direction: Direction) {
    if (nonceSalt.length < 4) throw new FrameError('nonce salt must be >= 4 bytes');
    this.#key = key;
    this.#salt = nonceSalt;
    this.#direction = direction;
  }

  encode(plaintext: Uint8Array): Uint8Array {
    if (plaintext.length > MAX_PLAINTEXT_BYTES) {
      throw new FrameError(`plaintext ${plaintext.length} exceeds frame limit`);
    }
    if (this.#counter > MAX_U64) throw new FrameError('frame counter exhausted');
    const counter = this.#counter++;
    const h = header(this.#direction, counter);
    const sealed = seal(this.#key, nonce(this.#salt, h.subarray(2)), plaintext, h);
    return Buffer.concat([h, sealed]);
  }
}

export class FrameDecoder {
  #key: Uint8Array;
  #salt: Uint8Array;
  #expectedDirection: Direction;
  #lastCounter = -1n;

  constructor(key: Uint8Array, nonceSalt: Uint8Array, expectedDirection: Direction) {
    if (nonceSalt.length < 4) throw new FrameError('nonce salt must be >= 4 bytes');
    this.#key = key;
    this.#salt = nonceSalt;
    this.#expectedDirection = expectedDirection;
  }

  decode(frame: Uint8Array): Uint8Array {
    if (frame.length < HEADER_BYTES + 16) {
      throw new FrameError('frame shorter than header + tag');
    }
    const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    if (buf.readUInt8(0) !== FRAME_VERSION) {
      throw new FrameError('unknown frame version');
    }
    if (buf.readUInt8(1) !== this.#expectedDirection) {
      throw new FrameError('unexpected frame direction');
    }
    const counter = buf.readBigUInt64BE(2);
    if (counter <= this.#lastCounter) {
      throw new ReplayError(`frame counter ${counter} did not advance`);
    }
    const h = buf.subarray(0, HEADER_BYTES);
    const plaintext = open(
      this.#key,
      nonce(this.#salt, buf.subarray(2, HEADER_BYTES)),
      buf.subarray(HEADER_BYTES),
      h,
    );
    if (plaintext.length > MAX_PLAINTEXT_BYTES) {
      throw new FrameError('decoded plaintext exceeds frame limit');
    }
    this.#lastCounter = counter;
    return plaintext;
  }
}
