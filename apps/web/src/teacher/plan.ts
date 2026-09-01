/**
 * THE PLANNER — goals as named target states over the observer's own
 * measures.
 *
 * The auto-loop is currently a static script: decayed first, then new,
 * recognition until success, production after. A PLAN closes the loop over
 * its own state: a goal names an OBSERVABLE target ("strength of X ≥ the
 * review floor"), is decomposed into the existing learning primitives
 * (teach / quiz / expose / ask), its progress is evaluated after every step,
 * and a failed step REVISES the plan (a quiescent teach switches to the
 * exposure route) instead of re-triggering the same action.
 *
 * Goal selection is the learned evaluative gradient made concrete: goals are
 * ordered by the drive weights experience has already shaped (Phase 2), and
 * deficit beliefs (Phase 1) become candidate goals — "I keep failing X"
 * composes into a fill-gap plan.
 *
 * Honesty contract preserved: a goal that cannot progress is marked STALLED
 * and surfaced by introspection — never pursued forever, never hidden.
 */
import { TeacherAgent, REVIEW_STRENGTH_THRESHOLD } from './TeacherAgent';
import { hasDefinition } from './deck';
import type { BehaviorOption } from './drives';
import { scoreWord } from './curriculum';

export type GoalType = 'learn-word' | 'fill-gap' | 'practice' | 'verify-belief';

export type GoalStatus = 'active' | 'complete' | 'stalled';

export interface LearningGoal {
  id: string;
  type: GoalType;
  /** The subject the goal is about (word, gap utterance, or cue). */
  target: string;
  /** The observable completion predicate — a function over teacher state. */
  completeWhen(teacher: TeacherAgent): boolean;
  /** Progress narrative for introspection ("strength 0.3 → target 0.6"). */
  describe(teacher: TeacherAgent): string;
  /** Steps remaining in the current plan (popped as they run). */
  steps: PlannedStep[];
  status: GoalStatus;
  /** Attempts exhausted — the plan stops honestly instead of spinning. */
  attempts: number;
  /** How much the goal matters to the observer (learned-value weight). */
  priority: number;
  /** The observer's observed success rate for this goal type (0..1 — the
   *  planner's expected-value multiplier). */
  successRate?: number;
}

/** One atomic step of a plan — always an EXISTING observer primitive. */
export type PlannedStep =
  | { kind: 'teach' }
  | { kind: 'quiz-recognition' }
  | { kind: 'quiz-production' }
  | { kind: 'expose' }
  | { kind: 'ask' };

/** A step failed, and the plan may revise. */
export type StepResult =
  | { outcome: 'pending' | 'progressed' | 'failed' }
  | { outcome: 'complete' };

export const MAX_GOAL_ATTEMPTS = 5;
export const MAX_STALLED_STEPS = 3;

export function goalId(type: GoalType, target: string): string {
  return `${type}:${target}`;
}

// ── Completion predicates (closures over the target) ──────────────────────

/** A word is learned once its trace strength clears the review floor. */
export function wordLearnedComplete(target: string): (teacher: TeacherAgent) => boolean {
  return (teacher) => {
    const strength = teacher.recallStrengthOf(target);
    return strength !== null && strength >= REVIEW_STRENGTH_THRESHOLD;
  };
}

/** A gap is filled when its utterance is no longer an unanswered gap. */
export function gapFilledComplete(target: string): (teacher: TeacherAgent) => boolean {
  return (teacher) => !teacher.listGaps().includes(target);
}

/** A phrase is practiced when it recalls above the floor. */
export function phrasePracticedComplete(target: string): (teacher: TeacherAgent) => boolean {
  return (teacher) => teacher.phraseStrength(target) >= REVIEW_STRENGTH_THRESHOLD;
}

/** A belief-verification goal is complete when a contradiction is stored. */
export function beliefVerifiedComplete(target: string): (teacher: TeacherAgent) => boolean {
  return (teacher) => teacher.beliefsOf(target).some((belief) => belief.contradicts);
}

// ── Plan construction: decompose a goal into existing primitives ───────────

export function planStepsFor(type: GoalType): PlannedStep[] {
  switch (type) {
    case 'learn-word':
      return [{ kind: 'teach' }, { kind: 'quiz-recognition' }, { kind: 'quiz-production' }];
    case 'fill-gap':
      return [{ kind: 'ask' }, { kind: 'teach' }];
    case 'practice':
      return [{ kind: 'quiz-recognition' }, { kind: 'quiz-production' }];
    case 'verify-belief':
      return [{ kind: 'quiz-recognition' }, { kind: 'quiz-production' }];
  }
}

// ── Goal construction ──────────────────────────────────────────────────────

