/**
 * Holographic Memory
 *
 * A prime-indexed complex interference field: each prime is assigned a distinct
 * spatial frequency, and a pattern is the superposition of the corresponding
 * plane waves. The field is content-addressable (correlate two fields) and
 * invertible (recover per-prime complex amplitudes).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * The three math bugs from `lib/hqe.js` that are fixed here
 * ──────────────────────────────────────────────────────────────────────────
 *
 * 1. INVERTED DAMPING SIGN (`HolographicEncoder.evolve`, lib/hqe.js:928)
 *
 *      const localDamping = dampingFactor * (1 + lambda * intensity * 0.1);
 *
 *    `dampingFactor` is `exp(-λ·dt) ≤ 1`, but the `(1 + λ·I·0.1)` factor is
 *    ≥ 1 and grows with intensity, so high-energy cells were multiplied by a
 *    LARGER factor than low-energy cells - the opposite of stabilization - and
 *    once `λ·I·0.1 > e^{λ·dt} − 1` the local factor exceeded 1 and the field
 *    grew without bound.
 *
 *    Fix: the intensity term goes into the exponent with a negative sign,
 *      factor = exp(−λ·dt·(1 + κ·u)),  u = I/Iₘₐₓ ∈ [0,1]
 *    so factor ∈ (0, exp(−λ·dt)] ≤ 1 and higher intensity is damped MORE.
 *    `evolve()` asserts that total energy did not increase.
 *
 * 2. NON-ORTHOGONAL "INVERSE DFT" (`computeSpatialFrequencies`, lib/hqe.js:536)
 *
 *    Frequencies were `k = 2π/(scale·(1+log₂ p))` steered by a golden-ratio
 *    angle spiral, which is not an orthogonal basis over the integer grid.
 *    `reconstruct()` then applied a textbook inverse-DFT kernel to it, so the
 *    cross-terms never cancelled and encode→reconstruct never round-tripped.
 *
 *    Fix: prime `i` gets integer wavenumber `kᵢ = i + 1` and the basis is
 *    `exp(i·2π·kᵢ·n/N)`, which is genuinely orthonormal on `n = 0..N−1`:
 *      (1/N)·Σₙ exp(i·2π(kᵢ−kⱼ)n/N) = δᵢⱼ
 *    Encode→reconstruct is therefore exact to floating-point precision.
 *
 *    Wavenumbers are assigned by PRIME IDENTITY - the prime's rank in the
 *    prime sequence (2 -> 1, 3 -> 2, 5 -> 3, ...) - not by the prime's
 *    position in any particular field's basis list. Two fields therefore
 *    agree on the spatial frequency of every prime they share, so patterns
 *    over disjoint prime sets stay orthogonal (see `correlation`).
 *
 * 3. PHASE-BLIND SIMILARITY (`HolographicMemory.correlate`, lib/hqe.js:1079)
 *
 *    The legacy correlation multiplied |H₁|² by |H₂|², discarding phase, so a
 *    pattern and its exact phase-inverse scored 1.0 (identical).
 *
 *    Fix: complex correlation `Σₙ H₁[n]·conj(H₂[n])` normalized by the field
 *    norms. `similarity()` returns its signed real part in [−1, 1], so an
 *    anti-phase pattern scores −1 and a 90°-shifted pattern scores 0.
 *
 * This module is pure math with no dependency on the ESM library.
 */

import {
  clampRange,
  NonFiniteValueError,
  normalizedEntropy,
  requireAllFinite,
  requireFinite,
  safeDivide,
  shannonEntropyBits,
  toDistribution
} from './numeric';
import { ConfigurationLimitError, MAX_GRID_SIZE, MAX_PRIME_COUNT } from './errors';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** A complex amplitude. */
export interface ComplexAmplitude {
  re: number;
  im: number;
}

/** Complex correlation between two fields. */
export interface HoloCorrelation {
  /** Signed real part, in [-1, 1]. Anti-phase patterns give -1. */
  real: number;
  /** Imaginary part, in [-1, 1]. A 90 degree shift moves energy here. */
  imag: number;
  /** Magnitude in [0, 1] - phase-invariant overlap. */
  magnitude: number;
  /** Correlation phase in radians. */
  phase: number;
}

