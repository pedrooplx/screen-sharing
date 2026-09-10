import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { base32Encode } from '../../src/main/room/base32.js';
import {
  RoomCodeError,
  crc16,
  decodeRoomCode,
  encodeRoomCode,
  type RoomCodeData,
} from '../../src/main/room/room-code.js';

function sample(overrides: Partial<RoomCodeData> = {}): RoomCodeData {
  return {
    version: 1,
    roomId: new Uint8Array(randomBytes(4)),
    codeSalt: new Uint8Array(randomBytes(6)),
    host: { family: 'ipv4', address: '203.0.113.9', port: 47821 },
    ...overrides,
  };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('room code', () => {
  it('round-trips an IPv4 code', () => {
    const data = sample();
    const code = encodeRoomCode(data);
    const back = decodeRoomCode(code);
    expect(hex(back.roomId)).toBe(hex(data.roomId));
    expect(hex(back.codeSalt)).toBe(hex(data.codeSalt));
    expect(back.host).toEqual(data.host);
  });

  it('renders IPv4 as 32 symbols in groups of four', () => {
    const code = encodeRoomCode(sample());
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it('round-trips an IPv6 code', () => {
    const data = sample({
      host: { family: 'ipv6', address: '2001:db8::1', port: 9000 },
    });
    expect(decodeRoomCode(encodeRoomCode(data)).host).toEqual(data.host);
  });

  it('is tolerant of user typing (case, spaces, O/I/L confusables)', () => {
    const code = encodeRoomCode(sample());
    const mangled = code
      .toLowerCase()
      .replace(/-/g, ' ')
      .replace(/0/g, 'O')
      .replace(/1/g, 'l');
    expect(decodeRoomCode(mangled).host.port).toBe(47821);
  });

  it('detects a single mistyped character via CRC', () => {
    const code = encodeRoomCode(sample()).replace(/-/g, '');
    const idx = 5;
    const wrong = code[idx] === 'A' ? 'B' : 'A';
    const broken = code.slice(0, idx) + wrong + code.slice(idx + 1);
    expect(() => decodeRoomCode(broken)).toThrow(/checksum|mistyped/i);
  });

  it('rejects an unknown version byte', () => {
    // hand-build a 20-byte body with version 2 and a valid CRC
    const body = new Uint8Array(18);
    body[0] = 2;
    const c = crc16(body);
    const raw = new Uint8Array(20);
    raw.set(body);
    raw[18] = (c >>> 8) & 0xff;
    raw[19] = c & 0xff;
    expect(() => decodeRoomCode(base32Encode(raw))).toThrow(RoomCodeError);
  });

  it('rejects garbage', () => {
    expect(() => decodeRoomCode('not a real code!!!')).toThrow(RoomCodeError);
    expect(() => decodeRoomCode('AAAA-AAAA')).toThrow(RoomCodeError);
  });

  it('rejects an invalid port', () => {
    expect(() =>
      encodeRoomCode(sample({ host: { family: 'ipv4', address: '1.2.3.4', port: 0 } })),
    ).toThrow(RoomCodeError);
  });
});

describe('crc16 (CCITT-FALSE)', () => {
  it('matches the known vector for "123456789"', () => {
    expect(crc16(Buffer.from('123456789'))).toBe(0x29b1);
  });
});
