/**
 * THE GRADER RELIABILITY MODEL — where the LLM teacher is trusted, and by how much.
 *
 * The teacher grades learner answers in two ways:
 *   · RULE-BASED checks (quiz trace identity in TeacherAgent.grade, the
 *     deterministic verifier for drills, the grounding composition check) —
 *     exact by construction, but narrow: they only measure their own
 *     property (identity, arithmetic truth, echo/fabrication).
 *   · LLM semantic grades (0..1 quality scores over creative/hybrid answers)
 *     — broad, but fallible in ways the app cannot see from a single grade.
 *
 * This module learns WHERE the LLM grade is unreliable. Every grade is
 * bucketed by criteria — answer type, FSRS difficulty band, question
 * template, provider — and every disagreement with a rule-based check (or a
 * later user/world verdict) is evidence. The model produces a reliability
 * estimate per bucket (Bayesian-smoothed over a fallback chain, so a sparse
 * bucket leans on its dimensions and the prior), and a FEEDBACK WEIGHT that
 * damps exactly the low-reliability buckets:
 *
 *     weight = 1               when reliability ≥ prior (evidence never
 *                              earned distrust — contribute fully)
 *     weight → MIN_FEEDBACK_WEIGHT as reliability → 0 (damp, never erase)
 *
 * The weight scales the DELTAS of feedback (edge confidence bumps, trace
 * reinforcement, composition-weight gradients, FSRS state updates) — never
 * the grade's BAND: a damped weak grade must not silently become a strong
 * one by multiplication.
 *
 * Disagreements enter the RE-GRADE LOOP: the model schedules a pending
 * re-grade (cheaper re-check, user confirmation, or deferral) and records
 * the resolution back into the same stats, so the reliability estimate is
 * the accumulated verdict history of the bucket.
 */
import type { GroundingResult } from './grounding';

/** What kind of answer was graded. 'definition' and 'spelling' are the two
 *  quiz directions (recognition expects the definition; production expects
 *  the word); 'creative' is an LLM-graded composition; 'drill' is a
 *  deterministically verifiable exercise. */
export type AnswerType = 'definition' | 'example' | 'spelling' | 'creative' | 'conversation' | 'drill' | 'other';

/** The FSRS scheduler's difficulty in [1, 10], banded. */
export type DifficultyBand = 'low' | 'mid' | 'high';

/** A grade's actionable band — the thresholds the app already acts on
 *  (CREATIVE_REINFORCE_SCORE / CREATIVE_WEAKEN_SCORE). */
export type GradeBand = 'strong' | 'mid' | 'weak';

/** The criteria that bucket a grade. Every dimension is a reliability
 *  signal: answer type (a definition grade is easier than a spelling
 *  grade), difficulty band (hard words strain any grader), question
 *  template (conversational prompts vs operator questions), and provider
 *  (different models disagree at different rates). */
export interface GradeCriteria {
  answerType: AnswerType;
  difficultyBand: DifficultyBand;
  template: string;
  provider: string;
}

/** The LLM's grade band agrees with the rule-based band only when both
 *  sort the answer into the same actionable class. */
export const GRADE_STRONG_THRESHOLD = 0.7;
export const GRADE_WEAK_THRESHOLD = 0.3;

/** Uninformative prior: a grader with no evidence is assumed slightly
 *  better than chance. Estimates below it earn distrust; at or above it,
 *  feedback is applied fully. */
export const PRIOR_RELIABILITY = 0.65;
/** Floor of the feedback weight — a distrusted bucket still learns, but a
 *  single overturned grade can never zero out a pathway. */
export const MIN_FEEDBACK_WEIGHT = 0.1;
/** Pseudo-count of the Bayesian smoothing — the pull of the prior. */
export const PSEUDO_COUNT = 4;
/** A world-feedback sample (a later re-ask or retention) is weaker evidence
 *  than a rule-based check — the world confirms slowly. */
