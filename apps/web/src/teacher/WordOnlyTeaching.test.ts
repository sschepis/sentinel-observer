/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { DECK_1000 } from './decks/en-1000';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';

const WORD_ONLY_DECK: readonly DeckWord[] = [
  { word: 'apple', definition: '', example: '' },
  { word: 'water', definition: '', example: '' },
  { word: 'friend', definition: '', example: '' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary(WORD_ONLY_DECK, PRIME_SPACE)
};

describe('word-only teaching (before the Chaperone fills definitions)', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, WORD_ONLY_DECK);
  });

  afterEach(() => {
    session.dispose();
  });

  it('teaches the word itself as the trace content — never fabricated meaning', () => {
    const result = teacher.teach('apple');
    expect(result.traceId).not.toBeNull();
    const trace = session.observer.getMemoryBank().get(result.traceId!);
    expect(trace?.content).toBe('apple');
  });

  it('grades word-only recognition on trace identity with the word as the expected answer', () => {
    teacher.teach('apple');
    const question = teacher.ask('apple', 'recognition');
    expect(question.cue).toBe('apple');

    const grade = teacher.grade('apple', question);
    expect(grade.verdict).toBe('correct');
    expect(grade.expected).toBe('apple');
  });

  it('applies chaperoned definitions in place and upgrades the word', () => {
    teacher.teach('water');
    const applied = teacher.applyDefinitions([
      { word: 'water', definition: 'the clear liquid we drink', example: 'Give me a glass of water.' }
    ]);
    expect(applied).toBe(1);

    const entry = teacher.listWords().find((w) => w.word.word === 'water');
    expect(entry?.word.definition).toBe('the clear liquid we drink');

    // Production now works: cue = the definition.
    const question = teacher.ask('water', 'production');
    expect(question.cue).toBe('the clear liquid we drink');
  });

  it('never overwrites existing definitions with generated content', () => {
    teacher.applyDefinitions([
      { word: 'apple', definition: 'authored first', example: 'I eat an apple.' },
      { word: 'apple', definition: 'generated later', example: 'I eat an apple too.' }
    ]);
    const entry = teacher.listWords().find((w) => w.word.word === 'apple');
    expect(entry?.word.definition).toBe('authored first');
  });

  it('the deck scales: all 2437 frequency words have unique signatures', () => {
    const vocabulary = deckVocabulary(DECK_1000, PRIME_SPACE);
    const signatures = new Set(Object.values(vocabulary).map((s) => s.join(',')));
    expect(signatures.size).toBe(Object.keys(vocabulary).length);
    expect(Object.keys(vocabulary).length).toBeGreaterThanOrEqual(2400);
  });
});
