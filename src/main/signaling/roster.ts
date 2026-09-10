/**
 * The host's authoritative view of who is in the room. Every mutation goes
 * through here and is serialized by the host, so there is never concurrent
 * writing and never a merge conflict (docs/DESIGN.md section 7.2).
 */

import type { RosterEntry } from '../../shared/protocol.js';

export class Roster {
  readonly #entries = new Map<string, RosterEntry>();
  #nextJoinSeq = 0;

  /** Seed the host's own entry (joinSeq 0). */
  constructor(hostEntry: Omit<RosterEntry, 'joinSeq'>) {
    this.#entries.set(hostEntry.peerId, { ...hostEntry, joinSeq: this.#nextJoinSeq++ });
  }

  allocateJoinSeq(): number {
    return this.#nextJoinSeq++;
  }

  has(peerId: string): boolean {
    return this.#entries.has(peerId);
  }

  hasNickname(nickname: string): boolean {
    for (const e of this.#entries.values()) {
      if (e.nickname.toLowerCase() === nickname.toLowerCase()) return true;
    }
    return false;
  }

  size(): number {
    return this.#entries.size;
  }

  add(entry: RosterEntry): void {
    this.#entries.set(entry.peerId, entry);
  }

  remove(peerId: string): RosterEntry | undefined {
    const entry = this.#entries.get(peerId);
    this.#entries.delete(peerId);
    return entry;
  }

  update(peerId: string, patch: Partial<RosterEntry>): RosterEntry | undefined {
    const current = this.#entries.get(peerId);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.#entries.set(peerId, next);
    return next;
  }

  get(peerId: string): RosterEntry | undefined {
    return this.#entries.get(peerId);
  }

  snapshot(): RosterEntry[] {
    return [...this.#entries.values()].sort((a, b) => a.joinSeq - b.joinSeq);
  }
}
