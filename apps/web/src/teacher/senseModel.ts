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
 * §7.4 adds SENSE INDUCTION AS SPLIT FROM CONTEXT, behind
 * `CONTEXT_SENSE_SPLIT_FLAGS` (default OFF): a `ContextSenseRecorder` keeps
 * the co-excited context primes at each store/recall, and
 * `contextSplitDecision` splits a trace into two senses exactly when its
 * context distribution is BIMODAL (two distinguishable context clusters,
 * read with the cde.ts instrument) AND the split's conditional-entropy
 * reduction exceeds the new sense node's cost — the §9 MDL criterion run in
 * the split direction.
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
import { normalizedEntropy, topTwoMargin } from './cde';
import { UNKNOWN_TOKEN_COST } from './mdl';

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
  // PER-SENSE READINGS MUST BE DISTINCT — the disambiguating ask names both,
  // so two readings with the same text ("as in X, or as in X") are a bug.
  // A group's candidate gloss is its lead edge's source; a generic
  // curriculum label ("everyday-knowledge curriculum") or a source already
  // claimed by another group falls back to the distinct parent itself
  // ("a bank" / "a slope"), with the same article convention the probe
  // questions use.
  const sourceOf = (parent: string): string => {
    const source = relations.find(
      (r) => r.subject === subject && r.predicate === 'is-a' && r.object === parent
    )?.source;
    return typeof source === 'string' ? source.trim() : '';
  };
  const GENERIC_LABEL = /curriculum\s*$/i;
  const article = (noun: string): string => (/^[aeiou]/.test(noun) ? 'an' : 'a');
  // A gloss quotes only its primary clause: "a very large person;
  // impressive in size" reads as "a very large person" in the ask.
  const glossOf = (source: string): string => {
    let end = source.length;
    for (const separator of [';', ':']) {
      const at = source.indexOf(separator);
      if (at !== -1 && at < end) end = at;
    }
    const trimmed = source.slice(0, end).trim();
    return trimmed.length > 0 ? trimmed : source.trim();
  };
  const leadOf = (group: { members: string[] }): string =>
    group.members.find((m) => originOf(m) === 'regex') ?? group.members[0];
  const claimed = new Set<string>();
  const readings = ordered.map((group, index) => {
    const lead = leadOf(group);
    const candidate = glossOf(sourceOf(lead));
    let reading = candidate.length > 0 && !GENERIC_LABEL.test(candidate) && !claimed.has(candidate) ? candidate : '';
    if (reading.length === 0 || claimed.has(reading)) {
      reading = `${article(lead)} ${lead}`;
    }
    claimed.add(reading);
    return {
      key: senseKeyOf(subject, index + 1),
      surface: subject,
      index: index + 1,
      parents: group.members,
      reading
    };
  });
  // DEGENERATE SPLIT: a word whose readings cannot be made distinct has no
  // two-sense distinction to expose — it keeps the merged graph instead of
  // a fake split whose ask would name the same gloss twice.
  if (new Set(readings.map((r) => r.reading)).size !== readings.length) return [];
  return readings;
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

// ────────────────────────────────────────────────────────────────────────────
// §7.4 SENSE INDUCTION AS SPLIT FROM CONTEXT — the context-bimodality rule.
//
// Where WordNet supplies no senses, the entropy principle supplies an
// induction rule: a trace's CONTEXTS — the prime sets co-excited with it
// across its stores and recalls — form a distribution. When that
// distribution is BIMODAL (two distinguishable context clusters), splitting
// the trace into two senses reduces the conditional entropy of context
// given sense. The split is taken exactly when the reduction exceeds the
// cost of the new sense node — an MDL gain in the same currency as §9
// (split lowers the description length of context given sense; §9's merge
// lowers the description length of edges given concept).
//
// EVERYTHING BELOW IS BEHIND `CONTEXT_SENSE_SPLIT_FLAGS` (default OFF):
// recording is a no-op and the rule refuses to split while the flag is
// off, so every existing behavior stays bit-identical — the same additive
// discipline as the `senseSplit` constructor option above. The
// `sense-split-bench` (§7.5) flips the flag on, teaches with contexts from
// both known senses, and measures whether the rule recovers the splits
// without fragmenting a monosemous control set.
// ────────────────────────────────────────────────────────────────────────────

/** The §7.4 gate — ALL OFF by default. The rule is the FLAG-DRIVEN arm;
 *  the relation-graph split (§7.2) stays the default until the
 *  `sense-split-bench` shows the context distribution is clean enough to
 *  induce senses from it. */
export const CONTEXT_SENSE_SPLIT_FLAGS: { enabled: boolean } = { enabled: false };

/** Enable/disable context-based sense induction (the bench flips this). */
export function setContextSenseSplitEnabled(enabled: boolean): void {
  CONTEXT_SENSE_SPLIT_FLAGS.enabled = enabled;
}

