/**
 * SENSE MODEL (§7.2 / Phase F.2) — signature per sense, behind the
 * `senseSplit` flag.
 *
 * §7.1 measured a merged-sense fabrication path: a surface word whose
 * relation graph carries is-a parents in UNRELATED closures (e.g. 'bank'
 * is-a institution AND is-a slope) answers cross-sense probes from the
 * merged graph. §7.2 assigns each distinct reading its own sense node
 * (bank#1, bank#2) with its own four-prime signature; the surface word
 * excites the union of its senses' primes at split amplitude; definitions,
 * edges, and traces live on the sense; chain walks run over sense nodes and
 * cannot cross senses.
 *
 * This module is PURE and shared by the teacher (relations split, teach),
 * the probe test, and `cli/polysemy-bench.ts` — the same discipline as
 * `polysemyProbes.ts`. It IMPORTS `chain.ts` for the depth-bounded walk
 * semantics (`ancestors`) instead of editing it: the sense closures below
 * mirror exactly the walk the operator layer performs, so "unrelated
 * readings" means what the operator layer would and would not traverse.
 *
 * LEGACY COMPATIBILITY: everything here is additive. Surface-word
 * signatures (primeSignature / semanticSignature) are untouched and
 * byte-identical; `senseVocabulary` layers sense entries OVER the caller's
 * base vocabulary and leaves every non-split entry alone.
 */
import type { Relation } from './relations';
import { mergeRelations, extractRelations } from './relations';
import { isAParentsOf, wordsWithUnrelatedIsAParents } from './polysemyProbes';
import { ancestors, type DeniedClaim } from './chain';
import { PRIME_SPACE, SIGNATURE_LENGTH, sensePrimeSignature } from './primeSignature';
import { technicalRelations } from './technical';
import { SUPPLEMENTAL_RELATIONS } from './decks/relationSupplements';
import { GROUNDED_FACTS_RELATIONS } from './decks/groundedFacts';

const NEVER_DENIED: DeniedClaim = () => false;

/** The sense-node key for the `index`-th reading of a surface word. */
export function senseKeyOf(surface: string, index: number): string {
  return `${surface}#${index}`;
}

/** The `senseSplit` constructor option: `true` derives the assignment from
 *  the relation graph; an object form may carry a PRE-MINTED assignment —
 *  the caller builds the session vocabulary from the same assignment
 *  (`senseVocabulary`), so the two agree by construction. */
export interface SenseSplitConfig {
  assignment?: SenseAssignment;
}

/** True when `key` has the `${surface}#${index}` sense-node shape. */
export function isSenseKey(key: string): boolean {
  return /^[a-z-]+#\d+$/.test(key);
}

/** Parse a sense key back into its surface word and 1-based index. */
export function parseSenseKey(key: string): { surface: string; index: number } | null {
  const match = /^([a-z-]+)#(\d+)$/.exec(key);
  if (match === null) return null;
  return { surface: match[1], index: Number(match[2]) };
}

/** One distinct reading of a polysemous surface word. */
export interface SenseReading {
  /** The sense node key (bank#1). */
  key: string;
  /** The surface word (bank). */
  surface: string;
  /** 1-based reading index. */
  index: number;
  /** The direct is-a parents this reading carries (its closure's roots). */
  parents: string[];
  /** The gloss spoken when the observer disambiguates: the relation source
   *  of the reading's lead parent, or `a <parent>` when absent. */
  reading: string;
}

/**
 * Cluster a subject's direct is-a parents into DISTINCT READINGS. Two
 * parents share a reading iff one's is-a closure contains the other (within
 * the chain walk's depth bound — `ancestors` mirrors chain.ts exactly), the
 * same "unrelated" relation `wordsWithUnrelatedIsAParents` measures.
 * Readings are ordered deterministically: the reading carrying a
 * definitional ('regex') parent first, then the remaining readings by their
 * lexicographically smallest parent.
 */
