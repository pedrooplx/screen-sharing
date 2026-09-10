/**
 * Best-effort primary LAN IPv4 of this machine. Used as the internal host when
 * asking the router for a port mapping, and to notice "no NAT at all" (STUN
 * address == local address).
 */

import { networkInterfaces } from 'node:os';

const PRIVATE_V4 =
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function primaryLanIpv4(): string | null {
  const ifaces = networkInterfaces();
  const candidates: string[] = [];
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      candidates.push(addr.address);
    }
  }
  // prefer a routable-looking private address over link-local
  const preferred = candidates.find(
    (ip) => PRIVATE_V4.test(ip) && !ip.startsWith('169.254.'),
  );
  return preferred ?? candidates[0] ?? null;
}

export function allLanIpv4(): string[] {
  const ifaces = networkInterfaces();
  const out: string[] = [];
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}
