/**
 * Where the signaling relay lives (docs/DESIGN.md section 2.2 / 18).
 *
 * The relay is the one piece of hosted infrastructure: a tiny WebSocket
 * multiplexer that lets a room host and its peers reach each other without
 * anyone opening a port. It only ever forwards opaque bytes - CPace and the
 * AES-256-GCM control frames stay end to end (peer <-> host).
 *
 * Resolution order:
 *   1. ERROS_RELAY_URL in the environment (dev, or a user override)
 *   2. the URL baked into the build at package time (ERROS_RELAY_URL_BAKED)
 *   3. DEFAULT_RELAY_URL below
 */

/** Public relay. Override per deployment; see server/README.md to run your own. */
export const DEFAULT_RELAY_URL = 'wss://erros-share-relay.onrender.com';

export class RelayConfigError extends Error {
  override name = 'RelayConfigError';
}

function sanitize(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new RelayConfigError(`relay URL must be ws:// or wss://, got ${url.protocol}`);
  }
  // ws: is only allowed for loopback (tests, self-host on the same machine)
  if (
    url.protocol === 'ws:' &&
    url.hostname !== 'localhost' &&
    url.hostname !== '127.0.0.1' &&
    url.hostname !== '[::1]'
  ) {
    throw new RelayConfigError('plaintext ws:// is only allowed for localhost');
  }
  return url.toString().replace(/\/$/, '');
}

/**
 * The relay URL this process should use. `override` wins (it is the value a
 * future settings.json would carry); otherwise the environment, then the baked
 * constant, then the default.
 */
export function relayUrl(override?: string): string {
  const candidate =
    override?.trim() ||
    process.env['ERROS_RELAY_URL']?.trim() ||
    process.env['ERROS_RELAY_URL_BAKED']?.trim() ||
    DEFAULT_RELAY_URL;
  return sanitize(candidate);
}
