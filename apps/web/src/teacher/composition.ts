/**
 * MULTI-PREDICATE COMPOSITION — sound chains over typed edges (P10).
 *
 * A single operator answers from one edge; two composable edges give
 * INFERENCE. This layer generalizes the existing is-a inheritance walks to
 * ANY sound predicate sequence: bird is-a animal → animal has-part heart →
 * heart capable-of pump blood composes to "a bird can pump blood" — a claim
 * no single edge states.
 *
 * Three gates stand between a chain and a composed claim:
 *
 *  1. SOUNDNESS — the predicate sequence must match a COMPOSITION_RULE.
 *     is-a is transitive, and properties/capabilities/purposes inherit down
 *     is-a; a PART's capability transfers to the whole (has-part →
 *     capable-of). Everything else — parts of parts, capable-of of a
 *     capability, a part's kind becoming the whole's kind — is REJECTED:
 *     unsound sequences compose nothing. Composition is a table, not a
 *     free-form path algebra.
 *
 *  2. MDL — composition is NOT free. The composed claim is adopted only when
 *     its description-length saving beats the added complexity of the
 *     inference: the bits of the spelled-out chain (what the claim
 *     compresses) minus the bits of the claim itself minus a per-step rule
 *     cost must be positive. Cheap chains through ubiquitous words do not
 *     pay for the inference; chains through rare, informative words do.
 *
 *  3. NEGATION — a chain is rejected when any hop or the conclusion
 *     conflicts with the confirmed-false store (deniedFromNegations). A
 *     taught "birds do not have wheels" kills every chain that would derive
 *     one. Absence of a negation is never evidence for a chain.
 *
 * Every hop carries its edge's confidence weight; the composed claim's
 * SUPPORT is the weakest hop's strength, so a chain is only as strong as its
 * least-confident link.
 */

import { isContentWord, tokenizeText } from './context';
import { inheritsEdge } from './chain';
import { TokenCostModel } from './mdl';
import {
  indexRelations,
  predicateVerb,
  type Negation,
  type Relation,
  type RelationPredicate
} from './relations';

/** One stored edge of a chain, with its confidence weight (absent = 1). */
export interface ChainHop {
  subject: string;
  predicate: RelationPredicate;
  object: string;
  strength: number;
}

/** A sound predicate sequence and the claim predicate it licenses. */
export interface CompositionRule {
  hops: readonly RelationPredicate[];
  conclusion: RelationPredicate;
}

/**
 * THE COMPOSITION RULES — every sound predicate sequence. The is-a family
 * formalizes what `inheritsEdge` already does informally (properties inherit
 * down the taxonomy); the has-part → capable-of pair is the new step (a
 * part's capability transfers to the whole, "birds can pump blood" via the
 * heart). Any sequence not listed here is unsound by construction.
 */
export const COMPOSITION_RULES: readonly CompositionRule[] = [
  { hops: ['is-a', 'is-a'], conclusion: 'is-a' },
  { hops: ['is-a', 'has-part'], conclusion: 'has-part' },
  { hops: ['is-a', 'capable-of'], conclusion: 'capable-of' },
  { hops: ['is-a', 'has-property'], conclusion: 'has-property' },
  { hops: ['is-a', 'used-for'], conclusion: 'used-for' },
  { hops: ['is-a', 'requires'], conclusion: 'requires' },
  { hops: ['is-a', 'located-in'], conclusion: 'located-in' },
  { hops: ['is-a', 'made-of'], conclusion: 'made-of' },
  { hops: ['is-a', 'causes'], conclusion: 'causes' },
  { hops: ['has-part', 'capable-of'], conclusion: 'capable-of' },
  { hops: ['is-a', 'has-part', 'capable-of'], conclusion: 'capable-of' }
];

/** A chain that cleared all three gates. */
export interface ComposedClaim {
  subject: string;
  /** The conclusion predicate (the rule's conclusion, not the last hop's). */
  predicate: RelationPredicate;
  object: string;
  /** The full evidence chain, in walk order (the provenance the claim cites). */
  hops: ChainHop[];
  /** The weakest hop's confidence weight — the claim is only as strong as
   *  its least-confident link. */
  support: number;
  /** MDL gain in bits — positive is the condition for adoption. */
  gain: number;
  /** The rule whose sequence the chain matched (post is-a collapsing). */
  rule: CompositionRule;
}

