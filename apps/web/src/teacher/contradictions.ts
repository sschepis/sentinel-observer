/**
 * CONTRADICTION SWEEP — the graph's own integrity audit.
 *
 * The relation graph grows from three sources (regex extraction, the
 * authored curricula, the Chaperone) and a confirmed-false store (P8). Each
 * source is precision-first on its own, but nothing reconciles the sources
 * against each other at rest: a positive edge and a negation for the same
 * claim can sit in the graph silently, and inheritance (chain.ts) can hand
 * a subject an edge its own ancestor denies. This module sweeps the whole
 * graph for those disagreements, scores each by the evidence behind both
 * sides, and emits a verification queue — a targeted list of yes/no probes
 * the world (user or graded feedback) resolves.
 *
 * Honesty contract: a conflict is only REPORTED when both sides carry
 * meaningful support. A positive edge weakened to the floor by wrong grades
 * is no longer a live claim — it answers hedged, and the sweep leaves it
 * alone. Resolution (see sweep.ts) exploits exactly this gate: confirming
 * the negative weakens the positive below the floor, so the sweep does not
 * re-report the same disagreement; confirming the positive retracts the
 * negation and reinforces the edge (corroboration bookkeeping).
 *
 * The module is PURE — no session, no persistence. It reads relations and
 * negations and returns conflicts, so every rule here is unit-testable
 * without the observer.
 */
import { predicateVerb, type Negation, type Relation, type RelationOrigin } from './relations';

/** The is-a walk depth, mirroring chain.ts (MAX_DEPTH). */
const ANCESTOR_DEPTH = 4;

/**
 * A positive edge whose confidence is meaningful enough to collide with a
 * denial. Edges weakened below this floor (wrong grades, resolved
 * negative-wins) no longer assert — the sweep stops reporting them.
 */
export const MIN_POSITIVE_STRENGTH = 0.5;

/** The provenance-priority bonus for a positive edge (regex is precision-first
 *  and validated; chaperone edges are the least validated source). */
const PROVENANCE_BONUS: Record<RelationOrigin, number> = { regex: 0.15, authored: 0.1, chaperone: 0.05, reading: 0.05 };

/** The evidence weight of the denial side: a taught statement is explicit
 *  user testimony; a graded "No" is world feedback through the answer path. */
const NEGATION_ORIGIN_WEIGHT: Record<Negation['origin'], number> = { taught: 1, graded: 0.6, reading: 0.5 };

/** Direct conflicts are the graph lying about itself; inherited ones have an
 *  escape hatch (the subject may be a genuine exception to its parent), so
 *  they weigh less. */
const DIRECTION_FACTOR = {
  direct: 1,
  'explicit-positive': 0.8,
  'explicit-negative': 0.85,
  inherited: 0.6
} as const;

export type ConflictDirection = keyof typeof DIRECTION_FACTOR;

/** The positive side of a conflict: an edge (direct on the subject, or
 *  inherited from an is-a ancestor). */
export interface PositiveSide {
  /** The subject the asserting edge lives on (the conflict subject when
   *  direct; an is-a ancestor when inherited). */
  holder: string;
  origin: RelationOrigin;
  /** Effective confidence: 1 per stated source + agreement/grade deltas. */
  strength: number;
  /** How many relation entries state the same triple (corroboration). */
  corroborations: number;
  source: string;
}

/** The negative side of a conflict: a confirmed-false entry. */
export interface NegativeSide {
  /** The subject the denial lives on (the conflict subject when direct; an
   *  is-a ancestor when inherited — the denial applies to the subclass). */
  holder: string;
  origin: Negation['origin'];
  evidence: string;
}

/** One detected contradiction: the same claim asserted positively and
 *  denied, either on the same subject or across an is-a edge. */
export interface SweepConflict {
  /** Stable identity — the sweep must be able to say "this one resolved". */
  id: string;
  /** The subject where the disagreement is observed. */
  subject: string;
  predicate: string;
  object: string;
  kind: 'direct' | 'inheritance';
  direction: ConflictDirection;
  positive: PositiveSide;
  negative: NegativeSide;
  /** Triage score in [0, 1] — higher = more evidence, more urgent. */
  severity: number;
}

