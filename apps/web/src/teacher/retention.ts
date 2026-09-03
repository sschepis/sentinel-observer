/**
 * THE ONE RETENTION LAW (L3, Phase 19.4).
 *
 * Everything the observer learns is a trace with a strength and a stability,
 * and there is exactly ONE forgetting curve — the FSRS v4 retention law:
 *
 *     R(t; S) = (1 + (19/81) · t/S)^(−1/2)
 *
 * — R(0) = 1, R(S) = the target retention (0.9), monotone decreasing.
 * Word traces read their per-word FSRS stability; every other learned thing
 * (conversation/creative/gap/belief traces, composition n-gram weights,
 * drive weights, rule corroboration horizons) reads a per-kind stability
 * preset from this module. No second decay curve exists (the legacy tiered
 * half-life `applyTimeDecay` was deleted in Phase 19.1).
 */

/** Target retention at review time: the due interval solves R(interval) = this. */
export const FSRS_TARGET_RETENTION = 0.9;

/** The FSRS v4 forgetting-curve constant (19/81). */
export const FSRS_FORGETTING_FACTOR = 19 / 81;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The FSRS v4 forgetting curve: the probability a memory is retained after
 * `elapsedDays` given stability S (days).
 */
export function retentionProbability(stabilityDays: number, elapsedDays: number): number {
  if (stabilityDays <= 0) return 0;
  const ratio = elapsedDays / stabilityDays;
  return Math.pow(1 + FSRS_FORGETTING_FACTOR * ratio, -0.5);
}

/** The review interval (days) whose retention is `retention` — the inversion
 *  of the forgetting curve. At the target 0.9, interval ≈ stability. */
export function dueIntervalDays(stabilityDays: number, retention = FSRS_TARGET_RETENTION): number {
  if (stabilityDays <= 0) return 0;
  return (stabilityDays * (Math.pow(retention, -2) - 1)) / FSRS_FORGETTING_FACTOR;
}

/**
 * Decay a learned scalar toward a floor under the one law:
 * `value' = floor + (value − floor) · R(elapsed; stability)`.
 * Used by every non-trace learned quantity (n-gram weights, drive weights).
 */
export function decayToward(value: number, floor: number, elapsedMs: number, stabilityDays: number): number {
  if (!(elapsedMs > 0) || !(stabilityDays > 0)) return value;
  const r = retentionProbability(stabilityDays, elapsedMs / DAY_MS);
  return floor + (value - floor) * r;
}

/**
 * Per-kind stability presets (days) — the ONLY place a learned kind's
 * forgetting horizon is written down.
 */
export const STABILITY_PRESETS = {
  /** Composition n-gram transition weights: fluency fades without practice,
   *  slowly (≈10% at 45 days unused). */
  ngramWeightDays: 45,
  /** Learned drive (behavior) weights: ancient wins stop dominating after a
   *  season without fresh outcomes. */
  driveWeightDays: 90,
  /** Non-word traces (conversation/creative/gap/belief) — the default the
   *  bank's retention decay applies when no per-word FSRS state exists
   *  (= FSRS_INITIAL_STABILITY × 7, the pre-L3 constant, unchanged). */
  nonWordTraceDays: 7,
  /** A learned rule's world credit expires after this long unused (the R16
   *  horizon, expressed as the stability whose due-interval it is). */
  ruleCorroborationDays: 30
} as const;
