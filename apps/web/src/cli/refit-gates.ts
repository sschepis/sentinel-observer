#!/usr/bin/env node
/**
 * REFIT GATES — TASKS.md #10. Re-fit the conversation confidence gates from
 * data, on the live observer's own record, with a held-out split.
 *
 * WHY: the hand constants (recall floor 0.6, high-confidence bar 0.8) were
 * tuned on the BLENDED recall score. The index-only readout
 * (OBSERVER_SMF_WEIGHT=0, docs/NULL_ARMS.md) lifts every score, so the
 * constants no longer sit where the data puts the decision. This tool fits
 * them the way the D.4 calibration bench fits its gates — isotonic
 * P(correct | score) → the smallest score whose fitted P(correct) reaches
 * the decision threshold — but on the real record, under whatever readout
 * arm the environment selects, and evaluated on pairs the fit never saw.
 *
 * WHAT IT DOES (read-only: the record file is only read, the observer lives
 * and dies in this process, the server is untouched):
 *   1. imports the exported record (default apps/web/public/bootstrap.json)
 *      into a fresh observer built exactly as the server builds it —
 *      OBSERVER_OPTIONS plus the OBSERVER_SMF_WEIGHT / OBSERVER_COUPLING hook;
 *   2. splits the taught conversation pairs into a FIT half and a HELD-OUT
 *      half by a seeded shuffle;
 *   3. on each pair: the exact cue is a positive sample at its recall
 *      confidence; one seeded LEGITIMATE VARIANT the chat identity gate
 *      accepts ("… please", "hey …") is a positive too; three seeded
 *      last-word distractors are negative samples (distractors that are
 *      themselves taught cues, or that the identity gate would accept, are
 *      skipped — as in calibration-bench);
 *   4. fits isotonic P(correct | score) on the FIT samples and reads two
 *      decision scores: the high-confidence bar at τ = 0.8 (cost(wrong) /
 *      (cost(wrong) + cost(abstain))) and the recall floor at τ = 0.5;
 *   5. on the HELD-OUT samples reports calibration error for the hand
 *      constants vs the fit, and the true-positive / false-positive rates
 *      of each gate at its hand constant vs its fitted score;
 *   6. writes bench/calibration/conversation-gates-<arm>.json in the shape
 *      the server loads at boot (OBSERVER_GATES_FILE) — a CalibratedGatesArtifact.
 *
 * The fitted scores are NOT applied anywhere by this tool. Applying them is
 * the operator's decision: point the server at the artifact.
 *
 *   npm run refit-gates                                    # control arm
 *   OBSERVER_SMF_WEIGHT=0 npm run refit-gates              # index-only arm
 *   REFIT_RECORD=public/bootstrap.json REFIT_PAIRS=300 REFIT_SEED=7 npm run refit-gates
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32 } from '@sschepis/sentient-core';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import {
  binnedCalibrationError,
  calibratedDecisionScore,
  CALIBRATED_GATE_CONSTANTS,
  DECISION_THRESHOLD,
  FLOOR_DECISION_THRESHOLD,
  fitIsotonicCalibration,
  handThresholdPredictor,
  type CalibratedGateName,
  type CalibratedGatesArtifact,
  type CalibrationSample
} from '../teacher/calibration';
import type { BootstrapRecord } from '../teacher/bootstrap';

const RECORD_PATH = process.env.REFIT_RECORD ?? 'public/bootstrap.json';
const PAIRS = Math.max(20, Number(process.env.REFIT_PAIRS ?? 300));
const SEED = Number(process.env.REFIT_SEED ?? 0x5eed);
const DISTRACTORS_PER_PAIR = 3;

const armLabel = (): string => {
  const smf = process.env.OBSERVER_SMF_WEIGHT;
  const coupling = process.env.OBSERVER_COUPLING;
  const parts: string[] = [];
  if (smf !== undefined) parts.push(Number(smf) === 0 ? 'smf-off' : `smf-${smf}`);
  if (coupling !== undefined) parts.push(Number(coupling) === 0 ? 'coupling-0' : `coupling-${coupling}`);
  return parts.length === 0 ? 'control' : parts.join('+');
};

function commitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

/** The chat identity gate's acceptance rule (agent/support.ts matchesCue):
 *  a distractor the chat would treat as the taught cue is not a negative. */
function identityApproved(distractor: string, cues: readonly string[]): boolean {
  return cues.some((cue) => cue.length > 0 && distractor.includes(cue) && distractor.length - cue.length <= 8);
}

/** A sample with the probe class it came from — the fit sees only
 *  (score, positive); the report breaks rates out per class, because the
 *  decision the gates make is different for each: exact cues MUST be
 *  spoken, legitimate variants SHOULD be, distractors must NOT. */
