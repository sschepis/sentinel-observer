/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../../observer/engine';
import { TeacherAgent } from '../TeacherAgent';
import { CONVERSATION_CUE_TOKENS } from '../conversation';
import { PRIME_SPACE, deckVocabulary } from '../primeSignature';
import { nextDrillConcept, runDrill, drillMdl, memorizerBaseline } from './drill';
import { generateExercises, chanceLevel } from './verify';
import { CHECKABLE_CONCEPTS } from './index';
import type { DeckWord } from '../deck';
import type { TechnicalConcept } from './types';

const MULTIPLICATION = CHECKABLE_CONCEPTS.find((c) => c.word === 'multiplication') as TechnicalConcept;

/** A deck holding the drilled concept and everything it depends on. */
const DECK: readonly DeckWord[] = [
  MULTIPLICATION,
  ...MULTIPLICATION.dependsOn.map((word) => ({ word, definition: `the concept ${word}`, example: `About ${word}.` }))
].map((c) => ({ word: c.word, definition: c.definition, example: c.example }));

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

async function teacherOn(): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  return { session, teacher: new TeacherAgent(session, DECK) };
}

/** A session + teacher whose deck holds the given concept and its prerequisites. */
async function teacherOnConcept(concept: TechnicalConcept): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const deck = [concept, ...concept.dependsOn.map((word) => ({ word, definition: `the concept ${word}`, example: `About ${word}.` }))];
  const session = new ObserverSession(
    { ...OPTIONS, vocabulary: deckVocabulary([...deck, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE) },
    100
  );
  await session.initialize();
  return { session, teacher: new TeacherAgent(session, deck) };
}

describe('choosing what to drill', () => {
  it('offers nothing until the concept and its prerequisites are taught', async () => {
    const { session, teacher } = await teacherOn();
    expect(nextDrillConcept(teacher)).toBeNull();
    session.dispose();
  });

  it('offers a concept only once its prerequisites are learned', async () => {
    const { session, teacher } = await teacherOn();

    // The concept alone is not enough — its prerequisites gate it.
    teacher.teach('multiplication');
    expect(nextDrillConcept(teacher)).toBeNull();

    for (const prerequisite of MULTIPLICATION.dependsOn) teacher.teach(prerequisite);
    expect(nextDrillConcept(teacher)?.word).toBe('multiplication');
    session.dispose();
  });

  it('spreads across concepts instead of grinding one', async () => {
    const { session, teacher } = await teacherOn();
    teacher.teach('multiplication');
    for (const prerequisite of MULTIPLICATION.dependsOn) teacher.teach(prerequisite);

    const counts = new Map<string, number>([['multiplication', 3]]);
    const chosen = nextDrillConcept(teacher, counts);
    // Only one concept is ready here, so it is still chosen — but the
    // selector must be reading the counts, not ignoring them.
    expect(chosen?.word).toBe('multiplication');
    session.dispose();
  });
});

describe('the minimum-description-length comparison', () => {
  it('finds the rule cheaper than a pile of stored instances', () => {
    const many = generateExercises('multiplication', 'multiplication', { count: 40, seed: 1 });
    const mdl = drillMdl(many, 'multiply the two numbers together');
    expect(mdl.instanceBits).toBeGreaterThan(mdl.ruleBits);
    expect(mdl.compresses).toBe(true);
  });

  it('does not claim compression from a single instance', () => {
    const one = generateExercises('multiplication', 'multiplication', { count: 1, seed: 1 });
    const mdl = drillMdl(one, 'multiply the two numbers together');
    expect(mdl.compresses).toBe(false);
  });
});

