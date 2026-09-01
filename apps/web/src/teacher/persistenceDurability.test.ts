/**
 * @jest-environment node
 */
import { describe, it, expect, jest } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent, type WordState } from './TeacherAgent';
import { MemoryPersistenceStore, type PersistenceStore } from '../persistence/store';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';
import type { SerializedTrace } from '@sschepis/sentient-core';

const DECK: readonly DeckWord[] = [
  { word: 'water', definition: 'a clear liquid that falls as rain', example: 'Water is wet.' },
  { word: 'bird', definition: 'an animal with wings', example: 'A bird can fly.' },
  { word: 'stone', definition: 'a hard piece of rock', example: 'The stone is heavy.' }
];
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

async function teacherOn(store: PersistenceStore): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  return { session, teacher: new TeacherAgent(session, DECK, store) };
}

/**
 * A store that models the real IndexedDB write: clear, yield, then write.
 * Two overlapping saves interleave into a truncated table unless the caller
 * serializes them — which is exactly what this store detects.
 */
class InterleavingStore extends MemoryPersistenceStore {
  concurrentWrites = 0;
  maxConcurrentWrites = 0;
  wordStateWrites = 0;
  private rows: WordState[] = [];

  async saveWordStates(states: WordState[]): Promise<void> {
    this.concurrentWrites += 1;
    this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this.concurrentWrites);
    this.wordStateWrites += 1;
    this.rows = [];
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.rows = states.map((state) => ({ ...state }));
    this.concurrentWrites -= 1;
  }

  async loadWordStates(): Promise<WordState[] | null> {
    return this.rows.length === 0 ? null : this.rows.map((state) => ({ ...state }));
  }

  async saveTraces(_traces: SerializedTrace[]): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the learning record reaches storage as it changes', () => {
  it('never runs two writes at once (a clear+write pair must not interleave)', async () => {
    const store = new InterleavingStore();
    const { session, teacher } = await teacherOn(store);

    await Promise.all([teacher.persistAll(), teacher.persistAll(), teacher.persistAll()]);

    expect(store.maxConcurrentWrites).toBe(1);
    expect(store.wordStateWrites).toBe(3);
    session.dispose();
  });

  it('coalesces a burst of lessons into a single write, then flushes it', async () => {
    jest.useFakeTimers();
    try {
      const store = new MemoryPersistenceStore();
      const session = new ObserverSession(OPTIONS, 100);
      await session.initialize();
      const teacher = new TeacherAgent(session, DECK, store);

      for (const entry of DECK) teacher.teach(entry.word);

      // Nothing has been written yet — the burst is still being coalesced.
      expect(await store.loadWordStates()).toBeNull();

      jest.useRealTimers();
      await teacher.flush();

      const saved = await store.loadWordStates();
      expect(saved).not.toBeNull();
      expect(saved?.filter((state) => state.traceId !== null).length).toBe(DECK.length);
      session.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('flushing without pending changes still waits for queued writes', async () => {
    const store = new InterleavingStore();
    const { session, teacher } = await teacherOn(store);

    void teacher.persistAll();
    await teacher.flush();

    expect(store.concurrentWrites).toBe(0);
    session.dispose();
  });

  it('keeps a failed write from blocking every later write', async () => {
    const store = new MemoryPersistenceStore();
    const failing = jest
      .spyOn(store, 'saveWordStates')
      .mockRejectedValueOnce(new Error('quota exceeded'));
    const { session, teacher } = await teacherOn(store);

    teacher.teach('water');
    await teacher.flush();
    expect(failing).toHaveBeenCalled();

    failing.mockRestore();
    teacher.teach('bird');
    await teacher.flush();

    const saved = await store.loadWordStates();
    expect(saved?.some((state) => state.word.word === 'bird' && state.traceId !== null)).toBe(true);
    session.dispose();
  });

  it('stores only the words that carry learning', async () => {
    const store = new MemoryPersistenceStore();
    const { session, teacher } = await teacherOn(store);

    teacher.teach('water');
    await teacher.flush();

    const saved = await store.loadWordStates();
    expect(saved?.length).toBe(1);
    expect(saved?.[0]?.word.word).toBe('water');

    // Untaught words rebuild from the deck, so the record stays complete.
    const { session: fresh, teacher: reloaded } = await teacherOn(store);
    await reloaded.restoreFromPersistence();
    expect(reloaded.listWords().length).toBe(DECK.length);
    expect(reloaded.listWords().find((w) => w.word.word === 'water')?.traceId).not.toBeNull();
    expect(reloaded.listWords().find((w) => w.word.word === 'bird')?.traceId).toBeNull();

    session.dispose();
    fresh.dispose();
  });
});

describe('chaperoned definitions are kept, not re-requested', () => {
  it('accumulates definitions across incremental saves', async () => {
    const store = new MemoryPersistenceStore();
    await store.saveDefinitions([{ word: 'water', definition: 'a clear liquid', example: 'Water is wet.' }]);
    await store.saveDefinitions([{ word: 'bird', definition: 'a winged animal', example: 'A bird flies.' }]);

    const saved = await store.loadDefinitions();
    expect(saved.map((d) => d.word).sort()).toEqual(['bird', 'water']);
  });

  it('overwrites an earlier definition for the same word', async () => {
    const store = new MemoryPersistenceStore();
    await store.saveDefinitions([{ word: 'water', definition: 'first', example: '' }]);
    await store.saveDefinitions([{ word: 'water', definition: 'second', example: '' }]);

    const saved = await store.loadDefinitions();
    expect(saved.length).toBe(1);
    expect(saved[0]?.definition).toBe('second');
  });

  it('leaves nothing to look up again once the definitions are applied', async () => {
    const store = new MemoryPersistenceStore();
    const undefined_deck: DeckWord[] = [
      { word: 'water', definition: '', example: '' },
      { word: 'bird', definition: '', example: '' }
    ];
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, undefined_deck, store);

    expect(teacher.listWords().filter((w) => w.word.definition.length === 0).length).toBe(2);

    const generated = [
      { word: 'water', definition: 'a clear liquid', example: 'Water is wet.' },
      { word: 'bird', definition: 'a winged animal', example: 'A bird flies.' }
    ];
    teacher.applyDefinitions(generated);
    await store.saveDefinitions(generated);

    // "Reload": a fresh teacher restores the definitions from storage, so
    // the backfill finds nothing missing and asks the model for nothing.
    const freshDeck: DeckWord[] = [
      { word: 'water', definition: '', example: '' },
      { word: 'bird', definition: '', example: '' }
    ];
    const freshSession = new ObserverSession(OPTIONS, 100);
    await freshSession.initialize();
    const fresh = new TeacherAgent(freshSession, freshDeck, store);
    await fresh.restoreFromPersistence();
    fresh.applyDefinitions(await store.loadDefinitions());

    expect(fresh.listWords().filter((w) => w.word.definition.length === 0).length).toBe(0);

    session.dispose();
    freshSession.dispose();
  });
});
