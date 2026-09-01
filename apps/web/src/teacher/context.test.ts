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