export const WORLD_FEEDBACK_WEIGHT = 0.25;
/** Bounded queues — the model is a bounded learner like every ledger here. */
export const PENDING_REGRADE_CAP = 100;
export const REGRADE_HISTORY_CAP = 200;

/** The difficulty band of an FSRS difficulty in [1, 10]. */
export function difficultyBandOf(difficulty: number): DifficultyBand {
  if (difficulty < 4) return 'low';
  if (difficulty <= 7) return 'mid';
  return 'high';
}

/** The actionable band of a semantic score. */
export function gradeBandOf(score: number): GradeBand {
  if (score >= GRADE_STRONG_THRESHOLD) return 'strong';
  if (score <= GRADE_WEAK_THRESHOLD) return 'weak';
  return 'mid';
}

/** The band the RULE-BASED composition check predicts for an answer: a
 *  fabrication grades weak, an echo of its seeds grades mid (honest, but no
 *  composition happened), a genuinely grounded composition grades strong.
 *  This mirrors the creative gold set's banding (calibration/creativeGold.ts). */
export function ruleBandForGrounding(grounding: GroundingResult): GradeBand {
  if (grounding.isFabrication) return 'weak';
  if (grounding.isEcho) return 'mid';
  return 'strong';
}

/** Whether an LLM band matches a rule-based band. */
export function bandsAgree(llmBand: GradeBand, ruleBand: GradeBand | null): boolean {
  return ruleBand === null || llmBand === ruleBand;
}

/** The stable key of a criteria tuple. */
export function criteriaKey(criteria: GradeCriteria): string {
  return `${criteria.answerType}\u0000${criteria.difficultyBand}\u0000${criteria.template}\u0000${criteria.provider}`;
}

interface BucketStats {
  /** Weighted agreement mass (rule checks count 1, world feedback less). */
  agree: number;
  /** Weighted sample mass. */
  total: number;
}

export interface RegradeDetail {
  utterance: string;
  answer: string;
  llmScore: number;
  llmBand: GradeBand;
  /** The rule-based band that disagreed (null when no check was possible). */
  ruleBand: GradeBand | null;
  reason: string;
}

export interface PendingRegrade {
  id: string;
  criteria: GradeCriteria;
  at: number;
  detail: RegradeDetail;
}

export interface ResolvedRegrade extends PendingRegrade {
  /** True when the re-grade confirmed the LLM grade (the rule check was
   *  the wrong side); false when it overturned it. */
  agreed: boolean;
  resolvedAt: number;
}

/** The queryable view of a bucket — what corroboration/curriculum modules
 *  read before acting on a grade's evidence. */
export interface ReliabilityEvidence {
  samples: number;
  agreements: number;
  agreementRate: number;
  reliability: number;
  weight: number;
}

/** The serializable record of the model (persisted with the learning state). */
export interface ReliabilitySnapshot {
  buckets: Record<string, BucketStats>;
  byAnswerType: Record<string, BucketStats>;
  byDifficulty: Record<string, BucketStats>;
  byTemplate: Record<string, BucketStats>;
  byProvider: Record<string, BucketStats>;
  pending: PendingRegrade[];
  history: ResolvedRegrade[];
}

function bump(stats: BucketStats | undefined, agree: boolean, weight: number): BucketStats {
  const current = stats ?? { agree: 0, total: 0 };
  current.agree += agree ? weight : 0;
  current.total += weight;
  return current;
}

function cloneStats(stats: BucketStats): BucketStats {
  return { agree: stats.agree, total: stats.total };
}

export class GraderReliabilityModel {
  private readonly buckets = new Map<string, BucketStats>();
  private readonly byAnswerType = new Map<string, BucketStats>();
  private readonly byDifficulty = new Map<string, BucketStats>();
  private readonly byTemplate = new Map<string, BucketStats>();
  private readonly byProvider = new Map<string, BucketStats>();
  private readonly pending: PendingRegrade[] = [];
  private readonly history: ResolvedRegrade[] = [];
  private nextRegradeId = 1;

