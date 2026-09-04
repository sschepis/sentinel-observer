/**
 * Slow Context Field (E.2 / improvements.md §6.2)
 *
 * The fast field (oscillators + SMF sketch) fully decays within one settle:
 * the companion paper measured nothing of the previous turn survives in the
 * field to prime the next, so working memory (a ring of recent text) is the
 * only symbolic substitute. This module is the SECOND timescale the priming
 * proposal asks for: a context accumulator that integrates once per TURN
 * (per settle) — never per tick — and decays over turns, not ticks, so a cue
 * that would be ambiguous in isolation is biased toward the reading the
 * conversation has been about. Priming happens IN the field, before the
 * operator layers see the question.
 *
 * DECAY IS MEASURED, NOT SET. The per-turn decay factor is the ONE retention
 * law — the FSRS v4 forgetting curve. This module is dependency-free core and
 * cannot import the web package, so the curve is mirrored here from
 * `apps/web/src/teacher/retention.ts` (the single source of the law; the
 * constant 19/81 and the −1/2 exponent are architectural, registered there
 * under class 'values'):
 *
 *     R(t; S) = (1 + (19/81) · t/S)^(−1/2)
 *
 * with t = elapsed turns and S = `stabilityTurns` — a TUNING constant (not a
 * free knob), registered in the app's constants registry. One turn elapsed at
 * stability S = 1 retains R = 0.9, the law's target retention. The
 * integration rate and the recall-cue blend weight are the remaining
 * tunables, both bounded.
 *
 * CONTAMINATION GUARD: the blend into the recall cue is a DIRECTION tilt of
 * at most `blendWeight` (clamped to [0, 0.5]) — the context adds a vector of
 * at most `weight · |cue|` magnitude, and the blended cue keeps the original
 * cue's norm, so only the direction moves. A cue whose trace set has a
 * decisive overlap term cannot be flipped by a small bounded tilt; the
 * priming-bench asserts exactly that (contamination 0 on unrelated probes).
 *
 * FLAG OFF = BIT-IDENTICAL CONTROL: the observer only constructs this field
 * when `SemanticObserverOptions.slowContext` is set; nothing here runs
 * otherwise.
 */

import { SedenionMemoryField, SMF_DIMENSION } from './SedenionMemoryField';
import type { PrimeActivitySample } from './SedenionMemoryField';
import { clampRange, requireFinite } from './numeric';

// ═══════════════════════════════════════════════════════════════════════════
// THE ONE RETENTION LAW (mirrored from apps/web/src/teacher/retention.ts)
// ═══════════════════════════════════════════════════════════════════════════

/** The FSRS v4 forgetting-curve constant (19/81). */
export const SLOW_CONTEXT_FORGETTING_FACTOR = 19 / 81;

/** The retention-curve exponent (−1/2). */
export const SLOW_CONTEXT_RETENTION_EXPONENT = -0.5;

/**
 * The retention law's value after `elapsedTurns` turns at stability
 * `stabilityTurns` (turns): `R(t; S) = (1 + (19/81)·t/S)^(−1/2)`.
 * R(0) = 1; R(S; S) = the target retention 0.9; monotone decreasing.
 */
