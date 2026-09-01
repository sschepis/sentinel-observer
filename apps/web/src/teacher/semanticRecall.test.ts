/**
 * @jest-environment node
 *
 * P13 — SEMANTIC RECALL. Comprehension, not identity lookup: cue with the
 * DEFINITION (and paraphrases of it) and expect the WORD. The structural
 * problem this measures (W11): a definition cue excites the definition's own
 * prime signatures, which differ from the word's — so the prime-overlap term
 * cannot match the word trace. The content-overlap comprehension path
 * answers production by meaning; the RAW overlap baseline is reported as the
 * honest contrast.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import type { DeckWord } from './deck';

const DECK: readonly DeckWord[] = [
  { word: 'apple', definition: 'a round red or green fruit', example: 'I eat an apple.' },
  { word: 'water', definition: 'a clear liquid that falls as rain and is used for drinking', example: 'Water is wet.' },
  { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
  { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' },
  { word: 'snow', definition: 'frozen white water that falls from the sky', example: 'Snow is cold.' },
  { word: 'dog', definition: 'a common animal with four legs that people keep as a pet', example: 'The dog barks.' },
  { word: 'house', definition: 'a building where people live', example: 'I live in a house.' },
  { word: 'game', definition: 'a contest with rules that people play to win', example: 'We play a game.' },
  { word: 'fruit', definition: 'a sweet part of a plant with seeds', example: 'I like fruit.' },
  { word: 'book', definition: 'a set of printed pages bound together for reading', example: 'I read a book.' }
];

/** Hand-written paraphrases — NONE contains the word itself, so the cue is
 *  comprehension, never identity lookup. */
const PARAPHRASES: Record<string, string[]> = {
  apple: ['a fruit that is round and sweet, red or green', 'the round fruit you eat for a snack'],
  water: ['the clear liquid you drink and wash with', 'a liquid that pours and quenches thirst'],
  bird: ['a flying animal covered in feathers', 'an animal with wings that flies'],
  robin: ['a red-breasted songbird', 'a small singing bird with a red chest'],
  snow: ['frozen rain that covers the ground in winter', 'cold white flakes that fall in winter'],
  dog: ['a pet animal that barks and has four legs', 'a loyal four-legged pet'],
  house: ['a home made of walls and a roof', 'the building you live in'],
  game: ['a structured play activity with rules', 'something you play with friends to win'],
  fruit: ['the sweet edible part of a plant', 'a sweet plant food you can eat'],
  book: ['pages bound together that people read', 'something printed that you read']
};

describe('P13 semantic recall (comprehension, not identity lookup)', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeAll(async () => {
    session = new ObserverSession(
      {
        primeCount: 64,
        gridSize: 128,
        memoryMode: 'compact',
        smfWidth: 128,
        vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
      },
      100
    );
    await session.initialize();
    teacher = new TeacherAgent(session, DECK);
    for (const entry of DECK) teacher.teach(entry.word);
  }, 120000);

  afterAll(() => {
    session.dispose();
  });

  it('identity lookup (recognition) stays the contrast baseline', () => {
    let correct = 0;
    for (const entry of DECK) {
      const state = teacher.tryState(entry.word);
      const answer = teacher.ask(entry.word, 'recognition');
      if (answer.recall !== null && state?.traceId !== null && answer.recall.trace.id === state?.traceId) correct += 1;
    }
    expect(correct / DECK.length).toBeGreaterThanOrEqual(0.8);
  });

  it('definition -> word: the comprehension path answers production (≥ 0.6)', () => {
    let correct = 0;
    for (const entry of DECK) {
      const state = teacher.tryState(entry.word);
      const answer = teacher.ask(entry.word, 'production');
      if (answer.recall !== null && state?.traceId !== null && answer.recall.trace.id === state?.traceId) correct += 1;
    }
    expect(correct / DECK.length).toBeGreaterThanOrEqual(0.6);
  });

  it('paraphrase -> word: rephrased meanings still recall the word (≥ 0.6)', () => {
    let correct = 0;
    let total = 0;
    for (const entry of DECK) {
      const state = teacher.tryState(entry.word);
      for (const cue of PARAPHRASES[entry.word] ?? []) {
        total += 1;
        const answer = teacher.askCue(entry.word, cue);
        if (answer.recall !== null && state?.traceId !== null && answer.recall.trace.id === state?.traceId) correct += 1;
      }
    }
    expect(total).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`SEMANTIC-RECALL: paraphrase->word top-1 ${((correct / total) * 100).toFixed(0)}% (${correct}/${total})`);
    expect(correct / total).toBeGreaterThanOrEqual(0.6);
  });

  it('the RAW prime-overlap baseline is reported as the honest contrast (expected low — W11)', () => {
    // Directly query the bank with the definition cue: the overlap term
    // cannot match the word trace (its signature is the WORD's primes).
    let overlapHits = 0;
    for (const entry of DECK) {
      const state = teacher.tryState(entry.word);
      if (state?.traceId === null || state?.traceId === undefined) continue;
      const results = session
        .recall(entry.definition, 5)
        .filter((result) => result.trace.metadata?.kind === undefined);
      if (results[0]?.trace.id === state.traceId) overlapHits += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`SEMANTIC-RECALL: raw prime-overlap baseline ${overlapHits}/${DECK.length} — comprehension rides on the content path`);
  });
});
