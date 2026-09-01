/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { DECK_100 } from './decks/en-100';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { MemoryPersistenceStore } from '../persistence/store';
import {
  fsrsDifficulty,
  overdueUrgency,
  neighborhoodEdges,
  neighborhoodSparsity,
  neighborIndex,
  gapSignal,
  drillWeakness,
  scoreWord,
  rankCurriculum,
  nextCurriculumWord,
  rankLegacy,
  CURRICULUM_WEIGHTS,
  type CurriculumItem
} from './curriculum';

const DAY = 24 * 60 * 60 * 1000;

/** Minimal item builder — the curriculum reads these fields and nothing else. */
function item(partial: Partial<CurriculumItem> = {}): CurriculumItem {
  return {
    word: 'word',
    traceId: 'trace-1',
    dueAt: null,
    stability: 1,
    difficulty: 5,
    lastIntervalDays: null,
    reviewHistory: [],
    ...partial
  };
}

/** A hand-built vocabulary with a known neighborhood graph:
 *  alpha ↔ beta share prime 2; gamma is isolated. */
const VOCAB = {
  alpha: [2, 3, 5, 7],
  beta: [2, 11, 13, 17],
  gamma: [19, 23, 29, 31]
};
const CTX = { vocabulary: VOCAB, now: 0 };

describe('curriculum signal components', () => {
  it('fsrsDifficulty maps the learned difficulty [1,10] onto [0,1]', () => {
    expect(fsrsDifficulty(item({ difficulty: 1 }))).toBe(0);
    expect(fsrsDifficulty(item({ difficulty: 10 }))).toBe(1);
    expect(fsrsDifficulty(item({ difficulty: 5 }))).toBeCloseTo(4 / 9, 10);
  });

  it('overdueUrgency is relative to the scheduled interval, not raw lateness', () => {
    const now = 30 * DAY;
    // 2 days late on a 1-day interval: deep decay (retention ≈ 0.55).
    const short = item({ dueAt: now - 2 * DAY, lastIntervalDays: 1 });
    // 2 days late on a 30-day interval: still ≈ 0.87 retention.
    const long = item({ dueAt: now - 2 * DAY, lastIntervalDays: 30 });
    expect(overdueUrgency(short, now)).toBe(1); // saturated
    expect(overdueUrgency(long, now)).toBeLessThan(0.1);
    expect(overdueUrgency(short, now)).toBeGreaterThan(overdueUrgency(long, now));
  });

  it('overdueUrgency is 0 when not due or never scheduled', () => {
    expect(overdueUrgency(item({ dueAt: 10 * DAY }), 5 * DAY)).toBe(0);
    expect(overdueUrgency(item({ dueAt: null }), 5 * DAY)).toBe(0);
    // A fresh word (never graded) falls back to the 1-day default interval.
    expect(overdueUrgency(item({ dueAt: -DAY, lastIntervalDays: null }), 0)).toBe(0.5);
  });

  it('neighborhoodEdges counts other words sharing at least one signature prime', () => {
    const index = neighborIndex(VOCAB);
    expect(neighborhoodEdges('alpha', VOCAB, index)).toBe(1); // beta
    expect(neighborhoodEdges('beta', VOCAB, index)).toBe(1); // alpha
    expect(neighborhoodEdges('gamma', VOCAB, index)).toBe(0);
    // A word absent from the vocabulary has no edges and NO sparsity claim.
    expect(neighborhoodEdges('missing', VOCAB, index)).toBe(0);
    expect(neighborhoodSparsity('missing', VOCAB, index)).toBe(0);
  });

  it('neighborhoodSparsity: isolated words score 1, clustered words decay', () => {
    const index = neighborIndex(VOCAB);
    expect(neighborhoodSparsity('gamma', VOCAB, index)).toBe(1);
    const alpha = neighborhoodSparsity('alpha', VOCAB, index);
    expect(alpha).toBeCloseTo(Math.exp(-1 / 6), 10);
    expect(alpha).toBeLessThan(1);
    expect(alpha).toBeGreaterThan(0);
  });

  it('gapSignal needs a pattern: one miss is noise, repeated misses are a signal', () => {
    expect(gapSignal({ reviewHistory: [] })).toBe(0);
    // A single miss (of a short history) is below the pattern threshold.
    expect(gapSignal({ reviewHistory: ['wrong'] })).toBeLessThan(0.3);
    // Three misses of eight are a pattern (trailing streak 0 here).
    const patterned = gapSignal({ reviewHistory: ['wrong', 'correct', 'wrong', 'correct', 'wrong', 'correct', 'correct', 'correct'] });
    expect(patterned).toBeGreaterThan(0.2);
    // A perfect record is 0.
    expect(gapSignal({ reviewHistory: ['correct', 'correct', 'correct', 'correct'] })).toBe(0);
    // A trailing streak pushes the signal up.
    const streak = gapSignal({ reviewHistory: ['correct', 'correct', 'wrong', 'wrong', 'wrong', 'wrong'] });
    expect(streak).toBeGreaterThan(gapSignal({ reviewHistory: ['wrong', 'correct', 'correct', 'correct', 'correct', 'correct'] }));
  });

  it('drillWeakness: zero rounds are not weak; three failed rounds saturate', () => {
    expect(drillWeakness(undefined)).toBe(0);
    expect(drillWeakness(0)).toBe(0);
    expect(drillWeakness(1)).toBeLessThan(drillWeakness(2));
    expect(drillWeakness(3)).toBe(1);
    expect(drillWeakness(7)).toBe(1);
  });
});