interface ClassedSample extends CalibrationSample {
  cls: 'exact' | 'variant' | 'distractor';
}

/**
 * LEGITIMATE VARIANTS of a taught cue — phrasings the chat identity gate
 * (agent/support.ts matchesCue: the question contains the cue with at most
 * 8 extra characters) accepts as the same exchange. Without this class the
 * fit sees only exact cues (score 1.0 under index-only scoring) against
 * distractors, and pushes both gates to 1.0 — a knife-edge that would refuse
 * every variant a person actually says. The variants are positives: speaking
 * the taught response to them is correct.
 */
const VARIANT_SHAPES: ReadonlyArray<(cue: string) => string> = [
  (cue) => `${cue} please`,
  (cue) => `${cue} today`,
  (cue) => `hey ${cue}`,
  (cue) => `so ${cue}`
];

interface GateEval {
  gate: CalibratedGateName;
  tau: number;
  hand: number;
  fitted: number | null;
  fittedP: number | null;
  heldOut: {
    hand: ClassRates;
    fitted: ClassRates | null;
  };
}

/** Per-class pass rates at a gate: the share of each probe class whose
 *  score clears the boundary. exact/variant are true-positive rates,
 *  distractor is the false-positive rate. */
interface ClassRates {
  exact: number;
  variant: number;
  distractor: number;
}

function rates(samples: readonly ClassedSample[], boundary: number): ClassRates {
  const rate = (cls: ClassedSample['cls']): number => {
    const pool = samples.filter((s) => s.cls === cls);
    return pool.length > 0 ? pool.filter((s) => s.score >= boundary).length / pool.length : 0;
  };
  return { exact: rate('exact'), variant: rate('variant'), distractor: rate('distractor') };
}

