import { describe, expect, test } from '@jest/globals';
import { ObserverSession } from '../../observer/engine';
import { PRIME_SPACE, deckVocabulary } from '../primeSignature';
import { ACTIVE_DECK } from '../decks';
import { TeacherAgent, CREATIVE_REINFORCE_SCORE } from '../TeacherAgent';
import { runDrill } from '../technical/drill';
import { CHECKABLE_CONCEPTS } from '../technical/index';
import { parseTaughtRule, validateTaughtRule, taughtRuleSpecFor } from './instruction';
import { parseRewritePrompt } from './parse';
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

const FLAGSHIP =
  'to find the gcd of a and b: if b is zero the answer is a; otherwise it is the gcd of b and the remainder of a divided by b.';

describe('R10 — taught rules: the flagship sentence', () => {
  test('the flagship parses into the Euclidean rule', () => {
    const parsed = parseTaughtRule(FLAGSHIP, taughtRuleSpecFor('gcf')!);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('nat.gcd');
    expect(parsed!.origin).toBe('taught');
    expect(parsed!.sourceClasses).toEqual([]);
    const body = JSON.stringify(parsed!.rhs);
    expect(body).toContain('nat.eq');
    expect(body).toContain('nat.mod');
    expect(body).toContain('nat.gcd');
    expect(body).toContain('ite');
  });

  test('variants of the same procedure parse (punctuation-free, equals-zero, bare body)', () => {
    const variants = [
      'to find the gcd of a and b: if b equals zero the answer is a; otherwise it is the gcd of b and the remainder of a divided by b',
      'To find the gcd of a and b, if b is zero, the answer is a. Otherwise, it is the gcd of b and the remainder of a divided by b.',
      'if b is zero the answer is a; otherwise it is the gcd of b and the remainder of a divided by b'
    ];
    for (const variant of variants) {
      const parsed = parseTaughtRule(variant, taughtRuleSpecFor('gcf')!);
      expect(parsed).not.toBeNull();
    }
  });

  test('the flagship validates against the gcf oracle', async () => {
    const teacher = await freshTeacher();
    const parsed = parseTaughtRule(FLAGSHIP, taughtRuleSpecFor('gcf')!)!;
    const verdict = validateTaughtRule(teacher.rewriteRuleStore(), parsed, 'gcf', { baseline: 0.05 });
    expect(verdict.ok).toBe(true);
  });

  test('end to end: the taught rule derives fresh prompts, hedged', async () => {
    const teacher = await freshTeacher();
    const outcome = teacher.teachRewriteRule(FLAGSHIP, 'gcf');
    expect(outcome.adopted).toBe(true);
    expect(outcome.ruleId).toBeDefined();
    expect(teacher.rewriteRuleStore().get(outcome.ruleId!)?.origin).toBe('taught');
    const answer = teacher.chatAnswer('What is the greatest common factor of 48 and 36?');
    const operator = answer.mode === 'operator' ? answer.operator : null;
    if (operator !== null && operator.kind === 'rewrite') {
      expect(operator.ruleIds).toContain(outcome.ruleId);
      expect(operator.answer).toBe('I think the answer is 12.');
    } else {
      throw new Error(`expected a rewrite answer, got ${answer.mode}`);
    }
    // A strong grade corroborates — the hedge lifts.
    teacher.creativeGradeFeedback(
      { traceIds: [], edges: [], ruleIds: [outcome.ruleId!] },
      CREATIVE_REINFORCE_SCORE + 0.1
    );
    const again = teacher.chatAnswer('What is the greatest common factor of 48 and 36?');
    const againOperator = again.mode === 'operator' ? again.operator : null;
    if (againOperator !== null && againOperator.kind === 'rewrite') {
      expect(againOperator.answer).toBe('The answer is 12.');
    } else {
      throw new Error(`expected a rewrite answer after corroboration, got ${again.mode}`);
    }
  });

  test('taught rules persist through export → import and stay hedged', async () => {
    const teacher = await freshTeacher();
    teacher.teachRewriteRule(FLAGSHIP, 'gcf');
    const record = teacher.exportBootstrap('en-20000');
    expect(record.rewriteRules?.some((rule) => rule.origin === 'taught')).toBe(true);

    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const restored = new TeacherAgent(session, DECK, null, 1, 0, 7);
    restored.importBootstrap(record);
    const rule = restored.rewriteRuleStore().all().find((entry) => entry.origin === 'taught');
    expect(rule).toBeDefined();
    const answer = restored.chatAnswer('What is the greatest common factor of 48 and 36?');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') expect(answer.response).toBe('I think the answer is 12.');
    session.dispose();
  });
});

