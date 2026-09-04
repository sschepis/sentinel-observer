/**
 * SHARD-ROUTE-BENCH (improvements.md §3.2 / B.2) — the measurement engine.
 *
 * The proposal under test: keep the shard-trainer's K shards as SEPARATE
 * banks at query time and route each cue to one of them, instead of
 * merging into a single 20k-interference bank. If a ~5k-word shard has
 * ~99% in-shard recall and the router picks the shard holding the true
 * trace, effective recall = routing accuracy × in-shard recall (+ the
 * runner-up fallback), compared against the merged single-bank baseline
 * (94.6% at 20k, 26.4 ms ask).
 *
 * Measured per K:
 *   (a) routing accuracy  — does the router (routeScores argmax) pick the
 *       shard holding the true trace (top-1), and is the home in the top-2;
 *   (b) in-shard recall   — top-1 of the home shard's OWN recall (`recallIn`);
 *   (c) effective recall  — the end-to-end routed answer through the live
 *       observer (includes the runner-up fallback), vs. the merged baseline
 *       over the same probe words;
 *   (d) latency           — ask ms per probe, sharded vs. merged.
 *
 * The sharded bank is a `ShardedMemoryBank` seeded with K shards, each
 * holding ONE training record's traces (seedShards + restoreTrace with an
 * explicit home — the partition the shard trainer produced). The merged
 * baseline restores mergeRecords(records) into a compact-mode session via
 * importBootstrap — the exact path the 94.6% number came from.
 *
 * The optional fuzz pass compares three banks restored from the same
 * records — missDetector ON, missDetector OFF (explicit false), and NO
 * FLAG — on flat-router distractor queries (§5.2's "replace the final
 * word" rule read at the signature level: one prime from each of three
 * shards). A distractor is admitted only when the router's distribution
 * over it is measurably FLAT, so the ON bank's empty answer is the miss
 * detector working, not a weak distractor.
 */
import { performance } from 'node:perf_hooks';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { ACTIVE_DECK } from '../teacher/decks';
import { mergeRecords } from '../teacher/mergeRecords';
import { topTwoMargin, topTwoThreeMargin, CDE_REGIME_DEFAULTS } from '../teacher/cde';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { MemoryPersistenceStore } from '../persistence/store';
import type { BootstrapRecord } from '../teacher/bootstrap';
import type { DeckWord } from '../teacher/deck';
import type { RecallResultLike, SedenionMemoryField, SerializedTraceData } from '@sschepis/sentient-core';

/**
 * The shard-route bench engine. Training defaults to a sequential in-process
 * loop (jest-safe); the CLI injects the parallel ShardTrainer worker pool for
 * the full-scale run — see the `train` option.
 */

/** The cue shape the sharded bank's routing/recall reads (the compact
 *  bank's RecallQuery — structurally declared here because the package root
 *  exports the FULL bank's cue type, which lacks the W1 `coherence` gate). */
interface Cue {
  smf?: SedenionMemoryField;
  primes?: readonly number[];
  phases?: readonly number[];
  amplitudes?: readonly number[];
  coherence?: number;
}

/** The `ShardedMemoryBank` surface the bench drives (cast from the
 *  MemoryBank the observer exposes). */
interface BenchBank {
  seedShards(k: number): void;
  restoreTrace(data: SerializedTraceData, homeShard?: number): unknown;
  get(id: string): unknown;
  recall(query: Cue, topK?: number): RecallResultLike[];
  routeScores(query: Cue): number[];
  recallIn(shardIndex: number, query: Cue, topK?: number): RecallResultLike[];
  shardAudit(): { index: number; traces: number; entropyBits: number; vocabulary: number }[];
  readonly missDetectorAsks: number;
}

export interface ShardRouteFuzz {
  /** Admitted flat-router distractors (see module doc). */
  flatDistractors: number;
  /** Distractors the OFF bank answered confidently (a wrong shard's answer). */
  offConfident: number;
  /** Distractors the ON bank answered confidently — the §3.2 gate: 0. */
  onConfident: number;
  /** Whether the explicit-OFF bank matched the no-flag bank on every probe. */
  offBitIdenticalToFlagless: boolean;
  /** True cues the OFF bank answered correctly that the ON bank asked on. */
  detectorRecallCost: number;
}

