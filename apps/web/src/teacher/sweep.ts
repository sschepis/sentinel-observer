/**
 * SWEEP INTEGRATION — the contradiction sweep wired to the teacher.
 *
 * The pure detection lives in contradictions.ts; this layer runs it over a
 * live TeacherAgent and closes the loop:
 *
 *   · sweepConflicts       — run the sweep over the teacher's graph and the
 *                            confirmed-false store, minus the one-shot
 *                            resolution ledger;
 *   · scheduleVerification — feed the queue into the planner (plan.ts):
 *                            each item becomes a contradiction belief (the
 *                            verify-belief goal's completion predicate reads
 *                            it) and a verify-belief goal ranked by severity;
 *   · runVerificationRound — the drill pass: each item is an Exercise in the
 *                            exact shape technical/verify.ts grades, the
 *                            observer answers its probe from its own graph,
 *                            and the WORLD's yes/no is marked by the same
 *                            deterministic verifier;
 *   · applyResolution      — the world's verdict edits the edges (reinforce
 *                            the winner, retract the losing denial, weaken
 *                            the losing positive below the sweep floor) and
 *                            the corroboration bookkeeping (grade ledger +
 *                            the one-shot resolution ledger) so the next
 *                            sweep does not re-report the disagreement.
 *
 * Resolution semantics (the no-ping-pong contract):
 *   · positive wins  — the losing negation is RETRACTED (the confirmed-false
 *                      store is evidence, and the world just overruled it);
 *                      the winning positive gains +0.2 corroboration.
 *   · negative wins  — the losing positive edge is weakened by −0.7, below
 *                      the sweep's support floor, so it stops asserting; the
 *                      negation stays as the evidence-backed denial.
 *   Either way the conflict id enters the ONE-SHOT ledger: the same evidence
 *   pair is never re-reported, even when a multi-source edge cannot fall
 *   below the floor in one step.
 */
import { TeacherAgent } from './TeacherAgent';
import {
  detectConflicts,
  resolutionFor,
  triageConflicts,
  type ResolutionVerdict,
  type VerificationItem
} from './contradictions';
import { verify, type Exercise } from './technical/verify';
import { verifyBeliefGoal, type LearningGoal } from './plan';
import { predicateVerb, type RelationPredicate } from './relations';

/** A positive-wins resolution corroborates the winning edge by this delta. */
export const SWEEP_REINFORCE_DELTA = 0.2;
/** A negative-wins resolution weakens the losing edge by this delta — below
 *  the sweep's support floor for a single-source edge (1.0 → 0.3). */
export const SWEEP_WEAKEN_DELTA = 0.7;
/** How many items one scheduling pass feeds the planner. */
export const SWEEP_QUEUE_LIMIT = 8;

/**
 * Run the sweep over the teacher's current graph: relations() (the merged
 * regex + authored + chaperone edges with the P8 confidence overlay) and the
 * confirmed-false store. The one-shot ledger suppresses conflicts the world
 * has already resolved.
 */
export function sweepConflicts(teacher: TeacherAgent): VerificationItem[] {
  const detected = detectConflicts(teacher.relations(), teacher.negationsList());
  const resolved = teacher.sweepResolutionLedger();
  return triageConflicts(detected.filter((conflict) => !resolved.has(conflict.id)));
}

/** A verification item as a targeted drill exercise — the exact Exercise
 *  shape the deterministic marker (technical/verify.ts) grades. The
 *  canonical answer is the positive side: verify() marks whether the world's
 *  answer affirmed it. */
export function verificationExercise(item: VerificationItem): Exercise {
  return {
    concept: item.subject,
    drill: 'verification',
    prompt: item.question,
    answer: 'yes',
    kind: 'text'
  };
}

/**
 * The world's yes/no on a probe, marked by the deterministic verifier: a
 * response carrying the word "yes" affirms the positive side; a response
 * that starts with "no" denies it; anything else (an evasion, a hedge) is
 * no verdict — the item stays unresolved.
 */
export function worldVerdictFor(item: VerificationItem, response: string): ResolutionVerdict | null {
  const text = response.trim().toLowerCase();
  if (verify(verificationExercise(item), text).correct) return 'positive';
  if (/^\s*no\b/.test(text)) return 'negative';
  return null;
}