/** Result of one dissipative evolution step. */
export interface HoloEvolution {
  /** Dissipation rate used. */
  lambda: number;
  /** Total field energy before the step. */
  energyBefore: number;
  /** Total field energy after the step. */
  energyAfter: number;
  /** Smallest per-cell damping factor applied (most-damped cell). */
  minDamping: number;
  /** Largest per-cell damping factor applied (least-damped cell). */
  maxDamping: number;
  /** Intensity-distribution entropy after the step, in bits. */
  entropy: number;
}

/** Construction options. */
export interface HolographicMemoryOptions {
  /** Number of complex grid cells N (default 64). Must exceed the prime count. */
  gridSize?: number;
  /** Prime basis. Defaults to the first `gridSize - 1` odd-indexed placeholders. */
  primes?: readonly number[];
  /** Base dissipation rate lambda >= 0 (default 0.5). */
  lambda?: number;
  /** Intensity coupling kappa >= 0 for the damping exponent (default 2). */
  intensityDamping?: number;
  /** Unitary phase rate omega, applied as a norm-preserving rotation (default 0). */
  omega?: number;
}

/** Serialized form. */
export interface HolographicSnapshot {
  version: 1;
  gridSize: number;
  primes: number[];
  re: number[];
  im: number[];
}

// ═══════════════════════════════════════════════════════════════════════════
// MEMORY
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_GRID_SIZE = 64;
const DEFAULT_LAMBDA = 0.5;
const DEFAULT_INTENSITY_DAMPING = 2;

/** Relative slack allowed when asserting the energy invariant. */
const ENERGY_INVARIANT_TOLERANCE = 1e-9;

export class HolographicMemory {
  private readonly N: number;
  private readonly primeList: number[];
  private readonly wavenumbers: number[];
  private readonly primeToSlot: Map<number, number>;
  private readonly lambda: number;
  private readonly kappa: number;
  private readonly omega: number;

  /** Interference field, split into real and imaginary parts. */
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  /** Precomputed basis: cos/sin of 2*pi*k*n/N for each (slot, cell). */
  private readonly basisCos: Float64Array;
  private readonly basisSin: Float64Array;

