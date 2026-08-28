/**
 * PrimeOscillatorField tests.
 *
 * The legacy fallback returned a hardcoded orderParameter of 0.5 and a
 * hardcoded entropy of 0.5 from every readout. These tests prove the field
 * runs on the real Kuramoto model: finite metrics, a quiescent field reports
 * zero (not 0.5), and coherence actually evolves between ticks.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  ConfigurationLimitError,
  NotInitializedError,
  PrimeOscillatorField,
  SemanticKernel
} from '../../src/semantic';
import { freshKernel } from './helpers';

describe('PrimeOscillatorField', () => {
  let kernel: SemanticKernel;
  let field: PrimeOscillatorField;

  beforeAll(async () => {
    kernel = await freshKernel();
    field = new PrimeOscillatorField({ primeCount: 16, kernel });
    await field.initialize();
  });

  it('initializes with a real prime basis', () => {
    expect(field.size).toBe(16);
    expect(field.primes).toEqual([2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53]);
    expect(field.indexOfPrime(5)).toBe(2);
    expect(field.indexOfPrime(4)).toBe(-1);
  });

  it('reports zero metrics for a quiescent field (never the legacy 0.5)', () => {
    const metrics = field.tick();
    expect(metrics.coherence).toBe(0);
    expect(metrics.entropy).toBe(0);
    expect(metrics.orderParameter).toBe(0);
  });

  it('excites only primes inside the basis', () => {
    expect(field.excite([2, 3, 5, 4, 97], 0.5)).toBe(3);
    expect(field.excite([], 0.5)).toBe(0);
    expect(field.excite([97], 0.5)).toBe(0);
  });

  it('produces finite, real, bounded metrics after excitation', () => {
    const metrics = field.tick(0.016);
    expect(Number.isFinite(metrics.coherence)).toBe(true);
    expect(Number.isFinite(metrics.entropy)).toBe(true);
    expect(Number.isFinite(metrics.orderParameter)).toBe(true);
    expect(metrics.coherence).toBeGreaterThanOrEqual(0);
    expect(metrics.coherence).toBeLessThanOrEqual(1);
    expect(metrics.orderParameter).toBeGreaterThanOrEqual(0);
    expect(metrics.orderParameter).toBeLessThanOrEqual(1);
    expect(metrics.entropy).toBeGreaterThanOrEqual(0);
    expect(metrics.entropy).toBeLessThanOrEqual(Math.log2(16));
  });

  it('order parameter is NOT the legacy hardcoded 0.5', () => {
    // A handful of low-amplitude oscillators cannot produce r = 0.5 under the
    // real Kuramoto formula |Σ a e^{iφ}| / N with a_k ≤ 0.5 and N = 16:
    // r ≤ (3·0.5)/16 = 0.09375. The legacy stub returned 0.5 unconditionally.
    const metrics = field.tick(0.016);
    expect(metrics.orderParameter).not.toBe(0.5);
    expect(metrics.orderParameter).toBeLessThan(0.094);
  });

  it('coherence is NOT constant across ticks', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 8; i++) {
      seen.add(field.tick(0.016).coherence);
    }
    // Phase synchronization makes coherence change every tick. If the engine
    // were stubbed to a constant this set would have a single member.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('decay drives amplitudes and order parameter down over time', () => {
    const first = field.tick(0.016);
    for (let i = 0; i < 60; i++) field.tick(0.05);
    const later = field.tick(0.016);
    expect(later.orderParameter).toBeLessThan(first.orderParameter);
  });

  it('reset restores the quiescent state', () => {
    field.reset();
    const state = field.getState();
    expect(state.totalAmplitude).toBe(0);
    expect(state.activePrimes).toEqual([]);
    const metrics = field.tick();
    expect(metrics.coherence).toBe(0);
    expect(metrics.orderParameter).toBe(0);
  });

  it('getState exposes consistent amplitude/phase vectors', () => {
    field.excite([2, 5, 11], 0.4);
    field.tick(0.016);
    const state = field.getState();
    expect(state.amplitudes).toHaveLength(16);
    expect(state.phases).toHaveLength(16);
    expect(state.activePrimes.length).toBeGreaterThan(0);
    expect(Number.isFinite(state.normalizedEntropy)).toBe(true);
    expect(Number.isFinite(state.totalAmplitude)).toBe(true);
    expect(state.amplitudes.every(Number.isFinite)).toBe(true);
    expect(state.phases.every(Number.isFinite)).toBe(true);
  });

  it('rejects non-positive dt', () => {
    expect(() => field.tick(0)).toThrow();
    expect(() => field.tick(-1)).toThrow();
    expect(() => field.tick(NaN)).toThrow();
  });

  it('getMetrics before initialization throws instead of fabricating zeros', () => {
    const uninitialized = new PrimeOscillatorField({ primeCount: 16, kernel });
    expect(() => uninitialized.getMetrics()).toThrow(NotInitializedError);
  });

  it('caps primeCount at construction with a typed error', () => {
    expect(() => new PrimeOscillatorField({ primeCount: 257 })).toThrow(ConfigurationLimitError);
    expect(() => new PrimeOscillatorField({ primeCount: 1e7 })).toThrow(ConfigurationLimitError);
    // At the cap is fine (construction only - initialize is not required).
    expect(new PrimeOscillatorField({ primeCount: 256 }).size).toBe(256);
  });
});
