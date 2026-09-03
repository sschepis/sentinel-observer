import { describe, expect, test } from '@jest/globals';
import { ObserverSession } from '../../observer/engine';
import { PRIME_SPACE, deckVocabulary } from '../primeSignature';
import { TeacherAgent } from '../TeacherAgent';
import { runDrill } from '../technical/drill';
import { CHECKABLE_CONCEPTS } from '../technical/index';
import { generateExercises, verify } from '../technical/verify';
import { matchArgs } from '../technical/dsl';
import { induceRuleSet, validateHeldOut, type InductionInstance } from './induction';
import { natFromDecimal, natToDecimal } from './peano';
import { digitsFromDecimal } from './digits';
import { tSym, termBits, termToString } from './terms';
import { reduce } from './engine';
import { RuleStore } from './types';
import { PEANO_RULES } from './peano';
import { DIGITS_RULES } from './digits';
import { INT_RULES } from './int';
import { LOGIC_RULES } from './logic';

function conceptDeck(word: string): Array<{ word: string; definition: string; example: string }> {
  const concept = CHECKABLE_CONCEPTS.find((entry) => entry.word === word)!;
  const words: string[] = [];
  const collect = (entry: typeof concept): void => {
    if (words.includes(entry.word)) return;
    words.push(entry.word);
    for (const prereq of entry.dependsOn) {
      const found = CHECKABLE_CONCEPTS.find((candidate) => candidate.word === prereq);
      if (found !== undefined) collect(found);
    }
  };
  collect(concept);
  return words.map((entryWord) => {
    const entry = CHECKABLE_CONCEPTS.find((candidate) => candidate.word === entryWord);
    return {
      word: entryWord,
      definition: entry?.definition ?? `the concept ${entryWord}`,
      example: entry?.example ?? `About ${entryWord}.`
    };
  });
}

async function conceptTeacher(word: string): Promise<TeacherAgent> {
  const deck = conceptDeck(word);
  const session = new ObserverSession(
    { primeCount: 64, gridSize: 128, memoryMode: 'compact' as const, vocabulary: deckVocabulary([...deck], PRIME_SPACE) },
    100
  );
  await session.initialize();
  const teacher = new TeacherAgent(session, deck, null, 1, 0, 7, undefined, undefined, undefined, true);
  for (const entry of deck) teacher.teach(entry.word);
  return teacher;
}

/** Drill a family in rewrite mode until the loop induces its rule. */
async function drillToInduction(teacher: TeacherAgent, word: string): Promise<string> {
  const concept = CHECKABLE_CONCEPTS.find((entry) => entry.word === word)!;
  let verdict = '';
  for (let round = 0; round < 8; round += 1) {
    verdict = runDrill(teacher, concept, round).verdict;
    if (verdict === 'rule-induced') break;
  }
  return verdict;
}

