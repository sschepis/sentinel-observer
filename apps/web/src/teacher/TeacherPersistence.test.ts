/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { DECK_100 } from './decks/en-100';
import { MemoryPersistenceStore } from '../persistence/store';
import { PRIME_SPACE } from './primeSignature';
import { semanticVocabulary } from './semanticSignature';
import { BOOTSTRAP_VOCABULARY_SCHEME } from './bootstrap';

const OPTIONS = { primeCount: 64, gridSize: 128, memoryMode: 'compact' as const, vocabulary: semanticVocabulary(DECK_100, PRIME_SPACE) };

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


  it('restores word states and traces into a fresh observer', async () => {
    // Session 1: the observer learns two words and is graded.
    const session1 = new ObserverSession(OPTIONS, 100);
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
    const session2 = new ObserverSession(OPTIONS, 100);
    await session2.initialize();
    const teacher2 = new TeacherAgent(session2, DECK_100, store);
    const restored = await teacher2.restoreFromPersistence();

    expect(restored.restored).toBe(2);
    expect(restored.stale).toBe(0);
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
    const session1 = new ObserverSession(OPTIONS, 100);
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

describe('encoding-epoch migration', () => {
  it('treats pre-compact traces as stale and resets their words for re-teaching', async () => {
    const store = new MemoryPersistenceStore();
    // A full-bank-era serialized trace (no 'bank' marker, flat profile).
    const legacyTrace = {
      id: 'legacy-1',
      content: 'apple: a round red or green fruit',
      smf: new Array(16).fill(0.01),
      primes: [2, 3, 5, 7, 11, 13],
      amplitudes: [1, 1, 1, 1, 1, 1],
      createdAt: 1,
      lastAccessAt: 2,
      accessCount: 3,
      strength: 0.8,
      importance: 0.5,
      consolidated: false,
      smfEntropy: 0.9,
      metadata: {}
    };
    await store.saveTraces([legacyTrace]);
    await store.saveWordStates([
      {
        word: DECK_100[0],
        traceId: 'legacy-1',
        taughtAt: 1,
        lastAskedAt: 2,
        lastGrade: 'correct',
        successes: 3,
        failures: 1,
        strengthHistory: [],
        stability: 1,
        difficulty: 5,
        dueAt: null,
        lastIntervalDays: null
      }
    ]);

    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK_100, store);
    const result = await teacher.restoreFromPersistence();

    expect(result.restored).toBe(0);
    expect(result.stale).toBe(1);
    const apple = teacher.listWords().find((w) => w.word.word === 'apple');
    expect(apple?.status).toBe('new');
    expect(apple?.traceId).toBeNull();
    expect(apple?.successes).toBe(0);

    session.dispose();
  });
});

describe('encoding-epoch migration (data-based)', () => {
  it('detects re-badged flat traces as stale (markers cannot hide flat data)', async () => {
    const store = new MemoryPersistenceStore();
    // Old-era data re-serialized by a later compact persist: compact marker,
    // flat amplitudes, near-identity SMF.
    const reBadged = {
      id: 'rebadged-1',
      content: 'water: the clear liquid we drink',
      smf: new Array(16).fill(0.005),
      primes: [2, 3, 5, 7, 11, 13, 17, 19],
      amplitudes: [1, 1, 1, 1, 1, 1, 1, 1],
      createdAt: 1,
      lastAccessAt: 2,
      accessCount: 1,
      strength: 0.9,
      importance: 0.5,
      consolidated: false,
      smfEntropy: 0.95,
      metadata: {},
      bank: 'compact'
    };
    await store.saveTraces([reBadged]);
    await store.saveWordStates([
      {
        word: DECK_100.find((w) => w.word === 'water')!,
        traceId: 'rebadged-1',
        taughtAt: 1,
        lastAskedAt: 2,
        lastGrade: null,
        successes: 2,
        failures: 0,
        strengthHistory: [],
        stability: 1,
        difficulty: 5,
        dueAt: null,
        lastIntervalDays: null
      }
    ]);

    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK_100, store);
    const result = await teacher.restoreFromPersistence();

    expect(result.restored).toBe(0);
    expect(result.stale).toBe(1);
    const water = teacher.listWords().find((w) => w.word.word === 'water');
    expect(water?.status).toBe('new');
    expect(water?.traceId).toBeNull();

    session.dispose();
  });

  it('keeps genuinely focused traces from the current vocabulary epoch', async () => {
    const store = new MemoryPersistenceStore();
    // A real focused trace: concentrated amplitudes, distinct SMF, no marker.
    const focused = {
      id: 'focused-1',
      content: 'book: pages with words that you read',
      smf: [0.9, 0.1, 0.05, 0.02, 0.01, 0.01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      primes: [2, 3, 5, 7, 11, 13],
      amplitudes: [0.7, 0.6, 0.5, 0.02, 0.01, 0.01],
      createdAt: 1,
      lastAccessAt: 2,
      accessCount: 0,
      strength: 1,
      importance: 0.5,
      consolidated: false,
      smfEntropy: 0.4,
      metadata: {}
    };
    await store.saveTraces([focused]);
    await store.saveLearningState({ vocabularyScheme: BOOTSTRAP_VOCABULARY_SCHEME });

    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK_100, store);
    const result = await teacher.restoreFromPersistence();

    expect(result.restored).toBe(1);
    expect(result.stale).toBe(0);

    session.dispose();
  });
});
