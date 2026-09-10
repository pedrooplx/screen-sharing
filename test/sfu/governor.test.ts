import { describe, expect, it } from 'vitest';
import { Governor, QUALITY_LADDER } from '../../src/main/sfu/governor.js';

function make() {
  return new Governor({ baseKbps: 2500, lossThreshold: 0.05, recoveryWindows: 3 });
}

function healthy(g: Governor, streamId: string, sub = 'p_b') {
  g.ingestSubscriber({ streamId, subscriberPeerId: sub, fractionLost: 0.0, rttMs: 20, fps: 30 });
}
function lossy(g: Governor, streamId: string, sub = 'p_b') {
  g.ingestSubscriber({ streamId, subscriberPeerId: sub, fractionLost: 0.2, rttMs: 20, fps: 12 });
}

describe('Governor', () => {
  it('does nothing while everyone is healthy', () => {
    const g = make();
    g.register('s1', 'p_a');
    healthy(g, 's1');
    expect(g.evaluate()).toEqual([]);
    expect(g.currentLevel('s1')?.label).toBe(QUALITY_LADDER[0]!.label);
  });

  it('steps down one level on a single bad window (bandwidth)', () => {
    const g = make();
    g.register('s1', 'p_a');
    lossy(g, 's1');
    const [d] = g.evaluate();
    expect(d).toMatchObject({
      streamId: 's1',
      ownerPeerId: 'p_a',
      reason: 'bandwidth',
      maxFps: QUALITY_LADDER[1]!.maxFps,
    });
    expect(d!.maxKbps).toBe(Math.round(2500 * QUALITY_LADDER[1]!.kbpsFactor));
  });

  it('keeps stepping down but stops at the floor', () => {
    const g = make();
    g.register('s1', 'p_a');
    for (let i = 0; i < 10; i++) {
      lossy(g, 's1');
      g.evaluate();
    }
    expect(g.currentLevel('s1')?.label).toBe(
      QUALITY_LADDER[QUALITY_LADDER.length - 1]!.label,
    );
  });

  it('steps down on CPU pressure from the publisher', () => {
    const g = make();
    g.register('s1', 'p_a');
    healthy(g, 's1');
    g.ingestPublisher({ streamId: 's1', cpuPressure: 1, fps: 18 });
    expect(g.evaluate()[0]).toMatchObject({ reason: 'cpu' });
  });

  it('recovers only after several consecutive healthy windows', () => {
    const g = make();
    g.register('s1', 'p_a');
    lossy(g, 's1');
    g.evaluate(); // -> level 1
    expect(g.currentLevel('s1')?.label).toBe(QUALITY_LADDER[1]!.label);

    healthy(g, 's1');
    expect(g.evaluate()).toEqual([]); // window 1
    healthy(g, 's1');
    expect(g.evaluate()).toEqual([]); // window 2
    healthy(g, 's1');
    const [up] = g.evaluate(); // window 3 -> step up
    expect(up).toMatchObject({ reason: 'restored' });
    expect(g.currentLevel('s1')?.label).toBe(QUALITY_LADDER[0]!.label);
  });

  it('a paused stream is left alone', () => {
    const g = make();
    g.register('s1', 'p_a');
    g.setPaused('s1', true);
    lossy(g, 's1');
    expect(g.evaluate()).toEqual([]);
  });

  it('resumeDirective reflects the degraded level', () => {
    const g = make();
    g.register('s1', 'p_a');
    lossy(g, 's1');
    g.evaluate();
    const resume = g.resumeDirective('s1');
    expect(resume).toMatchObject({ reason: 'restored', maxFps: QUALITY_LADDER[1]!.maxFps });
  });

  it('the worst subscriber decides the level', () => {
    const g = make();
    g.register('s1', 'p_a');
    healthy(g, 's1', 'good');
    lossy(g, 's1', 'bad');
    expect(g.evaluate()[0]).toMatchObject({ reason: 'bandwidth' });
  });
});
