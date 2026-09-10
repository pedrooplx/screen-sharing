/**
 * Failover coordinator (docs/DESIGN.md section 9).
 *
 * When the local SignalingClient reports `host-lost`, this decides what to do,
 * using only information every peer already holds (the roster mirror) plus one
 * UDP `heir_probe` per candidate. It emits a single `action`; the owning
 * PeerNode carries it out.
 *
 *   promote          - I am the reachable successor; start a server on epoch+1
 *   connect-heir     - someone ahead of me is taking over; re-home to them
 *   reconnect-current- the heir says the host is still alive; I'm just isolated
 *   room-dead        - nobody in the succession list answered
 *
 * Split-brain guard: a peer never promotes because it *thinks* the host is
 * gone. It promotes only when it is first in line AND (the previous candidates
 * are unreachable OR a heir probe confirms the host is gone).
 */

import { EventEmitter } from 'node:events';
import {
  type ElectionEntry,
  electionEntriesFromRoster,
  successionOrder,
} from './succession.js';
import type { HeirStatus } from '../net/heir-probe.js';
import type { InboundEndpoint, RosterEntry } from '../../shared/protocol.js';

export type FailoverAction =
  | { readonly type: 'promote'; readonly epoch: number }
  | {
      readonly type: 'connect-heir';
      readonly heirPeerId: string;
      readonly endpoint: InboundEndpoint;
      readonly expectedEpoch: number;
    }
  | { readonly type: 'reconnect-current' }
  | { readonly type: 'room-dead'; readonly reason: string };

export interface FailoverEvents {
  action: [FailoverAction];
}

export type ProbeFn = (
  host: string,
  port: number,
) => Promise<HeirStatus>;

export interface FailoverOptions {
  readonly selfPeerId: string;
  readonly currentEpoch: number;
  /** live view of the peer's roster mirror */
  readonly roster: () => RosterEntry[];
  /** perform a heir probe against an endpoint */
  readonly probe: ProbeFn;
  /** delay per succession position before a lower-ranked peer acts (default 2s) */
  readonly staggerMs?: number;
  readonly setTimeoutFn?: typeof setTimeout;
}

export class Failover extends EventEmitter<FailoverEvents> {
  readonly #opts: Required<Pick<FailoverOptions, 'staggerMs' | 'setTimeoutFn'>> &
    FailoverOptions;
  #running = false;
  #done = false;
  #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(opts: FailoverOptions) {
    super();
    this.#opts = {
      staggerMs: 2_000,
      setTimeoutFn: setTimeout,
      ...opts,
    };
  }

  /** The local client lost the host. */
  onHostLost(): void {
    if (this.#running || this.#done) return;
    this.#running = true;
    this.#run().catch((err: Error) => {
      this.#emitOnce({
        type: 'room-dead',
        reason: `failover error: ${err.message}`,
      });
    });
  }

  /** The host announced a graceful handoff before leaving. */
  onGracefulTransfer(successorPeerId: string, epoch: number): void {
    if (this.#done) return;
    this.#finish();
    if (successorPeerId === this.#opts.selfPeerId) {
      this.emit('action', { type: 'promote', epoch });
      return;
    }
    const entry = this.#opts.roster().find((e) => e.peerId === successorPeerId);
    if (entry?.inboundEndpoint) {
      this.emit('action', {
        type: 'connect-heir',
        heirPeerId: successorPeerId,
        endpoint: entry.inboundEndpoint,
        expectedEpoch: epoch,
      });
    } else {
      this.emit('action', {
        type: 'room-dead',
        reason: 'named successor has no known endpoint',
      });
    }
  }

  /** We reconnected (to the old host or a new one); stop trying. */
  cancel(): void {
    this.#finish();
  }

  #finish(): void {
    this.#done = true;
    this.#running = false;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }

  #delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let handle: ReturnType<typeof setTimeout> | undefined;
      const fire = () => {
        if (handle !== undefined) this.#timers.delete(handle);
        resolve();
      };
      handle = this.#opts.setTimeoutFn(fire, ms);
      this.#timers.add(handle);
    });
  }

  async #run(): Promise<void> {
    const roster = this.#opts.roster();
    const entries: ElectionEntry[] = electionEntriesFromRoster(roster);
    const order = successionOrder(entries).filter(
      (id) => id !== hostPeerId(roster),
    );

    const myIndex = order.indexOf(this.#opts.selfPeerId);
    const byId = new Map(roster.map((e) => [e.peerId, e]));

    for (let i = 0; i < order.length && !this.#done; i++) {
      const candidateId = order[i]!;

      if (candidateId === this.#opts.selfPeerId) {
        // only promote if the host actually verified our inbound path
        if (!byId.get(candidateId)?.inboundVerified) continue;
        // stagger by position so higher-ranked peers act first
        if (i > 0) await this.#delay(this.#opts.staggerMs * i);
        if (this.#done) return;
        this.#emitOnce({ type: 'promote', epoch: this.#opts.currentEpoch + 1 });
        return;
      }

      const endpoint = byId.get(candidateId)?.inboundEndpoint;
      if (!endpoint) continue; // can't probe or re-home; try the next

      let status: HeirStatus;
      try {
        status = await this.#opts.probe(endpoint.address, endpoint.port);
      } catch {
        continue; // candidate unreachable -> next in line
      }
      if (this.#done) return;

      if (status.hostAlive && status.epoch <= this.#opts.currentEpoch) {
        // the host is fine; I was just isolated
        this.#emitOnce({ type: 'reconnect-current' });
        return;
      }

      // this candidate is (or is becoming) the new host
      this.#emitOnce({
        type: 'connect-heir',
        heirPeerId: candidateId,
        endpoint,
        expectedEpoch: Math.max(this.#opts.currentEpoch + 1, status.epoch),
      });
      return;
    }

    if (!this.#done) {
      this.#emitOnce({
        type: 'room-dead',
        reason:
          myIndex === -1
            ? 'I cannot host and no reachable successor answered'
            : 'no reachable successor and my own inbound port is unverified',
      });
    }
  }

  #emitOnce(action: FailoverAction): void {
    if (this.#done) return;
    this.#finish();
    this.emit('action', action);
  }
}

function hostPeerId(roster: readonly RosterEntry[]): string | undefined {
  return roster.find((e) => e.isHost)?.peerId;
}
