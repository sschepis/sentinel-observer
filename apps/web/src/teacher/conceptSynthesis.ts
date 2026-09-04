/**
 * CONCEPT SYNTHESIS — MDL ABSTRACTION (§9, Phase H).
 *
 * When robin, sparrow, crow and finch each carry has-part wings,
 * has-part feathers and capable-of fly, the graph stores the same three
 * edges four times. A latent node X with those three edges plus one
 * `is-a X` edge per member stores seven edges instead of twelve, less the
 * cost of naming X:
 *
 *   gain(X) = Σ_(m ∈ members) bits(shared edges of m) − bits(edges of X)
 *           − Σ_m bits(m is-a X) − bits(name X) − Σ bits(exceptions)
 *
 * in the SAME Zipf-cost currency the operator and rule inductions already
 * use (`mdl.ts` TokenCostModel), and X is formed exactly when gain(X) > 0.
 * This is a biclique-cover problem over the graph, hard in general, and the
 * same greedy largest-gain-first procedure that induces shells is adequate.
 *
 * §9.4 CAUTION: the prime signatures are ADDRESSES, not semantics — the
 * intersection of robin's and sparrow's primes carries no meaning, and no
 * cluster of members hands over a shared prime to build the concept from.
 * Synthesis cannot be read off the signatures. The layer that IS
 * compositional is the distributed-vector layer: `prototypeBundle` below
 * superposes H(member) vectors (bundle), unbinds each role, and keeps the
 * fillers above the crosstalk floor — the §9.4 prototype, the candidate
 * shared edge set that gain(X) then decides on.
 *
 * This module is pure: no agent state, no observer session — the same
 * inputs produce the same outputs.
 */
import { RelationalHologram, type RoleFillerPair } from '@sschepis/sentient-core';
import { RELATION_PREDICATES, type Relation, type RelationPredicate } from './relations';
import { TokenCostModel } from './mdl';

/** One (predicate, object) edge of an induced concept. */
export interface InducedConceptEdge {
  predicate: RelationPredicate;
  object: string;
}

/**
 * A confirmed-false record on a member for one of X's shared edges —
 * "penguin is a bird, but it cannot fly" costs bits, and the negation
 * blocks inheritance of that edge for that member.
 */
export interface ConceptException {
  member: string;
  predicate: RelationPredicate;
  object: string;
}

/** A confirmed-false claim (the negations store, P8). */
export interface NegationLike {
  subject: string;
  predicate: string;
  object: string;
}

/** The result of one greedy abstraction step. */
export interface InducedConcept {
  /** Stable id: the sorted member set (deterministic across runs). */
  id: string;
  members: string[];
  edges: InducedConceptEdge[];
  exceptions: ConceptException[];
  gain: number;
}

const EDGE_SEP = '\u0000';

/** The (predicate, object) key of an edge — the unit the graph stores. */
export function sharedEdgeKey(predicate: string, object: string): string {
  return `${predicate}${EDGE_SEP}${object}`;
}

/**
 * The bit cost of one stored edge in the Zipf currency: the predicate
 * token plus the object token. Subjects are stored once either way (the
 * edge moves from the members to X), so they are not part of the
 * redundancy the concept removes.
 */
export function edgeBits(costs: TokenCostModel, predicate: string, object: string): number {
  return costs.costOf(predicate) + costs.costOf(object);
}

export interface GainCostInput {
  /** The Zipf token-cost model (the operator learner's currency). */
  costs: TokenCostModel;
  /** Bits for naming X — default: the model's unknown-token cost. */
  nameBits?: number;
}

/**
 * §9.1 — gain(X) in the Zipf-cost currency. Positive gain means adopting X
 * compresses the graph: the members' redundant shared edges are removed,
 * X stores them once, each member keeps one `is-a X` edge, X is named,
 * and confirmed-false exceptions are paid for.
 */
export function gainX(
  members: readonly string[],
  sharedEdges: ReadonlyArray<{ predicate: string; object: string }>,
  exceptions: ReadonlyArray<ConceptException>,
  input: GainCostInput
): number {
  const { costs } = input;
  const nameBits = input.nameBits ?? costs.unknownTokenCost();
  const edgeCost = (edge: { predicate: string; object: string }): number =>
    edgeBits(costs, edge.predicate, edge.object);

  const sharedBits = members.reduce(
    (sum) => sum + sharedEdges.reduce((inner, edge) => inner + edgeCost(edge), 0),
    0
  );
  const edgesOfX = sharedEdges.reduce((sum, edge) => sum + edgeCost(edge), 0);
  const isABits = members.reduce((sum) => sum + costs.costOf('is-a') + nameBits, 0);
  const exceptionBits = exceptions.reduce(
    (sum, exception) => sum + edgeBits(costs, exception.predicate, exception.object),
    0
  );
  return sharedBits - edgesOfX - isABits - nameBits - exceptionBits;
}

