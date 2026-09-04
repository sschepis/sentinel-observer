/**
 * ELABORATION AS FRONTIER SEARCH (improvements.md §8 / Phase G).
 *
 * `framesFor` already produces one hop of elaboration ("A robin is a bird.
 * It has wings and feathers. It can fly.") — every content word from a
 * stored edge, every claim parsed back through the internal critic. This
 * module builds the RECURSION as a search with a stopping criterion, not a
 * fixed loop:
 *
 *   · FRONTIER — the edges one hop out from the objects cited so far (the
 *     subject's own frames plus each object a spoken typed claim cites).
 *     This is the elaboration generalization of `nextClaimFrontier`/§A.7:
 *     the same candidate set read over every cited object, scored by the
 *     same corroboration strength (typed edges) that the frontier
 *     instrumentation exposes.
 *   · EXPAND — a frontier claim is spoken only when it passes the internal
 *     critic (§8.2: the critic runs on EVERY claim) AND adds information
 *     not already implied by what has been said: a claim inheritable from
 *     an already-spoken claim through a spoken is-a edge is redundant (the
 *     elaboration analogue of the MDL anecdote), and a duplicate is refused.
 *   · ORDER — by resonance with the original subject: the frontier scores
 *     (corroboration strength), highest first, so the elaboration stays
 *     about what was asked.
 *   · STOP — when the best remaining claim's marginal score falls below a
 *     floor, when the frontier consists only of hypothesis-tier edges, or
 *     when the frontier's candidate entropy H̃ is flat (H̃ → 1 — nothing
 *     stands out as worth saying next), whichever comes first. A safety cap
 *     on claim count is a SAFETY BOUND (§5), never a depth budget: the
 *     search is expected to stop before it.
 *
 * TWO HARD CONSTRAINTS (§8.2), enforced in code:
 *   · GROUNDED-ONLY RECURSION — a composed sentence is a LEAF: its objects
 *     never seed the frontier (composed output never feeds composed
 *     output), and the cumulative grounding of the whole elaboration — the
 *     product of per-claim grounding scores — is tracked and surfaced on
 *     the result for the deviation meter.
 *   · THE CRITIC RUNS ON EVERY CLAIM — the same refusal rule, linear in the
 *     claim count.
 *
 * RELATED TOPICS are structural — siblings under the same is-a parent and
 * has-part neighbors — offered as a labeled coda ("Related: sparrow,
 * crow"), never woven into the claims.
 *
 * ELABORATION TRACES (§8.4): a graded elaboration is stored as a trace
 * whose content is the trace ids / edges it drew on (metadata kind
 * 'elaboration') — a memory whose content is other memories. Re-asking the
 * same subject recalls the stored elaboration instead of re-searching, and
 * the trace decays under the one retention law like an ordinary trace.
 *
 * INWARD QUESTIONING (§8.3): `selfQuestions` generates the follow-up
 * questions an elaboration raises; the ones the observer cannot answer
 * become curiosity gaps through the existing recordGap path (the goals
 * faculty wires them in: `recordSelfQuestionGaps`).
 */

import { deniedFromNegations, edgeObjects, inheritsEdge, isATypeOf, type DeniedClaim } from './chain';
import { normalizedEntropy } from './cde';
import { composeClaim } from './composition';
import {
  criticize,
  extractSubject,
  framesFor,
  parseClaims,
  type Claim,
  type FrameOptions
} from './groundedFrames';
import {
  predicateVerb,
  type Relation,
  type RelationPredicate
} from './relations';
import { retentionProbability, STABILITY_PRESETS } from './retention';

// ── Types ──────────────────────────────────────────────────────────────────

/** Why the frontier search stopped — the §8.1 stopping criterion. */
export type ElaborationStopReason =
  /** The best remaining claim's marginal score fell below the floor. */
  | 'score-floor'
  /** The frontier consists only of hypothesis-tier edges. */
  | 'hypothesis-only'
  /** H̃ over the frontier is flat (→ 1): nothing stands out as worth saying. */
  | 'flat-entropy'
  /** The frontier closed — no candidates remain. */
  | 'frontier-empty'
  /** The claim-count SAFETY BOUND was reached (a safety bound, never the
   *  search budget — the bench asserts this does not fire). */
  | 'safety-cap';