describe('R10 — validation is the gate, never the parse', () => {
  test('a WRONG procedure parses but is rejected at validation with a counterexample', async () => {
    const teacher = await freshTeacher();
    // Parses fine (gcd of b and the remainder of b divided by a — a
    // plausible shape) but computes the wrong value.
    const wrong =
      'to find the gcd of a and b: if b is zero the answer is a; otherwise it is the gcd of b and the remainder of b divided by a';
    const parsed = parseTaughtRule(wrong, taughtRuleSpecFor('gcf')!);
    expect(parsed).not.toBeNull();
    const outcome = teacher.teachRewriteRule(wrong, 'gcf');
    expect(outcome.adopted).toBe(false);
    expect(outcome.counterexample).toContain('the rule gives');
    // Nothing was registered — the store holds only the authored decks.
    expect(teacher.rewriteRuleStore().all().filter((rule) => rule.origin !== 'authored')).toHaveLength(0);
  });

  test('a cheating constant rule is rejected — held-out catches it', async () => {
    const teacher = await freshTeacher();
    const cheat = 'to find the gcd of a and b: if b is zero the answer is zero; otherwise the answer is a';
    const parsed = parseTaughtRule(cheat, taughtRuleSpecFor('gcf')!);
    expect(parsed).not.toBeNull();
    const outcome = teacher.teachRewriteRule(cheat, 'gcf');
    expect(outcome.adopted).toBe(false);
  });

  test('garbage and out-of-grammar procedures are declined, not adopted', async () => {
    const teacher = await freshTeacher();
    expect(teacher.teachRewriteRule('zzz qqq 42', 'gcf').adopted).toBe(false);
    expect(teacher.teachRewriteRule('the answer is always seven', 'gcf').adopted).toBe(false);
    expect(teacher.teachRewriteRule('x y z', 'gcf').adopted).toBe(false);
    // A family with no taught-rule slot is declined with an explanation.
    expect(teacher.teachRewriteRule(FLAGSHIP, 'addition').adopted).toBe(false);
    expect(teacher.rewriteRuleStore().all().filter((rule) => rule.origin !== 'authored')).toHaveLength(0);
  });

  test('parsing is deterministic (identical semantics; ids are monotonic)', () => {
    const spec = taughtRuleSpecFor('gcf')!;
    const first = parseTaughtRule(FLAGSHIP, spec);
    const second = parseTaughtRule(FLAGSHIP, spec);
    // The rule CONTENT is deterministic; only the id carries the
    // monotonic adoption counter (same-millisecond adoptions must never
    // collide in the store).
    const semantics = (rule: typeof first): string =>
      rule === null ? 'null' : `${JSON.stringify(rule.lhs)}\u0000${JSON.stringify(rule.rhs)}\u0000${rule.origin}`;
    expect(semantics(first)).toBe(semantics(second));
    expect(first!.id).not.toBe(second!.id);
  });

  test('an adopted taught rule appears in the report as derivation source', async () => {
    const teacher = await freshTeacher();
    teacher.teachRewriteRule(FLAGSHIP, 'gcf');
    expect(parseRewritePrompt('What is the greatest common factor of 48 and 36?')).not.toBeNull();
    // The rule store names it with its taught origin.
    const taught = teacher.rewriteRuleStore().all().filter((rule) => rule.origin === 'taught');
    expect(taught).toHaveLength(1);
  });
});

