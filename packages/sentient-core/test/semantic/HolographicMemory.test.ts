/**
 * HolographicMemory tests - regression coverage for three legacy math bugs.
 *
 *   1. encode -> reconstruct must round-trip (legacy used a non-orthogonal
 *      golden-ratio / log-prime frequency set behind a textbook inverse-DFT
 *      kernel, so it never did).
 *   2. evolve() must not increase total field energy (legacy inverted the
 *      damping sign: `dampingFactor * (1 + lambda * intensity * 0.1)` damped
 *      high-intensity cells LESS and made the field grow without bound).
 *   3. similarity() must use phase (legacy correlated |H|^2 only, so a pattern
 *      and its phase-inverse scored identically).
 */
import { describe, it, expect } from '@jest/globals';
import {
  ConfigurationLimitError,
  HolographicMemory,
  NonFiniteValueError,
  type HolographicMemoryOptions
} from '../../src/semantic';

const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19];

function make(options: HolographicMemoryOptions = {}) {
  return new HolographicMemory({ gridSize: 32, primes: PRIMES, ...options });
}

/** Local trial-division prime list (the module under test must stay ESM-free). */
function firstPrimes(count: number): number[] {
  const primes: number[] = [];
  for (let candidate = 2; primes.length < count; candidate++) {
    let isPrime = true;
    for (let d = 2; d * d <= candidate; d++) {
      if (candidate % d === 0) {
        isPrime = false;
        break;
      }
    }
    if (isPrime) primes.push(candidate);
  }
  return primes;
}

