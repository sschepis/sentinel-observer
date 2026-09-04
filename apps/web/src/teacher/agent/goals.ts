/**
 * GOALS FACULTY — the goal store + goal loop (agent split refactor).
 *
 * The observer holds its plans as content: goals are stored as ordinary
 * memory traces (kind: 'goal'), pursued by GOAL-DRIVEN SCHOOL, and their
 * per-type outcome history feeds expected-value selection. State lives on
 * TeacherAgentCore (goals/goalLoopToken/goalLoopRunning/goalHistory).
 */
import { TeacherAgentCore, type Constructor, type CrossFacultyApi } from './base';
import type { TeacherAgent } from '../TeacherAgent';
import { chooseGoal, executeGoalStep, goalId, type LearningGoal, type GoalType } from '../plan';
import { unansweredSelfQuestions, type ElaborationOptions } from '../elaboration';
import type { Relation } from '../relations';
import { sleep, type AutoLoopOptions, type AutoLoopHandle } from './support';

export function GoalsMixin<TBase extends Constructor<TeacherAgentCore & CrossFacultyApi>>(Base: TBase) {
  return class GoalsFaculty extends Base {

    /** Restored goal traces rejoin the active goal content (without firing a
     *  duplicate storage — the trace is already in the bank). */
    storeGoalIfNewInStatic(trace: unknown): void {
      const metadata = (trace as { metadata?: Record<string, unknown> }).metadata ?? {};
      const type = String(metadata.goalType ?? '') as GoalType;
      const target = String(metadata.target ?? '');
      const isGoalType = ['learn-word', 'fill-gap', 'practice', 'verify-belief'].includes(type);
      if (!isGoalType || target.length === 0) return;
      const existing = this.goals.find((g) => g.type === type && g.target === target && g.status === 'active');
      if (existing === undefined && (metadata.goalStatus ?? 'active') === 'active') {
        this.goals.push({
          id: goalId(type, target),
          type,
          target,
          completeWhen: () => false,
          describe: () => `${target} — restored goal`,
          steps: [],
          status: 'active',
          attempts: 0,
          priority: Number(metadata.priority ?? 0)
        });
      }
    }

    /** Store a goal as an ordinary memory trace (kind: 'goal') — the observer
     *  holds its plans as content, alongside its beliefs and its knowledge.
     *  Stored under the target's orientation; returns the trace id. */
    protected storeGoalTrace(goal: LearningGoal, status: 'active' | 'complete' | 'stalled'): string | null {
      this.session.settleField();
      this.session.observeText(goal.target);
      this.session.observer.tick(0.02);
      return this.session.storeMemory(
        `${goal.describe(this as unknown as TeacherAgent)} — ${status === 'complete' ? 'done' : status === 'stalled' ? 'could not finish' : 'in progress'}`,
        {
          metadata: {
            kind: 'goal',
            goalType: goal.type,
            target: goal.target,
            goalStatus: status,
            formedAt: Date.now(),
            priority: goal.priority
          }
        }
      )?.id ?? null;
    }

    /** One stored goal trace per (type, target) — the "what are you trying
     *  to do" recall source. */
    protected storeGoalIfNew(goal: LearningGoal): void {
      const bank = this.session.observer.getMemoryBank();
      const exists = bank.all().some(
        (trace) =>
          trace.metadata?.kind === 'goal' &&
          trace.metadata.goalType === goal.type &&
          trace.metadata.target === goal.target &&
          trace.metadata.goalStatus === 'active'
      );
      if (!exists) this.storeGoalTrace(goal, 'active');
    }

    /** A stalled goal stores a REVISING GOAL-BELIEF — "I planned to learn X
     *  and could not" — the intent-analog of the belief contradiction. */
    protected noteGoalFailure(goal: LearningGoal): void {
      const key = `goal-failed:${goal.id}`;
      if (this.beliefsStored.has(key)) return;
      this.session.settleField();
      this.session.observeText(goal.target);
      this.session.observer.tick(0.02);
      const trace = this.session.storeMemory(`I planned to learn ${goal.target} and could not.`, {
        metadata: { kind: 'belief', beliefKind: 'goal-failed', about: goal.id, basis: { type: goal.type }, contradicts: false }
      });
      if (trace !== null) this.beliefsStored.add(key);
    }

    /** Install the goals to pursue (replaces the current set). Each goal is
     *  stored as a memory trace — the observer holds its plans as content. */
    adoptGoals(goals: readonly LearningGoal[]): void {
      this.goals.length = 0;
      this.goals.push(...goals);
      for (const goal of goals) this.storeGoalIfNew(goal);
    }

    /** Snapshot of the current goals (deep copies — the planner mutates them). */
    goalList(): LearningGoal[] {
      return this.goals.map((g) => ({ ...g, steps: [...g.steps] }));
    }

    /**
     * §8.3 INWARD QUESTIONING — the follow-up questions the observer's own
     * elaboration of `subject` raises, routed through its own stack: the
     * ones it cannot answer become curiosity gaps through the existing
     * recordGap path (the classroom loop fed by what the observer tried to
     * say and could not). Answerable follow-ups are not gaps — grounded
     * answers extend the elaboration. Returns the gaps recorded.
     */
    recordSelfQuestionGaps(subject: string, relations: readonly Relation[], options: ElaborationOptions = {}): string[] {
      const gaps = unansweredSelfQuestions(subject, relations, options);
      for (const gap of gaps) this.recordGap(gap);
      return gaps;
    }

    /**
     * GOAL-DRIVEN SCHOOL: each cycle picks the highest-priority ACTIVE goal
     * (ordered by the learned drive weights from Phase 2) and executes one
     * step of its plan (teach / quiz / expose / ask — all existing
     * primitives). Steps are progress-evaluated; a quiescent teach REVISES
     * the plan to the exposure route. Goals that cannot progress are marked
     * stalled — the loop ends when no active goals remain.
     */
    startGoalLoop(goals: readonly LearningGoal[], options: AutoLoopOptions = {}): AutoLoopHandle {
      if (this.goalLoopRunning) {
        return { stop: () => this.stopGoalLoop(), get running() { return false; } };
      }
      this.adoptGoals(goals);
      const token = ++this.goalLoopToken;
      this.goalLoopRunning = true;
      const self = this;
      const thisGoalLoopRunning = (): boolean => self.goalLoopRunning;
      const stepPauseMs = options.teachPauseMs ?? 500;

      void (async () => {
        try {
          while (token === this.goalLoopToken) {
            // EXPECTED-VALUE SELECTION (Phase 6b): each goal's type carries the
            // observer's own success rate — ends move with the observer's life.
            for (const g of this.goals) {
              const h = this.goalHistory[g.type] ?? { completed: 0, abandoned: 0 };
              const n = h.completed + h.abandoned;
              g.successRate = n === 0 ? 0.5 : h.completed / n; // Laplace prior 0.5
            }
            const goal = chooseGoal(this.goals, this as unknown as TeacherAgent);
            if (goal === null) break; // none active — all complete or stalled
            let result;
            try {
              result = await executeGoalStep(this as unknown as TeacherAgent, goal);
            } catch (reason) {
              // A step that THREW (unknown target, internal error) must not
              // kill the loop silently: the goal is marked STALLED honestly
              // (the "stalled, never hidden" contract) and the loop continues
              // with the remaining goals.
              goal.status = 'stalled';
              this.noteGoalOutcome(goal.type, false);
              this.noteGoalFailure(goal);
              const message = reason instanceof Error ? reason.message : String(reason);
              for (const listener of [...this.autoListeners]) {
                listener({ phase: 'idle', word: goal.target, cue: null, answer: null, grade: null, message: `goal error (${message}): ${goal.target}` });
              }
              await sleep(stepPauseMs);
              continue;
            }
            if (token !== this.goalLoopToken) break;
            if (result.outcome === 'complete') {
              // A completed VERIFY-BELIEF goal is a successful verification —
              // the acquired drive's outcome feeds its learned weight.
              if (goal.type === 'verify-belief') this.noteBehaviorOutcome('verify', true);
              // The goal-type history learns: this plan worked.
              this.noteGoalOutcome(goal.type, true);
              // The goal trace is reinforced — a memory of a fulfilled intent.
              const bank = this.session.observer.getMemoryBank();
              for (const trace of bank.all()) {
                if (trace.metadata?.kind === 'goal' && trace.metadata.goalType === goal.type && trace.metadata.target === goal.target) {
                  bank.reinforce(trace.id, 0.1);
                }
              }
              for (const listener of [...this.autoListeners]) {
                listener({ phase: 'idle', word: goal.target, cue: null, answer: null, grade: null, message: `goal complete: ${goal.target}` });
              }
            } else if (result.outcome === 'failed' && goal.status === 'stalled') {
              // A stalled goal stores a revising goal-belief — the observer
              // remembers its own intention failing. And the history learns.
              this.noteGoalOutcome(goal.type, false);
              this.noteGoalFailure(goal);
            }
            await sleep(stepPauseMs);
          }
          for (const listener of [...this.autoListeners]) {
            listener({ phase: 'done', word: null, cue: null, answer: null, grade: null, message: 'all goals complete or stalled' });
          }
        } finally {
          this.goalLoopRunning = false;
        }
      })();

      return {
        stop: () => this.stopGoalLoop(),
        get running() { return thisGoalLoopRunning(); }
      };
    }

    stopGoalLoop(): void {
      this.goalLoopToken += 1;
      this.goalLoopRunning = false;
    }

    /** Goals stalling honestly — surfaced for introspection, never hidden. */
    stalledGoals(): LearningGoal[] {
      return this.goalList().filter((g) => g.status === 'stalled');
    }

    /** The goal-type outcome history (read-only). */
    goalHistorySnapshot(): Record<GoalType, { completed: number; abandoned: number }> {
      return {
        'learn-word': { ...this.goalHistory['learn-word'] },
        'fill-gap': { ...this.goalHistory['fill-gap'] },
        practice: { ...this.goalHistory.practice },
        'verify-belief': { ...this.goalHistory['verify-belief'] }
      };
    }

    protected noteGoalOutcome(type: GoalType, completed: boolean): void {
      const record = this.goalHistory[type];
      if (completed) record.completed += 1;
      else record.abandoned += 1;
    }

    /** The plan completed a goal — the observer's goal history learns. */
    noteGoalSuccess(type: GoalType): void {
      this.noteGoalOutcome(type, true);
    }

    /** A goal was abandoned — the observer's goal history learns. */
    noteGoalAbandon(type: GoalType): void {
      this.noteGoalOutcome(type, false);
    }

    /** DELIBERATION VIEW: the active goal traces, ranked by priority, with the
     *  reason computed from the observer's own goal history — the answer to
     *  "what are you trying to do" is its own evaluated plan, not a canned
     *  string. */
    activeGoalView(): Array<{ target: string; type: GoalType; priority: number; reason: string }> {
      const bank = this.session.observer.getMemoryBank();
      const active: Array<{ target: string; type: GoalType; priority: number }> = [];
      for (const trace of bank.all()) {
        if (trace.metadata?.kind !== 'goal' || trace.metadata.goalStatus !== 'active') continue;
        const type = String(trace.metadata.goalType ?? '') as GoalType;
        const target = String(trace.metadata.target ?? '');
        const priority = Number(trace.metadata.priority ?? 0);
        const isGoalType = ['learn-word', 'fill-gap', 'practice', 'verify-belief'].includes(type);
        if (isGoalType && target.length > 0) active.push({ target, type, priority });
      }
      for (const inMemory of this.goals) {
        if (inMemory.status !== 'active') continue;
        if (!active.some((g) => g.target === inMemory.target && g.type === inMemory.type)) {
          active.push({ target: inMemory.target, type: inMemory.type, priority: inMemory.priority });
        }
      }
      active.sort((a, b) => b.priority - a.priority);
      return active.map((goal) => {
        const history = this.goalHistory[goal.type] ?? { completed: 0, abandoned: 0 };
        const total = history.completed + history.abandoned;
        const successRate = total === 0 ? 0.5 : history.completed / total;
        const reason = successRate >= 0.5
          ? `${goal.type} has gone well for me (${history.completed}/${total})`
          : `I have not tried much ${goal.type} yet`;
        return { target: goal.target, type: goal.type, priority: goal.priority, reason };
      });
    }
  };
}
