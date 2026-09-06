/**
 * SQLite store gate — the same dataset through both stores restores
 * identically (the parity contract), and a JSON dataset migrates into
 * SQLite in place (the continuity contract).
 *
 * @jest-environment node
 */
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { DECK_100 } from '../teacher/decks/en-100';
import { CONVERSATION_DECK } from '../teacher/conversation';
import { PRIME_SPACE, deckVocabulary } from '../teacher/primeSignature';
import { FilePersistenceStore } from './FilePersistenceStore';
import { SqlitePersistenceStore } from './SqlitePersistenceStore';
import type { DeckWord } from '../teacher/deck';

const DECK: readonly DeckWord[] = DECK_100.slice(0, 24);
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_DECK.map((p) => ({ word: p.cue }))], PRIME_SPACE)
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Copy a store's full dataset into another store through the interface —
 *  the parity gate compares THE SAME dataset through both stores, so random
 *  trace ids and wall-clock timestamps cannot leak into the comparison. */
async function copyDataset(from: FilePersistenceStore | SqlitePersistenceStore, to: FilePersistenceStore | SqlitePersistenceStore): Promise<void> {
  const traces = await from.loadTraces();
  if (traces.length > 0) await to.saveTraces(traces);
  const states = await from.loadWordStates();
  if (states !== null) await to.saveWordStates(states);
  const learning = await from.loadLearningState();
  if (learning !== null) await to.saveLearningState(learning);
  const definitions = await from.loadDefinitions();
  if (definitions.length > 0) await to.saveDefinitions(definitions);
  const episodic = await from.loadEpisodicMemory();
  if (episodic !== null) await to.saveEpisodicMemory(episodic);
  const diary = await from.loadDiary();
  if (diary.length > 0) await to.appendDiary(diary);
}

/** Teach an identical, deterministic curriculum into a fresh teacher. */
async function train(store: FilePersistenceStore | SqlitePersistenceStore): Promise<void> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, DECK, store, 1, 42);
  for (const entry of DECK) teacher.teach(entry.word);
  teacher.teachConversationDeck(CONVERSATION_DECK.slice(0, 8));
  for (const pair of CONVERSATION_DECK.slice(0, 8)) teacher.respond(pair.cue);
  teacher.noteBehaviorOutcome('ask', true);
  await teacher.persistAll();
  session.dispose();
}

/** Restore under a FROZEN clock: restoreFromPersistence applies retention
 *  decay with Date.now(), so two restores a millisecond apart would differ
 *  in strengths even from identical stored data. */
async function restoreFrozen(store: FilePersistenceStore | SqlitePersistenceStore): Promise<RestoredShape> {
  const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-06T00:00:00Z').getTime());
  try {
    return await restore(store);
  } finally {
    nowSpy.mockRestore();
  }
}

interface RestoredShape {
  restored: number;
  traces: unknown[];
  wordStates: unknown[];
  learningState: unknown;
}

async function restore(store: FilePersistenceStore | SqlitePersistenceStore): Promise<RestoredShape> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, DECK, store, 1, 42);
  const restored = await teacher.restoreFromPersistence();
  const definitions = await store.loadDefinitions();
  if (definitions.length > 0) teacher.applyDefinitions(definitions);
  const record = teacher.exportBootstrap('en-20000');
  const learning = await store.loadLearningState();
  session.dispose();
  return {
    restored: restored.restored,
    traces: record.traces as unknown[],
    wordStates: (record.wordStates ?? []) as unknown[],
    learningState: learning
  };
}

/** Report the first structural difference (path + values) or null. */
function firstDiff(a: unknown, b: unknown, path = 'root'): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${path}: type ${typeof a} vs ${typeof b}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i += 1) {
      const diff = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (diff !== null) return diff;
    }
    return null;
  }
  if (typeof a === 'object' && a !== null && b !== null) {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return `${path}: keys ${aKeys.join(',')} vs ${bKeys.join(',')}`;
    for (const key of aKeys) {
      const diff = firstDiff((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
      if (diff !== null) return diff;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

describe('SqlitePersistenceStore parity with the JSON store', () => {
  it('the identical curriculum restores identically from both stores', async () => {
    const jsonDir = mkdtempSync(join(tmpdir(), 'sentinel-store-json-'));
    const sqlDir = mkdtempSync(join(tmpdir(), 'sentinel-store-sqlite-'));
    dirs.push(jsonDir, sqlDir);

    const jsonStore = new FilePersistenceStore(jsonDir);
    const sqliteStore = new SqlitePersistenceStore(sqlDir);

    await train(jsonStore);
    await copyDataset(jsonStore, sqliteStore);

    // Storage parity: the same dataset reads back identically from both.
    expect(firstDiff(await sqliteStore.loadTraces(), await jsonStore.loadTraces())).toBeNull();
    expect(firstDiff(await sqliteStore.loadWordStates(), await jsonStore.loadWordStates())).toBeNull();
    expect(firstDiff(await sqliteStore.loadLearningState(), await jsonStore.loadLearningState())).toBeNull();

    // Restore parity: the same dataset restores the same teacher.
    expect(firstDiff(await restoreFrozen(sqliteStore), await restoreFrozen(jsonStore))).toBeNull();
    sqliteStore.close();
  }, 60000);

  it('migrates a legacy JSON dataset into SQLite in place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-store-migrate-'));
    dirs.push(dir);

    const jsonStore = new FilePersistenceStore(dir);
    await train(jsonStore);

    // First SQLite boot over the same directory: the constructor imports
    // the JSON files (which stay untouched as a backup).
    const sqliteStore = new SqlitePersistenceStore(dir);
    const traces = await sqliteStore.loadTraces();
    expect(traces.length).toBeGreaterThan(0);
    const states = await sqliteStore.loadWordStates();
    expect(states).not.toBeNull();
    expect(states!.length).toBe(DECK.length);

    expect(firstDiff(await sqliteStore.loadTraces(), await jsonStore.loadTraces())).toBeNull();
    expect(firstDiff(await restoreFrozen(sqliteStore), await restoreFrozen(jsonStore))).toBeNull();
    sqliteStore.close();
  }, 60000);
});