/** One stored edge a claim cites (the provenance the elaboration names). */
export interface ElaborationEdge {
  subject: string;
  predicate: RelationPredicate;
  object: string;
}

/** How a claim is backed — the §8.2 grounded-only recursion gate. */
export type ClaimBacking = 'typed' | 'composed';

/** One claim of an elaboration, with its provenance and grounding. */
export interface ElaboratedClaim {
  /** The claim as the critic verifies it (a standalone named sentence). */
  sentence: string;
  /** The prose the elaboration actually spoke the claim in. */
  spokenIn: string;
  subject: string;
  predicate: RelationPredicate;
  object: string;
  negated: boolean;
  /** Typed backing edges, or the composed chain's hops. */
  edges: ElaborationEdge[];
  backing: ClaimBacking;
  /** Per-claim grounding score in (0, 1] — the corroboration strength of
   *  the backing edge (typed) or the weakest hop's support (composed). */
  grounding: number;
  /** The backing edge's tier: a hypothesis-tier claim is never EXPANDED. */
  tier: 'asserted' | 'hypothesis';
  /** The frontier score that ordered it (corroboration strength). */
  score: number;
  /** True when the claim is a composed LEAF — its objects never seed the
   *  frontier (grounded-only recursion). */
  leaf: boolean;
}

/** The result of one elaboration search (or a §8.4 trace recall). */
export interface ElaborationResult {
  subject: string;
  /** Every spoken claim, in spoken order (the initial frames, then the
   *  expanded frontier claims). */
  claims: ElaboratedClaim[];
  /** The sentences spoken (the initial frames, then the expansions). */
  sentences: string[];
  /** Every edge the elaboration drew on, deduplicated. */
  citedEdges: ElaborationEdge[];
  /** §8.2: the cumulative grounding — the product of per-claim grounding
   *  scores across the spoken claims, surfaced for the deviation meter so
   *  a long elaboration cannot hide a fabrication in its tail. */
  groundingProduct: number;
  /** Why the search stopped. */
  stopReason: ElaborationStopReason;
  /** The best remaining candidate's marginal score at stop time (the
   *  score-floor comparison), or null when the frontier was empty. */
  bestRemainingScore: number | null;
  /** H̃ over the frontier scores at stop time (the flat-entropy reading). */
  frontierEntropyAtStop: number;
  /** Candidate claims the critic refused (never spoken). */
  refusedByCritic: string[];
  /** Candidate claims the redundancy gate refused (inheritable from an
   *  already-spoken claim, or a duplicate). */
  redundantSkipped: string[];
  /** The related-topics coda words (siblings + has-part neighbors). */
  related: string[];
  /** The labeled coda ("Related: sparrow, crow"), or '' when none. */
  coda: string;
  /** The full spoken text: the sentences plus the coda. */
  text: string;
  /** True when this elaboration was RECALLED from a stored elaboration
   *  trace (§8.4) instead of re-searched. */
  recalled: boolean;
  /** The elaboration trace id when this search was stored (§8.4). */
  storedTraceId: string | null;
}

