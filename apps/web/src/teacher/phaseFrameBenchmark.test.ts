/**
 * @jest-environment node
 *
 * PHASE-FRAME-BENCH (improvements.md §4.2 / Phase C.2) — sibling-separation
 * AUC of the phase order parameter, in the RAW frame vs the CO-ROTATING
 * frame, over elapsed time.
 *
 * THE HYPOTHESIS UNDER TEST. The raw phase term compares stored and cue
 * phases directly, so each oscillator's free drift ω_i·Δt dominates the
 * difference ensemble: the term is a moment-PROXIMITY signal (the honest
 * reading in CompactMemoryBank's doc block). The co-rotating frame compares
 * θ_i = φ_i − ω_i·t, which cancels the free drift exactly; whatever remains
 * is the deviation COUPLING produced during the moment — a content signal
 * or nothing.
 *
 * THE CONSTRUCTION. SIBLING traces: two different words mapped to the SAME
 * prime signature (same primes, different content) — the case the current
 * term cannot separate by construction. For each pair, the true match and
 * its sibling are stored via the production teach pipeline and then cued at
 * elapsed sim times spanning the free-run range used by the fuzz benches
 * (0 → 200 s; the cluster bench's free-run is 600 × 0.02 s = 12 s).
 *
 * FOUR ARMS × TIME SWEEP:
 *   · SETTLED pipeline (production: settleField before every store/cue) —
 *     elapsed time cannot enter the phases at all (each settle restarts
 *     them), so both frames must be FLAT in τ here; any separation is the
 *     settle-depth offset, which the co-rotating frame is designed to
 *     remove.
 *   · FREE-RUN pipeline (no settles: the field carries its history) — the
 *     regime where elapsed time genuinely enters the raw term.
 *   × raw frame (default bank) / co-rotating frame (`coRotatingPhases`).
 *
 * VERDICT RULE (§4.2): the co-rotating term passes when it separates
 * siblings with an AUC meaningfully above 0.5, INDEPENDENT of elapsed time.
 * AUC ≈ 0.5 records that the moment carries no content beyond excitation
 * and the term should be dropped (RECORDED here — the term is not deleted).
 * The verdict is reported, not hard-gated: the experiment's own answer is
 * the deliverable. Structural invariants (finite readings, flat settled
 * arm, the frames genuinely differing) ARE asserted.
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { PRIME_SPACE, primeSignature } from './primeSignature';

const PAIRS = Number(process.env.PHASE_FRAME_PAIRS ?? 10);
const SWEEP_SECONDS: readonly number[] = [0, 2, 20, 200];
const FREE_DT = 0.02;
const STORE_DT = 0.02;
const CUE_TICK = 0.02;
const SETTLE_STEPS = 4;
const SETTLE_DT = 0.05;

interface SiblingPair {
  pair: number;
  wordA: string;
  wordB: string;
  traceA: string;
  traceB: string;
}

/** Mann–Whitney AUC: P(a random positive scores above a random negative). */
function auc(positive: readonly number[], negative: readonly number[]): number {
  if (positive.length === 0 || negative.length === 0) return 0.5;
  let rank = 0;
  for (const p of positive) {
    for (const n of negative) {
      if (p > n) rank += 1;
      else if (p === n) rank += 0.5;
    }
  }
  return rank / (positive.length * negative.length);
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}

/** Vocabulary: both words of pair k share one 4-prime signature. */
function siblingVocabulary(): Record<string, number[]> {
  const vocabulary: Record<string, number[]> = Object.create(null) as Record<string, number[]>;
  for (let k = 0; k < PAIRS; k += 1) {
    const signature = primeSignature(`sib-${k}`, PRIME_SPACE);
    vocabulary[`alpha${k}`] = signature;
    vocabulary[`beta${k}`] = signature;
  }
  return vocabulary;
}

interface ArmReading {
  label: string;
  /** per τ: AUC and the mean true/sibling order parameters. */
  sweep: Array<{ tau: number; auc: number; meanTrue: number; meanSibling: number }>;
  /** every individual reading, for the range checks. */
  allTrue: number[];
  allSibling: number[];
  traceCount: number;
}

