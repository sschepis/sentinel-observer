/**
 * Sedenion Memory Field (SMF)
 *
 * A real, width-configurable semantic orientation vector. The default width is
 * the 16 named axes imported from `src/common/types.ts` (`SMF_AXES`) — this
 * module deliberately does NOT define a second axis list. The legacy
 * `lib/smf.js` fallback invented a *different* 16-name list ('coherence',
 * 'identity', 'duality', ...), so the same index meant different things
 * depending on which module you asked.
 *
 * Fixes relative to `lib/smf.js`:
 *   - The fallback class stubbed `smfEntropy() => 0`, `dominantAxes() => []` and
 *     `updateFromPrimeActivity() => {}` (an empty body). This implementation is
 *     complete: entropy is real Shannon entropy over normalized axis energies,
 *     dominant axes are really ranked, and prime activity really imprints.
 *   - `get`/`set` accept an axis name or index and validate both, instead of
 *     silently reading `undefined` for a misspelled axis name.
 *
 * Width & projection (the discrimination bottleneck fix):
 *   - The field may be constructed wider than 16 (`options.width`). The first
 *     16 components remain the named `SMF_AXES`; extra components are unnamed
 *     sketch dimensions (`axis:16`, `axis:17`, ...). Wider sketches spread
 *     discrimination across more dimensions.
 *   - When constructed with a `primeCount`, `updateFromPrimeActivity` imprints
 *     via a seeded signed random projection (Johnson–Lindenstrauss) instead of
 *     the legacy `axis = j mod width` fold — the fold aliased 16 oscillators
 *     onto each axis at primeCount=256 and made the axis semantics fictional.
 *     Without a `primeCount` the field falls back to the legacy fold, so the
 *     default 16-axis behavior is bit-for-bit unchanged.
 *
 *   AXIS NAMES ARE LABELS, NOT CHANNELS. With the projection active (the
 *   production configuration), every component hears every oscillator through
 *   the seeded matrix, so `visual_salience`, `emotional_valence`, etc. are
 *   conventional names for the first 16 sketch dimensions — they are NOT
 *   calibrated semantic channels, and no behavior may read a component as if
 *   it were one. The names exist for dashboard display and introspection only;
 *   all discrimination rides on the full sketch geometry.
 *
 * This module is pure math with no dependency on the ESM library, which is a
 * correctness property in itself: it cannot silently degrade. Its entropy is
 * asserted to equal `tinyaleph.shannonEntropy` in the test suite.
 */

