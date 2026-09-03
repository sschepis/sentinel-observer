/**
 * THE MATH BENCH (R6) — the end-to-end gate.
 *
 * A rewrite-mode teacher is drilled over the arithmetic AND logic families
 * the curriculum marks checkable; every exercise it answers must come from
 * a derivation (operator kind 'rewrite') or an honest decline — never a
 * fabrication — and every derivation must agree with the deterministic
 * oracle. This is the "the observer derives what it computes" claim made
 * measurable.
 */

import { describe, expect, test } from '@jest/globals';
import { ObserverSession } from '../../observer/engine';
import { PRIME_SPACE, deckVocabulary } from '../primeSignature';
import { ACTIVE_DECK } from '../decks';
import { TeacherAgent } from '../TeacherAgent';
import { generateExercises, verify, chanceLevel } from '../technical/verify';
import { runDrill } from '../technical/drill';
import { CHECKABLE_CONCEPTS } from '../technical/index';
import type { DeckWord } from '../deck';

const DECK: readonly DeckWord[] = ACTIVE_DECK.slice(0, 300).map((entry) => ({ ...entry }));

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK], PRIME_SPACE)
};

async function rewriteTeacher(): Promise<TeacherAgent> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  return new TeacherAgent(session, DECK, null, 1, 0, 7, undefined, undefined, undefined, true);
}

/** The arithmetic and logic families the rewrite engine owns (gcf/lcm are
 *  NOT here: they decline until the Euclidean rule is INDUCED — the
 *  flagship test below covers them). */
const REWRITE_FAMILIES = [
  'addition',
  'subtraction',
  'multiplication',
  'division',
  'remainder',
  'order-of-operations',
  'comparison',
  'parity',
  'factor',
  'exponent',
  'square',
  'word-problem-add',
  'word-problem-mul',
  'area',
  'volume',
  'density',
  'speed',
  'force',
  'solve-x-add',
  'solve-x-mul',
  'logic-and',
  'logic-or',
  'logic-not',
  'logic-if',
  'syllogism'
] as const;

describe('mathBench — derivations agree with the oracle', () => {
  test.each(REWRITE_FAMILIES)('%s: every derivation matches verify()', async (drill) => {
    const teacher = await rewriteTeacher();
    const exercises = generateExercises(drill, 'concept', { count: 20, seed: 4242 });
    expect(exercises.length).toBeGreaterThan(0);
    let answered = 0;
    let fabricated = 0;
    let correct = 0;
    for (const exercise of exercises) {
      const answer = teacher.chatAnswer(exercise.prompt);
      if (answer.mode === 'operator' && answer.operator !== null && answer.operator.kind === 'rewrite') {
        answered += 1;
        const verdict = verify(exercise, answer.response);
        if (verdict.correct) correct += 1;
        else fabricated += 1;
      }
    }
    // Every parsed prompt must derive (the authored decks own these
    // families) and every derivation must be right — zero fabrication.
    expect(answered).toBe(exercises.length);
    expect(fabricated).toBe(0);
    expect(correct).toBe(exercises.length);
    // Guard against a coincidental memorized answer: the fresh teacher has
    // never seen these prompts.
    expect(teacher.answerGradeLedger().length).toBe(0);
  });

  test('the gcf drill in rewrite mode induces and generalizes (the flagship)', async () => {
    const teacher = await rewriteTeacher();
    const concept = CHECKABLE_CONCEPTS.find((entry) => entry.drill === 'gcf')!;
    // The drill loop: teach -> memorize -> INDUCE. The Euclidean rule is
    // synthesized from the taught instances and registered.
    let verdict = '';
    for (let round = 0; round < 6; round += 1) {
      verdict = runDrill(teacher, concept, round).verdict;
      if (verdict === 'rule-induced') break;
    }
    expect(verdict).toBe('rule-induced');
    // Fresh gcf prompts now DERIVE — the induced rule generalizes far
    // beyond the taught pairs.
    const exercises = generateExercises('gcf', 'greatest common factor', { count: 60, seed: 99 });
    const heldOut = exercises.slice(30);
    let derived = 0;
    let right = 0;
    for (const exercise of heldOut.slice(0, 10)) {
      const answer = teacher.chatAnswer(exercise.prompt);
      if (answer.mode === 'operator' && answer.operator !== null && answer.operator.kind === 'rewrite') {
        derived += 1;
        if (verify(exercise, answer.response).correct) right += 1;
      }
    }
    expect(derived).toBeGreaterThanOrEqual(5);
    expect(right).toBe(derived);
    // Chance on gcf is 1/60 — answering every probe right is generalization,
    // not memory.
    expect(chanceLevel('gcf')).toBeLessThan(0.1);

    // lcm composes from the induced gcd: a * b / gcd(a, b) — the derived
    // answer is the composition of two procedures, not a memorized pair.
    const lcmExercises = generateExercises('lcm', 'least common multiple', { count: 10, seed: 77 });
    let lcmRight = 0;
    let lcmDerived = 0;
    for (const exercise of lcmExercises) {
      const answer = teacher.chatAnswer(exercise.prompt);
      if (answer.mode === 'operator' && answer.operator !== null && answer.operator.kind === 'rewrite') {
        lcmDerived += 1;
        if (verify(exercise, answer.response).correct) lcmRight += 1;
      }
    }
    expect(lcmDerived).toBeGreaterThanOrEqual(5);
    expect(lcmRight).toBe(lcmDerived);
  });
});
