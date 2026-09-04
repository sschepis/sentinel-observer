/**
 * L2 (Phase 20) — THE TRUST KERNEL: trust is measured agreement; fusion is
 * normalized trust.
 *
 * The same concept was implemented four times before this module existed:
 * the grader-reliability buckets, the fading controller's λ state machine,
 * edge corroboration classes, and rule corroboration. The kernel is the one
 * law under them: every JUDGE (the LLM teacher, the student's composite,
 * later: council members) accrues agreement mass against ground truth —
 * rule-based checks, oracles, world outcomes — bucketed by the same criteria
 * dimensions the reliability model established. Trust is the POSTERIOR LOWER
 * BOUND (Wilson) on the judge's agreement rate: a number that carries its
 * own sample mass, so a blind bucket is UNTRUSTED no matter how loudly it
 * agrees with itself, and trust tightens toward the measured rate as
 * evidence accrues.
 *
 * Fusion (the fading controller's replacement): when two judges must be
 * blended, the blend weight is normalized trust —
 *
 *     λ = T_student / (T_student + T_teacher)
 *
 * with an asymmetry the scaffold requires: the TEACHER is the incumbent
 * authority and carries the prior (an unmeasured teacher bucket is still
 * trusted at the prior's lower bound); the STUDENT's composite is the
 * newcomer and earns trust from ZERO (prior 0 — no unearned authority).
 * The old controller's four constants become theorems:
 *   · the floor: a blind student bucket has LB 0 → λ = 0;
 *   · the ceiling: finite teacher mass keeps T_teacher > 0 → λ < 1, and two
 *     equally-proven judges settle at λ* = 0.5 — the teacher is never
 *     dismissed, it is OUT-MEASURED;
 *   · the rate: λ climbs exactly as fast as evidence tightens the bound;
 *   · the regression: a student that stops agreeing loses mass-weighted
 *     rate, and λ falls with no special case (hack-resistance: a composite
 *     that flatters itself diverges from the rule checks and world verdicts
 *     that feed its buckets, and its trust collapses).
 */

/** Uninformative prior for an INCUMBENT judge (the LLM teacher): slightly
 *  better than chance, same value the reliability model has always used. */
export const TRUST_PRIOR = 0.65;
/** Pseudo-count of the Bayesian smoothing — the pull of the prior. */
export const TRUST_PSEUDO_COUNT = 4;
/** Floor of the feedback weight — damp, never erase. */
export const TRUST_MIN_WEIGHT = 0.1;
/** z of the Wilson lower bound (~95% one-sided confidence). */
export const TRUST_Z = 1.96;
/** Defensive floor on the incumbent's trust in fusion — λ can approach but
 *  never reach 1 even if every estimate degenerates. */
export const FUSION_TEACHER_FLOOR = 0.05;

/** The judges the kernel currently fuses. */
export const JUDGE_LLM = 'llm';
export const JUDGE_COMPOSITE = 'composite';
/** D.8 (§5.2 row 9): the world-outcome channel as a junior judge — its
 *  weight is its MEASURED agreement with ground truth, not an assignment. */
export const JUDGE_WORLD = 'world';

// ────────────────────────────────────────────────────────────────────────────
// D.8 (§5.2 row 9) — the world-outcome weight, measured by the kernel itself
// ────────────────────────────────────────────────────────────────────────────

/** The hand world-feedback weight — the CONTROL (mirrors reliability.ts
 *  WORLD_FEEDBACK_WEIGHT; the bench asserts parity). The world confirms
 *  slowly, the teacher sharply. */
export const WORLD_FEEDBACK_CONTROL = 0.25;

/** The gate — OFF by default (the 0.25 constant is the CONTROL; the
 *  measured weight switches on only behind its bench). */
let worldWeightMeasured = false;

/** Enable/disable the measured world-outcome weight. */
export function setWorldWeightMeasured(enabled: boolean): void {
  worldWeightMeasured = enabled;
}

