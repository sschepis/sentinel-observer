/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent, type CreativeReply } from './TeacherAgent';
import { DECK_100 } from './decks/en-100';
import { CHECKABLE_CONCEPTS } from './technical';
import { runDrill } from './technical/drill';
import { OperatorLearner } from './operators/learning';
import { TokenCostModel } from './mdl';
import { ACTIVE_DECK } from './decks';
import { criticize } from './groundedFrames';
import { stripHedges } from './grounding';

const STARTER_DECK = DECK_100.slice(0, 12);

/**
 * The word loop end to end: the teacher teaches, the observer learns, is
 * quizzed, answers from memory, and is graded — with the grade feeding real
 * events back into its field.
 *
 * Each test gets a FRESH observer so accumulated learning state from one
 * test cannot tilt the recall ranking of another.
 */
describe('TeacherAgent word loop', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    session = new ObserverSession({}, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, STARTER_DECK);
  });

  afterEach(() => {
    session.dispose();
  });

  it('teaches a word and binds its memory trace', () => {
    const result = teacher.teach('apple');
    expect(result.traceId).not.toBeNull();
    expect(result.word.word).toBe('apple');

    const entry = teacher.listWords().find((w) => w.word.word === 'apple');
    expect(entry?.status).toBe('learning');
    expect(entry?.strength).not.toBeNull();
  });

  it('the observer answers recognition cues from its memory', () => {
    teacher.teach('apple');
    const answer = teacher.ask('apple', 'recognition');
    expect(answer.cue).toBe('apple');
    // The observer should recall SOMETHING it was taught (its trace content).
    expect(answer.answer.length).toBeGreaterThan(0);
    expect(answer.answer.toLowerCase()).toContain('apple');
  });

  it('grades a correct recall as success and reinforces the observer', () => {
    teacher.teach('apple');
    const answer = teacher.ask('apple', 'recognition');
    const grade = teacher.grade('apple', answer);

    expect(grade.verdict).toBe('correct');
    expect(grade.confidence).not.toBeNull();
    expect(grade.expected.toLowerCase()).toContain('fruit');

    const entry = teacher.listWords().find((w) => w.word.word === 'apple');
    expect(entry?.successes).toBe(1);
    expect(entry?.failures).toBe(0);
  });

  it('a right trace is CORRECT even when the raw recall score is low (confidence is separate)', () => {
    // Regression: the observer recalled exactly the right trace — the answer
    // content begins with the word itself. The score magnitude must never
    // demote a right answer to a lesser verdict; it is reported as confidence.
    teacher.teach('apple');
    const answer = teacher.ask('apple', 'recognition');
    expect(answer.answer.toLowerCase()).toContain('apple');

    // Simulate a low raw score while keeping the right trace ranked first.
    if (answer.recall !== null) {
      (answer.recall as { score: number }).score = 0.32;
    }
    const grade = teacher.grade('apple', answer);

    expect(grade.verdict).toBe('correct');
    expect(grade.confidence).toBeCloseTo(0.32, 5);
    const entry = teacher.listWords().find((w) => w.word.word === 'apple');
    expect(entry?.successes).toBe(1);
  });

  it('grades a blank answer as wrong and feeds a failure event', () => {
    teacher.teach('house');
    const blank = teacher.ask('house', 'recognition');
    blank.recall = null;
    (blank as { answer: string }).answer = '';

    const grade = teacher.grade('house', blank);
    expect(grade.verdict).toBe('wrong');
    const entry = teacher.listWords().find((w) => w.word.word === 'house');
    expect(entry?.failures).toBe(1);
  });

  it('production cue asks the observer to produce the word from the meaning', () => {
    teacher.teach('water');
    const answer = teacher.ask('water', 'production');
    expect(answer.cue).toBe(STARTER_DECK.find((w) => w.word === 'water')?.definition);
    // With only ONE learned word, the observer must recall it for any cue.
    expect(answer.answer.toLowerCase()).toContain('water');
  });

  it('a wrong recall for a production cue is graded honestly as wrong', () => {
    // Teach both words; the production cue for 'water' is asked BEFORE the
    // observer has had repeated reinforcement, so the ranking is genuinely
    // its answer — correct OR confused. The point: whatever it said is what
    // gets graded, with no human override.
    teacher.teach('water');
    teacher.teach('apple');
    const answer = teacher.ask('water', 'production');
    const grade = teacher.grade('water', answer);

    if (answer.answer.toLowerCase().includes('water')) {
      expect(grade.verdict).toBe('correct');
    } else {
      expect(grade.verdict).toBe('wrong');
      expect(grade.answer).not.toBe('');
    }
  });

  it("the observer's curiosity asks for due words; a reviewed word drops out of the queue (P9 FSRS)", () => {
    for (const word of ['friend', 'book', 'music']) {
      teacher.teach(word);
    }
    // A freshly taught word is due immediately (dueAt = teach time).
    const friendState = teacher.tryState('friend');
    expect(friendState?.dueAt).not.toBeNull();
    if (friendState?.dueAt !== null && friendState?.dueAt !== undefined) {
      expect(friendState.dueAt).toBeLessThanOrEqual(Date.now());
    }

    // Review 'friend' correctly: the FSRS update stretches its stability and
    // schedules the next review ~1.5 days out — it must drop out of the queue.
    const answer = teacher.ask('friend', 'recognition');
    teacher.grade('friend', answer);
    const reviewed = teacher.tryState('friend');
    expect(reviewed?.dueAt).not.toBeNull();
    if (reviewed?.dueAt !== null && reviewed?.dueAt !== undefined) {
      expect(reviewed.dueAt).toBeGreaterThan(Date.now());
    }
    expect(teacher.nextReview()).not.toBe('friend');
    // The other two (still due) are next.
    expect(['book', 'music']).toContain(teacher.nextReview());
  });

  it('P9: correct grades stretch stability and ease difficulty; wrong grades do the reverse', () => {
    teacher.teach('apple');
    // tryState returns the LIVE state — snapshot the primitives.
    const beforeStability = teacher.tryState('apple')!.stability;
    const beforeDifficulty = teacher.tryState('apple')!.difficulty;
    expect(beforeStability).toBe(1);
    expect(beforeDifficulty).toBe(5);

    const answer = teacher.ask('apple', 'recognition');
    teacher.grade('apple', answer);
    const afterCorrect = teacher.tryState('apple');
    expect(afterCorrect!.stability).toBeGreaterThan(beforeStability);
    expect(afterCorrect!.difficulty).toBeLessThan(beforeDifficulty);
    expect(afterCorrect!.lastIntervalDays).toBeCloseTo(afterCorrect!.stability, 5);
    const afterCorrectStability = afterCorrect!.stability;
    const afterCorrectDifficulty = afterCorrect!.difficulty;

    teacher.grade('apple', { word: STARTER_DECK[0], cue: 'apple', answer: '', recall: null });
    const afterWrong = teacher.tryState('apple');
    expect(afterWrong!.stability).toBeLessThan(afterCorrectStability);
    expect(afterWrong!.difficulty).toBeGreaterThan(afterCorrectDifficulty);
  });

  it('P9: FSRS state survives export → import (stability, difficulty, dueAt)', async () => {
    teacher.teach('apple');
    const answer = teacher.ask('apple', 'recognition');
    teacher.grade('apple', answer);
    const before = teacher.tryState('apple');

    const record = teacher.exportBootstrap('test');
    session.dispose();

    const fresh = new ObserverSession({}, 100);
    await fresh.initialize();
    const freshTeacher = new TeacherAgent(fresh, STARTER_DECK);
    freshTeacher.importBootstrap(record);
    const after = freshTeacher.tryState('apple');
    expect(after?.stability).toBeCloseTo(before!.stability, 5);
    expect(after?.difficulty).toBeCloseTo(before!.difficulty, 5);
    expect(after?.dueAt).toBe(before!.dueAt);
    fresh.dispose();
  });

  it('P11: a graded-correct answer bumps the producing trace\'s utility (grade evidence)', () => {
    teacher.teach('apple');
    const state = teacher.listWords().find((w) => w.word.word === 'apple')!;
    const bank = session.observer.getMemoryBank();
    expect(bank.serializeTrace(state.traceId!)?.utilityExtra).toBeUndefined();

    const answer = teacher.ask('apple', 'recognition');
    teacher.grade('apple', answer);
    expect(bank.serializeTrace(state.traceId!)?.utilityExtra).toBe(1);
  });

  it('lists new words before they are taught and never fabricates states', () => {
    const fresh = teacher.listWords().find((w) => w.word.word === 'sleep');
    expect(fresh?.status).toBe('new');
    expect(fresh?.strength).toBeNull();
    expect(fresh?.successes).toBe(0);
    expect(fresh?.failures).toBe(0);
  });
});

