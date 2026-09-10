/**
 * Bandwidth / CPU governor (docs/DESIGN.md section 8.5).
 *
 * Pure control loop, no I/O: the host feeds it `stats_report` data and calls
 * `evaluate()` on an interval; it returns the `quality_directive`s to send.
 * Timer-agnostic so it is trivially unit-testable.
 *
 * One quality level per stream. Step DOWN fast (one bad window), step UP slow
 * (several good windows) - the usual asymmetry so a brief hiccup does not
 * yo-yo the encoder.
 */

export interface QualityLevel {
  readonly label: string;
  readonly kbpsFactor: number;
  readonly maxFps: number;
  readonly scaleDownBy: number;
}

/** Descending quality. Index 0 is full quality. */
export const QUALITY_LADDER: readonly QualityLevel[] = [
  { label: '1080p30', kbpsFactor: 1.0, maxFps: 30, scaleDownBy: 1 },
  { label: '720p30', kbpsFactor: 0.6, maxFps: 30, scaleDownBy: 1.5 },
  { label: '720p15', kbpsFactor: 0.4, maxFps: 15, scaleDownBy: 1.5 },
  { label: '480p15', kbpsFactor: 0.25, maxFps: 15, scaleDownBy: 2.5 },
];

export interface SubscriberSample {
  readonly streamId: string;
  readonly subscriberPeerId: string;
  readonly fractionLost: number;
  readonly rttMs: number;
  readonly fps: number;
}

export interface PublisherSample {
  readonly streamId: string;
  readonly cpuPressure: number;
  readonly fps: number;
}

export interface GovernorDirective {
  readonly ownerPeerId: string;
  readonly streamId: string;
  readonly maxKbps: number;
  readonly maxFps: number;
  readonly scaleDownBy: number;
  readonly reason: 'bandwidth' | 'cpu' | 'restored';
}

export interface GovernorOptions {
  readonly baseKbps: number;
  /** loss above this in one window steps the stream down */
  readonly lossThreshold?: number;
  /** consecutive healthy windows required to step back up */
  readonly recoveryWindows?: number;
}

interface StreamState {
  ownerPeerId: string;
  level: number;
  paused: boolean;
  healthyStreak: number;
  lastReason: GovernorDirective['reason'];
  subs: Map<string, SubscriberSample>;
  pub: PublisherSample | null;
}

export class Governor {
  readonly #baseKbps: number;
  readonly #lossThreshold: number;
  readonly #recoveryWindows: number;
  readonly #streams = new Map<string, StreamState>();

  constructor(opts: GovernorOptions) {
    this.#baseKbps = opts.baseKbps;
    this.#lossThreshold = opts.lossThreshold ?? 0.05;
    this.#recoveryWindows = opts.recoveryWindows ?? 4;
  }

  register(streamId: string, ownerPeerId: string): void {
    if (this.#streams.has(streamId)) return;
    this.#streams.set(streamId, {
      ownerPeerId,
      level: 0,
      paused: false,
      healthyStreak: 0,
      lastReason: 'restored',
      subs: new Map(),
      pub: null,
    });
  }

  forget(streamId: string): void {
    this.#streams.delete(streamId);
  }

  setPaused(streamId: string, paused: boolean): void {
    const s = this.#streams.get(streamId);
    if (s) s.paused = paused;
  }

  ingestSubscriber(sample: SubscriberSample): void {
    const s = this.#streams.get(sample.streamId);
    if (s) s.subs.set(sample.subscriberPeerId, sample);
  }

  ingestPublisher(sample: PublisherSample): void {
    const s = this.#streams.get(sample.streamId);
    if (s) s.pub = sample;
  }

  dropSubscriber(subscriberPeerId: string): void {
    for (const s of this.#streams.values()) s.subs.delete(subscriberPeerId);
  }

  /** Re-evaluate every active stream; returns directives to send. */
  evaluate(): GovernorDirective[] {
    const out: GovernorDirective[] = [];
    for (const [streamId, s] of this.#streams) {
      if (s.paused || s.subs.size === 0) continue;

      const worstLoss = Math.max(...[...s.subs.values()].map((x) => x.fractionLost));
      const cpu = s.pub?.cpuPressure ?? 0;
      const unhealthy = worstLoss > this.#lossThreshold || cpu >= 1;

      let nextLevel = s.level;
      let reason: GovernorDirective['reason'] = s.lastReason;

      if (unhealthy && s.level < QUALITY_LADDER.length - 1) {
        nextLevel = s.level + 1;
        reason = cpu >= 1 ? 'cpu' : 'bandwidth';
        s.healthyStreak = 0;
      } else if (unhealthy) {
        s.healthyStreak = 0;
      } else {
        s.healthyStreak += 1;
        if (s.healthyStreak >= this.#recoveryWindows && s.level > 0) {
          nextLevel = s.level - 1;
          reason = 'restored';
          s.healthyStreak = 0;
        }
      }

      if (nextLevel !== s.level) {
        s.level = nextLevel;
        s.lastReason = reason;
        out.push(this.#directive(streamId, s, reason));
      }
    }
    return out;
  }

  /** The directive that resumes a stream at its current level (after a pause). */
  resumeDirective(streamId: string): GovernorDirective | null {
    const s = this.#streams.get(streamId);
    if (!s) return null;
    return this.#directive(streamId, s, 'restored');
  }

  currentLevel(streamId: string): QualityLevel | null {
    const s = this.#streams.get(streamId);
    return s ? QUALITY_LADDER[s.level]! : null;
  }

  #directive(
    streamId: string,
    s: StreamState,
    reason: GovernorDirective['reason'],
  ): GovernorDirective {
    const level = QUALITY_LADDER[s.level]!;
    return {
      ownerPeerId: s.ownerPeerId,
      streamId,
      maxKbps: Math.round(this.#baseKbps * level.kbpsFactor),
      maxFps: level.maxFps,
      scaleDownBy: level.scaleDownBy,
      reason,
    };
  }
}
