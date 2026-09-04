/**
 * GROUNDED GENERATION + INTERNAL CRITIC (P5).
 *
 * The Markov composer stitches words from memory; every content word of a
 * FRAME composition is taken from a stored typed edge, so the sentence is
 * grounded by construction. The critic then parses the composed sentence
 * BACK through the claim grammar and refuses it unless every claim is backed
 * by the relation graph (direct or inherited), a sound multi-predicate chain
 * (P10 — the chain's hops become the cited evidence), or the confirmed-false
 * store — fabrication without an LLM.
 *
 * The frame pool: the FIXED frames (framesFor, incl. the P10 composed
 * frames) plus, when a LearnedFrameStore is supplied, the templates the
 * observer has learned from accepted answers (see learnedFrames.ts) — same
 * honesty contract, richer structure. Every composition records the
 * template ids it used so the world's grade can be attributed back to the
 * templates.
 *
 * The dispatch contract: try grounded frames first; the Markov path remains
 * as a LABELED fallback (the caller marks the answer `grounded: false`).
 */

import { edgeObjects, inheritsEdge, ancestors, deniedFromNegations, type DeniedClaim } from './chain';
import { composeClaim, composedClaimsFor } from './composition';
import { isContentWord, tokenizeText } from './context';
import type { TokenCostModel } from './mdl';
import { predicateVerb, type Relation, type RelationPredicate } from './relations';
import { claimHedge } from './grounding';
import { hedgeForClaim, type HedgeWord } from './corroboration';
import { normalizedEntropy } from './cde';
import { FIRST_FRAME_PREFERENCE, fixedFrames, type FrameRef, type LearnedFrameStore } from './learnedFrames';
import type { Negation } from './relations';

// The learned-template machinery (learnedFrames.ts) — re-exported here so
// existing importers keep a single grounded-generation entry point.
export { fixedFrames, renderTemplate, LearnedFrameStore } from './learnedFrames';
export type {
  LearnedFrameStore as LearnedFrameStoreType,
  HoleTemplate,
  FrameRef,
  FrameTemplateStats,
  AdmissionVerdict,
  TemplateAudit,
  LearnedFrameOptions
} from './learnedFrames';

/** One parsed claim of a candidate sentence. */
export interface Claim {
  subject: string;
  predicate: RelationPredicate;
  object: string;
  negated: boolean;
}

export interface GroundedComposition {
  sentence: string;
  /** The backing edges of every claim (the provenance the answer cites). */
  edges: Array<{ subject: string; predicate: RelationPredicate; object: string }>;
  frames: string[];
  /** P14: true when any cited claim is single-source or weakened — the
   *  spoken sentence must carry a corroboration hedge. */
  hedged: boolean;
  /** The template ids the composition was built from (fixed:..., learned:...
   *  and composed:...) — the credit/feedback attribution of each frame. The
   *  fixed-only path returns [] (the fixed seeds are not individually
   *  attributed). */
  templateIds: string[];
}

/** Generation options: the negation store and the MDL frequency model. */
export interface FrameOptions {
  negations?: readonly Negation[];
  cost?: TokenCostModel | null;
  /** R4b: ADMITTED composition rules beyond the seed table. */
  extraRules?: readonly import('./composition').CompositionRule[];
}

const article = (word: string): string => (/^[aeiou]/.test(word) ? 'an' : 'a');

/** "a" / "a and b" / "a, b and c" — the frame object list. */
function listPhrase(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')}, and ${words[words.length - 1]}`;
}

/**
 * The typed frames a subject can fill, each built ONLY from stored edges
 * (direct or inherited) or from a SOUND multi-predicate chain (P10 — the
 * composed frames: "A bird can pump blood." via is-a → has-part →
 * capable-of). Composed frames must clear the MDL gate and survive the
 * negation store; a claim a single edge already answers is never duplicated
 * here. The FIRST frame always names the subject (so the critic can resolve
 * it); later frames use "It".
 */
