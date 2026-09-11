import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { base32Encode } from '../../src/main/room/base32.js';
import {
  RoomCodeError,
  crc16,
  decodeRoomCode,
  encodeRoomCode,
  roomIdHex,
  type RoomCodeData,
} from '../../src/main/room/room-code.js';

function sample(overrides: Partial<RoomCodeData> = {}): RoomCodeData {
  return {
    version: 2,
    roomId: new Uint8Array(randomBytes(4)),
    codeSalt: new Uint8Array(randomBytes(6)),
    ...overrides,
  };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('room code', () => {
  it('round-trips roomId + codeSalt', () => {
    const data = sample();
    const code = encodeRoomCode(data);
    const back = decodeRoomCode(code);
    expect(hex(back.roomId)).toBe(hex(data.roomId));
    expect(hex(back.codeSalt)).toBe(hex(data.codeSalt));
    expect(back.version).toBe(2);
  });

  it('renders as 21 symbols in 3 groups of seven', () => {
    const code = encodeRoomCode(sample());
    expect(code).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{7}-[0-9A-HJKMNP-TV-Z]{7}-[0-9A-HJKMNP-TV-Z]{7}$/,
    );
  });

  it('is tolerant of user typing (case, spaces, O/I/L confusables)', () => {
    const data = sample({ roomId: new Uint8Array([0x10, 0, 0, 0]) });
    const code = encodeRoomCode(data);
    const mangled = code
      .toLowerCase()
      .replace(/-/g, ' ')
      .replace(/0/g, 'O')
      .replace(/1/g, 'l');
    expect(hex(decodeRoomCode(mangled).roomId)).toBe(hex(data.roomId));
  });

  it('detects a single mistyped character via CRC', () => {
    const code = encodeRoomCode(sample()).replace(/-/g, '');
    const idx = 5;
    const wrong = code[idx] === 'A' ? 'B' : 'A';
    const broken = code.slice(0, idx) + wrong + code.slice(idx + 1);
    expect(() => decodeRoomCode(broken)).toThrow(/checksum|mistyped/i);
  });

  it('rejects an unknown version byte', () => {
    // hand-build an 11-byte body with version 3 and a valid CRC
    const body = new Uint8Array(11);
    body[0] = 3;
    const c = crc16(body);
    const raw = new Uint8Array(13);
    raw.set(body);
    raw[11] = (c >>> 8) & 0xff;
    raw[12] = c & 0xff;
    expect(() => decodeRoomCode(base32Encode(raw))).toThrow(RoomCodeError);
  });

  it('rejects a v1 (pre-relay, IP-carrying) code as an unsupported version', () => {
    // v1 bodies were 18 or 30 bytes (+2 crc); either way the length alone
    // already disagrees with v2's fixed 13 bytes.
    const body = new Uint8Array(18);
    body[0] = 1;
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

  it('rejects a roomId or codeSalt of the wrong length', () => {
    expect(() => encodeRoomCode(sample({ roomId: new Uint8Array(3) }))).toThrow(
      RoomCodeError,
    );
    expect(() => encodeRoomCode(sample({ codeSalt: new Uint8Array(5) }))).toThrow(
      RoomCodeError,
    );
  });
});

describe('roomIdHex', () => {
  it('renders the 4-byte roomId as 8 lowercase hex chars', () => {
    expect(roomIdHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('deadbeef');
  });

  it('rejects the wrong length', () => {
    expect(() => roomIdHex(new Uint8Array(3))).toThrow(RoomCodeError);
  });
});

describe('crc16 (CCITT-FALSE)', () => {
  it('matches the known vector for "123456789"', () => {
    expect(crc16(Buffer.from('123456789'))).toBe(0x29b1);
  });
});
