/**
 * Phase B gate — server record I/O, bootstrap load, train control, and the
 * definitions runner. All of it operates on the server's SINGULAR record;
 * none of it exists in the browser anymore.
 *
 * @jest-environment node
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { DECK_100 } from '../teacher/decks/en-100';
import { CONVERSATION_DECK } from '../teacher/conversation';
import { PRIME_SPACE, deckVocabulary } from '../teacher/primeSignature';
import { ServerSession } from './ServerSession';
import { DefinitionsRunner } from './definitionsRunner';
import { MemoryPersistenceStore } from '../persistence/store';
import type { DeckWord } from '../teacher/deck';

const DECK: readonly DeckWord[] = DECK_100.slice(0, 20);
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_DECK.map((p) => ({ word: p.cue }))], PRIME_SPACE)
};

describe('server record I/O (the singular dataset)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function bootedServer(words: number): Promise<{ server: ServerSession; dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-record-'));
    dirs.push(dir);
    const server = new ServerSession({ dataDir: dir, words, conversation: false, tickImmediately: false, train: false });
    await server.boot();
    return { server, dir };
  }

  it('export → import round-trips the record into a fresh server (one dataset, moved intact)', async () => {
    const a = await bootedServer(10);
    const record = a.server.exportRecord();
    expect(record.traces.length).toBeGreaterThan(0);
    await a.server.shutdown();

    const b = await bootedServer(0);
    const summary = await b.server.importRecord(record);
    expect(summary.restored).toBeGreaterThan(0);
    expect(b.server.state().learned).toBeGreaterThan(0);
    await b.server.shutdown();
  });

  it('loadDeployedBootstrap imports the configured bootstrap path', async () => {
    const a = await bootedServer(8);
    const record = a.server.exportRecord();
    const bootstrapPath = join(tmpdir(), 'deployed-bootstrap.json');
    writeFileSync(bootstrapPath, JSON.stringify(record));
    await a.server.shutdown();

    const dir = mkdtempSync(join(tmpdir(), 'sentinel-record-'));
    dirs.push(dir);
    const b = new ServerSession({
      dataDir: dir,
      words: 0,
      conversation: false,
      tickImmediately: false,
      train: false,
      bootstrapPath
    });
    await b.boot();
    // Boot priority #2 already imported the bootstrap path (fresh disk, no
    // learning record) — so the deployed record IS the booted state, and
    // the explicit load is the same idempotent import (0 new traces).
    expect(b.state().learned).toBeGreaterThan(0);
    const loaded = await b.loadDeployedBootstrap();
    expect(loaded.ok).toBe(true);
    await b.shutdown();
  });

  it('setTraining stops and restarts the loop, reflected in state()', async () => {
    const { server } = await bootedServer(12);
    try {
      server.setTraining(true);
      await new Promise((resolve) => setTimeout(resolve, 400));
      server.setTraining(false);
      // Let any in-flight cycle finish before capturing the frozen count.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const stopped = server.state().training;
      expect(stopped).not.toBeNull();
      const cycles = stopped!.cycles;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(server.state().training!.cycles).toBe(cycles); // frozen while stopped
      server.setTraining(true);
      expect(server.state().training).not.toBeNull();
    } finally {
      await server.shutdown();
    }
  }, 180000);
});

describe('DefinitionsRunner (server-side backfill)', () => {
  it('completes honestly through the null provider and applies nothing', async () => {
    const words: readonly DeckWord[] = [
      { word: 'apple', definition: '', example: '' },
      { word: 'water', definition: '', example: '' },
      { word: 'hello', definition: 'a greeting', example: 'Hello there!' }
    ];
    const session = new ObserverSession(
      { ...OPTIONS, vocabulary: deckVocabulary(words, PRIME_SPACE) },
      100
    );
    await session.initialize();
    const teacher = new TeacherAgent(session, words);
    const store = new MemoryPersistenceStore();
    const events: string[] = [];
    const runner = new DefinitionsRunner(
      teacher,
      store,
      { endpoint: '', apiKey: '', model: '' },
      (next) => events.push(...next.map((event) => event.text))
    );

    expect(runner.running).toBe(false);
    expect(runner.start()).toBe(true);
    expect(runner.start()).toBe(false); // single run at a time
    const deadline = Date.now() + 20000;
    while (runner.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(runner.running).toBe(false);
    expect(runner.progress()?.phase).toBe('done');
    expect(runner.result()).toContain('generated 0 definitions');
    // The already-defined word was never touched; nothing was fabricated.
    expect(teacher.tryState('hello')?.word.definition).toBe('a greeting');

    session.dispose();
  }, 180000);
});

describe('server introspection snapshot', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reports objectives, drives, curiosity, beliefs, memory, trust, and training', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-introspect-'));
    dirs.push(dir);
    const server = new ServerSession({ dataDir: dir, words: 12, conversation: false, tickImmediately: false, train: false });
    await server.boot();
    try {
      const snapshot = server.introspection() as {
        objectives: { goals: unknown[]; stalled: unknown[]; history: Record<string, unknown> };
        drives: { signals: Record<string, number>; outcomes: Record<string, unknown> };
        curiosity: { question: string | null; gaps: unknown[] };
        beliefs: unknown[];
        memory: Record<string, number | boolean>;
        trust: { lambdas: Record<string, number>; calibration: unknown[] };
        training: null;
      };
      expect(Array.isArray(snapshot.objectives.goals)).toBe(true);
      expect(Array.isArray(snapshot.objectives.stalled)).toBe(true);
      expect(typeof snapshot.objectives.history).toBe('object');
      expect(typeof snapshot.drives.signals.coherence).toBe('number');
      expect(typeof snapshot.drives.signals.curiosity).toBe('number');
      expect(Array.isArray(snapshot.curiosity.gaps)).toBe(true);
      expect(Array.isArray(snapshot.beliefs)).toBe(true);
      expect(snapshot.memory.learned).toBeGreaterThan(0);
      expect(snapshot.memory.total).toBeGreaterThan(0);
      expect(typeof snapshot.trust.lambdas.conversational).toBe('number');
      expect(Array.isArray(snapshot.trust.calibration)).toBe(true);
      expect(snapshot.training).toBeNull(); // train: false
    } finally {
      await server.shutdown();
    }
  }, 60000);
});

describe('teach-reply closes the ask → told → own loop', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('the reply to an unanswered gap is adopted as the taught answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-teachreply-'));
    dirs.push(dir);
    const server = new ServerSession({ dataDir: dir, words: 12, conversation: false, tickImmediately: false, train: false });
    await server.boot();
    try {
      const asked = await server.teacher!.chatAnswer('what is a friend');
      expect(asked.mode).toBe('ask');

      const reply = server.tryTeachReply('A friend is a person you like and trust.');
      expect(reply).not.toBeNull();
      expect(reply!.handled).toBe(true);

      const again = await server.teacher!.chatAnswer('what is a friend');
      expect(again.mode).toBe('memorized');
      expect(again.response).toContain('A friend is a person you like and trust.');
    } finally {
      await server.shutdown();
    }
  }, 60000);

  it('a reply that does not name the asked subject is not adopted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-teachreply-no-'));
    dirs.push(dir);
    const server = new ServerSession({ dataDir: dir, words: 12, conversation: false, tickImmediately: false, train: false });
    await server.boot();
    try {
      await server.teacher!.chatAnswer('what is a friend');
      const reply = server.tryTeachReply('The weather is nice today.');
      expect(reply).toBeNull();
    } finally {
      await server.shutdown();
    }
  }, 60000);

  it('answerGap reports honestly when no teacher model is configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-answergap-'));
    dirs.push(dir);
    const server = new ServerSession({ dataDir: dir, words: 12, conversation: false, tickImmediately: false, train: false });
    await server.boot();
    try {
      const result = await server.answerGap('what is a quasar');
      expect(result.answered).toBe(false);
      expect(result.error).toContain('no teacher model configured');
    } finally {
      await server.shutdown();
    }
  }, 60000);
});
