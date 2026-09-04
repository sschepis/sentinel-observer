/**
 * THE CALIBRATION LEDGER (Phase 24.3, W8) + D.4 CALIBRATED THRESHOLDS.
 *
 * The margin-gate incident (CONVERSATION_MIN_MARGIN) proved the pattern:
 * a threshold calibrated on a small curriculum silently rots as the deck
 * scales, and the fix was to MEASURE the live distribution and gate on what
 * it shows. This ledger generalizes the measurement half: the riskiest
 * confidence gates record (score, outcome) pairs as they act, and the
 * benches read quantiles + drift against the hand constants.
 *
 * D.4 (§5.2 row 3) closes the loop the header above promised: the three
 * hand thresholds — recall confidence (CONVERSATION_HIGH_CONFIDENCE = 0.8),
 * hybrid/creative store (CREATIVE_REINFORCE_SCORE = 0.7), and creative
 * unlock (CREATIVE_UNLOCK_THRESHOLD = 0.8) — are replaced by calibrated
 * P(correct | score) from isotonic regression over (score, outcome) samples
 * (the ledger's own shape, or a bounded synthetic set built from graded
 * outcomes). A gate ACTS when the fitted P(correct) exceeds the decision
 * threshold
 *
 *     τ = cost(wrong) / (cost(wrong) + cost(abstain))
 *
 * The costs are VALUES (§5.1): a wrong answer costs 1, an abstention costs
 * 0.25 — the author's judgment, never fitted. Every calibrated gate is
 * behind a flag that defaults OFF: the hand constant is the CONTROL, and a
 * gate switches to its fitted score only after the calibration bench shows
 * the heavy gates hold (D.10: each gate's evidence must carry a programmatic
 * bench — the fuzz distractors are generated mechanically, teacher-free).
 */

export interface CalibrationSample {
  score: number;
  positive: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// VALUES — the decision costs (§5.1: judgments the data cannot make)
// ────────────────────────────────────────────────────────────────────────────

/** The cost of a WRONG answer (a fabricated/incorrect confident claim). */
export const WRONG_ANSWER_COST = 1;
/** The cost of ABSTAINING (asking instead of answering — honest, but the
 *  observer learns nothing from its own memory this turn). */
export const ABSTAIN_COST = 0.25;
/** Act when P(correct | score) exceeds this. With the costs above:
 *  1 / (1 + 0.25) = 0.8 — exactly the hand constants the gates replace,
 *  which is the point: the constants already encode the same decision rule;
 *  calibration moves the SCORE at which that rule fires. */
export const DECISION_THRESHOLD = WRONG_ANSWER_COST / (WRONG_ANSWER_COST + ABSTAIN_COST);

// ────────────────────────────────────────────────────────────────────────────
// D.4 — calibrated gates (isotonic P(correct | score) → decision score)
// ────────────────────────────────────────────────────────────────────────────

/** The three calibrated gates of §5.2 row 3. */
export type CalibratedGateName =
  | 'conversation-high-confidence'
  | 'creative-reinforce'
  | 'creative-unlock';

/** Each gate's hand constant — the CONTROL the flag defaults to. */
export const CALIBRATED_GATE_CONSTANTS: Record<CalibratedGateName, number> = {
  'conversation-high-confidence': 0.8,
  'creative-reinforce': 0.7,
  'creative-unlock': 0.8
};

/** Per-gate enable flags — ALL OFF by default (the constant is the control;
 *  a gate flips on only behind its calibration bench, and a lost probe
 *  flips it back). */
export const CALIBRATED_GATE_FLAGS: Record<CalibratedGateName, boolean> = {
  'conversation-high-confidence': false,
  'creative-reinforce': false,
  'creative-unlock': false
};

/** The fitted decision score per gate (null = not calibrated). Only read
 *  while the gate's flag is on. */
export const CALIBRATED_GATE_SCORES: Record<CalibratedGateName, number | null> = {
  'conversation-high-confidence': null,
  'creative-reinforce': null,
  'creative-unlock': null
};

/** Enable/disable one calibrated gate and set its fitted decision score.
 *  `score` null = the gate keeps the constant even when enabled. */
export function setCalibratedGate(gate: CalibratedGateName, enabled: boolean, score: number | null): void {
  CALIBRATED_GATE_FLAGS[gate] = enabled;
  CALIBRATED_GATE_SCORES[gate] = score;
}

/** Reset every gate behind its flag (the constants report's control state). */
export function resetCalibratedGates(): void {
  for (const gate of Object.keys(CALIBRATED_GATE_FLAGS) as CalibratedGateName[]) {
    setCalibratedGate(gate, false, null);
  }
}

/** The score a gate acts on RIGHT NOW: the fitted decision score when the
 *  gate is calibrated AND enabled, else the hand constant (the control). */
export function calibratedGateScore(gate: CalibratedGateName, fallback: number): number {
  const fitted = CALIBRATED_GATE_SCORES[gate];
  if (CALIBRATED_GATE_FLAGS[gate] && fitted !== null && Number.isFinite(fitted)) return fitted;
  return fallback;
}

// ────────────────────────────────────────────────────────────────────────────
// Isotonic regression (PAV) — the P(correct | score) fit of §5.2
// ────────────────────────────────────────────────────────────────────────────

export interface IsotonicCalibration {
  /** Breakpoints of the fitted step function, sorted ascending by score. */
  points: Array<{ score: number; p: number; mass: number }>;
  /** P(correct | score) under the fit: the pooled rate of the block the
   *  score falls into (last block below the score — left-continuous). */
  predict(score: number): number;
  /** The sample mass the fit consumed. */
  mass: number;
}

/**
 * Pool-Adjacent-Violators isotonic regression over (score, outcome) samples.
 * Returns a monotone non-decreasing step function P(correct | score).
 * Ties pool by score; empty sample sets fit P = 0 (no evidence, never act).
 */
export function fitIsotonicCalibration(samples: readonly CalibrationSample[]): IsotonicCalibration {
  if (samples.length === 0) {
    return { points: [], predict: () => 0, mass: 0 };
  }
  const byScore = new Map<number, { positives: number; count: number }>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.score)) continue;
    const bucket = byScore.get(sample.score) ?? { positives: 0, count: 0 };
    bucket.count += 1;
    if (sample.positive) bucket.positives += 1;
    byScore.set(sample.score, bucket);
  }
  const sorted = [...byScore.entries()].sort((a, b) => a[0] - b[0]);
  // PAV blocks: { score, p, mass } — merge a block into the previous one
  // while the pooled rate violates monotonicity.
  const blocks: Array<{ score: number; p: number; mass: number }> = [];
  for (const [score, bucket] of sorted) {
    blocks.push({ score, p: bucket.positives / bucket.count, mass: bucket.count });
    while (blocks.length > 1 && blocks[blocks.length - 1].p < blocks[blocks.length - 2].p) {
      const upper = blocks.pop()!;
      const lower = blocks[blocks.length - 1];
      lower.p = (lower.p * lower.mass + upper.p * upper.mass) / (lower.mass + upper.mass);
      lower.mass += upper.mass;
    }
  }
  const mass = blocks.reduce((sum, block) => sum + block.mass, 0);
  const predict = (score: number): number => {
    if (blocks.length === 0) return 0;
    if (score < blocks[0].score) return blocks[0].p;
    let result = blocks[0].p;
    for (const block of blocks) {
      if (score >= block.score) result = block.p;
      else break;
    }
    return result;
  };
  return { points: blocks, predict, mass };
}