  /** Record whether the LLM grade agreed with a rule-based check (weight 1 —
   *  the sharpest evidence the model gets). */
  recordAgreement(criteria: GradeCriteria, agree: boolean, weight = 1): void {
    this.buckets.set(criteriaKey(criteria), bump(this.buckets.get(criteriaKey(criteria)), agree, weight));
    this.byAnswerType.set(criteria.answerType, bump(this.byAnswerType.get(criteria.answerType), agree, weight));
    this.byDifficulty.set(criteria.difficultyBand, bump(this.byDifficulty.get(criteria.difficultyBand), agree, weight));
    this.byTemplate.set(criteria.template, bump(this.byTemplate.get(criteria.template), agree, weight));
    if (criteria.provider.length > 0) {
      this.byProvider.set(criteria.provider, bump(this.byProvider.get(criteria.provider), agree, weight));
    }
  }

  /** Record whether a later USER/WORLD verdict confirmed the LLM grade — a
   *  re-ask contradicts a strong grade, a retention confirms it. Weaker
   *  evidence than a rule-based check (the world confirms slowly). */
  recordWorldFeedback(criteria: GradeCriteria, agree: boolean, weight = WORLD_FEEDBACK_WEIGHT): void {
    this.recordAgreement(criteria, agree, weight);
  }

  /** Record the outcome of a scheduled re-grade — the resolution feeds the
   *  same stats as every other agreement sample. */
  recordRegrade(criteria: GradeCriteria, agree: boolean, weight = 1): void {
    this.recordAgreement(criteria, agree, weight);
  }

  /**
   * The smoothed reliability estimate of a bucket: a Bayesian posterior per
   * source (full tuple, then each dimension) blended by its sample mass, so
   * a sparse bucket leans on its dimensions and a cold bucket returns the
   * prior. Every estimate is pulled toward the prior by PSEUDO_COUNT.
   */
  reliability(criteria: GradeCriteria): number {
    const parts: Array<BucketStats | undefined> = [
      this.buckets.get(criteriaKey(criteria)),
      this.byAnswerType.get(criteria.answerType),
      this.byDifficulty.get(criteria.difficultyBand),
      this.byTemplate.get(criteria.template)
    ];
    if (criteria.provider.length > 0) parts.push(this.byProvider.get(criteria.provider));

    let numerator = 0;
    let denominator = 0;
    for (const stats of parts) {
      const total = stats?.total ?? 0;
      const agree = stats?.agree ?? 0;
      const estimate = (agree + PRIOR_RELIABILITY * PSEUDO_COUNT) / (total + PSEUDO_COUNT);
      const mass = total + PSEUDO_COUNT;
      numerator += estimate * mass;
      denominator += mass;
    }
    return denominator === 0 ? PRIOR_RELIABILITY : numerator / denominator;
  }

  /**
   * The feedback weight of a bucket: full contribution when measured
   * reliability has never earned distrust (≥ prior), a linear fall toward
   * MIN_FEEDBACK_WEIGHT below it. The weight scales feedback DELTAS, never
   * grade bands.
   */
  feedbackWeight(criteria: GradeCriteria): number {
    const reliability = this.reliability(criteria);
    if (reliability >= PRIOR_RELIABILITY) return 1;
    return MIN_FEEDBACK_WEIGHT + (1 - MIN_FEEDBACK_WEIGHT) * (reliability / PRIOR_RELIABILITY);
  }

  /** The queryable view of a bucket — for the corroboration and curriculum
   *  modules: how many samples, what agreement rate, the reliability, and
   *  the weight they should apply to grade-sourced evidence. */
  evidence(criteria: GradeCriteria): ReliabilityEvidence {
    const samples = this.buckets.get(criteriaKey(criteria))?.total ?? 0;
    const agreements = this.buckets.get(criteriaKey(criteria))?.agree ?? 0;
    const reliability = this.reliability(criteria);
    return {
      samples,
      agreements,
      agreementRate: samples === 0 ? 0 : agreements / samples,
      reliability,
      weight: this.feedbackWeight(criteria)
    };
  }