export function senseGroupsFor(
  relations: readonly Relation[],
  subject: string,
  denied: DeniedClaim = NEVER_DENIED
): SenseReading[] {
  const parents = isAParentsOf(relations, subject);
  if (parents.length < 2) return [];
  const closureCache = new Map<string, Set<string>>();
  const closureOf = (parent: string): Set<string> => {
    const cached = closureCache.get(parent);
    if (cached !== undefined) return cached;
    const closure = new Set(ancestors(relations, parent, denied));
    closureCache.set(parent, closure);
    return closure;
  };
  // Union-find over the parents: p ~ q iff one's closure contains the other.
  const groups: string[][] = [];
  for (const parent of parents) {
    const existing = groups.findIndex((group) =>
      group.some((member) => closureOf(member).has(parent) || closureOf(parent).has(member))
    );
    if (existing === -1) {
      groups.push([parent]);
    } else {
      groups[existing].push(parent);
    }
  }
  if (groups.length < 2) return [];
  const originOf = (parent: string): string | undefined =>
    relations.find((r) => r.subject === subject && r.predicate === 'is-a' && r.object === parent)?.origin;
  const ordered = groups
    .map((members) => ({ members: [...members].sort(), regex: members.some((m) => originOf(m) === 'regex') }))
    .sort((a, b) => Number(b.regex) - Number(a.regex) || (a.members[0] < b.members[0] ? -1 : 1));
  return ordered.map((group, index) => {
    const lead =
      group.members.find((m) => originOf(m) === 'regex') ?? group.members[0];
    const source = relations.find(
      (r) => r.subject === subject && r.predicate === 'is-a' && r.object === lead
    )?.source;
    return {
      key: senseKeyOf(subject, index + 1),
      surface: subject,
      index: index + 1,
      parents: group.members,
      reading: typeof source === 'string' && source.trim().length > 0 ? source.trim() : `a ${lead}`
    };
  });
}

/** Words the sense model splits: surface words with is-a parents in
 *  unrelated closures (the §7.1 population, via polysemyProbes.ts). */
export function wordsWithSenseSplits(relations: readonly Relation[]): string[] {
  return wordsWithUnrelatedIsAParents(relations);
}

/** The authored edge pool, mirrored from the teacher's
 *  `authoredRelationPool` — one definition, so a session vocabulary built
 *  from this graph matches the graph the teacher derives. */
export function authoredRelationPool(knownWords: ReadonlySet<string>): Relation[] {
  return [...technicalRelations(), ...SUPPLEMENTAL_RELATIONS, ...GROUNDED_FACTS_RELATIONS]
    .filter((relation) => knownWords.has(relation.subject) && knownWords.has(relation.object))
    .map((relation): Relation => relation.predicate === 'special-case-of'
      ? { ...relation, predicate: 'is-a' }
      : relation);
}

/** The full merged graph the teacher derives from a deck: regex extraction
 *  + authored pool + chaperone-supplied edges. The caller feeds this to
 *  `assignSenses` so the pre-built session vocabulary and the teacher's
 *  runtime split agree by construction. */
export function mergedGraphFor(
  definitions: ReadonlyArray<{ word: string; definition: string }>,
  knownWords: ReadonlySet<string>,
  chaperone: readonly Relation[]
): Relation[] {
  return mergeRelations(extractRelations(definitions), authoredRelationPool(knownWords), chaperone);
}

export interface SenseAssignment {
  /** surface word -> its readings (only sense-split words are present). */
  readingsOf: ReadonlyMap<string, readonly SenseReading[]>;
  /** sense node key -> its own four-prime signature. */
  signatures: Readonly<Record<string, readonly number[]>>;
  /** surface word -> the UNION of its senses' primes (the split-amplitude
   *  excitation entry that replaces the surface entry in the vocabulary). */
  surfaceUnions: Readonly<Record<string, readonly number[]>>;
}

/** The normalized key of a signature (sorted primes joined) — the
 *  collision-avoidance identity used for minting. */
export function signatureKey(primes: readonly number[]): string {
  return [...primes].sort((a, b) => a - b).join(',');
}

/** The reserved keys of a deployed vocabulary — every surface signature a
 *  minted sense signature must not collide with. */
export function reservedSignatureKeys(
  vocabulary: Readonly<Record<string, readonly number[]>>
): Set<string> {
  return new Set(Object.values(vocabulary).map((primes) => signatureKey(primes)));
}

/**
 * Assign one sense node per distinct reading for every word whose graph
 * carries is-a parents in unrelated closures. Each sense's signature is
 * derived deterministically from (word, sense index) via
 * `sensePrimeSignature`, escalating salt against the caller's `reserved`
 * signatures and the already-minted sense signatures — so no sense node
 * shares its four-prime set with a surface word or another sense. The
 * surface union entries concatenate each sense's primes in reading order.
 */
