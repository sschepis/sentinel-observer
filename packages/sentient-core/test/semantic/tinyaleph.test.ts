/**
 * Tinyaleph loader tests.
 *
 * The #1 review finding: the legacy code never actually loaded
 * @aleph-ai/tinyaleph (synchronous require + getter destructuring defeated the
 * lazy import), so every metric silently came from stubs. These tests prove
 * the real ESM library loads and computes real values.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  SemanticKernel,
  describeTinyalephStatus,
  isTinyalephLoaded,
  loadTinyaleph,
  shannonEntropyBits
} from '../../src/semantic';
import { freshKernel } from './helpers';

describe('tinyaleph loader', () => {
  let kernel: SemanticKernel;

  beforeAll(async () => {
    kernel = await freshKernel();
  });

  it('loads the real ESM library through the async loader', async () => {
    const module = await loadTinyaleph();
    expect(isTinyalephLoaded()).toBe(true);
    expect(module).toBeDefined();
    expect(typeof module.firstNPrimes).toBe('function');
    expect(typeof module.KuramotoModel).toBe('function');
    expect(typeof module.Hypercomplex).toBe('function');
    expect(typeof module.SemanticBackend).toBe('function');
    expect(typeof module.createEngine).toBe('function');
    expect(module.DEFAULT_PRIMES.length).toBeGreaterThan(0);
  });

  it('reports a healthy loader status', () => {
    const status = describeTinyalephStatus();
    expect(status.loaded).toBe(true);
    expect(status.degraded).toBe(false);
    expect(status.error).toBeNull();
  });

  it('memoizes a single module instance', async () => {
    const [a, b] = await Promise.all([loadTinyaleph(), loadTinyaleph()]);
    expect(a).toBe(b);
  });

  it('exposes real prime utilities (no stubbed constants)', () => {
    expect(kernel.firstNPrimes(5)).toEqual([2, 3, 5, 7, 11]);
    expect(kernel.nthPrime(6)).toBe(13);
    expect(kernel.primesUpTo(10)).toEqual([2, 3, 5, 7]);
    expect(kernel.isPrime(17)).toBe(true);
    expect(kernel.isPrime(18)).toBe(false);
    // Runtime-verified API: prime -> exponent record (the shipped d.ts claims
    // number[] but the implementation returns a factorization map).
    expect(kernel.factorize(12)).toEqual({ 2: 2, 3: 1 });
    expect(kernel.factorize(360)).toEqual({ 2: 3, 3: 2, 5: 1 });
  });

  it('passes the loader behavioral probes (validation is not typeof-only)', async () => {
    // These are the probes the loader runs on every load. A module whose
    // exports merely EXIST but behave like stubs is rejected (see
    // tinyalephSeam.test.ts for the rejection paths); the real module passes.
    expect(kernel.firstNPrimes(5)).toHaveLength(5);
    const state = kernel.createHypercomplex(16);
    expect(state).toBeDefined();
    expect(kernel.shannonEntropy([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(2, 10);
  });

  it('computes real Shannon entropy', () => {
    // Uniform distribution over 4 outcomes: exactly 2 bits.
    expect(kernel.shannonEntropy([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(2, 10);
    // Deterministic distribution: exactly 0 bits.
    expect(kernel.shannonEntropy([1, 0, 0])).toBeCloseTo(0, 10);
    // Our local implementation agrees bit-for-bit (same p > 1e-10 guard).
    const distribution = [0.1, 0.2, 0.3, 0.4];
    expect(shannonEntropyBits(distribution)).toBeCloseTo(kernel.shannonEntropy(distribution), 12);
  });

  it('creates working hypercomplex states', () => {
    const state = kernel.createHypercomplex(16);
    expect(state.dim).toBe(16);
    expect(state.c.length).toBe(16);
    const fromArray = kernel.hypercomplexFromArray([3, 4]);
    expect(fromArray.norm()).toBeCloseTo(5, 12);
    expect(fromArray.normalize().norm()).toBeCloseTo(1, 12);
  });

  it('classifies stability and lyapunov estimates deterministically', () => {
    // Runtime-verified 1.8.2 classes: λ < 0 -> 'stable', 0 <= λ < 0.5 ->
    // 'marginal', λ >= 0.5 -> 'chaotic'.
    expect(kernel.classifyStability(-0.5)).toBe('stable');
    expect(kernel.classifyStability(-0.05)).toBe('stable');
    expect(kernel.classifyStability(0.01)).toBe('marginal');
    expect(kernel.classifyStability(0.6)).toBe('chaotic');
    const series = Array.from({ length: 64 }, (_, i) => Math.sin(i / 3) * 0.5);
    const lambda = kernel.estimateLyapunov(series);
    expect(Number.isFinite(lambda)).toBe(true);
  });
});
