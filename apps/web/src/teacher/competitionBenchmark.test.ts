/**
 * @jest-environment node
 */
/**
 * P12 COMPETITION BENCHMARK — three independent competition mechanisms in the
 * oscillator field, each measured against the SAME honest control (all
 * competition off, which is bit-identical to the shipped engine).
 *
 * THE DIAGNOSIS UNDER TEST. Purely positive Kuramoto coupling pulls every
 * oscillator toward every other one, so the field's stable state is one
 * global mode: the sketch corpus mean carries ~75% of a typical trace's
 * magnitude, unrelated traces sit at ~0.30 cosine, and the discriminating
 * signal lives in a small residual on a shared component. The hypothesis is
 * that COMPETITION — a fixed excitation budget, inhibition between
 * non-co-excited primes, or a hard k-winner filter — lets the field hold
 * decorrelated structured states instead.
 *
 * SIX MEASUREMENTS per arm (see competitionMetrics.ts):
 *   1. sketch DC ratio ‖corpus mean‖ / mean‖sketch‖
 *   2. mean pairwise cosine between unrelated traces, raw and centered
 *   3. mean prime-set Jaccard between unrelated traces (structural+effective)
 *   4. retrieval margin over the taught conversation cues
 *   5. conversation competency and in-session word recognition
 *   6. THE FALSIFIER: `centerSketches` re-run under the winning variant
 *
 * This is a MEASUREMENT, not a gate. The only assertions are that the
 * control reproduces and that every arm stays finite and well-formed; the
 * verdicts live in docs/SCALING.md, justified by the printed numbers.
 */
import { describe, it, expect } from '@jest/globals';
import type { SemanticObserverOptions, TraceLike } from '@sschepis/sentient-core';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from './TeacherAgent';
import { ACTIVE_DECK } from './decks';
import { ALL_CONVERSATION_PAIRS } from './conversation';
import { MemoryPersistenceStore } from '../persistence/store';
import {
  retrievalMargin,
  sketchDcRatio,
  tracesByKind,
  unrelatedPairwiseCosine,
  unrelatedPrimeJaccard,
  type MarginProbe,
  type PairwiseCosineReading,
  type PrimeSetReading,
  type RetrievalMarginReading
} from './competitionMetrics';

