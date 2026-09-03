/**
 * L1b Phase 18.1 gate — the SMF imprint weighting flip experiment.
 *
 * 'floor' (legacy): alpha = lr·(0.5 + 0.5·coherence) — even a fully
 * incoherent moment imprints at half rate. 'linear': alpha = lr·coherence —
 * an incoherent moment barely imprints. This gate measures both under the
 * same curriculum and admits 'linear' into production only when:
 *   1. recognition recall is within noise of 'floor', and
 *   2. fuzz false positives (a last-word-swapped distractor answered with
 *      confidence ≥ 0.8) do not regress.
 *
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from './engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { CONVERSATION_DECK } from '../teacher/conversation';
import { DECK_100 } from '../teacher/decks/en-100';
import { PRIME_SPACE, deckVocabulary } from '../teacher/primeSignature';

const BENCH_WORDS = 30;
const BENCH_PAIRS = 10;
const FUZZ_CONFIDENT = 0.8;

interface WeightingMeasure {
  recall: number;
  exactAnswered: number;
  fuzzFalsePositives: number;
}

async function measure(weighting: 'floor' | 'linear'): Promise<WeightingMeasure> {
  const deck = DECK_100.slice(0, BENCH_WORDS);
  const session = new ObserverSession(
    {
      primeCount: 64,
      gridSize: 128,
      smfWidth: 128,
      vocabulary: deckVocabulary(deck, PRIME_SPACE),
      smfImprintWeighting: weighting
    },
    100
  );
  await session.initialize();
  const teacher = new TeacherAgent(session, deck);

  for (const entry of deck) teacher.teach(entry.word);
  let correct = 0;
  const words = teacher.listWords().filter((w) => w.traceId !== null);
  for (const state of words) {
    const answer = teacher.ask(state.word.word, 'recognition');
    if (answer.recall !== null && answer.recall.trace.id === state.traceId) correct += 1;
  }

  const pairs = CONVERSATION_DECK.slice(0, BENCH_PAIRS);
  teacher.teachConversationDeck(pairs);
  let exactAnswered = 0;
  let fuzzFalsePositives = 0;
  for (const pair of pairs) {
    const exact = teacher.respond(pair.cue);
    if (exact.response !== null) exactAnswered += 1;
    // The fuzz rule (§5.2): replace the final word with an unrelated deck
    // word; a distractor answered at ≥ 0.8 confidence is a false positive.
    const tokens = pair.cue.trim().split(/\s+/);
    tokens[tokens.length - 1] = 'water';
    const distractor = teacher.respond(tokens.join(' '));
    if (distractor.response !== null && (distractor.confidence ?? 0) >= FUZZ_CONFIDENT) {
      fuzzFalsePositives += 1;
    }
  }

  session.dispose();
  return { recall: correct / words.length, exactAnswered, fuzzFalsePositives };
}

describe('L1b: SMF imprint weighting gate (floor vs linear)', () => {
  it("'linear' keeps recall within noise of 'floor' and does not regress fuzz false positives", async () => {
    const floor = await measure('floor');
    const linear = await measure('linear');

    // eslint-disable-next-line no-console
    console.log(
      `\nL1b GATE: floor recall ${(floor.recall * 100).toFixed(1)}% · exact ${floor.exactAnswered}/${BENCH_PAIRS} · fuzz FP ${floor.fuzzFalsePositives}` +
        `\nL1b GATE: linear recall ${(linear.recall * 100).toFixed(1)}% · exact ${linear.exactAnswered}/${BENCH_PAIRS} · fuzz FP ${linear.fuzzFalsePositives}`
    );

    expect(linear.recall).toBeGreaterThanOrEqual(floor.recall - 0.1);
    expect(linear.fuzzFalsePositives).toBeLessThanOrEqual(floor.fuzzFalsePositives);
    expect(linear.exactAnswered).toBeGreaterThanOrEqual(floor.exactAnswered - 1);
  }, 240000);
});