export interface ShardRouteMeasurement {
  k: number;
  /** Actual words per shard (the deck cap may shrink K=8 below the ask). */
  shardSizes: number[];
  totalWords: number;
  probes: number;
  /** (a) P(router top-1 === true home) over probe cues. */
  routingTop1: number;
  /** P(true home ∈ router top-2) — the second-shard fallback ceiling. */
  routingTop2: number;
  /**
   * (a') The §3.2 "free" first-stage score — prime-vocabulary overlap per
   * shard (routeScores without a sketch, with routeFor's tie-break) — read
   * alongside the prototype-cosine route the production query uses.
   */
  routingTop1Primes: number;
  routingTop2Primes: number;
  /**
   * (a'') The router's CEILING: routing accuracy when the cue is the true
   * trace's own stored orientation (a perfect cue). Separates "the shards
   * are indistinguishable" from "the live cue is weak" — the live-field
   * route can never beat this.
   */
  routingTop1Exact: number;
  /** (b) P(home shard's own top-1 === true trace). */
  inShardRecall: number;
  /** (c) P(routed end-to-end top-1 === true trace) — includes fallback. */
  effectiveRecall: number;
  /** routingTop1 × inShardRecall — the analytic decomposition of (c). */
  productEstimate: number;
  /** The merged single-bank recall over the same probe words. */
  mergedRecall: number;
  /** (d) routed ask latency, ms per probe. */
  shardedAskMs: number;
  /** (d) merged ask latency, ms per probe. */
  mergedAskMs: number;
  /** True cues whose routed recall came back empty (the bank's ask). */
  routedAsks: number;
  /** True cues whose router distribution was FLAT (would ask with the
   *  detector ON — the detector's recall cost on honest cues). */
  flatTrueCues: number;
  shardAudit: { index: number; traces: number; entropyBits: number; vocabulary: number }[];
  fuzz: ShardRouteFuzz | null;
}

export interface ShardRouteBenchOptions {
  wordsPerShard: number;
  ks: number[];
  probeCount: number;
  /** Build the ON/OFF/no-flag banks and run the flat-distractor pass. */
  fuzz: boolean;
  onProgress?: (message: string) => void;
  /**
   * Trains the K deck shards into K bootstrap records (the shard trainer's
   * contract). Defaults to the sequential in-process loop below (jest-safe);
   * the CLI injects the parallel worker pool for the full-scale run.
   */
  train?: (shards: readonly DeckWord[][]) => Promise<BootstrapRecord[]>;
}

/** The sequential training loop — the same teacher call the shard-trainer
 *  worker makes, minus the worker pool (jest cannot parse the pool's
 *  `import.meta`). Records are compatible because all shards share
 *  OBSERVER_OPTIONS. */
async function trainSequential(shards: readonly DeckWord[][]): Promise<BootstrapRecord[]> {
  const records: BootstrapRecord[] = [];
  for (const deck of shards) {
    const session = new ObserverSession(OBSERVER_OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, deck, new MemoryPersistenceStore(), 500);
    for (const entry of deck) teacher.teach(entry.word);
    records.push(teacher.exportBootstrap('scale-shard'));
    session.dispose();
  }
  return records;
}

/** Restore each record's traces into shard `i` of the bank (the q16/prime
 *  handling mirrors importBootstrap). */
function restoreRecords(bank: BenchBank, records: readonly BootstrapRecord[]): number {
  let restored = 0;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    for (const data of record.traces) {
      const primes = data.primes.length === 0 && record.primeBasis !== undefined ? record.primeBasis : data.primes;
      const traceData =
        record.encoding === 'q16'
          ? { ...data, primes, amplitudes: data.amplitudes.map((a) => a / 65535) }
          : { ...data, primes };
      if (bank.restoreTrace(traceData as SerializedTraceData, i) !== null) restored += 1;
    }
  }
  return restored;
}

/** word -> { shard (record index), traceId } from the training records. */
function wordHomes(records: readonly BootstrapRecord[]): Map<string, { shard: number; traceId: string }> {
  const homes = new Map<string, { shard: number; traceId: string }>();
  records.forEach((record, shard) => {
    for (const state of record.wordStates) {
      if (state.traceId !== null) homes.set(state.word, { shard, traceId: state.traceId });
    }
  });
  return homes;
}