/** Whether the measured world-outcome weight is currently live. */
export function isWorldWeightMeasured(): boolean {
  return worldWeightMeasured;
}

/**
 * The world channel's measured agreement with ground truth in a bucket —
 * the trust kernel's own machinery applied to the world judge: the Wilson
 * lower bound on its recorded agreement rate at prior 0 (a newcomer earns
 * everything). Bounded to [0, 1): 0 with no evidence, tightening toward the
 * measured rate as ground-truth outcomes accrue, falling when the channel
 * disagrees with the ground truth it is measured against.
 */
export function measuredWorldWeight(kernel: TrustKernel, criteria: TrustCriteria): number {
  return kernel.trustLB(JUDGE_WORLD, criteria, 0);
}

/**
 * The LIVE world-feedback weight: the world channel's measured agreement
 * when the gate is on, else the fixed control (0.25). World outcomes that
 * carry ground truth (rule checks, bench verdicts) are recorded into the
 * world judge with kernel.record(JUDGE_WORLD, criteria, agree) — the same
 * bucket machinery every judge accrues under.
 */
export function worldFeedbackWeight(kernel: TrustKernel, criteria: TrustCriteria): number {
  if (worldWeightMeasured) return measuredWorldWeight(kernel, criteria);
  return WORLD_FEEDBACK_CONTROL;
}

/** The criteria dimensions (structurally identical to GradeCriteria in
 *  reliability.ts — defined here so reliability.ts can depend on trust.ts
 *  without a cycle). */
export interface TrustCriteria {
  answerType: string;
  difficultyBand: string;
  template: string;
  provider: string;
}

/** The stable key of a criteria tuple. */
export function trustCriteriaKey(criteria: TrustCriteria): string {
  return `${criteria.answerType}\u0000${criteria.difficultyBand}\u0000${criteria.template}\u0000${criteria.provider}`;
}

export interface TrustBucketStats {
  /** Weighted agreement mass (rule checks count 1, world feedback less). */
  agree: number;
  /** Weighted sample mass. */
  total: number;
}

/** One judge's evidence: the full-tuple buckets plus the four dimension
 *  fallbacks (the reliability model's structure, per judge). */
export interface JudgeSnapshot {
  buckets: Record<string, TrustBucketStats>;
  byAnswerType: Record<string, TrustBucketStats>;
  byDifficulty: Record<string, TrustBucketStats>;
  byTemplate: Record<string, TrustBucketStats>;
  byProvider: Record<string, TrustBucketStats>;
}

interface JudgeStats {
  buckets: Map<string, TrustBucketStats>;
  byAnswerType: Map<string, TrustBucketStats>;
  byDifficulty: Map<string, TrustBucketStats>;
  byTemplate: Map<string, TrustBucketStats>;
  byProvider: Map<string, TrustBucketStats>;
}

function emptyJudge(): JudgeStats {
  return {
    buckets: new Map(),
    byAnswerType: new Map(),
    byDifficulty: new Map(),
    byTemplate: new Map(),
    byProvider: new Map()
  };
}

function bump(map: Map<string, TrustBucketStats>, key: string, agree: boolean, weight: number): void {
  const stats = map.get(key) ?? { agree: 0, total: 0 };
  stats.agree += agree ? weight : 0;
  stats.total += weight;
  map.set(key, stats);
}

/** The Wilson score lower bound on a rate observed over `n` samples. */
export function wilsonLowerBound(rate: number, n: number, z = TRUST_Z): number {
  if (!(n > 0)) return 0;
  const p = Math.max(0, Math.min(1, rate));
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / denominator);
}

export class TrustKernel {
  private readonly judgeStats = new Map<string, JudgeStats>();

  private judge(id: string): JudgeStats {
    let stats = this.judgeStats.get(id);
    if (stats === undefined) {
      stats = emptyJudge();
      this.judgeStats.set(id, stats);
    }
    return stats;
  }