export function assignSenses(
  relations: readonly Relation[],
  primeSpace: readonly number[] = PRIME_SPACE,
  reservedKeys: ReadonlySet<string> = new Set<string>()
): SenseAssignment {
  const readingsOf = new Map<string, readonly SenseReading[]>();
  const signatures: Record<string, number[]> = Object.create(null) as Record<string, number[]>;
  const surfaceUnions: Record<string, number[]> = Object.create(null) as Record<string, number[]>;
  const used = new Set<string>(reservedKeys);
  for (const word of wordsWithSenseSplits(relations)) {
    const readings = senseGroupsFor(relations, word);
    if (readings.length < 2) continue;
    readingsOf.set(word, readings);
    const union: number[] = [];
    for (const reading of readings) {
      let signature: number[] | null = null;
      for (let salt = 0; salt < primeSpace.length && signature === null; salt += 1) {
        const candidate = sensePrimeSignature(reading.surface, reading.index, primeSpace, salt);
        if (candidate.length !== SIGNATURE_LENGTH) continue;
        const key = signatureKey(candidate);
        if (!used.has(key)) {
          signature = candidate;
          used.add(key);
        }
      }
      if (signature === null) {
        throw new Error(`senseModel: could not mint a unique signature for ${reading.key}`);
      }
      signatures[reading.key] = signature;
      for (const prime of signature) {
        if (!union.includes(prime)) union.push(prime);
      }
    }
    surfaceUnions[word] = union;
  }
  return { readingsOf, signatures, surfaceUnions };
}

/**
 * The deployed vocabulary for a sense-split session: the caller's base
 * vocabulary (byte-identical entries) with sense-split surface words
 * re-pointed at their sense-prime UNION and every sense node added under
 * its own signature. The surface word now excites the union of its senses'
 * primes — the split-amplitude excitation contract, implemented in the
 * vocabulary so every text cue ("bank") resolves symmetrically on both the
 * store and the recall side.
 */
export function senseVocabulary(
  base: Readonly<Record<string, readonly number[]>>,
  assignment: SenseAssignment
): Record<string, number[]> {
  const merged: Record<string, number[]> = Object.create(null) as Record<string, number[]>;
  for (const [word, primes] of Object.entries(base)) {
    merged[word] = [...primes];
  }
  for (const [word, union] of Object.entries(assignment.surfaceUnions)) {
    merged[word] = [...union];
  }
  for (const [key, primes] of Object.entries(assignment.signatures)) {
    merged[key] = [...primes];
  }
  return merged;
}

/**
 * THE GRAPH SPLIT — rewrite a merged relation graph so edges live on sense
 * nodes: an is-a edge moves to the reading whose direct parents (or whose
 * closure) contain its object, falling back to reading #1; every other
 * predicate from a sense-split surface word moves to reading #1 (the
 * definitional reading). Edges of non-split words pass through unchanged,
 * and edge OBJECTS are never rewritten — a walk that reaches a sense-split
 * surface word from another word stops there, so chain walks run over sense
 * nodes and CANNOT CROSS SENSES.
 */
export function splitRelationsBySense(
  relations: readonly Relation[],
  assignment: SenseAssignment,
  denied: DeniedClaim = NEVER_DENIED
): Relation[] {
  if (assignment.readingsOf.size === 0) return [...relations];
  const out: Relation[] = [];
  for (const relation of relations) {
    const readings = assignment.readingsOf.get(relation.subject);
    if (readings === undefined) {
      out.push(relation);
      continue;
    }
    let target: SenseReading | undefined;
    if (relation.predicate === 'is-a') {
      target = readings.find((reading) => reading.parents.includes(relation.object));
      if (target === undefined) {
        // Not a direct parent of any reading — assign by closure membership.
        target = readings.find((reading) =>
          reading.parents.some((parent) => ancestors(relations, parent, denied).includes(relation.object))
        );
      }
    }
    target = target ?? readings[0];
    out.push({ ...relation, subject: target.key });
  }
  return out;
}

/** The is-a closure of ONE sense over a SPLIT graph: the sense node plus
 *  its ancestors, via the same depth-bounded walk chain.ts performs. The
 *  walk cannot cross senses — no edge ever enters a sense node, so each
 *  sense's closure is exactly its own reading's ancestry. */
export function senseClosure(
  relations: readonly Relation[],
  reading: SenseReading,
  denied: DeniedClaim = NEVER_DENIED
): Set<string> {
  return new Set(ancestors(relations, reading.key, denied));
}

/** The per-sense closures of a surface word over a split graph: one
 *  closure per reading — what the §7.5 negative-target selector computes
 *  after the split instead of the merged closure. */
export function senseClosuresOf(
  relations: readonly Relation[],
  assignment: SenseAssignment,
  subject: string,
  denied: DeniedClaim = NEVER_DENIED
): Set<string>[] {
  const readings = assignment.readingsOf.get(subject);
  if (readings === undefined) return [new Set(ancestors(relations, subject, denied))];
  return readings.map((reading) => senseClosure(relations, reading, denied));
}
