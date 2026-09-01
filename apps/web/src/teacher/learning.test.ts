/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent, CREATIVE_REINFORCE_SCORE } from './TeacherAgent';
import { OperatorLearner, SLOT_COST } from './operators/learning';
import { TokenCostModel } from './mdl';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { ACTIVE_DECK } from './decks';
import { DECK_100 } from './decks/en-100';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';

const DECK: readonly DeckWord[] = DECK_100.slice(0, 10);
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

/** The real frequency prior — same one TeacherAgent uses. */
const FREQUENCY_MODEL = new TokenCostModel(ACTIVE_DECK.map((entry) => entry.word));

describe('operator learning (MDL induction)', () => {
  let learner: OperatorLearner;

  beforeEach(() => {
    learner = new OperatorLearner();
  });

  it('with uniform costs the classic rule re-emerges: one anecdote, two demos = a pattern', () => {
    learner.learn('do you like tea', 'Yes, I like tea.', 0.9);
    // One example is an anecdote — not yet fireable (savings < template cost).
    expect(learner.apply('do you like water')).toBeNull();
    expect(learner.fireableCount()).toBe(0);

    learner.learn('do you like rain', 'Yes, I like rain.', 0.85);
    expect(learner.fireableCount()).toBe(1);

    const result = learner.apply('do you like water');
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(result.kind).toBe('learned');
      expect(result.slot).toBe('water');
      expect(result.answer).toBe('Yes, I like water.');
    }
  });

  it('MDL with the frequency prior: a cheap common-word demo stays an anecdote', () => {
    const freq = new OperatorLearner(FREQUENCY_MODEL);
    // "tea" is a common word — its single answer does not pay for the shell.
    freq.learn('do you like tea', 'Yes, I like tea.', 0.9);
    expect(freq.fireableCount()).toBe(0);
    expect(freq.apply('do you like rain')).toBeNull();
  });

  it('MDL with the frequency prior: ONE demonstration of an expensive (rare-word) answer earns the operator', () => {
    const freq = new OperatorLearner(FREQUENCY_MODEL);
    // "xylophone" is absent from the deck (20-bit token) — echoing it into a
    // shell saves more bits than the shell costs, so a single demonstration
    // clears the MDL bar. cost(slot) > SLOT_COST is the exact criterion.
    freq.learn('do you like xylophone', 'Yes, I like xylophone.', 0.9);
    expect(SLOT_COST).toBe(15);
    expect(freq.fireableCount()).toBe(1);

    const result = freq.apply('do you like quinoa');
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(result.answer).toBe('Yes, I like quinoa.');
    }
  });

  it('gainOf reports the MDL margin: positive for mature, negative for anecdotes', () => {
    learner.learn('do you like tea', 'Yes, I like tea.', 0.9);
    const audit = learner.audit();
    expect(audit).toHaveLength(1);
    expect(audit[0].templates[0].gain).toBeLessThan(0);
    expect(audit[0].templates[0].mature).toBe(false);

    learner.learn('do you like rain', 'Yes, I like rain.', 0.85);
    const after = learner.audit();
    expect(after[0].templates[0].gain).toBeGreaterThan(0);
    expect(after[0].templates[0].mature).toBe(true);
    expect(after[0].evidence).toBe(2);
  });

  it('REJECTS answers carrying example-specific knowledge (no fabrication)', () => {
    // "Tea is a warm drink." contains knowledge ("warm", "drink") that is
    // not in the utterance — generalizing it to other slots would fabricate.
    learner.learn('what is tea', 'Tea is a warm drink.', 0.9);
    expect(learner.fireableCount()).toBe(0);
    expect(learner.apply('what is water')).toBeNull();
  });

  it('requires identical shells across demonstrations', () => {
    learner.learn('do you like tea', 'Yes, I like tea.', 0.9);
    learner.learn('do you like rain', 'I like rain too.', 0.9);
    // Templates differ — each shell stays an anecdote.
    expect(learner.fireableCount()).toBe(0);
  });

  it('does not learn without echo evidence', () => {
    learner.learn('what is the capital of mars', 'I do not know that.', 0.9);
    expect(learner.fireableCount()).toBe(0);
  });

  it('counts a re-graded identical demonstration ONCE (replay guard — no gain inflation)', () => {
    learner.learn('do you like tea', 'Yes, I like tea.', 0.9);
    const singleGain = learner.audit()[0].templates[0].gain;
    // Re-grading the SAME exchange (or a persistence restore replaying its
    // own creative traces) must not become a second, independent demo.
    learner.learn('do you like tea', 'Yes, I like tea.', 0.95);
    const after = learner.audit();
    expect(after[0].evidence).toBe(1);
    expect(after[0].templates[0].demonstrations).toBe(1);
    expect(after[0].templates[0].gain).toBe(singleGain);
  });

  it('replaces EVERY occurrence of the slot in the shell — no literal leftovers', () => {
    // "I like tea and tea." must become "{slot} and {slot}", never
    // "{slot} and tea" (which would echo a stale word on fire).
    learner.learn('do you like tea', 'Yes, I like tea and tea.', 0.9);
    const result = learner.apply('do you like rain');
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(result.answer).toBe('Yes, I like rain and rain.');
    }
  });

  it('teaches the observer patterns through graded answers and fires in chat', () => {
    const session = new ObserverSession(OPTIONS, 100);
    return (async () => {
      await session.initialize();
      const teacher = new TeacherAgent(session, DECK);
      // Two strong graded answers demonstrate the same shell.
      teacher.creativeGradeFeedback([], CREATIVE_REINFORCE_SCORE + 0.1, 'do you want tea', 'Yes, I want tea.');
      teacher.creativeGradeFeedback([], CREATIVE_REINFORCE_SCORE + 0.1, 'do you want rain', 'Yes, I want rain.');
      expect(teacher.learnedPatternCount()).toBe(1);

      const answer = teacher.chatAnswer('do you want water');
      expect(answer.mode).toBe('operator');
      if (answer.mode === 'operator') {
        expect(answer.response).toBe('Yes, I want water.');
      }
      session.dispose();
    })();
  });

  it('re-grading the SAME exchange at teacher level does not promote the operator', async () => {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK);
    teacher.creativeGradeFeedback([], 0.9, 'do you want tea', 'Yes, I want tea.');
    // Same exchange, re-graded — one anecdote, not two.
    teacher.creativeGradeFeedback([], 0.9, 'do you want tea', 'Yes, I want tea.');
    expect(teacher.learnedPatternCount()).toBe(0);
    expect(teacher.chatAnswer('do you want rain').mode).not.toBe('operator');
    session.dispose();
  });

  it('rebuilds the pattern library from stored memories across sessions', async () => {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK);
    teacher.creativeGradeFeedback([], 0.9, 'do you want tea', 'Yes, I want tea.');
    teacher.creativeGradeFeedback([], 0.9, 'do you want rain', 'Yes, I want rain.');
    const record = teacher.exportBootstrap('test');
    session.dispose();

    const fresh = new ObserverSession(OPTIONS, 100);
    await fresh.initialize();
    const freshTeacher = new TeacherAgent(fresh, DECK);
    freshTeacher.importBootstrap(record);
    expect(freshTeacher.learnedPatternCount()).toBe(1);
    const answer = freshTeacher.chatAnswer('do you want water');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') {
      expect(answer.response).toBe('Yes, I want water.');
    }
    fresh.dispose();
  });
});