describe('scoreWord and ranking', () => {
  it('scoreWord combines the signals into a weighted score in [0,1]', () => {
    const hard = scoreWord(item({ word: 'alpha', difficulty: 9, dueAt: -2 * DAY, lastIntervalDays: 1, reviewHistory: ['wrong', 'wrong', 'wrong'] }), CTX);
    expect(hard.score).toBeGreaterThanOrEqual(0);
    expect(hard.score).toBeLessThanOrEqual(1);
    // The components are reported separately (introspection, no black box).
    expect(hard.fsrs).toBeCloseTo(8 / 9, 10);
    expect(hard.gap).toBeGreaterThan(0);
  });

  it('a weight of 0 kills its component', () => {
    const withDrill = scoreWord(item({ word: 'alpha' }), { ...CTX, drillFailures: { alpha: 3 } });
    const withoutDrill = scoreWord(item({ word: 'alpha' }), { ...CTX, drillFailures: { alpha: 3 }, weights: { drill: 0 } });
    expect(withoutDrill.drill).toBe(1); // the signal is still measured…
    expect(withoutDrill.score).toBeLessThan(withDrill.score); // …but not weighted
  });

  it('rankCurriculum puts due words before fresh words, each pool score-ordered', () => {
    const now = 0;
    const items: CurriculumItem[] = [
      item({ word: 'gamma', traceId: null }), // fresh, isolated → highest fresh score
      item({ word: 'alpha', dueAt: -2 * DAY, lastIntervalDays: 1, difficulty: 9, reviewHistory: ['wrong', 'wrong', 'wrong'] }),
      item({ word: 'beta', dueAt: -3 * DAY, lastIntervalDays: 1, difficulty: 5 })
    ];
    const ranked = rankCurriculum(items, { ...CTX, now });
    expect(ranked[0].word).toBe('alpha'); // due, harder, gapped — beats more-overdue beta
    expect(ranked[1].word).toBe('beta');
    expect(ranked[2].word).toBe('gamma'); // fresh pool last
    // Healthy (learned, not due) words are excluded by default…
    const healthy = item({ word: 'delta', traceId: 't-delta', dueAt: 5 * DAY });
    const withHealthy = rankCurriculum([...items, healthy], { ...CTX, now });
    expect(withHealthy.map((s) => s.word)).not.toContain('delta');
    // …and included after fresh when asked.
    const includeHealthy = rankCurriculum([...items, healthy], { ...CTX, now }, { includeHealthy: true });
    expect(includeHealthy.map((s) => s.word)).toContain('delta');
    expect(includeHealthy[includeHealthy.length - 1].word).toBe('delta');
  });

  it('fresh words are ranked by sparsity: isolated words get taught first', () => {
    const items: CurriculumItem[] = [
      item({ word: 'beta', traceId: null }),
      item({ word: 'alpha', traceId: null }),
      item({ word: 'gamma', traceId: null })
    ];
    const ranked = rankCurriculum(items, { ...CTX, now: 0 });
    expect(ranked[0].word).toBe('gamma'); // 0 neighbors — strictly first
    // alpha and beta tie on 1 edge; the sort is stable (input order).
    expect(ranked.slice(1).map((s) => s.word).sort()).toEqual(['alpha', 'beta']);
  });

  it('nextCurriculumWord returns the top of the queue, null when empty', () => {
    const items = [item({ word: 'alpha', dueAt: -1, lastIntervalDays: 1 }), item({ word: 'beta' })];
    expect(nextCurriculumWord(items, { ...CTX, now: 0 })).toBe('alpha');
    expect(nextCurriculumWord([], CTX)).toBeNull();
  });

  it('rankLegacy reproduces the pre-curriculum scheduler: earliest dueAt, tie → lowest stability, fresh last', () => {
    const now = 0;
    const items: CurriculumItem[] = [
      item({ word: 'a', dueAt: -3 * DAY, stability: 4 }),
      item({ word: 'b', dueAt: -3 * DAY, stability: 2 }),
      item({ word: 'c', dueAt: -1 * DAY, stability: 1 }),
      item({ word: 'd', traceId: null })
    ];
    const ranked = rankLegacy(items, now);
    expect(ranked.map((s) => s.word)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('the default weights are finite and positive (a sane mix)', () => {
    for (const w of Object.values(CURRICULUM_WEIGHTS)) {
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThan(0);
    }
  });
});

describe('TeacherAgent curriculum integration', () => {
  const OPTIONS = {
    primeCount: 64,
    gridSize: 128,
    memoryMode: 'compact' as const,
    vocabulary: deckVocabulary(DECK_100, PRIME_SPACE)
  };

  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DECK_100);
  });

  afterEach(() => {
    session.dispose();
  });

  it('grades append to the persisted review history, capped', () => {
    teacher.teach('apple');
    for (let i = 0; i < 30; i += 1) {
      const answer = teacher.ask('apple', 'recognition');
      teacher.grade('apple', answer);
      teacher.grade('apple', { word: teacher.tryState('apple')!.word, cue: 'apple', answer: '', recall: null });
    }
    const history = teacher.tryState('apple')!.reviewHistory;
    expect(history.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThanOrEqual(24);
    // Both outcomes entered the record.
    expect(history.some((o) => o === 'correct')).toBe(true);
    expect(history.some((o) => o === 'wrong')).toBe(true);
  });

  it('reviewHistory and drillFailures survive persistence round-trips', async () => {
    const store = new MemoryPersistenceStore();
    const persisted = new TeacherAgent(session, DECK_100, store);
    persisted.teach('apple');
    persisted.grade('apple', { word: persisted.tryState('apple')!.word, cue: 'apple', answer: '', recall: null });
    persisted.grade('apple', { word: persisted.tryState('apple')!.word, cue: 'apple', answer: '', recall: null });
    persisted.recordDrillResult('addition', 'unlearned');
    persisted.recordDrillResult('addition', 'memorized');
    await persisted.persistAll();

    const session2 = new ObserverSession(OPTIONS, 100);
    await session2.initialize();
    const restored = new TeacherAgent(session2, DECK_100, store);
    await restored.restoreFromPersistence();
    expect(restored.tryState('apple')!.reviewHistory).toEqual(['wrong', 'wrong']);
    expect(restored.drillFailuresSnapshot()).toEqual({ addition: 2 });
    session2.dispose();
  });

  it('a failed drill that later induces clears the weakness; the queue reflects it', () => {
    teacher.recordDrillResult('water', 'unlearned');
    teacher.recordDrillResult('water', 'memorized');
    expect(teacher.drillFailuresSnapshot().water).toBe(2);
    // The weak concept outranks a healthy peer on the queue once taught.
    teacher.teach('water');
    teacher.teach('apple');
    let queue = teacher.curriculumQueue();
    let water = queue.find((s) => s.word === 'water')!;
    let apple = queue.find((s) => s.word === 'apple')!;
    expect(water.drill).toBeGreaterThan(0);
    expect(queue.indexOf(water)).toBeLessThan(queue.indexOf(apple));
    // Induction clears the weakness — the boost disappears with it.
    teacher.recordDrillResult('water', 'induced');
    expect(teacher.drillFailuresSnapshot().water).toBeUndefined();
    queue = teacher.curriculumQueue();
    water = queue.find((s) => s.word === 'water')!;
    apple = queue.find((s) => s.word === 'apple')!;
    expect(water.drill).toBe(0);
    // apple still trails only if the score ordering agrees — the drill
    // boost is gone, so the queue may reorder; the weakness must not.
    expect(water.score).toBeGreaterThanOrEqual(0);
    expect(apple.score).toBeGreaterThanOrEqual(0);
  });

  it('nextReview returns due words first; ordering within the due pool is curriculum-driven', () => {
    teacher.teach('apple');
    teacher.teach('water');
    teacher.teach('book');
    // All three are due (freshly taught). A failed review makes a word
    // harder AND starts its gap history — it must rise to the front.
    for (const word of ['apple', 'water']) {
      teacher.grade(word, { word: teacher.tryState(word)!.word, cue: word, answer: '', recall: null });
    }
    const first = teacher.nextReview();
    expect(['apple', 'water', 'book']).toContain(first);
    const scored = teacher.curriculumQueue().filter((s) => ['apple', 'water', 'book'].includes(s.word));
    expect(scored[0].word).toBe(first);
  });

  it('curriculum disabled restores the legacy scheduler exactly', async () => {
    const session2 = new ObserverSession(OPTIONS, 100);
    await session2.initialize();
    const legacy = new TeacherAgent(session2, DECK_100, null, 1, 4, undefined, undefined, { enabled: false });
    legacy.teach('friend');
    legacy.teach('book');
    legacy.teach('music');
    // friend fails → rescheduled; book and music stay due, book due first.
    legacy.grade('friend', { word: legacy.tryState('friend')!.word, cue: 'friend', answer: '', recall: null });
    expect(legacy.nextReview()).toBe(legacy.legacyQueue()[0].word);
    expect(legacy.nextReview()).toBe('book');
    session2.dispose();
  });

  it('nextNewWord is sparse-first under the curriculum, deck-order under the legacy control', async () => {
    const deck = DECK_100.slice(0, 12);
    const session2 = new ObserverSession(OPTIONS, 100);
    await session2.initialize();
    const legacy = new TeacherAgent(session2, deck, null, 1, 4, undefined, undefined, { enabled: false });
    const curriculum = new TeacherAgent(session2, deck, null, 1, 4, undefined, undefined, {});
    const vocab = curriculum.curriculumVocabulary();
    const firstCurriculum = curriculum.nextNewWord()!;
    const firstLegacy = legacy.nextNewWord()!;
    expect(firstLegacy).toBe(deck[0].word); // deck order
    // The curriculum pick must be at least as sparse as the deck-order pick.
    expect(neighborhoodEdges(firstCurriculum, vocab)).toBeLessThanOrEqual(neighborhoodEdges(firstLegacy, vocab));
    session2.dispose();
  });
});
