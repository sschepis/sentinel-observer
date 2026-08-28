import Dexie, { type Table } from 'dexie';
import type { ObserverSignal, SerializedTrace } from '@sschepis/sentient-core';
import type { WordState } from '../teacher/TeacherAgent';

/**
 * Persistence for the observer's learning record.
 *
 * Two implementations behind one interface, following the degradation
 * contract: IndexedDB when the browser has it (learning survives restarts),
 * an in-memory store otherwise (session-only, reported honestly).
 */

export type PersistenceKind = 'indexeddb' | 'memory';

export interface PersistenceStore {
  readonly kind: PersistenceKind;
  saveWordStates(states: WordState[]): Promise<void>;
  loadWordStates(): Promise<WordState[] | null>;
  saveTraces(traces: SerializedTrace[]): Promise<void>;
  loadTraces(): Promise<SerializedTrace[]>;
  appendDiary(signals: ObserverSignal[]): Promise<void>;
  loadDiary(): Promise<ObserverSignal[]>;
}

// ────────────────────────────────────────────────────────────────────────────
// In-memory implementation (tests, and browsers without IndexedDB)
// ────────────────────────────────────────────────────────────────────────────

export class MemoryPersistenceStore implements PersistenceStore {
  readonly kind: PersistenceKind = 'memory';
  private wordStates: WordState[] | null = null;
  private traces: SerializedTrace[] = [];
  private diary: ObserverSignal[] = [];

  async saveWordStates(states: WordState[]): Promise<void> {
    this.wordStates = states.map((s) => ({ ...s }));
  }

  async loadWordStates(): Promise<WordState[] | null> {
    return this.wordStates === null ? null : this.wordStates.map((s) => ({ ...s }));
  }

  async saveTraces(traces: SerializedTrace[]): Promise<void> {
    this.traces = traces;
  }

  async loadTraces(): Promise<SerializedTrace[]> {
    return this.traces;
  }

  async appendDiary(signals: ObserverSignal[]): Promise<void> {
    this.diary.push(...signals);
  }

  async loadDiary(): Promise<ObserverSignal[]> {
    return [...this.diary];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// IndexedDB implementation (Dexie)
// ────────────────────────────────────────────────────────────────────────────

interface WordStateRow extends WordState {
  key: string;
}

class SentinelDB extends Dexie {
  wordStates!: Table<WordStateRow, string>;
  traces!: Table<SerializedTrace, string>;
  diary!: Table<ObserverSignal, number>;

  constructor() {
    super('sentinel');
    // v2: the diary table gains an index on 'at' — orderBy('at') requires it
    // (v1 shipped without the index and loadDiary threw SchemaError).
    this.version(2).stores({
      wordStates: 'key',
      traces: 'id',
      diary: '++, at'
    });
  }
}

export class IndexedDBPersistenceStore implements PersistenceStore {
  readonly kind: PersistenceKind = 'indexeddb';
  private readonly db = new SentinelDB();

  async saveWordStates(states: WordState[]): Promise<void> {
    await this.db.wordStates.clear();
    await this.db.wordStates.bulkPut(states.map((s) => ({ ...s, key: s.word.word })));
  }

  async loadWordStates(): Promise<WordState[] | null> {
    const rows = await this.db.wordStates.toArray();
    if (rows.length === 0) return null;
    return rows.map(({ key: _key, ...state }) => state);
  }

  async saveTraces(traces: SerializedTrace[]): Promise<void> {
    await this.db.traces.clear();
    await this.db.traces.bulkPut(traces);
  }

  async loadTraces(): Promise<SerializedTrace[]> {
    return this.db.traces.toArray();
  }

  async appendDiary(signals: ObserverSignal[]): Promise<void> {
    await this.db.diary.bulkAdd(signals);
  }

  async loadDiary(): Promise<ObserverSignal[]> {
    return this.db.diary.orderBy('at').toArray();
  }
}

/** Pick the best store the environment offers (honest degradation). */
export function createPersistenceStore(): PersistenceStore {
  try {
    if (typeof indexedDB !== 'undefined') {
      return new IndexedDBPersistenceStore();
    }
  } catch {
    // Fall through to memory.
  }
  return new MemoryPersistenceStore();
}
