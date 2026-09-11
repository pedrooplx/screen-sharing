import { describe, expect, it, vi } from 'vitest';
import { Failover, type FailoverAction } from './failover.js';
import type { RosterEntry } from '../src/shared/protocol.js';
import type { HeirStatus } from './heir-probe.js';

function entry(p: Partial<RosterEntry> & { peerId: string }): RosterEntry {
  return {
    nickname: p.peerId,
    joinSeq: 0,
    isHost: false,
    inboundVerified: false,
    inboundEndpoint: null,
    publishing: null,
    ...p,
  };
}

const HOST = entry({ peerId: 'host', isHost: true, joinSeq: 0, inboundVerified: true });

function ep(peerId: string, joinSeq: number): RosterEntry {
  return entry({
    peerId,
    joinSeq,
    inboundVerified: true,
    inboundEndpoint: { address: '10.0.0.' + joinSeq, port: 40000 + joinSeq },
  });
}

const immediateTimeout = ((fn: () => void) => {
  fn();
  return 0 as unknown as NodeJS.Timeout;
}) as unknown as typeof setTimeout;

function run(opts: {
  self: string;
  roster: RosterEntry[];
  probe: (host: string, port: number) => Promise<HeirStatus>;
  epoch?: number;
  staggerMs?: number;
  setTimeoutFn?: typeof setTimeout;
}): Promise<FailoverAction> {
  const fo = new Failover({
    selfPeerId: opts.self,
    currentEpoch: opts.epoch ?? 3,
    roster: () => opts.roster,
    probe: opts.probe,
    staggerMs: opts.staggerMs ?? 2000,
    setTimeoutFn: opts.setTimeoutFn ?? immediateTimeout,
  });
  return new Promise((resolve) => {
    fo.on('action', resolve);
    fo.onHostLost();
  });
}

describe('Failover', () => {
  it('the designated heir promotes on epoch+1', async () => {
    const action = await run({
      self: 'p-a',
      roster: [HOST, ep('p-a', 1), ep('p-b', 2)],
      probe: () => Promise.reject(new Error('should not probe')),
    });
    expect(action).toEqual({ type: 'promote', epoch: 4 });
  });

  it('a lower-ranked peer re-homes to the heir when the heir says host is gone', async () => {
    const probe = vi.fn(async () => ({ hostAlive: false, epoch: 4 }));
    const action = await run({
      self: 'p-b',
      roster: [HOST, ep('p-a', 1), ep('p-b', 2)],
      probe,
    });
    expect(action).toMatchObject({ type: 'connect-heir', heirPeerId: 'p-a', expectedEpoch: 4 });
    expect(probe).toHaveBeenCalledWith('10.0.0.1', 40001);
  });

  it('a peer that only lost its own link reconnects, does not fail over', async () => {
    const action = await run({
      self: 'p-b',
      roster: [HOST, ep('p-a', 1), ep('p-b', 2)],
      probe: async () => ({ hostAlive: true, epoch: 3 }),
    });
    expect(action).toEqual({ type: 'reconnect-current' });
  });

  it('skips an unreachable heir and promotes the next in line (me)', async () => {
    const probe = vi.fn(async () => {
      throw new Error('heir down too');
    });
    const action = await run({
      self: 'p-b',
      roster: [HOST, ep('p-a', 1), ep('p-b', 2)],
      probe,
      staggerMs: 0,
    });
    expect(action).toEqual({ type: 'promote', epoch: 4 });
    expect(probe).toHaveBeenCalledOnce(); // probed p-a, then it was my turn
  });

  it('declares the room dead when nobody can host', async () => {
    const action = await run({
      self: 'p-x',
      roster: [
        HOST,
        entry({ peerId: 'p-a', joinSeq: 1, inboundVerified: false }),
        entry({ peerId: 'p-x', joinSeq: 2, inboundVerified: false }),
      ],
      probe: () => Promise.reject(new Error('no endpoint anyway')),
    });
    expect(action.type).toBe('room-dead');
  });

  it('staggers a position-2 promotion behind position-1', async () => {
    const order: string[] = [];
    const stagger = ((fn: () => void, ms: number) => {
      order.push(`wait ${ms}`);
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;
    await run({
      self: 'p-c',
      roster: [HOST, ep('p-a', 1), ep('p-b', 2), ep('p-c', 3)],
      probe: async () => {
        throw new Error('all down');
      },
      staggerMs: 1000,
      setTimeoutFn: stagger,
    });
    expect(order).toContain('wait 2000'); // index 2 -> 2 * 1000
  });

  describe('graceful transfer', () => {
    it('promotes me when I am named', () => {
      const fo = new Failover({
        selfPeerId: 'p-a',
        currentEpoch: 3,
        roster: () => [HOST, ep('p-a', 1)],
        probe: () => Promise.reject(new Error()),
      });
      const seen: FailoverAction[] = [];
      fo.on('action', (a) => seen.push(a));
      fo.onGracefulTransfer('p-a', 4);
      expect(seen).toEqual([{ type: 'promote', epoch: 4 }]);
    });

    it('re-homes me to the named successor', () => {
      const fo = new Failover({
        selfPeerId: 'p-b',
        currentEpoch: 3,
        roster: () => [HOST, ep('p-a', 1), ep('p-b', 2)],
        probe: () => Promise.reject(new Error()),
      });
      const seen: FailoverAction[] = [];
      fo.on('action', (a) => seen.push(a));
      fo.onGracefulTransfer('p-a', 4);
      expect(seen[0]).toMatchObject({ type: 'connect-heir', heirPeerId: 'p-a' });
    });
  });

  it('cancel() stops any pending action', async () => {
    let resolveProbe: (s: HeirStatus) => void = () => {};
    const fo = new Failover({
      selfPeerId: 'p-b',
      currentEpoch: 3,
      roster: () => [HOST, ep('p-a', 1), ep('p-b', 2)],
      probe: () => new Promise<HeirStatus>((r) => (resolveProbe = r)),
      setTimeoutFn: immediateTimeout,
    });
    const seen: FailoverAction[] = [];
    fo.on('action', (a) => seen.push(a));
    fo.onHostLost();
    fo.cancel();
    resolveProbe({ hostAlive: false, epoch: 4 });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(0);
  });
});
