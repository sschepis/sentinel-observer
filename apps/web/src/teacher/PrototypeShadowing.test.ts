/**
 * Prototype-shadowing regression gate.
 *
 * The deck contains the word "constructor". Records indexed by WORD that are
 * built as plain objects read `record['constructor']` as the inherited
 * Object.prototype.constructor FUNCTION — which made the curriculum throw
 * "function is not iterable" (`new Set(function)`) and then, one layer
 * down, "Non-finite value for clampRange value: NaN" (`function / 3`).
 *
 * This suite is the gate for the whole bug CLASS: every deck word must score
 * through the curriculum, teach, and snapshot without a prototype key ever
 * surfacing as a function.
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import { MemoryPersistenceStore } from '../persistence/store';
import { semanticVocabulary } from '../teacher/semanticSignature';
import { rankCurriculum, neighborhoodEdges } from '../teacher/curriculum';
import { PRIME_SPACE } from '../teacher/primeSignature';

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

describe('prototype-shadowing regression (the "constructor" bug class)', () => {
  it('the semantic vocabulary carries an OWN signature for every deck word — none reads back as a function', () => {
    const vocabulary = semanticVocabulary(ACTIVE_DECK, PRIME_SPACE);
    const functionKeys: string[] = [];
    for (const word of ACTIVE_DECK) {
      const key = word.word.toLowerCase();
      const value = (vocabulary as Record<string, unknown>)[key];
      if (typeof value === 'function') functionKeys.push(key);
      if (typeof value !== 'function') {
        expect(Array.isArray(value)).toBe(true);
        expect((value as number[]).length).toBeGreaterThan(0);
      }
    }
    expect(functionKeys).toEqual([]);
    expect(hasOwn(vocabulary, 'constructor')).toBe(true);
    expect(Array.isArray(vocabulary['constructor'])).toBe(true);
  });

  it('every deck word scores through the curriculum without throwing and every score is finite', async () => {
    const session = new ObserverSession(OBSERVER_OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 1);
    const context = teacher.curriculumContext();
    const items = teacher.listWords().map((state) => ({
      word: state.word.word,
      traceId: state.traceId,
      dueAt: state.dueAt,
      stability: state.stability,
      difficulty: state.difficulty,
      lastIntervalDays: state.lastIntervalDays,
      reviewHistory: state.reviewHistory
    }));
    const scores = rankCurriculum(items, context);
    expect(scores.length).toBe(items.length);
    for (const score of scores) {
      expect(Number.isFinite(score.score)).toBe(true);
      expect(score.score).toBeGreaterThanOrEqual(0);
      expect(score.score).toBeLessThanOrEqual(1);
      for (const part of [score.fsrs, score.overdue, score.waiting, score.sparsity, score.gap, score.drill]) {
        expect(Number.isFinite(part)).toBe(true);
      }
    }
    // 'constructor' scores like a regular word — a real number, not a crash.
    const constructorScore = scores.find((score) => score.word === 'constructor');
    expect(constructorScore).toBeDefined();
    expect(Number.isFinite(constructorScore!.score)).toBe(true);
    session.dispose();
  });

  it("neighborhoodEdges treats 'constructor' as its own word with a real neighborhood", () => {
    const vocabulary = semanticVocabulary(ACTIVE_DECK, PRIME_SPACE);
    const edges = neighborhoodEdges('constructor', vocabulary);
    expect(Number.isFinite(edges)).toBe(true);
    expect(edges).toBeGreaterThanOrEqual(0);
  });

  it("drillFailuresSnapshot never reads back 'constructor' as a function", async () => {
    const session = new ObserverSession(OBSERVER_OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 1);
    const snapshot = teacher.drillFailuresSnapshot();
    expect(typeof snapshot['constructor']).not.toBe('function');
    // The context's drill map reads the same way in the scoring path.
    const withFailure = teacher.curriculumContext(Date.now());
    expect(typeof (withFailure.drillFailures as Record<string, unknown>)['constructor']).not.toBe('function');
    session.dispose();
  });

  it("teach('constructor') stores a trace and the word becomes learned", async () => {
    const session = new ObserverSession(OBSERVER_OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 1);
    const result = teacher.teach('constructor');
    expect(result.traceId).not.toBeNull();
    const entry = teacher.listWords().find((state) => state.word.word === 'constructor');
    expect(entry).toBeDefined();
    expect(entry!.traceId).not.toBeNull();
    session.dispose();
  });
});
