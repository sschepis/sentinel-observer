/**
 * @jest-environment node
 *
 * Recall competency is a ratio: produced cues over taught exchanges. The
 * denominator is rebuilt from the trace metadata on restore, so if the
 * numerator is not persisted the meter reads 0% after every reload and
 * creative mode can never unlock.
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

const PAIRS = [
  { cue: 'hello', response: 'Hello, it is good to see you.' },
  { cue: 'how are you', response: 'I am well, thank you for asking.' }
];

async function teacherOn(store: MemoryPersistenceStore): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  return { session, teacher: new TeacherAgent(session, DECK, store) };
}

/** Teach the pairs and drill them, exactly as the classroom loop does. */
function teachAndDrill(teacher: TeacherAgent): void {
  for (const pair of PAIRS) {
    teacher.teachResponse(pair);
    teacher.respond(pair.cue);
  }
}

describe('recall competency survives a reload', () => {
  it('does not collapse to 0% when the produced cues come back', async () => {
    const store = new MemoryPersistenceStore();
    const { session, teacher } = await teacherOn(store);

    teachAndDrill(teacher);
    const before = teacher.conversationReport();
    expect(before.taught).toBe(PAIRS.length);
    expect(before.recalled).toBeGreaterThan(0);
    expect(before.competency).toBeGreaterThan(0);

    await teacher.flush();
    session.dispose();

    const { session: freshSession, teacher: fresh } = await teacherOn(store);
    await fresh.restoreFromPersistence();
    const after = fresh.conversationReport();

    expect(after.taught).toBe(before.taught);
    expect(after.recalled).toBe(before.recalled);
    expect(after.competency).toBe(before.competency);
    freshSession.dispose();
  });

  it('carries competency through a bootstrap record', async () => {
    const store = new MemoryPersistenceStore();
    const { session, teacher } = await teacherOn(store);

    teachAndDrill(teacher);
    const before = teacher.conversationReport();
    const record = teacher.exportBootstrap('en-20000');
    expect(record.learningState?.producedCues?.length).toBe(before.recalled);
    session.dispose();

    const { session: freshSession, teacher: fresh } = await teacherOn(new MemoryPersistenceStore());
    fresh.importBootstrap(record);
    const after = fresh.conversationReport();

    expect(after.taught).toBe(before.taught);
    expect(after.recalled).toBe(before.recalled);
    expect(after.competency).toBe(before.competency);
    freshSession.dispose();
  });

  it('never reports more produced cues than taught exchanges', async () => {
    const store = new MemoryPersistenceStore();
    const { session, teacher } = await teacherOn(store);
    teachAndDrill(teacher);
    await teacher.flush();
    session.dispose();

    // A record whose conversation traces are gone must not keep a numerator
    // that outruns the denominator.
    await store.saveTraces([]);

    const { session: freshSession, teacher: fresh } = await teacherOn(store);
    await fresh.restoreFromPersistence();
    const after = fresh.conversationReport();

    expect(after.taught).toBe(0);
    expect(after.recalled).toBe(0);
    expect(after.competency).toBe(0);
    expect(after.competency).toBeLessThanOrEqual(1);
    freshSession.dispose();
  });
});

describe('records written before produced cues were persisted', () => {
  it('recovers the numerator from the recall evidence on the traces', async () => {
    const store = new MemoryPersistenceStore();
    const { session, teacher } = await teacherOn(store);
    teachAndDrill(teacher);
    const before = teacher.conversationReport();
    await teacher.flush();
    session.dispose();

    // Age the record: strip the field the old writer never emitted.
    const legacy = { ...(await store.loadLearningState()) };
    delete legacy.producedCues;
    delete legacy.cueConfidence;
    await store.saveLearningState(legacy);

    const { session: freshSession, teacher: fresh } = await teacherOn(store);
    await fresh.restoreFromPersistence();
    const after = fresh.conversationReport();

    expect(after.taught).toBe(before.taught);
    expect(after.recalled).toBe(before.recalled);
    expect(after.competency).toBeGreaterThan(0);
    freshSession.dispose();
  });

  it('does not credit exchanges the observer was never asked to produce', async () => {
    const store = new MemoryPersistenceStore();
    const { session, teacher } = await teacherOn(store);

    // Taught, but never drilled — no recall ever happened.
    for (const pair of PAIRS) teacher.teachResponse(pair);
    await teacher.flush();
    session.dispose();

    const legacy = { ...(await store.loadLearningState()) };
    delete legacy.producedCues;
    await store.saveLearningState(legacy);

    const { session: freshSession, teacher: fresh } = await teacherOn(store);
    await fresh.restoreFromPersistence();
    const after = fresh.conversationReport();

    expect(after.taught).toBe(PAIRS.length);
    expect(after.recalled).toBe(0);
    expect(after.competency).toBe(0);
    freshSession.dispose();
  });

  it('honours an explicitly empty produced list instead of recovering', async () => {
    const store = new MemoryPersistenceStore();
    const { session, teacher } = await teacherOn(store);
    teachAndDrill(teacher);
    await teacher.flush();
    session.dispose();

    const written = { ...(await store.loadLearningState()), producedCues: [] };
    await store.saveLearningState(written);

    const { session: freshSession, teacher: fresh } = await teacherOn(store);
    await fresh.restoreFromPersistence();

    expect(fresh.conversationReport().recalled).toBe(0);
    freshSession.dispose();
  });
});