describe('chaperone relations (P4): ingest, reconcile, answer, persist', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    session = new ObserverSession({}, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, STARTER_DECK);
    teacher.teach('apple');
    teacher.teach('water');
  });

  afterEach(() => {
    session.dispose();
  });

  it('applyRelations adds chaperone edges to the graph and answers from them', () => {
    const result = teacher.applyRelations([
      { subject: 'apple', predicate: 'has-property', object: 'red', source: 'def', origin: 'chaperone' },
      { subject: 'water', predicate: 'opposite-of', object: 'fire', source: 'def', origin: 'chaperone' }
    ]);
    expect(result.accepted).toBe(2);
    expect(result.conflicts).toBe(0);

    expect(teacher.relations().some((r) => r.subject === 'apple' && r.predicate === 'has-property' && r.object === 'red' && r.origin === 'chaperone')).toBe(true);

    const property = teacher.chatAnswer('is apple red');
    expect(property.mode).toBe('operator');
    if (property.mode === 'operator') expect(property.response.toLowerCase()).toContain('red');

    const opposite = teacher.chatAnswer('what is the opposite of water');
    expect(opposite.mode).toBe('operator');
    if (opposite.mode === 'operator') expect(opposite.response.toLowerCase()).toContain('fire');
  });

  it('a same-predicate disagreement becomes a belief to verify, never an override', async () => {
    // A deck whose definitions DO extract a regex edge: "apple is-a fruit".
    const conflictDeck = [
      { word: 'apple', definition: 'a round red or green fruit', example: 'I eat an apple.' },
      { word: 'fruit', definition: 'a sweet part of a plant', example: 'I like fruit.' },
      { word: 'bird', definition: 'a creature with wings', example: 'A bird can fly.' },
      { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' }
    ];
    const conflictSession = new ObserverSession({}, 100);
    await conflictSession.initialize();
    const conflictTeacher = new TeacherAgent(conflictSession, conflictDeck);
    conflictTeacher.teach('apple');
    conflictTeacher.teach('fruit');

    const regexEdge = conflictTeacher.relations().find((r) => r.subject === 'apple' && r.predicate === 'is-a');
    expect(regexEdge?.object).toBe('fruit');

    const result = conflictTeacher.applyRelations([
      { subject: 'apple', predicate: 'is-a', object: 'snack', source: 'llm', origin: 'chaperone' }
    ]);
    expect(result.accepted).toBe(0);
    expect(result.conflicts).toBe(1);

    // The regex edge survives; the LLM's conflicting object never entered the graph.
    expect(conflictTeacher.relations().some((r) => r.subject === 'apple' && r.predicate === 'is-a' && r.object === 'fruit')).toBe(true);
    expect(conflictTeacher.relations().some((r) => r.subject === 'apple' && r.predicate === 'is-a' && r.object === 'snack')).toBe(false);

    const belief = conflictTeacher.beliefsOf('apple').find((b) => b.beliefKind === 'relation-conflict');
    expect(belief).toBeDefined();
    expect(belief?.contradicts).toBe(true);
    if (belief !== undefined) expect(belief.content.toLowerCase()).toContain('check which is true');

    conflictSession.dispose();
  });

  it('chaperone relations survive export → import', () => {
    teacher.applyRelations([
      { subject: 'apple', predicate: 'has-property', object: 'red', source: 'def', origin: 'chaperone' }
    ]);
    const record = teacher.exportBootstrap('test');
    expect(record.relations).toHaveLength(1);
    session.dispose();

    const fresh = new ObserverSession({}, 100);
    const freshTeacher = new TeacherAgent(fresh, STARTER_DECK);
    freshTeacher.importBootstrap(record);
    expect(freshTeacher.relations().some((r) => r.subject === 'apple' && r.predicate === 'has-property' && r.object === 'red')).toBe(true);
    fresh.dispose();
  });
});

