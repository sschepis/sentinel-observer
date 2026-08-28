/**
 * Sedenion Memory Field (SMF)
 *
 * A real 16-axis semantic orientation vector. Axis metadata is imported from
 * `src/common/types.ts` (`SMF_AXES`) - this module deliberately does NOT define
 * a second axis list. The legacy `lib/smf.js` fallback invented a *different*
 * 16-name list ('coherence', 'identity', 'duality', ...), so the same index
 * meant different things depending on which module you asked.
 *
 * Fixes relative to `lib/smf.js`:
 *   - The fallback class stubbed `smfEntropy() => 0`, `dominantAxes() => []` and
 *     `updateFromPrimeActivity() => {}` (an empty body). This implementation is
 *     complete: entropy is real Shannon entropy over normalized axis energies,
 *     dominant axes are really ranked, and prime activity really imprints.
 *   - `get`/`set` accept an axis name or index and validate both, instead of
 *     silently reading `undefined` for a misspelled axis name.
 *
 * This module is pure math with no dependency on the ESM library, which is a
 * correctness property in itself: it cannot silently degrade. Its entropy is
 * asserted to equal `tinyaleph.shannonEntropy` in the test suite.
 */

import {
  SMF_AXES,
  type SMFAxisIndex,
  type SMFAxisInfo,
  type SMFVector,
  type SemanticDomain,
  DOMAIN_RANGES
} from '../common/types';
import {
  clampRange,
  normalizedEntropy,
  requireAllFinite,
  requireFinite,
  safeDivide,
  shannonEntropyBits,
  stableCosineSimilarity,
  toDistribution
} from './numeric';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS & TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Number of sedenion axes. Derived from SMF_AXES, never hardcoded twice. */
export const SMF_DIMENSION = 16;

const AXIS_INDICES = Object.keys(SMF_AXES)
  .map(key => Number(key) as SMFAxisIndex)
  .sort((a, b) => a - b);

const AXIS_NAME_TO_INDEX: ReadonlyMap<string, SMFAxisIndex> = new Map(
  AXIS_INDICES.map(index => [SMF_AXES[index].name, index])
);

/** An axis may be referenced by canonical name or by numeric index. */
export type SMFAxisRef = SMFAxisIndex | number | string;

/** Ranked axis descriptor returned by `dominantAxes`. */
export interface DominantAxis {
  index: SMFAxisIndex;
  name: string;
  domain: SemanticDomain;
  /** Signed component value. */
  value: number;
  /** Squared component (energy) as a share of total field energy, in [0, 1]. */
  energyShare: number;
}

/** Serialized form. */
export interface SMFSnapshot {
  version: 1;
  components: number[];
}

/**
 * Minimal structural view of oscillator activity consumed by
 * `updateFromPrimeActivity`. `OscillatorFieldState` satisfies this.
 */
export interface PrimeActivitySample {
  readonly primes: readonly number[];
  readonly phases: readonly number[];
  readonly amplitudes: readonly number[];
  readonly coherence: number;
}

/** Imprint tuning for `updateFromPrimeActivity`. */
export interface PrimeActivityOptions {
  /** Base blend rate toward the observed target, in [0, 1] (default 0.2). */
  learningRate?: number;
  /** When true (default) the blend rate scales with observed coherence. */
  coherenceWeighted?: boolean;
}

