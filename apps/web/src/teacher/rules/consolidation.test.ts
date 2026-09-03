import { describe, expect, test } from '@jest/globals';
import { ObserverSession } from '../../observer/engine';
import { PRIME_SPACE, deckVocabulary } from '../primeSignature';
import { ACTIVE_DECK } from '../decks';
import { TeacherAgent, CREATIVE_REINFORCE_SCORE } from '../TeacherAgent';
import { generateExercises, verify } from '../technical/verify';
import { tSym, termBits, tVar } from './terms';
import { RuleStore, type RewriteRule } from './types';
import { RULE_CORROBORATION_HORIZON_MS } from './maintenance';
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

function gcdRule(id: string, overrides: Partial<RewriteRule> = {}): RewriteRule {
  const rhs = tSym('ite', [
    tSym('nat.eq', [tVar('b'), tSym('nat.z')]),
    tVar('a'),
    tSym('nat.gcd', [tVar('b'), tSym('nat.mod', [tVar('a'), tVar('b')])])
  ]);
  const lhs = tSym('nat.gcd', [tVar('a'), tVar('b')]);
  return {
    id,
    name: 'nat.gcd',
    lhs,
    rhs,
    origin: 'induced',
    strength: 1,
    sourceClasses: ['world-feedback'],
    bits: termBits(lhs) + termBits(rhs),
    evidence: 10,
    schema: 'measure',
    active: true,
    createdAt: 0,
    useCount: 3,
    ...overrides
  };
}

describe('R16 — decay: weaken-toward-hedged, never forget', () => {
  test('an unused corroborated rule decays to hedged and keeps working', async () => {
    const teacher = await freshTeacher();
    teacher.registerLearnedRules([gcdRule('rule-a', { lastUsedAt: 0 })]);
    const now = RULE_CORROBORATION_HORIZON_MS + 1000;
    const { decayed } = teacher.decayRuleCorroboration(now, RULE_CORROBORATION_HORIZON_MS);
    expect(decayed).toEqual(['rule-a']);
    const rule = teacher.rewriteRuleStore().get('rule-a')!;
    expect(rule.sourceClasses).toEqual([]);
    expect(rule.active).toBe(true);
    // Still answers — hedged again.
    const answer = teacher.chatAnswer('What is the greatest common factor of 48 and 36?');
    const operator = answer.mode === 'operator' ? answer.operator : null;
    if (operator !== null && operator.kind === 'rewrite') {
      expect(operator.answer).toBe('I think the answer is 12.');
    } else {
      throw new Error(`expected the decayed rule to keep deriving, got ${answer.mode}`);
    }
  });

  test('a recently-used rule keeps its world credit', async () => {
    const teacher = await freshTeacher();
    teacher.registerLearnedRules([gcdRule('rule-a', { lastUsedAt: Date.now() })]);
    const { decayed } = teacher.decayRuleCorroboration(Date.now() + 1000, RULE_CORROBORATION_HORIZON_MS);
    expect(decayed).toEqual([]);
    expect(teacher.rewriteRuleStore().get('rule-a')!.sourceClasses).toContain('world-feedback');
  });

  test('authored decks never decay', async () => {
    const teacher = await freshTeacher();
    const authored = teacher.rewriteRuleStore().all().filter((rule) => rule.origin === 'authored');
    expect(authored.length).toBeGreaterThan(0);
    const { decayed } = teacher.decayRuleCorroboration(Number.MAX_SAFE_INTEGER, 1);
    expect(decayed).toEqual([]);
  });

  test('decay flips exactly the hedge and nothing else (re-corroboration restores it)', async () => {
    const teacher = await freshTeacher();
    teacher.registerLearnedRules([gcdRule('rule-a', { lastUsedAt: 0 })]);
    teacher.decayRuleCorroboration(RULE_CORROBORATION_HORIZON_MS + 1, RULE_CORROBORATION_HORIZON_MS);
    // A strong grade re-corroborates: flat again.
    teacher.creativeGradeFeedback({ traceIds: [], edges: [], ruleIds: ['rule-a'] }, CREATIVE_REINFORCE_SCORE + 0.1);
    const rule = teacher.rewriteRuleStore().get('rule-a')!;
    expect(rule.sourceClasses).toContain('world-feedback');
    expect(rule.strength).toBeGreaterThanOrEqual(1);
  });
});

