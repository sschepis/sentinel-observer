#!/usr/bin/env node
/**
 * SMF WIDTH SWEEP — the P3 measurement.
 *
 * The projection-bottleneck fix replaces the `axis = j mod 16` fold in the SMF
 * imprint with a seeded signed random projection and makes the sketch width
 * configurable. This bench measures top-1 recognition at 1,000 and 20,000
 * words across widths {16, 64, 128, 256}, plus the fold-vs-projection A/B at
 * width 16 and the serialized footprint (the 2048 B/trace gate).
 *
 * Usage:
 *   npm run smf-width-bench
 */
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { DECK_1000 } from '../teacher/decks/en-1000';
import { DECK_20000 } from '../teacher/decks/en-20000';
import { PRIME_SPACE, deckVocabulary } from '../teacher/primeSignature';

interface Config {
  label: string;
  smfWidth: number;
  smfProjection: boolean;
}

const CONFIGS: Config[] = [
  { label: 'fold-16', smfWidth: 16, smfProjection: false },
  { label: 'jl-16', smfWidth: 16, smfProjection: true },
  { label: 'jl-64', smfWidth: 64, smfProjection: true },
  { label: 'jl-128', smfWidth: 128, smfProjection: true },
  { label: 'jl-256', smfWidth: 256, smfProjection: true }
];

interface Scale1000Result {
  accuracy: number;
  meanLatency: number;
  maxLatency: number;
  footprintBytes: number;
  confusions: string[];
  restoredAccuracy: number;
}

async function scale1000(cfg: Config): Promise<Scale1000Result> {
  const deck = DECK_1000.slice(0, 1000);
  const session = new ObserverSession(
    {
      primeCount: 64,
      gridSize: 128,
      memoryMode: 'compact',
      smfWidth: cfg.smfWidth,
      smfProjection: cfg.smfProjection,
      vocabulary: deckVocabulary(deck, PRIME_SPACE)
    },
    100
  );
  await session.initialize();

  for (const entry of deck) {
    session.settleField();
    session.observeText(entry.word);
    session.observer.tick(0.02);
    session.storeMemory(entry.word);
  }

  const bank = session.observer.getMemoryBank();
  const traceByWord = new Map<string, string>();
  for (const trace of bank.all()) traceByWord.set(trace.content, trace.id);

  let correct = 0;
  const latencies: number[] = [];
  const confusions: string[] = [];
  for (const entry of deck) {
    session.settleField();
    session.observeText(entry.word);
    session.observer.tick(0.02);
    const start = performance.now();
    const results = session.recall(entry.word, 5);
    latencies.push(performance.now() - start);
    const top = results[0] ?? null;
    if (top !== null && top.trace.id === traceByWord.get(entry.word)) {
      correct += 1;
    } else {
      confusions.push(`${entry.word} -> ${top ? top.trace.content.slice(0, 18) : 'blank'}`);
    }
  }

  let footprintBytes = 0;
  const serialized = bank.all().map((trace) => bank.serializeTrace(trace.id));
  for (const data of serialized) {
    if (data !== null) footprintBytes += JSON.stringify(data).length;
  }

  // Restore fidelity: re-import the serialized (q8-compact) traces into a
  // fresh bank — the production reload path — and re-quiz the same cues.
  const restoredSession = new ObserverSession(
    {
      primeCount: 64,
      gridSize: 128,
      memoryMode: 'compact',
      smfWidth: cfg.smfWidth,
      smfProjection: cfg.smfProjection,
      vocabulary: deckVocabulary(deck, PRIME_SPACE)
    },
    100
  );
  await restoredSession.initialize();
  const restoredBank = restoredSession.observer.getMemoryBank();
  for (const data of serialized) {
    if (data !== null) restoredBank.restoreTrace(data);
  }
  let restoredCorrect = 0;
  for (const entry of deck) {
    restoredSession.settleField();
    restoredSession.observeText(entry.word);
    restoredSession.observer.tick(0.02);
    const results = restoredSession.recall(entry.word, 5);
    const top = results[0] ?? null;
    if (top !== null && top.trace.id === traceByWord.get(entry.word)) restoredCorrect += 1;
  }
  restoredSession.dispose();

  session.dispose();

  return {
    accuracy: correct / deck.length,
    meanLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    maxLatency: Math.max(...latencies),
    footprintBytes: footprintBytes / deck.length,
    confusions,
    restoredAccuracy: restoredCorrect / deck.length
  };
}

interface Scale20kResult {
  accuracy: number;
  confusions: string[];
}

const SAMPLE_20K = 400;

async function scale20k(cfg: Config): Promise<Scale20kResult> {
  const stride = Math.max(1, Math.floor(DECK_20000.length / SAMPLE_20K));
  const deck = Array.from({ length: SAMPLE_20K }, (_, i) => DECK_20000[i * stride]);
  const session = new ObserverSession(
    {
      primeCount: 256,
      gridSize: 512,
      memoryMode: 'compact',
      memoryCapacity: 30000,
      smfWidth: cfg.smfWidth,
      smfProjection: cfg.smfProjection,
      vocabulary: deckVocabulary(DECK_20000, PRIME_SPACE)
    },
    100
  );
  await session.initialize();
  const teacher = new TeacherAgent(session, deck);

  for (const entry of deck) teacher.teach(entry.word);

  let correct = 0;
  const confusions: string[] = [];
  const words = teacher.listWords().filter((w) => w.traceId !== null);
  for (const state of words) {
    const answer = teacher.ask(state.word.word, 'recognition');
    if (answer.recall !== null && answer.recall.trace.id === state.traceId) {
      correct += 1;
    } else {
      confusions.push(`${state.word.word} -> ${answer.recall ? answer.recall.trace.content.slice(0, 18) : 'blank'}`);
    }
  }
  session.dispose();

  return { accuracy: correct / words.length, confusions };
}

async function main(): Promise<void> {
  console.log('SMF WIDTH SWEEP — fold vs signed random projection at widths 16/64/128/256\n');
  console.log('[scale-1000]   width    top-1   restored   latency(mean/max)    B/trace   confusions');
  console.log('-----------------------------------------------------------------------------------');
  for (const cfg of CONFIGS) {
    const r = await scale1000(cfg);
    const conf = r.confusions.length === 0 ? '0' : r.confusions.length.toString();
    console.log(
      `[scale-1000]   ${cfg.label.padEnd(8)} ${(r.accuracy * 100).toFixed(1).padStart(6)}%  ` +
        `${(r.restoredAccuracy * 100).toFixed(1).padStart(7)}%  ` +
        `${r.meanLatency.toFixed(1)}ms/${r.maxLatency.toFixed(1)}ms  ${r.footprintBytes.toFixed(0).padStart(7)}  ${conf}`
    );
    if (r.confusions.length > 0) {
      for (const line of r.confusions.slice(0, 8)) console.log(`      confusion: ${line}`);
    }
  }

  console.log('\n[scale-20k]    width    top-1     confusions');
  console.log('---------------------------------------------');
  for (const cfg of CONFIGS) {
    const r = await scale20k(cfg);
    console.log(`[scale-20k]    ${cfg.label.padEnd(8)} ${(r.accuracy * 100).toFixed(1).padStart(6)}%  ${r.confusions.length}`);
    for (const line of r.confusions.slice(0, 8)) console.log(`      confusion: ${line}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
