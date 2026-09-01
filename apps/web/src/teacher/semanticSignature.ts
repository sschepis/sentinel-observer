/**
 * PHASE 1 EXPERIMENT — semantic prime signatures (docs/PRIME_SEMANTICS_PLAN.md).
 *
 * The hash scheme in `primeSignature.ts` deliberately gives related words
 * UNRELATED signatures. This module is the experimental alternative: a word
 * inherits "category primes" from its is-a ancestors (extracted by
 * `relations.ts`), so signature overlap IS semantic relatedness — siblings
 * share their parent's prime, children share their ancestors'.
 *
 * Phase-1 hypotheses H1–H3 passed, so this is the production vocabulary
 * scheme. Legacy hash signatures remain available as experimental controls.
 *
 * Determinism and auditability match the hash scheme: category primes are
 * assigned by child-count rank with hash-probed placement, differentiator
 * primes come from the same salted FNV-1a picking, and collisions are
 * resolved sieve-style (re-salt differentiators, never the inherited primes).
 */

import { PRIME_SPACE, SIGNATURE_LENGTH, fnv1a } from './primeSignature';
import { generateFusionClosure } from './primeFusion';
import { extractRelations } from './relations';

export const SEMANTIC_VOCABULARY_SCHEME = 'semantic-is-a-v4' as const;

/**
 * v4 = the P3 SMF-width change (sketch 16 → 128). Persisted traces carry
 * their SMF vectors at the training-time width; the vocabulary scheme is the
 * compatibility gate that forces a clean re-teach instead of mixing
 * mismatched-width orientations (bootstrap records are rejected, stored
 * traces re-learned).

/** Deck slice shape accepted everywhere `deckVocabulary` is accepted. */
export interface VocabularyEntry {
  word: string;
  definition?: string;
}

/** Full assignment, exposed for tests and the signature bench. */
export interface SemanticAssignment {
  /** word -> signature, same shape as `deckVocabulary`'s result. */
  vocabulary: Record<string, number[]>;
  /** hypernym -> its category prime (budget-capped, child-count ranked). */
  categoryPrimes: ReadonlyMap<string, number>;
  /** word -> is-a parent (first extracted edge per subject). */
  parents: ReadonlyMap<string, string>;
}

export interface SemanticAssignmentOptions {
  categoryStrategy?: 'hash' | 'fusion';
}

/** At most half the basis is spent on categories; the rest stays free for
 *  differentiators so uniqueness capacity is preserved. */
export function categoryBudget(primeSpace: readonly number[]): number {
  return Math.floor(primeSpace.length / 2);
}

/** Categories larger than this are semantic stopwords ("act", "state",
 *  "person"): the shared prime carries almost no information yet maximizes
 *  recall interference among the siblings. They get no category prime. The
 *  count is TRANSITIVE — excluding "act" must not shift the same
 *  interference onto act's own parent. */
export const MAX_CATEGORY_CHILDREN = 48;

/** Words that would inherit each hypernym's prime — all descendants. */
function descendantCounts(parents: ReadonlyMap<string, string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of parents.keys()) {
    const seen = new Set<string>([word]);
    let current = parents.get(word);
    while (current !== undefined && !seen.has(current)) {
      counts.set(current, (counts.get(current) ?? 0) + 1);
      seen.add(current);
      current = parents.get(current);
    }
  }
  return counts;
}

/** Jaccard similarity of two signatures — the Phase-1/2 overlap measure. */
export function jaccard(a: readonly number[], b: readonly number[]): number {
  const setA = new Set(a);
  const union = new Set(a);
  let intersection = 0;
  for (const p of b) {
    if (setA.has(p)) intersection += 1;
    union.add(p);
  }
  return union.size === 0 ? 0 : intersection / union.size;
}

/**
 * Directed semantic coverage: for each known token in the prompt, find the
 * answer token with the most signature overlap, then average those matches.
 */
export function semanticRelatedness(
  answerTokens: readonly string[],
  promptTokens: readonly string[],
  vocabulary: Readonly<Record<string, readonly number[]>>
): number {
  const answerSignatures = answerTokens
    .map((token) => vocabulary[token.toLowerCase()])
    .filter((signature): signature is readonly number[] => signature !== undefined);
  const promptSignatures = promptTokens
    .map((token) => vocabulary[token.toLowerCase()])
    .filter((signature): signature is readonly number[] => signature !== undefined);
  if (answerSignatures.length === 0 || promptSignatures.length === 0) return 0;

  let total = 0;
  for (const promptSignature of promptSignatures) {
    let best = 0;
    for (const answerSignature of answerSignatures) {
      best = Math.max(best, jaccard(promptSignature, answerSignature));
    }
    total += best;
  }
  return total / promptSignatures.length;
}