export function framesFor(
  subject: string,
  relations: readonly Relation[],
  options: FrameOptions = {},
  denied: DeniedClaim = () => false
): string[] {
  const frames: string[] = [];
  const deny = options.negations !== undefined ? deniedFromNegations(options.negations) : denied;
  const parents = edgeObjects(relations, subject, 'is-a', deny);
  const parts = edgeObjects(relations, subject, 'has-part', deny).slice(0, 3);
  const props = edgeObjects(relations, subject, 'has-property', deny).slice(0, 3);
  const actions = edgeObjects(relations, subject, 'capable-of', deny).slice(0, 3);
  const purposes = edgeObjects(relations, subject, 'used-for', deny).slice(0, 3);
  const materials = edgeObjects(relations, subject, 'made-of', deny).slice(0, 3);

  if (parents.length > 0) frames.push(`A ${subject} is ${article(parents[0])} ${parents[0]}.`);
  else if (parts.length > 0) frames.push(`A ${subject} has ${listPhrase(parts)}.`);
  else if (props.length > 0) frames.push(`A ${subject} is ${listPhrase(props)}.`);
  else if (actions.length > 0) frames.push(`A ${subject} can ${listPhrase(actions)}.`);
  else if (purposes.length > 0) frames.push(`A ${subject} is used for ${listPhrase(purposes)}.`);
  else if (materials.length > 0) frames.push(`A ${subject} is made of ${listPhrase(materials)}.`);

  if (parts.length > 0 && parents.length > 0) frames.push(`It has ${listPhrase(parts)}.`);
  if (props.length > 0) frames.push(`It is ${listPhrase(props)}.`);
  if (actions.length > 0) frames.push(`It can ${listPhrase(actions)}.`);
  if (purposes.length > 0) frames.push(`It is used for ${listPhrase(purposes)}.`);
  if (materials.length > 0) frames.push(`It is made of ${listPhrase(materials)}.`);

  // P10 COMPOSED FRAMES: claims no single edge states, backed by a sound
  // chain (is-a → has-part → capable-of ...). Each names the subject so the
  // critic's claim grammar parses it back.
  for (const claim of composedClaimsFor(subject, relations, options)) {
    frames.push(`A ${subject} ${predicateVerb(claim.predicate, claim.object)} ${claim.object}.`);
  }

  return frames;
}

/** One candidate next-claim on the elaboration frontier, scoreable for §2's
 *  candidate-distribution entropy. */
export interface FrontierClaim {
  /** The claim text (a frame `framesFor` would emit, or a composed claim). */
  text: string;
  /** Marginal-information score: the backing edge's corroboration strength
   *  for typed claims, the MDL gain for composed (P10) claims. */
  score: number;
}

/**
 * INSTRUMENTATION (§2 / improvements.md A.7): the candidate next-claim
 * frontier — every claim `framesFor` and `composedClaimsFor` could emit for
 * a subject, scored so candidate-distribution entropy H̃ can be read over it.
 * This is the candidate set the elaboration stopping criterion (§8) will
 * gate on; it is exposed here as a pure list and nothing routes on it.
 * Direct and inherited typed edges carry their corroboration strength;
 * composed chains carry their MDL gain.
 */
