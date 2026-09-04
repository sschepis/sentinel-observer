/**
 * CANDIDATE-DISTRIBUTION ENTROPY (improvements.md §2) — the unifying instrument.
 *
 * Every arbitration point in the observer today compares a TOP score against a
 * fixed threshold and discards the distribution over the candidates it already
 * computed. This module exposes that distribution as one reading:
 *
 *   p_i = s_i / Σ_j s_j          (non-negative scores, normalized)
 *   H̃   = −Σ p_i log p_i / log k   (normalized entropy in [0, 1])
 *   H̃_k = H̃ over the retained top-k (k ∈ {2, 3, 5, 8})
 *   m    = (s₁ − s₂) / s₁          (top-two margin)
 *   m₂₃  = (s₂ − s₃) / s₂          (second-to-third margin)
 *
 * H̃ is k-normalized so it is comparable across decision points with different
 * candidate counts. Neither H̃ nor the margins require a temperature or any new
 * constant — p is a normalization of scores the system already has.
 *
 * H̃_k (top-k entropy) is the k-robust variant: when a decision point admits a
 * long tail of near-zero candidates (the recall prefilter admits k ≈ 100–750),
 * the full-set H̃ saturates near 1 for every cue — the tail's contribution to
 * the denominator log k washes out the shape of the head. H̃_k reads only the
 * retained top-k candidates, which is also exactly the slice the §2.2
 * disambiguating ask can NAME ("Do you mean X or Y?" needs the top two, and
 * nothing more). §2.2 regime 2 is "only possible if the top-k is retained":
 * H̃_k is the regime-2 reading of the distribution.
 *
 * ROUTING RULE (§2.2). Three regimes, with boundaries that §5 proposes to
 * CALIBRATE rather than fix:
 *   · LOW H̃ (one dominant candidate)         → answer from it.
 *   · HIGH H̃ with a LARGE m₂₃ (two dominant)  → ask a disambiguating question
 *     that names both top candidates.
 *   · FLAT H̃ (no dominant candidate)          → ask plainly, as today.
 *
 * MEASURED OUTCOME (cde-bench, Phase A): the routing rule FAILED its §2.4
 * gate and is NOT built. On the fuzz bench the full-set H̃ is pure noise
 * (AUC 0.510 — k-normalization over the 100–750-candidate tail saturates it
 * near 1 for every cue) and the top-k / margin variants, while carrying
 * signal, all sit BELOW the top score (best: AUC(1 − H̃₃) = 0.779 vs.
 * AUC(top) = 0.912). Per §11 ("the instrument may be empty"), the
 * disambiguating-ask routing must not be built from this instrument; each
 * downstream use needs its own bench. The margins DO separate the clear and
 * flat classes (adversarial m ≤ 0.044 vs. exact recall m ≥ 0.293) — that
 * separation calibrated the regime thresholds below — but regime labels are
 * measurement only: nothing in this module (or the system) routes on them.
 *
 * The regime thresholds are TUNING CONSTANTS (§5): `topTwoMargin` is
 * calibrated from `cde-bench`; `topTwoThreeMargin` stays a placeholder until
 * a two-dominant-candidate corpus exists. Nothing in this module routes on
 * the regime; it only computes the reading.
 */

/** The normalized candidate distribution p_i = s_i / Σ s_j. Non-negative scores
 *  only — negative inputs are floored to 0 (a negative "score" is not a score
 *  the system produces; the floor keeps p a valid distribution). */
export function candidateDistribution(scores: readonly number[]): number[] {
  if (scores.length === 0) return [];
  const floored = scores.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const total = floored.reduce((sum, s) => sum + s, 0);
  if (total <= 0) return new Array<number>(scores.length).fill(0);
  return floored.map((s) => s / total);
}

/**
 * The normalized candidate entropy H̃ = −Σ p_i log p_i / log k, in [0, 1].
 * 0 = one candidate holds all the mass (fully concentrated); 1 = every
 * candidate ties. A single candidate is fully concentrated (0); no candidates
 * is 0 (nothing to be uncertain about). Uses log base 2 throughout, so log k
 * normalizes k ≥ 2 candidates onto the same [0, 1] scale.
 */
