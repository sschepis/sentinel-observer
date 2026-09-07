/**
 * @jest-environment node
 *
 * TASKS.md #18 — THE GOAL LOOP IN THE SERVER, AND THE BENCH: a stalled goal
 * changes the curriculum (Rule 2: a mechanism on a decision path earns a
 * bench that changes its input and watches the behavior move, against a
 * null under which it must not).
 *
 * Three levels:
 *   · the curriculum signal — a stall moves a word's score and rank;
 *   · the teacher — a goal that stalls in pursueGoalStep puts its target at
 *     the top of the lesson queue (null: the same teacher with no stall
 *     keeps its order);
 *   · the server loop — a stalled fill-gap goal is what topic research
 *     studies next, ahead of an older gap.
 * Plus the drive-tempered selection: T → T_MIN recovers the argmax.
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { CURRICULUM_WEIGHTS, goalStallSignal, scoreWord, rankCurriculum, type CurriculumItem } from './curriculum';
import { chooseGoal, fillGapGoal, goalId, type LearningGoal } from './plan';
import { TrainingLoop } from '../server/trainingLoop';
import type { ChaperoneProvider } from './chaperone';
import type { DeckWord } from './deck';

const DECK: readonly DeckWord[] = [
  { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
  { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' },
  { word: 'dog', definition: 'a common animal with four legs that people keep as a pet', example: 'The dog barks.' },
  { word: 'apple', definition: 'a round red or green fruit', example: 'I eat an apple.' },
  { word: 'water', definition: 'a clear liquid that falls as rain and is used for drinking', example: 'Water is wet.' },
  { word: 'snow', definition: 'frozen white water that falls from the sky', example: 'Snow is cold.' },
  { word: 'game', definition: 'a contest with rules that people play to win', example: 'We play a game.' },
  { word: 'rain', definition: 'water that falls from clouds', example: 'Rain is wet.' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  smfWidth: 128,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

async function taughtTeacher(): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, DECK, null, 500, 4, 7);
  for (const entry of DECK) teacher.teach(entry.word);
  return { session, teacher };
}

/** A goal in the shape a stalled plan really takes — no steps left and an
 *  unmet target (the restore path builds goals exactly like this). */
function exhaustedGoal(target: string, priority = 1): LearningGoal {
  return {
    id: goalId('learn-word', target),
    type: 'learn-word',
    target,
    completeWhen: () => false,
    describe: () => `learn "${target}" — plan exhausted`,
    steps: [],
    status: 'active',
    attempts: 0,
    priority
  };
}

const item = (word: string): CurriculumItem => ({
  word,
  traceId: `t:${word}`,
  dueAt: null,
  stability: 1,
  difficulty: 5,
  lastIntervalDays: 1,
  reviewHistory: []
});

