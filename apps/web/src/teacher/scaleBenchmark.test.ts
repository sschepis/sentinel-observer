/**
 * @jest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { PRIME_SPACE, deckVocabulary, primeSignature } from './primeSignature';

const SCALE_WORDS = 500;

function syntheticDeck(count: number): Array<{ word: string; definition: string; example: string }> {
  return Array.from({ length: count }, (_, i) => {
    const word = `w${i + 1}`;
    return { word, definition: `meaning of ${word}`, example: `${word} in a sentence.` };
  });
}

/**
 * Phase-3 acceptance metric (docs/SCALING.md): the COMPACT memory bank at
 * 500 words — top-1 recognition accuracy, recall latency, and the serialized
 * footprint that makes browser residency viable.
 */
describe('compact-bank scale benchmark (500 words)', () => {
  let session: ObserverSession;

  beforeAll(async () => {
    const deck = syntheticDeck(SCALE_WORDS);
    session = new ObserverSession(
      { primeCount: 32, gridSize: 64, memoryMode: 'compact', vocabulary: deckVocabulary(deck, PRIME_SPACE) },
      100
    );
    await session.initialize();

    for (const entry of deck) {
      session.settleField();
      session.observeText(entry.word);
      session.observer.tick(0.02);
      session.storeMemory(`${entry.word}: ${entry.definition}`);
    }
  }, 180000);

  afterAll(() => {
    session.dispose();
  });

  it('recalls the right word for most cues, fast, with a lean footprint', () => {
    const deck = syntheticDeck(SCALE_WORDS);
    const bank = session.observer.getMemoryBank();
    const traceByWord = new Map<string, string>();
    for (const trace of bank.all()) {
      const word = trace.content.split(':')[0];
      traceByWord.set(word, trace.id);
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

    // Serialized footprint: the whole bank as the persistence layer sees it.
    let footprintBytes = 0;
    for (const trace of bank.all()) {
      footprintBytes += JSON.stringify(bank.serializeTrace(trace.id)).length;
    }

    // eslint-disable-next-line no-console
    console.log(`\nSCALE-500: accuracy ${(accuracy * 100).toFixed(1)}% (${correct}/${deck.length})`);
    // eslint-disable-next-line no-console
    console.log(`SCALE-500: recall latency mean ${meanLatency.toFixed(1)}ms, max ${maxLatency.toFixed(1)}ms`);
    // eslint-disable-next-line no-console
    console.log(`SCALE-500: serialized footprint ${(footprintBytes / 1024).toFixed(1)} KB (${(footprintBytes / deck.length).toFixed(0)} B/trace)`);

    // CI gates: discrimination, interactivity, and memory residency.
    expect(accuracy).toBeGreaterThanOrEqual(0.7);
    expect(meanLatency).toBeLessThan(100);
    expect(maxLatency).toBeLessThan(500);
    expect(footprintBytes / deck.length).toBeLessThan(2048);
  }, 180000);
});
