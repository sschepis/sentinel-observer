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
  halfLivesFor
} from './modelSettings';
import { applyTimeDecay } from '../teacher/TeacherAgent';

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

  it('reports the half-lives a rate produces', () => {
    expect(halfLivesFor(1)).toEqual({ fresh: 7, practised: 30, consolidated: 120 });
    expect(halfLivesFor(2)).toEqual({ fresh: 14, practised: 60, consolidated: 240 });
  });
});

describe('the forgetting rate actually changes forgetting', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const traceAt = (strength: number) => ({
    lastAccessAt: 0,
    strength,
    accessCount: 0,
    consolidated: false
  });

  it('halves an unpractised memory over its half-life at the default rate', () => {
    const trace = traceAt(1);
    applyTimeDecay([trace], WEEK, 1);
    expect(trace.strength).toBeCloseTo(0.5, 5);
  });

  it('forgets more slowly at a higher rate', () => {
    const fast = traceAt(1);
    const slow = traceAt(1);
    applyTimeDecay([fast], WEEK, 1);
    applyTimeDecay([slow], WEEK, 2);
    expect(slow.strength).toBeGreaterThan(fast.strength);
    expect(slow.strength).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('forgets faster at a lower rate', () => {
    const trace = traceAt(1);
    applyTimeDecay([trace], WEEK, 0.5);
    expect(trace.strength).toBeCloseTo(0.25, 5);
  });

  it('protects consolidated memories regardless of rate', () => {
    const consolidated = { lastAccessAt: 0, strength: 1, accessCount: 5, consolidated: true };
    const fresh = traceAt(1);
    applyTimeDecay([consolidated], WEEK, 1);
    applyTimeDecay([fresh], WEEK, 1);
    expect(consolidated.strength).toBeGreaterThan(fresh.strength);
  });

  it('never forgets anything over a sub-minute gap', () => {
    const trace = traceAt(1);
    applyTimeDecay([trace], 30 * 1000, 0.25);
    expect(trace.strength).toBe(1);
  });

  it('treats a nonsensical rate as the fastest allowed, not as division by zero', () => {
    const trace = traceAt(1);
    applyTimeDecay([trace], WEEK, 0);
    expect(Number.isFinite(trace.strength)).toBe(true);
    expect(trace.strength).toBeLessThan(1);
  });
});