describe('P7 answer provenance', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    session = new ObserverSession({}, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, STARTER_DECK);
  });

  afterEach(() => {
    session.dispose();
  });

  it('memorized answers carry the producing trace id', () => {
    teacher.teachResponse({ cue: 'how are you', response: 'I am well, thank you.' });
    const answer = teacher.chatAnswer('how are you');
    expect(answer.mode).toBe('memorized');
    if (answer.mode === 'memorized') {
      expect(answer.provenance.traceIds).toHaveLength(1);
      const trace = session.observer.getMemoryBank().get(answer.provenance.traceIds[0]);
      expect(trace?.content).toBe('I am well, thank you.');
    }
  });

  it('relational operator answers cite exactly the edges they used', async () => {
    const deck = [
      { word: 'bird', definition: 'a creature with wings', example: 'A bird can fly.' },
      { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' }
    ];
    const session2 = new ObserverSession({}, 100);
    await session2.initialize();
    const teacher2 = new TeacherAgent(session2, deck);
    teacher2.teach('bird');
    teacher2.teach('robin');

    const answer = teacher2.chatAnswer('is a robin a bird');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') {
      expect(answer.provenance.edges).toEqual([{ subject: 'robin', predicate: 'is-a', object: 'bird' }]);
      expect(answer.provenance.operatorId).toBe('is-a');
      expect(answer.provenance.traceIds).toEqual([]);
    }
    session2.dispose();
  });

  it('compiled-rule answers carry the rule id in provenance', async () => {
    const addition = CHECKABLE_CONCEPTS.find((c) => c.word === 'addition') as (typeof CHECKABLE_CONCEPTS)[number];
    const deck = [addition, ...addition.dependsOn.map((word) => ({ word, definition: `the concept ${word}`, example: `About ${word}.` }))];
    const session2 = new ObserverSession({}, 100);
    await session2.initialize();
    const teacher2 = new TeacherAgent(session2, deck);
    for (const entry of deck) teacher2.teach(entry.word);
    runDrill(teacher2, addition, 0);

    // On a fresh teacher the REWRITE engine owns addition (dispatch 2.7) —
    // the answer derives through the authored deck with rule provenance,
    // instead of a DSL-compiled rule. The provenance names the rules.
    const answer = teacher2.chatAnswer('What is 17 + 25?');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') {
      expect(answer.provenance.operatorId).toBe('rewrite');
      expect(answer.provenance.ruleIds?.length).toBeGreaterThan(0);
      expect(answer.provenance.derivationSteps).toBeGreaterThan(0);
    }
    session2.dispose();
  });

  it('a wrong quiz grade weakens exactly the producing trace (surgical repair)', () => {
    teacher.teach('apple');
    const state = teacher.listWords().find((w) => w.word.word === 'apple');
    expect(state?.traceId).toBeDefined();
    const bank = session.observer.getMemoryBank();
    const before = bank.get(state!.traceId!)!.strength;
    expect(before).toBeGreaterThan(0.3);

    const wrong = teacher.grade('apple', {
      word: STARTER_DECK[0],
      cue: 'apple',
      answer: '',
      recall: null
    });
    expect(wrong.verdict).toBe('wrong');
    const after = bank.get(state!.traceId!)!.strength;
    expect(before - after).toBeCloseTo(0.1, 5);
    // The ledger recorded the producer and the verdict.
    const ledger = teacher.answerGradeLedger();
    expect(ledger.length).toBeGreaterThan(0);
    const last = ledger[ledger.length - 1];
    expect(last.verdict).toBe('wrong');
    expect(last.traceIds).toEqual([state!.traceId]);
  });

  it('the grade ledger is bounded and survives export → import', () => {
    teacher.teach('apple');
    for (let i = 0; i < 250; i += 1) {
      teacher.creativeGradeFeedback([], i % 2 === 0 ? 0.9 : 0.1, `prompt ${i}`, `answer ${i}`);
    }
    expect(teacher.answerGradeLedger().length).toBeLessThanOrEqual(200);

    const record = teacher.exportBootstrap('test');
    expect(record.answerGrades?.length).toBeLessThanOrEqual(200);
    session.dispose();

    const fresh = new ObserverSession({}, 100);
    const freshTeacher = new TeacherAgent(fresh, STARTER_DECK);
    freshTeacher.importBootstrap(record);
    expect(freshTeacher.answerGradeLedger().length).toBe(teacher.answerGradeLedger().length);
    fresh.dispose();
  });

  it('authoredAnswers survive export → import (world-feedback credit map)', async () => {
    // Unlock creative, then let a creative answer register in the credit map.
    for (const cue of ['hello', 'hi', 'how are you', 'what is up', 'good morning']) {
      teacher.teachResponse({ cue, response: `reply to ${cue}` });
      teacher.respond(cue); // drill the pair so recall competency unlocks creative
    }
    const answer = teacher.chatAnswer('tell me about apple');
    expect(answer.mode).toBe('creative');

    const record = teacher.exportBootstrap('test');
    expect(record.authoredAnswers?.length).toBeGreaterThan(0);
    session.dispose();

    const fresh = new ObserverSession({}, 100);
    const freshTeacher = new TeacherAgent(fresh, STARTER_DECK);
    freshTeacher.importBootstrap(record);
    // The credit map round-trips: re-exporting reproduces the same entries.
    const record2 = freshTeacher.exportBootstrap('test');
    expect(record2.authoredAnswers).toEqual(record.authoredAnswers ?? []);
    fresh.dispose();
  });
});

