import { describe, expect, test } from '@jest/globals';
import { ObserverSession } from '../../observer/engine';
import { PRIME_SPACE, deckVocabulary } from '../primeSignature';
import { ACTIVE_DECK } from '../decks';
import { TeacherAgent, CREATIVE_WEAKEN_SCORE, CREATIVE_REINFORCE_SCORE } from '../TeacherAgent';
import { parseRewritePrompt } from './parse';
import { parseTaughtRule, validateTaughtRule, taughtRuleSpecFor } from './instruction';
import { RuleStore, RULE_STRENGTH_FLOOR } from './types';
import { tLit, tSym, tVar, termBits } from './terms';
import { chanceLevel } from '../technical/verify';
import type { DeckWord } from '../deck';

const DECK: readonly DeckWord[] = ACTIVE_DECK.slice(0, 300).map((entry) => ({ ...entry }));
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK], PRIME_SPACE)
};

async function freshTeacher(): Promise<TeacherAgent> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  return new TeacherAgent(session, DECK, null, 1, 0, 7);
}

describe('review fixes — C2 exactness guards decline, never truncate', () => {
  test.each([
    ['What is 7 / 2?', 'division'],
    ['What is 2 / 4?', 'division'],
    ['What is 13 percent of 20?', 'percent'],
    ['If 3 * x = 10, what is x?', 'solve-x-mul'],
    ['What is the square root of 50?', 'square-root'],
    ['Which is greater, 5 or 5?', 'comparison']
  ])('prompt %s declines (no confident truncation)', async (prompt) => {
    expect(parseRewritePrompt(prompt)).toBeNull();
    const teacher = await freshTeacher();
    const answer = teacher.chatAnswer(prompt);
    expect(answer.mode).not.toBe('operator');
  });

  test('M1: an odd rounding target never throws out of chatAnswer', async () => {
    const teacher = await freshTeacher();
    expect(() => teacher.chatAnswer('Round 47 to the nearest 5.')).not.toThrow();
    expect(parseRewritePrompt('Round 47 to the nearest 5.')).toBeNull();
    // The generator's targets still derive.
    expect(parseRewritePrompt('Round 47 to the nearest 10.')).not.toBeNull();
  });

  test('exact prompts still derive (guards are precise)', async () => {
    const teacher = await freshTeacher();
    for (const [prompt, expected] of [
      ['What is 8 / 2?', 'The answer is 4.'],
      ['What is 25 percent of 40?', 'The answer is 10.']
    ] as const) {
      const answer = teacher.chatAnswer(prompt);
      const operator = answer.mode === 'operator' ? answer.operator : null;
      if (operator !== null && operator.kind === 'rewrite') {
        expect(operator.answer).toBe(expected);
      } else {
        throw new Error(`expected a derivation for ${prompt}, got ${answer.mode}`);
      }
    }
  });
});

describe('review fixes — M3 taught-rule validation sees the CANDIDATE alone', () => {
  const CORRECT =
    'to find the gcd of a and b: if b is zero the answer is a; otherwise it is the gcd of b and the remainder of a divided by b';
  const CHEATING = 'to find the gcd of a and b: if b is zero the answer is a; otherwise the answer is a';

  test('a cheating rule is rejected even when a correct incumbent exists', async () => {
    const teacher = await freshTeacher();
    // Establish the correct rule first — the shadowing bug made the
    // incumbent answer every validation exercise.
    expect(teacher.teachRewriteRule(CORRECT, 'gcf').adopted).toBe(true);
    const outcome = teacher.teachRewriteRule(CHEATING, 'gcf');
    expect(outcome.adopted).toBe(false);
    expect(outcome.counterexample).toBeDefined();
    // Still only one learned rule — the correct one.
    expect(teacher.rewriteRuleStore().all().filter((rule) => rule.origin !== 'authored')).toHaveLength(1);
  });
});

