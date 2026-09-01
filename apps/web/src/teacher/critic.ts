/**
 * THE INTERNAL CRITIC (P5) — the claim grammar every composed sentence is
 * parsed back through.
 *
 * Grounded generation fills typed frames from stored edges, so a composed
 * sentence is grounded by construction; the critic is the second gate that
 * REFUSES any claim not backed by the relation graph (direct or inherited)
 * or the confirmed-false store — fabrication without an LLM. It is also the
 * admission gate for learned templates: a candidate template is admitted
 * only if every sentence it can render re-parses here into backed claims.
 *
 * Extracted from groundedFrames.ts so the learned-template induction
 * (learnedFrames.ts) can reuse the grammar without a circular import.
 */

import { isContentWord, tokenizeText } from './context';
import { inheritsEdge } from './chain';
import type { Negation, Relation, RelationPredicate } from './relations';

/** One parsed claim of a candidate sentence. */
export interface Claim {
  subject: string;
  predicate: RelationPredicate;
  object: string;
  negated: boolean;
}

/** A claim veto: true when (subject, predicate, object) is confirmed false. */
export type DeniedClaim = (subject: string, predicate: string, object: string) => boolean;

/** Build a `DeniedClaim` veto from the confirmed-false store. */
export function deniedFromNegations(
  negations: readonly { subject: string; predicate: string; object: string }[]
): DeniedClaim {
  if (negations.length === 0) return () => false;
  const keys = new Set(negations.map((n) => `${n.subject}\u0000${n.predicate}\u0000${n.object}`));
  return (subject, predicate, object) => keys.has(`${subject}\u0000${predicate}\u0000${object}`);
}

/**
 * THE INTERNAL CRITIC — parse a candidate sentence back through the claim
 * grammar and refuse any claim not supported by a stored edge (direct or
 * inherited) or the confirmed-false store. An unparseable sentence (no
 * resolvable subject, unknown clause) is ungrounded by definition.
 */
export function criticize(
  sentence: string,
  relations: readonly Relation[],
  negations: readonly Negation[]
): {
  grounded: boolean;
  unbacked: string[];
  edges: Array<{ subject: string; predicate: RelationPredicate; object: string }>;
  /** The subject the first frame names (null when unresolvable). */
  subject: string | null;
} {
  const subject = extractSubject(sentence);
  if (subject === null) return { grounded: false, unbacked: [sentence], edges: [], subject: null };
  const claims = parseClaims(sentence, subject);
  if (claims.length === 0) return { grounded: false, unbacked: [sentence], edges: [], subject };

  const edges: Array<{ subject: string; predicate: RelationPredicate; object: string }> = [];
  const unbacked: string[] = [];
  const denied = deniedFromNegations(negations);
  for (const claim of claims) {
    if (claim.negated) {
      if (negations.some((n) => n.subject === claim.subject && n.predicate === claim.predicate && n.object === claim.object)) {
        edges.push({ subject: claim.subject, predicate: claim.predicate, object: claim.object });
      } else {
        unbacked.push(`${claim.subject} is-not ${claim.object}`);
      }
      continue;
    }
    // A taught falsehood outranks extraction: a positive claim the
    // confirmed-false store contradicts is refused even with a stored edge.
    if (denied(claim.subject, claim.predicate, claim.object)) {
      unbacked.push(`${claim.subject} ${claim.predicate} ${claim.object}`);
      continue;
    }
    const direct = relations.some(
      (r) => r.subject === claim.subject && r.predicate === claim.predicate && r.object === claim.object
    );
    const via = direct ? null : inheritsEdge(relations, claim.subject, claim.predicate, claim.object);
    if (direct || via !== null) {
      edges.push({ subject: claim.subject, predicate: claim.predicate, object: claim.object });
    } else {
      unbacked.push(`${claim.subject} ${claim.predicate} ${claim.object}`);
    }
  }
  return { grounded: unbacked.length === 0, unbacked, edges, subject };
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
