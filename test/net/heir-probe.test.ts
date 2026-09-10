import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  HeirProbeError,
  HeirProbeResponder,
  heirProbe,
} from '../../src/main/net/heir-probe.js';

const roomId = new Uint8Array([1, 2, 3, 4]);
const W = new Uint8Array(randomBytes(32));

let responders: HeirProbeResponder[] = [];
afterEach(() => {
  for (const r of responders) r.close();
  responders = [];
});

async function startResponder(w = W, status = { hostAlive: true, epoch: 0 }) {
  const r = new HeirProbeResponder(w, roomId);
  r.setStatus(status);
  responders.push(r);
  const { port } = await r.listen(0, '127.0.0.1');
  return { r, port };
}

describe('heir probe', () => {
  it('round-trips an authenticated status', async () => {
    const { port } = await startResponder(W, { hostAlive: false, epoch: 7 });
    const status = await heirProbe('127.0.0.1', port, W, roomId);
    expect(status).toEqual({ hostAlive: false, epoch: 7 });
  });

  it('reflects a status change', async () => {
    const { r, port } = await startResponder(W, { hostAlive: true, epoch: 2 });
    expect((await heirProbe('127.0.0.1', port, W, roomId)).hostAlive).toBe(true);
    r.setStatus({ hostAlive: false, epoch: 2 });
    expect((await heirProbe('127.0.0.1', port, W, roomId)).hostAlive).toBe(false);
  });

  it('a prober with the wrong password gets no answer', async () => {
    const { port } = await startResponder();
    await expect(
      heirProbe('127.0.0.1', port, new Uint8Array(randomBytes(32)), roomId, {
        timeoutMs: 150,
        retries: 1,
      }),
    ).rejects.toThrow(HeirProbeError);
  });

  it('a probe for a different room gets no answer', async () => {
    const { port } = await startResponder();
    await expect(
      heirProbe('127.0.0.1', port, W, new Uint8Array([9, 9, 9, 9]), {
        timeoutMs: 150,
        retries: 1,
      }),
    ).rejects.toThrow(HeirProbeError);
  });

  it('times out cleanly when nothing is listening', async () => {
    await expect(
      heirProbe('127.0.0.1', 1, W, roomId, { timeoutMs: 100, retries: 1 }),
    ).rejects.toThrow(HeirProbeError);
  });
});