/** Deterministic strided probe sample over the words with known homes. */
function probeWords(slice: readonly DeckWord[], homes: Map<string, { shard: number; traceId: string }>, count: number): string[] {
  const taught = slice.filter((entry) => homes.has(entry.word)).map((entry) => entry.word);
  if (taught.length <= count) return taught;
  const stride = Math.floor(taught.length / count);
  return Array.from({ length: count }, (_, i) => taught[i * stride]);
}

/** Build an autoshard session whose bank holds the K training shards. */
async function buildShardedSession(
  records: readonly BootstrapRecord[],
  missDetector: boolean | undefined
): Promise<{ session: ObserverSession; bank: BenchBank }> {
  const session = new ObserverSession(
    {
      ...OBSERVER_OPTIONS,
      memoryMode: 'autoshard',
      memoryBankOptions: missDetector === undefined ? undefined : { missDetector }
    },
    100
  );
  await session.initialize();
  const bank = session.observer.getMemoryBank() as unknown as BenchBank;
  bank.seedShards(records.length);
  restoreRecords(bank, records);
  return { session, bank };
}

/** The full production query recallMemory builds (mirrors its W1 cue
 *  construction: the live field's phases/amplitudes/coherence ride along). */
function fullQuery(session: ObserverSession, primes: readonly number[]): Cue {
  const field = session.observer.getOscillatorField();
  const state = field.getState();
  const phases = primes.map((p) => {
    const index = field.indexOfPrime(p);
    return index >= 0 ? state.phases[index] : 0;
  });
  const amplitudes = primes.map((p) => {
    const index = field.indexOfPrime(p);
    return index >= 0 ? state.amplitudes[index] : 0;
  });
  return {
    smf: session.observer.getMemoryField().clone(),
    primes,
    phases,
    amplitudes,
    coherence: state.coherence
  };
}

/** Excite the observer with the cue and tick once — the exact recognition
 *  ask path (wordloop.recallWithCue). */
function excite(session: ObserverSession, cue: string): void {
  session.observeText(cue);
  session.observer.tick(0.02);
}

function isFlatRouter(scores: readonly number[]): boolean {
  return (
    topTwoMargin(scores) < CDE_REGIME_DEFAULTS.topTwoMargin &&
    topTwoThreeMargin(scores) < CDE_REGIME_DEFAULTS.topTwoThreeMargin
  );
}

function wordRecalls(session: ObserverSession, word: string, topK: number): RecallResultLike[] {
  return session.recall(word, topK).filter((r) => r.trace.metadata?.kind === undefined);
}

