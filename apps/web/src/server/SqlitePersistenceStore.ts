/**
 * SQLite-backed PersistenceStore for the observer server (node:sqlite — zero
 * dependencies, built into Node 22).
 *
 * One database file (`observer.sqlite`, WAL journal) under the data
 * directory, one table per record kind. Semantics mirror the JSON file
 * store exactly — save-all replaces the table, definitions upsert by word,
 * the diary keeps a rolling window, every write is transactional and
 * write-chained so overlapping saves cannot interleave — with the wins the
 * JSON files cannot give: incremental writes, crash-safe WAL commits, and
 * cheap partial reads.
 *
 * ONE-TIME MIGRATION: when the database is empty and the legacy JSON files
 * exist in the same directory, the constructor imports them into SQLite
 * (the JSON files are left untouched as a backup). The singular dataset
 * moves with no downtime and no data loss.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ObserverSignal, SerializedTrace } from '@sschepis/sentient-core';
import type { WordState } from '../teacher/TeacherAgent';
import type { EpisodicMemorySnapshot } from '../teacher/episodic';
import type { ChaperonedDefinition, PersistenceKind, PersistenceStore } from '../persistence/store';

const MAX_DIARY_ROWS = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS word_states (word TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, trace TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS diary (at INTEGER NOT NULL, signal TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS definitions (word TEXT PRIMARY KEY, definition TEXT NOT NULL, example TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS learning_state (key TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS episodic_memory (key TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
`;

export class SqlitePersistenceStore implements PersistenceStore {
  readonly kind: PersistenceKind = 'memory';
  private readonly db: DatabaseSync;
  private readonly dataDir: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'observer.sqlite'));
    this.db.exec(SCHEMA);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrateLegacyJsonOnce();
  }

  path(): string {
    return join(this.dataDir, 'observer.sqlite');
  }

  /** Import the legacy JSON files exactly once — an empty database and
   *  existing legacy files mean this is the first SQLite boot over a JSON
   *  dataset; the files stay as a backup. */
  private migrateLegacyJsonOnce(): void {
    const migrated = this.db.prepare('SELECT COUNT(*) AS n FROM traces').get() as { n: number };
    if (migrated.n > 0) return;
    const legacyFiles = [
      'word-states.json',
      'traces.json',
      'definitions.json',
      'learning-state.json',
      'episodic-memory.json',
      'diary.json'
    ];
    if (!legacyFiles.some((file) => existsSync(join(this.dataDir, file)))) return;

    const readJson = <T>(name: string): T | null => {
      try {
        return JSON.parse(readFileSync(join(this.dataDir, name), 'utf8')) as T;
      } catch {
        return null;
      }
    };

    this.db.exec('BEGIN');
    try {
      const states = readJson<WordState[]>('word-states.json') ?? [];
      if (states.length > 0) {
        const insert = this.db.prepare('INSERT INTO word_states (word, state) VALUES (?, ?)');
        for (const state of states) insert.run(state.word.word, JSON.stringify(state));
      }
      const traces = readJson<SerializedTrace[]>('traces.json') ?? [];
      if (traces.length > 0) {
        const insert = this.db.prepare('INSERT INTO traces (id, trace) VALUES (?, ?)');
        for (const trace of traces) insert.run(trace.id, JSON.stringify(trace));
      }
      const definitions = readJson<ChaperonedDefinition[]>('definitions.json') ?? [];
      if (definitions.length > 0) {
        const insert = this.db.prepare('INSERT INTO definitions (word, definition, example) VALUES (?, ?, ?)');
        for (const definition of definitions) insert.run(definition.word, definition.definition, definition.example);
      }
      const learning = readJson<Record<string, unknown>>('learning-state.json');
      if (learning !== null) {
        this.db.prepare('INSERT INTO learning_state (key, state) VALUES (?, ?)').run('state', JSON.stringify(learning));
      }
      const episodic = readJson<EpisodicMemorySnapshot>('episodic-memory.json');
      if (episodic !== null) {
        this.db.prepare('INSERT INTO episodic_memory (key, snapshot) VALUES (?, ?)').run('state', JSON.stringify(episodic));
      }
      const diary = readJson<ObserverSignal[]>('diary.json') ?? [];
      if (diary.length > 0) {
        const insert = this.db.prepare('INSERT INTO diary (at, signal) VALUES (?, ?)');
        for (const signal of diary.slice(-MAX_DIARY_ROWS)) insert.run(signal.at, JSON.stringify(signal));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      // Migration is best-effort at boot; a failure leaves the JSON files
      // untouched and the database empty — the next boot retries.
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** All writes are chained (never interleaved) and surfaced, never thrown
   *  into the observer loop — the same failure contract as the JSON store. */
  private chain(work: () => void): Promise<void> {
    const run = this.writeChain.then(() => {
      work();
    });
    this.writeChain = run.catch(() => {});
    return run;
  }

  async saveWordStates(states: WordState[]): Promise<void> {
    await this.chain(() => {
      this.db.exec('BEGIN');
      try {
        this.db.exec('DELETE FROM word_states');
        const insert = this.db.prepare('INSERT INTO word_states (word, state) VALUES (?, ?)');
        for (const state of states) insert.run(state.word.word, JSON.stringify(state));
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async loadWordStates(): Promise<WordState[] | null> {
    const rows = this.db.prepare('SELECT state FROM word_states').all() as Array<{ state: string }>;
    if (rows.length === 0) return null;
    return rows.map((row) => JSON.parse(row.state) as WordState);
  }

  async saveTraces(traces: SerializedTrace[]): Promise<void> {
    await this.chain(() => {
      this.db.exec('BEGIN');
      try {
        this.db.exec('DELETE FROM traces');
        const insert = this.db.prepare('INSERT INTO traces (id, trace) VALUES (?, ?)');
        for (const trace of traces) insert.run(trace.id, JSON.stringify(trace));
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async loadTraces(): Promise<SerializedTrace[]> {
    const rows = this.db.prepare('SELECT trace FROM traces').all() as Array<{ trace: string }>;
    return rows.map((row) => JSON.parse(row.trace) as SerializedTrace);
  }

  async appendDiary(signals: ObserverSignal[]): Promise<void> {
    await this.chain(() => {
      this.db.exec('BEGIN');
      try {
        const insert = this.db.prepare('INSERT INTO diary (at, signal) VALUES (?, ?)');
        for (const signal of signals) insert.run(signal.at, JSON.stringify(signal));
        this.db.exec(`DELETE FROM diary WHERE at NOT IN (SELECT at FROM diary ORDER BY at DESC LIMIT ${MAX_DIARY_ROWS})`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async loadDiary(): Promise<ObserverSignal[]> {
    const rows = this.db.prepare('SELECT signal FROM diary ORDER BY at ASC').all() as Array<{ signal: string }>;
    return rows.map((row) => JSON.parse(row.signal) as ObserverSignal);
  }

  async saveDefinitions(definitions: ChaperonedDefinition[]): Promise<void> {
    await this.chain(() => {
      this.db.exec('BEGIN');
      try {
        const upsert = this.db.prepare(
          'INSERT INTO definitions (word, definition, example) VALUES (?, ?, ?) ON CONFLICT(word) DO UPDATE SET definition = excluded.definition, example = excluded.example'
        );
        for (const definition of definitions) upsert.run(definition.word, definition.definition, definition.example);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async loadDefinitions(): Promise<ChaperonedDefinition[]> {
    const rows = this.db.prepare('SELECT word, definition, example FROM definitions').all() as unknown as Array<ChaperonedDefinition>;
    return rows;
  }

  async saveLearningState(state: Record<string, unknown>): Promise<void> {
    await this.chain(() => {
      this.db.exec('BEGIN');
      try {
        this.db
          .prepare('INSERT INTO learning_state (key, state) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET state = excluded.state')
          .run('state', JSON.stringify(state));
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async loadLearningState(): Promise<Record<string, unknown> | null> {
    const row = this.db.prepare('SELECT state FROM learning_state WHERE key = ?').get('state') as { state: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.state) as Record<string, unknown>);
  }

  async saveEpisodicMemory(snapshot: EpisodicMemorySnapshot): Promise<void> {
    await this.chain(() => {
      this.db.exec('BEGIN');
      try {
        this.db
          .prepare('INSERT INTO episodic_memory (key, snapshot) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET snapshot = excluded.snapshot')
          .run('state', JSON.stringify(snapshot));
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async loadEpisodicMemory(): Promise<EpisodicMemorySnapshot | null> {
    const row = this.db.prepare('SELECT snapshot FROM episodic_memory WHERE key = ?').get('state') as { snapshot: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.snapshot) as EpisodicMemorySnapshot);
  }

  /** Wait for all queued writes (the server's shutdown drain). */
  async drain(): Promise<void> {
    await this.writeChain;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Closing an already-closed handle is a no-op.
    }
  }
}