/** Reset the §7.4 flag behind its control (off — the graph split only). */
export function resetContextSenseSplitFlags(): void {
  CONTEXT_SENSE_SPLIT_FLAGS.enabled = false;
}

/** One recorded co-excitation: the sorted distinct primes of the context
 *  cues excited together with the word at ONE store/recall (the word's own
 *  signature is excluded — these are the primes co-excited WITH it). */
export interface ContextEvent {
  primes: readonly number[];
}

/**
 * The context-distribution recorder: one event per store/recall of a word,
 * each event the cue's co-excited context prime set. A pure, self-contained
 * channel the caller feeds at every teach and recall — while the flag is
 * off `record` is a no-op, so the mechanism costs nothing when disabled.
 */
export class ContextSenseRecorder {
  private readonly events = new Map<string, ContextEvent[]>();

  /** Record one co-excited context prime set for a word. No-op while the
   *  §7.4 flag is off; empty contexts are recorded as-is (the split rule
   *  ignores them — a store/recall with no co-excited context primes
   *  carries no context information). */
  record(word: string, contextPrimes: readonly number[]): void {
    if (!CONTEXT_SENSE_SPLIT_FLAGS.enabled) return;
    const key = word.trim().toLowerCase();
    if (key.length === 0) return;
    const primes = [...new Set(contextPrimes)].sort((a, b) => a - b);
    const bucket = this.events.get(key) ?? [];
    bucket.push({ primes });
    this.events.set(key, bucket);
  }

  /** Every recorded context event of a word, in recording order. */
  eventsOf(word: string): readonly ContextEvent[] {
    return this.events.get(word.trim().toLowerCase()) ?? [];
  }

  /** The words with at least one recorded context event. */
  recordedWords(): string[] {
    return [...this.events.keys()].sort();
  }

  /** Drop every recorded event. */
  clear(): void {
    this.events.clear();
  }
}

// ── §7.4 tuning constants (§5 discipline) ────────────────────────────────────
// Calibrated for the sense-split bench's teaching regime (a few context
// words per cue, several cues per sense). Documented here as constants, not
// buried in the rule, so the bench can read them and the report can name
// them.

/** Minimum non-empty context events before the rule reads a word. */
export const CONTEXT_SPLIT_MIN_EVENTS = 4;

/** Minimum events a cluster must hold to count as a distinguishable sense. */
export const CONTEXT_SPLIT_MIN_CLUSTER_EVENTS = 2;

/** Minimum mean top-two margin over the events' cluster affinities — how
 *  one-sided each event's cluster membership must be for the two clusters
 *  to count as DISTINGUISHABLE (mixed events read ~0 and kill the split). */
export const CONTEXT_SPLIT_MIN_MEAN_MARGIN = 0.5;

/** Minimum normalized entropy of the two cluster masses — both senses must
 *  actually occur (a 1-0 split is not bimodal). */
export const CONTEXT_SPLIT_MIN_BALANCE = 0.6;

/** Maximum Jaccard overlap between the two clusters' prime sets — the
 *  induced senses' contexts must be separable, not one noisy family. */
export const CONTEXT_SPLIT_MAX_PRIME_OVERLAP = 0.25;

/** Laplace smoothing over the per-cluster prime frequency tables. */
export const CONTEXT_SPLIT_LAPLACE = 1;

/** The Zipf cost of NAMING the new sense node — the sense key ("bank#2") is
 *  an unseen token, so it costs the model's unknown-token cost (mdl.ts,
 *  the §9 "bits(name X)" currency). */
export const SENSE_NODE_NAME_COST_BITS = UNKNOWN_TOKEN_COST;

/** The bits of minting a sense node's four-prime signature: selecting 4
 *  distinct primes from the prime space costs log₂ C(P, 4). */
export function senseNodeSignatureCostBits(primeSpaceSize: number): number {
  if (primeSpaceSize < SIGNATURE_LENGTH) return 0;
  const combinations =
    (primeSpaceSize * (primeSpaceSize - 1) * (primeSpaceSize - 2) * (primeSpaceSize - 3)) / 24;
  return Math.log2(combinations);
}

/** The total cost of a new sense node in the §9 currency: its name (a new
 *  token) plus its signature (a 4-of-P prime selection). */
export function senseNodeCostBits(primeSpaceSize: number = PRIME_SPACE.length): number {
  return SENSE_NODE_NAME_COST_BITS + senseNodeSignatureCostBits(primeSpaceSize);
}

