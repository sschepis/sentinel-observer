/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { STARTER_DECK } from './deck';

/** Poll until a predicate holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 30000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

describe('TeacherAgent autonomous loop', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    session = new ObserverSession({}, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, STARTER_DECK);
  });

  afterEach(() => {
    teacher.stopAutoLoop();
    session.dispose();
  });

  it('teaches, quizzes, and grades the whole deck without any human clicks', async () => {
    teacher.startAutoLoop({ teachPauseMs: 1, askPauseMs: 1, gradePauseMs: 1 });

    await waitFor(() => teacher.getAutoStep()?.phase === 'done');

    const words = teacher.listWords();
    expect(words.every((w) => w.traceId !== null)).toBe(true);
    // Every word is exercised both ways: recognition AND production.
    expect(words.every((w) => w.successes + w.failures >= 2)).toBe(true);
    expect(teacher.nextNewWord()).toBeNull();
    expect(teacher.getAutoStep()?.message).toMatch(/deck is learned/);
  });

  it('asks recognition before production for the same word', async () => {
    const phases: string[] = [];
    teacher.onAutoStep((step) => {
      if (step.phase === 'asking' && step.word === 'apple') {
        phases.push(step.message.includes('meaning of') ? 'recognition' : 'production');
      }
    });
    teacher.startAutoLoop({ teachPauseMs: 1, askPauseMs: 1, gradePauseMs: 1 });
    await waitFor(() => teacher.getAutoStep()?.phase === 'done');

    expect(phases).toEqual(['recognition', 'production']);
  });

  it('reviews a decaying word before teaching anything new', async () => {
    // Seed a learned word with a decayed trace: curiosity must pick it first.
    teacher.teach('music');
    const music = teacher.listWords().find((w) => w.word.word === 'music');
    if (music?.traceId) {
      const trace = session.observer.getMemoryBank().get(music.traceId);
      if (trace) trace.strength = 0.3;
    }

    const firstWords: string[] = [];
    teacher.onAutoStep((step) => {
      if (step.phase === 'asking' && !firstWords.includes(step.word ?? '')) {
        firstWords.push(step.word ?? '');
      }
    });
    teacher.startAutoLoop({ teachPauseMs: 1, askPauseMs: 1, gradePauseMs: 1 });
    await waitFor(() => firstWords.length >= 2);

    expect(firstWords[0]).toBe('music');
    teacher.stopAutoLoop();
  });

  it('stop() halts the loop promptly and a fresh loop can start again', async () => {
    const handle = teacher.startAutoLoop({ teachPauseMs: 60000, askPauseMs: 60000, gradePauseMs: 60000 });
    expect(handle.running).toBe(true);
    await waitFor(() => teacher.getAutoStep()?.phase === 'teaching' && teacher.getAutoStep()?.word !== null);

    handle.stop();
    expect(handle.running).toBe(false);
    expect(teacher.isAutoLoopRunning()).toBe(false);

    const wordsBefore = teacher.listWords().filter((w) => w.traceId !== null).length;
    teacher.startAutoLoop({ teachPauseMs: 1, askPauseMs: 1, gradePauseMs: 1 });
    await waitFor(() => teacher.getAutoStep()?.phase === 'done');
    const wordsAfter = teacher.listWords().filter((w) => w.traceId !== null).length;
    expect(wordsAfter).toBeGreaterThan(wordsBefore);
  });
});