/** A learn-word goal for a deck word. */
export function learnWordGoal(target: string, priority: number): LearningGoal {
  return {
    id: goalId('learn-word', target),
    type: 'learn-word',
    target,
    completeWhen: wordLearnedComplete(target),
    describe: (teacher) => {
      const strength = teacher.recallStrengthOf(target) ?? 0;
      return `learn "${target}" — recall strength ${strength.toFixed(2)} of the ${REVIEW_STRENGTH_THRESHOLD.toFixed(2)} floor`;
    },
    steps: planStepsFor('learn-word'),
    status: 'active',
    attempts: 0,
    priority
  };
}

/** A fill-gap goal for an unanswered utterance. */
export function fillGapGoal(target: string, priority: number): LearningGoal {
  return {
    id: goalId('fill-gap', target),
    type: 'fill-gap',
    target,
    completeWhen: gapFilledComplete(target),
    describe: (teacher) => `fill the gap "${target}" — ${teacher.listGaps().includes(target) ? 'still unanswered' : 'answered'}`,
    steps: planStepsFor('fill-gap'),
    status: 'active',
    attempts: 0,
    priority
  };
}

/** A practice goal for a conversation phrase. */
export function practiceGoal(target: string, priority: number): LearningGoal {
  return {
    id: goalId('practice', target),
    type: 'practice',
    target,
    completeWhen: phrasePracticedComplete(target),
    describe: (teacher) => `keep "${target}" — recall ${(teacher.phraseStrength(target)).toFixed(2)} of the ${REVIEW_STRENGTH_THRESHOLD.toFixed(2)} floor`,
    steps: planStepsFor('practice'),
    status: 'active',
    attempts: 0,
    priority
  };
}

/** A verify-belief goal: force experience to test a stored belief. */
export function verifyBeliefGoal(target: string, priority: number): LearningGoal {
  return {
    id: goalId('verify-belief', target),
    type: 'verify-belief',
    target,
    completeWhen: beliefVerifiedComplete(target),
    describe: (teacher) => `test what I think I know about "${target}" — ${teacher.beliefsOf(target).some((b) => b.contradicts) ? 'contradicted, resolved' : 'still unverified'}`,
    steps: planStepsFor('verify-belief'),
    status: 'active',
    attempts: 0,
    priority
  };
}

/** Goals derived from the observer's own deficits: stored fail-beliefs. */
export function discoverDeficitGoals(teacher: TeacherAgent): LearningGoal[] {
  const askWeight = teacher.driveWeights().ask ?? 0;
  return teacher.deficitBeliefs().map((belief) => fillGapGoal(belief.about, 1 + askWeight));
}

// ── Execution ──────────────────────────────────────────────────────────────

/**
 * Run one step of a goal's plan. Progress is evaluated after every step;
 * a failed teach (quiescent trace) REVISES the plan to the exposure route —
 * the first genuine plan-revision-on-failure rather than re-triggering.
 */
export async function executeGoalStep(
  teacher: TeacherAgent,
  goal: LearningGoal,
  progressionRate = 0.5
): Promise<StepResult> {
  const step = goal.steps[0];
  if (step === undefined) {
    goal.status = goal.completeWhen(teacher) ? 'complete' : 'stalled';
    if (goal.status === 'complete') teacher.noteGoalSuccess(goal.type);
    else teacher.noteGoalAbandon(goal.type);
    return { outcome: goal.status === 'complete' ? 'complete' : 'failed' };
  }
  goal.steps.shift();

  let progressed = false;
  let failed = false;
  switch (step.kind) {
    case 'teach':
      if (goal.type === 'fill-gap') {
        // The ASK step surfaced the gap; the TEACH step fills it with REAL
        // content only. No proposer is attached to this step — the LLM or
        // the human answers through teachResponse in live use — so teaching
        // a placeholder ("I learned X from a friend.") would memorize a
        // content-free non-answer the observer later repeats at high
        // confidence: a fabrication. With the gap still unanswered the step
        // fails honestly and the goal stalls (the gap stays a gap).
        if (teacher.listGaps().includes(goal.target)) {
          failed = true;
        } else {
          progressed = true; // real content already answered it
        }
      } else {
        const result = teacher.teach(goal.target);
        progressed = result.traceId !== null;
        if (!progressed) {
          // REVISION: a quiescent teach means the word could not be bound to
          // a stable orientation. Switch to the exposure route — GET the
          // word heard, then teach again. This is a plan change, not a retry.
          goal.steps.unshift({ kind: 'expose' }, { kind: 'quiz-recognition' }, { kind: 'teach' });
          progressed = false;
        }
      }
      break;
    case 'quiz-recognition': {
      const state = teacher.tryState(goal.target);
      if (state === null || state.traceId === null) {
        // Cannot quiz an untaught word — the plan needs teaching first.
        goal.steps.unshift({ kind: 'teach' });
        progressed = false;
        break;
      }
      const question = teacher.ask(goal.target, 'recognition');
      const result = teacher.grade(goal.target, question);
      progressed = result.verdict === 'correct';
      break;
    }
    case 'quiz-production': {
      const state = teacher.tryState(goal.target);
      if (state === null || !hasDefinition(state.word)) {
        // Production requires a meaning; word-only words practice by
        // recognition until the Chaperone fills them.
        progressed = false;
        break;
      }
      const question = teacher.ask(goal.target, 'production');
      const result = teacher.grade(goal.target, question);
      progressed = result.verdict === 'correct';
      break;
    }
    case 'expose':
      // HEAR the word: record it as a gap so the curiosity engine notices
      // it, then the plan teaches it next.
      teacher.recordGap(goal.target);
      progressed = true;
      break;
    case 'ask':
      // Surface the question the observer would ask — the request to learn.
      teacher.curiosityQuestion();
      progressed = true;
      break;
  }

  if (failed) {
    goal.attempts += 1;
    if (goal.attempts >= MAX_GOAL_ATTEMPTS) {
      goal.status = 'stalled';
      return { outcome: 'failed' };
    }
  }

  if (progressed) {
    if (goal.completeWhen(teacher)) {
      goal.status = 'complete';
      teacher.noteGoalSuccess(goal.type);
      return { outcome: 'complete' };
    }
    if (goal.attempts < MAX_STALLED_STEPS) {
      goal.priority += progressionRate; // success compounds what works
    }
    return { outcome: 'progressed' };
  }

  if (goal.completeWhen(teacher)) {
    goal.status = 'complete';
    teacher.noteGoalSuccess(goal.type);
    return { outcome: 'complete' };
  }
  if (goal.steps.length === 0) {
    goal.status = 'stalled';
    teacher.noteGoalAbandon(goal.type);
    return { outcome: 'failed' };
  }
  return { outcome: 'pending' };
}

