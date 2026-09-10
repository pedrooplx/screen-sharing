import { describe, expect, it, vi } from 'vitest';
import { Heartbeat } from '../../src/main/signaling/heartbeat.js';

function make(maxMissed = 3) {
  const pings: number[] = [];
  const onDead = vi.fn();
  const hb = new Heartbeat({
    maxMissed,
    sendPing: (nonce) => pings.push(nonce),
    onDead,
  });
  return { hb, pings, onDead };
}

describe('Heartbeat', () => {
  it('sends a ping on start and on each tick', () => {
    const { hb, pings } = make();
    hb.start();
    expect(pings).toHaveLength(1);
    hb.onPong(pings[0]!);
    hb.tick();
    expect(pings).toHaveLength(2);
  });

  it('declares dead after maxMissed unanswered ticks', () => {
    const { hb, onDead } = make(3);
    hb.start(); // ping #1 sent, outstanding
    hb.tick(); // missed = 1
    hb.tick(); // missed = 2
    expect(onDead).not.toHaveBeenCalled();
    hb.tick(); // missed = 3 -> dead
    expect(onDead).toHaveBeenCalledOnce();
    expect(hb.dead).toBe(true);
  });

  it('a pong resets the miss counter', () => {
    const { hb, pings, onDead } = make(3);
    hb.start();
    hb.tick(); // missed 1
    hb.tick(); // missed 2
    hb.onPong(pings.at(-1)!); // answered -> reset
    hb.tick();
    hb.tick();
    expect(onDead).not.toHaveBeenCalled();
  });

  it('ignores a stale or unknown pong nonce', () => {
    const { hb, onDead } = make(2);
    hb.start();
    hb.onPong(999999); // not the outstanding nonce
    hb.tick(); // missed 1
    hb.tick(); // missed 2 -> dead
    expect(onDead).toHaveBeenCalledOnce();
  });

  it('does nothing after stop()', () => {
    const { hb, pings } = make();
    hb.start();
    hb.stop();
    hb.tick();
    expect(pings).toHaveLength(1);
  });

  it('fires onDead at most once', () => {
    const { hb, onDead } = make(1);
    hb.start();
    hb.tick();
    hb.tick();
    hb.tick();
    expect(onDead).toHaveBeenCalledOnce();
  });
});
