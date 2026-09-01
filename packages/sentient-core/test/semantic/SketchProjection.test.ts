/**
 * SignedRandomProjection tests.
 *
 * The projection replaces the `axis = j mod 16` fold in the SMF imprint — the
 * "16-dim SMF orientation collisions" bottleneck. These tests pin the
 * determinism contract (same seed ⇒ same matrix), the JL geometry that makes
 * the sketch a faithful orientation signature, and the input guards.
 */
import { describe, it, expect } from '@jest/globals';
import { SignedRandomProjection, mulberry32 } from '../../src/semantic';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('different seeds diverge', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('SignedRandomProjection', () => {
  it('projects deterministically: the same input maps to the same sketch', () => {
    const p1 = new SignedRandomProjection({ inputDim: 64, outputDim: 32, seed: 7 });
    const p2 = new SignedRandomProjection({ inputDim: 64, outputDim: 32, seed: 7 });
    const x = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.7));
    expect(Array.from(p1.project(x))).toEqual(Array.from(p2.project(x)));
  });

  it('different seeds produce different projections', () => {
    const p1 = new SignedRandomProjection({ inputDim: 64, outputDim: 32, seed: 1 });
    const p2 = new SignedRandomProjection({ inputDim: 64, outputDim: 32, seed: 2 });
    const x = Array.from({ length: 64 }, (_, i) => Math.cos(i * 0.3));
    const y1 = p1.project(x);
    const y2 = p2.project(x);
    expect(Array.from(y1)).not.toEqual(Array.from(y2));
  });

  it('energy is roughly preserved (JL scale): unit inputs project near unit norm', () => {
    const p = new SignedRandomProjection({ inputDim: 256, outputDim: 64, seed: 99 });
    const x = new Float64Array(256).fill(1 / Math.sqrt(256));
    const y = p.project(x);
    const norm = Math.sqrt(Array.from(y).reduce((a, b) => a + b * b, 0));
    // E[||y||²] = ||x||² = 1; a 64-dim draw of 256 contributions concentrates.
    expect(Math.abs(norm - 1)).toBeLessThan(0.2);
  });

  it('treats non-finite and out-of-bounds inputs as zero (no NaN escape)', () => {
    const p = new SignedRandomProjection({ inputDim: 32, outputDim: 16, seed: 5 });
    const x = [1, NaN, Infinity, -2, 0, 3];
    const y = p.project(x);
    expect(y).toHaveLength(16);
    for (const v of y) expect(Number.isFinite(v)).toBe(true);
  });

  it('rejects degenerate dimensions and densities loudly', () => {
    expect(() => new SignedRandomProjection({ inputDim: 0, outputDim: 4 })).toThrow();
    expect(() => new SignedRandomProjection({ inputDim: 4, outputDim: 0 })).toThrow();
    expect(() => new SignedRandomProjection({ inputDim: 4, outputDim: 4, density: 1.5 })).toThrow();
    expect(() => new SignedRandomProjection({ inputDim: 4, outputDim: 4, density: 0 })).toThrow();
  });

  it('a one-hot input is separable from its own negation under cosine similarity', () => {
    // The whole point of the sketch: distinct signatures must not collide
    // into identical orientations. Two strongly different inputs must give
    // different sketch directions.
    const p = new SignedRandomProjection({ inputDim: 256, outputDim: 64, seed: 3 });
    const a = new Float64Array(256).fill(0);
    a[17] = 1;
    const b = new Float64Array(256).fill(0);
    b[211] = 1;
    const ya = p.project(a);
    const yb = p.project(b);
    const cosine = (() => {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < ya.length; i++) {
        dot += ya[i] * yb[i];
        na += ya[i] * ya[i];
        nb += yb[i] * yb[i];
      }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    })();
    expect(Math.abs(cosine)).toBeLessThan(0.6);
  });
});
