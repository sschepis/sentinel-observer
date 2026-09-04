#!/usr/bin/env node
/**
 * SCALE BENCH — the two experiments that decide how the observer scales.
 *
 * 1. PRIME-SPACE capacity physics: Kuramoto coupling in tinyaleph is O(N²)
 *    per tick (`kuramotoCoupling` loops all oscillators for each oscillator),
 *    so a bigger basis is exponentially more expensive per tell AND the only
 *    thing that buys vocabulary headroom. We measure recall, collisions, and
 *    per-tick cost at P ∈ {256, 512, 1024} × vocab up to 100k.
 *
 * 2. SHARD-TRAIN-MERGE: teach K disjoint deck shards in PARALLEL workers
 *    (each a full observer over a shared vocabulary → compatible traces),
 *    merge the exports into one bootstrap record, restore into one observer,
 *    and compare recall + wall-clock against sequential training on the same
 *    words. This is the throughput path to a larger system.
 *
 * Usage:
 *   npx tsx src/cli/scale-bench.ts [--prime-bench] [--shard-bench]
 *     [--route-bench]
 *     --words N       slice size for the shard bench (default 1200)
 *     --shards K      worker count (default 4)
 *     --shard-words N words per shard for the route bench (default 5000)
 *     --probes N      probe count for the route bench (default 400)
 *     --no-fuzz       skip the route bench's miss-detector fuzz pass
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import { deckVocabulary, auditDeck, firstPrimes } from '../teacher/primeSignature';
import { MemoryPersistenceStore } from '../persistence/store';
import { ShardTrainer, mergeRecords } from '../teacher/shardTrainer';
import { runShardRouteBench, summarize } from '../teacher/shardRouteBench';
import type { BootstrapRecord } from '../teacher/bootstrap';
import type { DeckWord } from '../teacher/deck';

const args = process.argv.slice(2);
const RUN_PRIME = args.includes('--prime-bench');
const RUN_SHARD = args.includes('--shard-bench');
const RUN_ROUTE = args.includes('--route-bench');
const RUN_SEARCH = args.includes('--search-bench');
const BOTH = !RUN_PRIME && !RUN_SHARD && !RUN_ROUTE && !RUN_SEARCH ? true : false;
const WORDS = Number(args[args.indexOf('--words') + 1] ?? 1200);
const SHARDS = Number(args[args.indexOf('--shards') + 1] ?? 4);
const argValue = (flag: string, fallback: number): number => {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : fallback;
};
const SHARD_WORDS = argValue('--shard-words', 5000);
const PROBES = argValue('--probes', 400);
const RUN_FUZZ = !args.includes('--no-fuzz');

// ────────────────────────────────────────────────────────────────────────────
// PRIME-SPACE BENCH
// ────────────────────────────────────────────────────────────────────────────

interface PrimeConfig {
  primeCount: number;
  gridSize: number;
  vocabSize: number;
}

// The holographic basis needs one integer wavenumber per prime inside the
// grid, so primeCount < gridSize is enforced by the engine — P=512 rides on
// grid 1024, P=1024 on grid 2048 (MAX_GRID_SIZE 4096 permits this).
const PRIME_CONFIGS: PrimeConfig[] = [
  { primeCount: 256, gridSize: 512, vocabSize: 20000 }, // app baseline
  { primeCount: 512, gridSize: 1024, vocabSize: 50000 },
  { primeCount: 1024, gridSize: 2048, vocabSize: 50000 },
  { primeCount: 1024, gridSize: 2048, vocabSize: 100000 }
];

const SAMPLE = 400;

/** Recognition recall over `deck` (teach-everything, then ask-grade). */
async function recognitionRecall(deck: readonly DeckWord[], primeCount: number, gridSize: number, vocabulary: Record<string, number[]>): Promise<{ recall: number; teachMs: number; tickMs: number }> {
  // Initialization is measured outside the timings.
  const session = new ObserverSession({ ...OBSERVER_OPTIONS, primeCount, gridSize, vocabulary });
  await session.initialize();
  const startTick = performance.now();
  for (let i = 0; i < 10; i += 1) session.observer.tick(0.02);
  const tickMs = (performance.now() - startTick) / 10;

  const startTeach = performance.now();
  const teacher = new TeacherAgent(session, deck, new MemoryPersistenceStore(), 500);
  for (const entry of deck) teacher.teach(entry.word);
  const teachMs = (performance.now() - startTeach) / deck.length;

  let correct = 0;
  for (const entry of deck) {
    const q = teacher.ask(entry.word, 'recognition');
    if (teacher.grade(entry.word, q).verdict === 'correct') correct += 1;
  }
  session.dispose();
  return { recall: (correct / deck.length) * 100, teachMs, tickMs };
}