/** A triaged conflict, phrased as a question the world can answer. */
export interface VerificationItem {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  kind: SweepConflict['kind'];
  direction: ConflictDirection;
  severity: number;
  positive: PositiveSide;
  negative: NegativeSide;
  /** The yes/no probe ("is a whale a fish?"). */
  question: string;
}

/** The verdict the world gives on a probe. */
export type ResolutionVerdict = 'positive' | 'negative';

/** The edge-level edits a verdict implies (applied by the integration
 *  layer): reinforce the winning positive, retract the losing negation,
 *  or weaken the losing positive below the sweep floor. */
export interface ResolutionEffect {
  reinforce?: { holder: string; predicate: string; object: string };
  retractNegation?: { holder: string; predicate: string; object: string };
  weaken?: { holder: string; predicate: string; object: string };
}

/** "whale is-a fish" reads as "is a fish" — the article follows the object. */
function article(object: string): string {
  return /^[aeiou]/.test(object) ? 'an' : 'a';
}

/** The natural-language probe for a claim — phrased in the operator forms
 *  ("is a whale a fish?", "does a snake have legs?") so the OBSERVER can
 *  answer it from its own graph too, and the world's yes/no resolves it. */
export function verificationQuestionFor(subject: string, predicate: string, object: string): string {
  switch (predicate) {
    case 'is-a':
      return `is ${subject} ${article(object)} ${object}?`;
    case 'has-part':
      return `does ${subject} have ${object}?`;
    case 'made-of':
      return `is ${subject} made of ${object}?`;
    default:
      return `is it true that ${subject} ${predicateVerb(predicate as Relation['predicate'], object)} ${object}?`;
  }
}

/** All is-a ancestors of a subject (transitively, up to ANCESTOR_DEPTH),
 *  including itself. The same walk chain.ts uses for inheritsEdge. The
 *  is-a map can be supplied to share one build across many lookups. */
export function ancestorsOf(
  relations: readonly Relation[],
  subject: string,
  isA?: ReadonlyMap<string, readonly string[]>
): string[] {
  const bySubject =
    isA ??
    (() => {
      const built = new Map<string, string[]>();
      for (const relation of relations) {
        if (relation.predicate !== 'is-a') continue;
        const list = built.get(relation.subject) ?? [];
        list.push(relation.object);
        built.set(relation.subject, list);
      }
      return built;
    })();
  const reached = [subject];
  const seen = new Set<string>([subject]);
  for (let depth = 0; depth < ANCESTOR_DEPTH; depth += 1) {
    const frontier = reached.slice();
    for (const word of frontier) {
      for (const parent of bySubject.get(word) ?? []) {
        if (!seen.has(parent)) {
          seen.add(parent);
          reached.push(parent);
        }
      }
    }
  }
  return reached;
}

/** The is-a ancestors of a subject, EXCLUDING the subject itself. */
function properAncestors(
  relations: readonly Relation[],
  subject: string,
  isA: ReadonlyMap<string, readonly string[]>
): string[] {
  return ancestorsOf(relations, subject, isA).filter((word) => word !== subject);
}

/** The direct positive edges of a subject, keyed by triple — with the
 *  effective strength (max over corroborating entries) and the
 *  corroboration count. */
function directPositives(
  relations: readonly Relation[]
): Map<string, PositiveSide> {
  const byKey = new Map<string, Array<Relation & { strength: number }>>();
  for (const relation of relations) {
    const key = `${relation.subject}\u0000${relation.predicate}\u0000${relation.object}`;
    const list = byKey.get(key) ?? [];
    list.push({ ...relation, strength: relation.strength ?? 1 });
    byKey.set(key, list);
  }
  const out = new Map<string, PositiveSide>();
  for (const [key, list] of byKey) {
    let best = list[0];
    for (const entry of list) {
      if (entry.strength > best.strength) best = entry;
    }
    out.set(key, {
      holder: best.subject,
      origin: best.origin,
      strength: best.strength,
      corroborations: list.length,
      source: best.source
    });
  }
  return out;
}

/** The direct negations of a subject, keyed by triple. */
function directNegations(negations: readonly Negation[]): Map<string, NegativeSide> {
  const out = new Map<string, NegativeSide>();
  for (const negation of negations) {
    out.set(`${negation.subject}\u0000${negation.predicate}\u0000${negation.object}`, {
      holder: negation.subject,
      origin: negation.origin,
      evidence: negation.evidence
    });
  }
  return out;
}