/** The split decision the rule reaches for one word. */
export interface ContextSplitDecision {
  /** The surface word. */
  word: string;
  /** The rule FIRED: enabled AND bimodal AND the MDL gain is positive. */
  split: boolean;
  /** The cde-based bimodality read alone (two distinguishable context
   *  clusters) — reported even when the MDL gate then blocks the split,
   *  so the bench can see which gate refused. */
  bimodal: boolean;
  /** Σ cost(E | word) − Σ cost(E | assigned sense) over the events, bits. */
  entropyReductionBits: number;
  /** bits(name of the sense node) + bits(its four-prime signature). */
  nodeCostBits: number;
  /** entropyReductionBits − nodeCostBits (positive exactly when split). */
  gainBits: number;
  /** Event index → cluster (0/1); non-null when the read is bimodal. */
  assignment: number[] | null;
  /** The two induced context-prime clusters — the induced senses. */
  clusters: [readonly number[], readonly number[]] | null;
}

/** The Jaccard co-occurrence between two primes over the recorded events
 *  (pair-order-independent: the co-occurrence table stores sorted keys). */
function primeJaccard(
  frequency: ReadonlyMap<number, number>,
  cooccurrence: ReadonlyMap<string, number>,
  a: number,
  b: number
): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const together = cooccurrence.get(`${lo}:${hi}`) ?? 0;
  const total = (frequency.get(a) ?? 0) + (frequency.get(b) ?? 0) - together;
  return total <= 0 ? 0 : together / total;
}

/** Σ cost(E | assigned sense) − Σ cost(E | word) — the bit reduction of
 *  encoding every event under its assigned sense's Laplace-smoothed prime
 *  frequencies instead of the word's single merged distribution. Hard
 *  assignment; the term is clamped at 0 (a split that would cost more to
 *  encode never pays). */
function contextEntropyReduction(
  events: readonly ContextEvent[],
  assignment: readonly number[],
  clusterCount: number
): number {
  const costOf = (
    counts: ReadonlyMap<number, number>,
    total: number,
    vocab: number,
    prime: number
  ): number => {
    const probability =
      ((counts.get(prime) ?? 0) + CONTEXT_SPLIT_LAPLACE) / (total + CONTEXT_SPLIT_LAPLACE * vocab);
    return -Math.log2(Math.max(probability, 1e-12));
  };
  const merged = new Map<number, number>();
  let mergedTotal = 0;
  for (const event of events) {
    for (const prime of event.primes) {
      merged.set(prime, (merged.get(prime) ?? 0) + 1);
      mergedTotal += 1;
    }
  }
  let unsplitBits = 0;
  for (const event of events) {
    for (const prime of event.primes) unsplitBits += costOf(merged, mergedTotal, merged.size, prime);
  }
  const perCluster: Array<Map<number, number>> = Array.from(
    { length: clusterCount },
    () => new Map<number, number>()
  );
  const totals = new Array<number>(clusterCount).fill(0);
  for (let i = 0; i < events.length; i += 1) {
    const cluster = assignment[i];
    for (const prime of events[i].primes) {
      perCluster[cluster].set(prime, (perCluster[cluster].get(prime) ?? 0) + 1);
      totals[cluster] += 1;
    }
  }
  let splitBits = 0;
  for (let i = 0; i < events.length; i += 1) {
    const cluster = assignment[i];
    for (const prime of events[i].primes) {
      splitBits += costOf(perCluster[cluster], totals[cluster], perCluster[cluster].size, prime);
    }
  }
  return Math.max(0, unsplitBits - splitBits);
}

/**
 * THE §7.4 SPLIT RULE — read a word's recorded context distribution and
 * decide whether the trace splits into two senses.
 *
 *  1. Cluster the context primes into TWO clusters by co-occurrence: the
 *     seeds are the most frequent prime and the frequent prime that
 *     co-occurs with it LEAST (two distinguishable context families); every
 *     other prime joins its nearer seed (Jaccard co-occurrence).
 *  2. The BIMODALITY read reuses cde.ts: each event's cluster affinities
 *     [|E∩A|, |E∩B|] give a top-two margin (one-sided = distinguishable),
 *     and the two cluster masses give a normalized entropy (both senses
 *     occur). Bimodal ⇔ every gate holds: each cluster has enough events,
 *     the mean margin meets CONTEXT_SPLIT_MIN_MEAN_MARGIN, the mass balance
 *     meets CONTEXT_SPLIT_MIN_BALANCE, and the clusters' prime sets do not
 *     overlap past CONTEXT_SPLIT_MAX_PRIME_OVERLAP.
 *  3. The MDL gate: the split fires exactly when the conditional-entropy
 *     reduction of context given sense exceeds the new sense node's cost
 *     (senseNodeCostBits) — the same currency as §9, run in the split
 *     direction.
 *
 *  Deterministic for a given recording. A monosemous word whose contexts
 *  overlap (one family of co-occurring primes) fails the margin gate or
 *  fails to pay for the node — it never fragments.
 */
