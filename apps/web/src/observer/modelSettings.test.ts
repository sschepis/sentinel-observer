/**
 * @jest-environment jsdom
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  DEFAULT_MODEL_SETTINGS,
  MODEL_SETTING_BOUNDS,
  normalizeModelSettings,
  loadModelSettings,
  saveModelSettings,
  dueHorizonsFor
} from './modelSettings';
import { applyRetentionDecay, retentionProbability } from '../teacher/TeacherAgent';

describe('model settings', () => {
  beforeEach(() => localStorage.clear());

  it('starts at the measured defaults', () => {
    expect(loadModelSettings()).toEqual(DEFAULT_MODEL_SETTINGS);
  });

  it('round-trips through storage', () => {
    saveModelSettings({ ...DEFAULT_MODEL_SETTINGS, forgettingRate: 2, wordsPerCycle: 7 });
    const loaded = loadModelSettings();
    expect(loaded.forgettingRate).toBe(2);
    expect(loaded.wordsPerCycle).toBe(7);
  });

  it('clamps values that would break the loop', () => {
    const settings = normalizeModelSettings({
      forgettingRate: 1000,
      reviewThreshold: -5,
      wordsPerCycle: 9999,
      cyclePauseMs: -1
    });
    expect(settings.forgettingRate).toBe(MODEL_SETTING_BOUNDS.forgettingRate.max);
    expect(settings.reviewThreshold).toBe(MODEL_SETTING_BOUNDS.reviewThreshold.min);
    expect(settings.wordsPerCycle).toBe(MODEL_SETTING_BOUNDS.wordsPerCycle.max);
    expect(settings.cyclePauseMs).toBe(MODEL_SETTING_BOUNDS.cyclePauseMs.min);
  });

  it('keeps count-valued knobs integral', () => {
    const settings = normalizeModelSettings({ wordsPerCycle: 3.7, reviewsPerCycle: 1.2 });
    expect(Number.isInteger(settings.wordsPerCycle)).toBe(true);
    expect(Number.isInteger(settings.reviewsPerCycle)).toBe(true);
  });

  it('degrades corrupt storage to defaults instead of throwing', () => {
    localStorage.setItem('sentinel.model.settings.v1', '{not json');
    expect(loadModelSettings()).toEqual(DEFAULT_MODEL_SETTINGS);
  });

  it('ignores non-numeric values', () => {
    const settings = normalizeModelSettings({ forgettingRate: 'slow', reviewThreshold: null });
    expect(settings.forgettingRate).toBe(DEFAULT_MODEL_SETTINGS.forgettingRate);
    expect(settings.reviewThreshold).toBe(DEFAULT_MODEL_SETTINGS.reviewThreshold);
  });

  it('reports the due horizons a rate produces (FSRS: interval ≈ stability × rate)', () => {
    expect(dueHorizonsFor(1)).toEqual({ fresh: 1, practised: 5, consolidated: 30 });
    expect(dueHorizonsFor(2)).toEqual({ fresh: 2, practised: 10, consolidated: 60 });
  });
});

describe('the forgetting rate actually changes forgetting (L3: the one FSRS law)', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const traceAt = (): { id: string; lastAccessAt: number; strength: number } => ({
    id: 'w',
    lastAccessAt: 0,
    strength: 1
  });
  const params = (stability: number) => () => ({ stability, difficulty: 5 });

  it('sets strength to the model prediction after a week idle (fresh word, S = 1)', () => {
    const trace = traceAt();
    applyRetentionDecay([trace], params(1), WEEK, 1);
    expect(trace.strength).toBeCloseTo(retentionProbability(1, 7), 5);
    expect(trace.strength).toBeLessThan(0.7); // R(1, 7) ≈ 0.615 — past due
  });

  it('forgets more slowly at a higher rate (rate scales stability)', () => {
    const fast = traceAt();
    const slow = traceAt();
    applyRetentionDecay([fast], params(1), WEEK, 1);
    applyRetentionDecay([slow], params(1), WEEK, 2);
    expect(slow.strength).toBeGreaterThan(fast.strength);
    expect(slow.strength).toBeCloseTo(retentionProbability(2, 7), 5);
  });

  it('forgets faster at a lower rate', () => {
    const trace = traceAt();
    applyRetentionDecay([trace], params(1), WEEK, 0.5);
    expect(trace.strength).toBeCloseTo(retentionProbability(0.5, 7), 5);
  });

  it('protects consolidated memories regardless of rate (stability carries the protection)', () => {
    const consolidated = traceAt();
    const fresh = traceAt();
    applyRetentionDecay([consolidated], params(30), WEEK, 1);
    applyRetentionDecay([fresh], params(1), WEEK, 1);
    expect(consolidated.strength).toBeGreaterThan(fresh.strength);
    expect(consolidated.strength).toBeGreaterThan(0.9);
  });

  it('barely forgets over a sub-minute gap', () => {
    const trace = { id: 'w', lastAccessAt: Date.now() - 30 * 1000, strength: 1 };
    applyRetentionDecay([trace], params(1), Date.now(), 0.25);
    expect(trace.strength).toBeGreaterThan(0.999);
  });

  it('treats a nonsensical rate as the fastest allowed, not as division by zero', () => {
    const trace = traceAt();
    applyRetentionDecay([trace], params(1), WEEK, 0);
    expect(Number.isFinite(trace.strength)).toBe(true);
    expect(trace.strength).toBeLessThan(1);
    expect(trace.strength).toBeGreaterThan(0);
  });
});