  /**
   * Schedule a re-grade for a disagreement (c): the LLM grade and the
   * rule-based check disagreed, so the grade's feedback is already applied
   * DAMPED — the resolution below records the outcome and updates the
   * bucket's reliability. Returns the regrade id ('' when the queue is full
   * — the disagreement still counted in the stats, only the follow-up is
   * dropped).
   */
  scheduleRegrade(criteria: GradeCriteria, detail: RegradeDetail): string {
    if (this.pending.length >= PENDING_REGRADE_CAP) return '';
    const id = `rg-${this.nextRegradeId++}`;
    this.pending.push({ id, criteria: { ...criteria }, at: Date.now(), detail });
    return id;
  }

  /** Every disagreement awaiting a re-grade (the UI's confirmation queue). */
  pendingRegrades(): readonly PendingRegrade[] {
    return this.pending.map((regrade) => ({
      id: regrade.id,
      criteria: { ...regrade.criteria },
      at: regrade.at,
      detail: { ...regrade.detail }
    }));
  }

  pendingRegrade(id: string): PendingRegrade | undefined {
    const regrade = this.pending.find((entry) => entry.id === id);
    return regrade === undefined
      ? undefined
      : { id: regrade.id, criteria: { ...regrade.criteria }, at: regrade.at, detail: { ...regrade.detail } };
  }

  /** Resolve a pending re-grade with the verdict on the LLM grade (true =
   *  the re-check confirmed it). The outcome feeds the model, so the next
   *  grade in this bucket is weighted by the corrected evidence.
   *  Returns false when the id is unknown. */
  resolveRegrade(id: string, agreed: boolean): boolean {
    const index = this.pending.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    const [regrade] = this.pending.splice(index, 1);
    this.history.push({ ...regrade, agreed, resolvedAt: Date.now() });
    if (this.history.length > REGRADE_HISTORY_CAP) {
      this.history.splice(0, this.history.length - REGRADE_HISTORY_CAP);
    }
    this.recordRegrade(regrade.criteria, agreed);
    return true;
  }

  /** Defer a pending re-grade — the disagreement stays counted, the
   *  follow-up is dropped. */
  dismissRegrade(id: string): boolean {
    const index = this.pending.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    this.pending.splice(index, 1);
    return true;
  }

  /** The resolved re-grade history (bounded) — the model's audit trail. */
  regradeHistory(): readonly ResolvedRegrade[] {
    return this.history.map((regrade) => ({
      id: regrade.id,
      criteria: { ...regrade.criteria },
      at: regrade.at,
      detail: { ...regrade.detail },
      agreed: regrade.agreed,
      resolvedAt: regrade.resolvedAt
    }));
  }

  /** Serialize for persistence (the learning state rides the same record). */
  snapshot(): ReliabilitySnapshot {
    const toRecord = (map: Map<string, BucketStats>): Record<string, BucketStats> => {
      const record: Record<string, BucketStats> = {};
      for (const [key, stats] of map) record[key] = cloneStats(stats);
      return record;
    };
    return {
      buckets: toRecord(this.buckets),
      byAnswerType: toRecord(this.byAnswerType),
      byDifficulty: toRecord(this.byDifficulty),
      byTemplate: toRecord(this.byTemplate),
      byProvider: toRecord(this.byProvider),
      pending: this.pending.map((regrade) => ({
        id: regrade.id,
        criteria: { ...regrade.criteria },
        at: regrade.at,
        detail: { ...regrade.detail }
      })),
      history: this.history.map((regrade) => ({
        id: regrade.id,
        criteria: { ...regrade.criteria },
        at: regrade.at,
        detail: { ...regrade.detail },
        agreed: regrade.agreed,
        resolvedAt: regrade.resolvedAt
      }))
    };
  }