export function normalizedEntropy(scores: readonly number[]): number {
  const p = candidateDistribution(scores);
  const k = p.length;
  if (k === 0 || k === 1) return 0;
  let entropy = 0;
  for (const pi of p) {
    if (pi <= 0) continue;
    entropy -= pi * Math.log2(pi);
  }
  return entropy / Math.log2(k);
}

/** The top-k slices the retained-candidate reading of §2.2 covers. */
export const CDE_TOP_K_KS = [2, 3, 5, 8] as const;

/** One of the retained-candidate slice sizes. */
export type CdeTopK = (typeof CDE_TOP_K_KS)[number];

/** H̃_k over every supported slice, keyed by the slice size. */
export type CdeTopKEntropies = Readonly<Record<CdeTopK, number>>;

/**
 * The top-k candidate entropy H̃_k: the normalized entropy over the RETAINED
 * top-k candidates only (p renormalized over those k), in [0, 1]. The
 * full-set H̃ saturates near 1 on long tails; this reads the shape of the
 * head — the part of the distribution the routing rule can act on (the
 * disambiguating ask names exactly the top two). k ≥ 2; fewer candidates
 * than k are read as-is (the retained slice is the whole list), and fewer
 * than two candidates is 0 (fully concentrated).
 */
export function topKEntropy(scores: readonly number[], k: number): number {
  const kept = Math.min(k, scores.length);
  if (kept < 2) return 0;
  const sorted = [...scores].sort((a, b) => b - a);
  return normalizedEntropy(sorted.slice(0, kept));
}

/** H̃_k for every supported slice size, in one pass. */
export function topKEntropies(scores: readonly number[]): CdeTopKEntropies {
  const sorted = [...scores].sort((a, b) => b - a);
  const result = {} as Record<CdeTopK, number>;
  for (const k of CDE_TOP_K_KS) result[k] = topKEntropy(sorted, k);
  return result;
}

/**
 * The top-two margin m = (s₁ − s₂) / s₁, in [0, 1] — how much the winner beats
 * its runner-up, relative to the winner. 1 = the runner-up scored nothing;
 * 0 = an exact tie. A single candidate has no runner-up and reports 0 (no
 * margin against a candidate that does not exist).
 */
export function topTwoMargin(scores: readonly number[]): number {
  if (scores.length < 2) return 0;
  const sorted = [...scores].sort((a, b) => b - a);
  const s1 = sorted[0];
  if (!Number.isFinite(s1) || s1 <= 0) return 0;
  return Math.max(0, Math.min(1, (s1 - sorted[1]) / s1));
}

/**
 * The second-to-third margin m₂₃ = (s₂ − s₃) / s₂ — how distinct the runner-up
 * is from the rest of the field. This is the "two dominant candidates" signal:
 * the winner barely beats the runner-up, but the runner-up clearly beats
 * everyone else. 0 when there are fewer than three candidates (no second place
 * to separate from a third place that does not exist).
 */
export function topTwoThreeMargin(scores: readonly number[]): number {
  if (scores.length < 3) return 0;
  const sorted = [...scores].sort((a, b) => b - a);
  const s2 = sorted[1];
  if (!Number.isFinite(s2) || s2 <= 0) return 0;
  return Math.max(0, Math.min(1, (s2 - sorted[2]) / s2));
}

/** The three §2.2 routing regimes. */
export type CdeRegime = 'clear' | 'disambiguate' | 'flat';

export interface CdeReading {
  /** H̃, the normalized candidate entropy in [0, 1]. */
  entropy: number;
  /** H̃_k over the retained top-k candidates for every supported k. */
  topKEntropy: CdeTopKEntropies;
  /** m = (s₁ − s₂)/s₁, the top-two margin in [0, 1]. */
  topTwoMargin: number;
  /** m₂₃ = (s₂ − s₃)/s₂, the second-to-third margin in [0, 1]. */
  topTwoThreeMargin: number;
  /** Candidate count k. */
  k: number;
  /** The routing regime implied by the reading under the given thresholds. */
  regime: CdeRegime;
}