describe('P8 confidence-weighted edges and explicit negatives', () => {
  const deck = [
    { word: 'bird', definition: 'a creature with wings', example: 'A bird can fly.' },
    { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' },
    { word: 'golf', definition: 'a game played with a ball', example: 'Golf uses a club.' }
  ];

  async function teacherOnDeck(): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
    const session = new ObserverSession({}, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, deck);
    for (const entry of deck) teacher.teach(entry.word);
    return { session, teacher };
  }

  it('a negation statement teaches the confirmed-false claim and the exchange', async () => {
    const { session, teacher } = await teacherOnDeck();
    const answer = teacher.chatAnswer('golf is not a bird');
    expect(answer.mode).toBe('operator');
    expect(teacher.negationOf('golf', 'is-a', 'bird')?.origin).toBe('taught');
    expect(teacher.negationOf('golf', 'is-a', 'bird')?.evidence).toBe('golf is not a bird');
    // The exchange is memorized: repeating it replays the ack.
    const again = teacher.chatAnswer('golf is not a bird');
    expect(again.mode).toBe('memorized');
    session.dispose();
  });

  it('answers "No" with evidence ONLY when the falsehood is confirmed', async () => {
    const { session, teacher } = await teacherOnDeck();
    // Absence of evidence: no edge, no negation -> ASK (the rule is intact).
    const before = teacher.chatAnswer('is golf a bird');
    expect(before.mode === 'ask' || before.mode === 'decline').toBe(true);

    teacher.storeNegation('golf', 'is-a', 'bird', 'the user told me', 'taught');
    const after = teacher.chatAnswer('is golf a bird');
    expect(after.mode).toBe('operator');
    if (after.mode === 'operator') {
      expect(after.response).toBe('No, golf is not a bird — I was taught that.');
      expect(after.provenance.edges).toEqual([{ subject: 'golf', predicate: 'is-a', object: 'bird' }]);
    }
    session.dispose();
  });

  it('a negation contradicting a stored edge becomes a belief to verify', async () => {
    const { session, teacher } = await teacherOnDeck();
    // robin is-a bird is extracted from the definition — the negation
    // contradicts it and must surface as a relation-conflict belief.
    teacher.storeNegation('robin', 'is-a', 'bird', 'the user said so', 'taught');
    const belief = teacher.beliefsOf('robin').find((b) => b.beliefKind === 'relation-conflict');
    expect(belief).toBeDefined();
    expect(belief?.contradicts).toBe(true);
    // And the negation outranks the extraction at answer time.
    const answer = teacher.chatAnswer('is a robin a bird');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') expect(answer.response).toBe('No, robin is not a bird — I was taught that.');
    session.dispose();
  });

  it('agreement between sources bumps an edge\'s confidence', async () => {
    const { session, teacher } = await teacherOnDeck();
    expect(teacher.edgeStrengthOf('robin', 'is-a', 'bird')).toBe(1);
    // A chaperone edge that AGREES with the extracted edge is evidence.
    const applied = teacher.applyRelations([
      { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'llm', origin: 'chaperone' }
    ]);
    expect(applied.accepted).toBe(0); // agreed, not added
    expect(teacher.edgeStrengthOf('robin', 'is-a', 'bird')).toBe(2);
    session.dispose();
  });

  it('a weakened edge answers hedged, never confident "Yes"', async () => {
    const { session, teacher } = await teacherOnDeck();
    const confident = teacher.chatAnswer('is a robin a bird');
    expect(confident.mode).toBe('operator');
    if (confident.mode === 'operator') expect(confident.response).toBe('Yes, robin is a bird.');

    // Wrong grades weakened the edge: the same question now hedges.
    teacher.bumpEdge('robin', 'is-a', 'bird', -0.9);
    const hedged = teacher.chatAnswer('is a robin a bird');
    expect(hedged.mode).toBe('operator');
    if (hedged.mode === 'operator') expect(hedged.response).toBe('Probably, robin is a bird.');
    session.dispose();
  });

  it('a graded-confirmed "No" answer enters the store', async () => {
    const { session, teacher } = await teacherOnDeck();
    teacher.creativeGradeFeedback([], 0.9, 'is golf a bird', 'No, golf is not a bird.');
    const negation = teacher.negationOf('golf', 'is-a', 'bird');
    expect(negation?.origin).toBe('graded');
    expect(negation?.evidence).toBe('No, golf is not a bird.');
    session.dispose();
  });

  it('negations survive export → import', async () => {
    const { session, teacher } = await teacherOnDeck();
    teacher.storeNegation('golf', 'is-a', 'bird', 'the user told me', 'taught');
    const record = teacher.exportBootstrap('test');
    expect(record.negations).toHaveLength(1);
    session.dispose();

    const fresh = new ObserverSession({}, 100);
    await fresh.initialize();
    const freshTeacher = new TeacherAgent(fresh, deck);
    freshTeacher.importBootstrap(record);
    expect(freshTeacher.negationOf('golf', 'is-a', 'bird')).not.toBeNull();
    const answer = freshTeacher.chatAnswer('is golf a bird');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') expect(answer.response).toBe('No, golf is not a bird — I was taught that.');
    fresh.dispose();
  });
});