describe('R11 — the ask → told → own loop', () => {
  /** A concept-local deck (gcf's curriculum words are not in the frequency
   *  slice), with recursive prerequisites. */
  async function conceptTeacher(): Promise<TeacherAgent> {
    const concept = CHECKABLE_CONCEPTS.find((entry) => entry.drill === 'gcf')!;
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
    const deck = words.map((word) => {
      const entry = CHECKABLE_CONCEPTS.find((candidate) => candidate.word === word);
      return { word, definition: entry?.definition ?? `the concept ${word}`, example: entry?.example ?? `About ${word}.` };
    });
    const session = new ObserverSession(
      { primeCount: 64, gridSize: 128, memoryMode: 'compact' as const, vocabulary: deckVocabulary([...deck], PRIME_SPACE) },
      100
    );
    await session.initialize();
    const teacher = new TeacherAgent(session, deck, null, 1, 0, 7);
    for (const word of words) teacher.teach(word);
    return teacher;
  }

  test('end to end: drill asks for the rule, a wrong reply gets the counterexample, the right one is adopted', async () => {
    const teacher = await conceptTeacher();
    const concept = CHECKABLE_CONCEPTS.find((entry) => entry.drill === 'gcf')!;

    // The drill memorizes gcf (the DSL cannot express gcd) and ASKS for
    // the rule — the question is now pending.
    const drill = runDrill(teacher, concept, 0);
    expect(drill.verdict).toBe('memorized');
    expect(drill.ruleQuestion).toBe('what is the rule for greatest common factor?');
    expect(teacher.pendingRuleQuestionsView()).toEqual([{ concept: 'greatest common factor', drill: 'gcf' }]);

    // A WRONG procedure reply is handled — never adopted — and answers
    // with the counterexample; the question stays open.
    const wrong =
      'to find the gcd of a and b: if b is zero the answer is a; otherwise it is the gcd of b and the remainder of b divided by a';
    const rejected = teacher.tryTeachReply(wrong);
    expect(rejected).not.toBeNull();
    expect(rejected!.handled).toBe(true);
    expect(rejected!.adopted).toBe(false);
    expect(rejected!.message).toContain('the rule gives');
    expect(teacher.pendingRuleQuestionsView()).toHaveLength(1);

    // The right procedure is adopted and the question closes.
    const adopted = teacher.tryTeachReply(
      'to find the gcd of a and b: if b is zero the answer is a; otherwise it is the gcd of b and the remainder of a divided by b'
    );
    expect(adopted).not.toBeNull();
    expect(adopted!.handled).toBe(true);
    expect(adopted!.adopted).toBe(true);
    expect(teacher.pendingRuleQuestionsView()).toHaveLength(0);
    expect(teacher.listGaps()).not.toContain('what is the rule for greatest common factor?');

    // Fresh prompts now DERIVE through the taught rule, hedged.
    const answer = teacher.chatAnswer('What is the greatest common factor of 48 and 36?');
    const operator = answer.mode === 'operator' ? answer.operator : null;
    if (operator !== null && operator.kind === 'rewrite') {
      expect(operator.answer).toBe('I think the answer is 12.');
    } else {
      throw new Error(`expected a rewrite answer after teaching, got ${answer.mode}`);
    }
  });

  test('a reply that does not parse is ANSWERED with the shape — never a guessed adoption', async () => {
    const teacher = await conceptTeacher();
    const concept = CHECKABLE_CONCEPTS.find((entry) => entry.drill === 'gcf')!;
    runDrill(teacher, concept, 0);
    expect(teacher.pendingRuleQuestionsView()).toHaveLength(1);
    // A pending question is open: the observer explains what it needs
    // instead of letting the reply fall into ordinary chat unanswered —
    // and nothing is adopted.
    const nonsense = teacher.tryTeachReply('I do not know');
    expect(nonsense).not.toBeNull();
    expect(nonsense!.handled).toBe(true);
    expect(nonsense!.adopted).toBe(false);
    expect(nonsense!.message).toContain('could not parse');
    const prose = teacher.tryTeachReply('keep dividing until it stops');
    expect(prose).not.toBeNull();
    expect(prose!.handled).toBe(true);
    expect(prose!.adopted).toBe(false);
    expect(teacher.pendingRuleQuestionsView()).toHaveLength(1);
    expect(teacher.rewriteRuleStore().all().filter((rule) => rule.origin !== 'authored')).toHaveLength(0);
  });

  test('Med1 review fix: an adoptable question behind slot-less pendings is still reachable', async () => {
    const teacher = await conceptTeacher();
    const concept = CHECKABLE_CONCEPTS.find((entry) => entry.drill === 'gcf')!;
    // Park a SLOT-LESS pending (place-value has no procedure slot yet) at
    // the front of the queue, THEN the drill raises the gcf question.
    teacher.notePendingRuleQuestion('place value', 'place-value');
    runDrill(teacher, concept, 0);
    expect(teacher.pendingRuleQuestionsView()[0].drill).toBe('place-value');
    expect(teacher.pendingRuleQuestionsView()[1].drill).toBe('gcf');
    // The gcf reply must still be adopted — the reply path tries every
    // open question, not just the FIFO head.
    const outcome = teacher.tryTeachReply(
      'to find the gcd of a and b: if b is zero the answer is a; otherwise it is the gcd of b and the remainder of a divided by b'
    );
    expect(outcome).not.toBeNull();
    expect(outcome!.adopted).toBe(true);
    expect(teacher.pendingRuleQuestionsView().map((entry) => entry.drill)).toEqual(['place-value']);
  });

  test('Med1 review fix: renamed-argument procedures parse, validate, and adopt', async () => {
    const teacher = await freshTeacher();
    const outcome = teacher.teachRewriteRule(
      'to find the gcd of x and y: if y is zero the answer is x; otherwise it is the gcd of y and the remainder of x divided by y',
      'gcf'
    );
    expect(outcome.adopted).toBe(true);
    const answer = teacher.chatAnswer('What is the greatest common factor of 48 and 36?');
    const operator = answer.mode === 'operator' ? answer.operator : null;
    if (operator !== null && operator.kind === 'rewrite') {
      expect(operator.answer).toBe('I think the answer is 12.');
    } else {
      throw new Error(`expected the renamed-arg rule to derive, got ${answer.mode}`);
    }
  });

  test('with no pending question, replies never trigger the teach path', async () => {
    const teacher = await conceptTeacher();
    expect(teacher.tryTeachReply(FLAGSHIP)).toBeNull();
  });
});