/** One K: train, restore, measure (a)–(d), and optionally the fuzz pass. */
async function measureOneK(options: ShardRouteBenchOptions, k: number, report: (message: string) => void): Promise<ShardRouteMeasurement> {
  const total = Math.min(ACTIVE_DECK.length, options.wordsPerShard * k);
  const per = Math.max(1, Math.floor(total / k));
  const slice = ACTIVE_DECK.slice(0, per * k).map((e) => ({ ...e }));
  const shards: DeckWord[][] = [];
  for (let i = 0; i < slice.length; i += per) shards.push(slice.slice(i, i + per));
  report(`[route-bench] K=${k}: training ${shards.length} shards x ${per} words (${slice.length} total)`);

  const train = options.train ?? trainSequential;
  const records = await train(shards);
  const homes = wordHomes(records);
  const probes = probeWords(slice, homes, options.probeCount);

  // ── Sharded side ────────────────────────────────────────────────────────
  const { session, bank } = await buildShardedSession(records, false);
  report(`[route-bench] K=${k}: sharded bank restored (${bank.shardAudit().length} shards)`);

  let routingTop1 = 0;
  let routingTop2 = 0;
  let routingTop1Primes = 0;
  let routingTop2Primes = 0;
  let routingTop1Exact = 0;
  let inShard = 0;
  let effective = 0;
  let routedAsks = 0;
  let flatTrueCues = 0;
  let measured = 0;
  // Read once: shardAudit computes per-shard entropy via the neighbor graph
  // (O(shard²)) — per-probe it would dominate the whole bench.
  const audit = bank.shardAudit();
  for (const word of probes) {
    const home = homes.get(word);
    const vocabPrimes = OBSERVER_OPTIONS.vocabulary[word];
    if (home === undefined || vocabPrimes === undefined || vocabPrimes.length === 0) continue;
    excite(session, word);
    const queryPrimes = vocabPrimes.filter((p) => p > 0);
    const query = fullQuery(session, queryPrimes);
    measured += 1;

    // (a) routing accuracy — the router's top pick and top-2 coverage.
    const scores = bank.routeScores(query);
    let top1 = 0;
    for (let i = 1; i < scores.length; i += 1) if (scores[i] > scores[top1]) top1 = i;
    if (top1 === home.shard) routingTop1 += 1;
    const ranked = scores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
    if (ranked.slice(0, 2).some((entry) => entry.index === home.shard)) routingTop2 += 1;
    if (isFlatRouter(scores)) flatTrueCues += 1;

    // (a') the proposal's free first-stage score: prime-overlap routing with
    // routeFor's tie-break (ties → the larger shard, then the earlier index).
    const primeScores = bank.routeScores({ primes: queryPrimes });
    let primeTop1 = 0;
    for (let i = 1; i < primeScores.length; i += 1) {
      if (primeScores[i] > primeScores[primeTop1] || (primeScores[i] === primeScores[primeTop1] && audit[i].traces > audit[primeTop1].traces)) {
        primeTop1 = i;
      }
    }
    if (primeTop1 === home.shard) routingTop1Primes += 1;
    const primeRanked = primeScores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
    if (primeRanked.slice(0, 2).some((entry) => entry.index === home.shard)) routingTop2Primes += 1;

    // (a'') the router's ceiling: route with the TRUE trace's own stored
    // orientation as the cue. A perfect cue removes the live-field imprint
    // from the equation — if this is also ~random, the shards' prototypes
    // carry no discriminative information for the partition.
    const trueTrace = bank.get(home.traceId) as { smf?: SedenionMemoryField } | undefined;
    if (trueTrace?.smf !== undefined) {
      const exactScores = bank.routeScores({ smf: trueTrace.smf, primes: queryPrimes });
      let exactTop1 = 0;
      for (let i = 1; i < exactScores.length; i += 1) if (exactScores[i] > exactScores[exactTop1]) exactTop1 = i;
      if (exactTop1 === home.shard) routingTop1Exact += 1;
    }

    // (b) in-shard recall — the home shard's OWN answer.
    const shardAnswer = bank.recallIn(home.shard, query, 5);
    if (shardAnswer.length > 0 && shardAnswer[0].trace.id === home.traceId) inShard += 1;

    // (c) effective recall — the end-to-end routed answer.
    const answers = wordRecalls(session, word, 5);
    if (answers.length === 0) routedAsks += 1;
    else if (answers[0].trace.id === home.traceId) effective += 1;
  }

  // (d) latency — a second pass measuring only the ask path.
  const tSharded = performance.now();
  for (const word of probes) {
    excite(session, word);
    session.recall(word, 5);
  }
  const shardedAskMs = (performance.now() - tSharded) / probes.length;

  const shardAudit = bank.shardAudit();

  // ── Merged baseline (the 94.6% path) ────────────────────────────────────
  const mergedRecord = mergeRecords(records);
  const mergedSession = new ObserverSession(OBSERVER_OPTIONS, 100);
  await mergedSession.initialize();
  const mergedTeacher = new TeacherAgent(mergedSession, slice);
  mergedTeacher.importBootstrap(mergedRecord);
  const mergedHomes = new Map<string, string>();
  for (const state of mergedRecord.wordStates) {
    if (state.traceId !== null) mergedHomes.set(state.word, state.traceId);
  }
  const comparable = probes.filter((word) => mergedHomes.has(word));
  let mergedCorrect = 0;
  for (const word of comparable) {
    excite(mergedSession, word);
    const answers = wordRecalls(mergedSession, word, 5);
    if (answers.length > 0 && answers[0].trace.id === mergedHomes.get(word)) mergedCorrect += 1;
  }
  let mergedAskMs = 0;
  if (comparable.length > 0) {
    const tMerged = performance.now();
    for (const word of comparable) {
      excite(mergedSession, word);
      mergedSession.recall(word, 5);
    }
    mergedAskMs = (performance.now() - tMerged) / comparable.length;
  }

  // ── Fuzz: ON / explicit-OFF / no-flag banks on flat-router distractors ──
  let fuzz: ShardRouteFuzz | null = null;
  if (options.fuzz) {
    fuzz = await measureFuzz(records, probes, homes, report);
  }

  mergedSession.dispose();
  session.dispose();

  return {
    k,
    shardSizes: shardAudit.map((a) => a.traces),
    totalWords: slice.length,
    probes: measured,
    routingTop1: measured === 0 ? 0 : routingTop1 / measured,
    routingTop2: measured === 0 ? 0 : routingTop2 / measured,
    routingTop1Primes: measured === 0 ? 0 : routingTop1Primes / measured,
    routingTop2Primes: measured === 0 ? 0 : routingTop2Primes / measured,
    routingTop1Exact: measured === 0 ? 0 : routingTop1Exact / measured,
    inShardRecall: measured === 0 ? 0 : inShard / measured,
    effectiveRecall: measured === 0 ? 0 : effective / measured,
    productEstimate: measured === 0 ? 0 : (routingTop1 / measured) * (inShard / measured),
    mergedRecall: comparable.length === 0 ? 0 : mergedCorrect / comparable.length,
    shardedAskMs,
    mergedAskMs,
    routedAsks,
    flatTrueCues,
    shardAudit: shardAudit.map((a) => ({ traces: a.traces, entropyBits: a.entropyBits, vocabulary: a.vocabulary, index: a.index })),
    fuzz
  };
}

