import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  MAGIC_COOKIE,
  StunError,
  decodeMappedAddress,
  encodeBindingRequest,
  isCarrierGradeNat,
} from '../../src/main/net/stun.js';

const tid = new Uint8Array(randomBytes(12));

function buildResponse(opts: {
  ip: number[];
  port: number;
  xored: boolean;
  tid?: Uint8Array;
  type?: number;
}): Buffer {
  const t = opts.tid ?? tid;
  const attrType = opts.xored ? 0x0020 : 0x0001;
  const attrValue = Buffer.alloc(8);
  attrValue.writeUInt8(0, 0);
  attrValue.writeUInt8(0x01, 1); // IPv4
  let port = opts.port;
  const ip = [...opts.ip];
  if (opts.xored) {
    port ^= (MAGIC_COOKIE >>> 16) & 0xffff;
    const mask = [0x21, 0x12, 0xa4, 0x42];
    for (let i = 0; i < 4; i++) ip[i]! ^= mask[i]!;
  }
  attrValue.writeUInt16BE(port, 2);
  Buffer.from(ip).copy(attrValue, 4);

  const msg = Buffer.alloc(20 + 4 + attrValue.length);
  msg.writeUInt16BE(opts.type ?? 0x0101, 0);
  msg.writeUInt16BE(4 + attrValue.length, 2);
  msg.writeUInt32BE(MAGIC_COOKIE, 4);
  Buffer.from(t).copy(msg, 8);
  msg.writeUInt16BE(attrType, 20);
  msg.writeUInt16BE(attrValue.length, 22);
  attrValue.copy(msg, 24);
  return msg;
}

describe('STUN binding request', () => {
  it('encodes a 20-byte header with the magic cookie', () => {
    const req = encodeBindingRequest(tid);
    expect(req.length).toBe(20);
    expect(req.readUInt16BE(0)).toBe(0x0001);
    expect(req.readUInt32BE(4)).toBe(MAGIC_COOKIE);
    expect(req.subarray(8, 20).equals(Buffer.from(tid))).toBe(true);
  });
  it('rejects a wrong-size transaction id', () => {
    expect(() => encodeBindingRequest(new Uint8Array(8))).toThrow(StunError);
  });
});

describe('STUN mapped-address decoding', () => {
  it('decodes XOR-MAPPED-ADDRESS (IPv4)', () => {
    const res = buildResponse({ ip: [203, 0, 113, 9], port: 51234, xored: true });
    expect(decodeMappedAddress(res, tid)).toEqual({
      family: 'ipv4',
      address: '203.0.113.9',
      port: 51234,
    });
  });
  it('falls back to legacy MAPPED-ADDRESS', () => {
    const res = buildResponse({ ip: [198, 51, 100, 7], port: 3478, xored: false });
    expect(decodeMappedAddress(res, tid).address).toBe('198.51.100.7');
  });
  it('rejects a transaction-id mismatch', () => {
    const res = buildResponse({ ip: [1, 2, 3, 4], port: 1, xored: true });
    expect(() => decodeMappedAddress(res, new Uint8Array(12))).toThrow(/transaction/i);
  });
  it('rejects a non-success message type', () => {
    const res = buildResponse({ ip: [1, 2, 3, 4], port: 1, xored: true, type: 0x0111 });
    expect(() => decodeMappedAddress(res, tid)).toThrow(StunError);
  });
});

describe('isCarrierGradeNat', () => {
  it('flags 100.64.0.0/10', () => {
    expect(isCarrierGradeNat('100.64.0.1')).toBe(true);
    expect(isCarrierGradeNat('100.127.255.255')).toBe(true);
  });
  it('passes normal public and private addresses', () => {
    expect(isCarrierGradeNat('100.128.0.1')).toBe(false);
    expect(isCarrierGradeNat('203.0.113.9')).toBe(false);
    expect(isCarrierGradeNat('192.168.1.1')).toBe(false);
  });
});
