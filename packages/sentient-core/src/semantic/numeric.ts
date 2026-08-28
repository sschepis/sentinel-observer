/**
 * Numeric Guards
 *
 * Small, dependency-free numeric helpers shared by the semantic engine.
 *
 * The legacy JS engine returned `NaN` and hardcoded placeholder values (0.5,
 * 1.0) from a dozen different code paths, which made every downstream metric
 * meaningless. Every numeric result produced by this package therefore passes
 * through an explicit finiteness assertion instead of being silently clamped
 * or defaulted.
 */

// ═══════════════════════════════════════════════════════════════════════════
// ERRORS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Thrown when a computation produces a non-finite value.
 *
 * This is deliberately fatal: a NaN metric is a bug, not a value to be
 * substituted with a plausible-looking constant.
 */
export class NonFiniteValueError extends Error {
  readonly label: string;
  readonly value: number;

  constructor(label: string, value: number) {
    super(`Non-finite value for "${label}": ${String(value)}`);
    this.name = 'NonFiniteValueError';
    this.label = label;
    this.value = value;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ASSERTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Assert that a value is a finite number and return it unchanged.
 */
export function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new NonFiniteValueError(label, value);
  }
  return value;
}

/**
 * Assert that every element of an array is finite and return the array.
 */
export function requireAllFinite(values: readonly number[], label: string): readonly number[] {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new NonFiniteValueError(`${label}[${i}]`, values[i]);
    }
  }
  return values;
}

// ═══════════════════════════════════════════════════════════════════════════
// GUARDED ARITHMETIC
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Division that returns an explicit fallback when the denominator is
 * effectively zero. The fallback is a *structural* value (typically 0), never
 * a fabricated metric.
 */
export function safeDivide(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return fallback;
  if (Math.abs(denominator) < 1e-300) return fallback;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : fallback;
}

/**
 * Clamp a value into an inclusive range.
 *
 * Non-finite input is a bug, not a value to be coerced into the range
 * minimum: that would fabricate a plausible-looking metric. It throws
 * `NonFiniteValueError` instead, matching the fail-loud contract of this
 * module.
 */
export function clampRange(value: number, min: number, max: number): number {
  requireFinite(value, 'clampRange value');
  return value < min ? min : value > max ? max : value;
}

// ═══════════════════════════════════════════════════════════════════════════
// INFORMATION THEORY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Shannon entropy in bits over a probability vector.
 *
 * Uses the same `p > 1e-10` guard as `tinyaleph.shannonEntropy` so that the
 * two implementations agree bit-for-bit (asserted in the test suite).
 */
export function shannonEntropyBits(probabilities: readonly number[]): number {
  let h = 0;
  for (const p of probabilities) {
    if (p > 1e-10) h -= p * Math.log2(p);
  }
  return requireFinite(h, 'shannonEntropyBits');
}

/**
 * Convert non-negative weights into a probability distribution.
 * Returns an all-zero vector when the total weight is zero (no fabrication of
 * a uniform distribution, which would imply maximum entropy for empty input).
 */
export function toDistribution(weights: readonly number[]): number[] {
  let total = 0;
  for (const w of weights) total += Math.abs(w);
  if (total < 1e-300) return weights.map(() => 0);
  return weights.map(w => Math.abs(w) / total);
}

/**
 * Normalized Shannon entropy in [0, 1] for a distribution over `n` outcomes.
 * Returns 0 when `n < 2` (a single outcome carries no uncertainty).
 *
 * This is the exact normalization of `shannonEntropyBits` over the SAME
 * distribution: `shannonEntropyBits(p) / log2(n)`.
 */
export function normalizedEntropy(probabilities: readonly number[]): number {
  const n = probabilities.length;
  if (n < 2) return 0;
  const h = shannonEntropyBits(probabilities);
  return clampRange(safeDivide(h, Math.log2(n), 0), 0, 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// GEOMETRY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cosine similarity with overflow and underflow guards.
 *
 * Both vectors are scaled by their max |component| before the dot product, so
 * huge finite inputs (e.g. 1e200) cannot overflow the sums to Infinity/NaN and
 * tiny finite inputs (e.g. 1e-200) cannot underflow them to 0. A zero vector
 * scores 0 against everything. Non-finite components throw
 * `NonFiniteValueError` (they would otherwise poison the max-scan).
 */
export function stableCosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let maxA = 0;
  let maxB = 0;
  for (const v of a) {
    if (!Number.isFinite(v)) throw new NonFiniteValueError('stableCosineSimilarity a', v);
    const av = Math.abs(v);
    if (av > maxA) maxA = av;
  }
  for (const v of b) {
    if (!Number.isFinite(v)) throw new NonFiniteValueError('stableCosineSimilarity b', v);
    const av = Math.abs(v);
    if (av > maxB) maxB = av;
  }
  if (maxA === 0 || maxB === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const aa = a[i] / maxA; // |aa| <= 1: no overflow in the products below
    const bb = b[i] / maxB;
    dot += aa * bb;
    normA += aa * aa;
    normB += bb * bb;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return dot / denominator;
}