  /** Record one agreement observation for a judge in a bucket. */
  record(judgeId: string, criteria: TrustCriteria, agree: boolean, weight = 1): void {
    const stats = this.judge(judgeId);
    bump(stats.buckets, trustCriteriaKey(criteria), agree, weight);
    bump(stats.byAnswerType, criteria.answerType, agree, weight);
    bump(stats.byDifficulty, criteria.difficultyBand, agree, weight);
    bump(stats.byTemplate, criteria.template, agree, weight);
    if (criteria.provider.length > 0) bump(stats.byProvider, criteria.provider, agree, weight);
  }

  /** The consulted cells of a criteria tuple (tuple + dimensions). */
  private cells(judgeId: string, criteria: TrustCriteria): Array<TrustBucketStats | undefined> {
    const stats = this.judgeStats.get(judgeId);
    if (stats === undefined) return [];
    const parts: Array<TrustBucketStats | undefined> = [
      stats.buckets.get(trustCriteriaKey(criteria)),
      stats.byAnswerType.get(criteria.answerType),
      stats.byDifficulty.get(criteria.difficultyBand),
      stats.byTemplate.get(criteria.template)
    ];
    if (criteria.provider.length > 0) parts.push(stats.byProvider.get(criteria.provider));
    return parts;
  }

  /**
   * The smoothed agreement estimate of a judge in a bucket: a Bayesian
   * posterior per consulted cell (tuple, then each dimension) blended by
   * its sample mass — the reliability model's exact machinery, with the
   * PRIOR as a parameter: the incumbent teacher keeps TRUST_PRIOR, the
   * newcomer composite runs at prior 0 (it earns everything).
   */
  reliability(judgeId: string, criteria: TrustCriteria, prior = TRUST_PRIOR): number {
    const parts = this.cells(judgeId, criteria);
    if (parts.length === 0) return prior;
    let numerator = 0;
    let denominator = 0;
    for (const stats of parts) {
      const total = stats?.total ?? 0;
      const agree = stats?.agree ?? 0;
      const estimate = (agree + prior * TRUST_PSEUDO_COUNT) / (total + TRUST_PSEUDO_COUNT);
      const mass = total + TRUST_PSEUDO_COUNT;
      numerator += estimate * mass;
      denominator += mass;
    }
    return denominator === 0 ? prior : numerator / denominator;
  }

  /** Mean evidence mass over the consulted cells — the effective sample
   *  count the lower bound is entitled to (a mean, not a sum: one recorded
   *  observation bumps every cell, and summing would overcount it). */
  private effectiveMass(judgeId: string, criteria: TrustCriteria): number {
    const parts = this.cells(judgeId, criteria);
    if (parts.length === 0) return 0;
    let sum = 0;
    for (const stats of parts) sum += stats?.total ?? 0;
    return sum / parts.length;
  }

  /**
   * TRUST — the Wilson lower bound on the judge's blended agreement rate at
   * its effective evidence mass. An incumbent (prior > 0) counts the prior's
   * pseudo-mass as evidence (an unmeasured teacher is still trusted at the
   * prior's lower bound, ≈ 0.23); a newcomer (prior 0) with no evidence has
   * trust exactly 0.
   */
  trustLB(judgeId: string, criteria: TrustCriteria, prior = TRUST_PRIOR): number {
    const mass = this.effectiveMass(judgeId, criteria) + (prior > 0 ? TRUST_PSEUDO_COUNT : 0);
    if (mass <= 0) return 0;
    return wilsonLowerBound(this.reliability(judgeId, criteria, prior), mass);
  }

  /** The feedback damping weight (the reliability model's contract): full
   *  contribution at/above the prior, a linear fall toward the floor below. */
  weight(judgeId: string, criteria: TrustCriteria, prior = TRUST_PRIOR): number {
    const reliability = this.reliability(judgeId, criteria, prior);
    if (reliability >= prior) return 1;
    return TRUST_MIN_WEIGHT + (1 - TRUST_MIN_WEIGHT) * (reliability / prior);
  }

