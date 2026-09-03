/**
 * Phase 24.3 gates — the read-only calibration ledger.
 *
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { CalibrationLedger } from './calibration';

describe('CalibrationLedger (W8 — measurement first, gating later)', () => {
  it('records bounded evidence and reports quantiles', () => {
    const ledger = new CalibrationLedger();
    for (let i = 0; i < 100; i += 1) ledger.record('quiz-recall', i / 100, i >= 50);
    const report = ledger.report('quiz-recall');
    expect(report.samples).toBe(100);
    expect(report.positives).toBe(50);
    expect(report.p50).toBeCloseTo(0.49, 1);
    expect(report.p10).toBeLessThan(report.p90!);
  });

  it('the separator sits between the classes — the measured replacement for a hand threshold', () => {
    const ledger = new CalibrationLedger();
    // Positives cluster at 0.8-1.0, negatives at 0.0-0.4: a clean gate.
    for (let i = 0; i < 40; i += 1) ledger.record('g', 0.8 + (i % 10) * 0.02, true);
    for (let i = 0; i < 40; i += 1) ledger.record('g', 0.0 + (i % 10) * 0.04, false);
    const report = ledger.report('g');
    expect(report.separator).not.toBeNull();
    expect(report.separator!).toBeGreaterThan(0.4);
    expect(report.separator!).toBeLessThan(0.85);
  });

  it('caps per-gate samples FIFO and round-trips through snapshot/restore', () => {
    const ledger = new CalibrationLedger();
    for (let i = 0; i < 700; i += 1) ledger.record('g', i / 700, true);
    expect(ledger.report('g').samples).toBe(500);

    const restored = new CalibrationLedger();
    restored.restore(ledger.snapshot());
    expect(restored.report('g').samples).toBe(500);
    expect(restored.quantile('g', 0.5)).toBeCloseTo(ledger.quantile('g', 0.5)!, 10);
  });

  it('unmeasured gates report empty, never throw', () => {
    const ledger = new CalibrationLedger();
    const report = ledger.report('never-seen');
    expect(report.samples).toBe(0);
    expect(report.p50).toBeNull();
    expect(report.separator).toBeNull();
    expect(ledger.quantile('never-seen', 0.5)).toBeNull();
  });
});
