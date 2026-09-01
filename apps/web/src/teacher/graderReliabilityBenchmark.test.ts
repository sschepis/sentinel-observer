/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  GraderReliabilityModel,
  gradeBandOf,
  bandsAgree,
  type GradeCriteria
} from './reliability';

/**
 * GRADER RELIABILITY BENCHMARK — weighted vs unweighted feedback.
 *
 * The question the reliability model answers: does damping feedback in
 * low-reliability buckets (where the LLM grade frequently disagrees with the
 * rule-based check) leave the observer's learned state closer to the truth
 * than applying every grade fully?
 *
 * The simulation: a grader whose LLM score agrees with the TRUE band with
 * probability p (0.9 in the reliable bucket, 0.35 in the flaky one), a
 * rule-based check (the composition grounding analog) that reflects truth
 * with probability 0.85, and feedback deltas applied to edges per grade
 * (the P8 edge-confidence mechanism). Two arms run over the same seeded
 * turns:
 *
 *   · baseline — every grade applies its full delta (the pre-model behavior)
 *   · weighted — the reliability model records each LLM-vs-rule agreement,
 *     schedules re-grades on disagreement (resolved with the ground truth),
 *     and scales each delta by the bucket's feedback weight
 *
 * Metrics: FEEDBACK ACCURACY = mean |accumulated edge delta − truth| over
 * edges (how close the grade history left the graph), and RETENTION = the
 * fraction of the truth's reinforcement/weakening total each arm actually
 * kept. The weighted arm must not lose to the baseline on either.
 */
const EDGE_COUNT = 4;
const TURNS_PER_BUCKET = 200;
const DELTA = 0.2;

const HIGH_BUCKET: GradeCriteria = {
  answerType: 'creative',
  difficultyBand: 'low',
  template: 'conversational',
  provider: 'reliable-model'
};
const LOW_BUCKET: GradeCriteria = {
  answerType: 'creative',
  difficultyBand: 'high',
  template: 'operator',
  provider: 'flaky-model'
};

