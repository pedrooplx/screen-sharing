import { describe, expect, it } from 'vitest';
import {
  type ElectionEntry,
  designatedHeir,
  nextSuccessor,
  successionIndex,
  successionOrder,
} from '../../src/main/election/succession.js';

function entry(p: Partial<ElectionEntry> & { peerId: string }): ElectionEntry {
  return {
    joinSeq: 0,
    inboundVerified: false,
    isHost: false,
    connected: true,
    ...p,
  };
}

const roster: ElectionEntry[] = [
  entry({ peerId: 'host', isHost: true, joinSeq: 0 }),
  entry({ peerId: 'p-charlie', joinSeq: 3, inboundVerified: true }),
  entry({ peerId: 'p-alice', joinSeq: 1, inboundVerified: false }),
  entry({ peerId: 'p-bob', joinSeq: 2, inboundVerified: true }),
  entry({ peerId: 'p-dave', joinSeq: 4, inboundVerified: false, connected: false }),
];

describe('successionOrder', () => {
  it('prefers inboundVerified, then joinSeq, then peerId', () => {
    // verified: bob(2) before charlie(3); then unverified alice(1)
    expect(successionOrder(roster)).toEqual(['p-bob', 'p-charlie', 'p-alice']);
  });

  it('excludes the host and disconnected peers', () => {
    const ids = successionOrder(roster);
    expect(ids).not.toContain('host');
    expect(ids).not.toContain('p-dave');
  });

  it('is independent of input order (deterministic across peers)', () => {
    const shuffled = [...roster].reverse();
    expect(successionOrder(shuffled)).toEqual(successionOrder(roster));
  });

  it('breaks a full tie on peerId', () => {
    const tied = [
      entry({ peerId: 'zeta', joinSeq: 5, inboundVerified: true }),
      entry({ peerId: 'beta', joinSeq: 5, inboundVerified: true }),
      entry({ peerId: 'gamma', joinSeq: 5, inboundVerified: true }),
    ];
    expect(successionOrder(tied)).toEqual(['beta', 'gamma', 'zeta']);
  });

  it('returns nothing when only the host is connected', () => {
    expect(successionOrder([entry({ peerId: 'host', isHost: true })])).toEqual([]);
    expect(designatedHeir([entry({ peerId: 'host', isHost: true })])).toBeNull();
  });
});

describe('failover helpers', () => {
  it('designatedHeir is the head of the queue', () => {
    expect(designatedHeir(roster)).toBe('p-bob');
  });

  it('nextSuccessor skips exhausted candidates', () => {
    expect(nextSuccessor(roster, new Set(['p-bob']))).toBe('p-charlie');
    expect(nextSuccessor(roster, new Set(['p-bob', 'p-charlie', 'p-alice']))).toBeNull();
  });

  it('successionIndex staggers promotion attempts', () => {
    expect(successionIndex(roster, 'p-bob')).toBe(0);
    expect(successionIndex(roster, 'p-alice')).toBe(2);
    expect(successionIndex(roster, 'host')).toBe(-1);
  });
});