/**
 * The miss-detector comparison. Three banks from the SAME records: ON
 * (missDetector true), OFF (explicit false), and a no-flag control.
 * Distractors are signature-level fuzz cues — one prime from each of three
 * different shards — admitted only when the router's distribution over
 * them is measurably FLAT, so an empty ON answer is the detector, not a
 * weak distractor.
 */
async function measureFuzz(
  records: readonly BootstrapRecord[],
  probes: readonly string[],
  homes: Map<string, { shard: number; traceId: string }>,
  report: (message: string) => void
): Promise<ShardRouteFuzz> {
  const k = records.length;
  const on = await buildShardedSession(records, true);
  const off = await buildShardedSession(records, false);
  const noFlag = await buildShardedSession(records, undefined);

  // Per-shard probe words (for drawing primes from other shards).
  const byShard = new Map<number, string[]>();
  for (const word of probes) {
    const home = homes.get(word);
    if (home === undefined) continue;
    const list = byShard.get(home.shard) ?? [];
    list.push(word);
    byShard.set(home.shard, list);
  }

  const flatDistractors: number[][] = [];
  for (const word of probes) {
    const home = homes.get(word);
    const wPrimes = OBSERVER_OPTIONS.vocabulary[word];
    if (home === undefined || wPrimes === undefined || wPrimes.length === 0) continue;
    const otherA = byShard.get((home.shard + 1) % k) ?? [];
    const otherB = byShard.get((home.shard + 2) % k) ?? [];
    if (otherA.length === 0 || otherB.length === 0) continue;
    const primeA = OBSERVER_OPTIONS.vocabulary[otherA[0]]?.[0];
    const primeB = OBSERVER_OPTIONS.vocabulary[otherB[0]]?.[0];
    if (primeA === undefined || primeB === undefined) continue;
    const candidate = [wPrimes[0], primeA, primeB];
    if (candidate.some((p) => p <= 0)) continue;
    // Admit only flat-router distractors: the detector's contract applies
    // exactly where the router does not know where the cue lives.
    if (isFlatRouter(off.bank.routeScores({ primes: candidate }))) {
      flatDistractors.push(candidate);
      if (flatDistractors.length >= 32) break;
    }
  }

  let offConfident = 0;
  let onConfident = 0;
  let identical = true;
  for (const distractor of flatDistractors) {
    const offAnswer = off.bank.recall({ primes: distractor }, 5);
    const onAnswer = on.bank.recall({ primes: distractor }, 5);
    const noFlagAnswer = noFlag.bank.recall({ primes: distractor }, 5);
    if (offAnswer.length > 0) offConfident += 1;
    if (onAnswer.length > 0) onConfident += 1;
    if (
      offAnswer.map((r) => ({ content: r.trace.content, score: r.score })).length !== noFlagAnswer.length ||
      !offAnswer.every(
        (r, i) => r.trace.content === noFlagAnswer[i].trace.content && r.score === noFlagAnswer[i].score
      )
    ) {
      identical = false;
    }
  }

  // The detector's recall cost on TRUE cues: words the OFF bank answers
  // correctly that the ON bank turns into asks.
  let offCorrect = 0;
  let onCorrect = 0;
  for (const word of probes.slice(0, 64)) {
    const home = homes.get(word);
    if (home === undefined) continue;
    excite(off.session, word);
    const offAnswers = wordRecalls(off.session, word, 5);
    if (offAnswers.length > 0 && offAnswers[0].trace.id === home.traceId) offCorrect += 1;
    excite(on.session, word);
    const onAnswers = wordRecalls(on.session, word, 5);
    if (onAnswers.length > 0 && onAnswers[0].trace.id === home.traceId) onCorrect += 1;
  }

  report(
    `[route-bench] fuzz: ${flatDistractors.length} flat distractors · OFF confident ${offConfident} · ON confident ${onConfident} · ` +
      `OFF≡no-flag ${identical ? 'bit-identical' : 'DIVERGED'} · detector true-cue cost ${offCorrect - onCorrect}/${Math.min(64, probes.length)}`
  );

  on.session.dispose();
  off.session.dispose();
  noFlag.session.dispose();

  return {
    flatDistractors: flatDistractors.length,
    offConfident,
    onConfident,
    offBitIdenticalToFlagless: identical,
    detectorRecallCost: offCorrect - onCorrect
  };
}

