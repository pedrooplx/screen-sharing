/**
 * Room code: the string a host hands out so peers know WHICH room to join. It
 * carries no secret (docs/DESIGN.md section 5) and its integrity is not
 * security-critical - the CPace handshake stops a forged host from
 * authenticating, and the password (the only secret) never travels.
 *
 * Since signaling moved to the hosted relay (section 2.2), the code no longer
 * carries WHERE the host is: every client dials the same relay URL and asks for
 * `roomId`. So v2 is just the room id + the Argon salt.
 *
 * Binary layout (big-endian):
 *   [0]        version   (u8, = 2)
 *   [1..5)     roomId     (4 bytes)   - the relay's room key
 *   [5..11)    codeSalt   (6 bytes)   - domain-separates the password KDF
 *   [11..13)   crc16      (CRC-16/CCITT-FALSE over bytes [0..11))
 *
 * 13 bytes -> 21 Base32 symbols (Crockford, no I/L/O/U), shown in 3 groups of 7:
 *   K7QM4X2-A9BTR0F-DW6HJE3
 */

import { base32Decode, base32Encode } from './base32.js';

export const ROOM_CODE_VERSION = 2;
export const ROOM_ID_BYTES = 4;
export const CODE_SALT_BYTES = 6;

const BODY_BYTES = 1 + ROOM_ID_BYTES + CODE_SALT_BYTES; // 11
const CODE_BYTES = BODY_BYTES + 2; // + crc16
const GROUP = 7;

export class RoomCodeError extends Error {
  override name = 'RoomCodeError';
}

export interface RoomCodeData {
  readonly version: number;
  readonly roomId: Uint8Array;
  readonly codeSalt: Uint8Array;
}

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no xor-out. */
export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

function assertLen(name: string, value: Uint8Array, expected: number): void {
  if (value.length !== expected) {
    throw new RoomCodeError(`${name} must be ${expected} bytes, got ${value.length}`);
  }
}

export function encodeRoomCode(data: RoomCodeData): string {
  assertLen('roomId', data.roomId, ROOM_ID_BYTES);
  assertLen('codeSalt', data.codeSalt, CODE_SALT_BYTES);

  const body = new Uint8Array(BODY_BYTES);
  body[0] = ROOM_CODE_VERSION;
  body.set(data.roomId, 1);
  body.set(data.codeSalt, 1 + ROOM_ID_BYTES);

  const withCrc = new Uint8Array(CODE_BYTES);
  withCrc.set(body, 0);
  const crc = crc16(body);
  withCrc[BODY_BYTES] = (crc >>> 8) & 0xff;
  withCrc[BODY_BYTES + 1] = crc & 0xff;

  return group(base32Encode(withCrc));
}

export function decodeRoomCode(text: string): RoomCodeData {
  let raw: Uint8Array;
  try {
    raw = base32Decode(text);
  } catch (err) {
    throw new RoomCodeError(`not a valid room code: ${(err as Error).message}`);
  }
  if (raw.length !== CODE_BYTES) {
    throw new RoomCodeError(`room code has unexpected length ${raw.length}`);
  }

  const body = raw.subarray(0, BODY_BYTES);
  const wantCrc = (raw[BODY_BYTES]! << 8) | raw[BODY_BYTES + 1]!;
  if (crc16(body) !== wantCrc) {
    throw new RoomCodeError('checksum mismatch - the code was mistyped');
  }

  const version = body[0]!;
  if (version !== ROOM_CODE_VERSION) {
    throw new RoomCodeError(
      `room code version ${version} not supported by this build`,
    );
  }

  return {
    version,
    roomId: body.slice(1, 1 + ROOM_ID_BYTES),
    codeSalt: body.slice(1 + ROOM_ID_BYTES, BODY_BYTES),
  };
}

/** roomId as the 8-char lowercase hex the relay HELLO expects. */
export function roomIdHex(roomId: Uint8Array): string {
  assertLen('roomId', roomId, ROOM_ID_BYTES);
  return Array.from(roomId, (b) => b.toString(16).padStart(2, '0')).join('');
}

function group(symbols: string): string {
  return (symbols.match(new RegExp(`.{1,${GROUP}}`, 'g')) ?? []).join('-');
}
