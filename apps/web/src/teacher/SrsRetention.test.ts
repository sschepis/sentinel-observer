/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent, FSRS_CONSOLIDATED_STABILITY, retentionProbability } from './TeacherAgent';
import { DECK_100 } from './decks/en-100';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { MemoryPersistenceStore } from '../persistence/store';

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary(DECK_100, PRIME_SPACE)
};

const DAY = 24 * 60 * 60 * 1000;

describe('SRS: FSRS wall-clock forgetting and due-status (P9)', () => {
  let store: MemoryPersistenceStore;
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    store = new MemoryPersistenceStore();
    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DECK_100, store);
  });

  afterEach(() => {
    session.dispose();
  });

  it('restored traces decay with wall-clock time and become due', async () => {
    // Session 1: teach a word, persist.
    teacher.teach('apple');
    const before = teacher.listWords().find((w) => w.word.word === 'apple')!;
    const trace1 = session.observer.getMemoryBank().get(before.traceId!)!;
    await teacher.persistAll();

    // Simulate 14 days of absence: the persisted trace's lastAccessAt ages.
    // A fresh word has stability 1 day — at 14 days the model predicts
    // retention ≈ 0.48, well below the due review point.
    const saved = await store.loadTraces();
    expect(saved).toHaveLength(1);
    saved[0].lastAccessAt = Date.now() - 14 * DAY;
    await store.saveTraces(saved);
    session.dispose();

    // Session 2: restore — the trace must have forgotten (strength is the
    // model's retention prediction, and the review is due).
    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DECK_100, store);
    const result = await teacher.restoreFromPersistence();

    expect(result.restored).toBe(1);
    const apple = teacher.report().words.find((w) => w.word === 'apple')!;
    expect(apple.status).toBe('due');
    expect(apple.strength!).toBeLessThan(0.6);
    expect(apple.strength!).toBeGreaterThan(0);
    expect(apple.strength!).toBeCloseTo(retentionProbability(1, 5, 14), 3);
  });

  it('a consolidated word (stability ≥ 30) forgets slowly and stays healthy over days', async () => {
    // Grow stability through repeated correct reviews: 8 correct grades on
    // the only learned word compound stability past the consolidation floor.
    teacher.teach('apple');
    for (let i = 0; i < 8; i += 1) {
      const answer = teacher.ask('apple', 'recognition');
      teacher.grade('apple', answer);
    }
    const state = teacher.tryState('apple');
    expect(state?.stability).toBeGreaterThanOrEqual(FSRS_CONSOLIDATED_STABILITY);
    await teacher.persistAll();

    // Age the trace 3 days and restore: the model predicts ~0.99 retention
    // (S ≈ 30+), the word is NOT due, and it reads consolidated.
    const saved = await store.loadTraces();
    saved[0].lastAccessAt = Date.now() - 3 * DAY;
    await store.saveTraces(saved);
    session.dispose();

    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DECK_100, store);
    await teacher.restoreFromPersistence();

    const apple = teacher.report().words.find((w) => w.word === 'apple')!;
    expect(apple.status).toBe('consolidated');
    expect(apple.strength!).toBeGreaterThan(0.8);
  }, 30000);

  it('report() gives counts, statuses, and strength deltas', async () => {
    teacher.teach('apple');
    const answer = teacher.ask('apple', 'recognition');
    teacher.grade('apple', answer);
    // The correct review scheduled the word ~1.5 days out: healthy, not due.
    const report = teacher.report();
    expect(report.total).toBe(100);
    expect(report.learned).toBe(1);
    expect(report.dueCount).toBe(0);
    expect(report.healthyCount).toBe(1);

    const apple = report.words.find((w) => w.word === 'apple')!;
    expect(apple.status).toBe('healthy');
    expect(apple.strength!).toBeGreaterThan(0.5);
    // The retention record samples the model's prediction on review.
    expect(teacher.tryState('apple')!.strengthHistory.length).toBeGreaterThan(0);

    const fresh = report.words.find((w) => w.word === 'sleep')!;
    expect(fresh.status).toBe('new');
    expect(fresh.strength).toBeNull();
  });

  it('nextReview() returns a due word, and reviewed words drop out of the queue', async () => {
    for (const word of ['friend', 'book', 'music']) teacher.teach(word);
    // All three are due (freshly taught); review two correctly so they are
    // scheduled ~1.5 days out — the remaining due word is next.
    for (const word of ['friend', 'book']) {
      const answer = teacher.ask(word, 'recognition');
      teacher.grade(word, answer);
    }
    expect(teacher.nextReview()).toBe('music');
  });
});
