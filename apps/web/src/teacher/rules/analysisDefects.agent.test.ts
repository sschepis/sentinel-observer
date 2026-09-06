/**
 * @jest-environment node
 *
 * Agent-level regression gates for the day-one defects in docs/ANALYSIS.md
 * §6 (#2 retention ordering, #7 consolidation ordering, #8 authored-rule
 * guard, #12 negation guard). Companion to ../analysisDefects.test.ts.
 */
import { describe, expect, test } from '@jest/globals';
import { ObserverSession } from '../../observer/engine';
import { PRIME_SPACE, deckVocabulary } from '../primeSignature';
import { ACTIVE_DECK } from '../decks';
import { TeacherAgent, CREATIVE_WEAKEN_SCORE } from '../TeacherAgent';
import { MemoryPersistenceStore } from '../../persistence/store';
import { CONVERSATION_CUE_TOKENS } from '../conversation';
import type { DeckWord } from '../deck';
import { tSym, tVar } from './terms';
import type { RewriteRule } from './types';

const DECK: readonly DeckWord[] = ACTIVE_DECK.slice(0, 300).map((entry) => ({ ...entry }));
/** A content word with a definition — the subject of the negation tests. */
const SUBJECT = DECK.find((entry) => /^[a-z]{4,}$/.test(entry.word) && /^an? /.test(entry.definition ?? ''))!.word;

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

async function freshTeacher(store: MemoryPersistenceStore | null = null): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  return { session, teacher: new TeacherAgent(session, DECK, store, 1, 0, 7) };
}

const rewriteAnswerOf = (teacher: TeacherAgent, prompt: string): { answer: string; ruleIds: string[] } | null => {
  const answer = teacher.chatAnswer(prompt);
  if (answer.mode !== 'operator' || answer.operator === null || answer.operator.kind !== 'rewrite') return null;
  return { answer: answer.response, ruleIds: answer.operator.ruleIds };
};

describe('§6 #8 — authored deck rules are architectural: grades cannot stop them', () => {
  test('five weak grades on addition leave nat.add derivable and unweakened', async () => {
    const { teacher } = await freshTeacher();
    const first = rewriteAnswerOf(teacher, 'What is 7 + 5?');
    expect(first).not.toBeNull();
    const cited = first!.ruleIds;
    const before = cited.map((id) => teacher.rewriteRuleStore().get(id)!.strength);
    for (let i = 0; i < 5; i += 1) {
      teacher.creativeGradeFeedback({ traceIds: [], edges: [], ruleIds: cited }, CREATIVE_WEAKEN_SCORE - 0.1, 'What is 7 + 5?', 'The answer is 12.');
    }
    const after = cited.map((id) => teacher.rewriteRuleStore().get(id)!.strength);
    expect(after).toEqual(before);
    for (const id of cited) {
      expect(teacher.rewriteRuleStore().isStopped(id)).toBe(false);
      expect(teacher.rewriteRuleStore().denialsOf(id).length).toBe(0);
    }
    const again = rewriteAnswerOf(teacher, 'What is 9 + 4?');
    expect(again?.answer).toBe('The answer is 13.');
    // The grade is not lost: it lands as a belief about the family.
    expect(teacher.beliefsOf(cited.map((id) => teacher.rewriteRuleStore().get(id)!.name)[0]).length).toBeGreaterThan(0);
  });
});

