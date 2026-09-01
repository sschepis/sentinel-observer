/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  retentionProbability,
  dueIntervalDays,
  applyRetentionDecay,
  FSRS_TARGET_RETENTION,
  FSRS_INITIAL_STABILITY,
  FSRS_CONSOLIDATED_STABILITY
} from './TeacherAgent';

describe('P9 FSRS retention model', () => {
  it('the curve starts at 1 and crosses the target retention at one stability', () => {
    expect(retentionProbability(1, 5, 0)).toBe(1);
    expect(retentionProbability(1, 5, 1)).toBeCloseTo(FSRS_TARGET_RETENTION, 5);
  });

  it('decays monotonically in time and recovers with stability', () => {
    expect(retentionProbability(10, 5, 20)).toBeLessThan(retentionProbability(10, 5, 10));
    expect(retentionProbability(30, 5, 10)).toBeGreaterThan(retentionProbability(1, 5, 10));
  });

  it('the due interval inverts the curve: R(interval) = target, and interval ≈ stability', () => {
    const interval = dueIntervalDays(10);
    expect(interval).toBeCloseTo(10, 5);
    expect(retentionProbability(10, 5, interval)).toBeCloseTo(FSRS_TARGET_RETENTION, 5);
    expect(dueIntervalDays(0)).toBe(0);
  });

  it('applyRetentionDecay sets strength to the prediction; non-word traces use the default curve', () => {
    const now = Date.now();
    const traces = [
      { id: 'word', lastAccessAt: now - 2 * 86400000, strength: 1 },
      { id: 'convo', lastAccessAt: now - 2 * 86400000, strength: 1 }
    ];
    applyRetentionDecay(traces, (id) => (id === 'word' ? { stability: 2, difficulty: 5 } : null), now);
    expect(traces[0].strength).toBeCloseTo(retentionProbability(2, 5, 2), 5);
    expect(traces[1].strength).toBeCloseTo(retentionProbability(7, 5, 2), 5);
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
