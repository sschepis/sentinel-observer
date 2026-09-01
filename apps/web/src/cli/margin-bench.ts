#!/usr/bin/env node
/**
 * MARGIN BENCH — the decisive retrieval metric (docs/SCALING.md §15).
 *
 * Protocol: train the observer (N words + the full conversation curriculum),
 * then for ~200 taught conversation cues call session.recall(cue, 5), locate
 * the trace whose metadata.cue equals the taught cue, and record its score
 * minus the best other score. The mean of that margin is what converts into
 * confident answers without loosening any gate — top-1 rank is saturated
 * (98.5%) and cannot judge anything.
 *
 * Also measured, identically on both arms:
 *   - prime-set Jaccard between unrelated conversation traces (~1.0 baseline:
 *     every trace carries the full active basis, a clique)
 *   - sketch DC ratio ||mean|| / mean||sketch|| (0.747 baseline)
 *   - unrelated-pair cosine, raw (0.297) and mean-centered (0.084)
 *   - conversation competency
 *
 * Arms: RAW (production defaults) and CENTERED (memoryBankOptions
 * { centerSketches: true } — the falsifier: if a change decollapses the
 * field, centering stops being catastrophic; while centering still destroys
 * ranking, the collapse has another cause).
 *
 * Usage:
 *   npx tsx src/cli/margin-bench.ts [--raw-only] [--centered-only]
 *   MARGIN_BENCH_WORDS=200 MARGIN_BENCH_CUES=200 (env overrides)
 */
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation';
import { MemoryPersistenceStore } from '../persistence/store';
import type { SemanticObserverOptions, TraceLike, RecallResult } from '@sschepis/sentient-core';

const args = process.argv.slice(2);
const RAW_ONLY = args.includes('--raw-only');
const CENTERED_ONLY = args.includes('--centered-only');
const WORDS = Number(process.env.MARGIN_BENCH_WORDS ?? 200);
const CUE_COUNT = Number(process.env.MARGIN_BENCH_CUES ?? 200);
const COMPETITION = {
  activationBudget: Number(process.env.MARGIN_BENCH_BUDGET ?? 0),
  inhibition: Number(process.env.MARGIN_BENCH_INHIBITION ?? 0),
  winnerTakeAll: Number(process.env.MARGIN_BENCH_WTA ?? 0)
};
const MOMENT_CRITERION = process.env.MARGIN_BENCH_CRITERION ?? 'global-R';
const SMF_MOMENT_IMPRINT = process.env.MARGIN_BENCH_SMF_IMPRINT === '1';

interface ArmOptions {
  label: string;
  extra: Partial<SemanticObserverOptions>;
}

interface MarginStats {
  cues: number;
  top5Present: number;
  top1: number;
  meanTrue: number;
  meanDistractor: number;
  meanMargin: number;
  jaccardUnrelated: number;
  dcRatio: number;
  cosineRaw: number;
  cosineCentered: number;
  competency: number;
  wallMs: number;
}

function sampleCues(count: number): string[] {
  const seen = new Set<string>();
  const cues: string[] = [];
  for (const pair of ALL_CONVERSATION_PAIRS) {
    if (!seen.has(pair.cue)) {
      seen.add(pair.cue);
      cues.push(pair.cue);
    }
  }
  if (cues.length <= count) return cues;
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(cues[Math.floor((i * cues.length) / count)]);
  return out;
}

