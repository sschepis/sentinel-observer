import { describe, expect, test } from '@jest/globals';
import { ObserverSession } from '../../observer/engine';
import { PRIME_SPACE, deckVocabulary } from '../primeSignature';
import { ACTIVE_DECK } from '../decks';
import { TeacherAgent } from '../TeacherAgent';
import { generateExercises, verify } from '../technical/verify';
import { matchArgs } from '../technical/dsl';
import { reduce } from './engine';
import { parseRewritePrompt, decodeNormalForm } from './parse';
import { ALG_RULES } from './alg';
import { PEANO_RULES, natFromDecimal } from './peano';
import { DIGITS_RULES } from './digits';
import { INT_RULES } from './int';
import { LOGIC_RULES } from './logic';
import { tSym } from './terms';
import { RuleStore } from './types';
import type { DeckWord } from '../deck';

const DECK: readonly DeckWord[] = ACTIVE_DECK.slice(0, 300).map((entry) => ({ ...entry }));
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK], PRIME_SPACE)
};

describe('R15 — equations: inverse operations', () => {
  test('the alg deck solves both generator shapes through the engine', () => {
    const store = new RuleStore([...PEANO_RULES, ...DIGITS_RULES, ...INT_RULES, ...LOGIC_RULES, ...ALG_RULES]);
    for (const drill of ['solve-x-add', 'solve-x-mul'] as const) {
      const exercises = generateExercises(drill, 'concept', { count: 30, seed: 4242 });
      for (const exercise of exercises) {
        const parsed = parseRewritePrompt(exercise.prompt);
        expect(parsed).not.toBeNull();
        const { outcome, ruleIds } = reduce(store, parsed!.term, { fuel: 20_000 });
        expect(outcome.status).toBe('normal');
        if (outcome.status === 'normal') {
          expect(decodeNormalForm(outcome.term)).toBe(String(exercise.answer));
        }
        // The visible work: the reduction cites the inverse-operation rule.
        expect(ruleIds.some((id) => id.startsWith('alg.solve-'))).toBe(true);
      }
    }
  });

  test('a fresh teacher derives solve-x prompts, and unmatched equation shapes decline', async () => {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK, null, 1, 0, 7);
    const exercises = generateExercises('solve-x-add', 'unknown number', { count: 20, seed: 7 });
    for (const exercise of exercises) {
      const answer = teacher.chatAnswer(exercise.prompt);
      expect(answer.mode).toBe('operator');
      if (answer.mode === 'operator' && answer.operator !== null) {
        expect(answer.operator.kind).toBe('rewrite');
        expect(verify(exercise, answer.response).correct).toBe(true);
      }
    }
    // Out of scope: x on both sides has no parser shape and no rule —
    // decline, never a guess.
    const bothSides = teacher.chatAnswer('If x + 3 = x + 5, what is x?');
    expect(bothSides.mode).not.toBe('operator');
    const noParse = teacher.chatAnswer('If 3 x plus 2 equals 14, solve for x');
    expect(noParse.mode).not.toBe('operator');
    session.dispose();
  });

  test('matchArgs lifts both quantities from the generator shapes', () => {
    const add = generateExercises('solve-x-add', 'unknown number', { count: 10, seed: 3 })[0];
    const addArgs = matchArgs('solve-x-add', add.prompt)!;
    expect(Number(add.answer) + Number(addArgs[0])).toBe(Number(addArgs[1]));
    const mul = generateExercises('solve-x-mul', 'unknown factor', { count: 10, seed: 4 })[0];
    const mulArgs = matchArgs('solve-x-mul', mul.prompt)!;
    expect(Number(mul.answer) * Number(mulArgs[0])).toBe(Number(mulArgs[1]));
  });

  test('the drill loop reports generalization for equations on a fresh teacher', async () => {
    const { runDrill } = await import('../technical/drill');
    const { CHECKABLE_CONCEPTS } = await import('../technical/index');
    const word = 'unknown number';
    const concept = CHECKABLE_CONCEPTS.find((entry) => entry.word === word)!;
    const deck = [concept, ...concept.dependsOn.map((w) => ({ word: w, definition: `the concept ${w}`, example: `About ${w}.` }))];
    const session = new ObserverSession(
      { primeCount: 64, gridSize: 128, memoryMode: 'compact' as const, vocabulary: deckVocabulary([...deck], PRIME_SPACE) },
      100
    );
    await session.initialize();
    const teacher = new TeacherAgent(session, deck, null, 1, 0, 7, undefined, undefined, undefined, true);
    teacher.teach(word);
    for (const prereq of concept.dependsOn) teacher.teach(prereq);
    const result = runDrill(teacher, concept, 0);
    expect(['induced', 'rule-induced']).toContain(result.verdict);
    session.dispose();
  });

  test('the inert constructors keep the equation intact (CBV cannot reduce it)', () => {
    const store = new RuleStore([...PEANO_RULES, ...DIGITS_RULES, ...INT_RULES, ...LOGIC_RULES, ...ALG_RULES]);
    const { outcome } = reduce(store, tSym('alg.solve', [tSym('eq.rel', [tSym('eq.plus', [tSym('var.x'), natFromDecimal(4)]), natFromDecimal(9)])]));
    expect(outcome.status).toBe('normal');
    if (outcome.status === 'normal') expect(decodeNormalForm(outcome.term)).toBe('5');
  });
});