describe('review fixes — M4 rule lifecycle', () => {
  test('register rejects heads that would break canonical-string equality', () => {
    const store = new RuleStore();
    const base = {
      id: 'x', name: '?evil', lhs: tSym('?evil', [tVar('x')]), rhs: tLit(1),
      origin: 'authored' as const, strength: 1, sourceClasses: ['curriculum'],
      bits: 10, active: true, createdAt: 0, useCount: 0
    };
    expect(() => store.register(base)).toThrow(/canonical-string equality/);
  });

  test('re-registering an id replaces the WHOLE record and resets its world record', () => {
    const store = new RuleStore();
    const make = (rhs: ReturnType<typeof tLit>): Parameters<RuleStore['register']>[0] => ({
      id: 'same', name: 'f', lhs: tSym('f', [tVar('x')]), rhs,
      origin: 'induced' as const, strength: 1, sourceClasses: ['world-feedback'],
      bits: 20, schema: 'measure' as const, evidence: 5, active: true, createdAt: 1, useCount: 9
    });
    store.register(make(tLit(1)));
    store.recordDenial({ ruleId: 'same', input: '#n:1', output: '#n:2', evidence: 'verified-wrong', at: 1 });
    store.adjustStrength('same', -5);
    expect(store.isStopped('same')).toBe(false);
    // Full replacement: fresh body, fresh world record.
    store.register({ ...make(tLit(2)), origin: 'consolidated', strength: 1, sourceClasses: [], schema: undefined, createdAt: 99 });
    const rule = store.get('same')!;
    expect(rule.origin).toBe('consolidated');
    expect(rule.sourceClasses).toEqual([]);
    expect(rule.useCount).toBe(0);
    expect(rule.strength).toBe(1);
    expect(store.denialsOf('same')).toHaveLength(0);
    expect(rule.createdAt).toBe(99);
  });

  test('stopped rules are never re-registered by induction (drill refusal)', async () => {
    const { runDrill } = await import('../technical/drill');
    const { CHECKABLE_CONCEPTS } = await import('../technical/index');
    const concept = CHECKABLE_CONCEPTS.find((entry) => entry.drill === 'gcf')!;
    const deck = [concept, ...concept.dependsOn.map((w) => ({ word: w, definition: `the concept ${w}`, example: `About ${w}.` }))];
    const session = new ObserverSession(
      { primeCount: 64, gridSize: 128, memoryMode: 'compact' as const, vocabulary: deckVocabulary([...deck], PRIME_SPACE) },
      100
    );
    await session.initialize();
    const teacher = new TeacherAgent(session, deck, null, 1, 0, 7, undefined, undefined, undefined, true);
    for (const entry of deck) teacher.teach(entry.word);
    // A stopped gcd rule: two denials at the floor.
    teacher.rewriteRuleStore().register({
      id: 'induced-nat.gcd-0', name: 'nat.gcd',
      lhs: tSym('nat.gcd', [tVar('a'), tVar('b')]),
      rhs: tSym('ite', [tSym('nat.eq', [tVar('b'), tSym('nat.z')]), tVar('a'), tSym('nat.gcd', [tVar('b'), tSym('nat.mod', [tVar('a'), tVar('b')])])]),
      origin: 'induced' as const, strength: RULE_STRENGTH_FLOOR, sourceClasses: ['world-feedback'],
      bits: 60, evidence: 10, schema: 'measure' as const, active: true, createdAt: 0, useCount: 0
    });
    const stoppedId = 'induced-nat.gcd-0';
    // Stop it deterministically at the store level (the graded path to the
    // stop is pinned by the honesty suite's five-grade test; this test's
    // purpose is the DRILL's refusal to resurrect a stopped symbol).
    const store = teacher.rewriteRuleStore();
    store.recordDenial({ ruleId: stoppedId, evidence: 'verified-wrong', input: '#a', output: '#b', at: 1 });
    store.recordDenial({ ruleId: stoppedId, evidence: 'verified-wrong', input: '#c', output: '#d', at: 2 });
    expect(store.isStopped(stoppedId)).toBe(true);
    // The drill must NOT resurrect it: verdicts never produce a new
    // active rule of the stopped name.
    const result = runDrill(teacher, concept, 0);
    expect(result.verdict).not.toBe('rule-induced');
    const active = teacher.rewriteRuleStore().all().filter((r) => r.name === 'nat.gcd' && r.active);
    expect(active.filter((r) => r.id !== stoppedId)).toHaveLength(0);
    session.dispose();
  });
});

describe('review fixes — Med2 P14 withdrawal symmetry', () => {
  test('a weak grade withdraws world-feedback — the rule speaks hedged again', async () => {
    const teacher = await freshTeacher();
    teacher.teachRewriteRule(
      'to find the gcd of a and b: if b is zero the answer is a; otherwise it is the gcd of b and the remainder of a divided by b',
      'gcf'
    );
    const taughtId = teacher.rewriteRuleStore().all().find((r) => r.origin === 'taught')!.id;
    teacher.creativeGradeFeedback({ traceIds: [], edges: [], ruleIds: [taughtId] }, CREATIVE_REINFORCE_SCORE + 0.1);
    expect(teacher.rewriteRuleStore().get(taughtId)!.sourceClasses).toContain('world-feedback');
    // A weak grade now withdraws the credit…
    teacher.creativeGradeFeedback({ traceIds: [], edges: [], ruleIds: [taughtId] }, CREATIVE_WEAKEN_SCORE - 0.1);
    expect(teacher.rewriteRuleStore().get(taughtId)!.sourceClasses).not.toContain('world-feedback');
    // …and the hedge returns.
    const answer = teacher.chatAnswer('What is the greatest common factor of 48 and 36?');
    const operator = answer.mode === 'operator' ? answer.operator : null;
    if (operator !== null && operator.kind === 'rewrite') {
      expect(operator.answer).toBe('I think the answer is 12.');
    } else {
      throw new Error(`expected the rule to derive hedged, got ${answer.mode}`);
    }
  });
});

describe('review fixes — accounting', () => {
  test('chanceLevel knows the new families', () => {
    expect(chanceLevel('place-value')).toBeCloseTo(1 / 28, 6);
    expect(chanceLevel('convert-time')).toBeCloseTo(1 / 30, 6);
    expect(chanceLevel('solve-x-mul')).toBeCloseTo(1 / 11, 6);
  });

  test('RULE_STRENGTH_FLOOR survives registration', () => {
    const store = new RuleStore();
    store.register({
      id: 'x', name: 'f', lhs: tSym('f', [tVar('x')]), rhs: tLit(1),
      origin: 'authored' as const, strength: 0.01, sourceClasses: ['curriculum'],
      bits: termBits(tSym('f', [tVar('x')])) + termBits(tLit(1)), active: true, createdAt: 0, useCount: 0
    });
    expect(store.get('x')!.strength).toBe(RULE_STRENGTH_FLOOR);
  });
});
