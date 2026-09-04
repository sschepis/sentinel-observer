/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  CDE_TOP_K_KS,
  candidateDistribution,
  classifyRegime,
  normalizedEntropy,
  readCde,
  topKEntropy,
  topTwoMargin,
  topTwoThreeMargin
} from './cde';

describe('candidateDistribution', () => {
  it('normalizes non-negative scores to a distribution summing to 1', () => {
    const p = candidateDistribution([1, 1, 2]);
    expect(p[0]).toBeCloseTo(0.25);
    expect(p[1]).toBeCloseTo(0.25);
    expect(p[2]).toBeCloseTo(0.5);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it('floors negative and non-finite scores to 0', () => {
    const p = candidateDistribution([1, -1, Number.NaN, 1]);
    expect(p[0]).toBeCloseTo(0.5);
    expect(p[1]).toBe(0);
    expect(p[2]).toBe(0);
    expect(p[3]).toBeCloseTo(0.5);
  });

  it('returns a zero distribution for an all-zero score list', () => {
    const p = candidateDistribution([0, 0, 0]);
    expect(p).toEqual([0, 0, 0]);
  });

  it('returns an empty distribution for no candidates', () => {
    expect(candidateDistribution([])).toEqual([]);
  });
});

describe('normalizedEntropy', () => {
  it('is 0 for a single candidate (fully concentrated)', () => {
    expect(normalizedEntropy([0.9])).toBe(0);
  });

  it('is 0 for no candidates', () => {
    expect(normalizedEntropy([])).toBe(0);
  });

  it('is 1 when every candidate ties (max uncertainty)', () => {
    expect(normalizedEntropy([1, 1, 1, 1])).toBeCloseTo(1);
  });

  it('is k-normalized: a uniform distribution reads 1 regardless of k', () => {
    expect(normalizedEntropy([1, 1, 1, 1, 1, 1, 1, 1])).toBeCloseTo(1);
  });

  it('separates a dominant candidate from a near-tie', () => {
    // p = [0.9, 0.1] over 2 candidates: H̃ ≈ 0.469.
    expect(normalizedEntropy([0.9, 0.1])).toBeCloseTo(0.469, 2);
    // p = [0.51, 0.49]: H̃ ≈ 0.999.
    expect(normalizedEntropy([0.51, 0.49])).toBeCloseTo(1, 2);
  });
});

describe('topKEntropy', () => {
  it('reads the retained top-k slice, renormalized', () => {
    // Top two hold the mass: H̃₂ over [0.8, 0.4] renormalized = [2/3, 1/3].
    const h2 = topKEntropy([0.8, 0.4, 0.001, 0.001, 0.001, 0.001], 2);
    expect(h2).toBeCloseTo(normalizedEntropy([0.8, 0.4]));
  });

  it('equals the full-set H̃ when the list is no longer than k', () => {
    const scores = [0.9, 0.08, 0.02];
    expect(topKEntropy(scores, 3)).toBeCloseTo(normalizedEntropy(scores));
    expect(topKEntropy(scores, 8)).toBeCloseTo(normalizedEntropy(scores));
  });

  it('is 0 with fewer than two candidates', () => {
    expect(topKEntropy([0.8], 2)).toBe(0);
    expect(topKEntropy([], 2)).toBe(0);
  });

  it('separates a dominant head from a flat head on a long tail', () => {
    // Full-set H̃ saturates near 1 for both (the tail carries the mass, as the
    // bench's k≈100–750 recall lists do), but the top-5 shape differs: one
    // dominant candidate vs. five tied ones.
    const tail = new Array<number>(500).fill(0.02);
    const dominantFull = normalizedEntropy([0.9, 0.5, 0.2, 0.1, 0.05, ...tail]);
    const dominant = topKEntropy([0.9, 0.5, 0.2, 0.1, 0.05, ...tail], 5);
    const flat = topKEntropy([0.9, 0.9, 0.9, 0.9, 0.9, ...tail], 5);
    expect(dominantFull).toBeGreaterThan(0.9); // the full-set reading saturates
    expect(flat).toBeCloseTo(1);
    expect(dominant).toBeLessThan(flat); // the retained top-5 separates
  });

  it('covers every supported slice size', () => {
    expect(CDE_TOP_K_KS).toEqual([2, 3, 5, 8]);
    for (const k of CDE_TOP_K_KS) expect(Number.isFinite(topKEntropy([0.9, 0.5, 0.2, 0.1, 0.05, 0.01, 0.01, 0.01], k))).toBe(true);
  });
});

describe('topTwoMargin', () => {
  it('is (s1 - s2)/s1', () => {
    expect(topTwoMargin([0.8, 0.4, 0.3])).toBeCloseTo(0.5);
  });

  it('is 1 when the runner-up scores nothing', () => {
    expect(topTwoMargin([0.8, 0])).toBeCloseTo(1);
  });

  it('is 0 on an exact top-two tie', () => {
    expect(topTwoMargin([0.5, 0.5])).toBeCloseTo(0);
  });

  it('is 0 with fewer than two candidates', () => {
    expect(topTwoMargin([0.8])).toBe(0);
    expect(topTwoMargin([])).toBe(0);
  });
});

describe('topTwoThreeMargin', () => {
  it('is (s2 - s3)/s2', () => {
    expect(topTwoThreeMargin([0.9, 0.8, 0.4])).toBeCloseTo(0.5);
  });

  it('is 0 with fewer than three candidates', () => {
    expect(topTwoThreeMargin([0.9, 0.8])).toBe(0);
    expect(topTwoThreeMargin([0.9])).toBe(0);
  });
});

describe('classifyRegime', () => {
  it('a single dominant candidate is clear', () => {
    expect(classifyRegime([0.9, 0.1])).toBe('clear');
  });

  it('a lone candidate is clear', () => {
    expect(classifyRegime([0.7])).toBe('clear');
  });

  it('no candidates is flat', () => {
    expect(classifyRegime([])).toBe('flat');
  });

  it('two dominant candidates separated from a tail is disambiguate', () => {
    // m = (0.5 − 0.45)/0.5 = 0.1 (tied) and m23 = (0.45 − 0.025)/0.45 ≈ 0.94.
    expect(classifyRegime([0.5, 0.45, 0.025, 0.025])).toBe('disambiguate');
  });

  it('a broad near-tie across many candidates is flat', () => {
    expect(classifyRegime([0.3, 0.3, 0.25, 0.15])).toBe('flat');
  });

  it('documents the k-normalization subtlety: two tied candidates among a large field read low H̃', () => {
    // Two tied winners among 1,200 recall prefilter candidates: H̃ ≈
    // log₂2 / log₂1200 ≈ 0.10 — low, despite the top two being tied. The
    // regime (driven by margins) must NOT rely on H̃ for this case.
    const manyTinyTail = [0.5, 0.5, ...new Array(1198).fill(1e-6)];
    expect(normalizedEntropy(manyTinyTail)).toBeLessThan(0.2);
    expect(classifyRegime(manyTinyTail)).toBe('disambiguate');
  });
});

describe('readCde', () => {
  it('bundles entropy, margins, k, and regime into one reading', () => {
    const reading = readCde([0.9, 0.08, 0.02]);
    expect(reading.k).toBe(3);
    expect(reading.entropy).toBeCloseTo(normalizedEntropy([0.9, 0.08, 0.02]));
    expect(reading.topTwoMargin).toBeCloseTo(topTwoMargin([0.9, 0.08, 0.02]));
    expect(reading.topTwoThreeMargin).toBeCloseTo(topTwoThreeMargin([0.9, 0.08, 0.02]));
    expect(reading.regime).toBe('clear');
  });

  it('carries H̃_k over every retained slice', () => {
    const reading = readCde([0.9, 0.08, 0.02]);
    for (const k of CDE_TOP_K_KS) {
      expect(reading.topKEntropy[k]).toBeCloseTo(topKEntropy([0.9, 0.08, 0.02], k));
    }
  });
});
