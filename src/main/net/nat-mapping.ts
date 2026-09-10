/**
 * Opening an inbound TCP port on the host's router (docs/DESIGN.md section 8.1).
 *
 * Attempt order: NAT-PMP / PCP first (fast, deterministic when present), then
 * UPnP-IGD (SSDP discovery, slower, more common on consumer gear). If both
 * fail, the host must fall back to manual port forwarding - the caller is told
 * exactly which port and internal IP to forward.
 *
 * Uses @achingbrain/nat-port-mapper: actively maintained, pure JS, covers
 * PMP + PCP + UPnP in one API, and handles lease renewal internally
 * (autoRefresh). This replaces the design's original `nat-api` pick, which
 * pulled in the deprecated `request` package and a stack of advisories.
 */

import { gateway4async } from 'default-gateway';
import { pmpNat, upnpNat, type Gateway } from '@achingbrain/nat-port-mapper';
import { primaryLanIpv4 } from './local-ip.js';

export type MappingMethod = 'nat-pmp' | 'upnp' | 'manual';

export interface PortMappingResult {
  readonly method: MappingMethod;
  readonly externalPort: number;
  readonly internalPort: number;
  readonly internalHost: string;
  /** external IP as reported by the gateway, if it gave one */
  readonly gatewayExternalIp: string | null;
}

export class NatMappingError extends Error {
  override name = 'NatMappingError';
}

export interface MapPortOptions {
  readonly port: number;
  readonly description?: string;
  readonly pmpTimeoutMs?: number;
  readonly upnpTimeoutMs?: number;
}

/** Handle for an active mapping; call `close()` on shutdown to release it. */
export interface ActiveMapping {
  readonly result: PortMappingResult;
  close(): Promise<void>;
}

const NOOP_CLOSE = async () => {};

export async function mapInboundPort(
  opts: MapPortOptions,
): Promise<ActiveMapping> {
  const internalHost = primaryLanIpv4();
  if (!internalHost) {
    throw new NatMappingError('no LAN IPv4 address to map to');
  }

  const pmp = await tryPmp(opts, internalHost);
  if (pmp) return pmp;

  const upnp = await tryUpnp(opts, internalHost);
  if (upnp) return upnp;

  return {
    result: {
      method: 'manual',
      externalPort: opts.port,
      internalPort: opts.port,
      internalHost,
      gatewayExternalIp: null,
    },
    close: NOOP_CLOSE,
  };
}

async function tryPmp(
  opts: MapPortOptions,
  internalHost: string,
): Promise<ActiveMapping | null> {
  let gateway: Gateway | undefined;
  try {
    const { gateway: gatewayIp } = await gateway4async();
    gateway = pmpNat(gatewayIp, {
      autoRefresh: true,
      description: opts.description ?? 'erros-share',
    });
    const mapping = await gateway.map(opts.port, internalHost, {
      protocol: 'tcp',
      signal: AbortSignal.timeout(opts.pmpTimeoutMs ?? 3_000),
    });
    const gatewayExternalIp = await gateway
      .externalIp({ signal: AbortSignal.timeout(2_000) })
      .catch(() => null);
    return finalize('nat-pmp', gateway, mapping, internalHost, gatewayExternalIp);
  } catch {
    await gateway?.stop().catch(() => {});
    return null;
  }
}

async function tryUpnp(
  opts: MapPortOptions,
  internalHost: string,
): Promise<ActiveMapping | null> {
  const client = upnpNat({
    autoRefresh: true,
    description: opts.description ?? 'erros-share',
  });
  const deadline = AbortSignal.timeout(opts.upnpTimeoutMs ?? 5_000);
  try {
    for await (const gateway of client.findGateways({ signal: deadline })) {
      try {
        const mapping = await gateway.map(opts.port, internalHost, {
          protocol: 'tcp',
        });
        const gatewayExternalIp = await gateway
          .externalIp({ signal: AbortSignal.timeout(2_000) })
          .catch(() => null);
        return finalize('upnp', gateway, mapping, internalHost, gatewayExternalIp);
      } catch {
        await gateway.stop().catch(() => {});
      }
    }
  } catch {
    /* discovery timed out */
  }
  return null;
}

function finalize(
  method: 'nat-pmp' | 'upnp',
  gateway: Gateway,
  mapping: { externalPort: number; internalPort: number },
  internalHost: string,
  gatewayExternalIp: string | null,
): ActiveMapping {
  return {
    result: {
      method,
      externalPort: mapping.externalPort,
      internalPort: mapping.internalPort,
      internalHost,
      gatewayExternalIp,
    },
    close: async () => {
      await gateway.stop().catch(() => {});
    },
  };
}