  /** Restore a persisted snapshot. Malformed or partial records are adopted
   *  defensively (the reliability model is advice, never a schema contract). */
  restore(snapshot: Partial<ReliabilitySnapshot> | null | undefined): void {
    if (snapshot === null || snapshot === undefined) return;
    const adopt = (map: Map<string, BucketStats>, record: unknown): void => {
      if (typeof record !== 'object' || record === null) return;
      for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) continue;
        const agree = Number((value as BucketStats).agree);
        const total = Number((value as BucketStats).total);
        if (Number.isFinite(agree) && Number.isFinite(total) && total > 0 && key.length > 0) {
          map.set(key, { agree: Math.max(0, agree), total: Math.max(0, total) });
        }
      }
    };
    adopt(this.buckets, snapshot.buckets);
    adopt(this.byAnswerType, snapshot.byAnswerType);
    adopt(this.byDifficulty, snapshot.byDifficulty);
    adopt(this.byTemplate, snapshot.byTemplate);
    adopt(this.byProvider, snapshot.byProvider);
    if (Array.isArray(snapshot.pending)) {
      for (const regrade of snapshot.pending.slice(-PENDING_REGRADE_CAP)) {
        if (typeof regrade?.id !== 'string' || typeof regrade?.criteria !== 'object' || regrade.criteria === null) continue;
        this.pending.push({
          id: regrade.id,
          criteria: {
            answerType: (regrade.criteria as GradeCriteria).answerType ?? 'other',
            difficultyBand: (regrade.criteria as GradeCriteria).difficultyBand ?? 'mid',
            template: String((regrade.criteria as GradeCriteria).template ?? ''),
            provider: String((regrade.criteria as GradeCriteria).provider ?? '')
          },
          at: Number(regrade.at) || Date.now(),
          detail: {
            utterance: String(regrade.detail?.utterance ?? ''),
            answer: String(regrade.detail?.answer ?? ''),
            llmScore: Number(regrade.detail?.llmScore) || 0,
            llmBand: (regrade.detail?.llmBand as GradeBand) ?? 'mid',
            ruleBand: (regrade.detail?.ruleBand as GradeBand | null) ?? null,
            reason: String(regrade.detail?.reason ?? '')
          }
        });
      }
    }
    if (Array.isArray(snapshot.history)) {
      for (const regrade of snapshot.history.slice(-REGRADE_HISTORY_CAP)) {
        if (typeof regrade?.id !== 'string' || typeof regrade?.criteria !== 'object' || regrade.criteria === null) continue;
        this.history.push({
          id: regrade.id,
          criteria: {
            answerType: (regrade.criteria as GradeCriteria).answerType ?? 'other',
            difficultyBand: (regrade.criteria as GradeCriteria).difficultyBand ?? 'mid',
            template: String((regrade.criteria as GradeCriteria).template ?? ''),
            provider: String((regrade.criteria as GradeCriteria).provider ?? '')
          },
          at: Number(regrade.at) || Date.now(),
          detail: {
            utterance: String(regrade.detail?.utterance ?? ''),
            answer: String(regrade.detail?.answer ?? ''),
            llmScore: Number(regrade.detail?.llmScore) || 0,
            llmBand: (regrade.detail?.llmBand as GradeBand) ?? 'mid',
            ruleBand: (regrade.detail?.ruleBand as GradeBand | null) ?? null,
            reason: String(regrade.detail?.reason ?? '')
          },
          agreed: regrade.agreed === true,
          resolvedAt: Number(regrade.resolvedAt) || Date.now()
        });
      }
    }
  }

  /** Forget everything (tests, or a re-baseline). */
  reset(): void {
    this.buckets.clear();
    this.byAnswerType.clear();
    this.byDifficulty.clear();
    this.byTemplate.clear();
    this.byProvider.clear();
    this.pending.length = 0;
    this.history.length = 0;
    this.nextRegradeId = 1;
  }
}