// ── Goal selection: ordered by the learned evaluative gradient ─────────────

/** The learned-value weight of a goal type, from the drive history. */
export function goalPriorityBase(teacher: TeacherAgent, type: GoalType): number {
  const weights = teacher.driveWeights();
  switch (type) {
    case 'learn-word':
      return weights.answer ?? 0.5;
    case 'fill-gap':
      return weights.ask ?? 0;
    case 'practice':
      return weights.practice ?? 0.2;
    case 'verify-belief':
      return weights.answer ?? 0.5;
  }
}

/** How much of the curriculum score multiplies a goal's expected value.
 *  Bounded: the drive history stays the dominant term — the curriculum
 *  tilts the queue, it does not own it. */
export const GOAL_CURRICULUM_BOOST = 0.5;

/** The P-curriculum score of a goal's target (0..1): hard FSRS items,
 *  sparse semantic neighborhoods, repeated gaps and weak drills pull their
 *  goals up the queue. Targets outside the deck (gap utterances, cues)
 *  score 0 — there is no evidence about them, and the curriculum never
 *  invents it. */
export function curriculumPriority(teacher: TeacherAgent, target: string): number {
  const state = teacher.tryState(target);
  if (state === null) return 0;
  return scoreWord(
    {
      word: state.word.word,
      traceId: state.traceId,
      dueAt: state.dueAt,
      stability: state.stability,
      difficulty: state.difficulty,
      lastIntervalDays: state.lastIntervalDays,
      reviewHistory: state.reviewHistory
    },
    {
      vocabulary: teacher.curriculumVocabulary(),
      drillFailures: teacher.drillFailuresSnapshot(),
      weights: teacher.curriculumContext().weights
    }
  ).score;
}

/** Pick the highest-priority active, non-stalled goal. Priority is the
 *  EXPECTED VALUE of the goal, computed from the observer's own goal
 *  history: a goal type that has reliably completed in the observer's life
 *  is worth more than one that keeps failing — the observer's ends move
 *  with its experience. Laplace smoothing keeps untried types viable. The
 *  optional teacher adds the curriculum tilt: goals whose target is
 *  currently hard/overdue/isolated/weak get up to a 1.5× expected-value
 *  multiplier, so the lesson queue follows the difficulty-targeted score.
 */
export function chooseGoal(goals: readonly LearningGoal[], teacher?: TeacherAgent): LearningGoal | null {
  let best: LearningGoal | null = null;
  let bestExpected = 0;
  for (const goal of goals) {
    if (goal.status !== 'active') continue;
    // goal.priority is the base importance (learned drive weight from
    // Phase 2); the success-rate multiplier is the observer's own history.
    // The history lives on the teacher; goals carry a mutable hook the
    // planner sets when the loop runs (setSuccessRate).
    let expected = goal.priority * (goal.successRate ?? 0.5);
    if (teacher !== undefined) {
      expected *= 1 + GOAL_CURRICULUM_BOOST * curriculumPriority(teacher, goal.target);
    }
    if (best === null || expected > bestExpected) {
      best = goal;
      bestExpected = expected;
    }
  }
  return best;
}