export interface CdeRegimeThresholds {
  /** Top-two margin m below which the winner and runner-up count as TIE-D —
   *  the ambiguous-between-two condition (regime 2, two dominant candidates). */
  topTwoMargin: number;
  /** m₂₃ above which the runner-up is separable from the rest of the field
   *  (the difference between "two dominant" and "broadly flat"). */
  topTwoThreeMargin: number;
}

/**
 * REGIME boundaries (§5.2 tuning constants), calibrated where `cde-bench`
 * showed a class separation and left as placeholders where it did not.
 *
 *   · topTwoMargin = 0.17 — CALIBRATED (cde-bench, 2026-09): the flat class
 *     (adversarial probes: "is a bird a quargle", "is snow a vehicle", …)
 *     measured m ∈ [0.011, 0.044] and the clear class (unambiguous exact
 *     deck-word recalls) measured m ∈ [0.293, 0.436]. The gap (0.044, 0.293)
 *     is non-empty; the threshold sits at its midpoint. Ambiguous cues ('the',
 *     near-tie conversation cues) fall at or below the flat ceiling, which is
 *     exactly where they belong.
 *   · topTwoThreeMargin = 0.2 — PLACEHOLDER: no two-dominant-candidate corpus
 *     exists in the bench (measured m₂₃ overlaps between the classes:
 *     exact [0.008, 0.119] vs. adversarial [0.007, 0.033]); the value is
 *     deliberately permissive until a disambiguation corpus exists.
 *
 * PHASE A REFUTATION (§2.4 / §11): on the fuzz bench no instrument variant
 * beats the top score outside noise (AUC(top) = 0.912 vs. best variant
 * AUC(1 − H̃₃) = 0.779; AUC(1 − H̃) = 0.510 is pure noise). The candidate
 * distribution therefore carries nothing the top score does not, and the
 * §2.2 disambiguating-ask ROUTING MUST NOT BE BUILT from this instrument.
 * These thresholds classify regimes for MEASUREMENT ONLY (the council and
 * frontier readings); nothing routes on them.
 */
export const CDE_REGIME_DEFAULTS: CdeRegimeThresholds = {
  topTwoMargin: 0.17,
  topTwoThreeMargin: 0.2
};

/**
 * Classify the routing regime of a candidate distribution.
 *
 * The regime is driven by the two MARGINS, not by H̃ alone, because H̃ is
 * k-normalized: two tied dominant candidates among a field of k read
 * H̃ = log₂2 / log₂k, which is small whenever k is large (the recall prefilter
 * admits ~1,200 candidates). The margins are k-robust and capture the paper's
 * intent directly:
 *   · 'clear'        — m ≥ topTwoMargin: the winner clearly beats its
 *                      runner-up (one dominant candidate).
 *   · 'disambiguate' — m < topTwoMargin (top two tied) AND m₂₃ ≥
 *                      topTwoThreeMargin (they clearly beat the rest): the
 *                      cue is ambiguous BETWEEN TWO readings.
 *   · 'flat'         — m < topTwoMargin AND m₂₃ < topTwoThreeMargin: broad
 *                      uncertainty, no dominant reading.
 * k = 0 is 'flat' (nothing to answer from); k = 1 is 'clear' (one candidate).
 */
export function classifyRegime(
  scores: readonly number[],
  thresholds: CdeRegimeThresholds = CDE_REGIME_DEFAULTS
): CdeRegime {
  if (scores.length === 0) return 'flat';
  if (scores.length === 1) return 'clear';
  if (topTwoMargin(scores) >= thresholds.topTwoMargin) return 'clear';
  if (topTwoThreeMargin(scores) >= thresholds.topTwoThreeMargin) return 'disambiguate';
  return 'flat';
}

/** One combined reading over a candidate distribution. */
export function readCde(
  scores: readonly number[],
  thresholds: CdeRegimeThresholds = CDE_REGIME_DEFAULTS
): CdeReading {
  return {
    entropy: normalizedEntropy(scores),
    topKEntropy: topKEntropies(scores),
    topTwoMargin: topTwoMargin(scores),
    topTwoThreeMargin: topTwoThreeMargin(scores),
    k: scores.length,
    regime: classifyRegime(scores, thresholds)
  };
}
