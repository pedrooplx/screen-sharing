/**
 * Boots the real relay (server/src/index.ts) on 127.0.0.1:0 for integration
 * tests, instead of re-implementing its wire handling with fakes (that's what
 * test/relay/relay.test.ts does, against `Relay` directly). Using the actual
 * HTTP+WS server here is what proves `RelayHostLink`/`RelayPeerLink` interop
 * with it end to end.
 */

import type { RelayLimits } from '../../server/src/relay.js';
import { createRelayHttpServer } from '../../server/src/index.js';

export interface TestRelay {
  readonly url: string;
  close(): Promise<void>;
}

export async function startTestRelay(limits?: RelayLimits): Promise<TestRelay> {
  const server = await createRelayHttpServer({ port: 0, ...(limits ? { limits } : {}) });
  return {
    url: `ws://127.0.0.1:${server.port}`,
    close: () => server.close(),
  };
}
