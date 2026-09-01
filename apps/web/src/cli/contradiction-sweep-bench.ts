/**
 * CONTRADICTION SWEEP BENCH — does the sweep find and resolve the graph's
 * disagreements, and what does the no-sweep baseline cost?
 *
 * Runs the full sweep over the real decks:
 *   · ACTIVE_DECK (the layered en-20000: WordNet definitions + technical
 *     curriculum + grounded facts + everyday supplements),
 *   · NEGATION_DECK taught into the teacher's confirmed-false store.
 *
 * Measures, per sweep:
 *   · conflicts found (by kind and direction), with the verification queue
 *     ordered by severity;
 *   · the world's verdicts resolving the queue (default: 'no' — the
 *     school-fact stance the negation deck represents; SWEEP_VERDICT=positive
 *     flips every verdict, exercising the retraction path);
 *   · the follow-up sweep — resolved conflicts must not re-report;
 *   · the NO-SWEEP BASELINE: the same graph with the sweep absent — every
 *     conflict stays latent (the graph asserts and denies the same claim
 *     while the observer answers from whichever side the dispatch order
 *     reaches first).
 *
 *   npm run sweep-bench            # school-fact verdicts (negative wins)
 *   SWEEP_VERDICT=positive npm run sweep-bench
 */
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import { NEGATION_DECK, teachNegationDeck } from '../teacher/decks/negations';
import { detectConflicts, type VerificationItem } from '../teacher/contradictions';
import { sweepConflicts, scheduleVerification, runVerificationRound, verificationExercise } from '../teacher/sweep';
import { verify } from '../teacher/technical/verify';

const VERDICT = (process.env.SWEEP_VERDICT ?? 'negative').toLowerCase();

interface SweepReport {
  deckWords: number;
  relations: number;
  negations: number;
  latent: number;
  found: number;
  resolved: number;
  remaining: number;
  detectMs: number;
  scheduled: number;
  adoptedGoals: number;
  queue: VerificationItem[];
}

async function runScenario(): Promise<SweepReport> {
  const session = new ObserverSession(
    { primeCount: 128, gridSize: 256, memoryMode: 'compact', memoryCapacity: 5000 },
    100
  );
  await session.initialize();
  const teacher = new TeacherAgent(session, ACTIVE_DECK);
  teachNegationDeck(teacher, NEGATION_DECK);

  const relations = teacher.relations();
  const negations = teacher.negationsList();

  // The latent disagreement count — what the no-sweep baseline silently
  // carries.
  const latent = detectConflicts(relations, negations).length;

  // SWEEP 1: detect + triage.
  const t0 = Date.now();
  const items = sweepConflicts(teacher);
  const detectMs = Date.now() - t0;
  const found = items.length;

  // Feed the planner (verify-belief goals over the conflicted subjects).
  const scheduled = scheduleVerification(teacher, items, items.length);
  const adoptedGoals = teacher.goalList().filter((g) => g.type === 'verify-belief').length;

  // The world resolves the queue. The default stance is the school-fact
  // correction ('no' — the denial wins); SWEEP_VERDICT=positive confirms
  // every claim (the retraction path).
  const results = runVerificationRound(teacher, items, () =>
    VERDICT === 'positive' ? 'yes' : 'no'
  );
  const resolved = results.filter((r) => r.resolved).length;

  // SWEEP 2: the resolved conflicts must not re-report.
  const remaining = sweepConflicts(teacher).length;

  session.dispose();
  return {
    deckWords: ACTIVE_DECK.length,
    relations: relations.length,
    negations: negations.length,
    latent,
    found,
    resolved,
    remaining,
    detectMs,
    scheduled,
    adoptedGoals,
    queue: items
  };
}

async function main(): Promise<void> {
  const report = await runScenario();

  console.log(`\ncontradiction sweep bench — ${VERDICT === 'positive' ? 'positive-wins verdicts' : 'school-fact (negative-wins) verdicts'}\n`);
  console.log(`deck: en-20000 layered (${report.deckWords} words) + negation deck (${report.negations} taught)`);
  console.log(`relation graph: ${report.relations} edges\n`);

  console.log('sweep 1 — detection and triage');
  console.log('─'.repeat(88));
  console.log(`conflicts found        ${report.found}   (${report.detectMs} ms detection)`);
  console.log(`  by direction:        ${directions(report)}`);
  console.log(`verification queue     ${report.queue.length} items, severity-ranked:`);
  for (const item of report.queue) {
    console.log(
      `  ${item.severity.toFixed(3)}  ${item.direction.padEnd(18)} ${item.question.padEnd(40)} [${item.id}]`
    );
  }
  console.log(`planner scheduled      ${report.scheduled} verify-belief goals (${report.adoptedGoals} active)`);

  console.log('─'.repeat(88));
  console.log('world feedback — the queue is drilled; the verifier marks each verdict');
  for (const item of report.queue) {
    const exercise = verificationExercise(item);
    const marked = verify(exercise, VERDICT === 'positive' ? 'yes' : 'no');
    console.log(
      `  ${marked.correct ? 'confirmed' : 'denied   '}  ${item.question}`
    );
  }

  console.log('─'.repeat(88));
  console.log('sweep 2 — the follow-up sweep');
  console.log(`conflicts resolved     ${report.resolved}`);
  console.log(`conflicts re-reported  ${report.remaining}   (a resolved conflict must never re-report)`);

  console.log('─'.repeat(88));
  console.log('no-sweep baseline');
  console.log(`conflicts found        ${report.latent > 0 ? '0' : '0'}   (the sweep never runs — the graph just sits contradictory)`);
  console.log(`conflicts resolved     0   (nothing feeds the edges or the planner)`);
  console.log(`latent disagreements   ${report.latent}   (the observer answers one side while the graph asserts the other)`);

  console.log(
    '\nEvery number here is exact: detection is deterministic and the world\'s\n' +
      'verdicts are marked by technical/verify.ts — no model in the loop.\n'
  );
}

function directions(report: SweepReport): string {
  const counts: Record<string, number> = {};
  for (const item of report.queue) counts[item.direction] = (counts[item.direction] ?? 0) + 1;
  return Object.entries(counts)
    .map(([direction, count]) => `${direction} ${count}`)
    .join(' · ');
}

void main();
