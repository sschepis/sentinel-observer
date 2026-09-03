/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { MemoryPersistenceStore } from '../persistence/store';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';

const DECK: readonly DeckWord[] = [
  { word: 'water', definition: 'a clear liquid that falls as rain', example: 'Water is wet.' },
  { word: 'bird', definition: 'an animal with wings', example: 'A bird can fly.' }
];
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

async function teacherOn(store: MemoryPersistenceStore): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, DECK, store);
  return { session, teacher };
}

describe('the full learning state survives a reload (the user’s scenario)', () => {
  it('traces, beliefs, goals, weights, history, and the handover all round-trip', async () => {
    const store = new MemoryPersistenceStore();

    // ── Session 1: learn, believe, plan, grade, hand over ──
    const { session, teacher } = await teacherOn(store);
    for (const entry of DECK) teacher.teach(entry.word);

    // Learn: two correct grades → a know-belief.
    for (let i = 0; i < 2; i += 1) {
      const q = teacher.ask('water', 'recognition');
      teacher.grade('water', q);
    }
    expect(teacher.beliefsOf('water').length).toBe(1);

    // Plan: an adopted goal becomes a goal trace.
    const goal = {
      id: 'learn-word:water',
      type: 'learn-word' as const,
      target: 'water',
      priority: 1,
      status: 'active' as const,
      attempts: 0,
      steps: [],
      completeWhen: () => false,
      describe: () => 'learn "water"'
    };
    teacher.adoptGoals([goal]);

    // Grade: a strong creative answer builds the composition weights
    // (Phase 7d fix — the model learns its own voice).
    teacher.creativeGradeFeedback([], 0.8, 'tell me something about yourself', 'I like the weather here.');
    expect(teacher.getCompositionWeights().size).toBeGreaterThan(0);

    // Hand over: agreement climbs λ and the drive gradient learns.
    for (let i = 0; i < 4; i += 1) teacher.noteFadeAgreement('conversational', 0.9);
    for (let i = 0; i < 3; i += 1) teacher.noteBehaviorOutcome('answer', true);
    teacher.noteGoalSuccess('learn-word');
    teacher.fadeReward('tell me something about yourself', 'I like the weather here.', 0.8, []);
    teacher.fadeReward('tell me something about yourself', 'I like the weather here.', 0.8, []);

    // Save the whole record (what a reload relies on).
    await teacher.persistAll();
    session.dispose();

    // ── "Reload": a fresh teacher on the same store, restored ──
    const { session: freshSession, teacher: fresh } = await teacherOn(store);
    await fresh.restoreFromPersistence();

    // The core memory survives.
    expect(fresh.listWords().find((w) => w.word.word === 'water')?.traceId).not.toBeNull();

    // The BELIEF library survives (self-knowledge persisted).
    expect(fresh.beliefsOf('water').length).toBe(1);
    const know = fresh.chatAnswer('do I know water');
    expect(know.mode).toBe('operator');
    if (know.mode === 'operator') expect(know.response).toContain('I know water well');

    // The COMPOSITION WEIGHTS survive (the tiny language model — the
    // handover does not reset to scaffolded).
    expect(fresh.getCompositionWeights().size).toBeGreaterThan(0);

    // L3 (19.2): the weights' decay clocks survive — a reload does NOT
    // restart every n-gram's forgetting clock at zero.
    expect(fresh.getCompositionWeightMeta().size).toBeGreaterThan(0);
    for (const key of fresh.getCompositionWeights().keys()) {
      expect(fresh.getCompositionWeightMeta().get(key)).toBeDefined();
    }

    // The DRIVE GRADIENT survives (the evaluative learning persists).
    // 2 from the correct grades + 3 explicit = 5; weight 0.5 + 5×0.1 = 1.0 →
    // clamped by the ceiling (1.5 falls to... 0.5+0.5=1.0).
    expect(fresh.behaviorOutcomeCounts().answer.wins).toBe(5);
    expect(fresh.driveWeights().answer).toBeCloseTo(1.0);

    // The GOAL HISTORY survives (the ends-move preference persists).
    expect(fresh.goalHistorySnapshot()['learn-word'].completed).toBe(1);

    // The FADE STATE survives (the handover keeps its λ — the teacher does
    // NOT take back over after a reload).
    expect(fresh.fadeLambdas().conversational).toBeGreaterThan(0);
    expect(fresh.teacherDependenceRate()).toBeLessThan(1);

    freshSession.dispose();
  });
});