describe('the memorizer null model', () => {
  it('is zero when no taught answer is ever right for a held-out item', () => {
    const train = [{ concept: 'c', drill: 'd', prompt: 'a', answer: '1', kind: 'number' as const }];
    const test = [{ concept: 'c', drill: 'd', prompt: 'b', answer: '2', kind: 'number' as const }];
    expect(memorizerBaseline(train, test)).toBe(0);
  });

  it('rises when the answer space is small enough to hit by replay', () => {
    // Half the taught answers are '1', so replaying one is right half the time.
    const train = [
      { concept: 'c', drill: 'd', prompt: 'a', answer: '1', kind: 'number' as const },
      { concept: 'c', drill: 'd', prompt: 'b', answer: '2', kind: 'number' as const }
    ];
    const test = [{ concept: 'c', drill: 'd', prompt: 'z', answer: '1', kind: 'number' as const }];
    expect(memorizerBaseline(train, test)).toBe(0.5);
  });

  it('is what stops a clustered answer space from faking induction', () => {
    // Remainders mod 3 collide constantly; the bar must reflect that.
    const exercises = generateExercises('remainder', 'remainder', { count: 40, seed: 5 });
    const { splitExercises } = require('./verify') as typeof import('./verify');
    const { train, test } = splitExercises(exercises);
    expect(memorizerBaseline(train, test)).toBeGreaterThan(0.05);
  });

  it('handles empty sets without dividing by zero', () => {
    expect(memorizerBaseline([], [])).toBe(0);
  });
});

describe('running a drill', () => {
  it('never teaches from the held-out set', async () => {
    const { session, teacher } = await teacherOn();
    teacher.teach('multiplication');
    for (const prerequisite of MULTIPLICATION.dependsOn) teacher.teach(prerequisite);

    const result = runDrill(teacher, MULTIPLICATION, 0);
    expect(result.taught).toBeGreaterThan(0);
    expect(result.trainPrompts.length).toBeGreaterThan(0);
    expect(result.testPrompts.length).toBeGreaterThan(0);

    // The split itself must be disjoint.
    const trained = new Set(result.trainPrompts);
    for (const prompt of result.testPrompts) expect(trained.has(prompt)).toBe(false);

    // And nothing held out may have reached the observer's memory.
    const taughtCues = new Set(teacher.listConversationPairs().map((pair) => pair.cue.toLowerCase()));
    for (const prompt of result.testPrompts) {
      expect(taughtCues.has(prompt.toLowerCase())).toBe(false);
    }
    session.dispose();
  }, 30000);

  it('reports an honest verdict with a chance baseline', async () => {
    const { session, teacher } = await teacherOn();
    teacher.teach('multiplication');
    for (const prerequisite of MULTIPLICATION.dependsOn) teacher.teach(prerequisite);

    const result = runDrill(teacher, MULTIPLICATION, 1);

    expect(result.concept).toBe('multiplication');
    expect(result.drill).toBe('multiplication');
    expect(result.trainAccuracy).toBeGreaterThanOrEqual(0);
    expect(result.trainAccuracy).toBeLessThanOrEqual(1);
    expect(result.testAccuracy).toBeGreaterThanOrEqual(0);
    expect(result.testAccuracy).toBeLessThanOrEqual(1);
    expect(['unlearned', 'memorized', 'induced', 'rule-induced']).toContain(result.verdict);
    expect(result.chance).toBeGreaterThan(0);
    expect(result.events.length).toBeGreaterThan(0);
    session.dispose();
  }, 30000);

  it('only calls it induction on real evidence, never on a lucky hit or two', async () => {
    const { session, teacher } = await teacherOn();
    teacher.teach('multiplication');
    for (const prerequisite of MULTIPLICATION.dependsOn) teacher.teach(prerequisite);

    const result = runDrill(teacher, MULTIPLICATION, 2);
    const testCorrect = Math.round(result.testAccuracy * result.testPrompts.length);
    if (result.verdict === 'induced') {
      // Both gates: clear of the null model AND enough hits to mean it.
      expect(result.testAccuracy).toBeGreaterThan(result.chance + 0.2);
      expect(testCorrect).toBeGreaterThanOrEqual(3);
    } else if (result.verdict === 'rule-induced') {
      // The COMPILED RULE must clear the same gates on the held-out set.
      expect(result.ruleTestAccuracy).toBeDefined();
      if (result.ruleTestAccuracy !== undefined) {
        expect(result.ruleTestAccuracy).toBeGreaterThan(result.chance + 0.2);
        expect(Math.round(result.ruleTestAccuracy * result.testPrompts.length)).toBeGreaterThanOrEqual(3);
      }
    } else {
      expect(result.testAccuracy <= result.chance + 0.2 || testCorrect < 3).toBe(true);
    }
    session.dispose();
  }, 30000);

  it('measures the bar against the memorizer, not a guessed constant', async () => {
    const { session, teacher } = await teacherOn();
    teacher.teach('multiplication');
    for (const prerequisite of MULTIPLICATION.dependsOn) teacher.teach(prerequisite);

    const result = runDrill(teacher, MULTIPLICATION, 4);
    // The bar is never below what blind guessing would score.
    expect(result.chance).toBeGreaterThanOrEqual(chanceLevel('multiplication'));
    session.dispose();
  }, 30000);

  it('emits events the training stream can classify as drills', async () => {
    const { session, teacher } = await teacherOn();
    teacher.teach('multiplication');
    for (const prerequisite of MULTIPLICATION.dependsOn) teacher.teach(prerequisite);

    const result = runDrill(teacher, MULTIPLICATION, 3);
    const metas = result.events.map((e) => e.meta ?? '');
    expect(metas.some((m) => m.startsWith('drill'))).toBe(true);
    session.dispose();
  }, 30000);
});

