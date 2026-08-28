/**
 * SedenionMemoryField tests.
 *
 * The legacy fallback stubbed entropy to 0 and dominantAxes to [] (empty
 * bodies). These tests prove the 16-axis field is a real implementation:
 * real Shannon entropy, ranked axes, guarded normalization and round-trip
 * serialization.
 */
import { describe, it, expect } from '@jest/globals';
import {
  NonFiniteValueError,
  SedenionMemoryField,
  SMF_DIMENSION,
  UnknownSMFAxisError,
  shannonEntropyBits,
  toDistribution
} from '../../src/semantic';
import { SMF_AXES, type SMFAxisIndex } from '../../src/common/types';

describe('SedenionMemoryField', () => {
  it('uses the canonical SMF_AXES metadata (no second axis list)', () => {
    expect(SMF_DIMENSION).toBe(16);
    for (let i = 0; i < 16; i++) {
      expect(SedenionMemoryField.axisInfo(i as SMFAxisIndex)).toBe(SMF_AXES[i as SMFAxisIndex]);
    }
    expect(SedenionMemoryField.axisNames()).toEqual(
      Object.values(SMF_AXES).map(axis => axis.name)
    );
  });

  it('defaults to the scalar-identity orientation', () => {
    const field = new SedenionMemoryField();
    expect(field.get(0)).toBe(1);
    expect(field.norm()).toBe(1);
    for (let i = 1; i < 16; i++) expect(field.get(i)).toBe(0);
  });

  it('get/set accept axis names and indices', () => {
    const field = SedenionMemoryField.zero();
    field.set('visual_salience', 0.5);
    field.set(7, 2.25); // relevance
    expect(field.get('visual_salience')).toBe(0.5);
    expect(field.get(0)).toBe(0.5);
    expect(field.get('relevance')).toBe(2.25);
    expect(field.get(7)).toBe(2.25);
    field.add(7, -0.25);
    expect(field.get('relevance')).toBe(2);
  });

  it('rejects unknown axis names and out-of-range indices loudly', () => {
    const field = SedenionMemoryField.zero();
    expect(() => field.get('not_an_axis')).toThrow(UnknownSMFAxisError);
    expect(() => field.set(16, 1)).toThrow(UnknownSMFAxisError);
    expect(() => field.set(-1, 1)).toThrow(UnknownSMFAxisError);
    expect(() => field.get(3.5)).toThrow(UnknownSMFAxisError);
  });

  it('computes norms, energy and normalization correctly', () => {
    const field = SedenionMemoryField.fromArray([3, 4]);
    expect(field.norm()).toBeCloseTo(5, 12);
    expect(field.energy()).toBeCloseTo(25, 12);

    const normalized = field.clone();
    expect(normalized.normalize()).toBe(true);
    expect(normalized.norm()).toBeCloseTo(1, 12);
    expect(normalized.get(0)).toBeCloseTo(0.6, 12);
    expect(normalized.get(1)).toBeCloseTo(0.8, 12);

    // Normalizing a zero field must not fabricate a direction.
    const zero = SedenionMemoryField.zero();
    expect(zero.normalize()).toBe(false);
    expect(zero.norm()).toBe(0);
  });

  it('entropy is real Shannon entropy over normalized axis energies', () => {
    const zero = SedenionMemoryField.zero();
    expect(zero.entropy()).toBe(0);
    expect(zero.normalizedEntropy()).toBe(0);

    const identity = SedenionMemoryField.identity();
    expect(identity.entropy()).toBe(0);
    expect(identity.normalizedEntropy()).toBe(0);

    // Two equal axes: p = [0.5, 0.5] -> H = 1 bit exactly.
    const twoAxes = SedenionMemoryField.fromArray([1, 1]);
    expect(twoAxes.entropy()).toBeCloseTo(1, 12);
    expect(twoAxes.normalizedEntropy()).toBeCloseTo(1 / Math.log2(16), 12);

    // Cross-check the distribution directly.
    const distribution = twoAxes.energyDistribution();
    expect(distribution.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(shannonEntropyBits(distribution)).toBeCloseTo(1, 12);
  });

  it('entropy is monotonic under mixing (spread raises entropy)', () => {
    const concentrated = SedenionMemoryField.fromArray([2, 0]);
    const spread = SedenionMemoryField.fromArray([2, 1]);
    expect(spread.entropy()).toBeGreaterThan(concentrated.entropy());
  });

  it('dominantAxes ranks by absolute magnitude with correct shares', () => {
    const field = SedenionMemoryField.fromArray([1, -2, 0.5]);
    const top = field.dominantAxes(3);
    expect(top).toHaveLength(3);
    expect(top[0].index).toBe(1);
    expect(top[0].value).toBe(-2);
    expect(top[1].index).toBe(0);
    expect(top[2].index).toBe(2);
    expect(top[0].energyShare).toBeCloseTo(4 / (1 + 4 + 0.25), 12);

    const shares = field.dominantAxes(16).map(a => a.energyShare);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);

    expect(field.dominantAxes(0)).toEqual([]);
  });

  it('updateFromPrimeActivity imprints real oscillator activity', () => {
    const field = SedenionMemoryField.zero();
    const sample = {
      primes: [2, 3, 5],
      phases: [0, 0, 0],
      amplitudes: [0.5, 0.25, 0.125],
      coherence: 0.95
    };
    const rate = field.updateFromPrimeActivity(sample);
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThanOrEqual(1);

    // Zero phases: each excited axis picks up positive amplitude.
    expect(field.get(0)).toBeGreaterThan(0);
    expect(field.get(1)).toBeGreaterThan(0);
    expect(field.get(2)).toBeGreaterThan(0);
    expect(field.norm()).toBeGreaterThan(0);
    expect(field.toArray().every(Number.isFinite)).toBe(true);
  });

  it('updateFromPrimeActivity respects the learning rate bounds', () => {
    const field = SedenionMemoryField.zero();
    const sample = {
      primes: [2],
      phases: [0],
      amplitudes: [1],
      coherence: 0.9
    };
    const noOp = field.updateFromPrimeActivity(sample, { learningRate: 0 });
    expect(noOp).toBe(0);
    expect(field.norm()).toBe(0);
  });

  it('coherenceWith is cosine similarity', () => {
    const a = SedenionMemoryField.fromArray([1, 0]);
    const b = SedenionMemoryField.fromArray([0, 1]);
    const opposite = SedenionMemoryField.fromArray([-1, 0]);

    expect(a.coherenceWith(a)).toBeCloseTo(1, 12);
    expect(a.coherenceWith(b)).toBeCloseTo(0, 12);
    expect(a.coherenceWith(opposite)).toBeCloseTo(-1, 12);

    // Zero fields are incoherent with everything, not NaN.
    expect(SedenionMemoryField.zero().coherenceWith(a)).toBe(0);
  });

  it('coherenceWith is overflow-safe: self-similarity of a 1e200 field is 1', () => {
    // The naive cosine similarity overflows 1e200 * 1e200 to Infinity and
    // scored -1 (or 0). The scaled implementation must return exactly 1.
    const huge = SedenionMemoryField.fromArray(new Array(16).fill(1e200));
    expect(huge.coherenceWith(huge)).toBeCloseTo(1, 10);

    const tiny = SedenionMemoryField.fromArray(new Array(16).fill(1e-200));
    expect(tiny.coherenceWith(tiny)).toBeCloseTo(1, 10);
  });

  it('decay scales the field and is bounded to [0, 1]', () => {
    const field = SedenionMemoryField.fromArray([1, 1]);
    field.decay(0.5);
    expect(field.get(0)).toBeCloseTo(0.5, 12);
    field.decay(2); // clamped to rate 1 -> zeroed
    expect(field.norm()).toBe(0);
  });

  it('clone is independent', () => {
    const field = SedenionMemoryField.fromArray([1, 2]);
    const copy = field.clone();
    copy.set(0, 99);
    expect(field.get(0)).toBe(1);
    expect(copy.get(0)).toBe(99);
  });

  it('toJSON/fromJSON round-trips and rejects malformed payloads', () => {
    const field = SedenionMemoryField.fromArray([1, -2, 0.5, 3]);
    const restored = SedenionMemoryField.fromJSON(field.toJSON());
    expect(restored.toArray()).toEqual(field.toArray());

    expect(() => SedenionMemoryField.fromJSON({ version: 2, components: field.toArray() } as never)).toThrow();
    expect(() => SedenionMemoryField.fromJSON({ version: 1, components: [1, 2] } as never)).toThrow();
  });

  it('fromJSON rejects non-finite components instead of silently coercing NaN to 0', () => {
    const withNaN = new Array(16).fill(0);
    withNaN[3] = NaN;
    expect(() => SedenionMemoryField.fromJSON({ version: 1, components: withNaN })).toThrow(
      NonFiniteValueError
    );

    const withInfinity = new Array(16).fill(0);
    withInfinity[7] = Infinity;
    expect(() => SedenionMemoryField.fromJSON({ version: 1, components: withInfinity })).toThrow(
      NonFiniteValueError
    );
  });

  it('toRecord exposes named axes', () => {
    const field = SedenionMemoryField.zero().set('certainty', 0.75);
    expect(field.toRecord().certainty).toBe(0.75);
    expect(Object.keys(field.toRecord())).toHaveLength(16);
  });
});
