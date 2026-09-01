/**
 * P14 CROSS-SOURCE CORROBORATION — agreement across independent sources.
 *
 * A relation stated by exactly ONE source class is a weak claim. It may be
 * spoken (the honesty contract only forbids UNBACKED claims), but it must be
 * HEDGED — "I think" or explicit uncertainty — never asserted flatly.
 * Agreement across >= 2 INDEPENDENT source classes corroborates the claim:
 * confidence rises and the hedge is removed. The four classes (see
 * relations.ts) are deliberately coarse so agreement means real agreement:
 *
 *   curriculum      deck definitions (regex) + authored curriculum decks
 *   definition      LLM-chaperoned definitions/edges (single weak source)
 *   conversation    user statements ("my dog can bark" -> dog capable-of bark)
 *   world-feedback  accepted graded answers citing the edge
 *
 * This module is policy-only: it decides confidence and hedge words from
 * evidence, and mines evidence from text. The TeacherAgent owns the per-edge
 * evidence store; relations.ts owns the provenance vocabulary.
 */

import { inheritsEdge } from './chain';
import {
  sourceClassForOrigin,
  type Relation,
  type RelationPredicate,
  type SourceClass
} from './relations';

/** The hedge words a claim may be spoken with ('' = assert flatly). */
export type HedgeWord = '' | 'I think' | 'Probably';

/** The minimum number of independent source classes that corroborate. */
export const CORROBORATION_CLASSES = 2;
/** Below this effective strength an edge reads as weakened (hedge "Probably"). */
export const STRENGTH_CONFIDENT = 1;

/**
 * The corroboration BASE confidence of an edge from its source classes
 * (before the grade/agreement overlay):
 *
 *   · 1 class, curriculum → 1.0 — a single STATED curriculum source. The
 *     curriculum is reviewed material (docs/ENGLISH_LEARNING.md: "definitions
 *     and examples reviewed, not AI-generated"), so one stated source is the
 *     P8 baseline — but it still reads as single-source for hedging.
 *   · 1 class, definition → 0.6 — a single LLM-chaperoned source is weak
 *     until another class agrees (operators hedge it "Probably").
 *   · 2 / 3 / 4 classes → 1.0 / 1.2 / 1.4 — corroboration promotes; the
 *     margin above 1.0 is headroom that survives small negative grade deltas.
 */
export function corroborationConfidence(classes: readonly SourceClass[]): number {
  const distinct = distinctClasses(classes);
  if (distinct.length >= 4) return 1.4;
  if (distinct.length === 3) return 1.2;
  if (distinct.length === 2) return 1.0;
  if (distinct.length === 1) return distinct[0] === 'definition' ? 0.6 : 1.0;
  return 0.6;
}

/** The distinct classes, in policy order (the edge's own class first). */
export function distinctClasses(classes: readonly SourceClass[]): SourceClass[] {
  const seen = new Set<SourceClass>();
  const out: SourceClass[] = [];
  for (const cls of classes) {
    if (seen.has(cls)) continue;
    seen.add(cls);
    out.push(cls);
  }
  return out;
}

/** True when >= 2 independent source classes support the edge. */
export function isCorroborated(classes: readonly SourceClass[]): boolean {
  return distinctClasses(classes).length >= CORROBORATION_CLASSES;
}

/**
 * The hedge word for a claim with `classes` corroboration and effective
 * `strength`: weakened edges (< 1) hedge "Probably" (the P8 contract);
 * corroborated edges assert flatly; single-source edges hedge "I think".
 */
export function hedgeFor(classes: readonly SourceClass[], strength: number): HedgeWord {
  if (strength < STRENGTH_CONFIDENT) return 'Probably';
  return isCorroborated(classes) ? '' : 'I think';
}

/** The classes an edge carries, defaulting to its origin's own class. */
export function classesOf(relation: Relation): readonly SourceClass[] {
  return relation.sourceClasses !== undefined && relation.sourceClasses.length > 0
    ? relation.sourceClasses
    : [sourceClassForOrigin(relation.origin)];
}

/**
 * The backing edge of a claim — direct, or inherited through is-a ancestors.
 * Returns null when no stored edge supports the claim (the critic refuses
 * such claims anyway; a conservative hedge is the fallback here).
 */