/** First is-a edge per subject — the inheritance skeleton. */
export function parentMap(deck: ReadonlyArray<VocabularyEntry>): Map<string, string> {
  const defined = deck.filter(
    (entry): entry is { word: string; definition: string } =>
      typeof entry.definition === 'string' && entry.definition.trim().length > 0
  );
  const parents = new Map<string, string>();
  for (const relation of extractRelations(defined)) {
    if (relation.predicate !== 'is-a') continue;
    const subject = relation.subject.toLowerCase();
    if (!parents.has(subject)) parents.set(subject, relation.object.toLowerCase());
  }
  return parents;
}

/** Ancestor chain (parent, grandparent, ...) with a cycle guard. */
function ancestorsOf(word: string, parents: ReadonlyMap<string, string>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([word]);
  let current = parents.get(word);
  while (current !== undefined && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = parents.get(current);
  }
  return chain;
}

/**
 * Sibling clusters (deck words sharing an is-a parent), largest first —
 * the interference stress-test population for the Phase-1 benches: these
 * are exactly the words semantic overlap could confuse.
 */
export function siblingClusters(
  deck: ReadonlyArray<VocabularyEntry>
): Array<{ parent: string; words: string[] }> {
  const parents = parentMap(deck);
  const deckWords = new Set(deck.map((entry) => entry.word.toLowerCase()));
  const groups = new Map<string, string[]>();
  for (const [word, parent] of parents) {
    if (!deckWords.has(word)) continue;
    const list = groups.get(parent) ?? [];
    list.push(word);
    groups.set(parent, list);
  }
  return [...groups.entries()]
    .map(([parent, words]) => ({ parent, words: [...words].sort() }))
    .filter((group) => group.words.length >= 2)
    .sort((a, b) => b.words.length - a.words.length || (a.parent < b.parent ? -1 : 1));
}

/**
 * Category primes: hypernyms ranked by direct-child count (ties broken
 * lexicographically) claim primes up to the budget. Placement is
 * hash-probed so the assignment is stable under deck reordering.
 */
export function assignCategoryPrimes(
  parents: ReadonlyMap<string, string>,
  primeSpace: readonly number[]
): Map<string, number> {
  const childCounts = new Map<string, number>();
  for (const parent of parents.values()) {
    childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
  }
  const reach = descendantCounts(parents);
  const ranked = [...childCounts.entries()]
    .filter(([hypernym]) => (reach.get(hypernym) ?? 0) <= MAX_CATEGORY_CHILDREN)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

  const budget = categoryBudget(primeSpace);
  const used = new Set<number>();
  const categoryPrimes = new Map<string, number>();
  for (const [hypernym] of ranked.slice(0, budget)) {
    let index = fnv1a(hypernym) % primeSpace.length;
    while (used.has(index)) index = (index + 1) % primeSpace.length;
    used.add(index);
    categoryPrimes.set(hypernym, primeSpace[index]);
  }
  return categoryPrimes;
}

/** Same category ranking as the control, but primes come from triadic closure. */
export function assignFusionCategoryPrimes(
  parents: ReadonlyMap<string, string>,
  primeSpace: readonly number[]
): Map<string, number> {
  const childCounts = new Map<string, number>();
  for (const parent of parents.values()) {
    childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
  }
  const reach = descendantCounts(parents);
  const ranked = [...childCounts.entries()]
    .filter(([hypernym]) => (reach.get(hypernym) ?? 0) <= MAX_CATEGORY_CHILDREN)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const generated = [...generateFusionClosure(primeSpace).keys()].sort((a, b) => a - b);
  const capacity = Math.min(categoryBudget(primeSpace), generated.length);
  const used = new Set<number>();
  const categoryPrimes = new Map<string, number>();
  for (const [hypernym] of ranked.slice(0, capacity)) {
    let index = fnv1a(hypernym) % generated.length;
    while (used.has(index)) index = (index + 1) % generated.length;
    used.add(index);
    categoryPrimes.set(hypernym, generated[index]);
  }
  return categoryPrimes;
}

/** Salted hash differentiators, skipping primes already in the signature. */
function fillDifferentiators(
  word: string,
  salt: number,
  base: readonly number[],
  primeSpace: readonly number[]
): number[] {
  const hash = fnv1a(salt === 0 ? word : `${salt}:${word}`);
  const picks = [...base];
  let slot = 0;
  while (picks.length < SIGNATURE_LENGTH && slot < 7) {
    let index = (hash >>> (slot * 5)) % primeSpace.length;
    let guard = 0;
    while (picks.includes(primeSpace[index]) && guard < primeSpace.length) {
      index = (index + 1) % primeSpace.length;
      guard += 1;
    }
    if (guard >= primeSpace.length) break;
    picks.push(primeSpace[index]);
    slot += 1;
  }
  return picks;
}

