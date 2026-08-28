/**
 * Numeric guard tests.
 *
 * The review found `clampRange` fabricating metrics by turning NaN into the
 * range minimum, and unguarded dot products overflowing to Infinity/NaN for
 * huge (but finite) inputs. These tests pin the fail-loud contract and the
 * overflow/underflow-safe geometry helper.
 */
import { describe, it, expect } from '@jest/globals';
import {
  NonFiniteValueError,
  clampRange,
  normalizedEntropy,
  shannonEntropyBits,
  stableCosineSimilarity,
  toDistribution
} from '../../src/semantic';

describe('numeric guards', () => {
  it('clampRange throws NonFiniteValueError instead of fabricating the range minimum', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => clampRange(bad, 0, 1)).toThrow(NonFiniteValueError);
    }
    expect(clampRange(0.5, 0, 1)).toBe(0.5);
    expect(clampRange(-1, 0, 1)).toBe(0);
    expect(clampRange(2, 0, 1)).toBe(1);
  });

  it('stableCosineSimilarity: self-similarity of huge finite vectors is exactly 1', () => {
    const huge = new Array(16).fill(1e200);
    expect(stableCosineSimilarity(huge, huge)).toBeCloseTo(1, 10);
  });

  it('stableCosineSimilarity: tiny finite vectors do not underflow to 0', () => {
    const tiny = new Array(16).fill(1e-200);
    expect(stableCosineSimilarity(tiny, tiny)).toBeCloseTo(1, 10);
  });

  it('stableCosineSimilarity scores a zero vector as 0 and anti-aligned vectors as -1', () => {
    const zero = new Array(16).fill(0);
    const unit = new Array(16).fill(1);
    expect(stableCosineSimilarity(zero, unit)).toBe(0);
    expect(stableCosineSimilarity(unit, unit.map(v => -v))).toBeCloseTo(-1, 10);
  });

  it('stableCosineSimilarity rejects non-finite components loudly', () => {
    expect(() => stableCosineSimilarity([NaN, 1], [1, 1])).toThrow(NonFiniteValueError);
    expect(() => stableCosineSimilarity([1, 1], [1, Infinity])).toThrow(NonFiniteValueError);
  });

  it('normalizedEntropy is the exact normalization of shannonEntropyBits over the same distribution', () => {
    const distribution = toDistribution([1, 2, 3, 4]);
    const h = shannonEntropyBits(distribution);
    expect(normalizedEntropy(distribution)).toBeCloseTo(h / Math.log2(distribution.length), 12);
    // A deterministic distribution has 0 entropy, normalized or not.
    expect(normalizedEntropy([1, 0, 0, 0])).toBe(0);
  });
});
