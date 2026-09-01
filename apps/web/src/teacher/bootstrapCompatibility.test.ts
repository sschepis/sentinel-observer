/**
 * @jest-environment node
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { MemoryPersistenceStore } from '../persistence/store';
import { DECK_100 } from './decks/en-100';
import { PRIME_SPACE } from './primeSignature';
import { semanticVocabulary } from './semanticSignature';
import { TeacherAgent } from './TeacherAgent';
import { BOOTSTRAP_VERSION, BOOTSTRAP_VOCABULARY_SCHEME, type BootstrapRecord } from './bootstrap';
import { assertImportable, importRecord } from './bootstrapLoader';

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: semanticVocabulary(DECK_100, PRIME_SPACE)
};

const sessions: ObserverSession[] = [];

async function teacher(): Promise<TeacherAgent> {
  const session = new ObserverSession(OPTIONS, 100);
  sessions.push(session);
  await session.initialize();
  return new TeacherAgent(session, DECK_100, new MemoryPersistenceStore());
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

describe('bootstrap vocabulary compatibility', () => {
  it('exports and restores semantic-v2 records', async () => {
    const source = await teacher();
    source.teach('apple');
    const record = source.exportBootstrap('en-20000');

    expect(record.version).toBe(BOOTSTRAP_VERSION);
    expect(record.vocabularyScheme).toBe(BOOTSTRAP_VOCABULARY_SCHEME);

    const target = await teacher();
    expect(target.importBootstrap(record).restored).toBe(1);
  });

  it('H5: the app can always re-import what it exports (deck round-trip)', async () => {
    const source = await teacher();
    source.teach('apple');
    // The DEFAULT export (no deck argument) must already be importable —
    // a record stamped with an unrecognized deck is rejected by the loader.
    const record = source.exportBootstrap();
    expect(record.deck).toBe('en-20000');
    expect(assertImportable(record)).toBeUndefined();

    const target = await teacher();
    expect(target.importBootstrap(record).restored).toBe(1);

    // And the loader still refuses foreign decks loudly.
    const foreign = { ...record, deck: 'en-1000' };
    expect(() => assertImportable(foreign)).toThrow(/trained on deck/);
  });

  it('rejects legacy records through direct and loader imports', async () => {
    const source = await teacher();
    source.teach('apple');
    const current = source.exportBootstrap('en-20000');
    const legacy = { ...current, version: 1, vocabularyScheme: undefined } as unknown as BootstrapRecord;
    const target = await teacher();

    expect(() => target.importBootstrap(legacy)).toThrow(/incompatible/);
    await expect(importRecord(target, legacy)).rejects.toThrow(/regenerate/);
  });

  it('ADOPTS persisted traces when the learning state (scheme marker) is missing — H6', async () => {
    // A pre-v4 IndexedDB (or a failed saveLearningState alongside a
    // successful saveTraces) has traces but no learningState. That is NOT a
    // mismatched basis: the traces were written by this app under this
    // scheme, and declaring them all stale used to wipe the entire record on
    // the next persist. Adoption is gated per-trace by the encoding check
    // (isStaleEncoding), which still rejects true pre-focused-era traces.
    class LegacyStore extends MemoryPersistenceStore {
      override async loadLearningState(): Promise<Record<string, unknown> | null> {
        return null;
      }
    }
    const store = new LegacyStore();
    const sourceSession = new ObserverSession(OPTIONS, 100);
    sessions.push(sourceSession);
    await sourceSession.initialize();
    const source = new TeacherAgent(sourceSession, DECK_100, store);
    source.teach('apple');
    await source.persistAll();

    const targetSession = new ObserverSession(OPTIONS, 100);
    sessions.push(targetSession);
    await targetSession.initialize();
    const target = new TeacherAgent(targetSession, DECK_100, store);
    const result = await target.restoreFromPersistence();

    expect(result).toEqual({ restored: 1, stale: 0 });
    expect(target.listWords().find((state) => state.word.word === 'apple')?.traceId).not.toBeNull();
  });
});
