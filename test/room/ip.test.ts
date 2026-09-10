import { describe, expect, it } from 'vitest';
import {
  IpError,
  bytesToIpv4,
  bytesToIpv6,
  ipv4ToBytes,
  ipv6ToBytes,
} from '../../src/main/room/ip.js';

describe('ipv4', () => {
  it('round-trips', () => {
    for (const a of ['0.0.0.0', '192.168.1.1', '255.255.255.255', '203.0.113.9']) {
      expect(bytesToIpv4(ipv4ToBytes(a))).toBe(a);
    }
  });
  it('rejects out-of-range octets and bad shapes', () => {
    expect(() => ipv4ToBytes('256.0.0.1')).toThrow(IpError);
    expect(() => ipv4ToBytes('1.2.3')).toThrow(IpError);
    expect(() => ipv4ToBytes('1.2.3.4.5')).toThrow(IpError);
  });
});

describe('ipv6', () => {
  it('round-trips canonical forms', () => {
    for (const a of [
      '::',
      '::1',
      '2001:db8::1',
      'fe80::1234:5678:9abc:def0',
      '2001:db8:0:0:0:0:2:1',
    ]) {
      const bytes = ipv6ToBytes(a);
      expect(bytes.length).toBe(16);
      // re-parsing the formatted output yields the same bytes
      expect([...ipv6ToBytes(bytesToIpv6(bytes))]).toEqual([...bytes]);
    }
  });

  it('parses full and compressed forms to the same bytes', () => {
    expect([...ipv6ToBytes('2001:0db8:0000:0000:0000:0000:0000:0001')]).toEqual(
      [...ipv6ToBytes('2001:db8::1')],
    );
  });

  it('handles an embedded IPv4 tail', () => {
    expect([...ipv6ToBytes('::ffff:192.168.0.1')]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 192, 168, 0, 1,
    ]);
  });

  it('compresses the longest zero run when formatting', () => {
    expect(bytesToIpv6(ipv6ToBytes('1:0:0:0:2:0:0:3'))).toBe('1::2:0:0:3');
  });

  it('rejects two "::" and malformed groups', () => {
    expect(() => ipv6ToBytes('1::2::3')).toThrow(IpError);
    expect(() => ipv6ToBytes('12345::1')).toThrow(IpError);
    expect(() => ipv6ToBytes('1:2:3:4:5:6:7')).toThrow(IpError);
  });
});
