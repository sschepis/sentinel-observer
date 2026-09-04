/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { selfQuestions, unansweredSelfQuestions } from './elaboration';
import type { DeckWord } from './deck';
import type { Relation } from './relations';

const RELATIONS: Relation[] = [
  { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
  { subject: 'bird', predicate: 'is-a', object: 'creature', source: 'def', origin: 'regex' },
  { subject: 'bird', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
  { subject: 'bird', predicate: 'has-part', object: 'feathers', source: 'def', origin: 'regex' },
  { subject: 'wings', predicate: 'used-for', object: 'flight', source: 'def', origin: 'chaperone' }
];

const DECK: readonly DeckWord[] = [
  { word: 'water', definition: 'a clear liquid that falls as rain', example: 'Water is wet.' },
  { word: 'bird', definition: 'an animal with wings', example: 'A bird can fly.' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

async function setup(): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, DECK);
  return { session, teacher };
}

describe('self-question-bench (§8.3)', () => {
  it('generates the follow-up questions an elaboration raises', () => {
    const questions = selfQuestions('robin', RELATIONS);
    const texts = questions.map((q) => q.question);
    expect(texts).toContain('what is a bird?');
    expect(texts).toContain('what are wings for?');
    expect(texts).toContain('what are feathers for?');
    // "what is a bird?" is answerable (bird still has frames); wings has a
    // used-for edge; feathers does not.
    const byText = new Map(questions.map((q) => [q.question, q]));
    expect(byText.get('what is a bird?')!.answerable).toBe(true);
    expect(byText.get('what are wings for?')!.answerable).toBe(true);
    expect(byText.get('what are feathers for?')!.answerable).toBe(false);
  });

  it('unanswerable follow-ups are the curiosity-gap feed', () => {
    expect(unansweredSelfQuestions('robin', RELATIONS)).toEqual(['what are feathers for?']);
  });

  it('a thin graph raises no questions — and no gaps', () => {
    expect(selfQuestions('robin', [])).toEqual([]);
    expect(unansweredSelfQuestions('robin', [])).toEqual([]);
  });
});

describe('inward questions become curiosity gaps through the existing recordGap path', () => {
  it('unanswerable follow-ups are recorded as gaps', async () => {
    const { session, teacher } = await setup();
    expect(teacher.listGaps()).toHaveLength(0);
    const gaps = teacher.recordSelfQuestionGaps('robin', RELATIONS);
    expect(gaps).toEqual(['what are feathers for?']);
    expect(teacher.listGaps()).toContain('what are feathers for?');
    session.dispose();
  });

  it('a thin graph records no gaps', async () => {
    const { session, teacher } = await setup();
    const gaps = teacher.recordSelfQuestionGaps('robin', []);
    expect(gaps).toEqual([]);
    expect(teacher.listGaps()).toHaveLength(0);
    session.dispose();
  });

  it('a fully answerable graph records no gaps (nothing to ask for)', async () => {
    const { session, teacher } = await setup();
    const FULL: Relation[] = [
      ...RELATIONS,
      { subject: 'feathers', predicate: 'used-for', object: 'warmth', source: 'def', origin: 'chaperone' }
    ];
    const gaps = teacher.recordSelfQuestionGaps('robin', FULL);
    expect(gaps).toEqual([]);
    expect(teacher.listGaps()).toHaveLength(0);
    session.dispose();
  });
});
