/**
 * Signed Random Projection (Johnson–Lindenstrauss sketch).
 *
 * The 16-axis SMF imprint used to fold oscillators onto axes by position
 * (`axis = j mod 16`): with primeCount = 256 that aliased 16 primes onto each
 * axis and gave the axes no real semantics. This module replaces the fold
 * with a seeded Rademacher (±1) random matrix — a proper JL projection that
 * spreads every oscillator's activity across all sketch dimensions, so the
 * orientation captures the full signature rather than a mod-16 bucket.
 *
 * The matrix is generated deterministically from a seed, so the same field
 * config produces the same sketch on every run (benchmarks reproduce). It is
 * pure math: no dependency on the ESM library.
 */

// ─══════════════════════════════════════════════════════════════════════════
// SEEDED PRNG
// ─══════════════════════════════════════════════════════════════════════════

/**
 * Deterministic mulberry32 PRNG. A seeded projection matrix must reproduce
 * exactly, so the RNG is never Math.random.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─══════════════════════════════════════════════════════════════════════════
// PROJECTION
// ─══════════════════════════════════════════════════════════════════════════

export interface SignedRandomProjectionOptions {
  /** Number of input components (the oscillator count). */
  inputDim: number;
  /** Number of sketch dimensions (the SMF width). */
  outputDim: number;
  /** Determinism seed; the same config always yields the same matrix. */
  seed?: number;
  /**
   * Fraction of non-zero entries per row (default 1 = dense Rademacher).
   * Memory stays dense; this only changes the row sparsity and the
   * normalization, matching the sparse-JL construction.
   */
  density?: number;
}

export class SignedRandomProjection {
  readonly inputDim: number;
  readonly outputDim: number;
  /** Row-major weight matrix: `outputDim × inputDim`, entries in {0, ±1}. */
  private readonly weights: Float32Array;
  /** JL normalization: 1 / sqrt(outputDim · density) — energy-preserving. */
  private readonly scale: number;

  /**
   * Process-wide cache of immutable weight matrices, keyed by
   * `inputDim:outputDim:seed:density`. The matrix is deterministic from the
   * config and never mutated after construction, so instances sharing a
   * config share the matrix: the SMF clones its projection on every
   * teach/observe/recall, and each clone used to regenerate the full matrix
   * (~0.6 ms at the production 256→128 config, ~65k seeded draws). Bounded
   * so unusual configs cannot grow it without limit.
   */
  private static readonly matrixCache = new Map<string, { weights: Float32Array; scale: number }>();
  private static readonly MATRIX_CACHE_MAX = 16;

  constructor(options: SignedRandomProjectionOptions) {
    const inputDim = Math.floor(options.inputDim);
    const outputDim = Math.floor(options.outputDim);
    if (!Number.isInteger(inputDim) || inputDim < 1) {
      throw new Error(`SignedRandomProjection: inputDim must be a positive integer, got ${options.inputDim}`);
    }
    if (!Number.isInteger(outputDim) || outputDim < 1) {
      throw new Error(`SignedRandomProjection: outputDim must be a positive integer, got ${options.outputDim}`);
    }
    const density = options.density === undefined ? 1 : options.density;
    if (!Number.isFinite(density) || density <= 0 || density > 1) {
      throw new Error(`SignedRandomProjection: density must be in (0, 1], got ${density}`);
    }
    const seed = options.seed ?? 0x5eed;

    const key = `${inputDim}:${outputDim}:${seed}:${density}`;
    const cached = SignedRandomProjection.matrixCache.get(key);
    if (cached !== undefined) {
      this.inputDim = inputDim;
      this.outputDim = outputDim;
      this.weights = cached.weights;
      this.scale = cached.scale;
      return;
    }

    this.inputDim = inputDim;
    this.outputDim = outputDim;
    this.weights = new Float32Array(outputDim * inputDim);
    const rng = mulberry32(seed);
    for (let i = 0; i < outputDim * inputDim; i++) {
      if (rng() < density) {
        this.weights[i] = rng() < 0.5 ? -1 : 1;
      }
    }
    // Energy-preserving scale for the zeroed-dense Rademacher construction:
    // E[||y||²] = outputDim · scale² · density · ||x||² = ||x||² when
    // scale = 1/sqrt(outputDim · density). The row count is what concentrates
    // the sketch, not the input width.
    this.scale = 1 / Math.sqrt(Math.max(1, outputDim) * density);

    SignedRandomProjection.matrixCache.set(key, { weights: this.weights, scale: this.scale });
    if (SignedRandomProjection.matrixCache.size > SignedRandomProjection.MATRIX_CACHE_MAX) {
      const oldest = SignedRandomProjection.matrixCache.keys().next().value;
      if (oldest !== undefined) SignedRandomProjection.matrixCache.delete(oldest);
    }
  }

  /**
   * Project an input vector onto the sketch: `y[i] = scale · Σⱼ W[i][j] · x[j]`.
   *
   * Non-finite inputs contribute zero (the caller's activity filter), and the
   * input may be shorter than `inputDim` (missing components are zero).
   */
  project(x: ArrayLike<number>): Float64Array {
    const out = new Float64Array(this.outputDim);
    const n = Math.min(x.length, this.inputDim);
    for (let i = 0; i < this.outputDim; i++) {
      const row = i * this.inputDim;
      let sum = 0;
      for (let j = 0; j < n; j++) {
        const value = x[j];
        if (value === 0 || !Number.isFinite(value)) continue;
        const w = this.weights[row + j];
        if (w === 0) continue;
        sum += w * value;
      }
      out[i] = sum * this.scale;
    }
    return out;
  }
}
