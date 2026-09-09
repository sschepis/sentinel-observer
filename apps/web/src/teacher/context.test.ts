/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { WorkingMemory, resolveReferences, lastEntity, extractUnknownSubject } from './context';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { DECK_100 } from './decks/en-100';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';

const WORD_DECK: readonly DeckWord[] = [
  { word: 'apple', definition: 'a round fruit', example: 'I eat an apple.' },
  { word: 'water', definition: 'a clear liquid', example: 'I drink water.' },
  { word: 'hello', definition: 'a greeting', example: 'Hello there!' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...WORD_DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

describe('working memory', () => {
  it('keeps only the most recent turns (ring buffer)', () => {
    const memory = new WorkingMemory(3);
    memory.note('user', 'a');
    memory.note('observer', 'b');
    memory.note('user', 'c');
    memory.note('observer', 'd');
    expect(memory.all().map((t) => t.text)).toEqual(['b', 'c', 'd']);
  });

  it('ignores empty turns', () => {
    const memory = new WorkingMemory(3);
    memory.note('user', '   ');
    expect(memory.all()).toHaveLength(0);
  });
});

describe('reference resolution', () => {
  it('resolves a pronoun to the last entity mentioned', () => {
    const window = [{ role: 'user' as const, text: 'I like apples.', at: 1 }];
    expect(resolveReferences('what about it?', window)).toBe('what about apple?');
    expect(resolveReferences('do you like that too?', window)).toBe('do you like apple too?');
  });

  it('prefers the human\'s words over the observer\'s own replies', () => {
    const window = [
      { role: 'user' as const, text: 'I like apples.', at: 1 },
      { role: 'observer' as const, text: 'Apples are tasty.', at: 2 }
    ];
    expect(lastEntity(window)).toBe('apple');
    expect(resolveReferences('what about it?', window)).toBe('what about apple?');
  });

  it('never rewrites a pronoun to a word the observer does not know', () => {
    // THE 2026-09-09 BENCH FINDING. A word-problem turn ended on "than"
    // ("how many more push-ups … than David"), so the next question's
    // pronouns were rewritten to it: "her friend had 23 games" became "than
    // friend had 23 games", and the observer answered a sentence no reader
    // could parse. Two things now prevent it — "than" is grammatical
    // vocabulary and can never be a referent, and a referent the observer
    // does not know is not substituted at all.
    const window = [{ role: 'user' as const, text: 'How many more push-ups did Zachary do than David?', at: 1 }];
    const asked = 'Katie had 72 games and her friend had 23 games. How many do they have total?';
    // "than" is grammatical vocabulary: never a referent, whatever the
    // observer's vocabulary says.
    expect(lastEntity(window)).not.toBe('than');
    // And this utterance names its own subject before the pronoun, so
    // nothing from the previous turn is substituted into it at all.
    expect(resolveReferences(asked, window, () => true)).toBe(asked);
    expect(resolveReferences(asked, window, (word) => word !== 'david')).toBe(asked);
    // And an entity the observer has no word for is left alone.
    const unknown = [{ role: 'user' as const, text: 'A zebu.', at: 1 }];
    expect(resolveReferences('what about it?', unknown, (word) => word !== 'zebu')).toBe('what about it?');
    expect(resolveReferences('what about it?', unknown, (word) => word === 'zebu')).toBe('what about zebu?');
  });

  it('keeps a possessive phrase intact — "her friend" is not an anaphor', () => {
    const window = [{ role: 'user' as const, text: 'I like apples.', at: 1 }];
    const known = (word: string) => word === 'apple';
    expect(resolveReferences('her friend ate one', window, known)).toBe('her friend ate one');
    expect(resolveReferences('this page is nice', window, known)).toBe('this page is nice');
    // A bare pronoun still resolves.
    expect(resolveReferences('what about it?', window, known)).toBe('what about apple?');
    expect(resolveReferences('do you like them?', window, known)).toBe('do you like apple?');
  });

  it('does not reach into the previous turn when the utterance names its own subject', () => {
    // The bench finding: "A pet store had six kittens. If they got another
    // three kittens, how many would they have total?" had "they" rewritten
    // to the previous problem's entity, and the observer answered a story
    // nobody told it.
    const window = [{ role: 'user' as const, text: 'I like apples.', at: 1 }];
    const known = (word: string) => word === 'apple';
    const story = 'A pet store had six kittens. If they got another three kittens, how many would they have total?';
    expect(resolveReferences(story, window, known)).toBe(story);
    // A bare pronoun with nothing before it still resolves from memory.
    expect(resolveReferences('what about it?', window, known)).toBe('what about apple?');
    expect(resolveReferences('is it sweet?', window, known)).toBe('is apple sweet?');
  });

  it('leaves the utterance unchanged without a pronoun', () => {
    const window = [{ role: 'user' as const, text: 'I like apples.', at: 1 }];
    expect(resolveReferences('what is the capital of mars', window)).toBe('what is the capital of mars');
  });

  it('leaves the utterance unchanged when nothing resolvable was said', () => {
    const window: Array<{ role: 'user'; text: string; at: number }> = [];
    expect(resolveReferences('what about it?', window)).toBe('what about it?');
    // Only pronouns/function words in the window — no entity to resolve to.
    const functionOnly = [{ role: 'user' as const, text: 'What is it?', at: 1 }];
    expect(resolveReferences('what about it?', functionOnly)).toBe('what about it?');
  });

  it('extractUnknownSubject finds the last unknown content word', () => {
    const known = new Set(['apple', 'water']);
    expect(extractUnknownSubject('what is the capital of mars', known)).toBe('mars');
    expect(extractUnknownSubject('do you like rain', known)).toBe('rain');
    expect(extractUnknownSubject('what is apple', known)).toBeNull();
  });
});

describe('chatAnswer with working memory + ask mode', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, WORD_DECK);
  });

  afterEach(() => {
    session.dispose();
  });

  it('notes turns into working memory', () => {
    teacher.chatAnswer('I like apples.');
    teacher.chatAnswer('what about it?');
    expect(teacher.getWorkingMemory().length).toBeGreaterThan(0);
    expect(teacher.getWorkingMemory().some((t) => t.role === 'user' && t.text === 'I like apples.')).toBe(true);
  });

  it('a reference resolves to a taught word and answers via the definition operator', () => {
    teacher.teach('apple');
    // "what about it?" after "I like apples." -> "what about apple?" ->
    // the definition operator answers from the taught definition.
    const first = teacher.chatAnswer('I like apples.');
    void first;
    const answer = teacher.chatAnswer('what about it?');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') {
      expect(answer.operator!.kind).toBe('definition');
      expect(answer.response.toLowerCase()).toContain('fruit');
    }
  });

  it('asks about the unknown and records a gap when it cannot answer', () => {
    const answer = teacher.chatAnswer('what is the capital of mars');
    expect(answer.mode).toBe('ask');
    if (answer.mode === 'ask') {
      expect(answer.response).toContain('mars');
    }
    expect(teacher.listGaps()).toContain('what is the capital of mars');
  });

  it('resolves against PRIOR turns, never the current utterance (regression: "alway")', () => {
    teacher.chatAnswer('The sky is so blue today.');
    const answer = teacher.chatAnswer('is it always like that?');
    // The unknown subject must come from the prior turn ("today"), not from
    // singularizing the current utterance's own word ("always" -> "alway").
    expect(answer.mode).toBe('ask');
    if (answer.mode === 'ask') {
      expect(answer.response).not.toContain('alway');
    }
  });

  it('does not ask about empty input', () => {
    const answer = teacher.chatAnswer('   ');
    expect(answer.mode).toBe('decline');
  });

  it('moment-grounded recall: a partial-overlap distractor is NOT answered from memory', async () => {
    // Teach "what is the weather like" — then a same-lead distractor must
    // not be answered as if it were that exchange (the old 0.65 false-recall
    // case, now guard-free thanks to settle-to-agreement).
    teacher.teachResponse({ cue: 'what is the weather like', response: 'The weather is warm today.' });
    const answer = teacher.chatAnswer('what is the capital of mars');
    expect(answer.mode).not.toBe('memorized');
    expect(answer.mode === 'ask' || answer.mode === 'creative').toBe(true);
  });
});