  /** The full-tuple bucket view (samples/agreements are tuple-exact). */
  evidence(judgeId: string, criteria: TrustCriteria, prior = TRUST_PRIOR): {
    samples: number;
    agreements: number;
    agreementRate: number;
    reliability: number;
    weight: number;
    trustLB: number;
  } {
    const stats = this.judgeStats.get(judgeId)?.buckets.get(trustCriteriaKey(criteria));
    const samples = stats?.total ?? 0;
    const agreements = stats?.agree ?? 0;
    return {
      samples,
      agreements,
      agreementRate: samples === 0 ? 0 : agreements / samples,
      reliability: this.reliability(judgeId, criteria, prior),
      weight: this.weight(judgeId, criteria, prior),
      trustLB: this.trustLB(judgeId, criteria, prior)
    };
  }

  /** Serialize one judge's evidence. */
  judgeSnapshot(judgeId: string): JudgeSnapshot {
    const stats = this.judgeStats.get(judgeId) ?? emptyJudge();
    const toRecord = (map: Map<string, TrustBucketStats>): Record<string, TrustBucketStats> => {
      const record: Record<string, TrustBucketStats> = {};
      for (const [key, value] of map) record[key] = { agree: value.agree, total: value.total };
      return record;
    };
    return {
      buckets: toRecord(stats.buckets),
      byAnswerType: toRecord(stats.byAnswerType),
      byDifficulty: toRecord(stats.byDifficulty),
      byTemplate: toRecord(stats.byTemplate),
      byProvider: toRecord(stats.byProvider)
    };
  }

  /** The judges holding any evidence. */
  judgeIds(): string[] {
    return [...this.judgeStats.keys()];
  }

  /** Restore one judge's evidence (defensive: malformed cells are skipped). */
  restoreJudge(judgeId: string, snapshot: Partial<JudgeSnapshot> | null | undefined): void {
    if (snapshot === null || snapshot === undefined) return;
    const stats = this.judge(judgeId);
    const adopt = (map: Map<string, TrustBucketStats>, record: unknown): void => {
      if (typeof record !== 'object' || record === null) return;
      for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) continue;
        const agree = Number((value as TrustBucketStats).agree);
        const total = Number((value as TrustBucketStats).total);
        if (Number.isFinite(agree) && Number.isFinite(total) && total > 0 && key.length > 0) {
          map.set(key, { agree: Math.max(0, agree), total: Math.max(0, total) });
        }
      }
    };
    adopt(stats.buckets, snapshot.buckets);
    adopt(stats.byAnswerType, snapshot.byAnswerType);
    adopt(stats.byDifficulty, snapshot.byDifficulty);
    adopt(stats.byTemplate, snapshot.byTemplate);
    adopt(stats.byProvider, snapshot.byProvider);
  }

  /** Forget everything (tests, or a re-baseline). */
  reset(): void {
    this.judgeStats.clear();
  }
}

/**
 * THE EMERGENT HANDOVER (the fading controller's replacement): the blend
 * weight of the student's composite against the teacher's grade is
 * normalized trust. Every property the old controller hard-coded is now a
 * consequence: blind student → λ = 0; student that has proven itself →
 * λ climbs exactly as fast as the bound tightens; equally-proven judges →
 * λ* = 0.5; teacher never dismissed (its prior + measured mass keep
 * T_teacher > 0); student regression or reward-hacking → measured agreement
 * falls → λ falls.
 */
export function fusionLambda(kernel: TrustKernel, criteria: TrustCriteria): number {
  const student = kernel.trustLB(JUDGE_COMPOSITE, criteria, 0);
  if (student <= 0) return 0;
  const teacher = Math.max(kernel.trustLB(JUDGE_LLM, criteria, TRUST_PRIOR), FUSION_TEACHER_FLOOR);
  return student / (student + teacher);
}
