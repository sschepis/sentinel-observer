/**
 * @jest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { DECK_20000 } from './decks/en-20000';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';

const SAMPLE = 400;

/**
 * Production-scale acceptance metric: the compact bank with the PRODUCTION
 * field config (256 primes / 512 grid / 128-dim SMF sketch — docs/SCALING.md
 * §7's "app baseline" after the P3 projection fix) over the FULL 20,000-word
 * frequency deck, probed on a deterministic strided sample of 400 words. This
 * is the scale at which the 16-dim SMF orientation collisions named in
 * SCALING.md §7 stop being a rounding error — it is the explicit gate for the
 * projection-bottleneck work (P3): the sketch width must not regress this
 * number.
 *
 * The CI floor is the same honest 70% as the other benchmarks; the real
 * number is reported in the test output.
 */
describe('production-scale benchmark (20,000-word vocabulary, 400 probes)', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;
  let deck: readonly DeckWord[];

  beforeAll(async () => {
    // Deterministic strided sample across the whole frequency deck: 400 probes
    // spread from the most to the least frequent words, exercising the full
    // vocabulary's discrimination range.
    expect(DECK_20000.length).toBeGreaterThanOrEqual(SAMPLE);
    const stride = Math.max(1, Math.floor(DECK_20000.length / SAMPLE));
    deck = Array.from({ length: SAMPLE }, (_, i) => DECK_20000[i * stride]);

    session = new ObserverSession(
      {
        primeCount: 256,
        gridSize: 512,
        memoryMode: 'compact',
        memoryCapacity: 30000,
        smfWidth: 128,
        vocabulary: deckVocabulary(DECK_20000, PRIME_SPACE)
      },
      100
    );
    await session.initialize();
    teacher = new TeacherAgent(session, deck);

    for (const entry of deck) {
      teacher.teach(entry.word);
    }
  }, 600000);

  afterAll(() => {
    session.dispose();
  });

  it('recalls the right word for most cues at 20,000-word vocabulary scale', () => {
    let correct = 0;
    let probed = 0;
    const confused: string[] = [];

    const words = teacher.listWords().filter((w) => w.traceId !== null);
    for (const state of words) {
      const answer = teacher.ask(state.word.word, 'recognition');
      probed += 1;
      if (answer.recall !== null && answer.recall.trace.id === state.traceId) {
        correct += 1;
      } else {
        const got = answer.recall !== null ? answer.recall.trace.content.slice(0, 20) : 'blank';
        confused.push(`${state.word.word} -> ${got}`);
      }
    }

    const accuracy = correct / probed;
    // eslint-disable-next-line no-console
    console.log(`\nSCALE-20K: top-1 recognition accuracy ${(accuracy * 100).toFixed(1)}% (${correct}/${probed})`);
    for (const line of confused.slice(0, 8)) {
      // eslint-disable-next-line no-console
      console.log(`SCALE-20K confusion: ${line}`);
    }

    expect(accuracy).toBeGreaterThanOrEqual(0.7);
  }, 600000);
});
