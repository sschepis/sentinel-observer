/**
 * P13: SMF moment imprint — the first imprint after `settleField()` can
 * REPLACE the sketch instead of EMA-blending into the accumulated
 * curriculum trajectory.
 *
 * The honest control (default OFF) keeps the EMA: consecutive lessons share
 * the drifting trajectory, which is the measured collapse (§19d). With the
 * option ON, each lesson's trace sketch is imprinted from its own moment.
 */
import { describe, it, expect } from '@jest/globals';
import { SemanticObserver, SedenionMemoryField } from '../../src/semantic';
import { freshKernel } from './helpers';

describe('smfMomentImprint (P13)', () => {
  it('default OFF: settleField leaves the accumulated sketch untouched (control)', async () => {
    const kernel = await freshKernel();
    const observer = new SemanticObserver({ kernel, primeCount: 16, gridSize: 64 });
    await observer.initialize();

    observer.processInput([2, 3, 5], 0.5);
    observer.tick(0.016);
    observer.tick(0.016);
    const before = observer.getMemoryField().toArray();

    observer.settleField();
    expect(observer.getMemoryField().toArray()).toEqual(before);

    // And the next tick keeps blending: the result is NOT the pure moment
    // imprint of the fresh excitation.
    observer.processInput([7, 11], 0.5);
    observer.tick(0.016);
    const expectedFull = new SedenionMemoryField(new Float64Array(before), { primeCount: 16, width: 16 });
    for (let i = 0; i < before.length; i += 1) expectedFull.set(i, before[i]);
    expectedFull.updateFromPrimeActivity(observer.getOscillatorField().getState(), { learningRate: 1 });
    const after = observer.getMemoryField().toArray();
    let differs = false;
    for (let i = 0; i < after.length; i += 1) {
      if (Math.abs(after[i] - expectedFull.get(i)) > 1e-9) differs = true;
    }
    expect(differs).toBe(true);
    observer.dispose();
  });

  it('ON: the first tick after settleField fully replaces the sketch with the moment imprint', async () => {
    const kernel = await freshKernel();
    const observer = new SemanticObserver({ kernel, primeCount: 16, gridSize: 64, smfMomentImprint: true });
    await observer.initialize();

    observer.processInput([2, 3, 5], 0.5);
    observer.tick(0.016);
    observer.tick(0.016);

    observer.settleField();
    observer.processInput([7, 11], 0.5);

    // Expected = the pre-tick sketch replaced (alpha 1) by the state the
    // tick imprints (the field state AFTER the tick's evolution step).
    const expected = observer.getMemoryField().clone();
    observer.tick(0.016);
    expected.updateFromPrimeActivity(observer.getOscillatorField().getState(), { learningRate: 1 });

    const after = observer.getMemoryField().toArray();
    for (let i = 0; i < after.length; i += 1) {
      expect(after[i]).toBeCloseTo(expected.get(i), 9);
    }
    observer.dispose();
  });

  it('ON: the replacement is one-shot — later ticks blend again (EMA alpha < 1)', async () => {
    const kernel = await freshKernel();
    const observer = new SemanticObserver({ kernel, primeCount: 16, gridSize: 64, smfMomentImprint: true });
    await observer.initialize();

    observer.processInput([2, 3, 5], 0.5);
    observer.tick(0.016);
    observer.settleField();
    observer.processInput([7, 11], 0.5);
    observer.tick(0.016);

    // Second tick: ordinary blend, so the result differs from a full
    // replacement computed on the second tick's state.
    const expected = observer.getMemoryField().clone();
    observer.tick(0.016);
    expected.updateFromPrimeActivity(observer.getOscillatorField().getState(), { learningRate: 1 });
    const after = observer.getMemoryField().toArray();
    let differs = false;
    for (let i = 0; i < after.length; i += 1) {
      if (Math.abs(after[i] - expected.get(i)) > 1e-9) differs = true;
    }
    expect(differs).toBe(true);
    observer.dispose();
  });

  it('ON: every settleField re-arms the replacement', async () => {
    const kernel = await freshKernel();
    const observer = new SemanticObserver({ kernel, primeCount: 16, gridSize: 64, smfMomentImprint: true });
    await observer.initialize();

    for (const primes of [[2, 3, 5], [7, 11], [13, 17, 19]]) {
      observer.settleField();
      observer.processInput(primes, 0.5);
      const expected = observer.getMemoryField().clone();
      observer.tick(0.016);
      expected.updateFromPrimeActivity(observer.getOscillatorField().getState(), { learningRate: 1 });
      const after = observer.getMemoryField().toArray();
      for (let i = 0; i < after.length; i += 1) {
        expect(after[i]).toBeCloseTo(expected.get(i), 9);
      }
    }
    observer.dispose();
  });

  it('ON: a mid-tick failure rolls the pending replacement flag back atomically', async () => {
    const kernel = await freshKernel();
    let allow = false;
    const flakySafety = {
      checkMetrics: () => {
        if (!allow) throw new Error('injected tick failure');
        return { allowed: true, violations: [], evaluated: [], maxSeverity: null };
      }
    } as unknown as SemanticObserver['safety'];
    const observer = new SemanticObserver({ kernel, primeCount: 16, gridSize: 64, smfMomentImprint: true, safety: flakySafety });
    await observer.initialize();

    observer.processInput([2, 3, 5], 0.5);
    allow = true;
    observer.tick(0.016);
    allow = false;

    observer.settleField();
    observer.processInput([7, 11], 0.5);
    expect(() => observer.tick(0.016)).toThrow('injected tick failure');

    // The failed tick must NOT have consumed the one-shot replacement: the
    // next successful tick still fully replaces the sketch.
    allow = true;
    const expected = observer.getMemoryField().clone();
    observer.tick(0.016);
    expected.updateFromPrimeActivity(observer.getOscillatorField().getState(), { learningRate: 1 });
    const after = observer.getMemoryField().toArray();
    for (let i = 0; i < after.length; i += 1) {
      expect(after[i]).toBeCloseTo(expected.get(i), 9);
    }
    observer.dispose();
  });
});