export interface InduceOptions {
  /** The Zipf token-cost model (required — the currency of gain). */
  costs: TokenCostModel;
  /** Confirmed-false claims: exceptions cost bits and block inheritance. */
  negations?: ReadonlyArray<NegationLike>;
  /** Members must share at least this many identical (predicate, object)
   *  edges (default 2 — the §9.1 biclique criterion). */
  minSharedEdges?: number;
  /** Search bound: maximum members per concept (default 16). */
  maxMembers?: number;
  /** Search bound: maximum concepts formed (default 24). */
  maxConcepts?: number;
  /** Search bound: candidate member-sets considered per round (default 600). */
  candidateCap?: number;
  /** Bits for naming X (default: the model's unknown-token cost). */
  nameBits?: number;
}

const DEFAULTS = {
  minSharedEdges: 2,
  maxMembers: 16,
  maxConcepts: 24,
  candidateCap: 600
};

interface WorkingEdge {
  predicate: RelationPredicate;
  object: string;
}

/** List join used by the agent's hedged speech ("robin, sparrow and crow"). */
export function joinList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * §9.1 — greedy largest-gain-first biclique-cover-style induction.
 *
 * Every candidate member set is the intersection of the subjects carrying
 * two co-occurring edges (members share ≥ `minSharedEdges` identical
 * (predicate, object) edges), and X's edge set is the full intersection of
 * the members' edges. Candidates are EXPANDED greedily: a subject outside
 * the core joins when it shares ≥ `minSharedEdges` of X's edges and its
 * marginal gain (its redundancy savings minus its is-a edge and any
 * confirmed-false exceptions) is positive — the §9.2 generalization:
 * "even if finch's own definition never said so".
 *
 * The highest-gain candidate is formed, its covered edges are removed
 * from the members (biclique cover), and the search repeats until no
 * candidate has positive gain — recursion stops on the data, not a depth
 * constant (§9.5). Formed concepts are returned largest-gain-first.
 */
export function induceConcepts(relations: readonly Relation[], options: InduceOptions): InducedConcept[] {
  const minSharedEdges = Math.max(2, options.minSharedEdges ?? DEFAULTS.minSharedEdges);
  const maxMembers = Math.max(minSharedEdges, options.maxMembers ?? DEFAULTS.maxMembers);
  const maxConcepts = Math.max(0, options.maxConcepts ?? DEFAULTS.maxConcepts);
  const candidateCap = Math.max(1, options.candidateCap ?? DEFAULTS.candidateCap);
  const nameBits = options.nameBits ?? options.costs.unknownTokenCost();

  // The working graph: subject -> edge key -> edge. The cover removes
  // formed concepts' shared edges so later concepts cannot re-count the
  // same redundancy.
  const graph = new Map<string, Map<string, WorkingEdge>>();
  for (const relation of relations) {
    const edges = graph.get(relation.subject) ?? new Map<string, WorkingEdge>();
    edges.set(sharedEdgeKey(relation.predicate, relation.object), {
      predicate: relation.predicate,
      object: relation.object
    });
    graph.set(relation.subject, edges);
  }
  const negationsByMember = new Map<string, Set<string>>();
  for (const negation of options.negations ?? []) {
    const keys = negationsByMember.get(negation.subject) ?? new Set<string>();
    keys.add(sharedEdgeKey(negation.predicate, negation.object));
    negationsByMember.set(negation.subject, keys);
  }

  const formed: InducedConcept[] = [];
  for (let round = 0; round < maxConcepts; round += 1) {
    const best = bestCandidate(graph, negationsByMember, {
      costs: options.costs,
      nameBits,
      minSharedEdges,
      maxMembers,
      candidateCap
    });
    if (best === null || best.gain <= 0) break;
    formed.push(best);
    // COVER: the shared edges now live on X — remove them from the members.
    for (const member of best.members) {
      const memberEdges = graph.get(member);
      if (memberEdges === undefined) continue;
      for (const edge of best.edges) memberEdges.delete(sharedEdgeKey(edge.predicate, edge.object));
      if (memberEdges.size === 0) graph.delete(member);
    }
  }
  return formed;
}