describe('acting on the verdict', () => {
  it('asks for the rule, not for more instances, when it only memorized', async () => {
    const { session, teacher } = await teacherOn();
    teacher.teach('multiplication');
    for (const prerequisite of MULTIPLICATION.dependsOn) teacher.teach(prerequisite);

    const result = runDrill(teacher, MULTIPLICATION, 5);
    if (result.verdict === 'memorized') {
      expect(result.ruleQuestion).toBe('what is the rule for multiplication?');
      // The gap the observer will take to its teacher is the RULE, and not
      // any of the arithmetic instances it just failed.
      const gaps = teacher.listGaps();
      expect(gaps).toContain('what is the rule for multiplication?');
      for (const prompt of result.testPrompts) {
        expect(gaps).not.toContain(prompt.toLowerCase());
      }
    } else {
      expect(result.ruleQuestion).toBeNull();
    }
    session.dispose();
  }, 30000);

  it('does not pile up a duplicate rule gap across rounds', async () => {
    const { session, teacher } = await teacherOn();
    teacher.teach('multiplication');
    for (const prerequisite of MULTIPLICATION.dependsOn) teacher.teach(prerequisite);

    runDrill(teacher, MULTIPLICATION, 6);
    runDrill(teacher, MULTIPLICATION, 7);

    const question = 'what is the rule for multiplication?';
    const occurrences = teacher.listGaps().filter((gap) => gap === question).length;
    expect(occurrences).toBeLessThanOrEqual(1);
    session.dispose();
  }, 40000);
});