export function slowContextRetention(stabilityTurns: number, elapsedTurns: number): number {
  if (!Number.isFinite(stabilityTurns) || stabilityTurns <= 0) return 0;
  if (!Number.isFinite(elapsedTurns) || elapsedTurns <= 0) return 1;
  const ratio = elapsedTurns / stabilityTurns;
  const value = Math.pow(1 + SLOW_CONTEXT_FORGETTING_FACTOR * ratio, SLOW_CONTEXT_RETENTION_EXPONENT);
  return requireFinite(value, 'slowContextRetention');
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Defaults for the slow context. The stability (in TURNS) and the blend
 * weight are tuning constants — registered in the app's constants registry
 * (class 'tuning') — not free knobs; the values here are the hand constants
 * the tuning evidence may later move.
 */
export const SLOW_CONTEXT_DEFAULTS = {
  /** Retention stability in turns: the per-turn decay factor is R(1; S). */
  stabilityTurns: 2,
  /** Direction tilt of the context into the recall cue (clamped to [0, 0.5]). */
  blendWeight: 0.15,
  /** EMA rate at which a turn's converged excitation integrates. */
  learningRate: 0.5
} as const;

/** Hard cap on the recall-cue blend weight — a tilt, never an override. */
export const MAX_SLOW_CONTEXT_BLEND_WEIGHT = 0.5;

/** Construction options. */
export interface SlowContextFieldOptions {
  /** Sketch width (default `SMF_DIMENSION` = 16, the named axes). */
  width?: number;
  /**
   * Oscillator count of the field the context imprints from. When given, the
   * imprint uses the same seeded signed random projection as the SMF, so the
   * context lives in the same sketch space as the cue it is blended into.
   */
  primeCount?: number;
  /** Determinism seed for the projection matrix (default 0x5eed). */
  projectionSeed?: number;
  /** Non-zero density of the projection rows in (0, 1] (default 1). */
  projectionDensity?: number;
  /**
   * Retention stability in TURNS for the one retention law. The per-turn
   * decay factor is `slowContextRetention(stabilityTurns, 1)` — the retention
   * the context keeps after one turn elapsed. A tuning constant (default 2).
   */
  stabilityTurns?: number;
  /**
   * The slow context's contribution to the recall cue, as a fraction of the
   * cue's own magnitude (default 0.15, clamped to [0, 0.5]). The blend only
   * tilts the cue's DIRECTION; its norm is preserved.
   */
  blendWeight?: number;
  /**
   * EMA rate at which a turn's converged excitation integrates into the
   * context (default 0.5, clamped to [0, 1]).
   */
  learningRate?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// FIELD
// ═══════════════════════════════════════════════════════════════════════════

export class SlowContextField {
  /** The context sketch, in the same space as the observer's SMF. */
  private readonly field: SedenionMemoryField;
  private readonly stabilityTurns: number;
  private readonly learningRate: number;
  private readonly blendWeightValue: number;
  /** Settles (turns) integrated so far. */
  private turns = 0;

  constructor(options: SlowContextFieldOptions = {}) {
    const stability = options.stabilityTurns ?? SLOW_CONTEXT_DEFAULTS.stabilityTurns;
    if (!Number.isFinite(stability) || stability <= 0) {
      throw new Error(`SlowContextField: stabilityTurns must be a positive finite number, got ${stability}`);
    }
    const blend = options.blendWeight ?? SLOW_CONTEXT_DEFAULTS.blendWeight;
    if (!Number.isFinite(blend) || blend < 0 || blend > MAX_SLOW_CONTEXT_BLEND_WEIGHT) {
      throw new Error(
        `SlowContextField: blendWeight must be in [0, ${MAX_SLOW_CONTEXT_BLEND_WEIGHT}], got ${blend}`
      );
    }
    const rate = options.learningRate ?? SLOW_CONTEXT_DEFAULTS.learningRate;
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new Error(`SlowContextField: learningRate must be in [0, 1], got ${rate}`);
    }

    this.stabilityTurns = stability;
    this.blendWeightValue = blend;
    this.learningRate = rate;
    this.field = SedenionMemoryField.zero({
      width: options.width ?? SMF_DIMENSION,
      ...(options.primeCount !== undefined && options.primeCount > 0
        ? {
            primeCount: Math.floor(options.primeCount),
            projectionSeed: options.projectionSeed,
            projectionDensity: options.projectionDensity
          }
        : {})
    });
  }

  /** The retention the context keeps after ONE turn elapsed: R(1; S). */
  retentionPerTurn(): number {
    return slowContextRetention(this.stabilityTurns, 1);
  }

  /** The configured recall-cue blend weight (bounded at construction). */
  get blendWeight(): number {
    return this.blendWeightValue;
  }

  /** Settles (turns) integrated so far. */
  get turnCount(): number {
    return this.turns;
  }

  /** The context sketch's L2 norm (0 = empty context). */
  norm(): number {
    return this.field.norm();
  }

  /** Copy of the context sketch components. */
  toArray(): number[] {
    return this.field.toArray();
  }

  /** The raw context sketch (read-only use; clone before mutating). */
  sketch(): SedenionMemoryField {
    return this.field;
  }

  /**
   * Integrate one turn into the context: the context first decays by exactly
   * one turn under the retention law (measured rate, `retentionPerTurn()`),
   * then the turn's converged excitation is EMA-blended in at
   * `learningRate`. Called ONCE per turn (per settle), never per tick.
   *
   * @returns the blend rate actually applied.
   */
  integrateTurn(sample: PrimeActivitySample): number {
    this.turns += 1;
    // One turn elapsed: every existing component retains R(1; S).
    this.field.decay(1 - this.retentionPerTurn());
    // The turn's converged moment imprints at the integration rate. The
    // blend is NOT coherence-weighted (the moment has already converged;
    // a quiescent turn contributes nothing and dilutes the context, which
    // is the honest reading of a blank turn).
    return this.field.updateFromPrimeActivity(sample, {
      learningRate: this.learningRate,
      coherenceWeighted: false
    });
  }

  /**
   * Blend the context into a recall cue: `cue + w·|cue|·(context/|context|)`.
   *
   * The context contributes a vector of at most `w·|cue|` magnitude — a
   * bounded DIRECTION tilt (max angle ≈ atan(w)) — and the blended cue keeps
   * the original cue's norm, so the magnitude never moves. An empty context
   * (norm 0) leaves the cue untouched.
   *
   * @returns a new field; `cue` is never mutated.
   */
  blendInto(cue: SedenionMemoryField, weight: number = this.blendWeightValue): SedenionMemoryField {
    const blended = cue.clone();
    const w = clampRange(weight, 0, MAX_SLOW_CONTEXT_BLEND_WEIGHT);
    const cueNorm = cue.norm();
    const contextNorm = this.field.norm();
    if (w === 0 || cueNorm < 1e-12 || contextNorm < 1e-12) return blended;

    // The context's contribution is scaled to the CUE's magnitude: the blend
    // is a tilt of at most atan(w) in direction, never a magnitude change.
    const scale = (cueNorm * w) / contextNorm;
    for (let i = 0; i < Math.min(blended.width, this.field.width); i++) {
      blended.set(i, blended.get(i) + scale * this.field.get(i));
    }
    const blendedNorm = blended.norm();
    if (blendedNorm > 1e-12) {
      const restore = cueNorm / blendedNorm;
      for (let i = 0; i < blended.width; i++) blended.set(i, blended.get(i) * restore);
    }
    return blended;
  }

  /** Clear the context and the turn counter (a fresh conversation). */
  reset(): void {
    for (let i = 0; i < this.field.width; i++) this.field.set(i, 0);
    this.turns = 0;
  }
}