function bestCandidate(
  graph: Map<string, Map<string, WorkingEdge>>,
  negationsByMember: Map<string, Set<string>>,
  options: {
    costs: TokenCostModel;
    nameBits: number;
    minSharedEdges: number;
    maxMembers: number;
    candidateCap: number;
  }
): InducedConcept | null {
  const { costs, nameBits, minSharedEdges, maxMembers, candidateCap } = options;

  // Inverted index: edge key -> subjects carrying it.
  const subjectsOf = new Map<string, string[]>();
  for (const [subject, edges] of graph) {
    for (const key of edges.keys()) {
      const list = subjectsOf.get(key) ?? [];
      list.push(subject);
      subjectsOf.set(key, list);
    }
  }

  // Candidate member sets from pairs of co-occurring edges.
  const candidates = new Map<string, InducedConcept>();
  const consider = (members: string[]): void => {
    if (members.length < minSharedEdges || members.length > maxMembers) return;
    const [member] = members;
    const memberEdges = graph.get(member);
    if (memberEdges === undefined) return;
    // X's edge set: the intersection over the members.
    const shared: WorkingEdge[] = [];
    for (const [key, edge] of memberEdges) {
      if (members.every((m) => graph.get(m)?.has(key) === true)) shared.push(edge);
    }
    if (shared.length < minSharedEdges) return;
    const sorted = [...members].sort();
    const id = `concept:${sorted.join('+')}`;
    const existing = candidates.get(id);
    if (existing !== undefined) return; // the intersection is the same node
    const node: InducedConcept = { id, members: sorted, edges: shared, exceptions: [], gain: 0 };
    expandCandidate(node, graph, subjectsOf, negationsByMember, { costs, nameBits, minSharedEdges });
    node.gain = gainX(node.members, node.edges, node.exceptions, { costs, nameBits });
    candidates.set(id, node);
  };

  for (const [subject, edges] of graph) {
    const keys = [...edges.keys()];
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        const left = subjectsOf.get(keys[i]);
        const right = subjectsOf.get(keys[j]);
        if (left === undefined || right === undefined) continue;
        const members = left.filter((s) => right.includes(s));
        consider(members);
        if (candidates.size >= candidateCap) break;
      }
      if (candidates.size >= candidateCap) break;
    }
    if (candidates.size >= candidateCap) break;
  }

  if (candidates.size === 0) return null;
  // LARGEST GAIN FIRST; ties break by more members, then the lexical id
  // (deterministic).
  return [...candidates.values()].sort(
    (a, b) => b.gain - a.gain || b.members.length - a.members.length || a.id.localeCompare(b.id)
  )[0];
}

/** Greedy member expansion: a subject joins X when it shares ≥
 *  `minSharedEdges` of X's edges and its marginal gain is positive. */
