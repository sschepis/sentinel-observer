import { describe, expect, test } from '@jest/globals';
import { ObserverSession } from '../../observer/engine';
import { PRIME_SPACE, deckVocabulary } from '../primeSignature';
import { ACTIVE_DECK } from '../decks';
import { TeacherAgent, CREATIVE_WEAKEN_SCORE, CREATIVE_REINFORCE_SCORE } from '../TeacherAgent';
import { runDrill } from '../technical/drill';
import { CHECKABLE_CONCEPTS } from '../technical/index';
import type { DeckWord } from '../deck';
import { natFromDecimal } from './peano';
import { tSym } from './terms';
import type { RewriteRule } from './types';

const DECK: readonly DeckWord[] = ACTIVE_DECK.slice(0, 300).map((entry) => ({ ...entry }));

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK], PRIME_SPACE)
};

async function freshTeacher(rewriteInduction = false): Promise<TeacherAgent> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  return new TeacherAgent(session, DECK, null, 1, 0, 7, undefined, undefined, undefined, rewriteInduction);
}

/** The Euclidean gcd rule, as induction would produce it — registered as
 *  if it had been induced from instances. */
function inducedGcdRule(): RewriteRule {
  return {
    id: 'induced-nat.gcd-0',
    name: 'nat.gcd',
    lhs: tSym('nat.gcd', [{ t: 'var', name: 'a' }, { t: 'var', name: 'b' }]),
    rhs: tSym('ite', [
      tSym('nat.eq', [{ t: 'var', name: 'b' }, tSym('nat.z')]),
      { t: 'var', name: 'a' },
      tSym('nat.gcd', [
        { t: 'var', name: 'b' },
        tSym('nat.mod', [{ t: 'var', name: 'a' }, { t: 'var', name: 'b' }])
      ])
    ]),
    origin: 'induced',
    strength: 1,
    sourceClasses: [],
    bits: 60,
    evidence: 10,
    schema: 'measure',
    active: true,
    createdAt: 0,
    useCount: 0
  };
}

const rewriteAnswerOf = (teacher: TeacherAgent, prompt: string): { answer: string; ruleIds: string[] } | null => {
  const answer = teacher.chatAnswer(prompt);
  if (answer.mode !== 'operator' || answer.operator === null || answer.operator.kind !== 'rewrite') return null;
  return { answer: answer.response, ruleIds: answer.operator.ruleIds };
};