describe('§6 #7 — a consolidated rule inherits the corroboration of the rule it replaces', () => {
  test('a world-confirmed bloated gcd rule consolidates into a rule that still speaks flatly', async () => {
    const { teacher } = await freshTeacher();
    const bloated: RewriteRule = {
      id: 'rule-bloated',
      name: 'nat.gcd',
      lhs: tSym('nat.gcd', [tVar('a'), tVar('b')]),
      rhs: tSym('ite', [
        tSym('nat.eq', [tVar('b'), tSym('nat.z')]),
        tVar('a'),
        tSym('nat.gcd', [tVar('b'), tSym('nat.mod', [tVar('a'), tVar('b')])])
      ]),
      origin: 'induced',
      strength: 1,
      sourceClasses: ['world-feedback'],
      bits: 400,
      evidence: 10,
      schema: 'measure',
      active: true,
      createdAt: 0,
      useCount: 3
    };
    teacher.registerLearnedRules([bloated]);
    expect(rewriteAnswerOf(teacher, 'What is the greatest common factor of 48 and 36?')?.answer).toBe('The answer is 12.');
    const report = teacher.consolidateLearnedRules();
    expect(report.consolidated).toContain('rule-bloated');
    const consolidated = teacher.rewriteRuleStore().all().find((rule) => rule.origin === 'consolidated');
    expect(consolidated).toBeDefined();
    expect(consolidated!.sourceClasses).toContain('world-feedback');
    // 3 at registration + the one derivation above: usage is inherited too.
    expect(consolidated!.useCount).toBe(4);
    // Before the fix the replacement lost its corroboration and re-hedged.
    expect(rewriteAnswerOf(teacher, 'What is the greatest common factor of 48 and 36?')?.answer).toBe('The answer is 12.');
  });
});

describe('§6 #12 — declarative negations must name a known, explicit subject', () => {
  test('"this is not a test" and "it is not a problem" do not become taught falsehoods', async () => {
    const { teacher } = await freshTeacher();
    for (const entry of DECK.slice(0, 40)) teacher.teach(entry.word);
    const idiom = teacher.chatAnswer('this is not a test');
    expect(teacher.negationOf('this', 'is-a', 'test') ?? undefined).toBeUndefined();
    expect(idiom.mode).not.toBe('memorized');
    // A pronoun the reference resolver rewrites is not an explicit teaching.
    teacher.teach(SUBJECT);
    teacher.chatAnswer(`tell me about ${SUBJECT}`);
    teacher.chatAnswer('it is not a problem');
    expect(teacher.negationOf(SUBJECT, 'is-a', 'problem') ?? undefined).toBeUndefined();
  });

  test('an explicit negation about a known subject still teaches', async () => {
    const { teacher } = await freshTeacher();
    teacher.teach(SUBJECT);
    const answer = teacher.chatAnswer(`${SUBJECT} is not a zebra`);
    expect(answer.mode).toBe('operator');
    expect(teacher.negationOf(SUBJECT, 'is-a', 'zebra')?.origin).toBe('taught');
  });
});

describe('§6 #2 — the retention law decays the learned weights on restore', () => {
  test('composition weights whose decay clocks are 200 days old come back decayed, not verbatim', async () => {
    const store = new MemoryPersistenceStore();
    const { session, teacher } = await freshTeacher(store);
    teacher.teach(DECK[0].word);
    teacher.creativeGradeFeedback([], 0.8, 'tell me something about yourself', 'I like the weather here.');
    const weights = teacher.getCompositionWeights();
    expect(weights.size).toBeGreaterThan(0);
    const saved = new Map(weights);
    // Age every clock by 200 days (the n-gram preset is 45 days).
    const meta = teacher.getCompositionWeightMeta() as Map<string, number>;
    const ancient = Date.now() - 200 * 24 * 60 * 60 * 1000;
    for (const key of meta.keys()) meta.set(key, ancient);
    await teacher.persistAll();
    session.dispose();

    const { teacher: fresh } = await freshTeacher(store);
    await fresh.restoreFromPersistence();
    const restored = fresh.getCompositionWeights();
    // Before the fix the sweep ran on the empty defaults and the persisted
    // values were loaded verbatim afterwards — nothing ever decayed.
    let decayedOrPruned = 0;
    for (const [key, value] of saved) {
      const now = restored.get(key);
      if (now === undefined || now < value) decayedOrPruned += 1;
    }
    expect(decayedOrPruned).toBe(saved.size);
  });
});
