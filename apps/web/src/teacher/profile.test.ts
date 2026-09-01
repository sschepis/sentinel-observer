/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { ALL_CONVERSATION_PAIRS, CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';

const N: DeckWord[] = [
  { word: 'water', definition: 'a clear liquid', example: '' },
  { word: 'bird', definition: 'an animal', example: '' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...N, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

describe('member build profiling', () => {
  it('times the member build', async () => {
    const t0 = Date.now();
    const session = new ObserverSession(OPTIONS, 100);
    const tInit = Date.now();
    await session.initialize();
    console.log(`initialize: ${Date.now() - tInit}ms`);
    const teacher = new TeacherAgent(session, N);
    for (const e of N) teacher.teach(e.word);
    const tTeach = Date.now();
    teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS);
    console.log(`teachConversationDeck(${ALL_CONVERSATION_PAIRS.length}): ${Date.now() - tTeach}ms`);
    const tRespond = Date.now();
    for (const p of ALL_CONVERSATION_PAIRS) teacher.respond(p.cue);
    console.log(`respond(${ALL_CONVERSATION_PAIRS.length}): ${Date.now() - tRespond}ms`);
    console.log(`total: ${Date.now() - t0}ms`);
    session.dispose();
    expect(1).toBe(1);
  });
});