export function backingEdge(
  relations: readonly Relation[],
  subject: string,
  predicate: string,
  object: string
): Relation | null {
  const direct = relations.find(
    (r) => r.subject === subject && r.predicate === predicate && r.object === object
  );
  if (direct !== undefined) return direct;
  const via = inheritsEdge(relations, subject, predicate, object);
  if (via === null) return null;
  return (
    relations.find(
      (r) => r.subject === via.via && r.predicate === predicate && r.object === object
    ) ?? null
  );
}

/**
 * The hedge word for one claim backed by `relations` ('' = corroborated,
 * spoken flatly). Weak claims are never fabricated — they are hedged.
 */
export function hedgeForClaim(
  relations: readonly Relation[],
  subject: string,
  predicate: string,
  object: string
): HedgeWord {
  const edge = backingEdge(relations, subject, predicate, object);
  if (edge === null) return 'I think';
  return hedgeFor(classesOf(edge), edge.strength ?? 1);
}

/**
 * Strip corroboration hedge markers from a spoken sentence, so the deviation
 * meter scores the COMPOSITION, not its presentation ("I think" is not
 * content the observer stitched). Returns the sentence unchanged when no
 * hedge markers are present.
 */
export function stripClaimHedges(sentence: string): string {
  return sentence
    .replace(/\bI think\s+/gi, '')
    .replace(/\bProbably\s*[,—–-]?\s+/gi, '')
    .trim();
}

const escapeRegex = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Question-leading statements ask, they do not assert. */
const QUESTION_START = /^\s*(?:is|are|was|were|do|does|did|can|could|will|would|should|may|might|who|what|which|where|when|why|how)\b/i;
/** Negations assert the absence, never the presence, of a relation. */
const NEGATION_MARKER = /\b(?:not|never|no|isn't|aren't|can't|cannot|won't|doesn't|don't|didn't)\b/i;

/**
 * CONSERVATIVE TEXT-EVIDENCE MINER — does a statement corroborate
 * `subject {predicate} object`? Two gates make it precise:
 *
 *   1. The utterance must be a DECLARATIVE assertion: questions and
 *      negations never corroborate ("is a robin a bird?" asks, "a robin is
 *      not a bird" contradicts — neither is evidence).
 *   2. The predicate must be EXPRESSED, not just co-mentioned: "the dog
 *      chased the cat" must never corroborate dog is-a cat. Each predicate
 *      has its own surface pattern ("X is a Y", "X has Y", "X can Y",
 *      "X is Y", "X made of Y", "X is in Y").
 *
 * Plural forms of subject/object are accepted ("robins are birds").
 */
export function evidenceInText(
  text: string,
  subject: string,
  predicate: RelationPredicate,
  object: string
): boolean {
  const lower = text.trim().toLowerCase();
  if (lower.length === 0 || lower.includes('?') || QUESTION_START.test(lower)) return false;
  if (NEGATION_MARKER.test(lower)) return false;
  const s = escapeRegex(subject.toLowerCase());
  const o = escapeRegex(object.toLowerCase());
  const subj = `\\b${s}(?:s|es)?\\b`;
  const obj = `\\b${o}(?:s|es)?\\b`;
  switch (predicate) {
    case 'is-a':
      return (
        new RegExp(`${subj}\\s+is\\s+(?:a|an)\\s+${obj}`).test(lower) ||
        new RegExp(`${subj}\\s+are\\s+${obj}`).test(lower)
      );
    case 'has-part':
      return new RegExp(`${subj}\\s+(?:has|have|with)\\s+(?:(?:a|an|the)\\s+)?${obj}`).test(lower);
    case 'capable-of':
      return new RegExp(`${subj}\\s+(?:can|could|will)\\s+${obj}`).test(lower);
    case 'has-property':
      return new RegExp(`${subj}\\s+is\\s+${obj}`).test(lower);
    case 'made-of':
      return new RegExp(`${subj}\\s+(?:is\\s+)?made\\s+of\\s+${obj}`).test(lower);
    case 'located-in':
      return new RegExp(`${subj}\\s+is\\s+(?:in|on|at|near)\\s+(?:(?:the|a|an)\\s+)?${obj}`).test(lower);
    // Uncommon predicates have no safe surface pattern — co-mention is not
    // corroboration. Never mined.
    default:
      return false;
  }
}

/** The text-evidence class an utterance contributes, or null when it does
 *  not corroborate the edge. */
export function evidenceClassInText(
  text: string,
  subject: string,
  predicate: RelationPredicate,
  object: string
): SourceClass | null {
  return evidenceInText(text, subject, predicate, object) ? 'conversation' : null;
}
