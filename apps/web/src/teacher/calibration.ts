/**
 * THE CALIBRATION LEDGER (Phase 24.3, W8 — READ-ONLY in this round).
 *
 * The margin-gate incident (CONVERSATION_MIN_MARGIN) proved the pattern:
 * a threshold calibrated on a small curriculum silently rots as the deck
 * scales, and the fix was to MEASURE the live distribution and gate on what
 * it shows. This ledger generalizes the measurement half: the riskiest
 * confidence gates record (score, outcome) pairs as they act, and the
 * benches read quantiles + drift against the hand constants. NOTHING
 * CONSUMES IT FOR GATING YET — the gates switch to measured quantiles only
 * in a follow-up, after the drift reports confirm the need (the same
 * bench-first discipline every other constant went through).
 */

export interface CalibrationSample {
  score: number;
  positive: boolean;
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