describe('R5 — rule-level honesty through the agent', () => {
  test('authored decks answer arithmetic flatly, with rule provenance', async () => {
    const teacher = await freshTeacher();
    const result = rewriteAnswerOf(teacher, 'What is 7 + 5?');
    expect(result).not.toBeNull();
    expect(result!.answer).toBe('The answer is 12.');
    expect(result!.ruleIds.length).toBeGreaterThan(0);
  });

  test('an induced rule speaks HEDGED until the world corroborates it', async () => {
    const teacher = await freshTeacher();
    teacher.registerLearnedRules([inducedGcdRule()]);
    const result = rewriteAnswerOf(teacher, 'What is the greatest common factor of 48 and 36?');
    expect(result).not.toBeNull();
    expect(result!.answer).toBe('I think the answer is 12.');
    expect(result!.ruleIds).toContain('induced-nat.gcd-0');

    // A strong grade corroborates: the hedge lifts. (Graded without an
    // utterance/answer so the fade controller does not blend the verdict
    // — the rule-credit path is orthogonal to the memory fade.)
    teacher.creativeGradeFeedback(
      { traceIds: [], edges: [], ruleIds: ['induced-nat.gcd-0'], derivationSteps: 3 },
      CREATIVE_REINFORCE_SCORE + 0.1
    );
    const again = rewriteAnswerOf(teacher, 'What is the greatest common factor of 48 and 36?');
    expect(again!.answer).toBe('The answer is 12.');
  });

  test('a weak grade weakens exactly the cited rule and records a denial', async () => {
    const teacher = await freshTeacher();
    teacher.registerLearnedRules([inducedGcdRule()]);
    const rule = teacher.rewriteRuleStore().get('induced-nat.gcd-0')!;
    const before = rule.strength;
    teacher.creativeGradeFeedback(
      { traceIds: [], edges: [], ruleIds: ['induced-nat.gcd-0'] },
      CREATIVE_WEAKEN_SCORE - 0.1,
      'What is the greatest common factor of 12 and 8?',
      'The answer is 4.'
    );
    expect(rule.strength).toBeLessThan(before);
    expect(teacher.rewriteRuleStore().denialsOf('induced-nat.gcd-0').length).toBe(1);
    // The grade ledger names the rule for surgical repair.
    const entry = teacher.answerGradeLedger()[teacher.answerGradeLedger().length - 1];
    expect(entry.ruleIds).toContain('induced-nat.gcd-0');
  });

  test('a doubly-denied rule at the floor stops firing — but is never deleted', async () => {
    const teacher = await freshTeacher();
    teacher.registerLearnedRules([inducedGcdRule()]);
    const rule = teacher.rewriteRuleStore().get('induced-nat.gcd-0')!;
    // Five weak grades drive the strength to the floor (1 -> 0.8 -> ... -> 0.1).
    for (let i = 0; i < 5; i += 1) {
      teacher.creativeGradeFeedback(
        { traceIds: [], edges: [], ruleIds: ['induced-nat.gcd-0'] },
        CREATIVE_WEAKEN_SCORE - 0.1,
        'What is the greatest common factor of 12 and 8?',
        'The answer is 4.'
      );
    }
    expect(rule.strength).toBe(0.1);
    expect(teacher.rewriteRuleStore().isStopped('induced-nat.gcd-0')).toBe(true);
    // The rule is stopped (the engine declines), but the record is kept.
    expect(teacher.rewriteRuleStore().get('induced-nat.gcd-0')).toBeDefined();
    const result = rewriteAnswerOf(teacher, 'What is the greatest common factor of 48 and 36?');
    expect(result).toBeNull();
    // The one-shot ledger names the stop.
    expect(teacher.ruleResolutionsView()).toContain('induced-nat.gcd-0');
  });

  test('an uninducible family declines — never a fabricated answer', async () => {
    const teacher = await freshTeacher();
    // gcf without any gcd rule: the term has no rule for nat.gcd — the
    // engine leaves it irreducible, the decoder declines, and the dispatch
    // falls through to ask (never a fabricated number).
    const answer = teacher.chatAnswer('What is the greatest common factor of 48 and 36?');
    expect(answer.mode).not.toBe('operator');
  });

  test('learned rewrite rules survive a bootstrap export/import round-trip', async () => {
    const teacher = await freshTeacher();
    teacher.registerLearnedRules([inducedGcdRule()]);
    const record = teacher.exportBootstrap('en-20000');
    expect(record.rewriteRules?.length).toBe(1);
    expect(record.rewriteRules![0].id).toBe('induced-nat.gcd-0');

    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const restored = new TeacherAgent(session, DECK, null, 1, 0, 7);
    restored.importBootstrap(record);
    expect(restored.rewriteRuleStore().get('induced-nat.gcd-0')).toBeDefined();
    const result = rewriteAnswerOf(restored, 'What is the greatest common factor of 48 and 36?');
    expect(result).not.toBeNull();
    expect(result!.answer).toBe('I think the answer is 12.');
  });

  test('authored deck rules never persist (decks are code)', async () => {
    const teacher = await freshTeacher();
    const record = teacher.exportBootstrap('en-20000');
    expect(record.rewriteRules ?? []).toHaveLength(0);
    // nat.add still works — the decks re-seed on construction.
    const result = rewriteAnswerOf(teacher, 'What is 7 + 5?');
    expect(result!.answer).toBe('The answer is 12.');
  });
});