const WORDS = Number(process.env.COMPETITION_BENCH_WORDS ?? 200);
const PAIRS = Number(process.env.COMPETITION_BENCH_PAIRS ?? ALL_CONVERSATION_PAIRS.length);
const MARGIN_CUES = Number(process.env.COMPETITION_BENCH_CUES ?? 200);
/** Arms to run; empty = all. Lets one variant be re-measured cheaply. */
const ONLY = (process.env.COMPETITION_BENCH_ARMS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** The teacher's own cue path (TeacherAgent.exciteAndSettle), reproduced. */
const SETTLE_DT = 0.05;
const SETTLE_STEPS = 4;

interface Arm {
  name: string;
  /** What the arm changes relative to the control, for the report. */
  note: string;
  options: Partial<SemanticObserverOptions>;
}

/**
 * THE ARMS. The control is literally the shipped production config: every
 * competition knob defaults to 0, and at 0 the field evolves bit-identically
 * to the engine before this experiment (asserted in the core unit tests).
 *
 * Budgets: the control's settled field carries ~1.5-2.5 total amplitude on a
 * 4-prime cue, so 2.0 is a light ceiling and 0.5 is a hard one.
 * Inhibition: 0.5 decouples the excited group from the silent background,
 * 1.0 makes it actively anti-phase.
 * k-WTA: a word signature is 4 primes and an utterance a few words, so 16
 * keeps a whole utterance and 4 keeps roughly one word.
 */
const ARMS: readonly Arm[] = [
  { name: 'control', note: 'no competition (the shipped engine)', options: {} },
  { name: 'divisive-2.0', note: 'activationBudget 2.0', options: { activationBudget: 2 } },
  { name: 'divisive-1.0', note: 'activationBudget 1.0', options: { activationBudget: 1 } },
  { name: 'divisive-0.5', note: 'activationBudget 0.5', options: { activationBudget: 0.5 } },
  { name: 'divisive-0.25', note: 'activationBudget 0.25', options: { activationBudget: 0.25 } },
  { name: 'divisive-0.1', note: 'activationBudget 0.1', options: { activationBudget: 0.1 } },
  { name: 'inhibition-0.5', note: 'cross-group weight 0 (decoupled)', options: { inhibition: 0.5 } },
  { name: 'inhibition-1.0', note: 'cross-group weight -1 (anti-phase)', options: { inhibition: 1 } },
  { name: 'wta-16', note: 'k-winner-take-all, k=16', options: { winnerTakeAll: 16 } },
  { name: 'wta-8', note: 'k-winner-take-all, k=8', options: { winnerTakeAll: 8 } },
  { name: 'wta-4', note: 'k-winner-take-all, k=4', options: { winnerTakeAll: 4 } }
];

interface ArmResult {
  name: string;
  note: string;
  traces: number;
  dcRatio: number;
  cosine: PairwiseCosineReading;
  jaccard: PrimeSetReading;
  margin: RetrievalMarginReading;
  competency: number;
  wordTop1: number;
  /** Per-kind DC ratio and unrelated-pair cosine, for reproducing §15. */
  byKind: { kind: string; traces: number; dc: number; raw: number; centered: number }[];
  wallMs: number;
}

interface TrainedArm {
  session: ObserverSession;
  teacher: TeacherAgent;
  probes: MarginProbe[];
  wordProbes: MarginProbe[];
  wallMs: number;
}

/**
 * Train one arm. Identical curriculum, identical order, identical teacher
 * settings on every arm — the ONLY difference is the observer options.
 */
async function train(options: Partial<SemanticObserverOptions>): Promise<TrainedArm> {
  const started = Date.now();
  const session = new ObserverSession({ ...OBSERVER_OPTIONS, ...options }, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 500);

  const wordProbes: MarginProbe[] = [];
  for (const entry of ACTIVE_DECK.slice(0, WORDS)) {
    const result = teacher.teach(entry.word);
    if (result.traceId !== null) wordProbes.push({ cue: entry.word, traceId: result.traceId });
  }

  const probes: MarginProbe[] = [];
  for (const pair of ALL_CONVERSATION_PAIRS.slice(0, PAIRS)) {
    const traceId = teacher.teachResponse(pair);
    if (traceId !== null) probes.push({ cue: pair.cue, traceId });
  }
  for (const pair of ALL_CONVERSATION_PAIRS.slice(0, PAIRS)) teacher.respond(pair.cue);

  return { session, teacher, probes, wordProbes, wallMs: Date.now() - started };
}

/** Measure everything for one trained arm. */
function measure(arm: Arm, trained: TrainedArm): ArmResult {
  const { session, teacher } = trained;
  const traces = session.observer.getMemoryBank().all() as TraceLike[];

  const excite = (cue: string): void => {
    session.settleField();
    session.observeText(cue);
    session.observer.tick(0.02);
    for (let step = 0; step < SETTLE_STEPS; step += 1) session.observer.tick(SETTLE_DT);
  };

  // A deterministic stride over the taught cues, so a 200-cue sample spans
  // the whole 728-pair deck instead of only its opening.
  const stride = Math.max(1, Math.floor(trained.probes.length / MARGIN_CUES));
  const cueSample = trained.probes.filter((_, i) => i % stride === 0).slice(0, MARGIN_CUES);

  const margin = retrievalMargin(cueSample, excite, (cue, topK) => session.recall(cue, topK), 5);

  // Word recognition inside the same session: the cue is the word, the
  // answer is its own lesson trace ranked first among WORD traces (the same
  // metadata filter TeacherAgent.recallWithCue uses for identity).
  let wordCorrect = 0;
  for (const probe of trained.wordProbes) {
    excite(probe.cue);
    const results = session.recall(probe.cue, 5).filter((r) => r.trace.metadata?.kind === undefined);
    if (results[0]?.trace.id === probe.traceId) wordCorrect += 1;
  }

  return {
    name: arm.name,
    note: arm.note,
    traces: traces.length,
    dcRatio: sketchDcRatio(traces),
    cosine: unrelatedPairwiseCosine(traces),
    jaccard: unrelatedPrimeJaccard(traces),
    margin,
    competency: teacher.conversationReport().competency,
    wordTop1: trained.wordProbes.length === 0 ? 0 : wordCorrect / trained.wordProbes.length,
    byKind: [...tracesByKind(traces).entries()]
      .filter(([, group]) => group.length >= 2)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([kind, group]) => {
        const reading = unrelatedPairwiseCosine(group);
        return {
          kind,
          traces: group.length,
          dc: sketchDcRatio(group),
          raw: reading.raw,
          centered: reading.centered
        };
      }),
    wallMs: trained.wallMs
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function report(results: readonly ArmResult[]): string {
  const head =
    `\n[competitionBench] words=${WORDS} pairs=${PAIRS} cues<=${MARGIN_CUES}\n` +
    `${'arm'.padEnd(15)} ${'DC'.padStart(6)} ${'cos'.padStart(6)} ${'cosC'.padStart(6)} ` +
    `${'Jstr'.padStart(5)} ${'Jeff'.padStart(5)} ${'|P|'.padStart(5)} ${'top1'.padStart(6)} ` +
    `${'true'.padStart(6)} ${'distr'.padStart(6)} ${'margin'.padStart(7)} ${'comp'.padStart(6)} ` +
    `${'word'.padStart(6)} ${'sec'.padStart(5)}\n`;
  const rows = results
    .map(
      (r) =>
        `${r.name.padEnd(15)} ${r.dcRatio.toFixed(3).padStart(6)} ${r.cosine.raw.toFixed(3).padStart(6)} ` +
        `${r.cosine.centered.toFixed(3).padStart(6)} ${r.jaccard.structural.toFixed(2).padStart(5)} ` +
        `${r.jaccard.effective.toFixed(2).padStart(5)} ${r.jaccard.meanEffectiveSize.toFixed(1).padStart(5)} ` +
        `${pct(r.margin.top1Rate).padStart(6)} ${r.margin.meanTrueScore.toFixed(3).padStart(6)} ` +
        `${r.margin.meanDistractorScore.toFixed(3).padStart(6)} ` +
        `${(r.margin.meanMargin >= 0 ? '+' : '') + r.margin.meanMargin.toFixed(3)}`.padStart(8) +
        ` ${pct(r.competency).padStart(6)} ${pct(r.wordTop1).padStart(6)} ` +
        `${(r.wallMs / 1000).toFixed(0).padStart(5)}`
    )
    .join('\n');
  const legend =
    `\n  DC=‖corpus mean‖/mean‖sketch‖ · cos/cosC=unrelated-pair cosine raw/centered\n` +
    `  Jstr/Jeff=prime-set Jaccard structural/effective · |P|=mean indexed primes\n` +
    `  top1/true/distr/margin=retrieval margin over taught cues · comp=conversation competency\n` +
    `  word=in-session word recognition top-1\n`;
  const notes = results.map((r) => `  ${r.name.padEnd(15)} ${r.note}`).join('\n');
  const kinds = results
    .map(
      (r) =>
        `  ${r.name.padEnd(15)} ` +
        r.byKind.map((k) => `${k.kind}(${k.traces}) DC ${k.dc.toFixed(3)} cos ${k.raw.toFixed(3)}/${k.centered.toFixed(3)}`).join(' · ')
    )
    .join('\n');
  return `${head}${rows}\n${legend}${notes}\n\n  by trace kind:\n${kinds}\n`;
}

describe('P12 competition benchmark (honest control: no competition)', () => {
  it('measures every competition variant against the control', async () => {
    const arms = ONLY.length > 0 ? ARMS.filter((a) => ONLY.includes(a.name)) : ARMS;
    const results: ArmResult[] = [];

    for (const arm of arms) {
      const trained = await train(arm.options);
      results.push(measure(arm, trained));
      trained.session.dispose();
    }

    // eslint-disable-next-line no-console
    console.log(report(results));

    for (const result of results) {
      expect(Number.isFinite(result.dcRatio)).toBe(true);
      expect(Number.isFinite(result.cosine.raw)).toBe(true);
      expect(Number.isFinite(result.margin.meanMargin)).toBe(true);
      expect(result.traces).toBeGreaterThan(0);
    }

    const control = results.find((r) => r.name === 'control');
    if (control) {
      // The control must reproduce the measured collapse this experiment was
      // opened to explain. If these ever stop holding, the diagnosis moved
      // and every verdict below it needs re-measuring.
      expect(control.dcRatio).toBeGreaterThan(0.5);
      expect(control.margin.top1Rate).toBeGreaterThan(0.9);
    }
  }, 3600000);
});
