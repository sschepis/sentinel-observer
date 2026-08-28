/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
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

describe('SRS: wall-clock forgetting and due-status', () => {
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

    // Simulate 3 days of absence: the persisted trace's lastAccessAt ages.
    const saved = await store.loadTraces();
    expect(saved).toHaveLength(1);
    saved[0].lastAccessAt = Date.now() - 3 * DAY;
    await store.saveTraces(saved);
    session.dispose();

    // Session 2: restore — the trace must have forgotten (unreinforced
    // half-life is 2 days, so 3 days leaves strength below the due threshold).
    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DECK_100, store);
    const result = await teacher.restoreFromPersistence();

    expect(result.restored).toBe(1);
    const apple = teacher.report().words.find((w) => w.word === 'apple')!;
    expect(apple.status).toBe('due');
    expect(apple.strength!).toBeLessThan(0.6);
    expect(apple.strength!).toBeGreaterThan(0);
    void trace1;
  });

  it('a consolidated trace forgets slowly and stays healthy over days', async () => {
    teacher.teach('apple');
    const entry = teacher.listWords().find((w) => w.word.word === 'apple')!;
    const trace = session.observer.getMemoryBank().get(entry.traceId!)!;
    // Consolidate: enough accesses + strength.
    trace.accessCount = 5;
    trace.consolidated = true;
    trace.strength = 1;
    await teacher.persistAll();

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
    expect(apple.strength!).toBeGreaterThan(0.8); // 30-day half-life: barely faded
  });

  it('report() gives counts, statuses, and strength deltas', async () => {
    teacher.teach('apple');
    const entry = teacher.listWords().find((w) => w.word.word === 'apple')!;
    const trace = session.observer.getMemoryBank().get(entry.traceId!)!;
    trace.strength = 0.8;
    await teacher.persistAll();

    // Second sample after reinforcement: delta vs previous sample.
    trace.strength = 0.9;
    await teacher.persistAll();

    const report = teacher.report();
    expect(report.total).toBe(100);
    expect(report.learned).toBe(1);
    expect(report.dueCount).toBe(0);
    expect(report.healthyCount).toBe(1);

    const apple = report.words.find((w) => w.word === 'apple')!;
    expect(apple.strength).toBeCloseTo(0.9, 5);
    expect(apple.delta).toBeCloseTo(0.1, 5);
    expect(apple.status).toBe('healthy');

    const fresh = report.words.find((w) => w.word === 'sleep')!;
    expect(fresh.status).toBe('new');
    expect(fresh.strength).toBeNull();
  });

  it('nextReview() returns the most decayed word first (SRS ordering)', async () => {
    for (const word of ['friend', 'book', 'music']) teacher.teach(word);
    const music = teacher.listWords().find((w) => w.word.word === 'music')!;
    const trace = session.observer.getMemoryBank().get(music.traceId!)!;
    trace.strength = 0.3;

    expect(teacher.nextReview()).toBe('music');
  });
});
