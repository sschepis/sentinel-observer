/**
 * SlowContextField tests (E.2 / improvements.md §6.2).
 *
 * The slow context is the SECOND timescale: integrated once per turn, decayed
 * over turns under the one retention law (the FSRS v4 curve, mirrored here —
 * this module may not import the web package). These tests pin the law, the
 * per-turn decay, the integration blend, and the bounded recall-cue tilt.
 */
import { describe, it, expect } from '@jest/globals';
import {
  SedenionMemoryField,
  SlowContextField,
  slowContextRetention,
  SLOW_CONTEXT_FORGETTING_FACTOR,
  MAX_SLOW_CONTEXT_BLEND_WEIGHT
} from '../../src/semantic';

describe('slowContextRetention (the one retention law, mirrored)', () => {
  it('R(0) = 1 and R(S; S) = the target retention 0.9', () => {
    expect(slowContextRetention(2, 0)).toBe(1);
    expect(slowContextRetention(1, 1)).toBeCloseTo(0.9, 6);
  });

  it('matches the FSRS v4 curve literal: (1 + (19/81)·t/S)^(−1/2)', () => {
    for (const [S, t] of [
      [1, 1],
      [2, 1],
      [2, 3],
      [5, 2]
    ] as const) {
      const expected = Math.pow(1 + SLOW_CONTEXT_FORGETTING_FACTOR * (t / S), -0.5);
      expect(slowContextRetention(S, t)).toBeCloseTo(expected, 12);
    }
  });

  it('is monotone decreasing in elapsed turns', () => {
    expect(slowContextRetention(2, 2)).toBeLessThan(slowContextRetention(2, 1));
    expect(slowContextRetention(2, 1)).toBeLessThan(1);
  });

  it('returns 0 for a non-positive stability', () => {
    expect(slowContextRetention(0, 1)).toBe(0);
    expect(slowContextRetention(-1, 1)).toBe(0);
    expect(slowContextRetention(NaN, 1)).toBe(0);
  });
});

describe('SlowContextField', () => {
  it('refuses unbounded configuration loudly', () => {
    expect(() => new SlowContextField({ stabilityTurns: 0 })).toThrow(/stabilityTurns/);
    expect(() => new SlowContextField({ blendWeight: 0.6 })).toThrow(/blendWeight/);
    expect(() => new SlowContextField({ blendWeight: -0.1 })).toThrow(/blendWeight/);
    expect(() => new SlowContextField({ learningRate: 1.5 })).toThrow(/learningRate/);
  });

  it('starts empty and reports the per-turn retention R(1; S)', () => {
    const context = new SlowContextField({ width: 16, stabilityTurns: 2 });
    expect(context.norm()).toBe(0);
    expect(context.turnCount).toBe(0);
    expect(context.retentionPerTurn()).toBeCloseTo(slowContextRetention(2, 1), 12);
  });

  it('integrates once per turn: per-turn decay then blend at the learning rate', () => {
    const context = new SlowContextField({ width: 16, stabilityTurns: 2, learningRate: 0.5 });
    const sampleA = {
      primes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
      phases: new Array(16).fill(0),
      amplitudes: new Array(16).fill(1),
      coherence: 1
    };
    const r = slowContextRetention(2, 1);

    // Turn 1: nothing to decay; ctx = lr·T → every axis 0.5, norm = 4·0.5.
    context.integrateTurn(sampleA);
    expect(context.turnCount).toBe(1);
    expect(context.norm()).toBeCloseTo(2, 10);

    // Turn 2: the existing context decays by R(1; S) first, then blends:
    // ctx' = (1−lr)·(r·ctx) + lr·T → each axis 0.5·(r·0.5) + 0.5.
    context.integrateTurn(sampleA);
    expect(context.turnCount).toBe(2);
    expect(context.norm()).toBeCloseTo(4 * (0.5 * (r * 0.5) + 0.5), 10);

    // Turn 3 with a quiescent sample (all amplitudes 0): decay, then blend
    // toward the zero target → ctx'' = 0.5·(r·ctx').
    const quiet = { ...sampleA, amplitudes: new Array(16).fill(0), coherence: 0 };
    context.integrateTurn(quiet);
    expect(context.turnCount).toBe(3);
    expect(context.norm()).toBeCloseTo(0.5 * r * (4 * (0.5 * (r * 0.5) + 0.5)), 10);
  });

  it('blends a bounded direction tilt: norm preserved, tilt bounded by weight', () => {
    const context = new SlowContextField({ width: 16, stabilityTurns: 2 });
    // Imprint a context pointing along a single axis (fold path: oscillators
    // 0..15 all excite axis 0 via j mod 16, so use a projection-free sample
    // and give axis 0 the mass).
    context.integrateTurn({
      primes: new Array(16).fill(1).map((_, i) => i + 1),
      phases: new Array(16).fill(0),
      amplitudes: [1, ...new Array(15).fill(0)],
      coherence: 1
    });

    const cue = SedenionMemoryField.identity({ width: 16 });
    const blended = context.blendInto(cue, 0.25);
    expect(blended).not.toBe(cue);
    expect(cue.get(0)).toBe(1); // the original cue is never mutated
    expect(blended.norm()).toBeCloseTo(cue.norm(), 10); // magnitude preserved

    // The tilt angle must be at most atan(weight): |sin θ| ≤ weight.
    const dot = blended.toArray().reduce((acc, v, i) => acc + v * cue.get(i), 0);
    const cos = Math.min(1, Math.max(-1, dot / (blended.norm() * cue.norm())));
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    expect(sin).toBeLessThanOrEqual(0.25 + 1e-9);
  });

  it('an empty context leaves the cue untouched', () => {
    const context = new SlowContextField({ width: 16 });
    const cue = SedenionMemoryField.identity({ width: 16 });
    const blended = context.blendInto(cue, 0.5);
    expect(blended.toArray()).toEqual(cue.toArray());
  });

  it('blend weight is clamped to the hard cap', () => {
    const context = new SlowContextField({ width: 16, stabilityTurns: 2, blendWeight: 0.5 });
    context.integrateTurn({
      primes: new Array(16).fill(1).map((_, i) => i + 1),
      phases: new Array(16).fill(0),
      amplitudes: [1, ...new Array(15).fill(0)],
      coherence: 1
    });
    const cue = SedenionMemoryField.identity({ width: 16 });
    // weight 0.9 requested → clamped to MAX_SLOW_CONTEXT_BLEND_WEIGHT.
    const blended = context.blendInto(cue, 0.9);
    const dot = blended.toArray().reduce((acc, v, i) => acc + v * cue.get(i), 0);
    const cos = Math.min(1, Math.max(-1, dot / (blended.norm() * cue.norm())));
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    expect(sin).toBeLessThanOrEqual(MAX_SLOW_CONTEXT_BLEND_WEIGHT + 1e-9);
  });

  it('reset clears the context and the turn counter', () => {
    const context = new SlowContextField({ width: 16, stabilityTurns: 2 });
    context.integrateTurn({
      primes: new Array(16).fill(1).map((_, i) => i + 1),
      phases: new Array(16).fill(0),
      amplitudes: new Array(16).fill(1),
      coherence: 1
    });
    expect(context.norm()).toBeGreaterThan(0);
    context.reset();
    expect(context.norm()).toBe(0);
    expect(context.turnCount).toBe(0);
  });
});
