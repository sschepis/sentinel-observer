/**
 * GROUNDED GENERATION + INTERNAL CRITIC (P5).
 *
 * The Markov composer stitches words from memory; every content word of a
 * FRAME composition is taken from a stored typed edge, so the sentence is
 * grounded by construction. The critic then parses the composed sentence
 * BACK through the claim grammar and refuses it unless every claim is backed
 * by the relation graph (direct or inherited) or the confirmed-false store —
 * fabrication without an LLM.
 *
 * The frame pool: the FIXED frames (framesFor) plus, when a
 * LearnedFrameStore is supplied, the templates the observer has learned
 * from accepted answers (see learnedFrames.ts) — same honesty contract,
 * richer structure. Every composition records the template ids it used so
 * the world's grade can be attributed back to the templates.
 *
 * The dispatch contract: try grounded frames first; the Markov path remains
 * as a LABELED fallback (the caller marks the answer `grounded: false`).
 */

import { isContentWord } from './context';
import type { Negation, Relation, RelationPredicate } from './relations';
import { framesFor, fixedFrames, FIRST_FRAME_PREFERENCE, type FrameRef, type LearnedFrameStore } from './learnedFrames';
import { criticize } from './critic';

// The claim grammar and the fixed frames now live in critic.ts and
// learnedFrames.ts respectively; re-exported here so existing importers
// keep working unchanged.
export { framesFor, fixedFrames, renderTemplate } from './learnedFrames';
export { criticize, parseClaims, extractSubject, contentWordsOf } from './critic';
export type { Claim } from './critic';
export type {
  LearnedFrameStore,
  HoleTemplate,
  FrameRef,
  FrameTemplateStats,
  AdmissionVerdict,
  TemplateAudit
} from './learnedFrames';

export interface GroundedComposition {
  sentence: string;
  /** The backing edges of every claim (the provenance the answer cites). */
  edges: Array<{ subject: string; predicate: RelationPredicate; object: string }>;
  frames: string[];
  /** The template ids the composition was built from (fixed:... and
   *  learned:...) — the credit/feedback attribution of each frame. */
  templateIds: string[];
}

/**
 * The typed frames a subject can fill, built ONLY from stored edges
 * (direct or inherited). The FIRST frame always names the subject (so the
 * critic can resolve it); later frames use "It".
 */

/** Subjects (from the recall seeds) that have at least one fillable frame. */
export function groundedSubjects(
  words: readonly string[],
  relations: readonly Relation[],
  denied: (subject: string, predicate: string, object: string) => boolean = () => false
): string[] {
  return [...new Set(words)].filter((word) => isContentWord(word) && framesFor(word, relations, denied).length > 0);
}

/**
 * Compose a grounded sentence: pick a seed subject with edges, fill 1–3
 * frames deterministically from the supplied rng. The frame pool is the
 * fixed frames plus — when a LearnedFrameStore is given — its admitted
 * learned templates and (with the store's exploration probability) its
 * not-yet-admitted candidates, so learning can accumulate evidence from the
 * world's verdicts. Returns null when no seed subject has any edge — the
 * caller falls back to the labeled Markov path.
 */
export function composeGrounded(
  seedWords: readonly string[],
  relations: readonly Relation[],
  rng: () => number,
  maxSentences = 3,
  negations: readonly Negation[] = [],
  learned: LearnedFrameStore | null = null
): GroundedComposition | null {
  const denied = (subject: string, predicate: string, object: string): boolean =>
    negations.some((n) => n.subject === subject && n.predicate === predicate && n.object === object);
  const candidates = groundedSubjects(seedWords, relations, denied);
  if (candidates.length === 0) return null;
  // Prefer the utterance's own topic: seedWords are ordered [utterance words,
  // ...memory words], so the first candidate is the first utterance content
  // word with edges. It wins most draws; the pool keeps variety.
  const subject =
    rng() < 0.75 ? candidates[0] : candidates[Math.floor(rng() * candidates.length)];
  // Named frames open the composition (the critic's resolution anchor); the
  // rest are drawn deterministically from the anaphoric pool.
  const refs: FrameRef[] =
    learned !== null
      ? learned.compositionFrames(subject, relations, denied, negations, rng)
      : fixedFrames(subject, relations, denied);
  const named = refs.filter((frame) => frame.namesSubject);
  if (named.length === 0) return null;
  // With a learned store, learned openings earn a share of first-frame
  // draws; the top-priority fixed frame keeps the majority. Without one,
  // named[0] is the only named frame — identical to the fixed-only behavior.
  const first =
    named.length === 1 || rng() < FIRST_FRAME_PREFERENCE
      ? named[0]
      : named[1 + Math.floor(rng() * (named.length - 1))];
  const picked: FrameRef[] = [first];
  const pool = refs.filter((frame) => !frame.namesSubject && frame.text !== first.text);
  // The frame count draws from the pool (fixed path: identical distribution
  // to the fixed-only composer); the SENTENCE budget caps the total — a
  // learned multi-clause opening already spent some of it.
  const count = Math.min(maxSentences, Math.max(1, 1 + Math.floor(rng() * refs.length)));
  let sentences = (first.text.match(/[.!?]/g) ?? []).length;
  for (let i = 1; i < count && pool.length > 0; i += 1) {
    const frame = pool.splice(Math.floor(rng() * pool.length), 1)[0];
    const frameSentences = (frame.text.match(/[.!?]/g) ?? []).length;
    if (sentences + frameSentences > maxSentences) continue;
    picked.push(frame);
    sentences += frameSentences;
  }
  const sentence = picked.map((frame) => frame.text).join(' ').replace(/\s+([.!?])/g, '$1');
  const verdict = criticize(sentence, relations, negations);
  return {
    sentence,
    edges: verdict.grounded ? verdict.edges : [],
    frames: picked.map((frame) => frame.text),
    templateIds: picked.map((frame) => frame.id)
  };
}