  constructor(options: HolographicMemoryOptions = {}) {
    const rawGridSize = options.gridSize ?? DEFAULT_GRID_SIZE;
    if (!Number.isFinite(rawGridSize)) throw new NonFiniteValueError('gridSize', rawGridSize);
    this.N = Math.max(4, Math.floor(rawGridSize));
    if (this.N > MAX_GRID_SIZE) {
      throw new ConfigurationLimitError('gridSize', MAX_GRID_SIZE, this.N);
    }
    this.primeList = options.primes ? Array.from(options.primes) : defaultPrimeBasis(this.N);

    if (this.primeList.length === 0) {
      throw new Error('HolographicMemory requires a non-empty prime basis');
    }
    if (this.primeList.length > MAX_PRIME_COUNT) {
      throw new ConfigurationLimitError('prime basis length', MAX_PRIME_COUNT, this.primeList.length);
    }
    if (this.primeList.length >= this.N) {
      // kᵢ = i + 1 must stay inside [1, N-1] for the basis to remain orthogonal.
      throw new Error(
        `HolographicMemory: prime basis (${this.primeList.length}) must be smaller than gridSize (${this.N})`
      );
    }
    if (new Set(this.primeList).size !== this.primeList.length) {
      throw new Error('HolographicMemory: prime basis must not contain duplicates');
    }

    this.lambda = requireFinite(Math.max(0, options.lambda ?? DEFAULT_LAMBDA), 'HolographicMemory.lambda');
    this.kappa = requireFinite(
      Math.max(0, options.intensityDamping ?? DEFAULT_INTENSITY_DAMPING),
      'HolographicMemory.intensityDamping'
    );
    this.omega = requireFinite(options.omega ?? 0, 'HolographicMemory.omega');

    this.primeToSlot = new Map(this.primeList.map((p, i) => [p, i]));
    // Wavenumbers are assigned by PRIME IDENTITY (the prime's rank in the
    // prime sequence: 2 -> 1, 3 -> 2, 5 -> 3, ...), not by position in the
    // basis list. Two fields therefore agree on the spatial frequency of any
    // prime regardless of which (or how many) primes each carries, so
    // patterns over disjoint prime sets stay orthogonal - which is exactly
    // what content-addressable recall needs.
    const ranks = primeRankTable(this.primeList, MAX_GRID_SIZE);
    const seenWavenumbers = new Set<number>();
    this.wavenumbers = this.primeList.map(p => {
      const k = ranks.get(p)!;
      if (k >= this.N) {
        throw new Error(
          `HolographicMemory: prime ${p} maps to wavenumber ${k}, which must be smaller than gridSize (${this.N})`
        );
      }
      if (seenWavenumbers.has(k)) {
        throw new Error(
          `HolographicMemory: prime basis entries map to colliding wavenumber ${k}; the basis must be orthogonal`
        );
      }
      seenWavenumbers.add(k);
      return k;
    });

    this.re = new Float64Array(this.N);
    this.im = new Float64Array(this.N);

    const slots = this.primeList.length;
    this.basisCos = new Float64Array(slots * this.N);
    this.basisSin = new Float64Array(slots * this.N);
    for (let s = 0; s < slots; s++) {
      const k = this.wavenumbers[s];
      for (let n = 0; n < this.N; n++) {
        const theta = (2 * Math.PI * k * n) / this.N;
        this.basisCos[s * this.N + n] = Math.cos(theta);
        this.basisSin[s * this.N + n] = Math.sin(theta);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Structure
  // ─────────────────────────────────────────────────────────────────────────

  get gridSize(): number {
    return this.N;
  }

  get primes(): readonly number[] {
    return this.primeList;
  }

  /**
   * Integer wavenumber assigned to each prime, in basis order. The wavenumber
   * is the prime's rank in the prime sequence (2 -> 1, 3 -> 2, ...), so the
   * same prime always has the same spatial frequency in every field.
   */
  get spatialFrequencies(): readonly number[] {
    return this.wavenumbers;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Encoding
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Encode a pattern: `H[n] = Σᵢ aᵢ·exp(i·(2π·kᵢ·n/N + φᵢ))`.
   *
   * Clears the field first. `amplitudes[i]` and the optional `phases[i]`
   * correspond to `primes[i]` of the argument list, not to the basis order.
   * Primes outside the basis are ignored and counted in the return value.
   *
   * @returns number of basis slots actually written.
   */
  encode(primes: readonly number[], amplitudes: readonly number[], phases?: readonly number[]): number {
    this.clear();
    return this.superpose(primes, amplitudes, phases);
  }

  /** Add a pattern to the existing field without clearing it. */
  superpose(primes: readonly number[], amplitudes: readonly number[], phases?: readonly number[]): number {
    let written = 0;
    const count = Math.min(primes.length, amplitudes.length);

    for (let i = 0; i < count; i++) {
      const slot = this.primeToSlot.get(primes[i]);
      if (slot === undefined) continue;

      const amplitude = amplitudes[i];
      if (!Number.isFinite(amplitude) || amplitude === 0) continue;
      const phase = phases && Number.isFinite(phases[i]) ? phases[i] : 0;

      // aᵢ = amplitude·e^{iφᵢ}
      const ar = amplitude * Math.cos(phase);
      const ai = amplitude * Math.sin(phase);
      const offset = slot * this.N;

      for (let n = 0; n < this.N; n++) {
        const c = this.basisCos[offset + n];
        const s = this.basisSin[offset + n];
        this.re[n] += ar * c - ai * s;
        this.im[n] += ar * s + ai * c;
      }
      written += 1;
    }

    return written;
  }

  /**
   * Recover per-prime complex amplitudes via the orthogonal inverse transform
   * `aᵢ = (1/N)·Σₙ H[n]·exp(−i·2π·kᵢ·n/N)`.
   *
   * Exact inverse of `encode` up to floating-point precision.
   */
  reconstruct(): Map<number, ComplexAmplitude> {
    const out = new Map<number, ComplexAmplitude>();

    for (let s = 0; s < this.primeList.length; s++) {
      const offset = s * this.N;
      let sr = 0;
      let si = 0;
      for (let n = 0; n < this.N; n++) {
        const c = this.basisCos[offset + n];
        const sn = this.basisSin[offset + n];
        // (re + i·im)·(c − i·sn)
        sr += this.re[n] * c + this.im[n] * sn;
        si += this.im[n] * c - this.re[n] * sn;
      }
      out.set(this.primeList[s], {
        re: requireFinite(sr / this.N, 'reconstruct.re'),
        im: requireFinite(si / this.N, 'reconstruct.im')
      });
    }

    return out;
  }

  /** Reconstructed magnitudes in basis order. */
  reconstructMagnitudes(): number[] {
    const amps = this.reconstruct();
    return this.primeList.map(p => {
      const a = amps.get(p);
      return a ? Math.hypot(a.re, a.im) : 0;
    });
  }

  /** Reconstructed phases (radians) in basis order. */
  reconstructPhases(): number[] {
    const amps = this.reconstruct();
    return this.primeList.map(p => {
      const a = amps.get(p);
      return a ? Math.atan2(a.im, a.re) : 0;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Comparison
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Phase-aware similarity in [-1, 1]: the signed real part of the normalized
   * complex correlation. Identical patterns give 1, anti-phase patterns give
   * -1, and a quarter-cycle shift gives 0.
   */
  similarity(other: HolographicMemory): number {
    return this.correlation(other).real;
  }

  /**
   * Full complex correlation, including the phase-invariant magnitude.
   *
   * Both fields are scaled by their max |component| before the sums, so huge
   * finite cells (e.g. 1e200) cannot overflow the products to Infinity/NaN
   * and near-zero cells (e.g. 1e-200) cannot underflow them to 0. Identical
   * patterns therefore always correlate at exactly 1 regardless of their
   * amplitude scale; an empty field correlates at 0 against everything.
   */
  correlation(other: HolographicMemory): HoloCorrelation {
    if (other.N !== this.N) {
      throw new Error(`Grid size mismatch: ${this.N} vs ${other.N}`);
    }

    const scaleA = this.maxAbs();
    const scaleB = other.maxAbs();
    if (scaleA === 0 || scaleB === 0) {
      return { real: 0, imag: 0, magnitude: 0, phase: 0 };
    }

    let cr = 0;
    let ci = 0;
    let n1 = 0;
    let n2 = 0;

    for (let n = 0; n < this.N; n++) {
      const ar = this.re[n] / scaleA;
      const ai = this.im[n] / scaleA;
      const br = other.re[n] / scaleB;
      const bi = other.im[n] / scaleB;
      // a·conj(b)
      cr += ar * br + ai * bi;
      ci += ai * br - ar * bi;
      n1 += ar * ar + ai * ai;
      n2 += br * br + bi * bi;
    }

    const denominator = Math.sqrt(n1) * Math.sqrt(n2);
    const real = clampRange(safeDivide(cr, denominator, 0), -1, 1);
    const imag = clampRange(safeDivide(ci, denominator, 0), -1, 1);

    return {
      real: requireFinite(real, 'correlation.real'),
      imag: requireFinite(imag, 'correlation.imag'),
      magnitude: requireFinite(clampRange(Math.hypot(real, imag), 0, 1), 'correlation.magnitude'),
      phase: requireFinite(Math.atan2(imag, real), 'correlation.phase')
    };
  }

  /** Largest |cell| across the complex field. */
  private maxAbs(): number {
    let max = 0;
    for (let n = 0; n < this.N; n++) {
      const r = Math.abs(this.re[n]);
      if (r > max) max = r;
      const i = Math.abs(this.im[n]);
      if (i > max) max = i;
    }
    return max;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dynamics
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * One dissipative evolution step.
   *
   * Unitary part: a global phase rotation by `ω·dt`, which is norm-preserving.
   * Dissipative part: per-cell factor `exp(−λ·dt·(1 + κ·I/Iₘₐₓ)) ∈ (0, 1]`,
   * so more intense cells lose more energy and total energy is non-increasing.
   *
   * The energy invariant is asserted, so the legacy sign inversion cannot be
   * reintroduced silently.
   */
  evolve(dt = 0.016): HoloEvolution {
    if (!Number.isFinite(dt) || dt <= 0) {
      throw new Error(`HolographicMemory.evolve requires a positive finite dt, got ${String(dt)}`);
    }

    const energyBefore = this.energy();

    // Unitary rotation (|e^{iθ}| = 1, so per-cell modulus is preserved).
    const theta = this.omega * dt;
    if (theta !== 0) {
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      for (let n = 0; n < this.N; n++) {
        const r = this.re[n];
        const i = this.im[n];
        this.re[n] = r * c - i * s;
        this.im[n] = r * s + i * c;
      }
    }

    // Dissipation, intensity-weighted with the CORRECT sign.
    let maxIntensity = 0;
    for (let n = 0; n < this.N; n++) {
      const intensity = this.re[n] * this.re[n] + this.im[n] * this.im[n];
      if (intensity > maxIntensity) maxIntensity = intensity;
    }

    let minDamping = 1;
    let maxDamping = this.lambda > 0 ? 0 : 1;

    if (this.lambda > 0) {
      for (let n = 0; n < this.N; n++) {
        const intensity = this.re[n] * this.re[n] + this.im[n] * this.im[n];
        const u = clampRange(safeDivide(intensity, maxIntensity, 0), 0, 1);
        const factor = Math.exp(-this.lambda * dt * (1 + this.kappa * u));
        if (factor < minDamping) minDamping = factor;
        if (factor > maxDamping) maxDamping = factor;
        this.re[n] *= factor;
        this.im[n] *= factor;
      }
    }

    const energyAfter = this.energy();

    // Invariant: pure dissipation can never add energy.
    if (energyAfter > energyBefore * (1 + ENERGY_INVARIANT_TOLERANCE) + Number.EPSILON) {
      throw new Error(
        `HolographicMemory.evolve violated the dissipation invariant: ` +
          `energy rose from ${energyBefore} to ${energyAfter}`
      );
    }

    return {
      lambda: requireFinite(this.lambda, 'HolographicMemory.evolve lambda'),
      energyBefore,
      energyAfter,
      minDamping: requireFinite(minDamping, 'minDamping'),
      maxDamping: requireFinite(maxDamping, 'maxDamping'),
      entropy: this.entropy()
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Readouts
  // ─────────────────────────────────────────────────────────────────────────

  /** Total field energy `Σₙ |H[n]|²`. */
  energy(): number {
    let sum = 0;
    for (let n = 0; n < this.N; n++) sum += this.re[n] * this.re[n] + this.im[n] * this.im[n];
    return requireFinite(sum, 'HolographicMemory.energy');
  }

  /** Per-cell intensity `|H[n]|²`. */
  intensity(): number[] {
    const out = new Array<number>(this.N);
    for (let n = 0; n < this.N; n++) out[n] = this.re[n] * this.re[n] + this.im[n] * this.im[n];
    return out;
  }

  /**
   * Shannon entropy (bits) of the normalized per-cell intensity distribution
   * `pₙ = |H[n]|² / Σ |H[m]|²`. An empty field has no distribution and
   * reports 0.
   *
   * Convention (shared with `normalizedEntropy()`): the distribution is the
   * per-cell intensity, normalized by its total.
   */
  entropy(): number {
    return requireFinite(shannonEntropyBits(toDistribution(this.intensity())), 'HolographicMemory.entropy');
  }

  /**
   * The exact normalization of the SAME distribution used by `entropy()`:
   * `entropy() / log2(N)`, in [0, 1]. Both readouts share the
   * intensity-distribution convention, so this is always the normalization of
   * `entropy()`, never a second distribution.
   */
  normalizedEntropy(): number {
    return requireFinite(
      normalizedEntropy(toDistribution(this.intensity())),
      'HolographicMemory.normalizedEntropy'
    );
  }

  /** Complex field cell. */
  cell(n: number): ComplexAmplitude {
    if (!Number.isInteger(n) || n < 0 || n >= this.N) {
      throw new Error(`Cell index out of range: ${String(n)}`);
    }
    return { re: this.re[n], im: this.im[n] };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /** Zero the field. */
  clear(): this {
    this.re.fill(0);
    this.im.fill(0);
    return this;
  }

  clone(): HolographicMemory {
    const copy = new HolographicMemory({
      gridSize: this.N,
      primes: this.primeList,
      lambda: this.lambda,
      intensityDamping: this.kappa,
      omega: this.omega
    });
    copy.re.set(this.re);
    copy.im.set(this.im);
    return copy;
  }

  toJSON(): HolographicSnapshot {
    return {
      version: 1,
      gridSize: this.N,
      primes: [...this.primeList],
      re: Array.from(this.re),
      im: Array.from(this.im)
    };
  }

  /**
   * Rebuild from a snapshot. Rejects malformed payloads loudly: wrong
   * version, mismatched field length, or non-finite components all throw
   * (`NonFiniteValueError` for non-finite cells).
   */
  static fromJSON(snapshot: HolographicSnapshot, options: HolographicMemoryOptions = {}): HolographicMemory {
    if (!snapshot || snapshot.version !== 1) {
      throw new Error('Invalid holographic snapshot: expected version 1');
    }
    if (
      !Array.isArray(snapshot.re) ||
      !Array.isArray(snapshot.im) ||
      snapshot.re.length !== snapshot.gridSize ||
      snapshot.im.length !== snapshot.gridSize
    ) {
      throw new Error('Invalid holographic snapshot: field length does not match gridSize');
    }
    requireAllFinite(snapshot.re, 'snapshot.re');
    requireAllFinite(snapshot.im, 'snapshot.im');
    const memory = new HolographicMemory({
      ...options,
      gridSize: snapshot.gridSize,
      primes: snapshot.primes
    });
    memory.re.set(snapshot.re);
    memory.im.set(snapshot.im);
    return memory;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Trial-division prime basis used when the caller does not supply one.
 * Local on purpose: this module must stay free of the async ESM dependency.
 */
function defaultPrimeBasis(gridSize: number): number[] {
  const wanted = Math.max(1, Math.min(16, gridSize - 1));
  const primes: number[] = [];
  for (let n = 2; primes.length < wanted; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) {
      if (n % d === 0) {
        prime = false;
        break;
      }
    }
    if (prime) primes.push(n);
  }
  return primes;
}

/**
 * Map each value to its rank in the prime sequence (2 -> 1, 3 -> 2, 5 -> 3,
 * ...). Values larger than the `maxRank`-th prime map to `maxRank + 1`; the
 * caller rejects those because their wavenumber can never fit in the grid.
 *
 * This makes wavenumber assignment a function of the PRIME ITSELF, not of the
 * prime's position in whatever basis list a particular field happens to use.
 */
function primeRankTable(values: readonly number[], maxRank: number): Map<number, number> {
  let max = 0;
  for (const p of values) if (p > max) max = p;

  const ranks = new Map<number, number>();
  let count = 0;
  for (let candidate = 2; candidate <= max && count < maxRank; candidate++) {
    let prime = true;
    for (let d = 2; d * d <= candidate; d++) {
      if (candidate % d === 0) {
        prime = false;
        break;
      }
    }
    if (prime) {
      count += 1;
      ranks.set(candidate, count);
    }
  }

  const out = new Map<number, number>();
  for (const p of values) out.set(p, ranks.get(p) ?? maxRank + 1);
  return out;
}
