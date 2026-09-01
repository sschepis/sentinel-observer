/**
 * @jest-environment node
 */
/**
 * SPARSE EXCITATION BENCHMARK — physics experiment 1 (docs/SCALING.md §17).
 *
 * THE HYPOTHESIS UNDER TEST. The observer's oscillator field was diagnosed as
 * sitting in a GLOBAL SYNCHRONY regime carrying almost no information: every
 * stored trace appeared to carry all 256 basis primes (prime overlap a
 * clique), the SMF corpus mean carried ~75% of a typical sketch's magnitude,
 * and mean-centering the sketch at readout — which should HELP if the shared
 * component were noise — collapsed top-1 ranking instead. If that picture is
 * right, making excitation SPARSE (a stimulus excites only its top-k primes)
 * should decollapse the code: prime Jaccard falls, the DC ratio falls, the
 * cosine floor falls, and centering stops being catastrophic.
 *
 * WHAT IS MEASURED, identically on every arm:
 *   1. mean prime-set Jaccard between unrelated traces — reported BOTH as the
 *      raw `trace.primes` array (the diagnosis's metric) and as the
 *      AMPLITUDE-GATED ACTIVE set, which is what the inverted index and the
 *      overlap term actually consume;
 *   2. sketch DC ratio ||corpus mean|| / mean ||sketch||;
 *   3. mean pairwise sketch cosine between unrelated traces, raw and centered;
 *   4. the §15 retrieval margin: for the taught conversation cues, recall
 *      top-5 and locate the trace whose `metadata.cue` is that cue — top-1
 *      rank rate, mean true score, mean best-distractor score, mean margin;
 *   5. conversation competency (the shipped identity+margin gate);
 *   6. THE FALSIFIER: `centerSketches` re-run with sparse excitation ON.
 *
 * The honest control is `excitationTopK` unset — the shipped encoder,
 * untouched. Both arms run in one process off one curriculum.
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation';
import { MemoryPersistenceStore } from '../persistence/store';
import type { TraceLike } from '@sschepis/sentient-core';

/** §15 measured 200 words + the full 728-pair curriculum; match it. */
const WORDS = Number(process.env.SPARSE_BENCH_WORDS ?? 200);
const PAIRS = Number(process.env.SPARSE_BENCH_PAIRS ?? ALL_CONVERSATION_PAIRS.length);
/** Cues probed for the retrieval margin (§15 used ~200). */
const MARGIN_CUES = Number(process.env.SPARSE_BENCH_CUES ?? 200);
/** Traces sampled for the O(n^2) geometry readings. */
const GEOMETRY_SAMPLE = 200;
/** The compact bank's own index gate: below this a prime is not a reading. */
const INDEX_THRESHOLD = 1e-4;
/** Recall settling, copied from TeacherAgent.exciteAndSettle. */
const RECALL_SETTLE_STEPS = 4;
const SETTLE_DT = 0.05;

interface ArmConfig {
  readonly label: string;
  /** undefined = the honest control (shipped encoder). */
  readonly excitationTopK?: number;
  readonly centerSketches?: boolean;
}

interface ArmResult {
  readonly label: string;
  readonly traces: number;
  /** Mean number of primes a stimulus actually excites. */
  readonly meanActivePrimes: number;
  readonly jaccardRaw: number;
  readonly jaccardActive: number;
  readonly dcRatio: number;
  readonly cosineRaw: number;
  readonly cosineCentered: number;
  /**
   * The EMA probe: how similar are two sketches stored BACK TO BACK, and how
   * similar are the first and last sketches of the same run? If the sketch
   * were a function of content these would both be ~the corpus floor; if it
   * is a running average of the observer's history, the first is high and the
   * second is ~0.
   */
  readonly cosineConsecutive: number;
  readonly cosineFirstLast: number;
  readonly top1Rate: number;
  readonly inTop5Rate: number;
  readonly meanTrueScore: number;
  readonly meanDistractorScore: number;
  readonly meanMargin: number;
  readonly competency: number;
  readonly wallMs: number;
}

