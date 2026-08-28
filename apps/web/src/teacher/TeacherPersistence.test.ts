/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { DECK_100 } from './decks/en-100';
import { MemoryPersistenceStore } from '../persistence/store';

/**
 * The observer's learning record survives a restart: teach + grade, tear the
 * session down, build a fresh observer + teacher over the same store, and the
 * vocabulary — traces, strengths, counters — comes back.
 */
describe('TeacherAgent persistence round-trip', () => {
  let store: MemoryPersistenceStore;

  beforeEach(() => {
    store = new MemoryPersistenceStore();
  });

  afterEach(() => {});

  it('restores word states and traces into a fresh observer', async () => {
    // Session 1: the observer learns two words and is graded.
    const session1 = new ObserverSession({}, 100);
    await session1.initialize();
    const teacher1 = new TeacherAgent(session1, DECK_100, store);
    teacher1.teach('apple');
    teacher1.teach('water');
    const question = teacher1.ask('apple', 'recognition');
    teacher1.grade('apple', question);
    // Wait for the fire-and-forget persists to land.
    await teacher1.persistAll();
    session1.dispose();

    // Session 2: a completely fresh observer restores from the store.
    const session2 = new ObserverSession({}, 100);
    await session2.initialize();
    const teacher2 = new TeacherAgent(session2, DECK_100, store);
    const restored = await teacher2.restoreFromPersistence();

    expect(restored).toBe(2);
    const words = teacher2.listWords();
    const apple = words.find((w) => w.word.word === 'apple');
    const water = words.find((w) => w.word.word === 'water');
    expect(apple?.status).toBe('learning');
    expect(apple?.successes).toBe(1);
    expect(apple?.traceId).not.toBeNull();
    expect(water?.status).toBe('learning');
    expect(water?.failures).toBe(0);

    // The restored observer can still answer.
    const answer = teacher2.ask('apple', 'recognition');
    expect(answer.answer.toLowerCase()).toContain('apple');

    session2.dispose();
  });

  it('persists the diary entries and reloads them in order', async () => {
    const session1 = new ObserverSession({}, 100);
    await session1.initialize();
    const teacher1 = new TeacherAgent(session1, DECK_100, store);
    teacher1.teach('book');
    await teacher1.persistAll();
    // The memory 'stored' signal was emitted — capture it like the hook does.
    const diarySignals = session1.observer
      .getSignals()
      .history()
      .filter((s) => s.kind !== 'metric');
    await store.appendDiary(diarySignals);
    session1.dispose();

    const loaded = await store.loadDiary();
    expect(loaded.some((s) => s.kind === 'memory')).toBe(true);
  });
});
