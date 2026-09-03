import { describe, expect, test } from '@jest/globals';
import { ObserverSession } from '../../observer/engine';
import { PRIME_SPACE, deckVocabulary } from '../primeSignature';
import { TeacherAgent } from '../TeacherAgent';
import { runDrill } from '../technical/drill';
import { CHECKABLE_CONCEPTS } from '../technical/index';
import { generateExercises, verify } from '../technical/verify';
import { matchArgs } from '../technical/dsl';

function conceptDeck(word: string): Array<{ word: string; definition: string; example: string }> {
  const concept = CHECKABLE_CONCEPTS.find((entry) => entry.drill === word)!;
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

async function drillTeacher(word: string): Promise<TeacherAgent> {
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

describe('R13 — conversions learn their multiplier; measure families compose', () => {
  test('convert-time: the drill induces conv.convert-time and fresh prompts derive', async () => {
    const teacher = await drillTeacher('convert-time');
    const concept = CHECKABLE_CONCEPTS.find((entry) => entry.drill === 'convert-time')!;
    let verdict = '';
    for (let round = 0; round < 4 && verdict !== 'rule-induced'; round += 1) {
      verdict = runDrill(teacher, concept, round).verdict;
    }
    expect(verdict).toBe('rule-induced');
    const rule = teacher.rewriteRuleStore().all().find((entry) => entry.name === 'conv.convert-time');
    expect(rule).toBeDefined();
    expect(rule!.origin).toBe('induced');
    expect(rule!.schema).toBe('scalar');
    const exercises = generateExercises('convert-time', 'minute', { count: 40, seed: 31 });
    let correct = 0;
    let derived = 0;
    for (const exercise of exercises) {
      const answer = teacher.chatAnswer(exercise.prompt);
      if (answer.mode === 'operator' && answer.operator !== null && answer.operator.kind === 'rewrite') derived += 1;
      if (verify(exercise, answer.mode === 'decline' ? '' : answer.response).correct) correct += 1;
    }
    expect(derived).toBeGreaterThanOrEqual(10);
    expect(correct).toBe(exercises.length);
  });

  test('H2 discipline survives migration: the time rule never answers a MASS prompt', async () => {
    const teacher = await drillTeacher('convert-time');
    const concept = CHECKABLE_CONCEPTS.find((entry) => entry.drill === 'convert-time')!;
    for (let round = 0; round < 4; round += 1) {
      if (runDrill(teacher, concept, round).verdict === 'rule-induced') break;
    }
    // The grams prompt parses as conv.convert-mass — a rule the teacher
    // does not have — so it must ask, never be answered by the ×60 time
    // rule. (The PARSER is per-family; that is the H2 guard now.)
    const grams = teacher.chatAnswer('How many grams are in 5 kilograms?');
    expect(grams.mode).not.toBe('operator');
    const reverse = teacher.chatAnswer('How many minutes are in 120 seconds?');
    expect(reverse.mode).not.toBe('decline');
    if (reverse.mode === 'operator' && reverse.operator !== null) {
      expect(reverse.operator.kind).toBe('rewrite');
    }
  });

  test('measure prompts lift exactly the generator quantities', () => {
    // The generators and the parser must agree on which numbers are which
    // (area = w × h; density = mass ÷ volume; the composite quantities
    // stay composite).
    const exercises = generateExercises('force', 'force', { count: 20, seed: 3 });
    for (const exercise of exercises) {
      const parsed = matchArgs('force', exercise.prompt)!;
      expect(Number(exercise.answer)).toBe(Number(parsed[0]) * Number(parsed[1]));
    }
    const density = generateExercises('density', 'density', { count: 20, seed: 5 });
    for (const exercise of density) {
      const parsed = matchArgs('density', exercise.prompt)!;
      expect(Number(exercise.answer)).toBe(Number(parsed[0]) / Number(parsed[1]));
    }
    const area = generateExercises('area', 'area', { count: 20, seed: 7 });
    for (const exercise of area) {
      const parsed = matchArgs('area', exercise.prompt)!;
      expect(Number(exercise.answer)).toBe(Number(parsed[0]) * Number(parsed[1]));
    }
  });
});
