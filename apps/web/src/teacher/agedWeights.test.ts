/**
 * L3 Phase 19.2 gates — weights are memories too.
 *
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  bumpAgedWeights,
  decayAgedWeights,
  capAgedWeights,
  NGRAM_WEIGHT_FLOOR,
  NGRAM_WEIGHT_CAP,
  type WeightMeta
} from './agedWeights';
import { decayToward, retentionProbability, dueIntervalDays, STABILITY_PRESETS, FSRS_TARGET_RETENTION } from './retention';
import type { TransitionWeights } from './conversation';

const DAY = 24 * 60 * 60 * 1000;

describe('retention.ts — the one law', () => {
  it('R(0) = 1, R(S) = target, monotone decreasing', () => {
    expect(retentionProbability(10, 0)).toBe(1);
    expect(retentionProbability(10, 10)).toBeCloseTo(FSRS_TARGET_RETENTION, 5);
    expect(retentionProbability(10, 30)).toBeLessThan(retentionProbability(10, 10));
  });

  it('dueIntervalDays inverts the curve at the target', () => {
    expect(dueIntervalDays(12)).toBeCloseTo(12, 5);
  });

  it('decayToward moves a value toward its floor by the retention of the window', () => {
    const decayed = decayToward(1.0, 0, 45 * DAY, 45);
    expect(decayed).toBeCloseTo(retentionProbability(45, 45), 10);
    // No elapsed time, no decay; zero stability, no decay (guarded).
    expect(decayToward(1, 0, 0, 45)).toBe(1);
    expect(decayToward(1, 0, DAY, 0)).toBe(1);
  });
});

describe('agedWeights — decay, prune, cap, round-trip', () => {
  it('bump stamps every touched n-gram with the bump time', () => {
    const weights: TransitionWeights = new Map();
    const meta: WeightMeta = new Map();
    bumpAgedWeights(weights, meta, ['i like warm tea'], 0.05, 1000);
    expect(weights.size).toBeGreaterThan(0);
    for (const key of weights.keys()) {
      expect(meta.get(key)).toBe(1000);
    }
  });

  it('unused weights decay toward the floor under the one law; used ones restart their clock', () => {
    const weights: TransitionWeights = new Map();
    const meta: WeightMeta = new Map();
    bumpAgedWeights(weights, meta, ['i like tea'], 0.05, 0);
    const key = 'i|like';
    const before = weights.get(key)!;

    // 90 days unused: w' = floor + (w − floor)·R(90; 45).
    decayAgedWeights(weights, meta, 90 * DAY);
    const after = weights.get(key)!;
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(
      NGRAM_WEIGHT_FLOOR + (before - NGRAM_WEIGHT_FLOOR) * retentionProbability(STABILITY_PRESETS.ngramWeightDays, 90),
      10
    );
    // The sweep re-stamps: an immediate second sweep decays nothing.
    const secondSweep = weights.get(key)!;
    decayAgedWeights(weights, meta, 90 * DAY);
    expect(weights.get(key)!).toBeCloseTo(secondSweep, 12);
  });

  it('a weight that reaches the floor is PRUNED — the map is bounded by forgetting', () => {
    const weights: TransitionWeights = new Map([['a|b', NGRAM_WEIGHT_FLOOR + 1e-12]]);
    const meta: WeightMeta = new Map([['a|b', 0]]);
    const { pruned } = decayAgedWeights(weights, meta, 365 * DAY);
    expect(pruned).toBe(1);
    expect(weights.has('a|b')).toBe(false);
    expect(meta.has('a|b')).toBe(false);
  });

  it('legacy entries without a stamp start their clock at the sweep (no retroactive decay)', () => {
    const weights: TransitionWeights = new Map([['x|y', 1.5]]);
    const meta: WeightMeta = new Map();
    decayAgedWeights(weights, meta, 500 * DAY);
    expect(weights.get('x|y')).toBe(1.5); // first sweep only stamps
    expect(meta.get('x|y')).toBe(500 * DAY);
    decayAgedWeights(weights, meta, 590 * DAY);
    expect(weights.get('x|y')!).toBeLessThan(1.5); // second sweep decays the 90d window
  });

  it('the hard cap evicts the weakest entries first (oldest stamp breaking ties)', () => {
    const weights: TransitionWeights = new Map();
    const meta: WeightMeta = new Map();
    for (let i = 0; i < 10; i += 1) {
      weights.set(`k|${i}`, 0.1 + i * 0.1);
      meta.set(`k|${i}`, i);
    }
    const evicted = capAgedWeights(weights, meta, 7);
    expect(evicted).toBe(3);
    expect(weights.has('k|0')).toBe(false);
    expect(weights.has('k|1')).toBe(false);
    expect(weights.has('k|2')).toBe(false);
    expect(weights.has('k|9')).toBe(true);
    expect(NGRAM_WEIGHT_CAP).toBe(50_000);
  });

  it('orphaned meta stamps are cleaned by the sweep', () => {
    const weights: TransitionWeights = new Map([['a|b', 1]]);
    const meta: WeightMeta = new Map([
      ['a|b', 0],
      ['ghost|key', 0]
    ]);
    decayAgedWeights(weights, meta, DAY);
    expect(meta.has('ghost|key')).toBe(false);
  });
});