export function nextClaimFrontier(
  subject: string,
  relations: readonly Relation[],
  options: FrameOptions = {},
  denied: DeniedClaim = () => false
): FrontierClaim[] {
  const deny = options.negations !== undefined ? deniedFromNegations(options.negations) : denied;
  const byKey = new Map<string, { text: string; score: number }>();
  const record = (predicate: RelationPredicate, object: string, score: number): void => {
    if (!Number.isFinite(score) || score <= 0) return;
    const key = `${predicate}\u0000${object}`;
    const existing = byKey.get(key);
    if (existing === undefined || score > existing.score) {
      byKey.set(key, { text: `A ${subject} ${predicateVerb(predicate, object)} ${object}.`, score });
    }
  };
  // Direct and inherited typed edges — the framesFor pools, with their
  // corroboration strength as the marginal-information score.
  for (const ancestor of ancestors(relations, subject, deny)) {
    for (const relation of relations) {
      if (relation.subject !== ancestor) continue;
      if (deny(subject, relation.predicate, relation.object)) continue;
      if (deny(ancestor, relation.predicate, relation.object)) continue;
      record(relation.predicate, relation.object, relation.strength ?? 1);
    }
  }
  // Composed chains (P10) — the composedClaimsFor pool, scored by MDL gain.
  for (const claim of composedClaimsFor(subject, relations, options)) {
    record(claim.predicate, claim.object, claim.gain);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

/** H̃ over the candidate next-claim frontier — the §8 stopping signal: a
 *  flat reading (H̃ → 1) means nothing is left worth saying. */
export function frontierEntropy(
  subject: string,
  relations: readonly Relation[],
  options: FrameOptions = {},
  denied: DeniedClaim = () => false
): number {
  return normalizedEntropy(nextClaimFrontier(subject, relations, options, denied).map((c) => c.score));
}

/** Subjects (from the recall seeds) that have at least one fillable frame. */
export function groundedSubjects(
  words: readonly string[],
  relations: readonly Relation[],
  denied: DeniedClaim = () => false
): string[] {
  return [...new Set(words)].filter((word) => isContentWord(word) && framesFor(word, relations, {}, denied).length > 0);
}

/**
 * Compose a grounded sentence: pick a seed subject with edges, fill 1–3
 * frames deterministically from the supplied rng. Returns null when no seed
 * subject has any edge — the caller falls back to the labeled Markov path.
 *
 * The fifth parameter accepts either the negation store (legacy callers) or
 * a FrameOptions object (negations + MDL cost model). The optional sixth
 * parameter is a LearnedFrameStore: when given, the frame pool is the fixed
 * seeds plus the store's admitted learned templates (and, with the store's
 * exploration probability, its not-yet-admitted candidates) plus the P10
 * composed frames, so learning can accumulate evidence from the world's
 * verdicts while every frame still passes the critic.
 */
export function composeGrounded(
  seedWords: readonly string[],
  relations: readonly Relation[],
  rng: () => number,
  maxSentences = 3,
  negationsOrOptions: readonly Negation[] | FrameOptions = {},
  learned: LearnedFrameStore | null = null
): GroundedComposition | null {
  const options: FrameOptions = Array.isArray(negationsOrOptions)
    ? { negations: negationsOrOptions as readonly Negation[] }
    : (negationsOrOptions as FrameOptions);
  const negations = options.negations ?? [];
  const denied = deniedFromNegations(negations);
  const candidates = groundedSubjects(seedWords, relations, denied);
  if (candidates.length === 0) return null;
  // Prefer the utterance's own topic: seedWords are ordered [utterance words,
  // ...memory words], so the first candidate is the first utterance content
  // word with edges. It wins most draws; the pool keeps variety.
  const subject =
    rng() < 0.75 ? candidates[0] : candidates[Math.floor(rng() * candidates.length)];

  if (learned !== null) {
    // LEARNED TEMPLATES: named frames open the composition (the critic's
    // resolution anchor); the rest are drawn deterministically from the
    // anaphoric pool. Learned openings earn a share of first-frame draws;
    // the top-priority fixed frame keeps the majority.
    const refs: FrameRef[] = learned.compositionFrames(subject, relations, denied, negations, rng);
    return composeFromRefs(refs, subject, relations, negations, options, rng, maxSentences);
  }

  // FIXED PATH (P5 + P10): the first frame always names the subject (the
  // critic's resolution anchor); the rest are drawn deterministically from
  // the remaining pool. The frames are the fixed seeds plus the P10
  // composed frames, each carrying its template id for attribution.
  const refs: FrameRef[] = fixedFrames(subject, relations, denied);
  return composeFromRefs(refs, subject, relations, negations, options, rng, maxSentences);
}

/** The shared composition pick loop over typed frame refs: P10 composed
 *  frames ride alongside the template frames (chain-backed claims
 *  contribute new knowledge to whichever pool is active), the sentence
 *  budget caps the total (a multi-clause opening already spent some of it),
 *  and the critic re-verifies before anything is returned. */
function composeFromRefs(
  refs: FrameRef[],
  subject: string,
  relations: readonly Relation[],
  negations: readonly Negation[],
  options: FrameOptions,
  rng: () => number,
  maxSentences: number
): GroundedComposition | null {
  const seen = new Set(refs.map((frame) => frame.text));
  for (const claim of composedClaimsFor(subject, relations, options)) {
    const text = `A ${subject} ${predicateVerb(claim.predicate, claim.object)} ${claim.object}.`;
    if (seen.has(text)) continue;
    seen.add(text);
    refs.push({ id: `composed:${claim.predicate}:${claim.object}`, text, namesSubject: true });
  }
  const named = refs.filter((frame) => frame.namesSubject);
  if (named.length === 0) return null;
  const first =
    named.length === 1 || rng() < FIRST_FRAME_PREFERENCE
      ? named[0]
      : named[1 + Math.floor(rng() * (named.length - 1))];
  const picked: FrameRef[] = [first];
  const pool = refs.filter((frame) => !frame.namesSubject && frame.text !== first.text);
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
  const verdict = criticize(sentence, relations, negations, { cost: options.cost ?? null, extraRules: options.extraRules });
  return {
    sentence,
    edges: verdict.grounded ? verdict.edges : [],
    frames: picked.map((frame) => frame.text),
    hedged: verdict.hedged,
    templateIds: picked.map((frame) => frame.id)
  };
}

/**
 * THE INTERNAL CRITIC — parse a candidate sentence back through the claim
 * grammar and refuse any claim not supported by a stored edge (direct or
 * inherited), a sound composed chain (P10 — the chain's hops become the
 * cited evidence), or the confirmed-false store. An unparseable sentence
 * (no resolvable subject, unknown clause) is ungrounded by definition.
 *
 * P14: the verdict is corroboration-aware — each accepted claim carries the
 * hedge word of its backing edge ('' when corroborated by >= 2 independent
 * source classes and unweakened, 'I think' for single-source claims,
 * 'Probably' when grades weakened the edge). A grounded claim may still be
 * weak; the critic's job is refusing UNBACKED claims, and the hedge is
 * applied when the sentence is spoken.
 */
export function criticize(
  sentence: string,
  relations: readonly Relation[],
  negations: readonly Negation[],
  options: { cost?: TokenCostModel | null; extraRules?: readonly import('./composition').CompositionRule[] } = {}
): { grounded: boolean; unbacked: string[]; edges: Array<{ subject: string; predicate: RelationPredicate; object: string }>; hedged: boolean; hedges: HedgeWord[] } {
  const subject = extractSubject(sentence);
  if (subject === null) return { grounded: false, unbacked: [sentence], edges: [], hedged: false, hedges: [] };
  const claims = parseClaims(sentence, subject);
  if (claims.length === 0) return { grounded: false, unbacked: [sentence], edges: [], hedged: false, hedges: [] };

  const denied = deniedFromNegations(negations);
  const edges: Array<{ subject: string; predicate: RelationPredicate; object: string }> = [];
  const unbacked: string[] = [];
  const hedges: HedgeWord[] = [];
  for (const claim of claims) {
    if (claim.negated) {
      if (negations.some((n) => n.subject === claim.subject && n.predicate === claim.predicate && n.object === claim.object)) {
        edges.push({ subject: claim.subject, predicate: claim.predicate, object: claim.object });
        // A confirmed falsehood is evidence-backed — spoken without hedging.
        hedges.push('');
      } else {
        unbacked.push(`${claim.subject} is-not ${claim.object}`);
      }
      continue;
    }
    const direct = relations.some(
      (r) => r.subject === claim.subject && r.predicate === claim.predicate && r.object === claim.object
    );
    const via = direct ? null : inheritsEdge(relations, claim.subject, claim.predicate, claim.object, denied);
    if (direct || via !== null) {
      edges.push({ subject: claim.subject, predicate: claim.predicate, object: claim.object });
      // P14: the corroboration hedge of the backing edge (direct or inherited).
      hedges.push(claimHedge(relations, claim.subject, claim.predicate, claim.object));
      continue;
    }
    // P10: no single edge states the claim — a SOUND chain still may. The
    // chain's hops are the evidence the claim cites, so a composed answer's
    // provenance names real stored edges.
    const composed = composeClaim(relations, claim.subject, claim.predicate, claim.object, {
      negations,
      cost: options.cost ?? null,
      extraRules: options.extraRules
    });
    if (composed !== null) {
      for (const hop of composed.hops) {
        edges.push({ subject: hop.subject, predicate: hop.predicate, object: hop.object });
      }
    } else {
      unbacked.push(`${claim.subject} ${claim.predicate} ${claim.object}`);
    }
  }
  return {
    grounded: unbacked.length === 0,
    unbacked,
    edges,
    hedged: hedges.some((hedge) => hedge !== ''),
    hedges
  };
}

/**
 * P14 CORROBORATION HEDGE — phrase a verified composition honestly: every
 * sentence part whose claims are single-source is prefixed "I think", every
 * part whose backing edges were weakened by grades is prefixed "Probably",
 * and corroborated parts are asserted flatly. The input sentence is the RAW
 * frame composition (already passed the critic); the output is what is
 * spoken. Returns the sentence unchanged (hedged: false) when every claim is
 * corroborated and strong.
 */
export function hedgeComposition(
  sentence: string,
  relations: readonly Relation[]
): { sentence: string; hedged: boolean } {
  // Keep the sentence-terminating punctuation attached to each part, so the
  // hedged parts keep their periods ("I think a robin is a bird.").
  const parts = sentence.split(/(?<=[.!?])\s*/).filter((part) => part.trim().length > 0);
  if (parts.length === 0) return { sentence, hedged: false };
  const subject = extractSubject(parts[0]);
  if (subject === null) return { sentence, hedged: false };

  const hedgedParts: string[] = [];
  let hedged = false;
  for (const part of parts) {
    const claims = parseClaims(part, subject);
    let word: HedgeWord = '';
    for (const claim of claims) {
      // Confirmed-false claims are evidence-backed — never hedged.
      if (claim.negated) continue;
      const candidate = hedgeForClaim(relations, claim.subject, claim.predicate, claim.object);
      if (candidate === 'Probably') {
        word = 'Probably';
        break;
      }
      if (candidate === 'I think' && word === '') word = 'I think';
    }
    if (word === '') {
      hedgedParts.push(part);
      continue;
    }
    hedged = true;
    const lowered = part.charAt(0).toLowerCase() + part.slice(1);
    hedgedParts.push(word === 'Probably' ? `Probably, ${lowered}` : `I think ${lowered}`);
  }
  return { sentence: hedgedParts.join(' ').replace(/\s+([.!?])/g, '$1'), hedged };
}

/** The subject named by the first "A {X} ..." frame (null when unresolvable). */
export function extractSubject(sentence: string): string | null {
  const hit = sentence.match(/^a[n]?\s+([a-z]+(?:\s+[a-z]+)*)\s+(?:is|has|can|is used|is made)/i);
  return hit === null ? null : hit[1].toLowerCase();
}

/** Split an object list ("wings and feathers", "cold and wet") into words. */
function splitObjects(rest: string): string[] {
  return rest
    .split(/\s+(?:and|,)\s+/i)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0 && isContentWord(token));
}

/** Parse every claim of a candidate sentence under a resolved subject. */
export function parseClaims(sentence: string, subject: string): Claim[] {
  const claims: Claim[] = [];
  const parts = sentence.split(/[.!?]+\s*/).filter((part) => part.trim().length > 0);
  for (const part of parts) {
    const clause = part.trim();
    const isA = clause.match(/^a[n]?\s+([a-z]+(?:\s+[a-z]+)*)\s+is\s+(?:a|an)\s+([a-z]+(?:\s+[a-z]+)*)$/i);
    if (isA !== null) {
      claims.push({ subject: isA[1].toLowerCase(), predicate: 'is-a', object: isA[2].toLowerCase(), negated: false });
      continue;
    }
    // FIRST-FRAME variants of every other clause ("A robin has wings.",
    // "A snow is cold and wet.") — previously only the is-a first frame
    // parsed, so a two-frame sentence's first claim was silently skipped
    // (incomplete cited-edge provenance: a wrong grade weakened only the
    // parseable frames) and a single non-is-a frame was rejected as
    // ungrounded, demoting the composition to the Markov fallback.
    const aHas = clause.match(/^a[n]?\s+([a-z]+(?:\s+[a-z]+)*)\s+has\s+(.+)$/i);
    if (aHas !== null) {
      for (const object of splitObjects(aHas[2])) claims.push({ subject: aHas[1].toLowerCase(), predicate: 'has-part', object, negated: false });
      continue;
    }
    const aCan = clause.match(/^a[n]?\s+([a-z]+(?:\s+[a-z]+)*)\s+can\s+(.+)$/i);
    if (aCan !== null) {
      for (const object of splitObjects(aCan[2])) claims.push({ subject: aCan[1].toLowerCase(), predicate: 'capable-of', object, negated: false });
      continue;
    }
    // ORDER: the used-for and made-of forms must precede the bare "is"
    // property form ("a hammer is used for nails" must not parse as
    // property "used for nails").
    const aUsedFor = clause.match(/^a[n]?\s+([a-z]+(?:\s+[a-z]+)*)\s+is\s+used\s+for\s+(.+)$/i);
    if (aUsedFor !== null) {
      for (const object of splitObjects(aUsedFor[2])) claims.push({ subject: aUsedFor[1].toLowerCase(), predicate: 'used-for', object, negated: false });
      continue;
    }
    const aMadeOf = clause.match(/^a[n]?\s+([a-z]+(?:\s+[a-z]+)*)\s+is\s+made\s+of\s+(.+)$/i);
    if (aMadeOf !== null) {
      for (const object of splitObjects(aMadeOf[2])) claims.push({ subject: aMadeOf[1].toLowerCase(), predicate: 'made-of', object, negated: false });
      continue;
    }
    // ORDER: the located-in form must precede the bare "is" property form
    // ("a bird is located in sky" must not parse as property "located in").
    const aLocatedIn = clause.match(/^a[n]?\s+([a-z]+(?:\s+[a-z]+)*)\s+is\s+located\s+in\s+(.+)$/i);
    if (aLocatedIn !== null) {
      for (const object of splitObjects(aLocatedIn[2])) claims.push({ subject: aLocatedIn[1].toLowerCase(), predicate: 'located-in', object, negated: false });
      continue;
    }
    const aIs = clause.match(/^a[n]?\s+([a-z]+(?:\s+[a-z]+)*)\s+is\s+(?!not\s+)([a-z]+(?:\s+[a-z]+)*)$/i);
    if (aIs !== null) {
      for (const object of splitObjects(aIs[2])) claims.push({ subject: aIs[1].toLowerCase(), predicate: 'has-property', object, negated: false });
      continue;
    }
    const isNotA = clause.match(/^(?:it|they|[a-z]+(?:\s+[a-z]+)*)\s+is\s+not\s+(?:a|an)\s+([a-z]+(?:\s+[a-z]+)*)$/i);
    if (isNotA !== null) {
      claims.push({ subject, predicate: 'is-a', object: isNotA[1].toLowerCase(), negated: true });
      continue;
    }
    const has = clause.match(/^(?:it|they)\s+has\s+(.+)$/i);
    if (has !== null) {
      for (const object of splitObjects(has[1])) claims.push({ subject, predicate: 'has-part', object, negated: false });
      continue;
    }
    const can = clause.match(/^(?:it|they)\s+can\s+(.+)$/i);
    if (can !== null) {
      for (const object of splitObjects(can[1])) claims.push({ subject, predicate: 'capable-of', object, negated: false });
      continue;
    }
    const usedFor = clause.match(/^(?:it|they)\s+is\s+used\s+for\s+(.+)$/i);
    if (usedFor !== null) {
      for (const object of splitObjects(usedFor[1])) claims.push({ subject, predicate: 'used-for', object, negated: false });
      continue;
    }
    const madeOf = clause.match(/^(?:it|they)\s+is\s+made\s+of\s+(.+)$/i);
    if (madeOf !== null) {
      for (const object of splitObjects(madeOf[1])) claims.push({ subject, predicate: 'made-of', object, negated: false });
      continue;
    }
    const isProp = clause.match(/^(?:it|they)\s+is\s+(.+)$/i);
    if (isProp !== null) {
      for (const object of splitObjects(isProp[1])) claims.push({ subject, predicate: 'has-property', object, negated: false });
      continue;
    }
    // An unrecognized content clause is a fabrication risk — it stays
    // unparsed and the critic marks the sentence ungrounded.
  }
  return claims;
}

/** The content words of a sentence — used by the fabrication-rate bench. */
export function contentWordsOf(sentence: string): string[] {
  return tokenizeText(sentence).filter(isContentWord);
}
