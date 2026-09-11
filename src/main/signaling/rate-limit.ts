/**
 * Per-IP handshake rate limiting for the host (docs/DESIGN.md section 6.4).
 *
 * Every attempt still costs the host ~1 s of Argon2id, CPace success or not -
 * connecting to this app's single fixed room needs no password any more
 * (docs/DESIGN.md section 6), so what this actually guards against now is
 * someone hammering the host with connection attempts to burn its CPU, not
 * password guessing. This caps that: a sliding window of allowed attempts,
 * then exponential backoff.
 */

export interface RateLimitConfig {
  /** attempts allowed inside the window before backoff kicks in */
  readonly burst: number;
  /** sliding window length, ms */
  readonly windowMs: number;
  /** backoff after the burst is exhausted, ms (doubles each further attempt) */
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  burst: 5,
  windowMs: 60_000,
  baseBackoffMs: 2_000,
  maxBackoffMs: 15 * 60_000,
};

interface Bucket {
  hits: number[];
  blockedUntil: number;
  overflowCount: number;
}

export class RateLimiter {
  readonly #cfg: RateLimitConfig;
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;

  constructor(cfg: RateLimitConfig = DEFAULT_RATE_LIMIT, now: () => number = Date.now) {
    this.#cfg = cfg;
    this.#now = now;
  }

  /** Returns null if allowed (and records the attempt), or ms-until-retry. */
  take(key: string): number | null {
    const now = this.#now();
    const bucket = this.#buckets.get(key) ?? {
      hits: [],
      blockedUntil: 0,
      overflowCount: 0,
    };
    this.#buckets.set(key, bucket);

    if (now < bucket.blockedUntil) return bucket.blockedUntil - now;

    bucket.hits = bucket.hits.filter((t) => now - t < this.#cfg.windowMs);

    if (bucket.hits.length >= this.#cfg.burst) {
      const backoff = Math.min(
        this.#cfg.baseBackoffMs * 2 ** bucket.overflowCount,
        this.#cfg.maxBackoffMs,
      );
      bucket.overflowCount++;
      bucket.blockedUntil = now + backoff;
      return backoff;
    }

    bucket.hits.push(now);
    return null;
  }

  /** Called on a successful handshake: reset the peer's standing. */
  clear(key: string): void {
    this.#buckets.delete(key);
  }

  /** Drop stale buckets. */
  sweep(): void {
    const now = this.#now();
    for (const [key, bucket] of this.#buckets) {
      const idle =
        now > bucket.blockedUntil &&
        bucket.hits.every((t) => now - t >= this.#cfg.windowMs);
      if (idle) this.#buckets.delete(key);
    }
  }
}
