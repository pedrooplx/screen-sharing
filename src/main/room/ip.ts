/**
 * IPv4 / IPv6 <-> bytes. Node has no built-in address-to-bytes, and we need a
 * fixed-width binary form for the room code.
 */

export class IpError extends Error {
  override name = 'IpError';
}

export function ipv4ToBytes(address: string): Uint8Array {
  const parts = address.trim().split('.');
  if (parts.length !== 4) throw new IpError(`not an IPv4 address: ${address}`);
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i]!;
    if (!/^\d{1,3}$/.test(p)) throw new IpError(`bad IPv4 octet: ${p}`);
    const n = Number(p);
    if (n > 255) throw new IpError(`IPv4 octet out of range: ${p}`);
    out[i] = n;
  }
  return out;
}

export function bytesToIpv4(bytes: Uint8Array): string {
  if (bytes.length !== 4) throw new IpError('IPv4 needs 4 bytes');
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

/** Expand one colon-separated run into 16-bit groups, resolving a trailing
 *  dotted-quad (e.g. "::ffff:1.2.3.4") into two groups. */
function parseGroups(run: string): number[] {
  if (run === '') return [];
  const parts = run.split(':');
  const groups: number[] = [];
  parts.forEach((part, i) => {
    if (part.includes('.')) {
      if (i !== parts.length - 1) throw new IpError(`misplaced IPv4 tail: ${run}`);
      const v4 = ipv4ToBytes(part);
      groups.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      return;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) throw new IpError(`bad IPv6 group: ${part}`);
    groups.push(parseInt(part, 16));
  });
  return groups;
}

export function ipv6ToBytes(address: string): Uint8Array {
  let text = address.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const pct = text.indexOf('%');
  if (pct !== -1) text = text.slice(0, pct);

  if (text.indexOf('::') !== text.lastIndexOf('::')) {
    throw new IpError(`IPv6 has more than one "::": ${address}`);
  }

  let groups: number[];
  const dc = text.indexOf('::');
  if (dc === -1) {
    groups = parseGroups(text);
    if (groups.length !== 8) throw new IpError(`IPv6 needs 8 groups: ${address}`);
  } else {
    const left = parseGroups(text.slice(0, dc));
    const right = parseGroups(text.slice(dc + 2));
    const missing = 8 - left.length - right.length;
    if (missing < 1) throw new IpError(`IPv6 "::" covers no zero group: ${address}`);
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  }

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = (groups[i]! >>> 8) & 0xff;
    out[i * 2 + 1] = groups[i]! & 0xff;
  }
  return out;
}

export function bytesToIpv6(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new IpError('IPv6 needs 16 bytes');
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) groups.push((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!);

  // longest run of >= 2 zero groups gets compressed to "::"
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}