/** Deterministic PRNG — a seeded run must reproduce exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimTurn {
  bucket: GradeCriteria;
  edge: number;
  trueBand: 'strong' | 'weak';
  llmBand: 'strong' | 'weak';
  ruleBand: 'strong' | 'weak';
}

function generateTurns(seed: number): SimTurn[] {
  const rng = mulberry32(seed);
  const turns: SimTurn[] = [];
  for (let i = 0; i < 2 * TURNS_PER_BUCKET; i += 1) {
    const bucket = i < TURNS_PER_BUCKET ? HIGH_BUCKET : LOW_BUCKET;
    const llmReliability = i < TURNS_PER_BUCKET ? 0.9 : 0.35;
    const trueBand: 'strong' | 'weak' = rng() < 0.5 ? 'strong' : 'weak';
    // The rule check reflects the truth 85% of the time (like grounding:
    // exact about its own property, imperfect about the grade).
    const ruleBand = rng() < 0.85 ? trueBand : trueBand === 'strong' ? 'weak' : 'strong';
    // The LLM grade reflects the truth only p of the time in this bucket.
    const llmBand = rng() < llmReliability ? trueBand : trueBand === 'strong' ? 'weak' : 'strong';
    turns.push({ bucket, edge: i % EDGE_COUNT, trueBand, llmBand, ruleBand });
  }
  return turns;
}

interface ArmResult {
  edgeError: number[];
  strongApplied: number;
  weakApplied: number;
  reliability: Record<string, number>;
  weight: Record<string, number>;
  regrades: number;
}

function runArm(turns: readonly SimTurn[], weighted: boolean): ArmResult {
  const model = weighted ? new GraderReliabilityModel() : null;
  const edgesTruth = new Array<number>(EDGE_COUNT).fill(0);
  const edgesApplied = new Array<number>(EDGE_COUNT).fill(0);
  const reliability: Record<string, number> = {};
  const weight: Record<string, number> = {};
  let strongApplied = 0;
  let weakApplied = 0;
  let regrades = 0;

  for (const turn of turns) {
    const truthDelta = turn.trueBand === 'strong' ? DELTA : -DELTA;
    edgesTruth[turn.edge] += truthDelta;

    if (model !== null) {
      const agree = bandsAgree(gradeBandOf(turn.llmBand === 'strong' ? 0.8 : 0.2), turn.ruleBand === 'strong' ? 'strong' : 'weak');
      model.recordAgreement(turn.bucket, agree);
      if (!agree) {
        const id = model.scheduleRegrade(turn.bucket, {
          utterance: 'benchmark prompt',
          answer: 'benchmark answer',
          llmScore: turn.llmBand === 'strong' ? 0.8 : 0.2,
          llmBand: turn.llmBand,
          ruleBand: turn.ruleBand,
          reason: 'benchmark disagreement'
        });
        if (id !== '' && turn.edge % 2 === 0) {
          // Half of the scheduled re-grades are resolved with the ground
          // truth — the loop's outcome feeds the same model.
          if (model.resolveRegrade(id, turn.llmBand === turn.trueBand)) regrades += 1;
        }
      }
    }

    const llmDelta = turn.llmBand === 'strong' ? DELTA : -DELTA;
    const applied = model !== null ? llmDelta * model.feedbackWeight(turn.bucket) : llmDelta;
    edgesApplied[turn.edge] += applied;
    if (turn.trueBand === 'strong') strongApplied += applied;
    else weakApplied += applied;
  }

  if (model !== null) {
    reliability[HIGH_BUCKET.provider] = model.reliability(HIGH_BUCKET);
    reliability[LOW_BUCKET.provider] = model.reliability(LOW_BUCKET);
    weight[HIGH_BUCKET.provider] = model.feedbackWeight(HIGH_BUCKET);
    weight[LOW_BUCKET.provider] = model.feedbackWeight(LOW_BUCKET);
  }

  const edgeError = edgesTruth.map((truth, i) => Math.abs(edgesApplied[i] - truth));
  return { edgeError, strongApplied, weakApplied, reliability, weight, regrades };
}

describe('grader reliability benchmark (weighted vs unweighted feedback)', () => {
  it('weighting by bucket reliability beats the unweighted baseline on feedback accuracy and retention', () => {
    const turns = generateTurns(20260831);
    const baseline = runArm(turns, false);
    const weighted = runArm(turns, true);

    const mae = (arm: ArmResult): number =>
      arm.edgeError.reduce((sum, error) => sum + error, 0) / arm.edgeError.length;
    const baselineMae = mae(baseline);
    const weightedMae = mae(weighted);

    // Retention: how much of the truth's reinforcement the arm kept, on
    // true-strong and true-weak turns separately. Closer to 1 = better.
    const strongTruth = turns.filter((t) => t.trueBand === 'strong').length * DELTA;
    const weakTruth = -turns.filter((t) => t.trueBand === 'weak').length * DELTA;
    const baselineStrongRetention = Math.abs(baseline.strongApplied) / Math.max(0.0001, strongTruth);
    const weightedStrongRetention = Math.abs(weighted.strongApplied) / Math.max(0.0001, strongTruth);
    const baselineWeakRetention = Math.abs(baseline.weakApplied) / Math.max(0.0001, Math.abs(weakTruth));
    const weightedWeakRetention = Math.abs(weighted.weakApplied) / Math.max(0.0001, Math.abs(weakTruth));

    // The model must have LEARNED the buckets: the reliable bucket keeps
    // (near-)full weight, the flaky bucket earns distrust. The exact
    // numbers depend on the seeded agreement draw — the gates are the
    // ordering and the MAE comparison below.
    expect(weighted.weight[LOW_BUCKET.provider]).toBeLessThan(1);
    expect(weighted.weight[HIGH_BUCKET.provider]).toBeGreaterThan(0.9);
    expect(weighted.weight[HIGH_BUCKET.provider]).toBeGreaterThan(weighted.weight[LOW_BUCKET.provider]);
    expect(weighted.reliability[HIGH_BUCKET.provider]).toBeGreaterThan(weighted.reliability[LOW_BUCKET.provider]);

    // eslint-disable-next-line no-console
    console.log(`\nBENCH: feedback-accuracy (mean |edge delta − truth|) — baseline ${baselineMae.toFixed(3)} · weighted ${weightedMae.toFixed(3)} (${((weightedMae / Math.max(1e-9, baselineMae) - 1) * 100).toFixed(1)}%)`);
    // eslint-disable-next-line no-console
    console.log(`BENCH: retention (kept/truth) — baseline strong ${baselineStrongRetention.toFixed(3)} weak ${baselineWeakRetention.toFixed(3)} · weighted strong ${weightedStrongRetention.toFixed(3)} weak ${weightedWeakRetention.toFixed(3)}`);
    // eslint-disable-next-line no-console
    console.log(`BENCH: reliability learned — high ${weighted.reliability[HIGH_BUCKET.provider]?.toFixed(3) ?? 'n/a'} (weight ${weighted.weight[HIGH_BUCKET.provider]?.toFixed(2) ?? 'n/a'}) · low ${weighted.reliability[LOW_BUCKET.provider]?.toFixed(3) ?? 'n/a'} (weight ${weighted.weight[LOW_BUCKET.provider]?.toFixed(2) ?? 'n/a'}) · regrades resolved ${weighted.regrades}`);

    // The honest CI gate: weighting must not lose to the baseline.
    expect(weightedMae).toBeLessThanOrEqual(baselineMae);
    expect(Math.abs(weightedStrongRetention - 1)).toBeLessThanOrEqual(Math.abs(baselineStrongRetention - 1) + 0.01);
    expect(Math.abs(weightedWeakRetention - 1)).toBeLessThanOrEqual(Math.abs(baselineWeakRetention - 1) + 0.01);
  });

  it('the reliable bucket stays at (near-)full weight across the run (no false distrust)', () => {
    const turns = generateTurns(7);
    const weighted = runArm(turns, true);
    expect(weighted.weight[HIGH_BUCKET.provider]).toBeGreaterThan(0.9);
    expect(weighted.weight[LOW_BUCKET.provider]).toBeLessThan(weighted.weight[HIGH_BUCKET.provider]);
  });
});