import {
  SMF_AXES,
  type SMFAxisIndex,
  type SMFAxisInfo,
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
import { SignedRandomProjection } from './SketchProjection';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS & TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Number of named sedenion axes. Derived from SMF_AXES — never hardcoded twice. */
export const SMF_DIMENSION = Object.keys(SMF_AXES).length;

/** Hard cap on the sketch width, enforced at construction. */
export const MAX_SMF_WIDTH = 4096;

const AXIS_INDICES = Object.keys(SMF_AXES)
  .map(key => Number(key) as SMFAxisIndex)
  .sort((a, b) => a - b);

const AXIS_NAME_TO_INDEX: ReadonlyMap<string, SMFAxisIndex> = new Map(
  AXIS_INDICES.map(index => [SMF_AXES[index].name, index])
);

/** An axis may be referenced by canonical name or by numeric index. */
export type SMFAxisRef = SMFAxisIndex | number | string;

/** Construction options for the field. */
export interface SedenionMemoryFieldOptions {
  /**
   * Sketch width (default 16 = the named SMF_AXES). Components beyond the
   * first 16 are unnamed sketch dimensions.
   */
  width?: number;
  /**
   * Oscillator count of the field this orientation imprints from. When given,
   * `updateFromPrimeActivity` uses a seeded signed random projection instead
   * of the legacy `axis = j mod width` fold.
   */
  primeCount?: number;
  /** Determinism seed for the projection matrix (default 0x5eed). */
  projectionSeed?: number;
  /** Non-zero density of the projection rows in (0, 1] (default 1). */
  projectionDensity?: number;
}

/** Ranked axis descriptor returned by `dominantAxes`. */
export interface DominantAxis {
  index: number;
  name: string;
  /** Domain of a named axis; null for unnamed sketch dimensions. */
  domain: SemanticDomain | null;
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
  /** The sketch width (component count). */
  readonly width: number;
  /**
   * Lazily built: the projection matrix is 128×256 floats (~128 KB) and is
   * needed only by `updateFromPrimeActivity`. Clones (every stored trace
   * carries a cloned SMF) must NOT allocate it — a bank full of dead
   * projection matrices would multiply live memory by ~100×. The matrix is
   * built on first imprint and is deterministic (same params → same matrix).
   */
  private _projection: SignedRandomProjection | null = null;
  private readonly projectionParams: {
    primeCount: number;
    seed: number;
    density: number;
  } | null;

  constructor(initial?: readonly number[] | Float64Array, options: SedenionMemoryFieldOptions = {}) {
    const width = Math.floor(options.width ?? SMF_DIMENSION);
    if (!Number.isInteger(width) || width < 1 || width > MAX_SMF_WIDTH) {
      throw new Error(
        `SedenionMemoryField: width must be an integer in [1, ${MAX_SMF_WIDTH}], got ${options.width}`
      );
    }
    this.width = width;
    this.s = new Float64Array(width);
    if (initial) {
      const length = Math.min(initial.length, width);
      for (let i = 0; i < length; i++) {
        const value = initial[i];
        this.s[i] = Number.isFinite(value) ? value : 0;
      }
    } else {
      // Scalar-identity orientation: unit weight on the real axis.
      this.s[0] = 1;
    }

    if (options.primeCount !== undefined && options.primeCount > 0) {
      this.projectionParams = {
        primeCount: Math.floor(options.primeCount),
        seed: options.projectionSeed ?? 0x5eed,
        density: options.projectionDensity ?? 1
      };
    } else {
      this.projectionParams = null;
    }
  }

  /** The projection matrix, built on first use (lazy — clones never pay for it). */
  private get projection(): SignedRandomProjection | null {
    if (this._projection === null && this.projectionParams !== null) {
      this._projection = new SignedRandomProjection({
        inputDim: this.projectionParams.primeCount,
        outputDim: this.width,
        seed: this.projectionParams.seed,
        density: this.projectionParams.density
      });
    }
    return this._projection;
  }

  /**
   * Whether the projection matrix has been materialized. Read-only
   * introspection: a cloned field (a stored trace) reports false until it is
   * actually imprinted — the memory-footprint gate for the compact bank.
   */
  projectionAllocated(): boolean {
    return this._projection !== null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Factories
  // ─────────────────────────────────────────────────────────────────────────

  /** Identity field (scalar axis = 1, all others 0). */
  static identity(options?: SedenionMemoryFieldOptions): SedenionMemoryField {
    return new SedenionMemoryField(undefined, options);
  }

  /** All-zero field. */
  static zero(options?: SedenionMemoryFieldOptions): SedenionMemoryField {
    const field = new SedenionMemoryField(undefined, options);
    field.s.fill(0);
    return field;
  }

  /**
   * Build from a vector. The width follows the vector when it is wider than
   * the default (so a serialized 64-dim sketch restores as 64-dim); shorter
   * vectors pad to the default width.
   */
  static fromArray(values: readonly number[], options?: SedenionMemoryFieldOptions): SedenionMemoryField {
    const width = options?.width ?? Math.max(SMF_DIMENSION, values.length);
    return new SedenionMemoryField(values, { ...options, width });
  }

  /** Build a field with a single dominant axis. */
  static fromAxis(axis: SMFAxisRef, value = 1): SedenionMemoryField {
    const field = SedenionMemoryField.zero();
    field.set(axis, value);
    return field;
  }

  /** Axis metadata for a named index. */
  static axisInfo(index: SMFAxisIndex): SMFAxisInfo {
    return SMF_AXES[index];
  }

  /** Canonical named-axis names in index order. */
  static axisNames(): readonly string[] {
    return AXIS_INDICES.map(index => SMF_AXES[index].name);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Axis resolution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Resolve a canonical name to its index in the fixed 16-axis metadata.
   * Instance indexing (`get`/`set`) bounds by the field's own width instead.
   */
  static resolveAxis(ref: SMFAxisRef): SMFAxisIndex {
    if (typeof ref === 'number') {
      if (!Number.isInteger(ref) || ref < 0 || ref >= SMF_DIMENSION) throw new UnknownSMFAxisError(ref);
      return ref as SMFAxisIndex;
    }
    const index = AXIS_NAME_TO_INDEX.get(ref);
    if (index === undefined) throw new UnknownSMFAxisError(ref);
    return index;
  }

  private resolve(ref: SMFAxisRef): number {
    if (typeof ref === 'number') {
      if (!Number.isInteger(ref) || ref < 0 || ref >= this.width) throw new UnknownSMFAxisError(ref);
      return ref;
    }
    const index = AXIS_NAME_TO_INDEX.get(ref);
    if (index === undefined || index >= this.width) throw new UnknownSMFAxisError(ref);
    return index;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────────────────────────────────────

  get(ref: SMFAxisRef): number {
    return this.s[this.resolve(ref)];
  }

  set(ref: SMFAxisRef, value: number): this {
    this.s[this.resolve(ref)] = requireFinite(value, 'SMF.set value');
    return this;
  }

  add(ref: SMFAxisRef, delta: number): this {
    const index = this.resolve(ref);
    this.s[index] = requireFinite(this.s[index] + delta, 'SMF.add result');
    return this;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Geometry
  // ─────────────────────────────────────────────────────────────────────────

  /** Euclidean (L2) norm. */
  norm(): number {
    let sum = 0;
    for (let i = 0; i < this.width; i++) sum += this.s[i] * this.s[i];
    return requireFinite(Math.sqrt(sum), 'SMF.norm');
  }

  /** Total energy (squared norm). */
  energy(): number {
    let sum = 0;
    for (let i = 0; i < this.width; i++) sum += this.s[i] * this.s[i];
    return requireFinite(sum, 'SMF.energy');
  }

  /**
   * Scale to unit norm in place. A zero field is left untouched (scaling it
   * would require inventing a direction) and `false` is returned.
   */
  normalize(): boolean {
    const n = this.norm();
    if (n < 1e-12) return false;
    for (let i = 0; i < this.width; i++) this.s[i] = this.s[i] / n;
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
    for (let i = 0; i < this.width; i++) this.s[i] *= factor;
    return this;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Information
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Real Shannon entropy (bits) over the normalized axis-energy distribution
   * `pᵢ = sᵢ² / Σ sⱼ²`. A zero field has no distribution and reports 0.
   * Range: [0, log2(width)].
   *
   * Convention (shared with `normalizedEntropy()`): the distribution is the
   * squared axis components, normalized by their total (`energyDistribution`).
   */
  entropy(): number {
    return requireFinite(shannonEntropyBits(this.energyDistribution()), 'SMF.entropy');
  }

  /**
   * The exact normalization of the SAME distribution used by `entropy()`:
   * `entropy() / log2(width)`, in [0, 1]. Both readouts share the
   * `energyDistribution()` convention, so this is always the normalization of
   * `entropy()`, never a second distribution.
   */
  normalizedEntropy(): number {
    return requireFinite(normalizedEntropy(this.energyDistribution()), 'SMF.normalizedEntropy');
  }

  /** Axis-energy probability distribution used by `entropy()`. */
  energyDistribution(): number[] {
    const energies = new Array<number>(this.width);
    for (let i = 0; i < this.width; i++) energies[i] = this.s[i] * this.s[i];
    return toDistribution(energies);
  }

  /**
   * Top-`n` components ranked by absolute magnitude. The first 16 carry the
   * named `SMF_AXES` metadata; wider fields expose `axis:16`, `axis:17`, ...
   */
  dominantAxes(n = 4): DominantAxis[] {
    const count = clampRange(Math.floor(n), 0, this.width);
    if (count === 0) return [];

    const total = this.energy();
    const ranked: DominantAxis[] = [];
    for (let i = 0; i < this.width; i++) {
      const named = i < SMF_DIMENSION;
      ranked.push({
        index: i,
        name: named ? SMF_AXES[i as SMFAxisIndex].name : `axis:${i}`,
        domain: named ? SMF_AXES[i as SMFAxisIndex].domain : null,
        value: this.s[i],
        energyShare: requireFinite(safeDivide(this.s[i] * this.s[i], total, 0), 'energyShare')
      });
    }

    ranked.sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.index - b.index);
    return ranked.slice(0, count);
  }

  /** L2 magnitude of one semantic domain's slice (the named first-16 view). */
  domainMagnitude(domain: SemanticDomain): number {
    const [start, end] = DOMAIN_RANGES[domain];
    const clampedEnd = Math.min(end, this.width - 1);
    let sum = 0;
    for (let i = start; i <= clampedEnd; i++) sum += this.s[i] * this.s[i];
    return requireFinite(Math.sqrt(sum), 'SMF.domainMagnitude');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Prime activity imprint
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Imprint oscillator activity onto the sketch.
   *
   * With a projection (field constructed with `primeCount`), each oscillator
   * `j` contributes `aⱼ · cos(φⱼ)` through the seeded JL matrix, so every
   * sketch dimension hears every oscillator — no mod-width aliasing.
   *
   * Without a projection (the legacy default), oscillator `j` contributes
   * `aⱼ · cos(φⱼ)` to axis `j mod width`, so the signed axes (emotional
   * valence, causal weight, ...) can go negative as phases drift. Per-axis
   * contributions are averaged (guarded division).
   *
   * Either way the target is blended into the current orientation with an
   * exponential moving average whose rate scales with the observed coherence:
   * an incoherent field barely imprints.
   *
   * @returns the blend rate actually applied.
   */
  updateFromPrimeActivity(sample: PrimeActivitySample, options: PrimeActivityOptions = {}): number {
    const { amplitudes, phases } = sample;
    const count = Math.min(amplitudes.length, phases.length);
    if (count === 0) return 0;

    const targets = new Float64Array(this.width);
    if (this.projection !== null) {
      const x = new Float64Array(count);
      for (let j = 0; j < count; j++) {
        const amplitude = amplitudes[j];
        const phase = phases[j];
        x[j] =
          Number.isFinite(amplitude) && Number.isFinite(phase)
            ? amplitude * Math.cos(phase)
            : 0;
      }
      targets.set(this.projection.project(x));
    } else {
      const sums = new Float64Array(this.width);
      const counts = new Int32Array(this.width);
      for (let j = 0; j < count; j++) {
        const amplitude = amplitudes[j];
        const phase = phases[j];
        if (!Number.isFinite(amplitude) || !Number.isFinite(phase)) continue;
        const axis = j % this.width;
        sums[axis] += amplitude * Math.cos(phase);
        counts[axis] += 1;
      }
      for (let i = 0; i < this.width; i++) {
        targets[i] = safeDivide(sums[i], counts[i], 0);
      }
    }

    const learningRate = clampRange(options.learningRate ?? 0.2, 0, 1);
    const coherence = Number.isFinite(sample.coherence) ? clampRange(sample.coherence, 0, 1) : 0;
    const weighted = options.coherenceWeighted ?? true;
    const alpha = clampRange(weighted ? learningRate * (0.5 + 0.5 * coherence) : learningRate, 0, 1);
    if (alpha === 0) return 0;

    for (let i = 0; i < this.width; i++) {
      this.s[i] = requireFinite((1 - alpha) * this.s[i] + alpha * targets[i], `SMF axis ${i}`);
    }

    return alpha;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Serialization
  // ─────────────────────────────────────────────────────────────────────────

  /** Copy of the sketch components. */
  toArray(): number[] {
    return Array.from(this.s);
  }

  /**
   * Compact q8 fixed-point serialization for trace persistence.
   *
   * A width-128 float64 sketch costs ~3.4 KB as JSON numbers — over the
   * 2048 B/trace footprint gate. q8 keeps the direction (7 bits of relative
   * precision per component) at ~4 bytes per component, so a 128-dim sketch
   * persists in ~520 bytes. Returns integers in [-127, 127] plus the scale
   * factor needed to restore the magnitude.
   */
  static toCompact(values: readonly number[]): { q: number[]; maxAbs: number } {
    let maxAbs = 0;
    for (const v of values) {
      const a = Math.abs(v);
      if (Number.isFinite(a) && a > maxAbs) maxAbs = a;
    }
    if (maxAbs < 1e-12) return { q: values.map(() => 0), maxAbs: 0 };
    const q = values.map((v) => {
      const clamped = Number.isFinite(v) ? v / maxAbs : 0;
      return Math.max(-127, Math.min(127, Math.round(clamped * 127)));
    });
    return { q, maxAbs };
  }

  /** Restore a q8 fixed-point serialization to float components. */
  static fromCompact(q: readonly number[], maxAbs: number): number[] {
    if (!Number.isFinite(maxAbs) || maxAbs <= 0) return Array.from(q).map(() => 0);
    return Array.from(q).map((v) => (v / 127) * maxAbs);
  }

  /** Named-axis keyed view (the first 16 components). */
  toRecord(): Record<string, number> {
    const record: Record<string, number> = {};
    for (const index of AXIS_INDICES) {
      if (index >= this.width) break;
      record[SMF_AXES[index].name] = this.s[index];
    }
    return record;
  }

  toJSON(): SMFSnapshot {
    return { version: 1, components: Array.from(this.s) };
  }

  /**
   * Rebuild from a snapshot. Rejects malformed payloads loudly: wrong
   * version, fewer than the canonical 16 components, or non-finite components
   * all throw (a NaN axis would silently become 0 in the plain constructor,
   * so it is refused here instead of being coerced). Wider snapshots restore
   * at their own width.
   */
  static fromJSON(snapshot: SMFSnapshot, options?: SedenionMemoryFieldOptions): SedenionMemoryField {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.components)) {
      throw new Error('Invalid SMF snapshot: expected { version: 1, components: number[] }');
    }
    if (snapshot.components.length < SMF_DIMENSION) {
      throw new Error(
        `Invalid SMF snapshot: expected at least ${SMF_DIMENSION} components, got ${snapshot.components.length}`
      );
    }
    requireAllFinite(snapshot.components, 'SMF snapshot component');
    return new SedenionMemoryField(snapshot.components, {
      ...options,
      width: options?.width ?? snapshot.components.length
    });
  }

  clone(): SedenionMemoryField {
    return new SedenionMemoryField(this.s, {
      width: this.width,
      ...(this.projectionParams !== null
        ? {
            primeCount: this.projectionParams.primeCount,
            projectionSeed: this.projectionParams.seed,
            projectionDensity: this.projectionParams.density
          }
        : {})
    });
  }

  toString(): string {
    const top = this.dominantAxes(3)
      .map(a => `${a.name}=${a.value.toFixed(3)}`)
      .join(', ');
    return `SMF(norm=${this.norm().toFixed(3)}, H=${this.entropy().toFixed(3)}, ${top})`;
  }
}
