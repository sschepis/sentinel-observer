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

/**
 * The diary is a rolling window — the app only ever renders its recent tail,
 * but a training run emits a memory signal per lesson, so an uncapped table
 * grows forever and makes every reload slower.
 */
const MAX_DIARY_ROWS = 500;
/** Appends between prune passes. */
const DIARY_PRUNE_SLACK = 200;

export interface ChaperonedDefinition {
  word: string;
  definition: string;
  example: string;
}

export interface PersistenceStore {
  readonly kind: PersistenceKind;
  saveWordStates(states: WordState[]): Promise<void>;
  loadWordStates(): Promise<WordState[] | null>;
  saveTraces(traces: SerializedTrace[]): Promise<void>;
  loadTraces(): Promise<SerializedTrace[]>;
  appendDiary(signals: ObserverSignal[]): Promise<void>;
  loadDiary(): Promise<ObserverSignal[]>;
  /** Upsert by word — callers save incrementally, so this must never drop
   *  definitions saved by an earlier call. */
  saveDefinitions(definitions: ChaperonedDefinition[]): Promise<void>;
  loadDefinitions(): Promise<ChaperonedDefinition[]>;
  /** The full higher-order learning state (composition weights, drive
   *  weights, goal history, fade state, counters) as one JSON-serializable
   *  record — the deliberative layers must survive reloads too. */
  saveLearningState(state: Record<string, unknown>): Promise<void>;
  loadLearningState(): Promise<Record<string, unknown> | null>;
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
    this.traces = traces.map((t) => ({ ...t, smf: [...t.smf], amplitudes: [...t.amplitudes] }));
  }

  async loadTraces(): Promise<SerializedTrace[]> {
    // Defensive copy — callers must not mutate the store's internal array.
    return this.traces.map((t) => ({ ...t, smf: [...t.smf], amplitudes: [...t.amplitudes] }));
  }

  async appendDiary(signals: ObserverSignal[]): Promise<void> {
    this.diary.push(...signals);
    if (this.diary.length > MAX_DIARY_ROWS) {
      this.diary = this.diary.slice(-MAX_DIARY_ROWS);
    }
  }

  async loadDiary(): Promise<ObserverSignal[]> {
    return [...this.diary];
  }

  private definitions = new Map<string, ChaperonedDefinition>();

  async saveDefinitions(definitions: ChaperonedDefinition[]): Promise<void> {
    for (const definition of definitions) {
      this.definitions.set(definition.word, { ...definition });
    }
  }

  async loadDefinitions(): Promise<ChaperonedDefinition[]> {
    return [...this.definitions.values()].map((d) => ({ ...d }));
  }

  private learningState: Record<string, unknown> | null = null;

  async saveLearningState(state: Record<string, unknown>): Promise<void> {
    this.learningState = state;
  }

  async loadLearningState(): Promise<Record<string, unknown> | null> {
    return this.learningState === null ? null : { ...this.learningState };
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
  definitions!: Table<ChaperonedDefinition, string>;
  learningState!: Table<{ key: string; state: Record<string, unknown> }, string>;

  constructor() {
    super('sentinel');
    // v2: the diary table gains an index on 'at' — orderBy('at') requires it
    // (v1 shipped without the index and loadDiary threw SchemaError).
    // v3: the definitions table stores chaperone-generated deck content.
    // v4: the learningState table stores the higher-order learning record.
    this.version(3).stores({
      wordStates: 'key',
      traces: 'id',
      diary: '++, at',
      definitions: 'word'
    });
    this.version(4).stores({
      wordStates: 'key',
      traces: 'id',
      diary: '++, at',
      definitions: 'word',
      learningState: 'key'
    });
  }
}

export class IndexedDBPersistenceStore implements PersistenceStore {
  readonly kind: PersistenceKind = 'indexeddb';
  private readonly db = new SentinelDB();
  /** Appends since the last prune (pruning every time costs a transaction). */
  private sinceDiaryPrune = 0;

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
    // Counting on every append would cost a transaction per lesson.
    this.sinceDiaryPrune += signals.length;
    if (this.sinceDiaryPrune < DIARY_PRUNE_SLACK) return;
    this.sinceDiaryPrune = 0;
    const count = await this.db.diary.count();
    if (count > MAX_DIARY_ROWS) {
      const stale = await this.db.diary
        .orderBy('at')
        .limit(count - MAX_DIARY_ROWS)
        .primaryKeys();
      await this.db.diary.bulkDelete(stale);
    }
  }

  async loadDiary(): Promise<ObserverSignal[]> {
    const recent = await this.db.diary.orderBy('at').reverse().limit(MAX_DIARY_ROWS).toArray();
    return recent.reverse();
  }

  async saveDefinitions(definitions: ChaperonedDefinition[]): Promise<void> {
    await this.db.definitions.bulkPut(definitions);
  }

  async loadDefinitions(): Promise<ChaperonedDefinition[]> {
    return this.db.definitions.toArray();
  }

  async saveLearningState(state: Record<string, unknown>): Promise<void> {
    await this.db.learningState.put({ key: 'singleton', state });
  }

  async loadLearningState(): Promise<Record<string, unknown> | null> {
    const row = await this.db.learningState.get('singleton');
    return row === undefined ? null : row.state;
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
