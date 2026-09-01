/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { ALL_CONVERSATION_PAIRS, CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';

const DECK: readonly DeckWord[] = [
  { word: 'water', definition: 'a clear liquid that falls as rain', example: 'Water is wet.' },
  { word: 'weather', definition: 'the state of the air outside', example: 'The weather is sunny.' },
  { word: 'game', definition: 'an activity with rules', example: 'Chess is a game.' },
  { word: 'bird', definition: 'an animal with wings', example: 'A bird can fly.' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

async function unlockedTeacher(): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, DECK);
  for (const entry of DECK) teacher.teach(entry.word);
  teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS);
  for (const pair of ALL_CONVERSATION_PAIRS) teacher.respond(pair.cue);
  return { session, teacher };
}

describe('the evasion rule + curiosity feed + deviation meter', () => {
  it('definition questions about never-heard words route to ASK, not creative', async () => {
    const { session, teacher } = await unlockedTeacher();
    const answer = teacher.chatAnswer('what is zzz');
    expect(answer.mode).toBe('ask');
    if (answer.mode === 'ask') {
      expect(answer.response).toContain('zzz'); // names the word it does not know
    }
    session.dispose();
  });

  it('relational questions containing never-heard words route to ASK', async () => {
    const { session, teacher } = await unlockedTeacher();
    const answer = teacher.chatAnswer('is zzz a game');
    expect(answer.mode).toBe('ask');
    session.dispose();
  });

  it('creative still composes about KNOWN material (no unknown words, no question form)', async () => {
    const { session, teacher } = await unlockedTeacher();
    const answer = teacher.chatAnswer('what do you think about the weather');
    expect(answer.mode).toBe('creative');
    session.dispose();
  });

  it('utterances of pure unknowns route to ASK and still feed the curiosity drive', async () => {
    const { session, teacher } = await unlockedTeacher();
    expect(teacher.listGaps()).toHaveLength(0);
    const answer = teacher.chatAnswer('zzz xyz qqq'); // nothing known to compose about
    expect(answer.mode).toBe('ask');
    expect(teacher.listGaps()).toContain('zzz xyz qqq');
    session.dispose();
  });

  it('unsupported relational questions about KNOWN words route to honest unknown, not creative', async () => {
    const { session, teacher } = await unlockedTeacher();
    const answer = teacher.chatAnswer('is water a game');
    expect(answer.mode).toBe('ask');
    if (answer.mode === 'ask') {
      expect(answer.response).toContain('whether water is a game');
    }
    session.dispose();
  });

  it('ambiguous meaning prompts route to ASK, not creative', async () => {
    const { session, teacher } = await unlockedTeacher();
    const answer = teacher.chatAnswer('what word means something used outside');
    expect(answer.mode).toBe('ask');
    if (answer.mode === 'ask') expect(answer.response).toContain('which word matches');
    session.dispose();
  });

  it('natural inflections still retrieve a learned meaning before ASK', async () => {
    const { session, teacher } = await unlockedTeacher();
    const answer = teacher.chatAnswer('what word means a flying animal covered in feathers');
    expect(answer.mode).toBe('operator');
    if (answer.mode === 'operator' && answer.operator?.kind === 'semantic-recall') {
      expect(answer.operator.word).toBe('bird');
    }
    session.dispose();
  });

  it('H4: OPEN factual forms about KNOWN words route to ASK, never creative (evasion gap)', async () => {
    const { session, teacher } = await unlockedTeacher();
    // No causes/requires/capable-of/used-for/property/location knowledge for
    // 'water' exists anywhere — the open forms must behave exactly like
    // their closed siblings ("does water cause floods" → ask), not compose.
    const probes = [
      'what does water cause',
      'what does water need',
      'what does water do',
      'what is water like',
      'what is water for',
      'where is water'
    ];
    for (const probe of probes) {
      const answer = teacher.chatAnswer(probe);
      expect(answer.mode).toBe('ask');
    }
    session.dispose();
  });

  it('H4: open factual forms still answer via the operator when the edge exists', async () => {
    const { session, teacher } = await unlockedTeacher();
    // Teach a causes edge directly through the relation API the teacher uses.
    teacher.applyRelations([
      { subject: 'water', predicate: 'causes', object: 'flood', source: 'test', origin: 'authored' },
      { subject: 'bird', predicate: 'capable-of', object: 'fly', source: 'test', origin: 'authored' }
    ]);
    const causes = teacher.chatAnswer('what does water cause');
    expect(causes.mode).toBe('operator');
    if (causes.mode === 'operator') {
      expect(causes.response).toContain('flood');
    }
    const does = teacher.chatAnswer('what does a bird do');
    expect(does.mode).toBe('operator');
    if (does.mode === 'operator') {
      expect(does.response).toContain('fly');
    }
    session.dispose();
  });

  it('the deviation meter counts every answer by its layer', async () => {
    const { session, teacher } = await unlockedTeacher();
    teacher.chatAnswer('hello'); // memorized OR creative (recall is marginal in tiny fields)
    teacher.chatAnswer('what is water'); // operator
    teacher.chatAnswer('what is zzz'); // ask (evasion rule)
    teacher.chatAnswer('what do you think about the weather'); // creative
    const counts = teacher.answerModeCounts();
    const total = (counts.memorized ?? 0) + (counts.operator ?? 0) + (counts.creative ?? 0) + (counts.ask ?? 0) + (counts.decline ?? 0);
    expect(total).toBe(4); // every answer lands in exactly one layer
    expect(counts.operator ?? 0).toBeGreaterThanOrEqual(1);
    expect(counts.ask ?? 0).toBeGreaterThanOrEqual(1);
    expect(counts.creative ?? 0).toBeGreaterThanOrEqual(1);
    session.dispose();
  });
});