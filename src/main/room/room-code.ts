/**
 * Room code: the string a host hands out so peers know WHERE the host is and
 * WHICH room to join. Carries no secret (docs/DESIGN.md section 5) - the
 * password is never in here and the code's integrity is not security-critical,
 * because the CPace handshake stops a forged host from authenticating.
 *
 * Binary layout (big-endian):
 *   [0]        version   (u8, = 1)
 *   [1]        flags      bit0: 0 = IPv4, 1 = IPv6
 *   [2..6)     roomId     (4 bytes)
 *   [6..12)    codeSalt   (6 bytes)
 *   [12..14)   port       (u16)
 *   [14..N)    address    (4 bytes IPv4 | 16 bytes IPv6)
 *   [N..N+2)   crc16      (CRC-16/CCITT-FALSE over bytes [0..N))
 *
 * IPv4 -> 20 bytes -> exactly 32 Base32 symbols, shown in groups of 4:
 *   K7QM-4X2A-9BTR-0FDW-6HJE-3NCV-8PGY-1SZK
 */

import { base32Decode, base32Encode } from './base32.js';
import {
  bytesToIpv4,
  bytesToIpv6,
  ipv4ToBytes,
  ipv6ToBytes,
} from './ip.js';

export const ROOM_CODE_VERSION = 1;
export const ROOM_ID_BYTES = 4;
export const CODE_SALT_BYTES = 6;

const FLAG_IPV6 = 0x01;

export class RoomCodeError extends Error {
  override name = 'RoomCodeError';
}

export interface HostEndpoint {
  readonly family: 'ipv4' | 'ipv6';
  readonly address: string;
  readonly port: number;
}

export interface RoomCodeData {
  readonly version: number;
  readonly roomId: Uint8Array;
  readonly codeSalt: Uint8Array;
  readonly host: HostEndpoint;
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
  const { port, family, address } = data.host;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RoomCodeError(`port out of range: ${port}`);
  }

  const addrBytes =
    family === 'ipv6' ? ipv6ToBytes(address) : ipv4ToBytes(address);
  const body = new Uint8Array(14 + addrBytes.length);
  body[0] = ROOM_CODE_VERSION;
  body[1] = family === 'ipv6' ? FLAG_IPV6 : 0;
  body.set(data.roomId, 2);
  body.set(data.codeSalt, 6);
  body[12] = (port >>> 8) & 0xff;
  body[13] = port & 0xff;
  body.set(addrBytes, 14);

  const withCrc = new Uint8Array(body.length + 2);
  withCrc.set(body, 0);
  const crc = crc16(body);
  withCrc[body.length] = (crc >>> 8) & 0xff;
  withCrc[body.length + 1] = crc & 0xff;

  return group(base32Encode(withCrc));
}

export function decodeRoomCode(text: string): RoomCodeData {
  let raw: Uint8Array;
  try {
    raw = base32Decode(text);
  } catch (err) {
    throw new RoomCodeError(
      `not a valid room code: ${(err as Error).message}`,
    );
  }
  if (raw.length !== 20 && raw.length !== 32) {
    throw new RoomCodeError(`room code has unexpected length ${raw.length}`);
  }

  const body = raw.subarray(0, raw.length - 2);
  const wantCrc = (raw[raw.length - 2]! << 8) | raw[raw.length - 1]!;
  if (crc16(body) !== wantCrc) {
    throw new RoomCodeError('checksum mismatch - the code was mistyped');
  }

  const version = body[0]!;
  if (version !== ROOM_CODE_VERSION) {
    throw new RoomCodeError(
      `room code version ${version} not supported by this build`,
    );
  }
  const isV6 = (body[1]! & FLAG_IPV6) !== 0;
  const expectedLen = isV6 ? 32 : 20;
  if (raw.length !== expectedLen) {
    throw new RoomCodeError('room code family flag disagrees with its length');
  }

  const roomId = body.slice(2, 6);
  const codeSalt = body.slice(6, 12);
  const port = (body[12]! << 8) | body[13]!;
  if (port < 1) throw new RoomCodeError('room code carries port 0');
  const addrBytes = body.slice(14);
  const address = isV6 ? bytesToIpv6(addrBytes) : bytesToIpv4(addrBytes);

  return {
    version,
    roomId,
    codeSalt,
    host: { family: isV6 ? 'ipv6' : 'ipv4', address, port },
  };
}

function group(symbols: string): string {
  return (symbols.match(/.{1,4}/g) ?? []).join('-');
}
