/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
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

async function setupTeacher(): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, DECK);
  for (const entry of DECK) teacher.teach(entry.word);
  return { session, teacher };
}

/** Two correct recognition grades — the boundary that earns a know-belief. */
function earnKnowBelief(teacher: TeacherAgent, word: string): void {
  for (let i = 0; i < 2; i += 1) {
    const q = teacher.ask(word, 'recognition');
    teacher.grade(word, q);
  }
}

describe('belief traces (second-order self-uptake)', () => {
  it('a word that survives its own loop earns a stored know-belief, exactly once', async () => {
    const { session, teacher } = await setupTeacher();
    earnKnowBelief(teacher, 'water');
    const know = teacher.beliefsOf('water').filter((b) => b.beliefKind === 'know');
    expect(know).toHaveLength(1);
    expect(know[0].content).toBe('I know water well.');
    expect(know[0].contradicts).toBe(false);
    // Dedup: further correct grades never duplicate the know-belief.
    earnKnowBelief(teacher, 'water');
    expect(teacher.beliefsOf('water').filter((b) => b.beliefKind === 'know')).toHaveLength(1);
    session.dispose();
  });

  it('"do I know X" answers from the stored belief — the operator input is the observer’s own state', async () => {
    const { session, teacher } = await setupTeacher();
    const before = teacher.chatAnswer('do I know water');
    expect(before.mode).not.toBe('operator'); // no belief yet — no claimed self-knowledge
    earnKnowBelief(teacher, 'water');
    const answer = teacher.chatAnswer('do I know water');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') {
      expect(answer.response).toContain('I know water well.');
    }
    session.dispose();
  });

  it('a failed grade CONTRADICTS the stored belief: a revising belief is stored and the original demoted', async () => {
    const { session, teacher } = await setupTeacher();
    earnKnowBelief(teacher, 'water');
    const positive = teacher.beliefsOf('water').find((b) => b.beliefKind === 'know');
    expect(positive).toBeDefined();
    const strengthBefore = positive!.strength;

    const wrong = teacher.grade('water', {
      word: { word: 'water', definition: 'a clear liquid that falls as rain', example: '' },
      cue: 'zzz unrelated cue',
      answer: '',
      recall: null
    });
    expect(wrong.verdict).toBe('wrong');

    const beliefs = teacher.beliefsOf('water');
    const revise = beliefs.find((b) => b.beliefKind === 'revise');
    expect(revise).toBeDefined();
    expect(revise!.contradicts).toBe(true);
    expect(revise!.content).toContain('I thought I knew water');
    // The ORIGINAL belief trace was demoted by the contradiction.
    const demoted = beliefs.find((b) => b.beliefKind === 'know');
    expect(demoted!.strength).toBeLessThan(strengthBefore);

    // And "do I know water" now answers with the contradiction.
    const answer = teacher.chatAnswer('do I know water');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') {
      expect(answer.response).toContain('I am not sure I still do');
    }
    session.dispose();
  });

  it('repeatedly failing the same utterance becomes a memory about its own ignorance', async () => {
    const { session, teacher } = await setupTeacher();
    teacher.chatAnswer('zzz xyz qqq'); // first ask — gap recorded
    expect(teacher.beliefsOf('zzz xyz qqq')).toHaveLength(0);
    teacher.chatAnswer('zzz xyz qqq'); // second miss — the belief fires
    const beliefs = teacher.beliefsOf('zzz xyz qqq');
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0].beliefKind).toBe('fail');
    expect(beliefs[0].content).toContain('I keep failing');
    session.dispose();
  });

  it('beliefs round-trip persistence: export → import rebuilds the library without duplicates', async () => {
    const { session, teacher } = await setupTeacher();
    earnKnowBelief(teacher, 'water');
    const record = teacher.exportBootstrap('test');
    session.dispose();

    const fresh = new ObserverSession(OPTIONS, 100);
    await fresh.initialize();
    const freshTeacher = new TeacherAgent(fresh, DECK);
    const result = freshTeacher.importBootstrap(record);
    expect(result.restored).toBeGreaterThan(0);
    expect(freshTeacher.beliefsOf('water')).toHaveLength(1);
    const answer = freshTeacher.chatAnswer('do I know water');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator') {
      expect(answer.response).toContain('I know water well.');
    }
    fresh.dispose();
  });

  it('self-knowledge is never claimed without a stored belief — the operator falls through', async () => {
    const { session, teacher } = await setupTeacher();
    const answer = teacher.chatAnswer('do I remember xylophone');
    expect(answer.mode).not.toBe('operator');
    session.dispose();
  });
});