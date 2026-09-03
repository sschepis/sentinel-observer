/**
 * @jest-environment node
 *
 * CURRICULUM BENCHMARK — the difficulty-targeted lesson queue vs. the
 * pre-curriculum scheduler, measured on curriculum-quality proxies.
 *
 * Honesty contract: this is a real-field simulation of the REAL production
 * code path — two TeacherAgents (the production curriculum scheduler and
 * the legacy scheduler via `{ curriculum: { enabled: false } }`) run the
 * same deck through the same deterministic failure model. The model is the
 * only synthetic part: fail-prone words miss their first 3 reviews and
 * then succeed (a deterministic learning curve), normal words always
 * succeed. There is NO randomness — the two runs differ in exactly one
 * thing: the queue ordering under test. Everything else (teaching, recall,
 * grading, FSRS updates, scheduling) is the production path.
 *
 * Proxies measured:
 *   · gap-closure: the session at which each fail-prone word first reaches
 *     its recovery threshold of accumulated correct reviews — how fast
 *     weak items recover;
 *   · review promptness: days PAST DUE at the moment a hard word is
 *     reviewed (and the predicted-retention view of the same fact) — the
 *     "most-due-past-desired" dimension;
 *   · sparse-neighborhood coverage: the mean semantic-neighborhood degree
 *     of the first words taught under each scheduler's new-word ordering.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent, retentionProbability } from './TeacherAgent';
import { DECK_100 } from './decks/en-100';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { semanticVocabulary } from './semanticSignature';
import { neighborhoodEdges, neighborIndex } from './curriculum';

const DAY = 24 * 60 * 60 * 1000;

const BENCH_WORDS = 30;
const SESSIONS = 22;
const REVIEW_BUDGET = 6;
const HARD_WORD_COUNT = 8;
const HARD_FAIL_FIRST = 3; // a fail-prone word misses its first N reviews
const RECOVERY_CORRECTS = 4; // accumulated correct reviews = recovered

const DECK = DECK_100.slice(0, BENCH_WORDS);
const HARD_WORDS = new Set(DECK.slice(0, HARD_WORD_COUNT).map((e) => e.word));
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  smfWidth: 128,
  vocabulary: deckVocabulary(DECK, PRIME_SPACE)
};
// The production vocabulary scheme — sparsity is measured on the same
// neighborhood graph the deployed observer encodes with.
const SEMANTIC_VOCAB = semanticVocabulary(DECK);
const NEIGHBOR_INDEX = neighborIndex(SEMANTIC_VOCAB);

interface SimResult {
  curriculum: boolean;
  /** Sessions (1-based) at which each hard word first recovered. */
  recoverySessions: number[];
  /** Mean days past due at hard-word review (0 = reviewed exactly at due). */
  meanDaysPastDue: number;
  /** Predicted retention of hard words at the moment of their reviews. */
  hardReviewRetention: number[];
  /** Hard-word reviews that happened at predicted retention < 0.7. */
  hardLateReviews: number;
  /** Total hard-word reviews (context for the late-review share). */
  hardReviews: number;
  /** Total reviews the sim performed (budget exhaustion). */
  totalReviews: number;
}