describe('HolographicMemory', () => {
  // ═══════════════════════════════════════════════════════════════════════
  // BUG 2: ORTHOGONAL BASIS / ROUND-TRIP
  // ═══════════════════════════════════════════════════════════════════════

  it('uses distinct integer wavenumbers (an orthogonal basis)', () => {
    const memory = make();
    expect(memory.spatialFrequencies).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(memory.spatialFrequencies).size).toBe(PRIMES.length);
    expect(Math.max(...memory.spatialFrequencies)).toBeLessThan(memory.gridSize);
  });

  it('rejects a prime basis that would break orthogonality', () => {
    expect(() => new HolographicMemory({ gridSize: 8, primes: [2, 3, 5, 7, 11, 13, 17, 19] })).toThrow();
    expect(() => new HolographicMemory({ gridSize: 8, primes: [2, 2, 3] })).toThrow();
    expect(() => new HolographicMemory({ gridSize: 8, primes: [] })).toThrow();
  });

  it('encode -> reconstruct round-trips amplitudes within tolerance', () => {
    const memory = make();
    const amplitudes = [0.9, 0.1, 0.55, 0.33, 0.7, 0.05, 0.42, 0.61];

    expect(memory.encode(PRIMES, amplitudes)).toBe(PRIMES.length);
    const recovered = memory.reconstruct();

    expect(recovered.size).toBe(PRIMES.length);
    PRIMES.forEach((prime, i) => {
      const amp = recovered.get(prime);
      expect(amp).toBeDefined();
      expect(amp!.re).toBeCloseTo(amplitudes[i], 10);
      expect(amp!.im).toBeCloseTo(0, 10);
    });
  });

  it('encode -> reconstruct round-trips complex amplitudes (magnitude AND phase)', () => {
    const memory = make();
    const amplitudes = [1, 0.5, 0.25, 0.75, 0.6, 0.4, 0.2, 0.8];
    const phases = [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.3, 1.1, 2.4, -2.9];

    memory.encode(PRIMES, amplitudes, phases);

    const magnitudes = memory.reconstructMagnitudes();
    const recoveredPhases = memory.reconstructPhases();

    PRIMES.forEach((_, i) => {
      expect(magnitudes[i]).toBeCloseTo(amplitudes[i], 10);
      // Compare via unit vectors to avoid the +/-pi wrap.
      expect(Math.cos(recoveredPhases[i])).toBeCloseTo(Math.cos(phases[i]), 10);
      expect(Math.sin(recoveredPhases[i])).toBeCloseTo(Math.sin(phases[i]), 10);
    });
  });

  it('round-trips a sparse pattern without cross-talk between primes', () => {
    const memory = make();
    memory.encode([5], [1]);
    const recovered = memory.reconstruct();

    expect(recovered.get(5)!.re).toBeCloseTo(1, 10);
    for (const prime of PRIMES.filter(p => p !== 5)) {
      expect(Math.hypot(recovered.get(prime)!.re, recovered.get(prime)!.im)).toBeCloseTo(0, 10);
    }
  });

  it('satisfies Parseval: field energy = N * sum |a_i|^2', () => {
    const memory = make();
    const amplitudes = [0.5, 0.25, 0, 0, 0, 0, 0, 0];
    memory.encode(PRIMES, amplitudes);

    const expected = memory.gridSize * amplitudes.reduce((sum, a) => sum + a * a, 0);
    expect(memory.energy()).toBeCloseTo(expected, 8);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BUG 1: DAMPING SIGN / ENERGY INVARIANT
  // ═══════════════════════════════════════════════════════════════════════

  it('evolve does NOT increase total energy (inverted-sign regression)', () => {
    const memory = make({ lambda: 0.5, intensityDamping: 2 });
    memory.encode(PRIMES, [1, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05, 0.02]);

    let previous = memory.energy();
    expect(previous).toBeGreaterThan(0);

    for (let step = 0; step < 100; step++) {
      const result = memory.evolve(0.05);
      expect(result.energyAfter).toBeLessThanOrEqual(result.energyBefore);
      expect(result.energyAfter).toBeLessThanOrEqual(previous);
      expect(Number.isFinite(result.energyAfter)).toBe(true);
      previous = result.energyAfter;
    }

    // Bounded, decaying, and definitely not blowing up.
    expect(previous).toBeLessThan(memory.gridSize * 4);
  });

  it('evolve damps high-intensity cells MORE than low-intensity cells', () => {
    const memory = make({ lambda: 1, intensityDamping: 4 });
    // A single-prime plane wave has flat intensity, so superpose two to create
    // a real interference pattern with intensity contrast.
    memory.encode(PRIMES, [1, 0, 0, 0, 0, 0, 0, 0]);
    memory.superpose(PRIMES, [0, 0.8, 0, 0, 0, 0, 0, 0]);

    const before = memory.intensity();
    const result = memory.evolve(0.2);
    const after = memory.intensity();

    // Damping factors must all be <= 1 and the most intense cell must be
    // damped strictly harder than the least intense one.
    expect(result.maxDamping).toBeLessThanOrEqual(1);
    expect(result.minDamping).toBeLessThan(result.maxDamping);

    let hottest = 0;
    let coolest = 0;
    for (let n = 1; n < before.length; n++) {
      if (before[n] > before[hottest]) hottest = n;
      if (before[n] < before[coolest]) coolest = n;
    }
    const hotRatio = after[hottest] / before[hottest];
    const coolRatio = before[coolest] > 0 ? after[coolest] / before[coolest] : 1;
    expect(hotRatio).toBeLessThan(coolRatio);
  });

  it('evolve with lambda = 0 conserves energy exactly', () => {
    const memory = make({ lambda: 0 });
    memory.encode(PRIMES, [0.7, 0.3, 0, 0, 0, 0, 0, 0]);
    const before = memory.energy();
    const result = memory.evolve(0.5);
    expect(result.energyAfter).toBeCloseTo(before, 12);
    expect(result.minDamping).toBe(1);
    expect(result.maxDamping).toBe(1);
  });

  it('evolve on an empty field stays at zero energy', () => {
    const memory = make();
    const result = memory.evolve(0.1);
    expect(result.energyBefore).toBe(0);
    expect(result.energyAfter).toBe(0);
    expect(result.entropy).toBe(0);
  });

  it('evolve rejects non-positive dt', () => {
    const memory = make();
    expect(() => memory.evolve(0)).toThrow();
    expect(() => memory.evolve(-1)).toThrow();
    expect(() => memory.evolve(NaN)).toThrow();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BUG 3: PHASE-AWARE SIMILARITY
  // ═══════════════════════════════════════════════════════════════════════

  it('similarity is 1 for identical patterns', () => {
    const a = make();
    const b = make();
    const amplitudes = [0.5, 0.4, 0.3, 0.2, 0.1, 0, 0, 0];
    a.encode(PRIMES, amplitudes);
    b.encode(PRIMES, amplitudes);
    expect(a.similarity(b)).toBeCloseTo(1, 10);
  });

  it('similarity distinguishes a phase-inverted pattern (legacy scored 1.0)', () => {
    const a = make();
    const b = make();
    const amplitudes = [0.5, 0.4, 0.3, 0.2, 0.1, 0, 0, 0];
    const inverted = PRIMES.map(() => Math.PI);

    a.encode(PRIMES, amplitudes);
    b.encode(PRIMES, amplitudes, inverted);

    // Anti-phase: signed correlation is -1.
    expect(a.similarity(b)).toBeCloseTo(-1, 10);
    // ...while the phase-invariant magnitude stays 1, which is exactly the
    // quantity the legacy intensity-only correlate() was measuring.
    expect(a.correlation(b).magnitude).toBeCloseTo(1, 10);
  });

  it('similarity is 0 for a quarter-cycle phase shift', () => {
    const a = make();
    const b = make();
    const amplitudes = [0.6, 0.5, 0.4, 0, 0, 0, 0, 0];
    a.encode(PRIMES, amplitudes);
    b.encode(PRIMES, amplitudes, PRIMES.map(() => Math.PI / 2));

    expect(a.similarity(b)).toBeCloseTo(0, 10);
    expect(a.correlation(b).imag).toBeCloseTo(-1, 10);
    expect(a.correlation(b).magnitude).toBeCloseTo(1, 10);
  });

  it('similarity is 0 for orthogonal prime content', () => {
    const a = make();
    const b = make();
    a.encode([2, 3], [1, 1]);
    b.encode([11, 13], [1, 1]);
    expect(a.similarity(b)).toBeCloseTo(0, 10);
    expect(a.correlation(b).magnitude).toBeCloseTo(0, 10);
  });

  it('similarity against an empty field is 0, not NaN', () => {
    const a = make();
    const empty = make();
    a.encode(PRIMES, [1, 0, 0, 0, 0, 0, 0, 0]);
    expect(a.similarity(empty)).toBe(0);
    expect(Number.isFinite(a.similarity(empty))).toBe(true);
  });

  it('correlation is overflow-safe: identical huge patterns correlate at 1, not 0', () => {
    const a = make();
    const b = make();
    const amplitudes = new Array(PRIMES.length).fill(1e200);
    a.encode(PRIMES, amplitudes);
    b.encode(PRIMES, amplitudes);
    expect(a.similarity(b)).toBeCloseTo(1, 10);
    expect(a.correlation(b).magnitude).toBeCloseTo(1, 10);
  });

  it('correlation survives near-zero-amplitude identical patterns (no underflow to 0)', () => {
    const a = make();
    const b = make();
    const amplitudes = new Array(PRIMES.length).fill(1e-200);
    a.encode(PRIMES, amplitudes);
    b.encode(PRIMES, amplitudes);
    expect(a.similarity(b)).toBeCloseTo(1, 10);
  });

  it('similarity rejects mismatched grids', () => {
    const a = make();
    const b = new HolographicMemory({ gridSize: 64, primes: PRIMES });
    expect(() => a.similarity(b)).toThrow();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // READOUTS & SERIALIZATION
  // ═══════════════════════════════════════════════════════════════════════

  it('entropy is real and bounded by log2(N)', () => {
    const memory = make();
    expect(memory.entropy()).toBe(0); // empty field: no distribution

    memory.encode(PRIMES, [1, 0.5, 0.25, 0.1, 0, 0, 0, 0]);
    const h = memory.entropy();
    expect(Number.isFinite(h)).toBe(true);
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThanOrEqual(Math.log2(memory.gridSize));
    expect(memory.normalizedEntropy()).toBeGreaterThan(0);
    expect(memory.normalizedEntropy()).toBeLessThanOrEqual(1);
  });

  it('ignores primes outside the basis instead of corrupting the field', () => {
    const memory = make();
    expect(memory.encode([2, 999], [1, 1])).toBe(1);
    const recovered = memory.reconstruct();
    expect(recovered.has(999)).toBe(false);
    expect(recovered.get(2)!.re).toBeCloseTo(1, 10);
  });

  it('clear, clone and JSON round-trip preserve the field', () => {
    const memory = make();
    memory.encode(PRIMES, [0.9, 0.1, 0, 0, 0, 0, 0, 0]);

    const clone = memory.clone();
    expect(clone.similarity(memory)).toBeCloseTo(1, 10);
    clone.clear();
    expect(clone.energy()).toBe(0);
    expect(memory.energy()).toBeGreaterThan(0);

    const restored = HolographicMemory.fromJSON(memory.toJSON());
    expect(restored.similarity(memory)).toBeCloseTo(1, 10);
    expect(restored.energy()).toBeCloseTo(memory.energy(), 10);

    expect(() => HolographicMemory.fromJSON({ ...memory.toJSON(), version: 9 } as never)).toThrow();
  });

  it('cell access is bounds-checked', () => {
    const memory = make();
    expect(memory.cell(0)).toEqual({ re: 0, im: 0 });
    expect(() => memory.cell(-1)).toThrow();
    expect(() => memory.cell(memory.gridSize)).toThrow();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // VALIDATION & HARD CAPS
  // ═══════════════════════════════════════════════════════════════════════

  it('fromJSON rejects non-finite field components with a typed error', () => {
    const snapshotWithNaN = make().toJSON();
    snapshotWithNaN.re[0] = NaN;
    expect(() => HolographicMemory.fromJSON(snapshotWithNaN)).toThrow(NonFiniteValueError);

    const snapshotWithInfinity = make().toJSON();
    snapshotWithInfinity.im[1] = Infinity;
    expect(() => HolographicMemory.fromJSON(snapshotWithInfinity)).toThrow(NonFiniteValueError);
  });

  it('rejects non-finite lambda/kappa/omega at construction', () => {
    expect(() => make({ lambda: NaN })).toThrow(NonFiniteValueError);
    expect(() => make({ lambda: Infinity })).toThrow(NonFiniteValueError);
    expect(() => make({ intensityDamping: NaN })).toThrow(NonFiniteValueError);
    expect(() => make({ intensityDamping: Infinity })).toThrow(NonFiniteValueError);
    expect(() => make({ omega: NaN })).toThrow(NonFiniteValueError);
    expect(() => make({ omega: Infinity })).toThrow(NonFiniteValueError);
    expect(() => make({ gridSize: NaN })).toThrow(NonFiniteValueError);
  });

  it('caps gridSize and the prime basis with typed errors', () => {
    expect(() => new HolographicMemory({ gridSize: 4097 })).toThrow(ConfigurationLimitError);
    expect(() => new HolographicMemory({ gridSize: 1e7 })).toThrow(ConfigurationLimitError);
    expect(() => new HolographicMemory({ gridSize: 300, primes: firstPrimes(257) })).toThrow(
      ConfigurationLimitError
    );
    // At the cap is fine.
    expect(new HolographicMemory({ gridSize: 4096 }).gridSize).toBe(4096);
  });
});