/**
 * Schedule the queue into the teacher's planning (plan.ts): each item
 * becomes a contradiction belief — the same P4 relation-conflict belief the
 * applyRelations and storeNegation paths store, and the verify-belief goal's
 * completion predicate reads — plus a verify-belief goal at
 * severity-ranked priority. Idempotent per subject: a subject already
 * carrying a verify-belief goal is not scheduled twice.
 */
export function scheduleVerification(
  teacher: TeacherAgent,
  items: readonly VerificationItem[],
  limit = SWEEP_QUEUE_LIMIT
): number {
  const existing = teacher.goalList();
  // One goal per SUBJECT — several items may share a subject (direct and
  // inherited views of the same claim); the planner quizzes the subject.
  const scheduledTargets = new Set(
    existing.filter((goal) => goal.type === 'verify-belief').map((goal) => goal.target)
  );
  const goals: LearningGoal[] = [];
  let scheduled = 0;
  for (const item of items.slice(0, limit)) {
    if (scheduledTargets.has(item.subject)) continue;
    const content =
      `I was taught that ${item.subject} ${predicateVerb(item.predicate as RelationPredicate, item.object)} ${item.object}, ` +
      `but I was also told it does not — I should check which is true.`;
    teacher.noteConflictBelief(item.subject, content, {
      predicate: item.predicate,
      object: item.object,
      negative: item.negative.evidence,
      sweepConflict: item.id
    });
    goals.push(verifyBeliefGoal(item.subject, 1 + item.severity));
    scheduledTargets.add(item.subject);
    scheduled += 1;
  }
  if (goals.length > 0) teacher.adoptGoals([...existing, ...goals]);
  return scheduled;
}

/**
 * Apply the world's verdict to the teacher: edit the contested edges per
 * resolutionFor, record the resolution in the grade ledger (P7 corroboration
 * bookkeeping — the resolution is a graded answer whose producer is exactly
 * the contested edge), and mark the conflict one-shot resolved so the sweep
 * does not re-report it.
 */
export function applyResolution(
  teacher: TeacherAgent,
  item: VerificationItem,
  verdict: ResolutionVerdict
): void {
  const effect = resolutionFor(item, verdict);
  if (effect.reinforce !== undefined) {
    teacher.bumpEdge(effect.reinforce.holder, effect.reinforce.predicate as RelationPredicate, effect.reinforce.object, SWEEP_REINFORCE_DELTA);
  }
  if (effect.retractNegation !== undefined) {
    teacher.retractNegation(effect.retractNegation.holder, effect.retractNegation.predicate as RelationPredicate, effect.retractNegation.object);
  }
  if (effect.weaken !== undefined) {
    teacher.bumpEdge(effect.weaken.holder, effect.weaken.predicate as RelationPredicate, effect.weaken.object, -SWEEP_WEAKEN_DELTA);
  }
  teacher.recordAnswerGrade(item.question, 'verification', verdict === 'positive' ? 'strong' : 'weak', {
    traceIds: [],
    edges: [{ subject: item.subject, predicate: item.predicate as RelationPredicate, object: item.object }]
  });
  teacher.markSweepConflictResolved(item.id);
}

export interface VerificationRoundResult {
  item: VerificationItem;
  /** The observer's own answer to the probe (its current belief stance). */
  observerResponse: string;
  /** The world's verdict (null when it did not answer yes/no). */
  worldVerdict: ResolutionVerdict | null;
  /** True when the world gave a verdict and the edges were updated. */
  resolved: boolean;
}

/**
 * Run one verification round over the queue — the drill pass. The observer
 * answers each probe from its own graph (chatAnswer), the world answers
 * through the supplied callback (the user in live use; a stub in tests and
 * benches), and each verdict is applied. Unresolved items (an evasive world
 * answer) stay in the queue for the next round.
 */
export function runVerificationRound(
  teacher: TeacherAgent,
  items: readonly VerificationItem[],
  worldAnswer: (item: VerificationItem) => string
): VerificationRoundResult[] {
  const results: VerificationRoundResult[] = [];
  for (const item of items) {
    const answer = teacher.chatAnswer(item.question);
    const observerResponse = answer.mode === 'decline' ? '' : answer.response;
    const verdict = worldVerdictFor(item, worldAnswer(item));
    if (verdict !== null) {
      applyResolution(teacher, item, verdict);
    }
    results.push({ item, observerResponse, worldVerdict: verdict, resolved: verdict !== null });
  }
  return results;
}
