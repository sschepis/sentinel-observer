/**
 * The definition backfill is a long run over thousands of words. This suite
 * pins the durability contract: every batch reaches storage as it arrives,
 * so a tab that closes mid-run never re-asks the model for work it already
 * paid for.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useLearningEngine } from './useLearningEngine';
import { MemoryPersistenceStore } from '../persistence/store';
import type { TeacherAgent } from '../teacher/TeacherAgent';
import type { DeckWord } from '../teacher/deck';

const SETTINGS_KEY = 'sentinel-chaperone-settings';

interface FakeWord {
  word: DeckWord;
  traceId: string | null;
}

/** A teacher stand-in that owns a deck of definition-less words. */
function fakeTeacher(words: string[]): TeacherAgent & { applied: string[] } {
  const states: FakeWord[] = words.map((word) => ({
    word: { word, definition: '', example: '' },
    traceId: null
  }));
  const applied: string[] = [];
  return {
    applied,
    setTuning: () => {},
    listWords: () => states.map((state) => ({ ...state, strength: null, status: 'new' })),
    applyDefinitions: (definitions: ReadonlyArray<{ word: string; definition: string; example: string }>) => {
      for (const definition of definitions) {
        const state = states.find((s) => s.word.word === definition.word);
        if (state === undefined || state.word.definition.length > 0) continue;
        state.word.definition = definition.definition;
        state.word.example = definition.example;
        applied.push(definition.word);
      }
      return definitions.length;
    }
  } as unknown as TeacherAgent & { applied: string[] };
}

/** An endpoint that answers each definition request from the words asked. */
function definitionEndpoint(onCall: (words: string[]) => void) {
  return jest.fn(async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as {
      response_format?: { json_schema?: { schema?: { properties?: { definitions?: { required?: string[] } } } } };
    };
    const asked = body.response_format?.json_schema?.schema?.properties?.definitions?.required ?? [];
    onCall(asked);
    const definitions = Object.fromEntries(
      asked.map((word) => [
        word,
        { definition: `the meaning of the word ${word}`, example: `This is a sentence about ${word}.` }
      ])
    );
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ definitions }) } }] })
    };
  });
}

describe('definition backfill durability', () => {
  beforeEach(() => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ endpoint: 'https://llm.test/v1/chat/completions', apiKey: 'k', model: 'test' })
    );
  });

  afterEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  it('writes each batch to storage as it arrives, not only at the end', async () => {
    const store = new MemoryPersistenceStore();
    const words = Array.from({ length: 24 }, (_, i) => `word${i}`);
    const teacher = fakeTeacher(words);

    const saveSizes: number[] = [];
    const saveSpy = jest.spyOn(store, 'saveDefinitions');
    saveSpy.mockImplementation(async (definitions) => {
      saveSizes.push(definitions.length);
      return MemoryPersistenceStore.prototype.saveDefinitions.call(store, definitions);
    });

    global.fetch = definitionEndpoint(() => {}) as unknown as typeof fetch;

    const { result } = renderHook(() => useLearningEngine(teacher, store, 0));

    await act(async () => {
      result.current.runDefinitions();
    });
    await waitFor(() => expect(result.current.definitionProgress?.phase).toBe('done'), { timeout: 10000 });

    // 24 words at 8 per batch = 3 batches, each saved on arrival — plus one
    // confirming save at the end. A single save would mean the whole run was
    // buffered in memory and lost on a tab close.
    expect(saveSizes.filter((size) => size === 8).length).toBe(3);
    expect(saveSizes.length).toBeGreaterThan(3);

    const saved = await store.loadDefinitions();
    expect(saved.length).toBe(words.length);
    expect(saved.every((entry) => entry.definition.length > 0 && entry.example.length > 0)).toBe(true);
    // Applied in-place too, so the run does not re-target the same words.
    expect(teacher.applied.length).toBe(words.length);
  }, 20000);

  it('keeps the definitions already generated when the run is cancelled', async () => {
    const store = new MemoryPersistenceStore();
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
    const teacher = fakeTeacher(words);

    let calls = 0;
    let cancel: (() => void) | null = null;
    const fetchMock = definitionEndpoint(() => {
      calls += 1;
      // Stop the run once some batches have already been answered.
      if (calls === 2) cancel?.();
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useLearningEngine(teacher, store, 0));
    cancel = () => result.current.cancelDefinitions();

    await act(async () => {
      result.current.runDefinitions();
    });
    await waitFor(() => expect(result.current.definitionProgress?.phase).toBe('done'), { timeout: 10000 });

    const saved = await store.loadDefinitions();
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.length).toBeLessThan(words.length);
    // A resumed run would only ask for what is still missing.
    const stillMissing = teacher.listWords().filter((w) => w.word.definition.length === 0);
    expect(stillMissing.length).toBe(words.length - saved.length);
  }, 20000);

  it('does not re-request definitions that are already stored', async () => {
    const store = new MemoryPersistenceStore();
    const words = ['alpha', 'beta', 'gamma'];
    const teacher = fakeTeacher(words);

    // A previous session already answered these.
    const known = words.map((word) => ({ word, definition: `known ${word}`, example: `A ${word}.` }));
    await store.saveDefinitions(known);
    teacher.applyDefinitions(await store.loadDefinitions());

    const asked: string[][] = [];
    global.fetch = definitionEndpoint((batch) => asked.push(batch)) as unknown as typeof fetch;

    const { result } = renderHook(() => useLearningEngine(teacher, store, 1));

    await act(async () => {
      result.current.runDefinitions();
    });

    expect(asked).toEqual([]);
    expect(result.current.definitionProgress).toBeNull();
  });

  it('does not auto-start the backfill after a restore — only the manual trigger runs it', async () => {
    const store = new MemoryPersistenceStore();
    const words = Array.from({ length: 24 }, (_, i) => `word${i}`);
    const teacher = fakeTeacher(words);

    const asked: string[][] = [];
    global.fetch = definitionEndpoint((batch) => asked.push(batch)) as unknown as typeof fetch;

    // restoreEpoch > 0 with a configured endpoint is exactly the condition
    // that used to fire the automatic backfill over every definition-less
    // word on app load.
    const { result } = renderHook(() => useLearningEngine(teacher, store, 1));

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(asked).toEqual([]);
    expect(result.current.definitionProgress).toBeNull();

    // The explicit user action (SettingsView "Fill definitions") still runs.
    await act(async () => {
      result.current.runDefinitions();
    });
    await waitFor(() => expect(result.current.definitionProgress?.phase).toBe('done'), { timeout: 10000 });
    expect(asked.length).toBeGreaterThan(0);
  });
});
