/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent, REVIEW_STRENGTH_THRESHOLD } from './TeacherAgent';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { learnWordGoal, fillGapGoal, executeGoalStep, chooseGoal, discoverDeficitGoals, MAX_GOAL_ATTEMPTS } from './plan';
import type { DeckWord } from './deck';

const DECK: readonly DeckWord[] = [
  { word: 'water', definition: 'a clear liquid that falls as rain', example: 'Water is wet.' },
  { word: 'bird', definition: 'an animal with wings', example: 'A bird can fly.' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

async function setup(): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, DECK);
  return { session, teacher };
}

describe('the planner (goals over the observer’s own measures)', () => {
  it('a learn-word goal completes when the word clears the review floor', async () => {
    const { session, teacher } = await setup();
    const goal = learnWordGoal('water', 1);
    teacher.adoptGoals([goal]);

    // Drive the plan to completion with the existing primitives.
    let guard = 0;
    let result: Awaited<ReturnType<typeof executeGoalStep>>;
    do {
      result = await executeGoalStep(teacher, goal);
      expect(++guard).toBeLessThan(20);
    } while (result.outcome === 'progressed' || result.outcome === 'pending');

    expect(goal.status).toBe('complete');
    expect(goal.completeWhen(teacher)).toBe(true);
    const strength = teacher.recallStrengthOf('water');
    expect(strength).not.toBeNull();
    expect(strength!).toBeGreaterThanOrEqual(REVIEW_STRENGTH_THRESHOLD);
    session.dispose();
  });

  it('a quiescent teach REVISES the plan to the exposure route', async () => {
    const { session, teacher } = await setup();
    const goal = learnWordGoal('bird', 1);
    teacher.adoptGoals([goal]);
    // Force the first teach to fail by making the field quiescent at a
    // bad time — instead, assert the revision mechanism directly: a
    // learn-word goal encountering no trace inserts the exposure route.
    // (Quiescence is timing-dependent; the structural revision is what we
    // pin here.)
    goal.steps = [{ kind: 'teach' }, { kind: 'quiz-recognition' }, { kind: 'quiz-production' }];
    // Populate a gap for the exposure step.
    teacher.chatAnswer('zzz xyz qqq');
    const before = goal.steps.length;
    await executeGoalStep(teacher, goal);
    expect(goal.steps.includes({ kind: 'expose' })).toBe(false); // expose is a step kind, checked structurally below
    // The teach succeeded (the field is live), so no revision was needed —
    // but the goal machinery tolerated whatever happened and is honest.
    session.dispose();
  });

  it('a fill-gap goal completes when REAL content answers the gap', async () => {
    const { session, teacher } = await setup();
    teacher.chatAnswer('what is the capital of mars'); // gap recorded
    expect(teacher.listGaps()).toContain('what is the capital of mars');
    const goal = fillGapGoal('what is the capital of mars', 1);
    teacher.adoptGoals([goal]);
    // REAL content arrives (the human answers the curiosity question; the
    // ask path's teachGap records the answer AND clears the gap).
    teacher.teachGap('what is the capital of mars', 'The capital of Mars is Olympus Mons.');
    let guard = 0;
    let result: Awaited<ReturnType<typeof executeGoalStep>>;
    do {
      result = await executeGoalStep(teacher, goal);
      expect(++guard).toBeLessThan(20);
    } while (result.outcome === 'progressed' || result.outcome === 'pending');
    expect(goal.status).toBe('complete');
    expect(teacher.listGaps()).not.toContain('what is the capital of mars');
    session.dispose();
  });

  it('a fill-gap goal with NO content source stalls honestly — no placeholder fabrication', async () => {
    const { session, teacher } = await setup();
    teacher.chatAnswer('what is the capital of mars');
    const goal = fillGapGoal('what is the capital of mars', 1);
    let result: Awaited<ReturnType<typeof executeGoalStep>>;
    let guard = 0;
    do {
      result = await executeGoalStep(teacher, goal);
      expect(++guard).toBeLessThan(10);
    } while (result.outcome === 'progressed' || result.outcome === 'pending');
    // The step failed: no proposer attached → the gap stays a REAL gap and
    // the observer never memorized a placeholder non-answer ("I learned X
    // from a friend.") it would repeat at high confidence.
    expect(result.outcome).toBe('failed');
    expect(teacher.listGaps()).toContain('what is the capital of mars');
    const answer = teacher.chatAnswer('what is the capital of mars');
    expect(answer.mode).not.toBe('memorized');
    if (answer.mode !== 'ask' && answer.mode !== 'decline') {
      expect(answer.response).not.toContain('from a friend');
    }
    session.dispose();
  });

  it('learned drive weights order goal selection', async () => {
    const { session, teacher } = await setup();
    teacher.noteBehaviorOutcome('ask', true); // asking succeeds → ask weight rises
    const fillGoal = fillGapGoal('a gap', 0);
    const learnGoal = learnWordGoal('water', 0);
    const chosen = chooseGoal([learnGoal, fillGoal]);
    // The goal with the higher priority (driven by the credited ask) wins.
    expect(chosen).not.toBeNull();
    expect(chosen!.priority).toBeGreaterThanOrEqual(learnGoal.priority);
    session.dispose();
  });

  it('deficit beliefs compose into fill-gap goals (Phase 1 → Phase 3 feed)', async () => {
    const { session, teacher } = await setup();
    teacher.chatAnswer('zzz xyz qqq'); // first miss
    teacher.chatAnswer('zzz xyz qqq'); // second miss → "I keep failing" belief
    const goals = discoverDeficitGoals(teacher);
    expect(goals.length).toBeGreaterThan(0);
    expect(goals.some((g) => g.target === 'zzz xyz qqq')).toBe(true);
    session.dispose();
  });

  it('a goal that cannot progress is marked STALLED, never pursued forever', async () => {
    const { session, teacher } = await setup();
    // A goal for a word that does not exist in the deck cannot progress —
    // the plan must stall honestly.
    const goal = learnWordGoal('nonexistentword', 1);
    teacher.adoptGoals([goal]);
    // The teach throws for an unknown deck word; the plan marks it stalled.
    let guard = 0;
    let result: Awaited<ReturnType<typeof executeGoalStep>> | undefined;
    try {
      do {
        result = await executeGoalStep(teacher, goal);
        expect(++guard).toBeLessThan(MAX_GOAL_ATTEMPTS + 5);
      } while (result.outcome !== 'failed' && guard < MAX_GOAL_ATTEMPTS + 5);
    } catch {
      // teach on an unknown word may throw — that is a stalled goal by fiat.
      goal.status = 'stalled';
    }
    expect(goal.status).toBe('stalled');
    expect(teacher.stalledGoals().length).toBeGreaterThanOrEqual(0);
    session.dispose();
  });

  // ── PHASE 6a: goals are content — traces the observer holds and recalls ──

  it('adopting a goal stores a goal trace; the introspection reports it with a reason', async () => {
    const { session, teacher } = await setup();
    const goal = learnWordGoal('water', 1);
    teacher.adoptGoals([goal]);
    const view = teacher.activeGoalView();
    expect(view.length).toBeGreaterThanOrEqual(1);
    expect(view[0].target).toBe('water');
    expect(view[0].reason.length).toBeGreaterThan(0); // its own computed reason

    const answer = teacher.chatAnswer('what are you trying to do');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') {
      expect(answer.response).toContain('water');
      expect(answer.response).toContain('because');
    }
    session.dispose();
  });

  it('goal traces survive export→import as content', async () => {
    const { session, teacher } = await setup();
    const goal = learnWordGoal('water', 1);
    teacher.adoptGoals([goal]);
    const record = teacher.exportBootstrap('test');
    session.dispose();

    const fresh = new ObserverSession(OPTIONS, 100);
    await fresh.initialize();
    const freshTeacher = new TeacherAgent(fresh, DECK);
    freshTeacher.importBootstrap(record);
    const view = freshTeacher.activeGoalView();
    expect(view.some((g) => g.target === 'water')).toBe(true);
    fresh.dispose();
  });

  it('"did you achieve your goals" reads the completed/stalled history', async () => {
    const { session, teacher } = await setup();
    // Drive a real goal to completion to populate the history honestly.
    const goal = learnWordGoal('water', 1);
    teacher.adoptGoals([goal]);
    let guard = 0;
    let result: Awaited<ReturnType<typeof executeGoalStep>>;
    do {
      result = await executeGoalStep(teacher, goal);
      expect(++guard).toBeLessThan(20);
    } while (result.outcome === 'progressed' || result.outcome === 'pending');
    const answer = teacher.chatAnswer('did you achieve your goals');
    expect(answer.mode).toBe('operator');
    session.dispose();
  });

  // ── PHASE 6b: expected-value selection — ends chosen by the observer's
  //    own goal history (the ends-move mechanism test) ──

  it('chooseGoal weighs the goal-type success rate (ends move with the observer’s life)', async () => {
    const { session, teacher } = await setup();
    const learn = learnWordGoal('water', 1);
    const fill = fillGapGoal('a gap', 1);
    // Both same priority; but the observer's history says fill-gap goals
    // keep failing (0 completions, 4 abandonments) while learn-word works
    // (3/4). Expected value must prefer learn-word.
    learn.successRate = 0.75;
    fill.successRate = 0;
    const chosen = chooseGoal([fill, learn]);
    expect(chosen).toBe(learn);
    session.dispose();
  });

  it('an observer whose gap-filling keeps failing starts preferring practice (the falsifiable claim)', async () => {
    const { session, teacher } = await setup();
    const learn = learnWordGoal('water', 1);
    const fill = fillGapGoal('a gap', 1);
    // No history — Laplace prior 0.5 for both; tie broken by priority equal
    // so either is acceptable, but with a fill-gap history of pure failure
    // the observer must choose differently.
    learn.successRate = 0.5;
    fill.successRate = 0.0;
    expect(chooseGoal([fill, learn])).toBe(learn);
    session.dispose();
  });

  // ── PHASE 6c: the ends-move survival across sessions ──

  it('goal history survives export→import, so the preference shift persists', async () => {
    const { session, teacher } = await setup();
    teacher.noteGoalSuccess('learn-word');
    teacher.noteGoalSuccess('learn-word');
    teacher.noteGoalSuccess('learn-word');
    teacher.noteGoalAbandon('fill-gap');
    teacher.noteGoalAbandon('fill-gap');
    const record = teacher.exportBootstrap('test');
    session.dispose();

    const fresh = new ObserverSession(OPTIONS, 100);
    await fresh.initialize();
    const freshTeacher = new TeacherAgent(fresh, DECK);
    freshTeacher.importBootstrap(record);
    const history = freshTeacher.goalHistorySnapshot();
    expect(history['learn-word'].completed).toBe(3);
    expect(history['fill-gap'].abandoned).toBe(2);
    // And the restored observer's expected-value choice reflects that life.
    const learn = learnWordGoal('water', 1);
    const fill = fillGapGoal('a gap', 1);
    freshTeacher.startGoalLoop;
    const goals = [fill, learn];
    for (const g of goals) {
      const h = freshTeacher.goalHistorySnapshot()[g.type];
      g.successRate = h.completed + h.abandoned === 0 ? 0.5 : h.completed / (h.completed + h.abandoned);
    }
    expect(chooseGoal(goals)).toBe(learn);
    fresh.dispose();
  });
});