async function primeBench(): Promise<void> {
  console.log('[scale] PRIME-SPACE bench — O(N²) Kuramoto coupling means every prime doubles the per-tick cost; measured below.');
  for (const cfg of PRIME_CONFIGS) {
    const space = firstPrimes(cfg.primeCount);
    const synthetic = Array.from({ length: cfg.vocabSize }, (_, i) => ({ word: `w${String(i + 1).padStart(6, '0')}` }));
    const vocabulary = deckVocabulary(synthetic, space);
    const audit = auditDeck(synthetic, space);
    const deck: DeckWord[] = synthetic.slice(0, SAMPLE).map((entry) => ({
      word: entry.word,
      definition: 'a synthetic benchmark word',
      example: ''
    }));
    const { recall, teachMs, tickMs } = await recognitionRecall(deck, cfg.primeCount, cfg.gridSize, vocabulary);
    console.log(
      `[scale]   P=${String(cfg.primeCount).padStart(4)} grid=${cfg.gridSize} vocab=${String(cfg.vocabSize).padStart(6)}: ` +
      `tick ${tickMs.toFixed(2)}ms · teach ${teachMs.toFixed(2)}ms/word · recall ${recall.toFixed(1)}% · collisions ${audit.valid ? 0 : audit.collisions.length}`
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SHARD-TRAIN-MERGE BENCH
// ────────────────────────────────────────────────────────────────────────────

/** Split the deck into K contiguous shards. */
function shardsOf(deck: readonly DeckWord[], k: number): DeckWord[][] {
  const out: DeckWord[][] = [];
  const per = Math.ceil(deck.length / k);
  for (let i = 0; i < deck.length; i += per) out.push(deck.slice(i, i + per));
  return out;
}

async function shardBench(): Promise<void> {
  const slice = ACTIVE_DECK.slice(0, WORDS).map((e) => ({ ...e }));
  const shards = shardsOf(slice, SHARDS);
  const sample = slice.slice(0, 120).map((e) => e.word);

  // Sequential baseline: one observer, teach everything, probe. The timer
  // starts BEFORE initialization — the sharded timer already includes esbuild
  // bundling + worker init, so the sequential side must measure its full path
  // (session construction + initialize + teach) for the comparison to be fair.
  const tSeq = performance.now();
  const seqSession = new ObserverSession(OBSERVER_OPTIONS, 100);
  await seqSession.initialize();
  const seqTeacher = new TeacherAgent(seqSession, slice, new MemoryPersistenceStore(), 500);
  for (const entry of slice) seqTeacher.teach(entry.word);
  const seqMs = performance.now() - tSeq;
  let seqCorrect = 0;
  for (const word of sample) {
    const q = seqTeacher.ask(word, 'recognition');
    if (seqTeacher.grade(word, q).verdict === 'correct') seqCorrect += 1;
  }
  seqSession.dispose();
  console.log(`[scale]   sequential: ${slice.length} words · ${(seqMs / 1000).toFixed(1)}s · recall ${((seqCorrect / sample.length) * 100).toFixed(1)}%`);

  // Sharded: persistent worker pool (no cold start — the production path).
  const tShard = performance.now();
  const trainer = new ShardTrainer(SHARDS);
  const records = await trainer.train(shards);
  const shardMs = performance.now() - tShard;
  await trainer.dispose();
  const merged = mergeRecords(records);

  const mergeSession = new ObserverSession(OBSERVER_OPTIONS, 100);
  await mergeSession.initialize();
  const mergeTeacher = new TeacherAgent(mergeSession, slice, new MemoryPersistenceStore(), 500);
  const result = mergeTeacher.importBootstrap(merged);
  let mergeCorrect = 0;
  for (const word of sample) {
    const q = mergeTeacher.ask(word, 'recognition');
    if (mergeTeacher.grade(word, q).verdict === 'correct') mergeCorrect += 1;
  }
  mergeSession.dispose();
  console.log(
    `[scale]   sharded (${SHARDS}×${Math.ceil(slice.length / SHARDS)}, persistent pool): ${(shardMs / 1000).toFixed(1)}s · ` +
    `recall ${((mergeCorrect / sample.length) * 100).toFixed(1)}% · restored ${result.restored}/${merged.traces.length} traces · ` +
    `speedup ${(seqMs / Math.max(1, shardMs)).toFixed(1)}× · recall delta ${((mergeCorrect - seqCorrect) / sample.length * 100).toFixed(1)}pp`
  );
}

// ────────────────────────────────────────────────────────────────────────────
// SHARD-ROUTE BENCH (§3.2) — K shards as separate query-time banks + a
// router, against the merged single-bank baseline (94.6% @ 20k).
// ────────────────────────────────────────────────────────────────────────────

async function routeBench(): Promise<void> {
  console.log(
    `[scale] SHARD-ROUTE bench (§3.2) — routed shards vs merged baseline; K ∈ {4, 8}, ` +
      `${SHARD_WORDS} words/shard (deck-capped), ${PROBES} probes, fuzz ${RUN_FUZZ ? 'on' : 'off'}.`
  );
  const measurements = await runShardRouteBench({
    wordsPerShard: SHARD_WORDS,
    ks: [4, 8],
    probeCount: PROBES,
    fuzz: RUN_FUZZ,
    // The parallel worker pool (the shard trainer's production path) — the
    // engine's default is the sequential in-process loop that jest requires.
    train: async (shards) => {
      const trainer = new ShardTrainer(shards.length);
      const records = await trainer.train(shards);
      await trainer.dispose();
      return records;
    },
    onProgress: (message) => {
      console.log(message);
    }
  });
  console.log('\n[scale] SHARD-ROUTE verdict (§3.6):');
  for (const measurement of measurements) {
    for (const line of summarize(measurement)) {
      console.log(`[scale]   ${line}`);
    }
    const verdict =
      measurement.effectiveRecall >= measurement.mergedRecall
        ? 'PASS — effective recall meets or exceeds the merged baseline'
        : `REFUTE — effective recall ${(measurement.effectiveRecall * 100).toFixed(1)}% below merged ${(measurement.mergedRecall * 100).toFixed(1)}%`;
    console.log(`[scale]   → ${verdict}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// DENSE-BANK SEARCH BENCH — where the latency cliff lives
// ────────────────────────────────────────────────────────────────────────────

const SEARCH_SIZES = [2000, 10000, 20000];

async function searchBench(): Promise<void> {
  console.log('[scale] DENSE-BANK bench — ask latency vs bank size (via sharded training)…');
  for (const size of SEARCH_SIZES) {
    const slice = ACTIVE_DECK.slice(0, size).map((e) => ({ ...e }));
    const per = Math.ceil(slice.length / 4);
    const split: DeckWord[][] = [];
    for (let i = 0; i < slice.length; i += per) split.push(slice.slice(i, i + per));
    const trainer = new ShardTrainer(4);
    const records = await trainer.train(split);
    await trainer.dispose();
    const merged = mergeRecords(records);

    const session = new ObserverSession(OBSERVER_OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, slice, new MemoryPersistenceStore(), 500);
    teacher.importBootstrap(merged);

    // Recognition ask latency (settle + prefiltered recall) over a sample.
    const sample = slice.slice(0, 300).map((e) => e.word);
    const t0 = performance.now();
    let correct = 0;
    for (const word of sample) {
      const q = teacher.ask(word, 'recognition');
      if (teacher.grade(word, q).verdict === 'correct') correct += 1;
    }
    const askMs = (performance.now() - t0) / sample.length;

    // Full chat-answer latency (definition operator) over another sample.
    const defined = slice.filter((e) => e.definition.trim().length > 0).slice(0, 100);
    const t1 = performance.now();
    for (const e of defined) teacher.chatAnswer(`what is ${e.word}`);
    const chatMs = (performance.now() - t1) / defined.length;

    console.log(
      `[scale]   ${String(size).padStart(5)} traces: ask ${askMs.toFixed(1)}ms · chatAnswer ${chatMs.toFixed(1)}ms · recall ${((correct / sample.length) * 100).toFixed(1)}%`
    );
    session.dispose();
  }
}

// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (BOTH || RUN_PRIME) await primeBench();
  if (BOTH || RUN_SHARD) await shardBench();
  if (BOTH || RUN_ROUTE) await routeBench();
  if (BOTH || RUN_SEARCH) await searchBench();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});