import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/main/signaling/rate-limit.js';

const cfg = {
  burst: 3,
  windowMs: 1000,
  baseBackoffMs: 100,
  maxBackoffMs: 2000,
};

describe('RateLimiter', () => {
  it('allows up to the burst, then blocks', () => {
    let now = 0;
    const rl = new RateLimiter(cfg, () => now);
    expect(rl.take('ip')).toBeNull();
    expect(rl.take('ip')).toBeNull();
    expect(rl.take('ip')).toBeNull();
    expect(rl.take('ip')).toBe(100);
  });

  it('doubles the backoff on repeated overflow', () => {
    let now = 0;
    const rl = new RateLimiter(cfg, () => now);
    for (let i = 0; i < 3; i++) rl.take('ip');
    expect(rl.take('ip')).toBe(100);
    now += 100;
    expect(rl.take('ip')).toBe(200);
    now += 200;
    expect(rl.take('ip')).toBe(400);
  });

  it('caps the backoff', () => {
    let now = 0;
    const rl = new RateLimiter(
      { ...cfg, windowMs: 1_000_000, maxBackoffMs: 250 },
      () => now,
    );
    for (let i = 0; i < 3; i++) rl.take('ip');
    let last = 0;
    for (let i = 0; i < 8; i++) {
      const wait = rl.take('ip'); // now === blockedUntil, so a fresh backoff is computed
      last = wait ?? 0;
      now += last;
    }
    expect(last).toBe(250); // 100, 200, 250, 250, ...
  });

  it('recovers after the window passes', () => {
    let now = 0;
    const rl = new RateLimiter(cfg, () => now);
    for (let i = 0; i < 3; i++) rl.take('ip');
    now += 5000;
    expect(rl.take('ip')).toBeNull();
  });

  it('tracks IPs independently and clear() resets one', () => {
    let now = 0;
    const rl = new RateLimiter(cfg, () => now);
    for (let i = 0; i < 3; i++) rl.take('a');
    expect(rl.take('a')).not.toBeNull();
    expect(rl.take('b')).toBeNull();
    rl.clear('a');
    expect(rl.take('a')).toBeNull();
  });
});