/** The evidence weight of the positive side, from its effective strength:
 *  a single stated source (strength 1) scores 0.5; a chaperone-agreed edge
 *  (2) saturates at 1. */
function positiveEvidence(positive: PositiveSide): number {
  return Math.min(1, positive.strength / 2);
}

/**
 * Severity triage (c): how much evidence stands behind both sides, and how
 * directly they collide. Transparent and bounded — every term is a named
 * input, so a raised or lowered score is always explainable:
 *
 *   severity = (0.45·positive + 0.35·negative + 0.2·provenance + corrob) × directness
 *
 * where positive = strength evidence, negative = denial origin weight,
 * provenance = the origin-priority bonus, corrob = corroborating sources,
 * and directness = how directly the two sides collide.
 */
export function severityOf(conflict: SweepConflict): number {
  const positive = positiveEvidence(conflict.positive);
  const negative = NEGATION_ORIGIN_WEIGHT[conflict.negative.origin];
  const provenance = PROVENANCE_BONUS[conflict.positive.origin];
  const corroboration = Math.min(0.1, 0.05 * Math.max(0, conflict.positive.corroborations - 1));
  const raw =
    0.45 * positive + 0.35 * negative + 0.2 * provenance + corroboration;
  return Math.max(0, Math.min(1, raw * DIRECTION_FACTOR[conflict.direction]));
}

function conflictId(
  direction: ConflictDirection,
  subject: string,
  predicate: string,
  object: string,
  positiveHolder: string,
  negativeHolder: string
): string {
  if (direction === 'direct') return `direct:${subject}\u0000${predicate}\u0000${object}`;
  return `${direction}:${subject}\u0000${predicate}\u0000${object}\u0000${positiveHolder}\u0000${negativeHolder}`;
}

function makeConflict(
  direction: ConflictDirection,
  subject: string,
  predicate: string,
  object: string,
  positive: PositiveSide,
  negative: NegativeSide
): SweepConflict {
  const id = conflictId(direction, subject, predicate, object, positive.holder, negative.holder);
  const conflict: SweepConflict = {
    id,
    subject,
    predicate,
    object,
    kind: direction === 'direct' ? 'direct' : 'inheritance',
    direction,
    positive,
    negative,
    severity: 0
  };
  conflict.severity = severityOf(conflict);
  return conflict;
}

/**
 * SWEEP THE GRAPH: every claim asserted both positively and negatively,
 * direct or across an is-a edge, in both directions:
 *
 *   · direct               — the subject itself has the edge AND the denial;
 *   · explicit-positive    — the subject asserts the edge while an is-a
 *                            ancestor denies it (inherited denial);
 *   · explicit-negative    — the subject denies the claim while an is-a
 *                            ancestor asserts it (inherited positive);
 *   · inherited            — the subject inherits the claim from one ancestor
 *                            and the denial from a different one.
 *
 * The support gate (MIN_POSITIVE_STRENGTH) is applied to the positive side
 * on BOTH sides of the check: a weakened edge is no longer a live claim.
 */