describe('the curriculum stall signal (TASKS.md #18)', () => {
  it('reads zero with no stalls, half at one, saturates at two', () => {
    expect(goalStallSignal(undefined)).toBe(0);
    expect(goalStallSignal(0)).toBe(0);
    expect(goalStallSignal(1)).toBeCloseTo(0.5, 6);
    expect(goalStallSignal(2)).toBe(1);
    expect(goalStallSignal(5)).toBe(1);
    expect(CURRICULUM_WEIGHTS.stall).toBeGreaterThan(0);
  });

  it('moves an otherwise identical word to the top of the queue; the null (no stall) leaves the tie', () => {
    const items = [item('alpha'), item('beta'), item('gamma')];
    const ctx = { vocabulary: {}, now: Date.now() };
    const tied = rankCurriculum(items, ctx, { includeHealthy: true }).map((entry) => entry.score);
    expect(new Set(tied).size).toBe(1); // the null: nothing separates them
    const stalled = rankCurriculum(items, { ...ctx, goalStalls: { gamma: 1 } }, { includeHealthy: true });
    expect(stalled[0].word).toBe('gamma');
    expect(stalled[0].stall).toBeCloseTo(0.5, 6);
    expect(stalled[0].score).toBeGreaterThan(stalled[1].score);
    // Component check: the stall raises the score by exactly its weighted share.
    const plain = scoreWord(item('gamma'), ctx);
    const withStall = scoreWord(item('gamma'), { ...ctx, goalStalls: { gamma: 2 } });
    const total = Object.values(CURRICULUM_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(withStall.score - plain.score).toBeCloseTo(CURRICULUM_WEIGHTS.stall / total, 6);
  });
});

describe('drive-tempered goal selection', () => {
  const goals = [exhaustedGoal('low', 0.2), exhaustedGoal('high', 1.0)];
  it('the cold limit is the argmax; the hot limit explores', () => {
    let calls = 0;
    const rng = (): number => {
      calls += 1;
      return (calls * 0.6180339887) % 1; // a spread of draws across (0,1)
    };
    let coldHigh = 0;
    for (let i = 0; i < 200; i += 1) if (chooseGoal(goals, undefined, { temperature: 0.05, rng })?.target === 'high') coldHigh += 1;
    expect(coldHigh).toBe(200);
    let hotHigh = 0;
    for (let i = 0; i < 200; i += 1) if (chooseGoal(goals, undefined, { temperature: 1, rng })?.target === 'high') hotHigh += 1;
    // Expected values 0.1 vs 0.5 at T=1: P(high) = e^0 / (e^0 + e^-0.4) ≈ 0.60.
    expect(hotHigh).toBeGreaterThan(100);
    expect(hotHigh).toBeLessThan(160);
    // Without a sampler: the exact argmax, as before.
    expect(chooseGoal(goals)?.target).toBe('high');
  });
});

describe('a stalled goal changes the lesson queue (teacher level)', () => {
  it('after pursueGoalStep stalls a goal, its target ranks first; the same teacher without the stall keeps its order', async () => {
    const { session, teacher } = await taughtTeacher();
    const before = teacher.curriculumQueue({ includeHealthy: true }).map((entry) => entry.word);
    expect(before.length).toBe(DECK.length);
    const last = before[before.length - 1];
    // The null: pursuing with no goals changes nothing.
    expect(await teacher.pursueGoalStep()).toBeNull();
    expect(teacher.curriculumQueue({ includeHealthy: true }).map((entry) => entry.word)).toEqual(before);

    // The manipulation: adopt a goal about the LAST-ranked word that cannot progress.
    const added = teacher.addGoals([exhaustedGoal(last)]);
    expect(added.map((goal) => goal.target)).toEqual([last]);
    const report = await teacher.pursueGoalStep();
    expect(report?.outcome).toBe('stalled');
    expect(report?.target).toBe(last);
    expect(report?.temperature).not.toBeNull();
    expect(teacher.stalledGoals().map((goal) => goal.target)).toEqual([last]);
    expect(teacher.goalStallsSnapshot()[last]).toBe(1);

    const after = teacher.curriculumQueue({ includeHealthy: true });
    expect(after[0].word).toBe(last);
    expect(after[0].stall).toBeCloseTo(0.5, 6);
    // The stall is a revising goal-belief too: the observer remembers the intent failing.
    expect(teacher.beliefsOf(goalId('learn-word', last)).some((belief) => belief.beliefKind === 'goal-failed')).toBe(true);
    // A stalled goal is not re-adopted this session.
    expect(teacher.addGoals([exhaustedGoal(last)])).toEqual([]);
    // Nothing active remains: the next step has nothing to pursue.
    expect(await teacher.pursueGoalStep()).toBeNull();
    session.dispose();
  }, 60000);

  it('the stall survives a save/restore round trip (learning-state field goalStalls)', async () => {
    const { session, teacher } = await taughtTeacher();
    teacher.addGoals([exhaustedGoal('snow')]);
    await teacher.pursueGoalStep();
    const record = teacher.exportBootstrap('test');
    const stalls = (record.learningState as { goalStalls?: Record<string, number> }).goalStalls;
    expect(stalls).toEqual({ snow: 1 });
    session.dispose();
  }, 60000);
});

describe('a stalled fill-gap goal steers topic research (server loop)', () => {
  it('research studies the stalled gap ahead of an older gap; the goal step is counted in the stats', async () => {
    const { session, teacher } = await taughtTeacher();
    teacher.recordGap('what is a zorble');
    teacher.recordGap('what is a quimp');
    expect(teacher.listGaps()).toEqual(['what is a zorble', 'what is a quimp']);
    // The goal about the NEWER gap stalls: ask, then a teach with nothing
    // real to teach (no answer arrived) — two steps.
    teacher.addGoals([fillGapGoal('what is a quimp', 1)]);
    expect((await teacher.pursueGoalStep())?.outcome).toBe('progressed');
    expect((await teacher.pursueGoalStep())?.outcome).toBe('stalled');
    expect(teacher.stalledGoals().map((goal) => goal.target)).toEqual(['what is a quimp']);

    const topics: string[] = [];
    const provider: ChaperoneProvider = {
      name: 'stub',
      async complete() {
        throw new Error('stub: no completions');
      },
      async completeRaw(prompt: string) {
        const research = prompt.match(/^The observer is learning about "([^"]+)"/);
        if (research !== null) {
          topics.push(research[1]);
          return '{"facts": [], "definitions": [], "pairs": []}';
        }
        throw new Error('stub: no completions');
      }
    };
    const loop = new TrainingLoop(teacher, {
      settings: { endpoint: 'stub', apiKey: '', model: 'stub' },
      providerFactory: () => provider,
      cadenceMs: 0,
      wordsPerCycle: 0,
      reviewsPerCycle: 0,
      researchTopics: true
    });
    loop.start();
    const started = Date.now();
    while (topics.length < 2 && Date.now() - started < 20000) await new Promise((resolve) => setTimeout(resolve, 20));
    loop.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The older gap is gaps[0]; the stalled goal's gap is researched first anyway.
    expect(topics.length).toBeGreaterThanOrEqual(1);
    expect(topics[0]).toBe('quimp');
    const stats = loop.statistics();
    expect(stats.cycles).toBeGreaterThanOrEqual(1);
    // Nothing else stalls or completes in these cycles: the stats book the
    // goal pursuit that ran (a step is only counted when a goal was active).
    expect(stats.goalsStalled).toBe(0);
    session.dispose();
  }, 60000);
});