describe('R16 — consolidation: behavior-preserving shelf cleaning', () => {
  test('structural dedupe collapses identical learned rules and keeps the cheaper', async () => {
    const teacher = await freshTeacher();
    const keeper = gcdRule('rule-a', { bits: 50 });
    const duplicate = gcdRule('rule-b', { bits: 60, useCount: 7, sourceClasses: [] });
    teacher.registerLearnedRules([keeper, duplicate]);
    const report = teacher.consolidateLearnedRules();
    expect(report.deduped).toEqual(['rule-b']);
    expect(teacher.rewriteRuleStore().get('rule-b')!.active).toBe(false);
    expect(teacher.rewriteRuleStore().get('rule-a')!.useCount).toBe(10);
    // Identical answers before and after — the bench is the gate.
    const exercises = generateExercises('gcf', 'greatest common factor', { count: 20, seed: 4242 });
    for (const exercise of exercises) {
      const answer = teacher.chatAnswer(exercise.prompt);
      expect(answer.mode).toBe('operator');
      if (answer.mode === 'operator' && answer.operator !== null) {
        expect(verify(exercise, answer.response).correct).toBe(true);
      }
    }
  });

  test('grade-driven denials are never compacted (the two-denial stop counts them)', async () => {
    const teacher = await freshTeacher();
    teacher.registerLearnedRules([gcdRule('rule-a')]);
    teacher.creativeGradeFeedback({ traceIds: [], edges: [], ruleIds: ['rule-a'] }, 0.1);
    teacher.creativeGradeFeedback({ traceIds: [], edges: [], ruleIds: ['rule-a'] }, 0.1);
    const denials = teacher.rewriteRuleStore().denialsOf('rule-a').length;
    expect(denials).toBe(2);
    const report = teacher.consolidateLearnedRules();
    // Two independent world rejections stay two — compaction must never
    // let a wrongly graded rule stop being stoppable.
    expect(report.compactedDenials).toBe(0);
    expect(teacher.rewriteRuleStore().denialsOf('rule-a').length).toBe(2);
  });

  test('byte-identical answers across the whole family pool after consolidation', async () => {
    const teacher = await freshTeacher();
    teacher.registerLearnedRules([gcdRule('rule-a')]);
    const spoken = (exercise: { prompt: string }): string => {
      const answer = teacher.chatAnswer(exercise.prompt);
      return answer.mode === 'decline' ? 'decline' : answer.response;
    };
    const before = generateExercises('gcf', 'greatest common factor', { count: 20, seed: 77 }).map(spoken);
    teacher.consolidateLearnedRules();
    const after = generateExercises('gcf', 'greatest common factor', { count: 20, seed: 77 }).map(spoken);
    expect(after).toEqual(before);
  });

  test('consolidation never touches authored decks', async () => {
    const teacher = await freshTeacher();
    const authoredBefore = teacher.rewriteRuleStore().all().filter((rule) => rule.origin === 'authored').map((rule) => rule.id);
    teacher.consolidateLearnedRules();
    const authoredAfter = teacher.rewriteRuleStore().all().filter((rule) => rule.origin === 'authored').map((rule) => rule.id);
    expect(authoredAfter).toEqual(authoredBefore);
  });

  test('re-simplification can adopt a strictly cheaper rule under the consolidated origin', async () => {
    const teacher = await freshTeacher();
    // A deliberately bloated gcd rule (same behavior, bigger body).
    const bloatedRhs = tSym('ite', [
      tSym('nat.eq', [tVar('b'), tSym('nat.z')]),
      tVar('a'),
      tSym('nat.gcd', [tVar('b'), tSym('nat.mod', [tVar('a'), tVar('b')])])
    ]);
    const lhs = tSym('nat.gcd', [tVar('a'), tVar('b')]);
    const bloated = {
      id: 'rule-bloated',
      name: 'nat.gcd',
      lhs,
      rhs: bloatedRhs,
      origin: 'induced' as const,
      strength: 1,
      sourceClasses: [] as string[],
      bits: 400, // far above the true description length
      evidence: 10,
      schema: 'measure' as const,
      active: true,
      createdAt: 0,
      useCount: 0
    };
    teacher.registerLearnedRules([bloated]);
    // The teacher's rule store also hosts the DECKS; consolidation's
    // re-induction simulates against the library and must find the cheap
    // Euclidean form.
    const report = teacher.consolidateLearnedRules();
    const consolidated = teacher.rewriteRuleStore().all().find((rule) => rule.origin === 'consolidated');
    expect(consolidated).toBeDefined();
    expect(consolidated!.bits).toBeLessThan(100);
    expect(report.consolidated).toContain('rule-bloated');
    expect(teacher.rewriteRuleStore().get('rule-bloated')!.active).toBe(false);
    const answer = teacher.chatAnswer('What is the greatest common factor of 48 and 36?');
    const operator = answer.mode === 'operator' ? answer.operator : null;
    if (operator !== null && operator.kind === 'rewrite') {
      expect(operator.answer).toBe('I think the answer is 12.');
    } else {
      throw new Error(`expected the consolidated rule to derive, got ${answer.mode}`);
    }
  });

  test('the RuleStore primitives back the maintenance methods', () => {
    const store = new RuleStore();
    store.register(gcdRule('a', { createdAt: 0, useCount: 0 }));
    store.removeSourceClass('a', 'world-feedback');
    expect(store.get('a')!.sourceClasses).toEqual([]);
    // Structurally identical DENIED DERIVATIONS (same input + output)
    // compact; input-less grade denials never do.
    store.recordDenial({ ruleId: 'a', input: '12, 8', output: '4', evidence: 'verified-wrong', at: 1 });
    store.recordDenial({ ruleId: 'a', input: '12, 8', output: '4', evidence: 'verified-wrong', at: 2 });
    store.recordDenial({ ruleId: 'a', input: '9, 6', output: '3', evidence: 'verified-wrong', at: 3 });
    store.recordDenial({ ruleId: 'a', evidence: 'graded-wrong', at: 4 });
    store.recordDenial({ ruleId: 'a', evidence: 'graded-wrong', at: 5 });
    expect(store.compactDenials()).toBe(1);
    expect(store.allDenials()).toHaveLength(4);
  });
});
