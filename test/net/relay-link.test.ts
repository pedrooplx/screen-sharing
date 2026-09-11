import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RelayHostLink,
  RelayLinkError,
  RelayPeerLink,
  isRetriableRelayError,
  openWithRetry,
} from '../../src/main/net/relay-link.js';
import type { Transport } from '../../src/main/net/transport.js';
import { startTestRelay, type TestRelay } from '../helpers/relay.js';

const settle = () => new Promise((r) => setTimeout(r, 60));
async function waitFor(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let relay: TestRelay;
let closers: Array<() => void> = [];

afterEach(async () => {
  for (const close of closers) close();
  closers = [];
  await relay?.close();
});

async function freshRelay(): Promise<TestRelay> {
  relay = await startTestRelay();
  return relay;
}

describe('RelayHostLink + RelayPeerLink (against a real relay)', () => {
  it('delivers data both ways through the virtual transport', async () => {
    const r = await freshRelay();
    const host = await RelayHostLink.open(r.url, 'deadbeef', 'test');
    closers.push(() => void host.close());
    const gotTransport = new Promise<Transport>((resolve) =>
      host.onConnection((t) => resolve(t)),
    );
    const peer = await RelayPeerLink.open(r.url, 'deadbeef', 'test');
    closers.push(() => peer.close(1000, ''));

    const vt = await gotTransport;
    const hostGot = new Promise<string>((resolve) =>
      vt.onMessage((data) => resolve(data.toString())),
    );
    peer.send('hello host', false);
    expect(await hostGot).toBe('hello host');

    const peerGot = new Promise<string>((resolve) =>
      peer.onMessage((data) => resolve(data.toString())),
    );
    vt.send('hello peer', false);
    expect(await peerGot).toBe('hello peer');
  });

  it('gives each peer its own transport and keeps messages isolated', async () => {
    const r = await freshRelay();
    const host = await RelayHostLink.open(r.url, 'deadbeef', 'test');
    closers.push(() => void host.close());
    const transports: Transport[] = [];
    host.onConnection((t) => transports.push(t));

    const p1 = await RelayPeerLink.open(r.url, 'deadbeef', 'test');
    closers.push(() => p1.close(1000, ''));
    const p2 = await RelayPeerLink.open(r.url, 'deadbeef', 'test');
    closers.push(() => p2.close(1000, ''));
    await waitFor(() => transports.length === 2);

    const seenByFirst: string[] = [];
    const seenBySecond: string[] = [];
    transports[0]!.onMessage((d) => seenByFirst.push(d.toString()));
    transports[1]!.onMessage((d) => seenBySecond.push(d.toString()));
    p1.send('from p1', false);
    p2.send('from p2', false);
    await settle();

    expect(seenByFirst).toEqual(['from p1']);
    expect(seenBySecond).toEqual(['from p2']);
  });

  it('fires onClose on the host-side transport when the peer disconnects', async () => {
    const r = await freshRelay();
    const host = await RelayHostLink.open(r.url, 'deadbeef', 'test');
    closers.push(() => void host.close());
    const gotTransport = new Promise<Transport>((resolve) =>
      host.onConnection((t) => resolve(t)),
    );
    const peer = await RelayPeerLink.open(r.url, 'deadbeef', 'test');
    const vt = await gotTransport;

    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      vt.onClose((code, reason) => resolve({ code, reason })),
    );
    peer.close(1000, 'bye');
    await expect(closed).resolves.toMatchObject({});
    expect(vt.closed).toBe(true);
  });

  it('fires onClose on the peer when the host closes its transport (kick)', async () => {
    const r = await freshRelay();
    const host = await RelayHostLink.open(r.url, 'deadbeef', 'test');
    closers.push(() => void host.close());
    const gotTransport = new Promise<Transport>((resolve) =>
      host.onConnection((t) => resolve(t)),
    );
    const peer = await RelayPeerLink.open(r.url, 'deadbeef', 'test');
    const vt = await gotTransport;

    const hostSideClosed = new Promise<void>((resolve) => vt.onClose(() => resolve()));
    const peerSideClosed = new Promise<void>((resolve) => peer.onClose(() => resolve()));
    vt.close(1000, 'kicked');

    // the host's own transport self-notifies (no echo comes back from the
    // relay for a host-initiated kick - see relay-link.ts) AND the peer's
    // socket actually gets closed by the relay.
    await hostSideClosed;
    await peerSideClosed;
    expect(peer.closed).toBe(true);
  });

  it('tells surviving peers the host is gone when the host link closes', async () => {
    const r = await freshRelay();
    const host = await RelayHostLink.open(r.url, 'deadbeef', 'test');
    const peer = await RelayPeerLink.open(r.url, 'deadbeef', 'test');

    const peerClosed = new Promise<{ code: number; reason: string }>((resolve) =>
      peer.onClose((code, reason) => resolve({ code, reason })),
    );
    await host.close();

    const info = await peerClosed;
    expect(info.reason).toMatch(/host/i);
    expect(peer.closed).toBe(true);
  });

  it('rejects RelayPeerLink.open for a room that does not exist', async () => {
    const r = await freshRelay();
    await expect(RelayPeerLink.open(r.url, 'deadbeef', 'test')).rejects.toMatchObject({
      reason: 'no_such_room',
    });
  });

  it('rejects a second RelayHostLink.open for the same roomId', async () => {
    const r = await freshRelay();
    const host = await RelayHostLink.open(r.url, 'deadbeef', 'test');
    closers.push(() => void host.close());
    await expect(RelayHostLink.open(r.url, 'deadbeef', 'test')).rejects.toMatchObject({
      reason: 'room_exists',
    });
  });
});