describe('R4 — the drill loop in rewrite-induction mode', () => {
  test('a memorized gcf drill induces the Euclidean rule and derives fresh prompts', async () => {
    const teacher = await freshTeacher(true);
    const concept = CHECKABLE_CONCEPTS.find((entry) => entry.drill === 'gcf')!;
    let round = 0;
    let verdict = '';
    for (let i = 0; i < 6; i += 1) {
      const result = runDrill(teacher, concept, round);
      round += 1;
      verdict = result.verdict;
      if (verdict === 'rule-induced') break;
    }
    expect(verdict).toBe('rule-induced');
    const result = rewriteAnswerOf(teacher, 'What is the greatest common factor of 48 and 36?');
    expect(result).not.toBeNull();
    expect(result!.answer).toBe('I think the answer is 12.');
  });

  test('R13 migration state: convert-time induces a rewrite rule; convert-length honestly memorizes and asks', async () => {
    // convert-time: the rewrite arm now OWNS the family — the drill
    // induces conv.convert-time (×60) instead of compiling a DSL rule.
    const minute = CHECKABLE_CONCEPTS.find((entry) => entry.drill === 'convert-time')!;
    const timeDeck = [minute, ...minute.dependsOn.map((word) => ({ word, definition: `the concept ${word}`, example: `About ${word}.` }))];
    const timeSession = new ObserverSession(
      { primeCount: 64, gridSize: 128, memoryMode: 'compact' as const, vocabulary: deckVocabulary([...timeDeck], PRIME_SPACE) },
      100
    );
    await timeSession.initialize();
    const timeTeacher = new TeacherAgent(timeSession, timeDeck, null, 1, 0, 7, undefined, undefined, undefined, true);
    timeTeacher.teach('minute');
    for (const prerequisite of minute.dependsOn) timeTeacher.teach(prerequisite);
    const timeResult = runDrill(timeTeacher, minute, 0);
    expect(timeResult.verdict).toBe('rule-induced');
    const learned = timeTeacher.rewriteRuleStore().all().filter((rule) => rule.origin !== 'authored');
    expect(learned.some((rule) => rule.name === 'conv.convert-time' && rule.schema === 'scalar')).toBe(true);
    expect(timeTeacher.compiledRuleCount()).toBe(0);
    const answer = timeTeacher.chatAnswer('How many seconds are in 5 minutes?');
    const operator = answer.mode === 'operator' ? answer.operator : null;
    if (operator !== null && operator.kind === 'rewrite') {
      // The induced rule speaks hedged until the world corroborates it.
      expect(operator.answer).toBe('I think the answer is 300.');
    } else {
      throw new Error(`expected the induced conversion rule to derive, got ${answer.mode}`);
    }
    timeSession.dispose();

    // convert-length: NEITHER arm can express its decimal metric factors —
    // the drill memorizes and asks for the rule (never a fabricated
    // compile). The DSL fallback fires and honestly reports null.
    const centimeter = CHECKABLE_CONCEPTS.find((entry) => entry.drill === 'convert-length')!;
    const lengthDeck = [centimeter, ...centimeter.dependsOn.map((word) => ({ word, definition: `the concept ${word}`, example: `About ${word}.` }))];
    const lengthSession = new ObserverSession(
      { primeCount: 64, gridSize: 128, memoryMode: 'compact' as const, vocabulary: deckVocabulary([...lengthDeck], PRIME_SPACE) },
      100
    );
    await lengthSession.initialize();
    const lengthTeacher = new TeacherAgent(lengthSession, lengthDeck, null, 1, 0, 7, undefined, undefined, undefined, true);
    lengthTeacher.teach('centimeter');
    for (const prerequisite of centimeter.dependsOn) lengthTeacher.teach(prerequisite);
    const lengthResult = runDrill(lengthTeacher, centimeter, 0);
    expect(lengthResult.verdict).toBe('memorized');
    expect(lengthResult.ruleQuestion).toBe('what is the rule for centimeter?');
    expect(lengthTeacher.rewriteRuleStore().all().filter((rule) => rule.origin !== 'authored')).toHaveLength(0);
    expect(lengthTeacher.compiledRuleCount()).toBe(0);
    lengthSession.dispose();
  });
});