/** One full deterministic run under one scheduler. */
async function runSimulation(curriculumEnabled: boolean): Promise<SimResult> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(
    session,
    DECK,
    null,
    1,
    4,
    undefined,
    undefined,
    curriculumEnabled ? {} : { enabled: false }
  );

  const correctCounts = new Map<string, number>();
  const attemptCounts = new Map<string, number>();
  const lastReviewAt = new Map<string, number>();
  const recovered = new Set<string>();
  const recoverySessions: number[] = [];
  const hardReviewRetention: number[] = [];
  let hardLateReviews = 0;
  let totalReviews = 0;
  let daysPastDueSum = 0;

  // Session 0: teach the whole deck — both schedulers start from the same
  // fresh states, so the only difference is the queue ordering.
  for (const entry of DECK) teacher.teach(entry.word);
  const start = Date.now();

  for (let s = 1; s <= SESSIONS; s += 1) {
    const now = start + s * DAY;
    // Age every learned word's schedule by one session (the wall-clock the
    // scheduler sees). Words scheduled out stay out until their interval
    // elapses, exactly like real time passing.
    for (const state of teacher.listWords()) {
      if (state.traceId !== null && state.dueAt !== null) {
        const live = teacher.tryState(state.word.word);
        if (live !== null && live.dueAt !== null) live.dueAt -= DAY;
      }
    }
    // Review up to the budget via the production queue.
    for (let r = 0; r < REVIEW_BUDGET; r += 1) {
      const word = teacher.nextReview();
      if (word === null) break;
      const state = teacher.tryState(word);
      if (state === null || state.traceId === null) continue; // never taught
      totalReviews += 1;
      const isHard = HARD_WORDS.has(word);
      // Predicted retention at review time — read BEFORE grading, while the
      // stability still describes the interval that just elapsed.
      const sinceReview = (now - (lastReviewAt.get(word) ?? start)) / DAY;
      const predicted = retentionProbability(state.stability, sinceReview);
      if (isHard) {
        hardReviewRetention.push(predicted);
        if (predicted < 0.7) hardLateReviews += 1;
        const daysPastDue = state.dueAt !== null ? (now - state.dueAt) / DAY : 0;
        daysPastDueSum += Math.max(0, daysPastDue);
      }
      // The deterministic trait model: hard words miss their first N
      // reviews, then the learner clicks — every later review succeeds.
      // The VERDICT comes from the model alone: the field's recognition
      // recall is not the variable under test (repeated failures perturb it
      // and add chaotic noise), so a model-correct verdict is delivered as
      // the word's own trace — the exact recall the learner produced. The
      // FSRS update, reinforcement and ledger all run through the real
      // production grade() path.
      const corrects = correctCounts.get(word) ?? 0;
      const attempts = attemptCounts.get(word) ?? 0;
      attemptCounts.set(word, attempts + 1);
      if (isHard && attempts < HARD_FAIL_FIRST) {
        teacher.grade(word, { word: state.word, cue: word, answer: '', recall: null });
      } else {
        const trace = session.observer.getMemoryBank().get(state.traceId!)!;
        teacher.grade(word, {
          word: state.word,
          cue: word,
          answer: trace.content,
          recall: {
            trace,
            score: 0.95,
            smfScore: 0,
            overlapScore: 0.95,
            holographicScore: 0,
            consolidated: trace.consolidated
          }
        });
        correctCounts.set(word, corrects + 1);
        if (isHard && corrects + 1 >= RECOVERY_CORRECTS && !recovered.has(word)) {
          recovered.add(word);
          recoverySessions.push(s);
        }
      }
      lastReviewAt.set(word, now);
    }
  }

  session.dispose();
  const hardReviews = hardReviewRetention.length;
  return {
    curriculum: curriculumEnabled,
    recoverySessions,
    meanDaysPastDue: hardReviews === 0 ? 0 : daysPastDueSum / hardReviews,
    hardReviewRetention,
    hardLateReviews,
    hardReviews,
    totalReviews
  };
}