function expandCandidate(
  node: InducedConcept,
  graph: Map<string, Map<string, WorkingEdge>>,
  subjectsOf: Map<string, string[]>,
  negationsByMember: Map<string, Set<string>>,
  options: { costs: TokenCostModel; nameBits: number; minSharedEdges: number }
): void {
  const { costs, nameBits, minSharedEdges } = options;
  const edgeKeys = node.edges.map((edge) => sharedEdgeKey(edge.predicate, edge.object));
  const memberSet = new Set(node.members);
  let changed = true;
  while (changed) {
    changed = false;
    let best: { subject: string; marginal: number } | null = null;
    // Subjects that carry at least one of X's edges are the only ones that
    // can share ≥ minSharedEdges of them.
    const seen = new Set<string>();
    for (const key of edgeKeys) {
      for (const subject of subjectsOf.get(key) ?? []) {
        if (memberSet.has(subject) || seen.has(subject)) continue;
        seen.add(subject);
        const subjectEdges = graph.get(subject);
        if (subjectEdges === undefined) continue;
        const overlap = edgeKeys.filter((k) => subjectEdges.has(k));
        if (overlap.length < minSharedEdges) continue;
        const negated = negationsByMember.get(subject) ?? new Set<string>();
        const exceptions = node.edges.filter((edge) => negated.has(sharedEdgeKey(edge.predicate, edge.object)));
        const savings = overlap.reduce(
          (sum, key) => sum + edgeBits(costs, key.split(EDGE_SEP)[0], key.split(EDGE_SEP)[1]),
          0
        );
        const exceptionBitsSum = exceptions.reduce(
          (sum, exception) => sum + edgeBits(costs, exception.predicate, exception.object),
          0
        );
        const marginal = savings - (costs.costOf('is-a') + nameBits) - exceptionBitsSum;
        if (marginal > 0 && (best === null || marginal > best.marginal)) {
          best = { subject, marginal };
        }
      }
    }
    if (best !== null) {
      node.members = [...node.members, best.subject].sort();
      memberSet.add(best.subject);
      // The member's negated X-edges become recorded exceptions (they block
      // inheritance and cost bits).
      const negated = negationsByMember.get(best.subject) ?? new Set<string>();
      for (const edge of node.edges) {
        if (negated.has(sharedEdgeKey(edge.predicate, edge.object))) {
          node.exceptions.push({ member: best.subject, predicate: edge.predicate, object: edge.object });
        }
      }
      changed = true;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// §9.4 — the prototype: synthesis lives in the distributed-vector layer
// ────────────────────────────────────────────────────────────────────────────

export interface PrototypeEdge {
  predicate: string;
  object: string;
  score: number;
}

export interface PrototypeResult {
  members: string[];
  /** Fillers recovered above the crosstalk floor — the candidate shared
   *  edge set (the prototype's significant components). */
  shared: PrototypeEdge[];
  /** Member edges rejected below the floor — the idiosyncratic noise. */
  rejected: PrototypeEdge[];
  /** Each member's cosine to the prototype — its typicality (§9.4). */
  typicality: Array<{ member: string; cosine: number }>;
}

export interface PrototypeOptions {
  /** Roles to unbind (default: every relation predicate). */
  roles?: readonly string[];
  /** The candidate object universe (default: every object in the members'
   *  edges). */
  universe?: readonly string[];
  /**
   * The cleanup floor. Superposing M members of P pairs each leaves a
   * shared filler at ≈ √(M/P) and a single-occurrence filler at ≈ 1/√(M·P);
   * measured (4 members, 4–5 pairs, K = 128) the shared fillers sit at
   * 0.43–0.65 and single-occurrence fillers at ≤ 0.25 (crosstalk variance
   * included), so the default 0.35 splits them with headroom on both
   * sides.
   */
  crosstalkFloor?: number;
}

/**
 * §9.4 — the prototype of a member set: superpose H(member) vectors via
 * the RelationalHologram's own bind/bundle (shared role–filler components
 * add coherently, idiosyncratic ones cancel like noise), then unbind each
 * role and keep fillers above the crosstalk floor. The entropy reduction
 * is literal: the prototype has fewer significant components than the sum
 * of its members — and the recovered set is the candidate shared edge set
 * that gain(X) then decides on.
 */
export function prototypeBundle(
  holo: RelationalHologram,
  members: readonly string[],
  edgesOf: (member: string) => readonly RoleFillerPair[],
  options: PrototypeOptions = {}
): PrototypeResult {
  const roles = options.roles ?? (RELATION_PREDICATES as readonly string[]);
  const floor = options.crosstalkFloor ?? 0.35;
  const memberVectors: Float64Array[] = [];
  const universe = new Set<string>(options.universe ?? []);
  for (const member of members) {
    const pairs = edgesOf(member);
    const components = pairs.map((pair) =>
      RelationalHologram.bind(holo.vector(pair.predicate), holo.vector(pair.object))
    );
    memberVectors.push(RelationalHologram.bundle(components));
    for (const pair of pairs) universe.add(pair.object);
  }

  const shared: PrototypeEdge[] = [];
  const rejected: PrototypeEdge[] = [];
  const typicality: Array<{ member: string; cosine: number }> = [];
  if (memberVectors.length === 0) return { members: [...members], shared, rejected, typicality };
  const prototype = RelationalHologram.bundle(memberVectors);
  for (let i = 0; i < members.length; i += 1) {
    typicality.push({ member: members[i], cosine: RelationalHologram.cosine(prototype, memberVectors[i]) });
  }

  // The candidate pairs are the members' own edges (shared or idiosyncratic)
  // — scored under the prototype; above the floor they are recovered.
  const seen = new Set<string>();
  for (const role of roles) {
    const query = RelationalHologram.unbind(prototype, holo.vector(role));
    for (const object of universe) {
      const key = `${role}${EDGE_SEP}${object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const score = RelationalHologram.cosine(query, holo.vector(object));
      if (score >= floor) shared.push({ predicate: role, object, score });
      else rejected.push({ predicate: role, object, score });
    }
  }
  shared.sort((a, b) => b.score - a.score || a.object.localeCompare(b.object));
  rejected.sort((a, b) => b.score - a.score || a.object.localeCompare(b.object));
  return { members: [...members], shared, rejected, typicality };
}
