import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ObserverSignal, SerializedTrace } from '@sschepis/sentient-core';
import type { WordState } from '../teacher/TeacherAgent';
import type { EpisodicMemorySnapshot } from '../teacher/episodic';
import type { ChaperonedDefinition, PersistenceKind, PersistenceStore } from '../persistence/store';

/**
 * Disk-backed PersistenceStore for the observer server.
 *
 * One JSON file per record kind under a data directory. Every write is
 * atomic (temp file + rename) so a crash mid-save never leaves a torn
 * record, and a failed write never blocks the observer loop (the same
 * failure contract as the in-browser stores). Writes are chained so two
 * overlapping saves cannot interleave file bodies.
 */

const FILES = {
  wordStates: 'word-states.json',
  traces: 'traces.json',
  diary: 'diary.json',
  definitions: 'definitions.json',
  learningState: 'learning-state.json',
  episodicMemory: 'episodic-memory.json'
} as const;

const MAX_DIARY_ROWS = 500;

export class FilePersistenceStore implements PersistenceStore {
  readonly kind: PersistenceKind = 'memory';
  private readonly dataDir: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
  }

  /** The directory this store writes (for diagnostics and the snapshot export). */
  path(): string {
    return this.dataDir;
  }

  private atomicWrite(name: string, value: unknown): Promise<void> {
    const run = this.writeChain.then(() => {
      const target = join(this.dataDir, name);
      const tmp = `${target}.tmp`;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(tmp, JSON.stringify(value), 'utf8');
      renameSync(tmp, target);
    });
    this.writeChain = run.catch(() => {});
    return run;
  }

  private readJson<T>(name: string): T | null {
    try {
      const raw = readFileSync(join(this.dataDir, name), 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async saveWordStates(states: WordState[]): Promise<void> {
    await this.atomicWrite(FILES.wordStates, states);
  }

  async loadWordStates(): Promise<WordState[] | null> {
    return this.readJson<WordState[]>(FILES.wordStates);
  }

  async saveTraces(traces: SerializedTrace[]): Promise<void> {
    await this.atomicWrite(FILES.traces, traces);
  }

  async loadTraces(): Promise<SerializedTrace[]> {
    return this.readJson<SerializedTrace[]>(FILES.traces) ?? [];
  }

  async appendDiary(signals: ObserverSignal[]): Promise<void> {
    const current = this.readJson<ObserverSignal[]>(FILES.diary) ?? [];
    const merged = [...current, ...signals].slice(-MAX_DIARY_ROWS);
    await this.atomicWrite(FILES.diary, merged);
  }

  async loadDiary(): Promise<ObserverSignal[]> {
    return this.readJson<ObserverSignal[]>(FILES.diary) ?? [];
  }

  async saveDefinitions(definitions: ChaperonedDefinition[]): Promise<void> {
    const byWord = new Map<string, ChaperonedDefinition>();
    for (const definition of this.readJson<ChaperonedDefinition[]>(FILES.definitions) ?? []) {
      byWord.set(definition.word, definition);
    }
    for (const definition of definitions) byWord.set(definition.word, definition);
    await this.atomicWrite(FILES.definitions, [...byWord.values()]);
  }

  async loadDefinitions(): Promise<ChaperonedDefinition[]> {
    return this.readJson<ChaperonedDefinition[]>(FILES.definitions) ?? [];
  }

  async saveLearningState(state: Record<string, unknown>): Promise<void> {
    await this.atomicWrite(FILES.learningState, state);
  }

  async loadLearningState(): Promise<Record<string, unknown> | null> {
    return this.readJson<Record<string, unknown>>(FILES.learningState);
  }

  async saveEpisodicMemory(snapshot: EpisodicMemorySnapshot): Promise<void> {
    await this.atomicWrite(FILES.episodicMemory, snapshot);
  }

  async loadEpisodicMemory(): Promise<EpisodicMemorySnapshot | null> {
    return this.readJson<EpisodicMemorySnapshot>(FILES.episodicMemory);
  }

  /** Wait for all queued writes (the server's shutdown drain). */
  async drain(): Promise<void> {
    await this.writeChain;
  }

  /** Remove every record (a factory reset — the server's reset command). */
  reset(): void {
    for (const name of Object.values(FILES)) {
      const target = join(this.dataDir, name);
      try {
        rmSync(target);
        rmSync(`${target}.tmp`);
      } catch {
        // Missing files are already the reset state.
      }
    }
  }
}
