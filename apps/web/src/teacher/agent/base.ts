/**
 * The shared core of the TeacherAgent (the agent split refactor).
 *
 * TeacherAgentCore holds the state the constructor injects and every faculty
 * reads: the observer session, the persistence store, the convergence
 * schedule, the deterministic PRNGs, the operator learner, and the fixed
 * curriculum facts. Fields declared here are assigned by the final
 * TeacherAgent constructor (definite-assignment `!`), never here — the base
 * deliberately has no constructor of its own.
 *
 * CrossFacultyApi is the type-level contract between faculties: methods (and
 * later fields) one mixin calls on another are declared here as the compiler
 * demands them, so no faculty ever imports another faculty at runtime and the
 * mixin composition order is free. It starts EMPTY and grows only when tsc
 * reports a missing member — at the end it is the documentation of the
 * internal coupling surface.
 */
import type { ObserverSession } from '../../observer/engine';
import type { PersistenceStore } from '../../persistence/store';
import { RECALL_SETTLE_STEPS } from './support';
import { EpisodicMemory } from '../episodic';
import { OperatorLearner } from '../operators/learning';
import { mulberry32 } from '@sschepis/sentient-core';
import type { CurriculumConfig } from '../curriculum';export type Constructor<T = object> = new (...args: unknown[]) => T;

export interface CrossFacultyApi {}

export class TeacherAgentCore {
  // ── Constructor-injected (assigned by TeacherAgent's constructor) ─────────
  protected session!: ObserverSession;
  protected persistence: PersistenceStore | null = null;
  protected persistEvery = 1;
  protected settleSteps = RECALL_SETTLE_STEPS;
  protected episodic!: EpisodicMemory;
  protected operatorLearner!: OperatorLearner;
  protected knownWords!: ReadonlySet<string>;
  protected compositionRng!: () => number;
  protected hiddenRelationKeys: ReadonlySet<string> | null = null;
  protected curriculumConfig: CurriculumConfig = {};
  protected rewriteInduction = false;

  /** Seeded stream so the arbitration PRNG is a genuine mulberry32; the
   *  composition stream is injected (session-seeded or Math.random). */
  protected readonly arbitrationRng: () => number = mulberry32(0xd21ce5);
}
