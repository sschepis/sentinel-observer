/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  retentionProbability,
  reviewRetrievability,
  dueIntervalDays,
  applyRetentionDecay,
  FSRS_TARGET_RETENTION,
  FSRS_INITIAL_STABILITY,
  FSRS_CONSOLIDATED_STABILITY
} from './TeacherAgent';

describe('P9 FSRS retention model', () => {
  it('the curve starts at 1 and crosses the target retention at one stability', () => {
    expect(retentionProbability(1, 0)).toBe(1);
    expect(retentionProbability(1, 1)).toBeCloseTo(FSRS_TARGET_RETENTION, 5);
  });

  it('decays monotonically in time and recovers with stability', () => {
    expect(retentionProbability(10, 20)).toBeLessThan(retentionProbability(10, 10));
    expect(retentionProbability(30, 10)).toBeGreaterThan(retentionProbability(1, 10));
  });

  it('the due interval inverts the curve: R(interval) = target, and interval ≈ stability', () => {
    const interval = dueIntervalDays(10);
    expect(interval).toBeCloseTo(10, 5);
    expect(retentionProbability(10, interval)).toBeCloseTo(FSRS_TARGET_RETENTION, 5);
    expect(dueIntervalDays(0)).toBe(0);
  });

  it('applyRetentionDecay sets strength to the prediction; non-word traces use the default curve', () => {
    const now = Date.now();
    const traces = [
      { id: 'word', lastAccessAt: now - 2 * 86400000, strength: 1 },
      { id: 'convo', lastAccessAt: now - 2 * 86400000, strength: 1 }
    ];
    applyRetentionDecay(traces, (id) => (id === 'word' ? { stability: 2, difficulty: 5 } : null), now);
    expect(traces[0].strength).toBeCloseTo(retentionProbability(2, 2), 5);
    expect(traces[1].strength).toBeCloseTo(retentionProbability(7, 2), 5);
  });

  it('rate scales stability: 2 forgets half as fast', () => {
    const a = [{ id: 'w', lastAccessAt: Date.now() - 10 * 86400000, strength: 1 }];
    const b = [{ id: 'w', lastAccessAt: Date.now() - 10 * 86400000, strength: 1 }];
    applyRetentionDecay(a, () => ({ stability: 1, difficulty: 5 }), Date.now(), 1);
    applyRetentionDecay(b, () => ({ stability: 1, difficulty: 5 }), Date.now(), 2);
    expect(b[0].strength).toBeGreaterThan(a[0].strength);
  });

  it('the constants make fresh words due now and consolidated at 30 days', () => {
    expect(FSRS_INITIAL_STABILITY).toBe(1);
    expect(FSRS_CONSOLIDATED_STABILITY).toBe(30);
    expect(FSRS_TARGET_RETENTION).toBe(0.9);
  });
});

describe('L1a review retrievability (Phase 17.1)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const base = { stability: 10, lastAskedAt: null, taughtAt: null };

  it('reads R ≈ 1 for a word never reviewed (cram) and R = target at one stability of elapsed time', () => {
    expect(reviewRetrievability({ ...base }, 0)).toBe(1);
    expect(
      reviewRetrievability({ ...base, taughtAt: 0 }, 10 * DAY)
    ).toBeCloseTo(FSRS_TARGET_RETENTION, 5);
  });

  it('elapsed runs from the LAST review attempt when one exists', () => {
    const state = { stability: 10, taughtAt: 0, lastAskedAt: 5 * DAY };
    expect(reviewRetrievability(state, 5 * DAY)).toBe(1);
    expect(reviewRetrievability(state, 15 * DAY)).toBeCloseTo(retentionProbability(10, 10), 5);
  });

  it('a negative clock (test skew) reads as zero elapsed, never more than 1', () => {
    expect(reviewRetrievability({ ...base, taughtAt: Date.now() + 1000 }, 0)).toBe(1);
  });
});

describe('L1a surprise-scaled scheduler shape (Phase 17.2/17.3)', () => {
  it('lapse keep = clamp(1 − R, 0.05, 0.5): crammed floor, on-time 0.1, overdue cap', () => {
    const keep = (r: number): number => Math.min(0.5, Math.max(0.05, 1 - r));
    expect(keep(1)).toBeCloseTo(0.05, 10); // crammed lapse — harshest
    expect(keep(FSRS_TARGET_RETENTION)).toBeCloseTo(0.1, 10); // on-time = today's mid-difficulty
    expect(keep(0.4)).toBeCloseTo(0.5, 10); // overdue — forgetting already happened
  });

  it('success gain: no bonus at/before the due date, up to double when overdue', () => {
    const bonus = (r: number): number => 1 + 1 * (1 - Math.min(r / FSRS_TARGET_RETENTION, 1));
    expect(bonus(1)).toBeCloseTo(1, 10); // crammed — no bonus
    expect(bonus(FSRS_TARGET_RETENTION)).toBeCloseTo(1, 10); // on-time — the classic gain
    expect(bonus(0.45)).toBeCloseTo(1.5, 10); // overdue rescue
    expect(bonus(0.0001)).toBeCloseTo(2, 3); // the ceiling
  });
});
