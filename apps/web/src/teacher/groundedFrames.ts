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
 * The dispatch contract: try grounded frames first; the Markov path remains
 * as a LABELED fallback (the caller marks the answer `grounded: false`).
 */

import { edgeObjects, inheritsEdge } from './chain';
import { isContentWord, tokenizeText } from './context';
import { claimHedge } from './grounding';
import { hedgeForClaim } from './corroboration';
import type { Relation, RelationPredicate } from './relations';
import type { Negation } from './relations';
import type { HedgeWord } from './corroboration';

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
 * (direct or inherited). The FIRST frame always names the subject (so the
 * critic can resolve it); later frames use "It".
 */
export function framesFor(subject: string, relations: readonly Relation[]): string[] {
  const frames: string[] = [];
  const parents = edgeObjects(relations, subject, 'is-a');
  const parts = edgeObjects(relations, subject, 'has-part').slice(0, 3);
  const props = edgeObjects(relations, subject, 'has-property').slice(0, 3);
  const actions = edgeObjects(relations, subject, 'capable-of').slice(0, 3);
  const purposes = edgeObjects(relations, subject, 'used-for').slice(0, 3);
  const materials = edgeObjects(relations, subject, 'made-of').slice(0, 3);

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

  return frames;
}

/** Subjects (from the recall seeds) that have at least one fillable frame. */
export function groundedSubjects(words: readonly string[], relations: readonly Relation[]): string[] {
  return [...new Set(words)].filter((word) => isContentWord(word) && framesFor(word, relations).length > 0);
}

/**
 * Compose a grounded sentence: pick a seed subject with edges, fill 1–3
 * frames deterministically from the supplied rng. Returns null when no seed
 * subject has any edge — the caller falls back to the labeled Markov path.
 */
export function composeGrounded(
  seedWords: readonly string[],
  relations: readonly Relation[],
  rng: () => number,
  maxSentences = 3
): GroundedComposition | null {
  const candidates = groundedSubjects(seedWords, relations);
  if (candidates.length === 0) return null;
  // Prefer the utterance's own topic: seedWords are ordered [utterance words,
  // ...memory words], so the first candidate is the first utterance content
  // word with edges. It wins most draws; the pool keeps variety.
  const subject =
    rng() < 0.75 ? candidates[0] : candidates[Math.floor(rng() * candidates.length)];
  const frames = framesFor(subject, relations);
  // The FIRST frame always names the subject (the critic's resolution anchor);
  // the rest are drawn deterministically from the remaining pool.
  const picked: string[] = [frames[0]];
  const pool = frames.slice(1);
  const count = Math.min(maxSentences, Math.max(1, 1 + Math.floor(rng() * frames.length)));
  for (let i = 1; i < count && pool.length > 0; i += 1) {
    picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  const sentence = picked.join(' ').replace(/\s+([.!?])/g, '$1');
  const verdict = criticize(sentence, relations, []);
  return { sentence, edges: verdict.grounded ? verdict.edges : [], frames: picked, hedged: verdict.hedged };
}

/**
 * THE INTERNAL CRITIC — parse a candidate sentence back through the claim
 * grammar and refuse any claim not supported by a stored edge (direct or
 * inherited) or the confirmed-false store. An unparseable sentence (no
 * resolvable subject, unknown clause) is ungrounded by definition.
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
  negations: readonly Negation[]
): { grounded: boolean; unbacked: string[]; edges: Array<{ subject: string; predicate: RelationPredicate; object: string }>; hedged: boolean; hedges: HedgeWord[] } {
  const subject = extractSubject(sentence);
  if (subject === null) return { grounded: false, unbacked: [sentence], edges: [], hedged: false, hedges: [] };
  const claims = parseClaims(sentence, subject);
  if (claims.length === 0) return { grounded: false, unbacked: [sentence], edges: [], hedged: false, hedges: [] };

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
    const via = direct ? null : inheritsEdge(relations, claim.subject, claim.predicate, claim.object);
    if (direct || via !== null) {
      edges.push({ subject: claim.subject, predicate: claim.predicate, object: claim.object });
      // P14: the corroboration hedge of the backing edge (direct or inherited).
      hedges.push(claimHedge(relations, claim.subject, claim.predicate, claim.object));
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
function extractSubject(sentence: string): string | null {
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
