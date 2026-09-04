/**
 * PATH EVIDENCE — the candidate distribution over is-a paths a chained
 * answer rests on (improvements.md §4.3 / improvements-tasks.md C.3).
 *
 * A chained answer today surfaces *a* path. Two claims can both be "Yes"
 * while resting on very different evidence: one reached by a single path
 * through a weakened edge, another reached by several independent paths
 * through strong edges. This module reads the distribution chain.ts
 * `isAPaths` retains (scores = product of edge strengths along the path)
 * and reduces it to the numbers a speaker can act on:
 *
 *   paths       every route the walk visited (nodes + strength product).
 *   mass        Σ products — the total evidence for the claim.
 *   count       the number of independent routes.
 *   singlePath  count === 1 — the claim dies with its one edge.
 *   weakestEdge the weakest edge on the strongest (surfaced) path.
 *
 * THE HEDGED-BY-PATHS VERDICT: a claim resting on ONE path whose product is
 * below a threshold — or whose single path carries a weakened edge — must be
 * spoken HEDGED ("Probably, … — it rests on one source."), the same
 * contract the operator layer already honors for single weakened edges (P8)
 * and single sources (P14). Multi-path claims stay asserted: no single
 * corrupted edge can flip them. The thresholds are TUNING CONSTANTS (§5):
 * the defaults read "a full-strength single path asserts; any weakened edge
 * on the only path hedges", and the two knobs exist so §5 can calibrate
 * them independently on the path-entropy bench.
 */

import { isAPaths, isAEdgeStrength } from './chain';
import type { DeniedClaim, IsAPath } from './chain';
import type { Relation } from './relations';
import type { HedgeWord } from './corroboration';

/** One claim's reading over its is-a paths. */
export interface PathEvidence {
  /** Every is-a path from subject to target (product of edge strengths). */
  paths: IsAPath[];
  /** Σ of the paths' strength products — total evidence mass. */
  mass: number;
  /** The number of independent routes. */
  count: number;
  /** True when exactly one route supports the claim (it dies with its edge). */
  singlePath: boolean;
  /** The weakest edge strength on the strongest path (absent paths = 1). */
  weakestEdge: number;
}

/**
 * Read the is-a path distribution for `subject -> target` under the given
 * relation graph, with the same `denied` veto the walk itself honors (a
 * negated is-a edge is never walked, so a denied claim has no paths).
 */
export function pathEvidence(
  relations: readonly Relation[],
  subject: string,
  target: string,
  denied: DeniedClaim = () => false
): PathEvidence {
  const paths = isAPaths(relations, subject, target, denied);
  const mass = paths.reduce((sum, path) => sum + path.strength, 0);
  let strongest: IsAPath | null = null;
  for (const path of paths) {
    if (strongest === null || path.strength > strongest.strength) strongest = path;
  }
  let weakestEdge = 1;
  if (strongest !== null) {
    for (let i = 0; i + 1 < strongest.nodes.length; i += 1) {
      weakestEdge = Math.min(
        weakestEdge,
        isAEdgeStrength(relations, strongest.nodes[i], strongest.nodes[i + 1])
      );
    }
  }
  return { paths, mass, count: paths.length, singlePath: paths.length === 1, weakestEdge };
}

/** The hedge verdict's thresholds (§5 tuning constants). */
export interface PathHedgeThresholds {
  /** A single path whose product is below this reads weak. */
  pathProductMin: number;
  /** An edge below this reads weakened (P8's confident floor). */
  edgeStrengthMin: number;
}

/**
 * The default thresholds. `isAPaths` treats an absent edge strength as 1,
 * so a product below 1 and a weakened edge coincide in the default regime —
 * the two knobs are separate so §5 can calibrate them independently.
 */
export const PATH_HEDGE_DEFAULTS: PathHedgeThresholds = {
  pathProductMin: 1,
  edgeStrengthMin: 1
};

/**
 * The §4.3 verdict: must this claim be spoken hedged? True only for a claim
 * resting on ONE path whose product is below the threshold or whose single
 * path carries a weakened edge. Multi-path claims (and claims with no path
 * at all) are never hedged by this rule.
 */
export function hedgedByPaths(
  evidence: PathEvidence,
  thresholds: PathHedgeThresholds = PATH_HEDGE_DEFAULTS
): boolean {
  if (!evidence.singlePath) return false;
  return (
    evidence.mass < thresholds.pathProductMin ||
    evidence.weakestEdge < thresholds.edgeStrengthMin
  );
}

/**
 * The hedge word a hedged-by-paths claim is spoken with ('' = assert
 * flatly). A weakened edge on the only path hedges "Probably" — the P8
 * contract; a single full-strength path below the product threshold hedges
 * "I think" — the P14 single-source contract. Reuses corroboration.ts's
 * `HedgeWord` vocabulary so every hedge in the system is one of the two
 * words the grounding layer already strips.
 */
export function pathHedgeWord(
  evidence: PathEvidence,
  thresholds: PathHedgeThresholds = PATH_HEDGE_DEFAULTS
): HedgeWord {
  if (!hedgedByPaths(evidence, thresholds)) return '';
  return evidence.weakestEdge < thresholds.edgeStrengthMin ? 'Probably' : 'I think';
}