/**
 * The full semantic assignment for a deck. Signature layout per word:
 * inherited category primes of its ancestors (nearest first, at most
 * SIGNATURE_LENGTH − 1 so a differentiator slot always remains), then
 * hash differentiators. Collisions re-salt the differentiators only; if a
 * signature still cannot be made unique, inherited primes are dropped
 * deepest-first — degrading toward the hash scheme, never failing.
 */
export function semanticAssignment(
  deck: ReadonlyArray<VocabularyEntry>,
  primeSpace: readonly number[] = PRIME_SPACE,
  options: SemanticAssignmentOptions = {}
): SemanticAssignment {
  const parents = parentMap(deck);
  const categoryPrimes = options.categoryStrategy === 'fusion'
    ? assignFusionCategoryPrimes(parents, primeSpace)
    : assignCategoryPrimes(parents, primeSpace);

  const vocabulary: Record<string, number[]> = {};
  const seen = new Set<string>();

  for (const entry of deck) {
    const word = entry.word.toLowerCase();
    if (vocabulary[word] !== undefined) continue;

    const inherited: number[] = [];
    for (const ancestor of ancestorsOf(word, parents)) {
      const prime = categoryPrimes.get(ancestor);
      if (prime !== undefined && !inherited.includes(prime)) inherited.push(prime);
      // At most half the signature is inherited — the v2 extractor produces
      // deep chains, and a word whose signature is mostly shared ancestry
      // becomes indistinguishable from its siblings in recall.
      if (inherited.length >= SIGNATURE_LENGTH - 2) break;
    }

    let signature: number[] | null = null;
    for (let keep = inherited.length; keep >= 0 && signature === null; keep -= 1) {
      const base = inherited.slice(0, keep);
      for (let salt = 0; salt < primeSpace.length; salt += 1) {
        const candidate = fillDifferentiators(word, salt, base, primeSpace);
        if (candidate.length !== SIGNATURE_LENGTH) continue;
        if (!seen.has(candidate.join(','))) {
          signature = candidate;
          break;
        }
      }
    }
    if (signature === null) {
      throw new Error(`semanticSignature: could not mint a unique signature for "${word}"`);
    }
    seen.add(signature.join(','));
    vocabulary[word] = signature;
  }

  return { vocabulary, categoryPrimes, parents };
}

/** Drop-in replacement for `deckVocabulary` — the experiment's swap point. */
export function semanticVocabulary(
  deck: ReadonlyArray<VocabularyEntry>,
  primeSpace: readonly number[] = PRIME_SPACE,
  options: SemanticAssignmentOptions = {}
): Record<string, number[]> {
  return semanticAssignment(deck, primeSpace, options).vocabulary;
}

/**
 * Independent audit mirroring `auditDeck`: every word gets SIGNATURE_LENGTH
 * distinct in-basis primes, a unique signature, and the assignment is
 * deterministic across calls.
 */
export function auditSemanticDeck(
  deck: ReadonlyArray<VocabularyEntry>,
  primeSpace: readonly number[] = PRIME_SPACE
): {
  words: number;
  uniqueSignatures: number;
  categorized: number;
  collisions: Array<{ word: string; signature: number[] }>;
  valid: boolean;
} {
  const first = semanticAssignment(deck, primeSpace);
  const second = semanticAssignment(deck, primeSpace);

  const collisions: Array<{ word: string; signature: number[] }> = [];
  const seen = new Map<string, string>();
  let categorized = 0;

  for (const [word, signature] of Object.entries(first.vocabulary)) {
    if (second.vocabulary[word].join(',') !== signature.join(',')) {
      collisions.push({ word, signature });
      continue;
    }
    if (new Set(signature).size !== SIGNATURE_LENGTH) {
      throw new Error(`word "${word}" produced a degenerate signature: [${signature}]`);
    }
    for (const p of signature) {
      if (!primeSpace.includes(p)) {
        throw new Error(`word "${word}" has an out-of-basis prime: ${p}`);
      }
    }
    const parent = first.parents.get(word);
    if (parent !== undefined && first.categoryPrimes.has(parent)) categorized += 1;
    const key = signature.join(',');
    const existing = seen.get(key);
    if (existing !== undefined) collisions.push({ word, signature });
    seen.set(key, word);
  }

  return {
    words: Object.keys(first.vocabulary).length,
    uniqueSignatures: seen.size,
    categorized,
    collisions,
    valid: collisions.length === 0
  };
}