async function runArm(settled: boolean, coRotating: boolean): Promise<ArmReading> {
  const session = new ObserverSession(
    {
      primeCount: 64,
      gridSize: 128,
      smfWidth: 128,
      memoryMode: 'compact',
      vocabulary: siblingVocabulary(),
      ...(coRotating ? { memoryBankOptions: { coRotatingPhases: true } } : {})
    },
    100
  );
  await session.initialize();

  const pairs: SiblingPair[] = [];
  for (let k = 0; k < PAIRS; k += 1) {
    const wordA = `alpha${k}`;
    const wordB = `beta${k}`;
    if (settled) session.settleField();
    session.observeText(wordA);
    session.observer.tick(STORE_DT);
    const traceA = session.storeMemory(`definition of alpha word ${k}`, {
      metadata: { kind: 'sibling', pair: k, side: 'a' }
    });
    if (settled) session.settleField();
    session.observeText(wordB);
    session.observer.tick(STORE_DT);
    const traceB = session.storeMemory(`definition of beta word ${k}`, {
      metadata: { kind: 'sibling', pair: k, side: 'b' }
    });
    if (traceA === null || traceB === null) {
      throw new Error(`phaseFrameBench: sibling pair ${k} failed to store (traceA=${traceA} traceB=${traceB})`);
    }
    pairs.push({ pair: k, wordA, wordB, traceA: traceA.id, traceB: traceB.id });
  }

  const t0 = session.observer.getState().time;
  const sweep: ArmReading['sweep'] = [];
  const allTrue: number[] = [];
  const allSibling: number[] = [];
  for (const tau of SWEEP_SECONDS) {
    // Burn the observer clock to the target elapsed time since the last
    // sibling store. In the settled arm every probe resets the field, so
    // these ticks only move the clock — the flatness of that arm is exactly
    // what they document. In the free-run arm they genuinely evolve the
    // field, and the phases drift at ω_i for the whole interval.
    while (session.observer.getState().time < t0 + tau) {
      session.observer.tick(FREE_DT);
    }
    const trueR: number[] = [];
    const siblingR: number[] = [];
    for (const row of pairs) {
      if (settled) session.settleField();
      session.observeText(row.wordA);
      session.observer.tick(CUE_TICK);
      for (let step = 0; step < SETTLE_STEPS; step += 1) session.observer.tick(SETTLE_DT);
      const results = session.recall(row.wordA, 1000);
      const scoreById = new Map(results.map((r) => [r.trace.id, r.holographicScore]));
      const rTrue = scoreById.get(row.traceA) ?? 0;
      const rSibling = scoreById.get(row.traceB) ?? 0;
      trueR.push(rTrue);
      siblingR.push(rSibling);
      allTrue.push(rTrue);
      allSibling.push(rSibling);
    }
    sweep.push({ tau, auc: auc(trueR, siblingR), meanTrue: mean(trueR), meanSibling: mean(siblingR) });
  }

  const traceCount = session.observer.getMemoryBank().size;
  session.dispose();
  const label = `${settled ? 'settled' : 'free-run'} ${coRotating ? 'co-rotating' : 'raw'}`;
  return { label, sweep, allTrue, allSibling, traceCount };
}

function report(label: string, value: string): void {
  // eslint-disable-next-line no-console
  console.log(`[phaseFrameBench] ${label.padEnd(42)} ${value}`);
}

describe('phase-frame-bench: sibling-separation AUC vs elapsed time', () => {
  it('measures the order-parameter separation in both frames on both pipelines and records the verdict', async () => {
    const arms = {
      settledRaw: await runArm(true, false),
      settledCo: await runArm(true, true),
      freeRaw: await runArm(false, false),
      freeCo: await runArm(false, true)
    };

    // eslint-disable-next-line no-console
    console.log(
      `\n[phaseFrameBench] PAIRS=${PAIRS} SWEEP=${JSON.stringify(SWEEP_SECONDS)}s (fuzz free-run range: ` +
        `600×0.02 = 12s is inside the sweep)\n`
    );

    for (const arm of [arms.settledRaw, arms.settledCo, arms.freeRaw, arms.freeCo]) {
      for (const row of arm.sweep) {
        report(
          `${arm.label} τ=${String(row.tau).padStart(3)}s`,
          `AUC=${row.auc.toFixed(3)}  R_true=${row.meanTrue.toFixed(4)}  R_sibling=${row.meanSibling.toFixed(4)}`
        );
      }
    }

    // ── Structural invariants (asserted) ───────────────────────────────
    for (const arm of [arms.settledRaw, arms.settledCo, arms.freeRaw, arms.freeCo]) {
      expect(arm.traceCount).toBe(PAIRS * 2);
      for (const r of [...arm.allTrue, ...arm.allSibling]) {
        expect(Number.isFinite(r)).toBe(true);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1);
      }
    }
    // The settled pipeline restarts the phases at every store AND every cue,
    // so elapsed time cannot enter either frame: both arms must be flat in τ
    // (bit-identical readings across the sweep).
    for (const arm of [arms.settledRaw, arms.settledCo]) {
      const spread = Math.max(...arm.sweep.map((s) => s.auc)) - Math.min(...arm.sweep.map((s) => s.auc));
      expect(spread).toBeLessThan(1e-12);
    }
    // The option genuinely changes the production reading (the co-rotating
    // frame removes the settle-depth offset): otherwise the bench is vacuous.
    const raw0 = arms.settledRaw.sweep[0].meanTrue;
    const co0 = arms.settledCo.sweep[0].meanTrue;
    expect(Math.abs(raw0 - co0)).toBeGreaterThan(1e-6);

    // ── The verdict (reported, not hard-gated — the outcome IS the
    //    deliverable; see the test header for the §4.2 rule) ────────────
    const coAcrossTau = [
      ...arms.settledCo.sweep.map((s) => s.auc),
      ...arms.freeCo.sweep.map((s) => s.auc)
    ];
    const rawAcrossTau = [
      ...arms.settledRaw.sweep.map((s) => s.auc),
      ...arms.freeRaw.sweep.map((s) => s.auc)
    ];
    const coMean = mean(coAcrossTau);
    const rawMean = mean(rawAcrossTau);
    const coFlat = Math.max(...coAcrossTau) - Math.min(...coAcrossTau);
    // eslint-disable-next-line no-console
    console.log(
      `\n[phaseFrameBench] VERDICT INPUT mean AUC across τ — raw ${rawMean.toFixed(3)} · ` +
        `co-rotating ${coMean.toFixed(3)} (spread ${coFlat.toFixed(3)})\n`
    );
    if (coMean >= 0.6 && coFlat <= 0.2) {
      report('VERDICT', 'KEEP / RAISE — the co-rotating term separates siblings above chance, flat in elapsed time');
    } else {
      report(
        'VERDICT',
        'DROP (recorded) — AUC ≈ 0.5: the moment carries no content beyond excitation; the phase term is a proximity signal and its weight should go to zero (term kept in code, finding recorded)'
      );
    }
  }, 600000);
});
