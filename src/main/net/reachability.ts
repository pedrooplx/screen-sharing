/**
 * "Can the host open a fresh connection back to this peer?" (docs/DESIGN.md
 * section 8.2). The answer feeds `inboundVerified`, the primary key of the
 * host-succession order - we never pick a successor that cannot accept inbound.
 *
 * Phase 1 does a plain TCP connect probe. A future revision will follow the
 * connect with a short authenticated exchange so the host also proves the
 * listener belongs to that peer; see "Limitações conhecidas" in the README.
 */

import { createConnection } from 'node:net';

export interface ReachabilityResult {
  readonly reachable: boolean;
  readonly rttMs: number | null;
  readonly detail: string;
}

export async function tcpReachable(
  host: string,
  port: number,
  timeoutMs = 4_000,
): Promise<ReachabilityResult> {
  if (port < 1 || port > 65535) {
    return { reachable: false, rttMs: null, detail: 'invalid port' };
  }
  const start = performance.now();
  return new Promise<ReachabilityResult>((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (result: ReachabilityResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () =>
      finish({
        reachable: true,
        rttMs: Math.round(performance.now() - start),
        detail: 'connected',
      }),
    );
    socket.once('timeout', () =>
      finish({ reachable: false, rttMs: null, detail: 'timed out' }),
    );
    socket.once('error', (err) =>
      finish({ reachable: false, rttMs: null, detail: err.message }),
    );
  });
}