async function main(): Promise<void> {
  const arm = armLabel();
  console.log(`\n=== refit-gates (TASKS.md #10) — record ${RECORD_PATH}, arm ${arm}, ${PAIRS} pairs, seed ${SEED} ===`);
  console.log(`decision thresholds: high-confidence τ = ${DECISION_THRESHOLD}, recall floor τ = ${FLOOR_DECISION_THRESHOLD}\n`);

  const session = new ObserverSession(OBSERVER_OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, ACTIVE_DECK);
  const started = Date.now();
  const record = JSON.parse(readFileSync(RECORD_PATH, 'utf8')) as BootstrapRecord;
  const imported = teacher.importBootstrap(record);
  console.log(`imported ${imported.restored} traces, ${imported.conversations} conversation pairs in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  // Seeded, arm-independent split: the same pairs land in FIT / HELD-OUT
  // whichever arm the environment selects, so arms are compared like for like.
  const rng = mulberry32(SEED);
  const pairs = [...teacher.listConversationPairs()];
  for (let i = pairs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  const probed = pairs.slice(0, Math.min(PAIRS, pairs.length));
  const half = Math.floor(probed.length / 2);
  const fitPairs = probed.slice(0, half);
  const heldOutPairs = probed.slice(half);
  const allCues = pairs.map((pair) => pair.cue.trim().toLowerCase());
  const fillers = ACTIVE_DECK.map((entry) => entry.word);

  let done = 0;
  const collect = (subset: readonly { cue: string; response: string }[], label: string): ClassedSample[] => {
    const samples: ClassedSample[] = [];
    for (const pair of subset) {
      const cue = pair.cue.trim().toLowerCase();
      const exact = teacher.respond(cue);
      // A missed exact cue is still a positive — at score 0. Dropping it
      // would flatter every gate.
      samples.push({ score: exact.confidence ?? 0, positive: true, cls: 'exact' });
      // One seeded legitimate variant per pair (a positive the identity gate
      // accepts); skipped when the variant collides with another taught cue.
      const shape = VARIANT_SHAPES[Math.floor(rng() * VARIANT_SHAPES.length)] ?? VARIANT_SHAPES[0];
      const variant = shape(cue);
      if (!allCues.includes(variant) && identityApproved(variant, [cue])) {
        const hit = teacher.respond(variant);
        samples.push({ score: hit.confidence ?? 0, positive: true, cls: 'variant' });
      }
      const words = cue.split(' ');
      if (words.length >= 2) {
        for (let d = 0; d < DISTRACTORS_PER_PAIR; d += 1) {
          const filler = fillers[Math.floor(rng() * fillers.length)] ?? 'sky';
          const distractor = [...words.slice(0, -1), filler].join(' ');
          if (distractor === cue || allCues.includes(distractor) || identityApproved(distractor, allCues)) continue;
          const hit = teacher.respond(distractor);
          samples.push({ score: hit.confidence ?? 0, positive: false, cls: 'distractor' });
        }
      }
      done += 1;
      if (done % 50 === 0) console.log(`  … ${label}: ${done}/${probed.length} pairs probed`);
    }
    return samples;
  };

  console.log(`probing ${probed.length} pairs (exact + variant + ${DISTRACTORS_PER_PAIR} distractors each; ≈ 0.5 s per probe on a 21k record)…`);
  const fitSamples = collect(fitPairs, 'fit');
  const heldOutSamples = collect(heldOutPairs, 'held-out');
  session.dispose();

  const fit = fitIsotonicCalibration(fitSamples);
  const evals: GateEval[] = [];
  const gatesOut: CalibratedGatesArtifact['gates'] = {};
  const plan: Array<{ gate: CalibratedGateName; tau: number }> = [
    { gate: 'conversation-high-confidence', tau: DECISION_THRESHOLD },
    { gate: 'conversation-recall-floor', tau: FLOOR_DECISION_THRESHOLD }
  ];
  for (const { gate, tau } of plan) {
    const hand = CALIBRATED_GATE_CONSTANTS[gate];
    const decision = calibratedDecisionScore(fitSamples, tau);
    evals.push({
      gate,
      tau,
      hand,
      fitted: decision.score,
      fittedP: decision.p,
      heldOut: {
        hand: rates(heldOutSamples, hand),
        fitted: decision.score === null ? null : rates(heldOutSamples, decision.score)
      }
    });
    gatesOut[gate] = { enabled: decision.score !== null, score: decision.score };
  }

  const before = binnedCalibrationError(heldOutSamples, handThresholdPredictor(CALIBRATED_GATE_CONSTANTS['conversation-high-confidence'])).error;
  const after = binnedCalibrationError(heldOutSamples, fit.predict).error;

  const count = (pool: readonly ClassedSample[], cls: ClassedSample['cls']): number => pool.filter((s) => s.cls === cls).length;
  console.log(
    `samples: fit ${fitSamples.length} (exact ${count(fitSamples, 'exact')}, variant ${count(fitSamples, 'variant')}, distractor ${count(fitSamples, 'distractor')})` +
      ` · held-out ${heldOutSamples.length} (exact ${count(heldOutSamples, 'exact')}, variant ${count(heldOutSamples, 'variant')}, distractor ${count(heldOutSamples, 'distractor')})`
  );
  console.log(`HELD-OUT calibration error: hand constant ${before.toFixed(3)} → isotonic fit ${after.toFixed(3)} (${after <= before ? 'FALLS' : 'RISES'})`);
  console.log('P(correct | score) fit (score → p, mass) — blocks of mass ≥ 3 shown, singletons folded:');
  let folded = 0;
  for (const block of fit.points) {
    if (block.mass >= 3) console.log(`  ${block.score.toFixed(3)} → ${block.p.toFixed(3)}  (${block.mass})`);
    else folded += block.mass;
  }
  if (folded > 0) console.log(`  (+ ${folded} samples in blocks of mass < 3)`);
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  console.log('\nGATES (held-out pass rates per probe class — exact and variant should be high, distractor low):');
  for (const e of evals) {
    const fittedText = e.fitted === null ? 'none (curve never reaches τ)' : `${e.fitted.toFixed(3)} (p ${e.fittedP?.toFixed(3)})`;
    console.log(`  ${e.gate.padEnd(30)} τ ${e.tau}  hand ${e.hand.toFixed(2)} → fitted ${fittedText}`);
    console.log(`    hand:   exact ${pct(e.heldOut.hand.exact)}  variant ${pct(e.heldOut.hand.variant)}  distractor ${pct(e.heldOut.hand.distractor)}`);
    if (e.heldOut.fitted !== null) {
      console.log(`    fitted: exact ${pct(e.heldOut.fitted.exact)}  variant ${pct(e.heldOut.fitted.variant)}  distractor ${pct(e.heldOut.fitted.distractor)}`);
    }
  }

  const artifact: CalibratedGatesArtifact & { record: string; seed: number; pairs: number; heldOut: object; fit: object } = {
    commit: commitHash(),
    generatedAt: new Date().toISOString(),
    arm,
    record: RECORD_PATH,
    seed: SEED,
    pairs: probed.length,
    heldOut: { calibrationErrorHand: before, calibrationErrorFit: after, evals },
    fit: { points: fit.points, mass: fit.mass },
    gates: gatesOut
  };
  const outDir = join(process.cwd(), '..', '..', 'bench', 'calibration');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `conversation-gates-${arm}.json`);
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`\nwrote ${outPath}`);
  console.log('to run the server on these gates:  OBSERVER_GATES_FILE=' + join('..', '..', 'bench', 'calibration', `conversation-gates-${arm}.json`) + (arm === 'smf-off' ? ' OBSERVER_SMF_WEIGHT=0' : '') + ' npm run server');
}

main().catch((error) => {
  console.error('refit-gates failed:', error);
  process.exitCode = 1;
});