describe('relation-hole templates (P6)', () => {
  const edge = (subject: string, predicate: 'is-a' | 'has-part', object: string) =>
    ({ subject, predicate, object, source: 'def', origin: 'regex' as const });
  const relations = (): readonly ReturnType<typeof edge>[] => [
    edge('robin', 'is-a', 'bird'),
    edge('sparrow', 'is-a', 'bird'),
    edge('bird', 'has-part', 'wings')
  ];

  it('a relation-backed answer learns a hole template and fires on fresh slots', () => {
    const learner = new OperatorLearner(FREQUENCY_MODEL, relations);
    // "a robin is a bird": 'bird' is derivable from robin via the is-a edge,
    // so the guard admits it as a hole instead of rejecting the answer.
    expect(learner.learn('what is a robin', 'a robin is a bird', 0.9)).not.toBeNull();
    learner.learn('what is a sparrow', 'a sparrow is a bird', 0.9);
    expect(learner.fireableCount()).toBe(1);

    const result = learner.apply('what is a robin');
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(result.slot).toBe('robin');
      expect(result.answer).toBe('a robin is a bird');
    }
  });

  it('declines at FIRE time when the backing edge vanished', () => {
    const learner = new OperatorLearner(FREQUENCY_MODEL, relations);
    learner.learn('what is a robin', 'a robin is a bird', 0.9);
    learner.learn('what is a sparrow', 'a sparrow is a bird', 0.9);
    expect(learner.fireableCount()).toBe(1);

    // 'dog' has no is-a edge: the hole cannot be filled, the operator declines
    // — grounding is a fire-time invariant, never a learn-time promise.
    expect(learner.apply('what is a dog')).toBeNull();
  });

  it('still rejects a content word the graph cannot back', () => {
    const learner = new OperatorLearner(FREQUENCY_MODEL, relations);
    // 'mountain' is not derivable from robin via any stored edge — the
    // example-specific answer is rejected exactly like "Tea is a warm drink."
    expect(learner.learn('what is a robin', 'a robin is a mountain', 0.9)).toBeNull();
    expect(learner.fireableCount()).toBe(0);
  });

  it('multiple holes of the same predicate resolve in object order', () => {
    const multiRelations = () => [edge('bird', 'has-part', 'wings'), edge('bird', 'has-part', 'feathers')];
    const learner = new OperatorLearner(FREQUENCY_MODEL, multiRelations);
    learner.learn('what is a bird', 'a bird has wings and feathers', 0.9);
    const result = learner.apply('what is a bird');
    expect(result?.answer).toBe('a bird has wings and feathers');
  });

  it('a hole word REPEATED in the answer keeps one marker (both occurrences resolve to the same object)', () => {
    // robin is-a bird (direct), bird is-a creature (inherited): the answer
    // "a robin is a bird and a bird is a creature" contains 'bird' twice.
    // The old per-entry counter stamped the second occurrence with
    // {p:is-a:2}, which ran past the object list and the operator declined
    // every time — the repeated-derivation pattern was silently unlearnable.
    const repeatRelations = () => [
      edge('robin', 'is-a', 'bird'),
      edge('bird', 'is-a', 'creature')
    ];
    const learner = new OperatorLearner(FREQUENCY_MODEL, repeatRelations);
    const id = learner.learn('what is a robin', 'a robin is a bird and a bird is a creature', 0.9);
    expect(id).not.toBeNull();

    // The template carries the DISTINCT derivation markers — repeated
    // 'bird' occurrences share {p:is-a}, 'creature' gets {p:is-a:1}.
    const template = learner.templatesOf('what is a')[0];
    expect(template).toBe('a {slot} is a {p:is-a} and a {p:is-a} is a {p:is-a:1}');

    // Fire time resolves what the graph can fill: 'bird' → bird; the
    // inherited 'creature' hole stays unresolved ONLY if edgeObjects can't
    // fill it — the operator then declines honestly (never a stale echo).
    const result = learner.apply('what is a robin');
    if (result !== null) {
      expect(result.answer).toBe('a robin is a bird and a bird is a creature');
    }
  });

  it('pure echo behavior is unchanged when no relations are supplied', () => {
    const learner = new OperatorLearner();
    expect(learner.learn('do you like tea', 'Yes, I like tea.', 0.9)).not.toBeNull();
    learner.learn('do you like rain', 'Yes, I like rain.', 0.85);
    const result = learner.apply('do you like water');
    expect(result?.answer).toBe('Yes, I like water.');
  });
});