export interface CompositionOptions {
  /** The confirmed-false store; any hop or conclusion matching one is denied. */
  negations?: readonly Negation[];
  /** Lookup-form negation check (the operator path's negationOf), checked
   *  in addition to `negations`. */
  denied?: (subject: string, predicate: string, object: string) => boolean;
  /** The frequency-prior bit-cost model. When omitted, one is derived from
   *  the relation graph's own vocabulary (deterministic per graph). */
  cost?: TokenCostModel | null;
  /** Maximum chain length in edges (the walk is breadth-bounded). */
  maxDepth?: number;
}

/**
 * The inference's own complexity, in bits, PER COMPOSITION STEP. This is the
 * "composition is not free" constant: every hop added to a chain must be
 * paid for by the claim's compression of the chain.
 */
export const COMPOSITION_STEP_COST = 2;

/** The rule matching a predicate sequence, or null when the sequence is
 *  unsound. Consecutive is-a hops collapse to one (transitivity is itself
 *  the [is-a, is-a] rule, applied twice), so a chain through a multi-level
 *  taxonomy still matches the 3-hop pattern. */
export function isSoundSequence(predicates: readonly RelationPredicate[]): CompositionRule | null {
  const exact = COMPOSITION_RULES.find(
    (rule) => rule.hops.length === predicates.length && rule.hops.every((p, i) => p === predicates[i])
  );
  if (exact !== undefined) return exact;
  // Collapsed form: [is-a, is-a, X] and longer is-a runs mean [is-a, X].
  const collapsed: RelationPredicate[] = [];
  for (const predicate of predicates) {
    if (predicate === 'is-a' && collapsed[collapsed.length - 1] === 'is-a') continue;
    collapsed.push(predicate);
  }
  if (collapsed.length === predicates.length) return null;
  return (
    COMPOSITION_RULES.find(
      (rule) => rule.hops.length === collapsed.length && rule.hops.every((p, i) => p === collapsed[i])
    ) ?? null
  );
}

/** The confirmed-false entry for a claim, or null — the only "No". */
export function deniedFromNegations(
  negations: readonly Negation[],
  subject: string,
  predicate: string,
  object: string
): Negation | null {
  return (
    negations.find(
      (n) => n.subject === subject && n.predicate === predicate && n.object === object
    ) ?? null
  );
}

/** The description-length cost of a phrase's CONTENT words under the model.
 *  Predicate and function tokens are scaffolding and cost nothing — the gate
 *  weighs the claim's information, not its grammar. */
function contentCost(cost: TokenCostModel, text: string): number {
  return tokenizeText(text)
    .filter((token) => isContentWord(token))
    .reduce((sum, token) => sum + cost.costOf(token), 0);
}

/**
 * The MDL gate: the bits saved by the composed claim (the chain it
 * compresses, spelled out) minus the bits of the claim itself minus the
 * inference's own complexity (COMPOSITION_STEP_COST per hop). Positive gain
 * = adopting the composition compresses memory. Single stored edges never
 * reach this gate — composition only gates chains of two or more hops.
 */
export function compositionGain(
  cost: TokenCostModel,
  claim: { subject: string; predicate: string; object: string },
  hops: readonly ChainHop[]
): number {
  const savings = hops.reduce(
    (sum, hop) => sum + contentCost(cost, `${hop.subject} ${hop.object}`),
    0
  );
  const claimCost = contentCost(cost, `${claim.subject} ${claim.object}`);
  return savings - claimCost - COMPOSITION_STEP_COST * hops.length;
}

/** A deterministic frequency model derived from a graph's own vocabulary. */
function graphCostModel(relations: readonly Relation[]): TokenCostModel {
  const words: string[] = [];
  const seen = new Set<string>();
  for (const relation of relations) {
    for (const word of [relation.subject, relation.object]) {
      if (!seen.has(word)) {
        seen.add(word);
        words.push(word);
      }
    }
  }
  return new TokenCostModel(words);
}

function isDenied(options: CompositionOptions, subject: string, predicate: string, object: string): boolean {
  if (options.denied !== undefined && options.denied(subject, predicate, object)) return true;
  if (options.negations !== undefined) {
    return deniedFromNegations(options.negations, subject, predicate, object) !== null;
  }
  return false;
}

/** Every acyclic edge path from `subject`, up to `maxDepth` edges. */
function allChains(relations: readonly Relation[], subject: string, maxDepth: number): ChainHop[][] {
  const index = indexRelations(relations);
  const result: ChainHop[][] = [];
  const stack: Array<{ path: ChainHop[]; node: string; seen: Set<string> }> = [
    { path: [], node: subject, seen: new Set([subject]) }
  ];
  while (stack.length > 0) {
    const { path, node, seen } = stack.pop()!;
    for (const edge of index.get(node) ?? []) {
      if (seen.has(edge.object)) continue;
      const hop: ChainHop = {
        subject: node,
        predicate: edge.predicate,
        object: edge.object,
        strength: edge.strength ?? 1
      };
      const nextPath = [...path, hop];
      result.push(nextPath);
      if (nextPath.length < maxDepth) {
        const nextSeen = new Set(seen);
        nextSeen.add(edge.object);
        stack.push({ path: nextPath, node: edge.object, seen: nextSeen });
      }
    }
  }
  return result;
}