describe('P5 grounded generation + internal critic', () => {
  it('creative answers are grounded-first: frame sentences backed by edges', async () => {
    const deck = [
      { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
      { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' }
    ];
    const session = new ObserverSession({}, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, deck);
    for (const entry of deck) teacher.teach(entry.word);
    // Unlock creative: drill enough taught pairs to clear the competency bar.
    for (const cue of ['hello', 'hi', 'how are you', 'what is up', 'good morning']) {
      teacher.teachResponse({ cue, response: `reply to ${cue}` });
      teacher.respond(cue);
    }

    const answer = teacher.chatAnswer('tell me about robin');
    expect(answer.mode).toBe('creative');
    if (answer.mode === 'creative') {
      expect(answer.grounded).toBe(true);
      // Every cited edge exists in the graph (robin is-a bird, wings/feathers inherited).
      for (const edge of answer.provenance.edges) {
        expect(
          teacher.relations().some(
            (r) => r.subject === edge.subject && r.predicate === edge.predicate && r.object === edge.object
          )
        ).toBe(true);
      }
      expect(answer.response.toLowerCase()).toContain('robin');
    }
    session.dispose();
  }, 30000);

  it('the Markov path remains, labeled ungrounded, when no frames exist', async () => {
    const deck = [
      { word: 'apple', definition: 'a round red or green fruit', example: 'I eat an apple.' }
    ];
    const session = new ObserverSession({}, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, deck);
    teacher.teach('apple');
    for (const cue of ['hello', 'hi', 'how are you', 'what is up', 'good morning']) {
      teacher.teachResponse({ cue, response: `reply to ${cue}` });
      teacher.respond(cue);
    }
    // 'apple' is-a fruit requires 'fruit' as a deck word — absent, so no
    // frames: the answer is the labeled Markov fallback.
    const answer = teacher.chatAnswer('tell me about apple');
    expect(answer.mode).toBe('creative');
    if (answer.mode === 'creative') {
      expect(answer.grounded).toBe(false);
      expect(answer.provenance.edges).toEqual([]);
    }
    session.dispose();
  }, 30000);

  it('composition is deterministic when the session RNG is seeded', async () => {
    const makeTeacher = async () => {
      const session = new ObserverSession({}, 100);
      await session.initialize();
      const teacher = new TeacherAgent(session, [
        { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
        { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' }
      ], null, 1, 4, 42);
      for (const word of ['bird', 'robin']) teacher.teach(word);
      for (const cue of ['hello', 'hi', 'how are you', 'what is up', 'good morning']) {
        teacher.teachResponse({ cue, response: `reply to ${cue}` });
        teacher.respond(cue);
      }
      return { session, teacher };
    };
    const a = await makeTeacher();
    const b = await makeTeacher();
    const answerA = a.teacher.chatAnswer('tell me about robin');
    const answerB = b.teacher.chatAnswer('tell me about robin');
    expect(answerA.mode).toBe('creative');
    expect(answerB.mode).toBe('creative');
    if (answerA.mode === 'creative' && answerB.mode === 'creative') {
      expect(answerA.response).toBe(answerB.response);
    }
    a.session.dispose();
    b.session.dispose();
  }, 30000);
});

describe('cross-feature integration (P5-P8)', () => {
  const deck = [
    { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
    { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' },
    { word: 'golf', definition: 'a game played with a ball', example: 'Golf uses a club.' }
  ];

  async function teacherOnDeck(): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
    const session = new ObserverSession({}, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, deck);
    for (const entry of deck) teacher.teach(entry.word);
    return { session, teacher };
  }

  it('P7 provenance drives P8 edge confidence: a bad grade weakens the cited edge', async () => {
    const { session, teacher } = await teacherOnDeck();
    expect(teacher.edgeStrengthOf('robin', 'is-a', 'bird')).toBe(1);
    // A graded creative answer that CITED the edge (P5 grounded answers cite
    // edges; the grade loop weakens exactly those).
    teacher.creativeGradeFeedback(
      { traceIds: [], edges: [{ subject: 'robin', predicate: 'is-a', object: 'bird' }] },
      0.2,
      'is robin a bird',
      'probably not'
    );
    expect(teacher.edgeStrengthOf('robin', 'is-a', 'bird')).toBe(0.8);
    // ...and the weakened edge now answers hedged (P8), never confident "Yes".
    const answer = teacher.chatAnswer('is a robin a bird');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') expect(answer.response).toBe('Probably, robin is a bird.');
    session.dispose();
  });

  it('a confirmed-false claim beats the P1 graded fallback (negation precedence)', async () => {
    const { session, teacher } = await teacherOnDeck();
    // The loose hologram binds 'robin is-a bird' (from the definition) — the
    // graded fallback would hedge "I believe so". A taught negation must win.
    teacher.storeNegation('robin', 'is-a', 'bird', 'the user said so', 'taught');
    const answer = teacher.chatAnswer('is a robin a bird');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') expect(answer.response).toBe('No, robin is not a bird — I was taught that.');
    session.dispose();
  });

  it('P6 relation-hole answers pass the P5 internal critic (grounded by construction)', async () => {
    // A hole template fires only when its hole resolves from the graph; the
    // fired answer is a claim the P5 critic must accept.
    const holeDeck = [
      { word: 'bird', definition: 'a creature with wings', example: 'A bird can fly.' },
      { word: 'robin', definition: 'a small bird', example: 'I saw a robin.' },
      { word: 'sparrow', definition: 'a small bird', example: 'I saw a sparrow.' }
    ];
    const session = new ObserverSession({}, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, holeDeck);
    for (const entry of holeDeck) teacher.teach(entry.word);

    const learner = new OperatorLearner(
      new TokenCostModel(ACTIVE_DECK.map((entry) => entry.word)),
      () => teacher.relations()
    );
    learner.learn('what is a robin', 'a robin is a bird', 0.9);
    learner.learn('what is a sparrow', 'a sparrow is a bird', 0.9);
    const fired = learner.apply('what is a robin');
    expect(fired?.answer).toBe('a robin is a bird');
    if (fired !== null) {
      const verdict = criticize(fired.answer, teacher.relations(), teacher.negationsList());
      expect(verdict.grounded).toBe(true);
    }
    session.dispose();
  });
});

describe('P1 holographic fallback (graded answers where the graph is silent)', () => {
  it('P4 chaperone-supplied edges feed the distributed-vector traces (P4 → P1)', async () => {
    const deck = [
      { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
      { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' }
    ];
    const session = new ObserverSession({}, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, deck);
    teacher.teach('bird');

    // The chaperone supplies a capable-of edge the regex graph cannot see.
    const applied = teacher.applyRelations([
      { subject: 'bird', predicate: 'capable-of', object: 'fly', source: 'def', origin: 'chaperone' }
    ]);
    expect(applied.accepted).toBe(1);

    // The symbolic graph answers it confidently...
    const graph = teacher.chatAnswer('can a bird fly');
    expect(graph.mode).toBe('operator');
    if (graph.mode === 'operator') expect(graph.response).toBe('Yes, a bird can fly.');

    // ...and the P1 hologram binds the SAME edge: the loose trace recovers
    // the filler by unbind + cleanup.
    expect(teacher.relationalScore('bird', 'capable-of', 'fly')).toBeGreaterThan(0.3);
    session.dispose();
  });

  it('answers graph-silent is-a/has-part questions from the loose bindings, hedged', async () => {
    // 'creature', 'wings', and 'feathers' are NOT deck words, so the
    // precision-first graph drops those edges — but the loose extraction the
    // hologram binds keeps them, and the graded layer answers with a hedge.
    const deck = [
      { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
      { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' }
    ];
    const hologramSession = new ObserverSession({}, 100);
    await hologramSession.initialize();
    const hologramTeacher = new TeacherAgent(hologramSession, deck);
    hologramTeacher.teach('bird');
    hologramTeacher.teach('robin');

    // The graph has no is-a edge for bird (creature is not a deck word) —
    // the symbolic answer is silent, the graded layer hedges.
    expect(hologramTeacher.relations().some((r) => r.subject === 'bird' && r.predicate === 'is-a')).toBe(false);

    const isA = hologramTeacher.chatAnswer('is a bird a creature');
    expect(isA.mode).toBe('operator');
    if (isA.mode === 'operator') {
      expect(isA.operator!.kind).toBe('is-a');
      expect(isA.response).toMatch(/I believe so|Probably/);
      expect(isA.response.toLowerCase()).toContain('creature');
    }

    const hasPart = hologramTeacher.chatAnswer('does a bird have feathers');
    expect(hasPart.mode).toBe('operator');
    if (hasPart.mode === 'operator') {
      expect(hasPart.operator!.kind).toBe('has-part');
      expect(hasPart.response.toLowerCase()).toContain('feathers');
    }

    hologramSession.dispose();
  });

  it('stays silent (ASK) when neither the graph nor the bindings support the claim', async () => {
    const deck = [
      { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
      { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' }
    ];
    const hologramSession = new ObserverSession({}, 100);
    await hologramSession.initialize();
    const hologramTeacher = new TeacherAgent(hologramSession, deck);
    hologramTeacher.teach('bird');

    const answer = hologramTeacher.chatAnswer('is a bird a mountain');
    expect(answer.mode === 'ask' || answer.mode === 'decline').toBe(true);

    hologramSession.dispose();
  });
});

describe('P10 multi-predicate composition (is-a → has-part → capable-of, end to end)', () => {
  const COMPOSITION_DECK = [
    { word: 'bird', definition: 'an animal', example: 'A bird flies.' },
    { word: 'animal', definition: 'a creature with a heart', example: 'An animal lives.' },
    { word: 'heart', definition: 'a muscle in the chest', example: 'A heart beats.' }
  ];

  async function composedTeacher(
    options: { multiWordObject?: boolean } = {}
  ): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
    const session = new ObserverSession({}, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, COMPOSITION_DECK, null, 1, undefined, 7);
    for (const entry of COMPOSITION_DECK) teacher.teach(entry.word);
    teacher.applyRelations([
      {
        subject: 'heart',
        predicate: 'capable-of',
        object: options.multiWordObject === true ? 'pump blood' : 'pump',
        source: 'def',
        origin: 'chaperone'
      }
    ]);
    return { session, teacher };
  }

  it('answers a novel capability question through the chain, citing the stored hops', async () => {
    const { session, teacher } = await composedTeacher();
    const answer = teacher.chatAnswer('can a bird pump');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') {
      expect(answer.operator?.kind).toBe('composed');
      // P14: the chain's weakest hop is a single chaperone (LLM-only) edge —
      // the composed answer is hedged, not asserted flatly.
      expect(answer.response).toBe('Probably — bird is an animal, animal has heart, and heart can pump.');
      // Provenance names the STORED chain — never the derived claim.
      expect(answer.provenance.edges).toEqual([
        { subject: 'bird', predicate: 'is-a', object: 'animal' },
        { subject: 'animal', predicate: 'has-part', object: 'heart' },
        { subject: 'heart', predicate: 'capable-of', object: 'pump' }
      ]);
    }
    session.dispose();
  });

  it('a confirmed-false hop kills the chain — the observer asks instead of inferring', async () => {
    const { session, teacher } = await composedTeacher();
    teacher.storeNegation('animal', 'has-part', 'heart', 'taught', 'taught');
    const answer = teacher.chatAnswer('can a bird pump');
    // The negated hop kills the chain; no single edge backs the claim, and
    // the grounded question form never falls to creative — honest ASK.
    expect(answer.mode === 'ask' || answer.mode === 'decline').toBe(true);
    session.dispose();
  });

  it('the grounded generation path emits the composed frame and the critic backs it', async () => {
    const { session, teacher } = await composedTeacher({ multiWordObject: true });
    // Each creative draw advances the seeded composition RNG; within a fixed
    // horizon at least one draw picks the composed frame (the frame pool is
    // small and the composed claim is in it).
    let composed: CreativeReply | null = null;
    for (let i = 0; i < 20 && composed === null; i += 1) {
      const reply = teacher.creativeReply('tell me about the bird and heart');
      // P14: the composed claim rests on a single chaperone hop — the spoken
      // form is hedged ("I think a bird can pump blood."), still grounded.
      if (reply.grounded && reply.hedged && reply.sentence.includes('I think a bird can pump blood.')) composed = reply;
    }
    expect(composed).not.toBeNull();
    if (composed !== null) {
      expect(composed.sentence).toContain('I think a bird can pump blood.');
      for (const hop of [
        { subject: 'bird', predicate: 'is-a', object: 'animal' },
        { subject: 'animal', predicate: 'has-part', object: 'heart' },
        { subject: 'heart', predicate: 'capable-of', object: 'pump blood' }
      ]) {
        expect(
          composed.edges.some(
            (e) => e.subject === hop.subject && e.predicate === hop.predicate && e.object === hop.object
          )
        ).toBe(true);
      }
      // The internal critic parses the composed sentence back and accepts it.
      // P14: hedging is presentation applied AFTER verification, so the critic
      // scores the raw composition (stripHedges), never the hedge markers.
      const verdict = criticize(stripHedges(composed.sentence), teacher.relations(), teacher.negationsList());
      expect(verdict.grounded).toBe(true);
    }
    session.dispose();
  });
});
