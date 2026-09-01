/**
 * COMPOSITION GROUNDING — the deviation meter's per-composition verdict.
 *
 * A creative answer is composed from recalled seed memories. Some of its
 * content words come DIRECTLY from those seeds (grounded — the observer is
 * speaking its own material); the rest are novel stitches (deviation — where
 * fabrication risk lives). The grounding score is the fraction of the
 * answer's content words that appear in its seeds:
 *
 *     grounding = groundedContentWords / totalContentWords
 *
 * This gives the meter what the LLM grade cannot: a per-composition,
 * teacher-free account of WHICH deviations were warranted. An answer that
 * echoes its seeds (high grounding) is the observer speaking from memory; a
 * fluent new sentence (mid grounding) is genuine composition — adjacent
 * concepts put together — and a low-grounding noise answer is where the
 * observer left its own material entirely. The deviation meter can now
 * attribute: composed share × (1 − grounding) is the deviation-from-fact
 * exposure of each answer.
 */
import { isContentWord, tokenizeText, singularize } from './context';
import { hedgeForClaim, stripClaimHedges, type HedgeWord } from './corroboration';
import type { Relation } from './relations';

export interface GroundingResult {
  /** Fraction of content words that come directly from the seeds (0..1). */
  grounding: number;
  /** The grounded content words (present in the seeds). */
  groundedWords: string[];
  /** The novel content words (stitched — deviation from the observer's own
   *  material). */
  novelWords: string[];
  /** The answer is a near-echo of its seeds (grounding ≥ 0.8). */
  isEcho: boolean;
  /** The answer is entirely ungrounded (no content word from any seed). */
  isFabrication: boolean;
}

const ECHO_THRESHOLD = 0.8;

/** Compute the grounding of an answer against its composition seeds. */
export function groundingScore(answer: string, seeds: readonly string[]): GroundingResult {
  // Content-word filter FIRST, then singularize — the opposite order would
  // let truncated forms of pronouns/function words ("this"→"thi",
  // "does"→"doe") slip through as phantom content words and skew the ratio.
  const answerContent = tokenizeText(answer).filter((word) => isContentWord(word)).map(singularize);
  if (answerContent.length === 0) {
    // A phatic answer ("hello", "yes") has NO content to ground — it is
    // neither a grounded echo of its seeds nor a deviation from them.
    // Counting it as a perfect echo inflated the deviation meter's grounded
    // share with answers that simply had nothing to say.
    return { grounding: 1, groundedWords: [], novelWords: [], isEcho: false, isFabrication: false };
  }
  const seedContent = new Set(
    seeds.flatMap((seed) => tokenizeText(seed).filter((word) => isContentWord(word)).map(singularize))
  );
  const groundedWords: string[] = [];
  const novelWords: string[] = [];
  for (const word of answerContent) {
    if (seedContent.has(word)) groundedWords.push(word);
    else novelWords.push(word);
  }
  const grounding = groundedWords.length / answerContent.length;
  return {
    grounding,
    groundedWords,
    novelWords,
    isEcho: grounding >= ECHO_THRESHOLD,
    isFabrication: groundedWords.length === 0
  };
}

/** The deviation meter's per-composition view: the answer's grounding, plus
 *  the composed-share attribution the meter aggregates. */
export function groundingAttribution(grounding: number): {
  grounded: number;
  deviated: number;
} {
  // The composed share IS deviation exposure; grounding splits it: the
  // grounded portion speaks the observer's own material, the rest is
  // deviation-from-fact exposure.
  const deviated = Math.max(0, Math.min(1, 1 - grounding));
  return { grounded: 1 - deviated, deviated };
}

/**
 * P14 CORROBORATION-AWARE HEDGE (the grounding path's integration point):
 * the hedge word a single claim may be spoken with, from the corroboration
 * of its backing edge — '' (assert flatly) only when the claim is backed by
 * >= 2 independent source classes and not weakened by grades; 'I think' when
 * a single source states it; 'Probably' when grades weakened the edge. The
 * hedge is presentation on top of a grounded claim — it never fabricates.
 */
export function claimHedge(
  relations: readonly Relation[],
  subject: string,
  predicate: string,
  object: string
): HedgeWord {
  return hedgeForClaim(relations, subject, predicate, object);
}

/** Strip corroboration hedge markers from a spoken sentence — the deviation
 *  meter scores the composition, not the presentation ("I think" is not
 *  stitched content). */
export function stripHedges(sentence: string): string {
  return stripClaimHedges(sentence);
}