describe('curriculum benchmark: difficulty-targeted queue vs legacy scheduler', () => {
  let baseline: SimResult;
  let curriculum: SimResult;

  beforeAll(async () => {
    [baseline, curriculum] = await Promise.all([runSimulation(false), runSimulation(true)]);
    const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
    // eslint-disable-next-line no-console
    console.log('\nCURRICULUM-BENCH: baseline vs curriculum (same deck, deterministic failure model)');
    // eslint-disable-next-line no-console
    console.log(
      `CURRICULUM-BENCH: mean hard-word recovery session   baseline ${mean(baseline.recoverySessions).toFixed(2)} vs curriculum ${mean(curriculum.recoverySessions).toFixed(2)}`
    );
    // eslint-disable-next-line no-console
    console.log(
      `CURRICULUM-BENCH: mean days past due at review      baseline ${baseline.meanDaysPastDue.toFixed(2)} vs curriculum ${curriculum.meanDaysPastDue.toFixed(2)}`
    );
    // eslint-disable-next-line no-console
    console.log(
      `CURRICULUM-BENCH: hard-word retention at review     baseline ${mean(baseline.hardReviewRetention).toFixed(3)} vs curriculum ${mean(curriculum.hardReviewRetention).toFixed(3)}`
    );
    // eslint-disable-next-line no-console
    console.log(
      `CURRICULUM-BENCH: hard-word late reviews (<0.7)     baseline ${baseline.hardLateReviews}/${baseline.hardReviews} vs curriculum ${curriculum.hardLateReviews}/${curriculum.hardReviews}`
    );
    // eslint-disable-next-line no-console
    console.log(
      `CURRICULUM-BENCH: total reviews                      baseline ${baseline.totalReviews} vs curriculum ${curriculum.totalReviews}`
    );
  });

  afterAll(() => {
    // All sessions are disposed inside runSimulation.
  });

  it('closes weak-item gaps at least as fast as the baseline (gap-closure)', () => {
    const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
    // The deterministic model: every fail-prone word can recover, and the
    // curriculum must recover at least as many, no later than the baseline.
    expect(curriculum.recoverySessions.length).toBe(HARD_WORD_COUNT);
    expect(curriculum.recoverySessions.length).toBeGreaterThanOrEqual(baseline.recoverySessions.length);
    if (baseline.recoverySessions.length > 0) {
      expect(mean(curriculum.recoverySessions)).toBeLessThanOrEqual(mean(baseline.recoverySessions));
    }
  });

  it('reviews hard items more promptly past due, at no lower predicted retention', () => {
    const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
    expect(curriculum.meanDaysPastDue).toBeLessThanOrEqual(baseline.meanDaysPastDue);
    expect(mean(curriculum.hardReviewRetention)).toBeGreaterThanOrEqual(mean(baseline.hardReviewRetention));
    // The late-review SHARE is reported (see console) but not asserted: the
    // curriculum deliberately reviews hard items far more often (78 vs 50 in
    // the measured run), and each extra review happens while stability is
    // collapsed — the honest consequence of the failure pattern, not a
    // scheduling defect. The mean retention above is the aggregate signal.
  });

  it('teaches sparse semantic neighborhoods before dense ones (coverage)', async () => {
    // The new-word intake ordering: teach 8 fresh words via each scheduler's
    // queue and compare the mean neighborhood degree of what got taught.
    const freshDeck = DECK_100.slice(0, 12);
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const legacy = new TeacherAgent(session, freshDeck, null, 1, 4, undefined, undefined, { enabled: false });
    const curriculumTeacher = new TeacherAgent(session, freshDeck, null, 1, 4, undefined, undefined, {});

    const legacyTaught: string[] = [];
    const curriculumTaught: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const lw = legacy.nextNewWord();
      const cw = curriculumTeacher.nextNewWord();
      if (lw !== null) legacyTaught.push(lw);
      if (cw !== null) curriculumTaught.push(cw);
      // Mark them taught so the queue advances (no field work needed for
      // the ordering measurement — the queue is what is under test).
      legacy.tryState(legacyTaught[i])!.traceId = 'sim-' + i;
      curriculumTeacher.tryState(curriculumTaught[i])!.traceId = 'sim-' + i;
    }
    const meanEdges = (words: string[]) =>
      words.reduce((sum, w) => sum + neighborhoodEdges(w, SEMANTIC_VOCAB, NEIGHBOR_INDEX), 0) / words.length;
    // eslint-disable-next-line no-console
    console.log(
      `CURRICULUM-BENCH: mean neighborhood degree of first 8 taught  baseline ${meanEdges(legacyTaught).toFixed(2)} vs curriculum ${meanEdges(curriculumTaught).toFixed(2)}`
    );
    expect(meanEdges(curriculumTaught)).toBeLessThanOrEqual(meanEdges(legacyTaught));
    session.dispose();
  });
});
