/**
 * Deterministic host-succession order (docs/DESIGN.md section 9.1).
 *
 * Every participant holds the same roster and runs this pure function, so every
 * participant computes the same successor list with zero coordination. The
 * ordering keys, in priority:
 *
 *   1. inboundVerified  desc  - the host proved it can open a fresh connection
 *                               back to this peer, so it can actually take over
 *   2. joinSeq          asc   - whoever joined earliest
 *   3. peerId           asc   - lexicographic tie-break
 *
 * The current host and any peer whose control link is known dead are excluded.
 */

export interface ElectionEntry {
  readonly peerId: string;
  readonly joinSeq: number;
  readonly inboundVerified: boolean;
  readonly isHost: boolean;
  /** false once the heartbeat has declared this peer's control link dead */
  readonly connected: boolean;
}

export function compareCandidates(a: ElectionEntry, b: ElectionEntry): number {
  if (a.inboundVerified !== b.inboundVerified) {
    return a.inboundVerified ? -1 : 1;
  }
  if (a.joinSeq !== b.joinSeq) return a.joinSeq - b.joinSeq;
  if (a.peerId < b.peerId) return -1;
  if (a.peerId > b.peerId) return 1;
  return 0;
}

/** Ordered list of peerIds eligible to become host, best first. */
export function successionOrder(roster: readonly ElectionEntry[]): string[] {
  return roster
    .filter((e) => !e.isHost && e.connected)
    .slice()
    .sort(compareCandidates)
    .map((e) => e.peerId);
}

/** The designated heir: first in line, or null if nobody is eligible. */
export function designatedHeir(roster: readonly ElectionEntry[]): string | null {
  return successionOrder(roster)[0] ?? null;
}

/**
 * Next eligible successor, skipping peers that already tried and failed to open
 * a port during this failover round.
 */
export function nextSuccessor(
  roster: readonly ElectionEntry[],
  exhausted: ReadonlySet<string>,
): string | null {
  return successionOrder(roster).find((id) => !exhausted.has(id)) ?? null;
}

/**
 * My position in the succession queue (0 == designated heir), or -1 if I am not
 * eligible. Used to stagger promotion attempts by `2s * position`.
 */
export function successionIndex(
  roster: readonly ElectionEntry[],
  selfPeerId: string,
): number {
  return successionOrder(roster).indexOf(selfPeerId);
}

/**
 * Adapt a protocol roster (as mirrored by a peer) into election entries. Every
 * entry present in a peer's mirror is by definition still connected.
 */
export function electionEntriesFromRoster(
  roster: ReadonlyArray<{
    peerId: string;
    joinSeq: number;
    isHost: boolean;
    inboundVerified: boolean;
  }>,
): ElectionEntry[] {
  return roster.map((e) => ({
    peerId: e.peerId,
    joinSeq: e.joinSeq,
    isHost: e.isHost,
    inboundVerified: e.inboundVerified,
    connected: true,
  }));
}