export function detectConflicts(
  relations: readonly Relation[],
  negations: readonly Negation[]
): SweepConflict[] {
  const positives = directPositives(relations);
  const negatives = directNegations(negations);
  // The is-a map and the per-holder indexes, built once — the sweep then
  // visits each subject's OWN edges instead of rescanning the full graph
  // per subject (measured: ~40s → sub-second on the 20k-word deck).
  const isA = new Map<string, string[]>();
  const byHolder = new Map<string, Relation[]>();
  for (const relation of relations) {
    const list = byHolder.get(relation.subject) ?? [];
    list.push(relation);
    byHolder.set(relation.subject, list);
    if (relation.predicate === 'is-a') {
      const parents = isA.get(relation.subject) ?? [];
      parents.push(relation.object);
      isA.set(relation.subject, parents);
    }
  }
  const positivesByHolder = new Map<string, Map<string, PositiveSide>>();
  for (const [key, positive] of positives) {
    const list = positivesByHolder.get(positive.holder) ?? new Map<string, PositiveSide>();
    list.set(key, positive);
    positivesByHolder.set(positive.holder, list);
  }
  const negativesByHolder = new Map<string, Map<string, NegativeSide>>();
  for (const [key, negative] of negatives) {
    const list = negativesByHolder.get(negative.holder) ?? new Map<string, NegativeSide>();
    list.set(key, negative);
    negativesByHolder.set(negative.holder, list);
  }
  // The inherited denials per ancestor, so the per-subject walk does not
  // rescan the negation list for every ancestor.
  const negationsByHolder = new Map<string, Negation[]>();
  for (const negation of negations) {
    const list = negationsByHolder.get(negation.subject) ?? [];
    list.push(negation);
    negationsByHolder.set(negation.subject, list);
  }

  const conflicts: SweepConflict[] = [];
  const seen = new Set<string>();

  const push = (conflict: SweepConflict): void => {
    if (seen.has(conflict.id)) return;
    seen.add(conflict.id);
    conflicts.push(conflict);
  };

  // The subject universe: every subject that either asserts or denies
  // something, plus every is-a object (a denial on an ancestor must be
  // checked against every subclass that inherits it).
  const subjects = new Set<string>();
  for (const relation of relations) subjects.add(relation.subject);
  for (const negation of negations) subjects.add(negation.subject);
  for (const relation of relations) {
    if (relation.predicate === 'is-a') subjects.add(relation.object);
  }

  for (const subject of subjects) {
    const ancestors = properAncestors(relations, subject, isA);
    // The inherited positive edges of this subject, keyed by triple —
    // collected from the DIRECT edges of its ancestors (the walk
    // chain.ts's inheritsEdge performs).
    const inheritedPositives = new Map<string, PositiveSide>();
    for (const ancestor of ancestors) {
      for (const relation of byHolder.get(ancestor) ?? []) {
        const positive = positives.get(
          `${ancestor}\u0000${relation.predicate}\u0000${relation.object}`
        );
        if (positive === undefined) continue;
        inheritedPositives.set(
          `${relation.predicate}\u0000${relation.object}`,
          positive
        );
      }
    }
    // The inherited denials: the confirmed-false entries of the ancestors,
    // each applying to the subclass by class membership.
    const inheritedNegations = new Map<string, NegativeSide>();
    for (const ancestor of ancestors) {
      for (const negation of negationsByHolder.get(ancestor) ?? []) {
        inheritedNegations.set(`${negation.predicate}\u0000${negation.object}`, {
          holder: ancestor,
          origin: negation.origin,
          evidence: negation.evidence
        });
      }
    }

    const subjectPositives = positivesByHolder.get(subject) ?? new Map<string, PositiveSide>();
    for (const [pKey, positive] of subjectPositives) {
      if (positive.strength < MIN_POSITIVE_STRENGTH) continue;
      const predicate = pKey.split('\u0000')[1];
      const object = pKey.split('\u0000')[2];

      // Direct: the subject asserts and denies the same claim.
      const direct = negatives.get(pKey);
      if (direct !== undefined) {
        push(makeConflict('direct', subject, predicate, object, positive, direct));
      }
      // Explicit-positive vs inherited-negative: an ancestor denies what
      // this subject explicitly asserts.
      const inherited = inheritedNegations.get(`${predicate}\u0000${object}`);
      if (inherited !== undefined) {
        push(makeConflict('explicit-positive', subject, predicate, object, positive, inherited));
      }
    }

    const subjectNegations = negativesByHolder.get(subject) ?? new Map<string, NegativeSide>();
    for (const [nKey, negative] of subjectNegations) {
      const predicate = nKey.split('\u0000')[1];
      const object = nKey.split('\u0000')[2];

      // Explicit-negative vs inherited-positive: this subject denies what
      // an ancestor explicitly asserts.
      const inherited = inheritedPositives.get(`${predicate}\u0000${object}`);
      if (inherited !== undefined && inherited.strength >= MIN_POSITIVE_STRENGTH) {
        push(makeConflict('explicit-negative', subject, predicate, object, inherited, negative));
      }
    }

    // Inherited-vs-inherited: the claim comes from one ancestor and the
    // denial from a different one, with neither side explicit on the
    // subject and no direct conflict at either source (those are reported
    // where they live). This is the graph being inconsistent about the
    // subject's PARENTAGE without a directly-reportable root.
    for (const [key, positive] of inheritedPositives) {
      if (positive.strength < MIN_POSITIVE_STRENGTH) continue;
      const inherited = inheritedNegations.get(key);
      if (inherited === undefined || inherited.holder === positive.holder) continue;
      if (positives.has(`${subject}\u0000${key}`) || negatives.has(`${subject}\u0000${key}`)) continue;
      if (positives.has(`${positive.holder}\u0000${key}`) && negatives.has(`${positive.holder}\u0000${key}`)) continue;
      if (positives.has(`${inherited.holder}\u0000${key}`) && negatives.has(`${inherited.holder}\u0000${key}`)) continue;
      const [predicate, object] = key.split('\u0000');
      push(makeConflict('inherited', subject, predicate, object, positive, inherited));
    }
  }

  return conflicts;
}