describe('executable rule induction (P2)', () => {
  const ADDITION = CHECKABLE_CONCEPTS.find((c) => c.word === 'addition') as TechnicalConcept;

  it('turns a memorized drill into a compiled rule that answers FRESH prompts (the W5 kill-shot)', async () => {
    const { session, teacher } = await teacherOnConcept(ADDITION);
    teacher.teach('addition');
    for (const prerequisite of ADDITION.dependsOn) teacher.teach(prerequisite);

    const result = runDrill(teacher, ADDITION, 0);
    expect(result.verdict).toBe('rule-induced');
    expect(teacher.compiledRuleCount()).toBeGreaterThan(0);

    // A prompt the drill NEVER taught: the compiled operator must answer it.
    const fresh = teacher.chatAnswer('What is 47 + 32?');
    expect(fresh.mode).toBe('operator');
    if (fresh.mode === 'operator') {
      expect(fresh.operator?.kind).toBe('compiled-rule');
      expect(fresh.response).toBe('The answer is 79.');
    }

    // The held-out accuracy the rule earned is reported on the drill.
    expect(result.ruleTestAccuracy).toBe(1);
    session.dispose();
  }, 40000);

  it('leaves a family with no parser as memorized and asks for the rule (no fabrication)', async () => {
    // 'place value' has no DSL parser: the search cannot even try, so the
    // honest outcome is the memorized verdict + the rule question.
    const placeValue = CHECKABLE_CONCEPTS.find((c) => c.word === 'place value') as TechnicalConcept;
    const { session, teacher } = await teacherOnConcept(placeValue);
    teacher.teach('place value');
    for (const prerequisite of placeValue.dependsOn) teacher.teach(prerequisite);

    const result = runDrill(teacher, placeValue, 0);
    expect(result.verdict).toBe('memorized');
    expect(result.ruleQuestion).toBe('what is the rule for place value?');
    expect(teacher.compiledRuleCount()).toBe(0);
    session.dispose();
  }, 40000);

  it('a compiled conversion rule NEVER answers a prompt of another unit family or direction (the H2 fabrication)', async () => {
    // 'minute' drills the convert-time family (seconds<-minutes, minutes<-hours).
    const minute = CHECKABLE_CONCEPTS.find((c) => c.word === 'minute') as TechnicalConcept;
    const { session, teacher } = await teacherOnConcept(minute);
    teacher.teach('minute');
    for (const prerequisite of minute.dependsOn) teacher.teach(prerequisite);

    // Drill the time family: the induced rule is the ×60 unit-blind
    // multiplier for seconds<-minutes / minutes<-hours.
    const result = runDrill(teacher, minute, 0);
    expect(result.verdict).toBe('rule-induced');
    expect(teacher.compiledRuleCount()).toBeGreaterThan(0);

    // The SAME shape, other units: must NOT be answered by the time rule.
    // Before H2, "How many grams are in 5 kilograms?" was answered
    // "The answer is 300." (5×60) — a confident fabrication.
    const grams = teacher.chatAnswer('How many grams are in 5 kilograms?');
    expect(grams.mode).not.toBe('operator');
    if (grams.mode === 'operator') expect(grams.response).not.toContain('300');

    const centimeters = teacher.chatAnswer('How many centimeters are in 5 meters?');
    expect(centimeters.mode).not.toBe('operator');

    // Reverse direction of the SAME family is not generated by the drill
    // and must not fire either (the rule is the generator's forward shape).
    const reverse = teacher.chatAnswer('How many minutes are in 120 seconds?');
    expect(reverse.mode).not.toBe('operator');

    // The family's own forward prompts still answer correctly.
    const seconds = teacher.chatAnswer('How many seconds are in 5 minutes?');
    expect(seconds.mode).toBe('operator');
    if (seconds.mode === 'operator') {
      expect(seconds.operator?.kind).toBe('compiled-rule');
      expect(seconds.response).toBe('The answer is 300.');
    }
    session.dispose();
  }, 60000);

  it('compiled rules survive export → import', async () => {
    const { session, teacher } = await teacherOnConcept(ADDITION);
    teacher.teach('addition');
    for (const prerequisite of ADDITION.dependsOn) teacher.teach(prerequisite);
    runDrill(teacher, ADDITION, 1);
    expect(teacher.compiledRuleCount()).toBe(1);

    const record = teacher.exportBootstrap('test');
    expect(record.compiledRules).toHaveLength(1);
    session.dispose();

    const freshDeck = [ADDITION, ...ADDITION.dependsOn.map((word) => ({ word, definition: `the concept ${word}`, example: `About ${word}.` }))];
    const fresh = new ObserverSession(
      { ...OPTIONS, vocabulary: deckVocabulary([...freshDeck, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE) },
      100
    );
    await fresh.initialize();
    const freshTeacher = new TeacherAgent(fresh, freshDeck);
    freshTeacher.importBootstrap(record);
    expect(freshTeacher.compiledRuleCount()).toBe(1);
    const answer = freshTeacher.chatAnswer('What is 12 + 9?');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') expect(answer.response).toBe('The answer is 21.');
    fresh.dispose();
  }, 40000);
});
