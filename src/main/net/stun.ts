/**
 * Minimal STUN client - just enough to discover our external IP:port
 * (RFC 5389 / RFC 8489, Binding Request -> XOR-MAPPED-ADDRESS).
 *
 * We hand-roll this instead of pulling a STUN library: we need exactly one
 * request type, the wire format is tiny and frozen, and the popular npm STUN
 * packages drag in a large, poorly-maintained dependency tree (parse-url,
 * query-string, meow, ...). No media ever touches STUN - it is one UDP
 * round-trip to learn our public mapping.
 */

import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';

export const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ATTR_MAPPED_ADDRESS = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

export class StunError extends Error {
  override name = 'StunError';
}

export interface StunServer {
  readonly host: string;
  readonly port: number;
}

export const DEFAULT_STUN_SERVERS: readonly StunServer[] = [
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun1.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
];

export interface MappedAddress {
  readonly family: 'ipv4' | 'ipv6';
  readonly address: string;
  readonly port: number;
}

export function encodeBindingRequest(transactionId: Uint8Array): Buffer {
  if (transactionId.length !== 12) {
    throw new StunError('transaction id must be 12 bytes');
  }
  const msg = Buffer.alloc(20);
  msg.writeUInt16BE(BINDING_REQUEST, 0);
  msg.writeUInt16BE(0, 2); // no attributes
  msg.writeUInt32BE(MAGIC_COOKIE, 4);
  Buffer.from(transactionId).copy(msg, 8);
  return msg;
}

export function decodeMappedAddress(
  response: Buffer,
  transactionId: Uint8Array,
): MappedAddress {
  if (response.length < 20) throw new StunError('response shorter than header');
  const type = response.readUInt16BE(0);
  if (type !== BINDING_SUCCESS) {
    throw new StunError(`unexpected STUN message type 0x${type.toString(16)}`);
  }
  if (response.readUInt32BE(4) !== MAGIC_COOKIE) {
    throw new StunError('bad magic cookie');
  }
  if (!response.subarray(8, 20).equals(Buffer.from(transactionId))) {
    throw new StunError('transaction id mismatch');
  }

  const declaredLen = response.readUInt16BE(2);
  const end = Math.min(20 + declaredLen, response.length);
  let offset = 20;
  let mapped: MappedAddress | undefined;

  while (offset + 4 <= end) {
    const attrType = response.readUInt16BE(offset);
    const attrLen = response.readUInt16BE(offset + 2);
    const valueStart = offset + 4;
    const valueEnd = valueStart + attrLen;
    if (valueEnd > response.length) break;
    const value = response.subarray(valueStart, valueEnd);

    if (attrType === ATTR_XOR_MAPPED_ADDRESS) {
      return parseAddress(value, transactionId, true);
    }
    if (attrType === ATTR_MAPPED_ADDRESS && !mapped) {
      mapped = parseAddress(value, transactionId, false);
    }
    offset = valueEnd + ((4 - (attrLen % 4)) % 4); // 32-bit alignment
  }

  if (mapped) return mapped;
  throw new StunError('response carried no mapped address');
}

function parseAddress(
  value: Buffer,
  transactionId: Uint8Array,
  xored: boolean,
): MappedAddress {
  const family = value.readUInt8(1);
  let port = value.readUInt16BE(2);
  const addrBytes = Buffer.from(value.subarray(4));

  if (xored) {
    port ^= (MAGIC_COOKIE >>> 16) & 0xffff;
    const mask = Buffer.alloc(addrBytes.length);
    mask.writeUInt32BE(MAGIC_COOKIE, 0);
    if (addrBytes.length === 16) Buffer.from(transactionId).copy(mask, 4);
    for (let i = 0; i < addrBytes.length; i++) {
      addrBytes[i] = (addrBytes[i] ?? 0) ^ (mask[i] ?? 0);
    }
  }

  if (family === 0x01 && addrBytes.length === 4) {
    return {
      family: 'ipv4',
      address: `${addrBytes[0]}.${addrBytes[1]}.${addrBytes[2]}.${addrBytes[3]}`,
      port,
    };
  }
  if (family === 0x02 && addrBytes.length === 16) {
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      groups.push(addrBytes.readUInt16BE(i).toString(16));
    }
    return { family: 'ipv6', address: groups.join(':'), port };
  }
  throw new StunError(`unrecognised address family 0x${family.toString(16)}`);
}

export interface StunQueryOptions {
  readonly timeoutMs?: number;
  readonly retries?: number;
  /** bind the probe socket to this local port (to learn its own mapping) */
  readonly localPort?: number;
}

/** One Binding Request against one server, with RFC-style retransmission. */
export function stunQuery(
  server: StunServer,
  opts: StunQueryOptions = {},
): Promise<MappedAddress> {
  const timeoutMs = opts.timeoutMs ?? 500;
  const retries = opts.retries ?? 3;
  const transactionId = new Uint8Array(randomBytes(12));
  const request = encodeBindingRequest(transactionId);

  return new Promise<MappedAddress>((resolve, reject) => {
    const socket = createSocket('udp4');
    let attempts = 0;
    let retransmit: NodeJS.Timeout | undefined;
    let overall: NodeJS.Timeout | undefined;

    const done = (err: Error | null, value?: MappedAddress) => {
      if (retransmit) clearTimeout(retransmit);
      if (overall) clearTimeout(overall);
      socket.removeAllListeners();
      socket.close();
      if (err) reject(err);
      else resolve(value!);
    };

    socket.on('message', (msg) => {
      try {
        done(null, decodeMappedAddress(msg, transactionId));
      } catch (err) {
        done(err as Error);
      }
    });
    socket.on('error', (err) => done(err));

    const send = () => {
      attempts++;
      socket.send(request, server.port, server.host, (err) => {
        if (err) done(err);
      });
      if (attempts <= retries) {
        retransmit = setTimeout(send, timeoutMs * attempts);
      }
    };

    overall = setTimeout(
      () => done(new StunError(`no response from ${server.host}`)),
      timeoutMs * (retries + 2),
    );

    if (opts.localPort !== undefined) {
      socket.bind(opts.localPort, () => send());
    } else {
      send();
    }
  });
}

/** Try each server in order until one answers. */
export async function discoverExternalAddress(
  servers: readonly StunServer[] = DEFAULT_STUN_SERVERS,
  opts: StunQueryOptions = {},
): Promise<MappedAddress> {
  let lastError: Error = new StunError('no STUN servers configured');
  for (const server of servers) {
    try {
      return await stunQuery(server, opts);
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError;
}

/**
 * The same public STUN servers, shaped for a WebRTC `RTCPeerConnection`'s
 * `iceServers` (docs/DESIGN.md section 8.3 / 18.6) - this is what lets the
 * host's SFU (and any peer) discover its `srflx` candidate with one outbound
 * UDP packet, so media hole-punches without anyone opening an inbound port.
 * Untyped as `{ urls: string }[]` (not werift's `RTCIceServer`) so this module
 * stays dependency-free; callers that need the werift type get a structurally
 * compatible value.
 */
export function defaultIceServers(): { urls: string }[] {
  return DEFAULT_STUN_SERVERS.map((s) => ({ urls: `stun:${s.host}:${s.port}` }));
}

/** RFC 6598 CGNAT range (100.64.0.0/10) - a host here cannot accept inbound. */
export function isCarrierGradeNat(ipv4: string): boolean {
  const parts = ipv4.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}
