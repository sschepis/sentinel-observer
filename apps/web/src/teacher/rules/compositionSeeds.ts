/**
 * COMPOSITION RULES AS A LEARNABLE SEED SET (R4b).
 *
 * The shipped `COMPOSITION_RULES` table is the evergreen seed: sound by
 * construction, always available. New predicate sequences — chains the
 * world accepts — are admitted as learned rules through the same gates
 * `learnedFrames.ts` proved for fixed frames:
 *
 *   - evidence: >= MIN_EVIDENCE observed uses — each observation is one
 *     graded creative answer citing the chain (NOT replay-guarded per
 *     conversation turn; the world's verdicts are the unit of evidence);
 *   - acceptance: the candidate's accepted/uses must match or beat the
 *     SEEDS' own acceptance over the same window (and never fall below the
 *     floor) — a sequence the world keeps rejecting is never admitted;
 *   - cap: the admitted set is bounded; a new rule displaces the weakest
 *     admitted rule only when it is strictly better.
 *
 * The critic gate is inherited by construction: observations only ever come
 * from cited chains the internal critic already backed — a sequence that
 * cannot derive critic-valid claims never produces a cited chain.
 */

import { COMPOSITION_RULES, type CompositionRule } from '../composition';
import type { RelationPredicate } from '../relations';

export const COMPOSITION_ADMISSION_CAP = 12;
export const COMPOSITION_MIN_EVIDENCE = 3;
export const COMPOSITION_ACCEPTANCE_FLOOR = 0.5;

interface Candidate {
  rule: CompositionRule;
  uses: number;
  accepted: number;
  admitted: boolean;
  admittedAt: number;
}

export class CompositionRuleStore {
  private readonly seeds: readonly CompositionRule[];
  private readonly candidates = new Map<string, Candidate>();
  private readonly admittedRules: CompositionRule[] = [];
  private seedUses = 0;
  private seedAccepted = 0;

  constructor(seeds: readonly CompositionRule[] = COMPOSITION_RULES) {
    this.seeds = seeds;
  }

  /** The seeds + everything admitted — what the composer may use. */
  rules(): CompositionRule[] {
    return [...this.seeds, ...this.admittedRules];
  }

  /** Only the ADMITTED sequences (the seeds are already the table). */
  admitted(): CompositionRule[] {
    return [...this.admittedRules];
  }

  /**
   * Observe the world's verdict on a cited chain. Seed sequences feed the
   * acceptance baseline; anything else is a candidate.
   */
  observe(hops: readonly RelationPredicate[], accepted: boolean): void {
    if (hops.length < 2) return;
    if (this.seeds.some((seed) => sequencesEqual(seed.hops, hops))) {
      this.seedUses += 1;
      if (accepted) this.seedAccepted += 1;
      return;
    }
    const key = hops.join('\u0000');
    let candidate = this.candidates.get(key);
    if (candidate === undefined) {
      candidate = {
        rule: { hops: [...hops], conclusion: hops[hops.length - 1] },
        uses: 0,
        accepted: 0,
        admitted: false,
        admittedAt: 0
      };
      this.candidates.set(key, candidate);
    }
    candidate.uses += 1;
    if (accepted) candidate.accepted += 1;
    if (candidate.admitted) return;
    if (candidate.uses < COMPOSITION_MIN_EVIDENCE) return;
    const rate = candidate.accepted / candidate.uses;
    if (rate < this.acceptanceBaseline()) return;
    if (this.admittedRules.length < COMPOSITION_ADMISSION_CAP) {
      this.admit(candidate);
      return;
    }
    // Displace the weakest admitted rule only when strictly better.
    let weakestIndex = -1;
    let weakestRate = 1;
    for (let i = 0; i < this.admittedRules.length; i += 1) {
      const existing = this.candidates.get(this.admittedRules[i].hops.join('\u0000'));
      const existingRate = existing !== undefined ? existing.accepted / existing.uses : 0;
      if (existingRate < weakestRate) {
        weakestRate = existingRate;
        weakestIndex = i;
      }
    }
    if (rate > weakestRate) {
      const displaced = this.admittedRules[weakestIndex];
      const displacedCandidate = this.candidates.get(displaced.hops.join('\u0000'));
      if (displacedCandidate !== undefined) displacedCandidate.admitted = false;
      this.admittedRules.splice(weakestIndex, 1);
      this.admit(candidate);
    }
  }

  /** The seeds' acceptance over the observed window (0 when none). */
  acceptanceBaseline(): number {
    if (this.seedUses === 0) return COMPOSITION_ACCEPTANCE_FLOOR;
    return Math.max(COMPOSITION_ACCEPTANCE_FLOOR, this.seedAccepted / this.seedUses);
  }

  audit(): Array<{ hops: string[]; uses: number; accepted: number; admitted: boolean }> {
    return [...this.candidates.entries()].map(([key, candidate]) => ({
      hops: key.split('\u0000'),
      uses: candidate.uses,
      accepted: candidate.accepted,
      admitted: candidate.admitted
    }));
  }

  private admit(candidate: Candidate): void {
    candidate.admitted = true;
    candidate.admittedAt = this.admittedRules.length;
    this.admittedRules.push(candidate.rule);
  }
}

function sequencesEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