/** Pairs of traces with DIFFERENT content, seeded-random — the deck is
 *  topic-clustered, so adjacent traces are NOT unrelated. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unrelatedPairs(traces: readonly TraceLike[], count: number): Array<[TraceLike, TraceLike]> {
  const rand = mulberry32(0x51a7e);
  const pairs: Array<[TraceLike, TraceLike]> = [];
  let guard = 0;
  while (pairs.length < count && guard < count * 50) {
    guard += 1;
    const i = Math.floor(rand() * traces.length);
    const j = Math.floor(rand() * traces.length);
    if (i === j || traces[i].content === traces[j].content) continue;
    pairs.push([traces[i], traces[j]]);
  }
  return pairs;
}

function jaccard(a: readonly number[], b: readonly number[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const p of sa) if (sb.has(p)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function norm(v: Float64Array | number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += v[i] * v[i];
  return Math.sqrt(s);
}

function meanVector(vectors: number[][]): Float64Array {
  const n = vectors[0].length;
  const mean = new Float64Array(n);
  for (const v of vectors) for (let i = 0; i < n; i += 1) mean[i] += v[i] / vectors.length;
  return mean;
}

function cosineCenteredOf(a: number[], b: number[], mean: Float64Array): number {
  let ca = 0;
  let cb = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - mean[i];
    const db = b[i] - mean[i];
    ca += da * db;
    na += da * da;
    nb += db * db;
  }
  return na === 0 || nb === 0 ? 0 : ca / Math.sqrt(na * nb);
}

async function runArm(opts: ArmOptions): Promise<MarginStats> {
  const started = Date.now();
  const session = new ObserverSession(
    {
      ...OBSERVER_OPTIONS,
      ...COMPETITION,
      momentCriterion: MOMENT_CRITERION as 'global-R' | 'phase-clusters',
      smfMomentImprint: SMF_MOMENT_IMPRINT,
      ...opts.extra
    },
    100
  );
  await session.initialize();
  const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 500);
  for (const entry of ACTIVE_DECK.slice(0, WORDS)) teacher.teach(entry.word);
  teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS);
  for (const pair of ALL_CONVERSATION_PAIRS) teacher.respond(pair.cue);

  const cues = sampleCues(CUE_COUNT);
  let top1 = 0;
  let top5Present = 0;
  let trueSum = 0;
  let distractorSum = 0;
  let marginSum = 0;
  let marginN = 0;
  for (const cue of cues) {
    const results: RecallResult[] = session.recall(cue, 5);
    const trueIdx = results.findIndex((r) => r.trace.metadata?.cue === cue);
    if (trueIdx === -1) continue;
    top5Present += 1;
    if (trueIdx === 0) top1 += 1;
    const trueScore = results[trueIdx].score;
    trueSum += trueScore;
    let bestOther = -Infinity;
    for (let k = 0; k < results.length; k += 1) {
      if (k !== trueIdx && results[k].score > bestOther) bestOther = results[k].score;
    }
    if (Number.isFinite(bestOther)) {
      distractorSum += bestOther;
      marginSum += trueScore - bestOther;
      marginN += 1;
    }
  }

  const allTraces = session.observer.getMemoryBank().all();
  const pairs = unrelatedPairs(allTraces, 200);
  let jaccardSum = 0;
  let cosineRawSum = 0;
  let cosineCenteredSum = 0;
  const vectors = allTraces.map((t) => t.smf.toArray());
  const mean = meanVector(vectors);
  for (const [a, b] of pairs) {
    jaccardSum += jaccard(a.primes, b.primes);
    cosineRawSum += a.smf.coherenceWith(b.smf);
    cosineCenteredSum += cosineCenteredOf(a.smf.toArray(), b.smf.toArray(), mean);
  }
  let meanNormSum = 0;
  for (const v of vectors) meanNormSum += norm(v);
  const dcRatio = vectors.length === 0 ? 0 : norm(mean) / (meanNormSum / vectors.length);

  const competency = teacher.conversationReport().competency;
  session.dispose();

  const n = top5Present || 1;
  return {
    cues: cues.length,
    top5Present,
    top1: top1 / n,
    meanTrue: trueSum / n,
    meanDistractor: distractorSum / (marginN || 1),
    meanMargin: marginSum / (marginN || 1),
    jaccardUnrelated: jaccardSum / (pairs.length || 1),
    dcRatio,
    cosineRaw: cosineRawSum / (pairs.length || 1),
    cosineCentered: cosineCenteredSum / (pairs.length || 1),
    competency,
    wallMs: Date.now() - started
  };
}

function print(label: string, s: MarginStats): void {
  // eslint-disable-next-line no-console
  console.log(
    `  ${label.padEnd(10)} top-1 ${(s.top1 * 100).toFixed(1)}% (${s.top5Present}/${s.cues} in top-5) · ` +
      `true ${s.meanTrue.toFixed(3)} · distractor ${s.meanDistractor.toFixed(3)} · ` +
      `MARGIN ${s.meanMargin >= 0 ? '+' : ''}${s.meanMargin.toFixed(3)} · ` +
      `Jaccard ${s.jaccardUnrelated.toFixed(3)} · DC ratio ${s.dcRatio.toFixed(3)} · ` +
      `cosine raw/centered ${s.cosineRaw.toFixed(3)}/${s.cosineCentered.toFixed(3)} · ` +
      `competency ${(s.competency * 100).toFixed(1)}% · ${s.wallMs}ms`
  );
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(
    `[margin-bench] words=${WORDS} cues=${CUE_COUNT} pairs=${ALL_CONVERSATION_PAIRS.length} ` +
      `competition=${JSON.stringify(COMPETITION)} criterion=${MOMENT_CRITERION} smfMomentImprint=${SMF_MOMENT_IMPRINT}`
  );
  if (!CENTERED_ONLY) print('raw', await runArm({ label: 'raw', extra: {} }));
  if (!RAW_ONLY) {
    print('centered', await runArm({ label: 'centered', extra: { memoryBankOptions: { centerSketches: true } } }));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
