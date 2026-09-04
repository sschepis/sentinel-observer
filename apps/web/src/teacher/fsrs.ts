/**
 * THE FSRS SCHEDULER MODULE (Phase 24.2 — extracted from TeacherAgent).
 *
 * P9: per-item difficulty/stability learned from the observer's own review
 * history: strength IS the model's retention prediction, and the schedule is
 * dueAt = now + interval (the stability that decays to target retention).
 * L1a (Phase 17): the updates are SURPRISE-SCALED — the model's own
 * prediction at review time is the surprise signal (see reviewRetrievability
 * and the grade() update in TeacherAgent).
 *
 * The forgetting CURVE itself is the one law (retention.ts); this module
 * holds the scheduler's constants and the trace-decay application.
 */
import { retentionProbability, STABILITY_PRESETS } from './retention';
import { clampRange, normalizedEntropy, toDistribution } from '@sschepis/sentient-core';

/** Initial stability (days) of a freshly taught word. */
export const FSRS_INITIAL_STABILITY = 1;
/** Initial difficulty in [1, 10] — mid, the observer has no evidence yet. */
export const FSRS_INITIAL_DIFFICULTY = 5;
/**
 * L1a (Phase 17.2): THE SUCCESS GAIN IS SURPRISE-SCALED. R_eff = R/target,
 * clamped to at most 1: 1 at (or before) the due date, <1 for an overdue
 * review. The stability multiplier on a correct recall is
 *
 *     gain = e^(−D/8) · (1 + FSRS_OVERDUE_BONUS · (1 − R_eff))
 *
 * — at or before the due date the gain is exactly the pre-L1a growth
 * (e^(−D/8), ≈ 0.535 at mid difficulty: every consolidation gate keeps its
 * meaning), and it RISES as the review runs overdue: a correct recall of a
 * word the model predicted nearly gone (R_eff → 0) earns up to double — the
 * genuinely surprising rescue is the one that stretches stability most.
 * An early (crammed) review earns no bonus, and cramming buys no schedule
 * advantage: the cram signal lives on the LAPSE side (17.3), where an early
 * failure collapses hardest.
 */
export const FSRS_OVERDUE_BONUS = 1;
/** Difficulty scale of the success gain (e^(−D/scale)). */
export const FSRS_DIFFICULTY_SCALE = 8;
/** Stability (days) beyond which a word reads as consolidated. */
export const FSRS_CONSOLIDATED_STABILITY = 30;

/**
 * Candidate-distribution entropy of a ranked recall: the normalized Shannon
 * entropy of the recall scores treated as a distribution over candidates
 * (abs-magnitude weights, the same convention as the SMF's own entropy).
 * A flat distribution — no clear winner — reads 1; a single dominant
 * candidate reads 0. A list of fewer than two candidates carries no
 * uncertainty and reads 0.
 */
export function candidateDistributionEntropy(scores: readonly number[]): number {
  if (scores.length < 2) return 0;
  return normalizedEntropy(toDistribution(scores));
}

/**
 * Store-time surprise (Phase C.1 / §4.1): how poorly the bank predicts a new
 * stimulus, measured from the recall of the word's cue that precedes storage.
 *
 * Two complementary readings of the ranked candidate list, both in [0, 1]:
 *   · 1 − best-recall-score — how far the bank's best guess is from a perfect
 *     prediction (the dominant signal);
 *   · candidate-distribution entropy — how indecisive the bank is (a flat
 *     list means no clear winner, so the bank is genuinely uncertain).
 *
 * Surprise averages the two. An EMPTY candidate list is not a failed
 * prediction — the bank made no prediction at all — so it carries no surprise
 * signal and reads as neutral (0.5), keeping the fixed initial stability for
 * the first word stored into an empty bank.
 */
export function storeSurprise(scores: readonly number[]): number {
  if (scores.length === 0) return 0.5;
  const best = clampRange(Math.max(0, ...scores), 0, 1);
  return clampRange(0.5 * (1 - best) + 0.5 * candidateDistributionEntropy(scores), 0, 1);
}

/**
 * Initial stability (days) mapped from store-time surprise, anchored at the
 * fixed default: surprise = 0.5 reproduces today's FSRS_INITIAL_STABILITY (a
 * stimulus the bank half-predicts stores exactly as before). A near-duplicate
 * (surprise → 0) halves it; an unpredicted stimulus (surprise → 1) doubles
 * it. Bounded to a ×½–×2 window around the default — the success/failure
 * update curves are untouched.
 */
export function surpriseInitialStability(surprise: number): number {
  const s = clampRange(surprise, 0, 1);
  return FSRS_INITIAL_STABILITY * Math.pow(2, 2 * s - 1);
}

/**
 * L1a (Phase 17.1): the retrievability of a word AT REVIEW TIME — the
 * model's prediction that the word would have been recalled before this
 * review happened. Elapsed time runs from the last review attempt
 * (lastAskedAt; fall back to taughtAt before the first review), so a word
 * reviewed immediately after teaching reads R ≈ 1 (cram) and a word that
 * sat past its due interval reads R below the target — the "how surprised
 * should the update be" signal the L1a gains and collapses are scaled by.
 */
export function reviewRetrievability(state: {
  stability: number;
  lastAskedAt: number | null;
  taughtAt: number | null;
}, now = Date.now()): number {
  const anchor = state.lastAskedAt ?? state.taughtAt;
  const elapsedDays = anchor === null ? 0 : Math.max(0, now - anchor) / (24 * 60 * 60 * 1000);
  return clampRange(retentionProbability(state.stability, elapsedDays), 0.01, 1);
}

/** The per-trace FSRS parameters the retention decay reads. */
export interface RetentionParams {
  stability: number;
  difficulty: number;
}

/**
 * P9 wall-clock forgetting: every trace's strength becomes the MODEL's
 * prediction — retentionProbability(S, elapsed) — replacing the tiered
 * half-life curve. Word traces decay on their per-word FSRS stability; other
 * traces (conversation/creative/gap/belief) use the non-word stability
 * preset so taught phrases still forget on a human timescale.
 *
 * `rate` scales stability: 2 forgets half as fast, 0.5 twice as fast.
 */
export function applyRetentionDecay(
  traces: Iterable<{ id: string; lastAccessAt: number; strength: number }>,
  params: (traceId: string) => RetentionParams | null,
  now = Date.now(),
  rate = 1
): void {
  const DAY = 24 * 60 * 60 * 1000;
  const scale = Math.max(0.01, rate);
  for (const trace of traces) {
    const p = params(trace.id);
    const stability = p !== null ? Math.max(0.01, p.stability * scale) : STABILITY_PRESETS.nonWordTraceDays;
    const elapsed = Math.max(0, now - trace.lastAccessAt);
    trace.strength = clampRange(retentionProbability(stability, elapsed / DAY), 0.01, 1);
  }
}