/** The gates on one candidate chain, or null when any gate fails. */
function evaluate(
  rule: CompositionRule,
  hops: readonly ChainHop[],
  cost: TokenCostModel,
  options: CompositionOptions
): ComposedClaim | null {
  const conclusion = {
    subject: hops[0].subject,
    predicate: rule.conclusion,
    object: hops[hops.length - 1].object
  };
  if (conclusion.subject === conclusion.object) return null;
  // NEGATION: any hop OR the conclusion conflicting with a confirmed
  // falsehood kills the whole chain — never a partial derivation.
  for (const hop of hops) {
    if (isDenied(options, hop.subject, hop.predicate, hop.object)) return null;
  }
  if (isDenied(options, conclusion.subject, conclusion.predicate, conclusion.object)) return null;
  const support = hops.reduce((min, hop) => Math.min(min, hop.strength), 1);
  const gain = compositionGain(cost, conclusion, hops);
  if (gain <= 0) return null; // MDL: composition is not free
  return { ...conclusion, hops: [...hops], support, gain, rule };
}

/**
 * Back the claim (subject, predicate, object) with a sound chain, or null.
 * Used by the internal critic and the operator fallback: when no single
 * stored edge states the claim, a chain may still — subject is-a parent,
 * parent has-part part, part capable-of object ⇒ subject capable-of object.
 */
export function composeClaim(
  relations: readonly Relation[],
  subject: string,
  predicate: RelationPredicate,
  object: string,
  options: CompositionOptions = {}
): ComposedClaim | null {
  if (subject === object) return null;
  const maxDepth = options.maxDepth ?? 4;
  const cost = options.cost ?? graphCostModel(relations);
  let best: ComposedClaim | null = null;
  for (const hops of allChains(relations, subject, maxDepth)) {
    if (hops.length < 2) continue;
    const rule = isSoundSequence(hops.map((hop) => hop.predicate));
    if (rule === null || rule.conclusion !== predicate) continue;
    if (hops[hops.length - 1].object !== object) continue;
    const claim = evaluate(rule, hops, cost, options);
    if (claim === null) continue;
    if (best === null || claim.gain > best.gain) best = claim;
  }
  return best;
}

/**
 * Every sound composed claim derivable from `subject` (for generation).
 * Claims a single edge or is-a inheritance already answers are excluded —
 * the composed frames are NEW knowledge only, so they never duplicate the
 * direct frames.
 */
export function composedClaimsFor(
  subject: string,
  relations: readonly Relation[],
  options: CompositionOptions = {}
): ComposedClaim[] {
  const maxDepth = options.maxDepth ?? 4;
  const cost = options.cost ?? graphCostModel(relations);
  const byKey = new Map<string, ComposedClaim>();
  for (const hops of allChains(relations, subject, maxDepth)) {
    if (hops.length < 2) continue;
    const rule = isSoundSequence(hops.map((hop) => hop.predicate));
    if (rule === null) continue;
    const claim = evaluate(rule, hops, cost, options);
    if (claim === null) continue;
    const direct = relations.some(
      (r) =>
        r.subject === claim.subject && r.predicate === claim.predicate && r.object === claim.object
    );
    const inherited = direct ? null : inheritsEdge(relations, claim.subject, claim.predicate, claim.object);
    if (direct || inherited !== null) continue; // old machinery already answers it
    const key = `${claim.predicate}\u0000${claim.object}`;
    const existing = byKey.get(key);
    if (existing === undefined || claim.gain > existing.gain) byKey.set(key, claim);
  }
  return [...byKey.values()].sort((a, b) => b.gain - a.gain);
}

/** "a" / "a and b" / "a, b and c" — the evidence list in the answer. */
function listPhrase(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')}, and ${words[words.length - 1]}`;
}

/**
 * The chain spoken as evidence: "bird is an animal, animal has a heart, and
 * heart can pump blood". Each hop reads as its natural English verb, so the
 * composed answer cites its full path — the observer shows its work.
 */
export function chainPhrase(claim: ComposedClaim): string {
  const phrases = claim.hops.map(
    (hop) => `${hop.subject} ${predicateVerb(hop.predicate, hop.object)} ${hop.object}`
  );
  return listPhrase(phrases);
}