/**
 * Conflict triage (c): score every conflict by its evidence and produce the
 * verification queue, highest severity first (deterministic tie-break by
 * id so a sweep is reproducible).
 */
export function triageConflicts(
  conflicts: readonly SweepConflict[],
  options: { maxItems?: number } = {}
): VerificationItem[] {
  const sorted = [...conflicts].sort(
    (a, b) => b.severity - a.severity || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const items: VerificationItem[] = [];
  for (const conflict of sorted) {
    if (options.maxItems !== undefined && items.length >= options.maxItems) break;
    items.push({
      id: conflict.id,
      subject: conflict.subject,
      predicate: conflict.predicate,
      object: conflict.object,
      kind: conflict.kind,
      direction: conflict.direction,
      severity: conflict.severity,
      positive: conflict.positive,
      negative: conflict.negative,
      question: verificationQuestionFor(conflict.subject, conflict.predicate, conflict.object)
    });
  }
  return items;
}

/**
 * The edge-level edits a resolution verdict implies. The integration layer
 * applies them to the teacher (see sweep.ts):
 *
 *   · 'positive' (the world confirmed the claim): the losing NEGATION is
 *     retracted, and the winning positive edge gains corroboration.
 *   · 'negative' (the world denied the claim): the losing positive edge is
 *     weakened below the sweep floor, so the sweep stops reporting it.
 */
export function resolutionFor(conflict: SweepConflict, verdict: ResolutionVerdict): ResolutionEffect {
  const reinforce = (holder: string): ResolutionEffect['reinforce'] => ({
    holder,
    predicate: conflict.predicate,
    object: conflict.object
  });
  const retractNegation = (holder: string): ResolutionEffect['retractNegation'] => ({
    holder,
    predicate: conflict.predicate,
    object: conflict.object
  });
  const weaken = (holder: string): ResolutionEffect['weaken'] => ({
    holder,
    predicate: conflict.predicate,
    object: conflict.object
  });

  if (verdict === 'positive') {
    // The positive side wins: retract the denial, keep the assertion.
    switch (conflict.direction) {
      case 'direct':
        return { retractNegation: retractNegation(conflict.subject), reinforce: reinforce(conflict.subject) };
      case 'explicit-positive':
        // The denial lived on the ancestor; the subject's explicit edge wins.
        return { retractNegation: retractNegation(conflict.negative.holder), reinforce: reinforce(conflict.subject) };
      case 'explicit-negative':
        return { retractNegation: retractNegation(conflict.subject), reinforce: reinforce(conflict.positive.holder) };
      case 'inherited':
        return { retractNegation: retractNegation(conflict.negative.holder), reinforce: reinforce(conflict.positive.holder) };
    }
  }
  // The negative side wins: the positive edge loses support below the floor.
  switch (conflict.direction) {
    case 'direct':
      return { weaken: weaken(conflict.subject) };
    case 'explicit-positive':
      return { weaken: weaken(conflict.subject) };
    case 'explicit-negative':
      return { weaken: weaken(conflict.positive.holder) };
    case 'inherited':
      return { weaken: weaken(conflict.positive.holder) };
  }
}

/** Re-run detection and report whether the conflict is still live — the
 *  sweep's own definition of "resolved". */
export function isConflictResolved(
  relations: readonly Relation[],
  negations: readonly Negation[],
  conflict: SweepConflict
): boolean {
  return !detectConflicts(relations, negations).some((c) => c.id === conflict.id);
}
