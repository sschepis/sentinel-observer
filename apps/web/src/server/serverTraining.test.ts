/**
 * Phase A gate — the server-side autonomous classroom loop.
 *
 * The loop is THE trainer: it drives teach/review/drill cycles against the
 * server's singular TeacherAgent with server-configured (or null) chaperone
 * settings, emits LearningEvents, and stops cleanly. The browser never runs
 * it.
 *
 * @jest-environment node
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { DECK_100 } from '../teacher/decks/en-100';
import { CONVERSATION_DECK } from '../teacher/conversation';
import { PRIME_SPACE, deckVocabulary } from '../teacher/primeSignature';
import { TrainingLoop, EMPTY_TRAINING_STATS, type TrainingStats } from './trainingLoop';
import { ServerSession } from './ServerSession';
import type { LearningEvent } from '../learning/events';
import type { DeckWord } from '../teacher/deck';

const DECK: readonly DeckWord[] = DECK_100.slice(0, 24);
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_DECK.map((p) => ({ word: p.cue }))], PRIME_SPACE)
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('TrainingLoop (server-side trainer)', () => {
  it('runs autonomous cycles without an LLM endpoint (deterministic steps only) and reports stats + events', async () => {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK);
    teacher.teachConversationDeck(CONVERSATION_DECK.slice(0, 6));

    const events: LearningEvent[] = [];
    const cycles: TrainingStats[] = [];
    const loop = new TrainingLoop(teacher, {
      settings: { endpoint: '', apiKey: '', model: '' },
      cadenceMs: 0,
      wordsPerCycle: 2,
      reviewsPerCycle: 1,
      onEvents: (next) => events.push(...next),
      onCycle: (stats) => cycles.push({ ...stats })
    });

    expect(loop.start()).toBe(true);
    expect(loop.start()).toBe(false); // never double-runs
    await sleep(900);
    loop.stop();
    await sleep(30);

    expect(cycles.length).toBeGreaterThanOrEqual(3);
    const last = cycles[cycles.length - 1];
    expect(last.cycles).toBe(cycles.length);
    expect(last.wordsTaught).toBeGreaterThan(0); // the curriculum grows
    expect(events.some((event) => event.text === 'learning started')).toBe(true);
    expect(events.some((event) => event.text === 'learning stopped')).toBe(true);
    expect(events.some((event) => event.kind === 'word')).toBe(true);

    session.dispose();
  }, 30000);

  it('statistics start empty and stop() leaves the loop reusable', async () => {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK);
    const loop = new TrainingLoop(teacher, { settings: { endpoint: '', apiKey: '', model: '' }, cadenceMs: 5 });
    expect(loop.running).toBe(false);
    expect(loop.statistics()).toEqual(EMPTY_TRAINING_STATS);
    loop.start();
    expect(loop.running).toBe(true);
    loop.stop();
    await sleep(20);
    expect(loop.running).toBe(false);
    loop.start();
    expect(loop.running).toBe(true);
    loop.stop();
    await sleep(20);
    session.dispose();
  }, 30000);
});

describe('ServerSession trains at boot (the one trainer)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('boots with the loop running and reports training stats in state()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-train-'));
    dirs.push(dir);
    const server = new ServerSession({
      dataDir: dir,
      words: 12,
      conversation: false,
      autosaveMs: 60000,
      tickImmediately: false,
      train: true,
      trainCadenceMs: 5
    });
    await server.boot();
    await sleep(1200);
    try {
      const state = server.state();
      expect(state.training).not.toBeNull();
      expect(state.training!.cycles).toBeGreaterThanOrEqual(2);
      expect(state.training!.wordsTaught).toBeGreaterThan(0);
    } finally {
      await server.shutdown();
    }
  }, 60000);

  it('train: false leaves training null (the parity gate contract)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-notrain-'));
    dirs.push(dir);
    const server = new ServerSession({ dataDir: dir, words: 10, tickImmediately: false, train: false });
    await server.boot();
    try {
      expect(server.state().training).toBeNull();
    } finally {
      await server.shutdown();
    }
  }, 60000);
});
