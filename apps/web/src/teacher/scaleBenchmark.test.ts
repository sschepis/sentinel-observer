/**
 * @jest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { DECK_1000 } from './decks/en-1000';

const SCALE_WORDS = 1000;

/**
 * P12: optional competition knobs, so this gate can be re-run with a
 * competition variant ON without changing what it measures. All default to
 * 0, so the gate's own behavior is byte-identical to before.
 */
const COMPETITION = {
  activationBudget: Number(process.env.SCALE_BENCH_BUDGET ?? 0),
  inhibition: Number(process.env.SCALE_BENCH_INHIBITION ?? 0),
  winnerTakeAll: Number(process.env.SCALE_BENCH_WTA ?? 0)
};

/**
 * Phase-3 acceptance metric (docs/SCALING.md) at real-word scale: the
 * COMPACT memory bank with 1,000 REAL English words (word-only traces) —
 * top-1 recognition accuracy, recall latency, and the serialized footprint.
 */
describe('compact-bank scale benchmark (1000 real words)', () => {
  let session: ObserverSession;
  const deck = DECK_1000.slice(0, SCALE_WORDS);

  beforeAll(async () => {
    session = new ObserverSession(
      {
        primeCount: 64,
        gridSize: 128,
        memoryMode: 'compact',
        smfWidth: 128,
        ...COMPETITION,
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
  }, 300000);

  afterAll(() => {
    session.dispose();
  });

  it('recalls the right word for most cues, fast, with a lean footprint', () => {
    const bank = session.observer.getMemoryBank();
    const traceByWord = new Map<string, string>();
    for (const trace of bank.all()) {
      traceByWord.set(trace.content, trace.id);
    }

    let correct = 0;
    const latencies: number[] = [];
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
      }
    }

    const accuracy = correct / deck.length;
    const meanLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const maxLatency = Math.max(...latencies);

    let footprintBytes = 0;
    for (const trace of bank.all()) {
      footprintBytes += JSON.stringify(bank.serializeTrace(trace.id)).length;
    }

    // eslint-disable-next-line no-console
    console.log(`\nSCALE-1000: accuracy ${(accuracy * 100).toFixed(1)}% (${correct}/${deck.length})`);
    // eslint-disable-next-line no-console
    console.log(`SCALE-1000: competition ${JSON.stringify(COMPETITION)}`);
    // eslint-disable-next-line no-console
    console.log(`SCALE-1000: recall latency mean ${meanLatency.toFixed(1)}ms, max ${maxLatency.toFixed(1)}ms`);
    // eslint-disable-next-line no-console
    console.log(`SCALE-1000: serialized footprint ${(footprintBytes / 1024).toFixed(1)} KB (${(footprintBytes / deck.length).toFixed(0)} B/trace)`);

    expect(accuracy).toBeGreaterThanOrEqual(0.7);
    expect(meanLatency).toBeLessThan(100);
    expect(maxLatency).toBeLessThan(500);
    expect(footprintBytes / deck.length).toBeLessThan(2048);
  }, 300000);
});