/** Raised for an unknown axis name or an out-of-range axis index. */
export class UnknownSMFAxisError extends Error {
  constructor(ref: SMFAxisRef) {
    super(`Unknown SMF axis: ${JSON.stringify(ref)}`);
    this.name = 'UnknownSMFAxisError';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FIELD
// ═══════════════════════════════════════════════════════════════════════════

export class SedenionMemoryField {
  private readonly s: Float64Array;

  constructor(initial?: readonly number[] | Float64Array) {
    this.s = new Float64Array(SMF_DIMENSION);
    if (initial) {
      const length = Math.min(initial.length, SMF_DIMENSION);
      for (let i = 0; i < length; i++) {
        const value = initial[i];
        this.s[i] = Number.isFinite(value) ? value : 0;
      }
    } else {
      // Scalar-identity orientation: unit weight on the real axis.
      this.s[0] = 1;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Factories
  // ─────────────────────────────────────────────────────────────────────────

  /** Identity field (scalar axis = 1, all others 0). */
  static identity(): SedenionMemoryField {
    return new SedenionMemoryField();
  }

  /** All-zero field. */
  static zero(): SedenionMemoryField {
    return new SedenionMemoryField(new Float64Array(SMF_DIMENSION));
  }

  /** Build from a 16-vector. */
  static fromArray(values: readonly number[]): SedenionMemoryField {
    return new SedenionMemoryField(values);
  }

  /** Build a field with a single dominant axis. */
  static fromAxis(axis: SMFAxisRef, value = 1): SedenionMemoryField {
    const field = SedenionMemoryField.zero();
    field.set(axis, value);
    return field;
  }

  /** Axis metadata for an index. */
  static axisInfo(index: SMFAxisIndex): SMFAxisInfo {
    return SMF_AXES[index];
  }

  /** Canonical axis names in index order. */
  static axisNames(): readonly string[] {
    return AXIS_INDICES.map(index => SMF_AXES[index].name);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Axis resolution
  // ─────────────────────────────────────────────────────────────────────────

  /** Resolve a name or index to a validated axis index. */
  static resolveAxis(ref: SMFAxisRef): SMFAxisIndex {
    if (typeof ref === 'number') {
      if (!Number.isInteger(ref) || ref < 0 || ref >= SMF_DIMENSION) throw new UnknownSMFAxisError(ref);
      return ref as SMFAxisIndex;
    }
    const index = AXIS_NAME_TO_INDEX.get(ref);
    if (index === undefined) throw new UnknownSMFAxisError(ref);
    return index;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────────────────────────────────────

  get(ref: SMFAxisRef): number {
    return this.s[SedenionMemoryField.resolveAxis(ref)];
  }

  set(ref: SMFAxisRef, value: number): this {
    this.s[SedenionMemoryField.resolveAxis(ref)] = requireFinite(value, 'SMF.set value');
    return this;
  }

  add(ref: SMFAxisRef, delta: number): this {
    const index = SedenionMemoryField.resolveAxis(ref);
    this.s[index] = requireFinite(this.s[index] + delta, 'SMF.add result');
    return this;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Geometry
  // ─────────────────────────────────────────────────────────────────────────

  /** Euclidean (L2) norm. */
  norm(): number {
    let sum = 0;
    for (let i = 0; i < SMF_DIMENSION; i++) sum += this.s[i] * this.s[i];
    return requireFinite(Math.sqrt(sum), 'SMF.norm');
  }

  /** Total energy (squared norm). */
  energy(): number {
    let sum = 0;
    for (let i = 0; i < SMF_DIMENSION; i++) sum += this.s[i] * this.s[i];
    return requireFinite(sum, 'SMF.energy');
  }

  /**
   * Scale to unit norm in place. A zero field is left untouched (scaling it
   * would require inventing a direction) and `false` is returned.
   */
  normalize(): boolean {
    const n = this.norm();
    if (n < 1e-12) return false;
    for (let i = 0; i < SMF_DIMENSION; i++) this.s[i] = this.s[i] / n;
    return true;
  }

  /**
   * Cosine similarity with another field, in [-1, 1]; 0 if either is zero.
   *
   * Computed with the overflow/underflow-guarded `stableCosineSimilarity`:
   * both vectors are scaled by their max |component| first, so huge finite
   * components (e.g. 1e200) cannot overflow the dot product to Infinity/NaN
   * and tiny components cannot underflow it to 0.
   */
  coherenceWith(other: SedenionMemoryField): number {
    const value = stableCosineSimilarity(this.toArray(), other.toArray());
    return requireFinite(clampRange(value, -1, 1), 'SMF.coherenceWith');
  }

  /** Multiply every axis by `1 - rate` (bounded to [0, 1]). */
  decay(rate: number): this {
    const factor = 1 - clampRange(rate, 0, 1);
    for (let i = 0; i < SMF_DIMENSION; i++) this.s[i] *= factor;
    return this;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Information
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Real Shannon entropy (bits) over the normalized axis-energy distribution
   * `pᵢ = sᵢ² / Σ sⱼ²`. A zero field has no distribution and reports 0.
   * Range: [0, log2(16)] = [0, 4].
   *
   * Convention (shared with `normalizedEntropy()`): the distribution is the
   * squared axis components, normalized by their total (`energyDistribution`).
   */
  entropy(): number {
    return requireFinite(shannonEntropyBits(this.energyDistribution()), 'SMF.entropy');
  }

  /**
   * The exact normalization of the SAME distribution used by `entropy()`:
   * `entropy() / log2(16)`, in [0, 1]. Both readouts share the
   * `energyDistribution()` convention, so this is always the normalization of
   * `entropy()`, never a second distribution.
   */
  normalizedEntropy(): number {
    return requireFinite(normalizedEntropy(this.energyDistribution()), 'SMF.normalizedEntropy');
  }

  /** Axis-energy probability distribution used by `entropy()`. */
  energyDistribution(): number[] {
    const energies = new Array<number>(SMF_DIMENSION);
    for (let i = 0; i < SMF_DIMENSION; i++) energies[i] = this.s[i] * this.s[i];
    return toDistribution(energies);
  }

  /** Top-`n` axes ranked by absolute magnitude. */
  dominantAxes(n = 4): DominantAxis[] {
    const count = clampRange(Math.floor(n), 0, SMF_DIMENSION);
    if (count === 0) return [];

    const total = this.energy();
    const ranked = AXIS_INDICES.map(index => ({
      index,
      name: SMF_AXES[index].name,
      domain: SMF_AXES[index].domain,
      value: this.s[index],
      energyShare: requireFinite(safeDivide(this.s[index] * this.s[index], total, 0), 'energyShare')
    }));

    ranked.sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.index - b.index);
    return ranked.slice(0, count);
  }

  /** L2 magnitude of one semantic domain's slice. */
  domainMagnitude(domain: SemanticDomain): number {
    const [start, end] = DOMAIN_RANGES[domain];
    let sum = 0;
    for (let i = start; i <= end; i++) sum += this.s[i] * this.s[i];
    return requireFinite(Math.sqrt(sum), 'SMF.domainMagnitude');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Prime activity imprint
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Imprint oscillator activity onto the 16 axes.
   *
   * Oscillator `j` contributes `aⱼ · cos(φⱼ)` to axis `j mod 16`, so the signed
   * axes (emotional valence, causal weight, ...) can go negative as phases
   * drift. Per-axis contributions are averaged (guarded division), then blended
   * into the current orientation with an exponential moving average whose rate
   * scales with the observed coherence: an incoherent field barely imprints.
   *
   * @returns the blend rate actually applied.
   */
  updateFromPrimeActivity(sample: PrimeActivitySample, options: PrimeActivityOptions = {}): number {
    const { amplitudes, phases } = sample;
    const count = Math.min(amplitudes.length, phases.length);
    if (count === 0) return 0;

    const sums = new Float64Array(SMF_DIMENSION);
    const counts = new Int32Array(SMF_DIMENSION);

    for (let j = 0; j < count; j++) {
      const amplitude = amplitudes[j];
      const phase = phases[j];
      if (!Number.isFinite(amplitude) || !Number.isFinite(phase)) continue;
      const axis = j % SMF_DIMENSION;
      sums[axis] += amplitude * Math.cos(phase);
      counts[axis] += 1;
    }

    const learningRate = clampRange(options.learningRate ?? 0.2, 0, 1);
    const coherence = Number.isFinite(sample.coherence) ? clampRange(sample.coherence, 0, 1) : 0;
    const weighted = options.coherenceWeighted ?? true;
    const alpha = clampRange(weighted ? learningRate * (0.5 + 0.5 * coherence) : learningRate, 0, 1);
    if (alpha === 0) return 0;

    for (let i = 0; i < SMF_DIMENSION; i++) {
      const target = safeDivide(sums[i], counts[i], 0);
      this.s[i] = requireFinite((1 - alpha) * this.s[i] + alpha * target, `SMF axis ${i}`);
    }

    return alpha;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Serialization
  // ─────────────────────────────────────────────────────────────────────────

  /** Copy of the 16 components. */
  toArray(): SMFVector {
    return Array.from(this.s) as unknown as SMFVector;
  }

  /** Axis-name keyed view. */
  toRecord(): Record<string, number> {
    const record: Record<string, number> = {};
    for (const index of AXIS_INDICES) record[SMF_AXES[index].name] = this.s[index];
    return record;
  }

  toJSON(): SMFSnapshot {
    return { version: 1, components: Array.from(this.s) };
  }

  /**
   * Rebuild from a snapshot. Rejects malformed payloads loudly: wrong
   * version, wrong component count, or non-finite components all throw
   * (a NaN axis would silently become 0 in the plain constructor, so it is
   * refused here instead of being coerced).
   */
  static fromJSON(snapshot: SMFSnapshot): SedenionMemoryField {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.components)) {
      throw new Error('Invalid SMF snapshot: expected { version: 1, components: number[] }');
    }
    if (snapshot.components.length !== SMF_DIMENSION) {
      throw new Error(
        `Invalid SMF snapshot: expected ${SMF_DIMENSION} components, got ${snapshot.components.length}`
      );
    }
    requireAllFinite(snapshot.components, 'SMF snapshot component');
    return new SedenionMemoryField(snapshot.components);
  }

  clone(): SedenionMemoryField {
    return new SedenionMemoryField(this.s);
  }

  toString(): string {
    const top = this.dominantAxes(3)
      .map(a => `${a.name}=${a.value.toFixed(3)}`)
      .join(', ');
    return `SMF(norm=${this.norm().toFixed(3)}, H=${this.entropy().toFixed(3)}, ${top})`;
  }
}
