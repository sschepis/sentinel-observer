/**
 * @jest-environment node
 *
 * Checkable problems (src/curriculum/problems.ts): the observer answers
 * through its own stack, the check is exact, and the verdict books world
 * feedback the grader never has to vouch for.
 */
import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkProblem, numberIn, parseProblemRow, problemPrompt } from './problems';
import { CurriculumFeeder, discoverSources, describeFeed } from './registry';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { PRIME_SPACE, deckVocabulary } from '../teacher/primeSignature';
import { CONVERSATION_CUE_TOKENS } from '../teacher/conversation';
import type { DeckWord } from '../teacher/deck';

const DECK: readonly DeckWord[] = [
  { word: 'apple', definition: 'a round red or green fruit', example: 'I eat an apple.' },
  { word: 'number', definition: 'a symbol or word that shows how many', example: 'Six is a number.' }
];
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  smfWidth: 128,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

describe('problem rows', () => {
  it('parses rows and reads the first number of an answer or a reply', () => {
    expect(parseProblemRow('{"body":"John has 3 apples.","question":"How many apples?","answer":"3.0","source":"svamp"}')).toEqual({ body: 'John has 3 apples.', question: 'How many apples?', answer: '3.0', source: 'svamp' });
    expect(parseProblemRow('{"question":"x"}')).toBeNull();
    expect(numberIn('The answer is 6.')).toBe(6);
    expect(numberIn('5 (apples)')).toBe(5);
    expect(numberIn('1,200 people')).toBe(1200);
    expect(numberIn('I cannot tell.')).toBeNull();
    expect(problemPrompt({ body: '  A  b. ', question: ' What is c? ', answer: '1' })).toBe('A b. What is c?');
  });
});

describe('checkProblem', () => {
  it('a computable problem is answered and checked exactly; an unanswerable one is an abstention; a wrong expected answer books a wrong grade', async () => {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK, null, 500, 4, 7);
    for (const entry of DECK) teacher.teach(entry.word);
    const before = teacher.behaviorOutcomeCounts().answer;

    const right = checkProblem(teacher, { body: '', question: 'what is 36 / 6?', answer: '6' });
    expect(right.verdict).toBe('correct');
    expect(right.got).toBe(6);
    expect(right.mode).toBe('operator');
    expect(teacher.behaviorOutcomeCounts().answer.wins).toBe(before.wins + 1);
    expect(teacher.answerGradeLedger().some((entry) => entry.utterance === 'what is 36 / 6?' && entry.verdict === 'correct')).toBe(true);

    // The world says the answer was 7: the same derivation is now booked wrong
    // and the rules it derived through are weakened — the ledger names them.
    const wrong = checkProblem(teacher, { body: '', question: 'what is 36 / 6?', answer: '7' });
    expect(wrong.verdict).toBe('wrong');
    expect(teacher.behaviorOutcomeCounts().answer.losses).toBe(before.losses + 1);
    const booked = teacher.answerGradeLedger().find((entry) => entry.utterance === 'what is 36 / 6?' && entry.verdict === 'wrong');
    expect(booked).toBeDefined();
    expect((booked?.ruleIds ?? []).length).toBeGreaterThan(0);

    const unknown = checkProblem(teacher, { body: 'A zorble has some quimps.', question: 'How many quimps does the zorble have?', answer: '4' });
    expect(unknown.verdict).toBe('abstained');
    expect(unknown.got).toBeNull();
    session.dispose();
  }, 60000);

  it('the feeder reports right / wrong / abstained and accuracy when answering', async () => {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK, null, 500, 4, 7);
    for (const entry of DECK) teacher.teach(entry.word);
    const dir = mkdtempSync(join(tmpdir(), 'corpus-'));
    try {
      const rows = [
        { body: '', question: 'what is 2 + 3?', answer: '5' },
        { body: '', question: 'what is 4 * 5?', answer: '20' },
        { body: '', question: 'what is 9 - 4?', answer: '6' }, // wrong on purpose
        { body: 'A zorble has some quimps.', question: 'How many quimps?', answer: '4' }
      ];
      writeFileSync(join(dir, 'problems.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
      const feeder = new CurriculumFeeder(teacher, discoverSources(dir));
      const report = feeder.step(10);
      expect(report?.kind).toBe('problems');
      expect(report?.accepted).toBe(2);
      expect(report?.wrong).toBe(1);
      expect(report?.abstained).toBe(1);
      expect(describeFeed(report!)).toContain('accuracy when answering 67%');
      session.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