// ── vector helpers ──────────────────────────────────────────────────────────

function norm(v: readonly number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  const denominator = norm(a) * norm(b);
  return denominator === 0 ? 0 : dot / denominator;
}

function subtract(a: readonly number[], b: readonly number[]): number[] {
  return a.map((x, i) => x - b[i]);
}

function jaccard(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  let intersection = 0;
  for (const v of a) if (b.has(v)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** The primes a trace actually carries excitation on (what the index sees). */
function activePrimes(trace: TraceLike): Set<number> {
  const active = new Set<number>();
  for (let i = 0; i < trace.primes.length; i += 1) {
    if (trace.amplitudes[i] >= INDEX_THRESHOLD) active.add(trace.primes[i]);
  }
  return active;
}

// ── the arm ─────────────────────────────────────────────────────────────────

async function runArm(config: ArmConfig): Promise<ArmResult> {
  const started = Date.now();
  const session = new ObserverSession(
    {
      ...OBSERVER_OPTIONS,
      ...(config.excitationTopK !== undefined ? { excitationTopK: config.excitationTopK } : {}),
      ...(config.centerSketches === true ? { memoryBankOptions: { centerSketches: true } } : {})
    },
    100
  );
  await session.initialize();
  const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 100000);
  for (const entry of ACTIVE_DECK.slice(0, WORDS)) teacher.teach(entry.word);
  const pairs = ALL_CONVERSATION_PAIRS.slice(0, PAIRS);
  teacher.teachConversationDeck(pairs);

  const bank = session.observer.getMemoryBank();
  const traces = bank.all() as TraceLike[];

  // ── 1. prime-set Jaccard between unrelated traces ────────────────────────
  // "Unrelated" = distinct taught moments; a deterministic stride keeps the
  // sample identical across arms.
  const stride = Math.max(1, Math.floor(traces.length / GEOMETRY_SAMPLE));
  const sample: TraceLike[] = [];
  for (let i = 0; i < traces.length && sample.length < GEOMETRY_SAMPLE; i += stride) {
    sample.push(traces[i]);
  }
  const rawSets = sample.map((t) => new Set(t.primes));
  const activeSets = sample.map(activePrimes);

  let jaccardRawSum = 0;
  let jaccardActiveSum = 0;
  let pairCount = 0;
  for (let i = 0; i < sample.length; i += 1) {
    for (let j = i + 1; j < sample.length; j += 1) {
      jaccardRawSum += jaccard(rawSets[i], rawSets[j]);
      jaccardActiveSum += jaccard(activeSets[i], activeSets[j]);
      pairCount += 1;
    }
  }
  const meanActivePrimes = activeSets.reduce((s, set) => s + set.size, 0) / activeSets.length;

  // ── 2 & 3. sketch geometry ───────────────────────────────────────────────
  const sketches = traces.map((t) => t.smf.toArray());
  const width = sketches[0].length;
  const corpusMean = new Array<number>(width).fill(0);
  for (const s of sketches) {
    for (let i = 0; i < width; i += 1) corpusMean[i] += s[i] / sketches.length;
  }
  const dcRatio =
    norm(corpusMean) / (sketches.reduce((s, v) => s + norm(v), 0) / sketches.length);

  const sampleSketches = sample.map((t) => t.smf.toArray());
  let cosineRawSum = 0;
  let cosineCenteredSum = 0;
  for (let i = 0; i < sampleSketches.length; i += 1) {
    for (let j = i + 1; j < sampleSketches.length; j += 1) {
      cosineRawSum += cosine(sampleSketches[i], sampleSketches[j]);
      cosineCenteredSum += cosine(
        subtract(sampleSketches[i], corpusMean),
        subtract(sampleSketches[j], corpusMean)
      );
    }
  }

  // ── the EMA probe ────────────────────────────────────────────────────────
  // `bank.all()` is insertion-ordered and the geometry is read before any
  // recall touches a trace, so "consecutive" is genuinely "taught back to
  // back". This is measured on every arm because it must NOT move with k:
  // it is a property of the sketch update rule, not of the excitation.
  let consecutiveSum = 0;
  for (let i = 1; i < sketches.length; i += 1) {
    consecutiveSum += cosine(sketches[i - 1], sketches[i]);
  }

  // ── 4. the §15 retrieval margin ──────────────────────────────────────────
  // Production readout exactly: excite the cue, let the field converge, then
  // ask for the top 5 (TeacherAgent.exciteAndSettle + session.recall).
  let top1 = 0;
  let inTop5 = 0;
  let trueScoreSum = 0;
  let distractorScoreSum = 0;
  let marginSum = 0;
  let scored = 0;
  for (const pair of pairs.slice(0, MARGIN_CUES)) {
    const cue = pair.cue.toLowerCase();
    session.settleField();
    session.observeText(pair.cue);
    session.observer.tick(0.02);
    for (let step = 0; step < RECALL_SETTLE_STEPS; step += 1) session.observer.tick(SETTLE_DT);
    const hits = session.recall(pair.cue, 5);

    const trueIndex = hits.findIndex((h) => h.trace.metadata?.cue === cue);
    if (trueIndex === -1) continue;
    scored += 1;
    inTop5 += 1;
    if (trueIndex === 0) top1 += 1;
    const trueScore = hits[trueIndex].score;
    const best = hits.filter((_, i) => i !== trueIndex);
    const distractor = best.length > 0 ? Math.max(...best.map((h) => h.score)) : 0;
    trueScoreSum += trueScore;
    distractorScoreSum += distractor;
    marginSum += trueScore - distractor;
  }

  // ── 5. the shipped competency gate ───────────────────────────────────────
  for (const pair of pairs) teacher.respond(pair.cue);
  const competency = teacher.conversationReport().competency;

  const probed = Math.min(MARGIN_CUES, pairs.length);
  const result: ArmResult = {
    label: config.label,
    traces: traces.length,
    meanActivePrimes,
    jaccardRaw: jaccardRawSum / pairCount,
    jaccardActive: jaccardActiveSum / pairCount,
    dcRatio,
    cosineRaw: cosineRawSum / pairCount,
    cosineCentered: cosineCenteredSum / pairCount,
    cosineConsecutive: consecutiveSum / Math.max(1, sketches.length - 1),
    cosineFirstLast: cosine(sketches[0], sketches[sketches.length - 1]),
    top1Rate: scored === 0 ? 0 : top1 / scored,
    inTop5Rate: probed === 0 ? 0 : inTop5 / probed,
    meanTrueScore: scored === 0 ? 0 : trueScoreSum / scored,
    meanDistractorScore: scored === 0 ? 0 : distractorScoreSum / scored,
    meanMargin: scored === 0 ? 0 : marginSum / scored,
    competency,
    wallMs: Date.now() - started
  };
  session.dispose();
  return result;
}

function report(rows: readonly ArmResult[]): string {
  const header =
    '  arm                    | act/256 | Jraw  | Jact  |  DC   | cos   | cosC   | top1   | true  | dist  | margin | comp';
  const lines = rows.map(
    (r) =>
      `  ${r.label.padEnd(22)} | ${r.meanActivePrimes.toFixed(1).padStart(7)} | ` +
      `${r.jaccardRaw.toFixed(3)} | ${r.jaccardActive.toFixed(3)} | ` +
      `${r.dcRatio.toFixed(3)} | ${r.cosineRaw.toFixed(3)} | ${r.cosineCentered.toFixed(3).padStart(6)} | ` +
      `${(r.top1Rate * 100).toFixed(1).padStart(5)}% | ${r.meanTrueScore.toFixed(3)} | ` +
      `${r.meanDistractorScore.toFixed(3)} | ${(r.meanMargin >= 0 ? '+' : '') + r.meanMargin.toFixed(3)} | ` +
      `${(r.competency * 100).toFixed(1)}%`
  );
  return [header, ...lines].join('\n');
}

describe('sparse excitation benchmark (honest control: excitationTopK unset)', () => {
  it('measures the encoding geometry and the retrieval margin on both arms', async () => {
    const arms: ArmConfig[] = [
      { label: 'control (dense)' },
      { label: 'topK=8', excitationTopK: 8 },
      { label: 'topK=16', excitationTopK: 16 },
      { label: 'topK=32', excitationTopK: 32 },
      { label: 'topK=64', excitationTopK: 64 },
      // Below the measured active-set size: the only k values that actually
      // bind. Without these the sweep is flat and says nothing.
      { label: 'topK=4', excitationTopK: 4 },
      { label: 'topK=2', excitationTopK: 2 },
      // THE FALSIFIER: centering, off and on, across the whole DC range the
      // sparse arms produce. One centered point cannot separate "sparsity
      // rescued centering" from noise — the claim is a TREND against DC.
      { label: 'control + center', centerSketches: true },
      { label: 'topK=16 + center', excitationTopK: 16, centerSketches: true },
      { label: 'topK=8 + center', excitationTopK: 8, centerSketches: true },
      { label: 'topK=4 + center', excitationTopK: 4, centerSketches: true },
      { label: 'topK=2 + center', excitationTopK: 2, centerSketches: true }
    ];

    const rows: ArmResult[] = [];
    for (const arm of arms) rows.push(await runArm(arm));

    const control = rows[0];
    const byLabel = new Map(rows.map((r) => [r.label, r]));

    // eslint-disable-next-line no-console
    console.log(
      `\n[sparseExcitationBench] words=${WORDS} pairs=${PAIRS} cues=${MARGIN_CUES} ` +
        `traces=${control.traces}\n` +
        report(rows) +
        `\n  wall: ${rows.map((r) => `${r.label}=${(r.wallMs / 1000).toFixed(1)}s`).join(' · ')}\n`
    );

    // ── What the control must be, or the experiment is measuring nothing ──
    // The shipped encoder is ALREADY sparse in amplitude: the "all 256 primes"
    // reading is the trace's prime ARRAY, not its excitation.
    expect(control.meanActivePrimes).toBeLessThan(32);
    expect(control.jaccardRaw).toBeCloseTo(1, 3);
    expect(control.jaccardActive).toBeLessThan(0.2);
    // The control must reproduce the §15 retrieval distribution, or the
    // margin column is not comparable to anything already documented.
    expect(control.top1Rate).toBeGreaterThan(0.95);
    expect(control.meanMargin).toBeGreaterThan(0.09);

    // ── The option does what it says on every arm that binds ─────────────
    for (const k of [2, 4, 8]) {
      const arm = byLabel.get(`topK=${k}`);
      expect(arm).toBeDefined();
      expect(arm!.meanActivePrimes).toBeLessThanOrEqual(k + 1e-9);
    }

    // ── The MECHANISM claim, which the sweep does confirm ────────────────
    // Excitation density causes the sketch DC. Every arm whose budget binds
    // below the control's active count lowers the DC ratio and the raw
    // cosine floor, monotonically in k.
    const binding = [2, 4, 8].map((k) => byLabel.get(`topK=${k}`)!);
    for (const arm of binding) {
      expect(arm.dcRatio).toBeLessThan(control.dcRatio);
      expect(arm.cosineRaw).toBeLessThan(control.cosineRaw);
    }
    expect(byLabel.get('topK=2')!.dcRatio).toBeLessThan(byLabel.get('topK=4')!.dcRatio);
    expect(byLabel.get('topK=4')!.dcRatio).toBeLessThan(byLabel.get('topK=8')!.dcRatio);

    // ── Where the collapse actually lives (docs/SCALING.md §17d) ──────────
    // The SMF sketch is an EMA that nothing resets: `settleField()` clears
    // the oscillators, not the sketch. So a trace's sketch encodes WHEN it
    // was taught at least as strongly as WHAT it says. The ratio is the
    // reading that matters — sparsity strips CONTENT variance out of the
    // sketch while leaving the temporal trajectory intact, so the recency
    // component gets relatively STRONGER as k falls, not weaker.
    // eslint-disable-next-line no-console
    console.log(
      `[sparseExcitationBench] SKETCH EMA PROBE — is the sketch a code or a clock?\n` +
        `  arm                    | consecutive | unrelated | ratio | first-vs-last\n` +
        rows
          .map(
            (r) =>
              `  ${r.label.padEnd(22)} | ${r.cosineConsecutive.toFixed(3).padStart(11)} | ` +
              `${r.cosineRaw.toFixed(3).padStart(9)} | ` +
              `${(r.cosineConsecutive / r.cosineRaw).toFixed(2).padStart(5)} | ` +
              `${r.cosineFirstLast.toFixed(3)}`
          )
          .join('\n') +
        '\n'
    );
    for (const row of rows) {
      // Back-to-back traces are far more alike than unrelated ones, and the
      // ends of the run are far LESS alike: a drifting running average, not
      // a content code. If this ever stops holding, §17d is stale.
      expect(row.cosineConsecutive).toBeGreaterThan(row.cosineRaw);
      expect(row.cosineFirstLast).toBeLessThan(row.cosineRaw);
    }
    // Sparsity does not dilute the temporal component — it concentrates it.
    const recencyRatio = (r: ArmResult): number => r.cosineConsecutive / r.cosineRaw;
    expect(recencyRatio(byLabel.get('topK=2')!)).toBeGreaterThan(recencyRatio(control));
    expect(recencyRatio(byLabel.get('topK=4')!)).toBeGreaterThan(recencyRatio(control));

    // ── The measured NEGATIVE result, kept as a gate (docs/SCALING.md §17) ─
    // Lowering the DC by starving the excitation costs strictly more ranking
    // than the DC was costing. If a future change makes this assertion fail,
    // the verdict in §17 is out of date and must be re-measured, not deleted.
    expect(byLabel.get('topK=8')!.top1Rate).toBeLessThan(control.top1Rate);
    expect(byLabel.get('topK=8')!.competency).toBeLessThan(control.competency);

    // ── THE FALSIFIER ─────────────────────────────────────────────────────
    // Centering is catastrophic on the control (§15). The prediction under
    // test: sparse excitation makes it neutral or positive. Recorded either
    // way — a refuted prediction is the result, not a failure.
    const centered: Array<[string, string]> = [
      ['control (dense)', 'control + center'],
      ['topK=16', 'topK=16 + center'],
      ['topK=8', 'topK=8 + center'],
      ['topK=4', 'topK=4 + center'],
      ['topK=2', 'topK=2 + center']
    ];
    // eslint-disable-next-line no-console
    console.log(
      `[sparseExcitationBench] FALSIFIER — does centering stop being catastrophic?\n` +
        `  base arm        |  DC   | top1 off -> on   | margin off -> on   | d(margin)\n` +
        centered
          .map(([offLabel, onLabel]) => {
            const off = byLabel.get(offLabel)!;
            const on = byLabel.get(onLabel)!;
            const delta = on.meanMargin - off.meanMargin;
            return (
              `  ${offLabel.padEnd(15)} | ${off.dcRatio.toFixed(3)} | ` +
              `${(off.top1Rate * 100).toFixed(1).padStart(5)}% -> ${(on.top1Rate * 100).toFixed(1).padStart(5)}% | ` +
              `${(off.meanMargin >= 0 ? '+' : '') + off.meanMargin.toFixed(3)} -> ` +
              `${(on.meanMargin >= 0 ? '+' : '') + on.meanMargin.toFixed(3)} | ` +
              `${(delta >= 0 ? '+' : '') + delta.toFixed(3)}`
            );
          })
          .join('\n') +
        '\n'
    );

    // The measurement must be a real reading, not an empty one.
    expect(control.inTop5Rate).toBeGreaterThan(0.9);
    expect(rows.every((r) => Number.isFinite(r.meanMargin))).toBe(true);
  }, 1800000);
});