/** Elaboration options — the frontier search's knobs. */
export interface ElaborationOptions extends FrameOptions {
  /** §8.1: the marginal-score floor — stop when the best remaining claim's
   *  score falls below it (default 0.6: below a single weak source, the
   *  claim is no longer worth saying). */
  marginalScoreFloor?: number;
  /** §8.1: H̃ ≥ this is FLAT (H̃ → 1) — nothing stands out as worth saying
   *  next (default 1 − FLAT_ENTROPY_EPSILON: within 1% of fully uniform). */
  flatEntropyThreshold?: number;
  /** The claim-count SAFETY BOUND (§5), never the search budget. */
  maxClaims?: number;
  /** The redundancy gate (duplicate / inheritable-from-spoken). Default
   *  true; false only for the bench that measures redundancy without it. */
  redundancyCheck?: boolean;
  /** §8.4: the elaboration-trace memory (store on grade, recall on re-ask). */
  traceMemory?: ElaborationTraceMemory | null;
  /** §8.4: the world's grade of the produced elaboration — when ≥ the trace
   *  memory's floor, the elaboration is stored as a trace. */
  grade?: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** §8.1 stop floor: below a single weak (LLM-chaperoned) source, a claim is
 *  no longer worth saying. TUNING CONSTANT (§5); the benches pin the stops
 *  that fire, not this value. */
export const MARGINAL_SCORE_FLOOR = 0.6;

/** §8.1 flat-entropy stop: H̃ within this of fully uniform (H̃ → 1) means
 *  nothing stands out as worth saying next. TUNING CONSTANT (§5). */
export const FLAT_ENTROPY_EPSILON = 0.01;

/** The claim-count SAFETY BOUND (§5) — the loop's hard wall, never the
 *  search budget. The §8.5 bench refutes the mechanism when this fires. */
export const MAX_ELABORATION_CLAIMS = 24;

/** §8.4: an elaboration graded below this is not worth caching. */
export const ELABORATION_TRACE_MIN_GRADE = 0.8;

/** §8.4: the trace's strength floor — below it (like an ordinary trace
 *  pruned below the bank's minStrength) the elaboration is re-searched. */
export const ELABORATION_TRACE_RECALL_FLOOR = 0.25;

// ── Helpers ────────────────────────────────────────────────────────────────

const edgeKey = (edge: ElaborationEdge): string =>
  `${edge.subject}\u0000${edge.predicate}\u0000${edge.object}`;

const edgeId = (edge: ElaborationEdge): string =>
  `${edge.subject}:${edge.predicate}:${edge.object}`;

const claimKey = (claim: { subject: string; predicate: RelationPredicate; object: string }): string =>
  `${claim.subject}\u0000${claim.predicate}\u0000${claim.object}`;

const clamp01 = (value: number): number => Math.max(0.01, Math.min(1, value));

/** The standalone named sentence the critic verifies a claim in. */
function claimSentence(subject: string, predicate: RelationPredicate, object: string): string {
  return `A ${subject} ${predicateVerb(predicate, object)} ${object}.`;
}

/** The tier of a stored edge (absent tier = the legacy asserted default). */
function edgeTier(relations: readonly Relation[], subject: string, predicate: RelationPredicate, object: string): 'asserted' | 'hypothesis' {
  const edge = relations.find((r) => r.subject === subject && r.predicate === predicate && r.object === object);
  return edge === undefined || (edge.tier ?? 'asserted') !== 'hypothesis' ? 'asserted' : 'hypothesis';
}

/**
 * Resolve how a claim is backed and its per-claim grounding score: a
 * direct stored edge, an inherited edge (through is-a ancestry), a
 * confirmed-false negation (evidence-backed, grounding 1), or a sound
 * composed chain (P10 — a composed claim is a LEAF). Returns null only for
 * claims the graph cannot back (the critic refuses those).
 */
function resolveBacking(
  claim: Claim,
  relations: readonly Relation[],
  deny: DeniedClaim,
  options: ElaborationOptions
): { backing: ClaimBacking; edges: ElaborationEdge[]; grounding: number; tier: 'asserted' | 'hypothesis' } | null {
  if (claim.negated) return { backing: 'typed', edges: [], grounding: 1, tier: 'asserted' };
  const direct = relations.filter(
    (r) => r.subject === claim.subject && r.predicate === claim.predicate && r.object === claim.object
  );
  if (direct.length > 0) {
    const best = direct.reduce((a, b) => Math.max(a, b.strength ?? 1), -Infinity);
    const tier = direct.every((r) => (r.tier ?? 'asserted') !== 'hypothesis') ? 'asserted' : 'hypothesis';
    return {
      backing: 'typed',
      edges: [{ subject: claim.subject, predicate: claim.predicate, object: claim.object }],
      grounding: clamp01(best),
      tier
    };
  }
  const via = inheritsEdge(relations, claim.subject, claim.predicate, claim.object, deny);
  if (via !== null) {
    const holding = relations.find(
      (r) => r.subject === via.via && r.predicate === claim.predicate && r.object === claim.object
    );
    const strength = holding === undefined ? 1 : holding.strength ?? 1;
    const tier = holding === undefined || (holding.tier ?? 'asserted') !== 'hypothesis' ? 'asserted' : 'hypothesis';
    return {
      backing: 'typed',
      edges: [{ subject: via.via, predicate: claim.predicate, object: claim.object }],
      grounding: clamp01(strength),
      tier
    };
  }
  const composed = composeClaim(relations, claim.subject, claim.predicate, claim.object, {
    negations: options.negations,
    cost: options.cost ?? null,
    extraRules: options.extraRules
  });
  if (composed !== null) {
    return {
      backing: 'composed',
      edges: composed.hops.map((hop) => ({
        subject: hop.subject,
        predicate: hop.predicate,
        object: hop.object
      })),
      grounding: clamp01(composed.support),
      tier: composed.hops.every((hop) => edgeTier(relations, hop.subject, hop.predicate, hop.object) !== 'hypothesis')
        ? 'asserted'
        : 'hypothesis'
    };
  }
  return null;
}

// ── The search ─────────────────────────────────────────────────────────────

/** One candidate on the elaboration frontier (an edge one hop out from an
 *  object cited so far), scoreable for the §8 stopping criterion. */
interface FrontierCandidate {
  subject: string;
  predicate: RelationPredicate;
  object: string;
  /** Marginal-information score: the edge's corroboration strength. */
  score: number;
  tier: 'asserted' | 'hypothesis';
}

/**
 * THE ELABORATION — recursion as frontier search with a stopping criterion
 * (§8.1). Starts from the subject's `framesFor` output; the frontier is the
 * edges one hop out from the objects cited so far; a frontier claim is
 * EXPANDED only when it passes the internal critic on every claim (§8.2)
 * and adds information not implied by what has been said; ORDERED by the
 * frontier scores (corroboration strength — resonance with the subject);
 * STOPPED by the score floor, a hypothesis-only frontier, or flat frontier
 * entropy H̃ → 1 — whichever comes first. Related topics ride a labeled
 * coda, never the claims.
 */
export function elaborate(subject: string, relations: readonly Relation[], options: ElaborationOptions = {}): ElaborationResult {
  const deny = options.negations !== undefined ? deniedFromNegations(options.negations) : (() => false);

  // §8.4: re-asking the same subject recalls the stored elaboration
  // instead of re-searching.
  const traceMemory = options.traceMemory ?? null;
  if (traceMemory !== null) {
    const recalled = traceMemory.recall(subject, relations);
    if (recalled !== null) return recalled;
  }

  const result = searchElaboration(subject, relations, options, deny);

  // §8.4: a graded elaboration becomes a trace whose content is the
  // edges it drew on.
  if (traceMemory !== null && options.grade !== undefined && options.grade >= traceMemory.minGrade) {
    const id = traceMemory.store(subject, result, options.grade);
    if (id !== null) result.storedTraceId = id;
  }
  return result;
}

/** The frontier search itself. */
function searchElaboration(
  subject: string,
  relations: readonly Relation[],
  options: ElaborationOptions,
  deny: DeniedClaim
): ElaborationResult {
  const maxClaims = options.maxClaims ?? MAX_ELABORATION_CLAIMS;
  const scoreFloor = options.marginalScoreFloor ?? MARGINAL_SCORE_FLOOR;
  const flatThreshold = options.flatEntropyThreshold ?? 1 - FLAT_ENTROPY_EPSILON;
  const redundancyCheck = options.redundancyCheck !== false;
  const criticOptions = { cost: options.cost ?? null, extraRules: options.extraRules };

  const claims: ElaboratedClaim[] = [];
  const sentences: string[] = [];
  const spokenKeys = new Set<string>();
  const citedEdgeMap = new Map<string, ElaborationEdge>();
  const refusedByCritic: string[] = [];
  const redundantSkipped: string[] = [];
  const seeds: string[] = [subject];
  let groundingProduct = 1;

  const addClaim = (claim: Claim, spokenIn: string, score: number, seedObjects: boolean): boolean => {
    // A duplicate claim (framesFor can state the same claim in both its
    // first and its anaphoric frame) is redundant — never spoken twice.
    if (spokenKeys.has(claimKey(claim))) return false;
    const resolved = resolveBacking(claim, relations, deny, options);
    if (resolved === null) return false;
    const record: ElaboratedClaim = {
      sentence: claimSentence(claim.subject, claim.predicate, claim.object),
      spokenIn,
      subject: claim.subject,
      predicate: claim.predicate,
      object: claim.object,
      negated: claim.negated,
      edges: resolved.edges,
      backing: resolved.backing,
      grounding: resolved.grounding,
      tier: resolved.tier,
      score,
      leaf: resolved.backing === 'composed'
    };
    claims.push(record);
    spokenKeys.add(claimKey(claim));
    for (const edge of resolved.edges) {
      if (!citedEdgeMap.has(edgeKey(edge))) citedEdgeMap.set(edgeKey(edge), { ...edge });
    }
    groundingProduct *= resolved.grounding;
    // GROUNDED-ONLY RECURSION: a composed claim is a LEAF — its objects
    // never seed the frontier (composed output never feeds composed output).
    if (seedObjects && resolved.backing === 'typed') seeds.push(claim.object);
    return true;
  };

  // ── The initial frames (framesFor output) — the elaboration's first hop.
  //    The critic verifies the joined composition (anaphoric frames resolve
  //    against the named first frame), and every claim is recorded with its
  //    own grounding.
  const frames = framesFor(subject, relations, {
    negations: options.negations,
    cost: options.cost ?? null,
    extraRules: options.extraRules
  }, deny);
  if (frames.length > 0) {
    const joined = frames.join(' ').replace(/\s+([.!?])/g, '$1');
    const verdict = criticize(joined, relations, options.negations ?? [], criticOptions);
    if (!verdict.grounded) {
      for (const frame of frames) refusedByCritic.push(frame);
    } else {
      for (const frame of frames) {
        const frameSubject = extractSubject(frame) ?? subject;
        const frameClaims = parseClaims(frame, frameSubject);
        if (frameClaims.length === 0) {
          refusedByCritic.push(frame);
          continue;
        }
        const before = claims.length;
        for (const claim of frameClaims) addClaim(claim, frame, 1, true);
        if (claims.length > before) sentences.push(frame);
      }
    }
  }

  let stopReason: ElaborationStopReason = 'frontier-empty';
  let bestRemainingScore: number | null = null;
  let frontierEntropyAtStop = 0;

  // ── The frontier loop — expand the best candidate until the §8.1 stop.
  while (true) {
    if (claims.length >= maxClaims) {
      // The SAFETY BOUND — a wall, not a budget. The bench refutes the
      // mechanism when this fires (the §8 stops must engage first).
      stopReason = 'safety-cap';
      break;
    }
    const candidates = collectCandidates(seeds, relations, deny, spokenKeys);
    if (candidates.length === 0) {
      stopReason = 'frontier-empty';
      break;
    }
    frontierEntropyAtStop = normalizedEntropy(candidates.map((c) => c.score));
    const expandable = candidates.filter((c) => c.tier === 'asserted');
    if (expandable.length === 0) {
      // The frontier consists only of hypothesis-tier edges — nothing is
      // left worth saying (M5: hypothesis edges may only ever be spoken
      // hedged, never built on; the elaboration refuses to expand them).
      stopReason = 'hypothesis-only';
      break;
    }
    const best = expandable[0];
    if (best.score < scoreFloor) {
      stopReason = 'score-floor';
      bestRemainingScore = best.score;
      break;
    }
    if (frontierEntropyAtStop >= flatThreshold) {
      // Flat candidate entropy (H̃ → 1): no candidate stands out as worth
      // saying next — the §2 instrument as the §8.1 stop.
      stopReason = 'flat-entropy';
      break;
    }

    const sentence = claimSentence(best.subject, best.predicate, best.object);
    // §8.2: the critic runs on EVERY claim, with the same refusal rule.
    const verdict = criticize(sentence, relations, options.negations ?? [], criticOptions);
    if (!verdict.grounded) {
      refusedByCritic.push(sentence);
      spokenKeys.add(claimKey(best));
      continue;
    }
    // Redundancy: a claim inheritable from an already-spoken claim (the
    // spoken claim holds on an is-a ancestor — the "inheritable from a
    // spoken is-a edge" case) or a duplicate of a spoken claim adds no
    // information — the elaboration analogue of the MDL anecdote.
    if (redundancyCheck) {
      const redundant = [...spokenKeys].some((key) => {
        const [s2, p2, o2] = key.split('\u0000') as [string, RelationPredicate, string];
        return (
          s2 !== best.subject &&
          p2 === best.predicate &&
          o2 === best.object &&
          isATypeOf(relations, best.subject, s2, deny)
        );
      });
      if (redundant) {
        redundantSkipped.push(sentence);
        spokenKeys.add(claimKey(best));
        continue;
      }
    }

    addClaim(
      { subject: best.subject, predicate: best.predicate, object: best.object, negated: false },
      sentence,
      best.score,
      true
    );
    sentences.push(sentence);
  }

  const related = relatedTopics(subject, relations, deny);
  const coda = related.length > 0 ? `Related: ${related.join(', ')}` : '';
  return {
    subject,
    claims,
    sentences,
    citedEdges: [...citedEdgeMap.values()],
    groundingProduct,
    stopReason,
    bestRemainingScore,
    frontierEntropyAtStop,
    refusedByCritic,
    redundantSkipped,
    related,
    coda,
    text: coda.length > 0 ? `${sentences.join(' ')} ${coda}` : sentences.join(' '),
    recalled: false,
    storedTraceId: null
  };
}

/** The frontier: every edge one hop out from a cited object (the seed
 *  words), deduplicated by claim, scored by corroboration strength, ordered
 *  strongest first (ties alphabetical for determinism). Already-spoken
 *  claims are never re-offered. */
function collectCandidates(
  seeds: readonly string[],
  relations: readonly Relation[],
  deny: DeniedClaim,
  spokenKeys: ReadonlySet<string>
): FrontierCandidate[] {
  const byKey = new Map<string, FrontierCandidate>();
  for (const seed of seeds) {
    for (const relation of relations) {
      if (relation.subject !== seed) continue;
      if (relation.subject === relation.object) continue;
      if (deny(relation.subject, relation.predicate, relation.object)) continue;
      const key = claimKey({ subject: relation.subject, predicate: relation.predicate, object: relation.object });
      if (spokenKeys.has(key)) continue;
      const tier = (relation.tier ?? 'asserted') === 'hypothesis' ? 'hypothesis' : 'asserted';
      const score = relation.strength ?? 1;
      const existing = byKey.get(key);
      if (existing === undefined || score > existing.score) {
        byKey.set(key, {
          subject: relation.subject,
          predicate: relation.predicate,
          object: relation.object,
          score,
          tier
        });
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.score - a.score || claimKey(a).localeCompare(claimKey(b))
  );
}

/** The related-topics coda: siblings under the same (direct) is-a parent
 *  and has-part neighbors. Structural only — never woven into the claims. */
function relatedTopics(subject: string, relations: readonly Relation[], deny: DeniedClaim): string[] {
  const byScore = new Map<string, number>();
  const note = (word: string, score: number): void => {
    if (word === subject) return;
    const existing = byScore.get(word);
    if (existing === undefined || score > existing) byScore.set(word, score);
  };
  const parents = relations
    .filter((r) => r.subject === subject && r.predicate === 'is-a' && !deny(r.subject, 'is-a', r.object))
    .map((r) => r.object);
  for (const parent of parents) {
    for (const relation of relations) {
      if (relation.predicate !== 'is-a' || relation.object !== parent || relation.subject === subject) continue;
      if (deny(relation.subject, 'is-a', relation.object)) continue;
      note(relation.subject, relation.strength ?? 1);
    }
  }
  const parts = relations
    .filter((r) => r.subject === subject && r.predicate === 'has-part' && !deny(r.subject, 'has-part', r.object))
    .map((r) => r.object);
  for (const part of parts) {
    for (const relation of relations) {
      if (relation.predicate !== 'has-part' || relation.object !== part || relation.subject === subject) continue;
      note(relation.subject, relation.strength ?? 1);
    }
  }
  return [...byScore.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([word]) => word);
}

// ── §8.4 Elaboration traces ────────────────────────────────────────────────

/** A stored elaboration trace: a memory whose content is OTHER MEMORIES —
 *  the trace ids / edges the elaboration drew on (metadata kind
 *  'elaboration'). */
export interface ElaborationTrace {
  readonly id: string;
  readonly subject: string;
  /** The trace content: the ids of the edges the elaboration drew on. */
  readonly content: string;
  /** The edge ids the elaboration drew on (its memory-of-memories). */
  readonly traceIds: string[];
  readonly edges: ElaborationEdge[];
  readonly sentences: string[];
  readonly claims: ElaboratedClaim[];
  readonly groundingProduct: number;
  readonly stopReason: ElaborationStopReason;
  readonly related: string[];
  readonly coda: string;
  readonly text: string;
  readonly grade: number;
  readonly storedAt: number;
  lastAccessAt: number;
  accessCount: number;
  readonly stabilityDays: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * THE ELABORATION-TRACE MEMORY (§8.4) — the natural cache of the frontier
 * search. Only elaborations graded at or above the floor are stored; a
 * stored elaboration recalls on re-ask when its edges still validate
 * against the graph, and its strength decays under the ONE retention law
 * (the non-word-trace stability preset) exactly like an ordinary trace —
 * recall refreshes the access clock, and a trace whose strength has decayed
 * below the floor is dropped and the elaboration is re-searched.
 */
export class ElaborationTraceMemory {
  readonly minGrade: number;
  readonly recallFloor: number;
  private readonly stabilityDays: number;
  private readonly stored = new Map<string, ElaborationTrace>();
  private readonly clock: () => number;
  private counter = 0;

  constructor(options: {
    minGrade?: number;
    recallFloor?: number;
    stabilityDays?: number;
    /** Injectable clock for the retention simulation (default Date.now). */
    now?: () => number;
  } = {}) {
    this.minGrade = options.minGrade ?? ELABORATION_TRACE_MIN_GRADE;
    this.recallFloor = options.recallFloor ?? ELABORATION_TRACE_RECALL_FLOOR;
    this.stabilityDays = options.stabilityDays ?? STABILITY_PRESETS.nonWordTraceDays;
    this.clock = options.now ?? (() => Date.now());
  }

  /** Store a graded elaboration as a trace (content = the edges it drew
   *  on). Returns the trace id, or null when the grade is below the floor
   *  or an equally-good trace already exists. */
  store(subject: string, result: ElaborationResult, grade: number): string | null {
    if (grade < this.minGrade || result.claims.length === 0) return null;
    const existing = this.stored.get(subject);
    if (existing !== undefined && existing.grade >= grade) return null;
    if (existing !== undefined) this.stored.delete(subject);
    const now = this.clock();
    const traceIds = result.citedEdges.map(edgeId);
    const trace: ElaborationTrace = {
      id: `elaboration:${subject}:${++this.counter}`,
      subject,
      content: traceIds.join(', '),
      traceIds,
      edges: result.citedEdges.map((edge) => ({ ...edge })),
      sentences: [...result.sentences],
      claims: result.claims.map((claim) => ({ ...claim })),
      groundingProduct: result.groundingProduct,
      stopReason: result.stopReason,
      related: [...result.related],
      coda: result.coda,
      text: result.text,
      grade,
      storedAt: now,
      lastAccessAt: now,
      accessCount: 0,
      stabilityDays: this.stabilityDays,
      metadata: {
        kind: 'elaboration',
        subject,
        grade,
        traceIds,
        stopReason: result.stopReason,
        groundingProduct: result.groundingProduct
      }
    };
    this.stored.set(subject, trace);
    return trace.id;
  }

  /** Every stored elaboration trace (best grade first). */
  traces(): readonly ElaborationTrace[] {
    return [...this.stored.values()].sort((a, b) => b.grade - a.grade);
  }

  /** The stored trace for a subject, or null. */
  traceOf(subject: string): ElaborationTrace | null {
    return this.stored.get(subject) ?? null;
  }

  /** The trace's strength under the one retention law — R(elapsed; S) with
   *  the non-word-trace stability preset, exactly like an ordinary trace. */
  traceStrength(trace: ElaborationTrace): number {
    const elapsedDays = Math.max(0, this.clock() - trace.lastAccessAt) / (24 * 60 * 60 * 1000);
    return retentionProbability(trace.stabilityDays, elapsedDays);
  }

  /**
   * Recall the stored elaboration for a subject, or null when none exists,
   * its strength has decayed below the recall floor (an ordinary trace
   * below the bank's minStrength is pruned — the elaboration is
   * re-searched), or its cited edges no longer validate against the graph
   * (the elaboration's grounding expired). A successful recall refreshes
   * the access clock like an ordinary trace access.
   */
  recall(subject: string, relations: readonly Relation[]): ElaborationResult | null {
    const trace = this.stored.get(subject);
    if (trace === undefined) return null;
    if (this.traceStrength(trace) < this.recallFloor) return null;
    const keys = new Set(relations.map(edgeKey));
    if (trace.edges.some((edge) => !keys.has(edgeKey(edge)))) return null;
    trace.accessCount += 1;
    trace.lastAccessAt = this.clock();
    return {
      subject,
      claims: trace.claims.map((claim) => ({ ...claim })),
      sentences: [...trace.sentences],
      citedEdges: trace.edges.map((edge) => ({ ...edge })),
      groundingProduct: trace.groundingProduct,
      stopReason: trace.stopReason,
      bestRemainingScore: null,
      frontierEntropyAtStop: 0,
      refusedByCritic: [],
      redundantSkipped: [],
      related: [...trace.related],
      coda: trace.coda,
      text: trace.text,
      recalled: true,
      storedTraceId: null
    };
  }
}

// ── §8.3 Inward self-questioning ───────────────────────────────────────────

/** One follow-up question an elaboration raises. */
export interface SelfQuestion {
  question: string;
  /** The cited object the question follows up on. */
  about: string;
  /** Whether the observer's own stack can answer it from the graph
   *  (answerable questions extend the elaboration; unanswerable ones become
   *  curiosity gaps). */
  answerable: boolean;
}

const articleOf = (word: string): string => (/^[aeiou]/.test(word) ? 'an' : 'a');

const pluralOf = (word: string): string => (word.endsWith('s') ? word : `${word}s`);

/**
 * THE INWARD QUESTIONS (§8.3) — the follow-up questions the elaboration
 * raises, routed through the observer's own stack. For each is-a parent:
 * "what is a bird?" (answerable when the parent still has frames — a
 * grounded answer extends the elaboration). For each has-part part: "what
 * are feathers for?" (answerable when the part has a used-for edge). The
 * pattern of which questions resolve and which do not maps where the graph
 * is thin around the concept.
 */
export function selfQuestions(
  subject: string,
  relations: readonly Relation[],
  options: ElaborationOptions = {}
): SelfQuestion[] {
  const deny = options.negations !== undefined ? deniedFromNegations(options.negations) : (() => false);
  const frameOptions: FrameOptions = {
    negations: options.negations,
    cost: options.cost ?? null,
    extraRules: options.extraRules
  };
  const questions: SelfQuestion[] = [];
  const seen = new Set<string>();
  const push = (question: string, about: string, answerable: boolean): void => {
    if (seen.has(question)) return;
    seen.add(question);
    questions.push({ question, about, answerable });
  };

  // The direct is-a parents — the objects the elaboration's first frame
  // actually names ("A robin is a bird." → "what is a bird?").
  for (const parent of relations
    .filter((r) => r.subject === subject && r.predicate === 'is-a' && !deny(r.subject, 'is-a', r.object))
    .map((r) => r.object)) {
    push(
      `what is ${articleOf(parent)} ${parent}?`,
      parent,
      framesFor(parent, relations, frameOptions, deny).length > 0
    );
  }
  for (const part of edgeObjects(relations, subject, 'has-part', deny)) {
    push(
      `what are ${pluralOf(part)} for?`,
      part,
      edgeObjects(relations, part, 'used-for', deny).length > 0
    );
  }
  return questions;
}

/** The self-questions the observer cannot answer from its own graph — the
 *  curiosity-gap feed of the classroom loop (§8.3). */
export function unansweredSelfQuestions(
  subject: string,
  relations: readonly Relation[],
  options: ElaborationOptions = {}
): string[] {
  return selfQuestions(subject, relations, options)
    .filter((question) => !question.answerable)
    .map((question) => question.question);
}