export interface CalibratedDecision {
  /** The fitted score at or above which P(correct) ≥ τ (null when the curve
   *  never reaches τ — no score is safe to act on). */
  score: number | null;
  /** P(correct) at the returned score. */
  p: number | null;
  /** Sample mass behind the fit. */
  mass: number;
}

/**
 * The decision score of §5.2 row 3: the smallest score whose fitted
 * P(correct | score) reaches the decision threshold τ. Act on `score ≥`
 * this value. Uses the left-continuous step fit: the gate fires at the
 * block whose pooled rate first clears τ.
 */
export function calibratedDecisionScore(
  samples: readonly CalibrationSample[],
  tau: number = DECISION_THRESHOLD
): CalibratedDecision {
  const fit = fitIsotonicCalibration(samples);
  for (const block of fit.points) {
    if (block.p >= tau) return { score: block.score, p: block.p, mass: fit.mass };
  }
  return { score: null, p: null, mass: fit.mass };
}

/** Whether a score clears a decision boundary with a small epsilon (so a
 *  fitted boundary value itself clears it). */
export function clearsCalibratedGate(score: number, boundary: number): boolean {
  return score >= boundary - 1e-9;
}

// ────────────────────────────────────────────────────────────────────────────
// Calibration error — expected vs observed correctness in score bins (§5.5)
// ────────────────────────────────────────────────────────────────────────────

export interface CalibrationErrorReport {
  /** Mass-weighted mean |expected − observed| over score bins. */
  error: number;
  /** Per-bin rows (expected rate vs observed rate and mass). */
  bins: Array<{ min: number; max: number; expected: number; observed: number; mass: number }>;
  /** Total sample mass measured. */
  mass: number;
}

/**
 * Expected-vs-observed calibration error over score bins. `expected` is the
 * predictor's P(correct) for the bin (the hand step function for the control
 * arm, the isotonic fit for the calibrated arm); `observed` is the bin's
 * actual positive rate. Empty input → error 0 (nothing to be wrong about).
 */
