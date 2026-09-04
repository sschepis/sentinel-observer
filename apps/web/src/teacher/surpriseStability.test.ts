/**
 * Phase C.1 (§4.1) — store-time surprise as the FSRS stability initializer.
 *
 * Surprise-gated storage already computes how poorly the bank predicts a new
 * stimulus, then discards it. This keeps it: the recall of the word's cue
 * BEFORE the store yields a ranked candidate list whose best-recall-score and
 * candidate-distribution entropy measure how poorly the bank already predicts
 * the stimulus. That surprise seeds the initial FSRS stability — an
 * unpredicted stimulus starts above the fixed 1-day default, a near-duplicate
 * starts below — without touching the success/failure update curves.
 *
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import {
  TeacherAgent,
  retentionProbability,
  dueIntervalDays,
  FSRS_TARGET_RETENTION,
  FSRS_INITIAL_STABILITY,
  candidateDistributionEntropy,
  storeSurprise,
  surpriseInitialStability
} from './TeacherAgent';
import { FSRS_INITIAL_DIFFICULTY, FSRS_DIFFICULTY_SCALE } from './fsrs';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';

const DECK: DeckWord[] = [
  { word: 'apple', definition: 'a round fruit', example: 'I eat an apple.' },
  { word: 'water', definition: 'the clear liquid we drink', example: 'I drink water.' },
  { word: 'friend', definition: 'a person you like', example: 'She is my friend.' },
  { word: 'house', definition: 'a building people live in', example: 'The house is big.' },
  { word: 'music', definition: 'sounds arranged in time', example: 'I like music.' },
  { word: 'book', definition: 'pages bound together', example: 'I read a book.' },
  { word: 'tree', definition: 'a tall plant with a trunk', example: 'The tree is green.' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary(DECK, PRIME_SPACE)
};

describe('store-time surprise (Phase C.1)', () => {
  it('storeSurprise is neutral for no prediction, low for a strong prediction, high for a flat weak one', () => {
    expect(storeSurprise([])).toBeCloseTo(0.5, 10); // no prediction at all — neutral
    expect(storeSurprise([0.95, 0.02, 0.01, 0.01, 0.01])).toBeLessThan(0.5); // near-duplicate
    expect(storeSurprise([0.05, 0.04, 0.03, 0.02, 0.01])).toBeGreaterThan(0.5); // unpredicted, indecisive
  });

  it('candidateDistributionEntropy is 0 for a dominant candidate and higher for a flat one', () => {
    expect(candidateDistributionEntropy([0.9, 0.01, 0.01])).toBeLessThan(0.3);
    expect(candidateDistributionEntropy([0.3, 0.3, 0.3, 0.3])).toBeGreaterThan(0.9);
    expect(candidateDistributionEntropy([0.4])).toBe(0);
  });

  it('surpriseInitialStability anchors the default at surprise 0.5 and is monotone', () => {
    expect(surpriseInitialStability(0.5)).toBeCloseTo(FSRS_INITIAL_STABILITY, 10);
    expect(surpriseInitialStability(0)).toBeLessThan(FSRS_INITIAL_STABILITY); // near-duplicate
    expect(surpriseInitialStability(1)).toBeGreaterThan(FSRS_INITIAL_STABILITY); // unpredicted
    expect(surpriseInitialStability(0.9)).toBeGreaterThan(surpriseInitialStability(0.1));
  });
});

describe('store-time surprise seeds the FSRS stability (store path)', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DECK);
  });

  afterEach(() => {
    session.dispose();
  });

  it('an unpredicted word stores at HIGHER initial stability than a near-duplicate re-store', async () => {
    // Populate the bank so a novel word's recall is a flat, low-score
    // distribution (high candidate entropy = high surprise).
    for (const w of ['apple', 'water', 'friend', 'house', 'music', 'book']) {
      teacher.teach(w);
    }

    teacher.teach('tree');
    const novel = teacher.tryState('tree')!;
    const novelStability = novel.stability;
    const novelTrace = session.observer.getMemoryBank().get(novel.traceId!)!;
    expect(novelTrace.metadata?.surprise).toBeGreaterThan(0.5);

    // A near-duplicate: rebind and re-store the same word — the bank now
    // predicts it strongly, so the surprise (and initial stability) is low.
    teacher.tryState('tree')!.traceId = null;
    teacher.teach('tree');
    const duplicate = teacher.tryState('tree')!;
    const duplicateStability = duplicate.stability;
    const duplicateTrace = session.observer.getMemoryBank().get(duplicate.traceId!)!;
    expect(duplicateTrace.metadata?.surprise).toBeLessThan(0.5);

    expect(novelStability).toBeGreaterThan(duplicateStability);
    expect(novelStability).toBeGreaterThan(FSRS_INITIAL_STABILITY);
    expect(duplicateStability).toBeLessThan(FSRS_INITIAL_STABILITY);
  });
});

describe('surprise-stability-bench (§4.6): 30-day retention vs review load', () => {
  /**
   * The FSRS schedule over a 30-day window, mirroring the success update in
   * `grade()`: at each on-time review the retrieval is at the target
   * (R_eff = 1, no overdue bonus), so the stability gain is the classic
   * e^(−D/8) and the next review is scheduled `dueIntervalDays(S)` out.
   */
  function simulateSchedule(initialStability: number, days = 30): { reviews: number; retentionAtEnd: number } {
    let stability = initialStability;
    let difficulty = FSRS_INITIAL_DIFFICULTY;
    let dueAt = 0; // a fresh word is due immediately (teach sets dueAt = now)
    let lastReviewDay = 0;
    let reviews = 0;
    for (let day = 0; day <= days; day += 1) {
      if (day < dueAt) continue;
      const gain = Math.exp(-difficulty / FSRS_DIFFICULTY_SCALE);
      stability = stability * (1 + gain);
      difficulty = Math.max(1, difficulty - 0.1);
      reviews += 1;
      lastReviewDay = day;
      dueAt = day + dueIntervalDays(stability);
    }
    return {
      reviews,
      retentionAtEnd: retentionProbability(stability, days - lastReviewDay)
    };
  }

  it('an unpredicted word keeps retention above threshold with FEWER reviews than the fixed baseline', () => {
    const baseline = simulateSchedule(FSRS_INITIAL_STABILITY);
    const surprise = simulateSchedule(surpriseInitialStability(1)); // unpredicted → doubled

    // Fewer scheduled reviews over 30 days...
    expect(surprise.reviews).toBeLessThan(baseline.reviews);
    // ...while both keep retention above the target at the end of the window,
    // and the surprise-initialized word is retained at least as well.
    expect(surprise.retentionAtEnd).toBeGreaterThanOrEqual(FSRS_TARGET_RETENTION);
    expect(baseline.retentionAtEnd).toBeGreaterThanOrEqual(FSRS_TARGET_RETENTION);
    expect(surprise.retentionAtEnd).toBeGreaterThanOrEqual(baseline.retentionAtEnd);
  });
});
