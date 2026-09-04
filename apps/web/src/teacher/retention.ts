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

import { clampRange } from '@sschepis/sentient-core';

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
 * forgetting horizon is written down. With the §5.2 row 4 flag on, each
 * preset reads the store's OWN learned stability instead (D.5): the preset
 * is the PRIOR, and every recorded retrieval outcome updates it under the
 * FSRS update law — exactly how per-word stability is learned.
 */
export const STABILITY_PRESETS = {
  /** Composition n-gram transition weights: fluency fades without practice,
   *  slowly (≈10% at 45 days unused). */
  get ngramWeightDays(): number {
    return effectiveStoreStabilityDays('ngramWeight');
  },
  /** Learned drive (behavior) weights: ancient wins stop dominating after a
   *  season without fresh outcomes. */
  get driveWeightDays(): number {
    return effectiveStoreStabilityDays('driveWeight');
  },
  /** Non-word traces (conversation/creative/gap/belief) — the default the
   *  bank's retention decay applies when no per-word FSRS state exists
   *  (= FSRS_INITIAL_STABILITY × 7, the pre-L3 constant, unchanged). */
  get nonWordTraceDays(): number {
    return effectiveStoreStabilityDays('nonWordTrace');
  },
  /** A learned rule's world credit expires after this long unused (the R16
   *  horizon, expressed as the stability whose due-interval it is). */
  get ruleCorroborationDays(): number {
    return effectiveStoreStabilityDays('ruleCorroboration');
  }
};

// ────────────────────────────────────────────────────────────────────────────
// D.5 (§5.2 row 4) — per-store stability learned from retrieval successes
// ────────────────────────────────────────────────────────────────────────────

/** The learned stores whose decay horizon self-tunes. */
export type StoreKind = 'ngramWeight' | 'driveWeight' | 'nonWordTrace' | 'ruleCorroboration';

export const STORE_KINDS: readonly StoreKind[] = ['ngramWeight', 'driveWeight', 'nonWordTrace', 'ruleCorroboration'];

/** The presets ARE the priors — the CONTROL values every learned stability
 *  starts from and falls back to while its flag is off. */
const STORE_PRESET_DAYS: Record<StoreKind, number> = {
  ngramWeight: 45,
  driveWeight: 90,
  nonWordTrace: 7,
  ruleCorroboration: 30
};

/**
 * Mirrors of the FSRS scheduler's update-law constants (fsrs.ts) — kept
 * local so the store learner can live beside the presets without an import
 * cycle. The storeStability bench asserts BEHAVIORAL parity: a store update
 * reproduces the wordloop's update exactly when both run the same constants.
 */
const LEARN_OVERDUE_BONUS = 1; // = FSRS_OVERDUE_BONUS
const LEARN_DIFFICULTY_SCALE = 8; // = FSRS_DIFFICULTY_SCALE
const LEARN_INITIAL_DIFFICULTY = 5; // = FSRS_INITIAL_DIFFICULTY
const LEARN_LAPSE_FLOOR = 0.05;
const LEARN_LAPSE_CAP = 0.5;

/** Per-store enable flags — ALL OFF by default (the preset is the CONTROL;
 *  a store switches to its learned stability only behind its bench). */
export const STORE_STABILITY_FLAGS: Record<StoreKind, boolean> = {
  ngramWeight: false,
  driveWeight: false,
  nonWordTrace: false,
  ruleCorroboration: false
};

/** Enable/disable one store's learned stability. */
export function setStoreStabilityLearned(kind: StoreKind, enabled: boolean): void {
  STORE_STABILITY_FLAGS[kind] = enabled;
}

/** Reset every store flag behind its control (the constants report's state). */
export function resetStoreStabilityLearned(): void {
  for (const kind of STORE_KINDS) STORE_STABILITY_FLAGS[kind] = false;
}

interface StoreStabilityState {
  stability: number;
  difficulty: number;
  successes: number;
  failures: number;
}

const storeStates = new Map<StoreKind, StoreStabilityState>();

function stateOf(kind: StoreKind): StoreStabilityState {
  let state = storeStates.get(kind);
  if (state === undefined) {
    state = {
      stability: STORE_PRESET_DAYS[kind],
      difficulty: LEARN_INITIAL_DIFFICULTY,
      successes: 0,
      failures: 0
    };
    storeStates.set(kind, state);
  }
  return state;
}

/**
 * Record one retrieval outcome for a store and apply the FSRS update law
 * EXACTLY as the scheduler learns per-word stability (wordloop): a success
 * stretches stability by the e^(−D/8) gain plus the surprise-scaled overdue
 * bonus; a failure keeps clamp(1 − R, 0.05, 0.5) of it — a crammed failure
 * collapses hardest, an overdue one already forgot. Returns the store's new
 * stability (days).
 */
export function recordStoreOutcome(kind: StoreKind, success: boolean, retrieval: number): number {
  const state = stateOf(kind);
  const r = clampRange(retrieval, 0.01, 1);
  if (success) {
    const retrievalEff = Math.min(r / FSRS_TARGET_RETENTION, 1);
    const gain = (1 + LEARN_OVERDUE_BONUS * (1 - retrievalEff)) * Math.exp(-state.difficulty / LEARN_DIFFICULTY_SCALE);
    state.stability *= 1 + gain;
    state.difficulty = Math.max(1, state.difficulty - 0.1);
    state.successes += 1;
  } else {
    const keep = clampRange(1 - r, LEARN_LAPSE_FLOOR, LEARN_LAPSE_CAP);
    state.stability = Math.max(0.01, state.stability * keep);
    state.difficulty = Math.min(10, state.difficulty + 0.4);
    state.failures += 1;
  }
  return state.stability;
}

/** The store's learned stability (days), or null before any outcome. */
export function storeStabilityDays(kind: StoreKind): number | null {
  const state = storeStates.get(kind);
  return state === undefined ? null : state.stability;
}

/** The store's learned state — the evidence mass the constants report logs. */
export function storeStabilityEvidence(kind: StoreKind): {
  successes: number;
  failures: number;
  stability: number;
  difficulty: number;
} | null {
  const state = storeStates.get(kind);
  return state === undefined
    ? null
    : { successes: state.successes, failures: state.failures, stability: state.stability, difficulty: state.difficulty };
}

/**
 * The LIVE stability a store's consumers read: the store's learned value
 * when its flag is on, else the preset (the control). Every consumer reads
 * this through STABILITY_PRESETS, so one flag moves them all together.
 */
export function effectiveStoreStabilityDays(kind: StoreKind): number {
  if (STORE_STABILITY_FLAGS[kind]) {
    const learned = storeStabilityDays(kind);
    if (learned !== null) return learned;
  }
  return STORE_PRESET_DAYS[kind];
}

/** Forget every learned store state (tests, or a re-baseline). */
export function resetStoreStability(): void {
  storeStates.clear();
}
