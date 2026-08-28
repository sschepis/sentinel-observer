/**
 * @jest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { DECK_100 } from './decks/en-100';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';

const BENCH_WORDS = 30;

/**
 * Phase-2 acceptance metric (docs/SCALING.md): top-1 recall accuracy with
 * whole-word prime signatures on a 32-prime field. The observer is taught
 * each word once, then quizzed (recognition) — its answer is graded by
 * trace identity. The CI gate is the measured floor; the real number is
 * reported in the test output.
 */
describe('recall accuracy benchmark (30 words, whole-word signatures)', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeAll(async () => {
    const deck = DECK_100.slice(0, BENCH_WORDS);
    session = new ObserverSession(
      { primeCount: 32, gridSize: 64, vocabulary: deckVocabulary(deck, PRIME_SPACE) },
      100
    );
    await session.initialize();
    teacher = new TeacherAgent(session, deck);
  });

  afterAll(() => {
    session.dispose();
  });

  it('the observer answers with the right word for most cues', async () => {
    let correct = 0;
    const confused: string[] = [];

    for (const entry of DECK_100.slice(0, BENCH_WORDS)) {
      teacher.teach(entry.word);
    }

    const words = teacher.listWords().filter((w) => w.traceId !== null);
    for (const state of words) {
      const answer = teacher.ask(state.word.word, 'recognition');
      if (answer.recall !== null && answer.recall.trace.id === state.traceId) {
        correct += 1;
      } else {
        const got = answer.recall !== null ? answer.recall.trace.content.slice(0, 20) : 'blank';
        confused.push(`${state.word.word} -> ${got}`);
      }
    }

    const accuracy = correct / words.length;
    // eslint-disable-next-line no-console
    console.log(`\nBENCH: top-1 recognition accuracy ${(accuracy * 100).toFixed(1)}% (${correct}/${words.length})`);
    for (const line of confused.slice(0, 8)) {
      // eslint-disable-next-line no-console
      console.log(`BENCH confusion: ${line}`);
    }

    // The honest CI floor: whole-word signatures on a 32-prime field must
    // clear 70% — the 16-prime char-hash encoding could not guarantee this.
    expect(accuracy).toBeGreaterThanOrEqual(0.7);
  }, 60000);
});
