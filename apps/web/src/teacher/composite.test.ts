/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { spearman } from './composite';

describe('spearman', () => {
  it('returns zero when either series is constant', () => {
    expect(spearman([0, 1, 2, 3], [0.5, 0.5, 0.5, 0.5])).toBe(0);
    expect(spearman([1, 1, 1, 1], [0, 1, 2, 3])).toBe(0);
  });

  it('uses average ranks for ties', () => {
    expect(spearman([1, 1, 2, 2], [10, 10, 20, 20])).toBeCloseTo(1);
    expect(spearman([1, 1, 2, 2], [20, 20, 10, 10])).toBeCloseTo(-1);
  });

  it('preserves ordinary monotonic rank correlation', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1);
  });
});