describe('openWithRetry', () => {
  it('returns immediately on success', async () => {
    const open = vi.fn().mockResolvedValue('ok');
    await expect(openWithRetry(open)).resolves.toBe('ok');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('does not retry a fatal RelayLinkError', async () => {
    const err = new RelayLinkError('nope', 'room_exists');
    const open = vi.fn().mockRejectedValue(err);
    await expect(openWithRetry(open)).rejects.toBe(err);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure with backoff and calls onWaking once', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const open = vi.fn().mockImplementation(async () => {
        calls++;
        if (calls < 3) throw new Error('connect refused');
        return 'ok';
      });
      const onWaking = vi.fn();
      const p = openWithRetry(open, { onWaking, wakingAfterAttempts: 2 });
      await vi.runAllTimersAsync();
      await expect(p).resolves.toBe('ok');
      expect(open).toHaveBeenCalledTimes(3);
      expect(onWaking).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up once the budget elapses', async () => {
    vi.useFakeTimers();
    try {
      const open = vi.fn().mockRejectedValue(new Error('still down'));
      const p = openWithRetry(open, { budgetMs: 5_000 });
      const assertion = expect(p).rejects.toThrow('still down');
      await vi.runAllTimersAsync();
      await assertion;
      expect(open.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isRetriableRelayError', () => {
  it('treats connection-level failures as retriable', () => {
    expect(isRetriableRelayError(new Error('ECONNREFUSED'))).toBe(true);
  });

  it('treats rate_limited / server_full as retriable', () => {
    expect(isRetriableRelayError(new RelayLinkError('x', 'rate_limited'))).toBe(true);
    expect(isRetriableRelayError(new RelayLinkError('x', 'server_full'))).toBe(true);
  });

  it('treats room_exists / no_such_room / room_full as fatal', () => {
    expect(isRetriableRelayError(new RelayLinkError('x', 'room_exists'))).toBe(false);
    expect(isRetriableRelayError(new RelayLinkError('x', 'no_such_room'))).toBe(false);
    expect(isRetriableRelayError(new RelayLinkError('x', 'room_full'))).toBe(false);
  });
});