export function binnedCalibrationError(
  samples: readonly CalibrationSample[],
  predict: (score: number) => number,
  binCount = 10
): CalibrationErrorReport {
  const usable = samples.filter((sample) => Number.isFinite(sample.score));
  if (usable.length === 0) return { error: 0, bins: [], mass: 0 };
  const min = Math.min(...usable.map((sample) => sample.score));
  const max = Math.max(...usable.map((sample) => sample.score));
  const width = max - min > 0 ? (max - min) / binCount : 1;
  const bins: Array<{ min: number; max: number; expected: number; observed: number; mass: number }> = [];
  let weightedError = 0;
  for (let b = 0; b < binCount; b += 1) {
    const binMin = min + b * width;
    const binMax = b === binCount - 1 ? max + 1e-9 : min + (b + 1) * width;
    let expectedSum = 0;
    let positives = 0;
    let count = 0;
    for (const sample of usable) {
      if (sample.score < binMin || sample.score > binMax) continue;
      expectedSum += predict(sample.score);
      if (sample.positive) positives += 1;
      count += 1;
    }
    if (count === 0) continue;
    const expected = expectedSum / count;
    const observed = positives / count;
    weightedError += count * Math.abs(expected - observed);
    bins.push({ min: binMin, max: binMax, expected, observed, mass: count });
  }
  const mass = bins.reduce((sum, bin) => sum + bin.mass, 0);
  return { error: mass > 0 ? weightedError / mass : 0, bins, mass };
}

/** The CONTROL predictor: the hand constant as a step function. */
export function handThresholdPredictor(constant: number): (score: number) => number {
  return (score) => (score >= constant ? 1 : 0);
}

export interface CalibrationReport {
  gate: string;
  samples: number;
  positives: number;
  positiveRate: number;
  /** Score quantiles over ALL samples. */
  p10: number | null;
  p50: number | null;
  p90: number | null;
  /** The measured separator: the midpoint between the positive class's
   *  lower quartile and the negative class's upper quartile (null until
   *  both classes have samples) — the quantity a hand threshold claims
   *  to approximate. */
  separator: number | null;
}

const GATE_SAMPLE_CAP = 500;

function quantileOf(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[index];
}

export class CalibrationLedger {
  private readonly gates = new Map<string, CalibrationSample[]>();

  /** Record one gate decision's evidence (bounded FIFO per gate). */
  record(gate: string, score: number, positive: boolean): void {
    if (!Number.isFinite(score)) return;
    const samples = this.gates.get(gate) ?? [];
    samples.push({ score, positive });
    if (samples.length > GATE_SAMPLE_CAP) samples.splice(0, samples.length - GATE_SAMPLE_CAP);
    this.gates.set(gate, samples);
  }

  /** The score quantile over a gate's samples (null when unmeasured). */
  quantile(gate: string, q: number): number | null {
    const samples = this.gates.get(gate);
    if (samples === undefined || samples.length === 0) return null;
    const sorted = samples.map((s) => s.score).sort((a, b) => a - b);
    return quantileOf(sorted, q);
  }

  /** The drift report of one gate. */
  report(gate: string): CalibrationReport {
    const samples = this.gates.get(gate) ?? [];
    const sorted = samples.map((s) => s.score).sort((a, b) => a - b);
    const positives = samples.filter((s) => s.positive);
    const negatives = samples.filter((s) => !s.positive);
    const positiveScores = positives.map((s) => s.score).sort((a, b) => a - b);
    const negativeScores = negatives.map((s) => s.score).sort((a, b) => a - b);
    const posLower = quantileOf(positiveScores, 0.25);
    const negUpper = quantileOf(negativeScores, 0.75);
    return {
      gate,
      samples: samples.length,
      positives: positives.length,
      positiveRate: samples.length === 0 ? 0 : positives.length / samples.length,
      p10: quantileOf(sorted, 0.1),
      p50: quantileOf(sorted, 0.5),
      p90: quantileOf(sorted, 0.9),
      separator: posLower !== null && negUpper !== null ? (posLower + negUpper) / 2 : null
    };
  }

  /** Every measured gate. */
  gateNames(): string[] {
    return [...this.gates.keys()];
  }

  /** Serialize (rides the learning state, additive). */
  snapshot(): Record<string, CalibrationSample[]> {
    const record: Record<string, CalibrationSample[]> = {};
    for (const [gate, samples] of this.gates) record[gate] = samples.map((s) => ({ ...s }));
    return record;
  }

  restore(snapshot: unknown): void {
    if (typeof snapshot !== 'object' || snapshot === null) return;
    for (const [gate, samples] of Object.entries(snapshot as Record<string, unknown>)) {
      if (!Array.isArray(samples)) continue;
      for (const sample of samples.slice(-GATE_SAMPLE_CAP)) {
        const score = Number((sample as CalibrationSample)?.score);
        const positive = (sample as CalibrationSample)?.positive === true;
        if (Number.isFinite(score)) this.record(gate, score, positive);
      }
    }
  }
}