export function contextSplitDecision(
  word: string,
  recorder: ContextSenseRecorder,
  primeSpaceSize: number = PRIME_SPACE.length
): ContextSplitDecision {
  const nodeCostBits = senseNodeCostBits(primeSpaceSize);
  const refused: ContextSplitDecision = {
    word,
    split: false,
    bimodal: false,
    entropyReductionBits: 0,
    nodeCostBits,
    gainBits: -nodeCostBits,
    assignment: null,
    clusters: null
  };
  if (!CONTEXT_SENSE_SPLIT_FLAGS.enabled) return refused;
  const events = recorder.eventsOf(word).filter((event) => event.primes.length > 0);
  if (events.length < CONTEXT_SPLIT_MIN_EVENTS) return refused;

  const frequency = new Map<number, number>();
  for (const event of events) {
    for (const prime of event.primes) frequency.set(prime, (frequency.get(prime) ?? 0) + 1);
  }
  const cooccurrence = new Map<string, number>();
  for (const event of events) {
    for (let i = 0; i < event.primes.length; i += 1) {
      for (let j = i + 1; j < event.primes.length; j += 1) {
        const a = event.primes[i];
        const b = event.primes[j];
        const key = `${a}:${b}`;
        cooccurrence.set(key, (cooccurrence.get(key) ?? 0) + 1);
      }
    }
  }
  const jaccard = (a: number, b: number): number => primeJaccard(frequency, cooccurrence, a, b);
  const ranked = [...frequency.keys()].sort(
    (a, b) => (frequency.get(b) ?? 0) - (frequency.get(a) ?? 0) || a - b
  );
  if (ranked.length < 2) return refused;

  // Seed A: the most frequent prime. Seed B: the frequent prime that
  // co-occurs with it LEAST — the farthest context family.
  const seedA = ranked[0];
  let seedB: number | null = null;
  for (const prime of ranked.slice(1)) {
    const better =
      seedB === null ||
      jaccard(prime, seedA) < jaccard(seedB, seedA) - 1e-9 ||
      (Math.abs(jaccard(prime, seedA) - jaccard(seedB, seedA)) <= 1e-9 &&
        ((frequency.get(prime) ?? 0) > (frequency.get(seedB) ?? 0) ||
          ((frequency.get(prime) ?? 0) === (frequency.get(seedB) ?? 0) && prime < seedB)));
    if (better) seedB = prime;
  }
  if (seedB === null) return refused;

  const clusterA = new Set<number>([seedA]);
  const clusterB = new Set<number>([seedB]);
  for (const prime of ranked) {
    if (prime === seedA || prime === seedB) continue;
    if (jaccard(prime, seedA) >= jaccard(prime, seedB)) clusterA.add(prime);
    else clusterB.add(prime);
  }

  // Event assignment + the cde-based bimodality read.
  const assignment: number[] = [];
  const margins: number[] = [];
  for (const event of events) {
    let affinityA = 0;
    let affinityB = 0;
    for (const prime of event.primes) {
      if (clusterA.has(prime)) affinityA += 1;
      else affinityB += 1;
    }
    assignment.push(affinityA >= affinityB ? 0 : 1);
    margins.push(topTwoMargin([affinityA, affinityB]));
  }
  const clusterSize = [0, 0];
  for (const index of assignment) clusterSize[index] += 1;
  const meanMargin = margins.reduce((sum, margin) => sum + margin, 0) / margins.length;
  const balance = normalizedEntropy(clusterSize);
  const shared = [...clusterA].filter((prime) => clusterB.has(prime)).length;
  const union = clusterA.size + clusterB.size - shared;
  const overlap = union <= 0 ? 1 : shared / union;
  const bimodal =
    clusterSize[0] >= CONTEXT_SPLIT_MIN_CLUSTER_EVENTS &&
    clusterSize[1] >= CONTEXT_SPLIT_MIN_CLUSTER_EVENTS &&
    meanMargin >= CONTEXT_SPLIT_MIN_MEAN_MARGIN &&
    balance >= CONTEXT_SPLIT_MIN_BALANCE &&
    overlap <= CONTEXT_SPLIT_MAX_PRIME_OVERLAP;

  const entropyReductionBits = contextEntropyReduction(events, assignment, 2);
  const gainBits = entropyReductionBits - nodeCostBits;
  if (!bimodal) {
    return { ...refused, bimodal, entropyReductionBits, gainBits: Math.min(gainBits, 0) };
  }
  const clusters: [readonly number[], readonly number[]] = [
    [...clusterA].sort((a, b) => a - b),
    [...clusterB].sort((a, b) => a - b)
  ];
  if (gainBits <= 0) {
    // Bimodal but the split does not pay for the node — the MDL gate holds.
    return { ...refused, bimodal, entropyReductionBits, gainBits, assignment, clusters };
  }
  return { word, split: true, bimodal, entropyReductionBits, nodeCostBits, gainBits, assignment, clusters };
}