/** Run the bench for every K in order and return one measurement per K. */
export async function runShardRouteBench(options: ShardRouteBenchOptions): Promise<ShardRouteMeasurement[]> {
  const report = options.onProgress ?? ((): void => undefined);
  const results: ShardRouteMeasurement[] = [];
  for (const k of options.ks) {
    report(`[route-bench] §3.2 measurement: K=${k}, ${options.wordsPerShard} words/shard (capped by the deck), ${options.probeCount} probes`);
    results.push(await measureOneK(options, k, report));
  }
  return results;
}

/** One summary table row per K (shared by the CLI and the test log). */
export function summarize(measurement: ShardRouteMeasurement): string[] {
  const m = measurement;
  const lines = [
    `K=${m.k} · shards ${m.shardSizes.join('/')} words (${m.totalWords} total) · ${m.probes} probes`,
    `  routing top-1 ${(m.routingTop1 * 100).toFixed(1)}% · top-2 ${(m.routingTop2 * 100).toFixed(1)}% · prime-overlap top-1 ${(m.routingTop1Primes * 100).toFixed(1)}% · top-2 ${(m.routingTop2Primes * 100).toFixed(1)}% · perfect-cue ceiling ${(m.routingTop1Exact * 100).toFixed(1)}% · in-shard ${(m.inShardRecall * 100).toFixed(1)}%`,
    `  effective ${(m.effectiveRecall * 100).toFixed(1)}% (top1×in-shard product ${(m.productEstimate * 100).toFixed(1)}%) vs merged ${(m.mergedRecall * 100).toFixed(1)}%`,
    `  latency ask ${m.shardedAskMs.toFixed(1)} ms (sharded) vs ${m.mergedAskMs.toFixed(1)} ms (merged) · routed asks ${m.routedAsks} · flat true cues ${m.flatTrueCues}`,
    `  shards: ${m.shardAudit.map((a) => `${a.traces}t/${a.entropyBits.toFixed(1)}b`).join(' | ')}`
  ];
  if (m.fuzz !== null) {
    lines.push(
      `  fuzz: ${m.fuzz.flatDistractors} flat distractors · OFF ${m.fuzz.offConfident} confident wrong-shard answers · ON ${m.fuzz.onConfident} · ` +
        `OFF≡no-flag ${m.fuzz.offBitIdenticalToFlagless ? 'bit-identical' : 'DIVERGED'} · detector true-cue cost ${m.fuzz.detectorRecallCost}`
    );
  }
  return lines;
}