describe('R12 — place value: the second flagship (list-structural accessor)', () => {
  test('the drill INDUCES the accessor (never authored) and it generalizes', async () => {
    const teacher = await conceptTeacher('place value');
    const verdict = await drillToInduction(teacher, 'place value');
    expect(verdict).toBe('rule-induced');
    const learned = teacher.rewriteRuleStore().all().filter((rule) => rule.origin !== 'authored');
    expect(learned.length).toBeGreaterThan(0);
    expect(learned.some((rule) => rule.name === 'dig.placeVal' && rule.schema === 'accessor')).toBe(true);

    // Held-out prompts derive through the accessor with traces.
    const heldOut = generateExercises('place-value', 'place value', { count: 30, seed: 4242 });
    let derived = 0;
    for (const exercise of heldOut) {
      const answer = teacher.chatAnswer(exercise.prompt);
      if (answer.mode === 'operator' && answer.operator !== null && answer.operator.kind === 'rewrite') {
        derived += 1;
        expect(verify(exercise, answer.response).correct).toBe(true);
      }
    }
    expect(derived).toBe(heldOut.length);
  });

  test('a distinct-digit prompt parses; a repeated-digit prompt declines', () => {
    expect(matchArgs('place-value', 'In 472, what is the place value of the digit 7?')).toEqual([472, 7]);
    expect(matchArgs('place-value', 'In 707, what is the place value of the digit 7?')).toBeNull();
  });

  test('schema (c) synthesizes the accessor from instances directly', () => {
    const store = new RuleStore([...PEANO_RULES, ...DIGITS_RULES, ...INT_RULES, ...LOGIC_RULES]);
    const exercises = generateExercises('place-value', 'place value', { count: 44, seed: 5 });
    const train: InductionInstance[] = [];
    for (const exercise of exercises.slice(0, 22)) {
      const args = matchArgs('place-value', exercise.prompt)!;
      const value = Number(args[0]);
      const digit = Number(args[1]);
      const digits = String(value);
      const index = digits.length - 1 - digits.indexOf(String(digit));
      train.push({
        args: [digitsFromDecimal(value), natFromDecimal(index)],
        answer: natFromDecimal(Number(exercise.answer))
      });
    }
    const instanceBits = train.reduce((sum, instance) => sum + (instance.answer.t === 'lit' ? 10 : termBits(instance.answer)), 0);
    const induced = induceRuleSet(store, 'dig.placeVal', train, {
      instanceBits,
      baseline: 1 / 27,
      margin: 0.2,
      minHits: 3,
      schema: 'accessor'
    });
    expect(induced).not.toBeNull();
    expect(induced!.length).toBe(2);
    expect(induced!.every((rule) => rule.schema === 'accessor')).toBe(true);
    const body = termToString(induced![1].rhs);
    expect(body).toContain('nat.mul');
    expect(body).toContain('dig.placeVal');
  });
});

describe('R12 — square root: the bounded-search schema', () => {
  test('the drill INDUCES the search rule and answers fresh square prompts', async () => {
    const teacher = await conceptTeacher('square root');
    const verdict = await drillToInduction(teacher, 'square root');
    expect(verdict).toBe('rule-induced');
    const learned = teacher.rewriteRuleStore().all().filter((rule) => rule.origin !== 'authored');
    expect(learned.some((rule) => rule.name === 'nat.sqrt' && rule.schema === 'search')).toBe(true);

    const heldOut = generateExercises('square-root', 'square root', { count: 19, seed: 1234 });
    // The square pool is only 19 prompts, so the drill's own taught
    // instances overlap it — a correct answer may come from memory OR a
    // derivation; both must be right, and at least the untouched half must
    // derive through the induced search.
    let derived = 0;
    let correct = 0;
    for (const exercise of heldOut) {
      const answer = teacher.chatAnswer(exercise.prompt);
      if (answer.mode === 'operator' && answer.operator !== null && answer.operator.kind === 'rewrite') {
        derived += 1;
      }
      if (verify(exercise, answer.mode === 'decline' ? '' : answer.response).correct) correct += 1;
    }
    expect(correct).toBe(heldOut.length);
    expect(derived).toBeGreaterThanOrEqual(6);
  });

  test('schema (d) synthesizes the search from instances directly', () => {
    const store = new RuleStore([...PEANO_RULES, ...DIGITS_RULES, ...INT_RULES, ...LOGIC_RULES]);
    const exercises = generateExercises('square-root', 'square root', { count: 19, seed: 9 });
    const train: InductionInstance[] = exercises.map((exercise) => ({
      args: [natFromDecimal(Number(matchArgs('square-root', exercise.prompt)![0]))],
      answer: natFromDecimal(Number(exercise.answer))
    }));
    const instanceBits = train.reduce((sum, instance) => sum + termBits(instance.answer), 0);
    const induced = induceRuleSet(store, 'nat.sqrt', train, {
      instanceBits,
      baseline: 1 / 19,
      margin: 0.2,
      minHits: 3,
      schema: 'search',
      fuel: 60_000
    });
    expect(induced).not.toBeNull();
    expect(induced!.length).toBe(2);
    expect(induced!.every((rule) => rule.schema === 'search')).toBe(true);
    const probe = new RuleStore([...store.all(), ...induced!], store.allDenials());
    const { outcome } = reduce(probe, tSym('nat.sqrt', [natFromDecimal(144)]), { fuel: 20_000 });
    expect(outcome.status).toBe('normal');
    if (outcome.status === 'normal') expect(natToDecimal(outcome.term)).toBe(12);
  });
});
