/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent, CREATIVE_REINFORCE_SCORE, CREATIVE_WEAKEN_SCORE, creativeGradeDelta } from './TeacherAgent';
import { CONVERSATION_DECK, ALL_CONVERSATION_PAIRS, CONVERSATION_CUE_TOKENS, composeCreativeResponse, scoreComposition, updateCompositionWeights } from './conversation';
import { Chaperone, parseGradeOutcome, parseConversationPairs, validateConversationPair, type ChaperoneProvider, type ConversationPairResult } from './chaperone';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { BootstrapRecord } from './bootstrap';
import type { DeckWord } from './deck';

const WORD_DECK: readonly DeckWord[] = [
  { word: 'apple', definition: 'a fruit', example: 'I eat an apple.' },
  { word: 'water', definition: 'a clear liquid', example: 'I drink water.' },
  { word: 'hello', definition: 'a greeting', example: 'Hello there!' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary(
    [...WORD_DECK, ...CONVERSATION_CUE_TOKENS.map((word) => ({ word }))],
    PRIME_SPACE
  )
};

describe('TeacherAgent conversation (memorized exchanges)', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, WORD_DECK);
  });

  afterEach(() => {
    session.dispose();
  });

  it('stores a tagged conversation trace when taught', () => {
    const traceId = teacher.teachResponse({ cue: 'how are you', response: 'I am well, thank you.' });
    expect(traceId).not.toBeNull();

    const trace = session.observer.getMemoryBank().get(traceId!);
    expect(trace?.content).toBe('I am well, thank you.');
    expect(trace?.metadata).toMatchObject({ kind: 'conversation', cue: 'how are you' });
  });

  it('re-teaching the same cue is a no-op', () => {
    const first = teacher.teachResponse({ cue: 'hello', response: 'Hi!' });
    const second = teacher.teachResponse({ cue: 'hello', response: 'Hi!' });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(teacher.conversationReport().taught).toBe(1);
  });

  it('responds with the memorized response for a taught cue', () => {
    teacher.teachResponse({ cue: 'how are you', response: 'I am well, thank you.' });
    const answer = teacher.respond('how are you');
    expect(answer.response).toBe('I am well, thank you.');
    expect(answer.confidence).toBeGreaterThan(0);
    expect(answer.cue).toBe('how are you');
  });

  it('honestly declines when nothing was confidently recalled', () => {
    teacher.teachResponse({ cue: 'goodbye', response: 'Goodbye!' });
    // Words that share no encoded primes with any taught cue.
    const answer = teacher.respond('zzz xyz qqq');
    expect(answer.response).toBeNull();
    expect(answer.confidence).toBeNull();
  });

  it('an empty or whitespace utterance is never answered', () => {
    const answer = teacher.respond('   ');
    expect(answer.response).toBeNull();
  });

  it('word traces do not leak into conversational answers', () => {
    teacher.teach('apple');
    // "apple" is a learned WORD, not a conversation phrase — the observer
    // must not answer a conversation turn with its definition trace.
    const answer = teacher.respond('apple');
    expect(answer.response).toBeNull();
  });

  it('conversation traces do not leak into word quizzes', () => {
    teacher.teach('hello');
    teacher.teachResponse({ cue: 'goodbye', response: 'Goodbye!' });
    const question = teacher.ask('hello', 'recognition');
    // The taught word's trace must win the quiz, not the conversational one.
    const grade = teacher.grade('hello', question);
    expect(grade.verdict).toBe('correct');
  });

  it('teaches the whole conversation deck idempotently', () => {
    const first = teacher.teachConversationDeck(CONVERSATION_DECK);
    const second = teacher.teachConversationDeck(CONVERSATION_DECK);
    expect(first).toBe(CONVERSATION_DECK.length);
    expect(second).toBe(0);
    expect(teacher.conversationReport().taught).toBe(CONVERSATION_DECK.length);
  });

  it('creativeGradeFeedback memorizes a strong answer as a creative trace', () => {
    teacher.teachConversationDeck(CONVERSATION_DECK.slice(0, 2));
    const bank: any = session.observer.getMemoryBank();
    const before = bank.all().filter((t: any) => t.metadata?.kind === 'creative').length;

    teacher.creativeGradeFeedback([], CREATIVE_REINFORCE_SCORE + 0.1, 'what time is it', 'I think it is time to learn.');
    const creative = bank.all().filter((t: any) => t.metadata?.kind === 'creative');
    expect(creative.length).toBe(before + 1);
    expect(creative[creative.length - 1].content).toBe('I think it is time to learn.');
    expect(creative[creative.length - 1].metadata).toMatchObject({ kind: 'creative', uttered: 'what time is it' });

    // The same utterance does NOT duplicate the memory.
    teacher.creativeGradeFeedback([], CREATIVE_REINFORCE_SCORE + 0.1, 'what time is it', 'I think it is time to learn.');
    expect(bank.all().filter((t: any) => t.metadata?.kind === 'creative').length).toBe(before + 1);
  });

  it('creativeGradeFeedback never memorizes a weak answer', () => {
    teacher.teachConversationDeck(CONVERSATION_DECK.slice(0, 1));
    const bank: any = session.observer.getMemoryBank();
    const before = bank.all().filter((t: any) => t.metadata?.kind === 'creative').length;
    teacher.creativeGradeFeedback([], 0.1, 'what time is it', 'Blue is a color.');
    expect(bank.all().filter((t: any) => t.metadata?.kind === 'creative').length).toBe(before);
  });

  it('memorized creative answers survive export/import (persistence)', async () => {
    const s1 = new ObserverSession(OPTIONS, 100);
    await s1.initialize();
    const t1 = new TeacherAgent(s1, WORD_DECK);
    t1.creativeGradeFeedback([], 0.9, 'what time is it', 'I think it is time to learn.');
    const record = t1.exportBootstrap('test');
    s1.dispose();
    expect(record.traces.some((trace) => trace.metadata?.kind === 'creative')).toBe(true);

    const s2 = new ObserverSession(OPTIONS, 100);
    await s2.initialize();
    const t2 = new TeacherAgent(s2, WORD_DECK);
    const imported = t2.importBootstrap(record);
    expect(imported.restored).toBeGreaterThan(0);
    // A creative reply seeded from the restored memory pool.
    const reply = t2.creativeReply('what time is it');
    expect(reply.sentence.length).toBeGreaterThan(0);
    s2.dispose();
  });

  it('creativeReply composes a new sentence from the observer\'s own memories', () => {
    teacher.teachConversationDeck(CONVERSATION_DECK.slice(0, 6));
    const reply = teacher.creativeReply('hello, how are you?');

    expect(reply.sentence.length).toBeGreaterThan(0);
    expect(reply.seedCount).toBeGreaterThan(0);
    expect(reply.seedTraceIds.length).toBeGreaterThan(0);

    // Every word of the composition must come from the taught memories.
    const vocabulary = new Set(
      CONVERSATION_DECK.slice(0, 6)
        .flatMap((pair) => pair.response.split(' '))
        .map((token) => token.toLowerCase().replace(/[^a-z]/g, ''))
        .filter((token) => token.length > 0)
    );
    for (const token of reply.sentence.toLowerCase().split(' ')) {
      expect(vocabulary.has(token.replace(/[^a-z]/g, ''))).toBe(true);
    }
  });

  it('creativeGradeFeedback reinforces seeds on a strong grade and weakens them on a weak grade', () => {
    teacher.teachConversationDeck(CONVERSATION_DECK.slice(0, 2));
    const reply = teacher.creativeReply('how are you');
    const seedId = reply.seedTraceIds[0];
    const bank = session.observer.getMemoryBank();

    // Freshly-touched traces can sit at maximum strength, so weaken first.
    const before = bank.get(seedId)?.strength ?? 0;
    teacher.creativeGradeFeedback([seedId], CREATIVE_WEAKEN_SCORE - 0.1);
    const weakened = bank.get(seedId)?.strength ?? 0;
    expect(weakened).toBeLessThan(before);

    teacher.creativeGradeFeedback([seedId], CREATIVE_REINFORCE_SCORE + 0.1);
    const strengthened = bank.get(seedId)?.strength ?? 0;
    expect(strengthened).toBeGreaterThan(weakened);
  });

  it('creativeGradeFeedback is a no-op without a grade or with a neutral one', () => {
    teacher.teachConversationDeck(CONVERSATION_DECK.slice(0, 1));
    const reply = teacher.creativeReply('hello');
    const seedId = reply.seedTraceIds[0];
    const bank = session.observer.getMemoryBank();
    const before = bank.get(seedId)?.strength ?? 0;

    teacher.creativeGradeFeedback([seedId], null);
    expect(bank.get(seedId)?.strength ?? 0).toBe(before);

    teacher.creativeGradeFeedback([seedId], 0.5);
    expect(bank.get(seedId)?.strength ?? 0).toBe(before);
  });

  it('L1b (18.2): the creative delta is surprise-scaled by the margin beyond the gate', () => {
    // Band edges reproduce the floor (0.25 of the base delta); the extremes
    // reproduce the pre-L1b full magnitudes; mid-band is exactly 0.
    expect(creativeGradeDelta(1)).toBeCloseTo(0.05, 10);
    expect(creativeGradeDelta(0)).toBeCloseTo(-0.05, 10);
    expect(creativeGradeDelta(CREATIVE_REINFORCE_SCORE)).toBeCloseTo(0.05 * 0.25, 10);
    expect(creativeGradeDelta(CREATIVE_WEAKEN_SCORE)).toBeCloseTo(-0.05 * 0.25, 10);
    expect(creativeGradeDelta(0.5)).toBe(0);
    // Monotone in the margin: a 0.95 moves more than a 0.75.
    expect(creativeGradeDelta(0.95)).toBeGreaterThan(creativeGradeDelta(0.75));
    expect(Math.abs(creativeGradeDelta(0.05))).toBeGreaterThan(Math.abs(creativeGradeDelta(0.25)));
  });

  it('teaches the full conversation curriculum including the extended deck', () => {
    const taught = teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS);
    expect(taught).toBe(ALL_CONVERSATION_PAIRS.length);
    expect(ALL_CONVERSATION_PAIRS.length).toBeGreaterThan(16);
    expect(teacher.conversationReport().taught).toBe(ALL_CONVERSATION_PAIRS.length);
  });

  it('re-teaching a word reinforces the existing trace instead of duplicating it (surprise-gated storage)', () => {
    const first = teacher.teach('apple');
    expect(first.traceId).not.toBeNull();
    const bank = session.observer.getMemoryBank();
    // Fresh traces sit at full strength — weaken the trace so reinforcement
    // is measurable.
    bank.reinforce(first.traceId!, -0.5);
    const before = bank.get(first.traceId!)?.strength ?? 0;

    const second = teacher.teach('apple');
    expect(second.traceId).toBe(first.traceId);
    expect(bank.get(first.traceId!)?.strength ?? 0).toBeGreaterThan(before);
    // Exactly one trace explains the word — no duplicate disorder added.
    expect(bank.all().filter((trace) => trace.content.includes('apple')).length).toBe(1);
  });
});

describe('composeCreativeResponse', () => {
  const MEMORIES = [
    'Hello! I am learning English.',
    'I am well, thank you for asking.',
    'Goodbye! Come back soon.',
    'I learn by remembering each lesson.'
  ];

  it('builds a sentence only from the given memories', () => {
    const { sentence } = composeCreativeResponse(MEMORIES);
    const allowed = new Set('hello i am learning english well thank you for asking goodbye come back soon learn by remembering each lesson'.split(' '));
    for (const token of sentence.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)) {
      if (token.length > 0) expect(allowed.has(token)).toBe(true);
    }
    expect(sentence.length).toBeGreaterThan(0);
  });

  it('returns a bounded sentence with terminal punctuation', () => {
    const { sentence } = composeCreativeResponse(MEMORIES);
    expect(sentence.length).toBeLessThan(200);
    expect(/[.!?]$/.test(sentence)).toBe(true);
  });

  it('falls back gracefully with no memories', () => {
    const { sentence, seedCount } = composeCreativeResponse([]);
    expect(seedCount).toBe(0);
    expect(sentence.length).toBeGreaterThan(0);
  });
});

describe('minimum-surprise composition (entropy descent)', () => {
  it('scoreComposition rewards utterance overlap and learned transition weight', () => {
    const tokens = new Set(['hello', 'friend']);
    const weights = new Map<string, number>([['i|am', 5]]);
    const responsive = scoreComposition(['hello', 'i', 'am', 'friend'], tokens, weights);
    const unrelated = scoreComposition(['goodbye', 'bye'], tokens, weights);
    expect(responsive).toBeGreaterThan(unrelated);
    // More overlap AND the weighted transition beats equal-overlap alone.
    const weighted = scoreComposition(['hello', 'i', 'am'], tokens, weights);
    const plain = scoreComposition(['hello', 'bye', 'soon'], tokens, weights);
    expect(weighted).toBeGreaterThan(plain);
  });

  it('updateCompositionWeights nudges transition weights along the grade delta', () => {
    const weights = new Map<string, number>();
    updateCompositionWeights(weights, ['I am well.'], 0.05);
    expect(weights.get('i|am')).toBeCloseTo(1.05);
    expect(weights.get('am|well')).toBeCloseTo(1.05);
    updateCompositionWeights(weights, ['I am well.'], -0.05);
    expect(weights.get('i|am')).toBeCloseTo(1);
    // The floor keeps trained-down transitions alive.
    updateCompositionWeights(weights, ['I am well.'], -10);
    expect(weights.get('i|am')).toBeGreaterThan(0);
  });

  it('updateCompositionWeights also trains TRIGRAM transitions', () => {
    const weights = new Map<string, number>();
    updateCompositionWeights(weights, ['I am well today.'], 0.05);
    expect(weights.get('i|am|well')).toBeCloseTo(1.05);
    expect(weights.get('am|well|today')).toBeCloseTo(1.05);
    // scoreComposition rewards a trained trigram path.
    const tokens = new Set<string>();
    const withTrigram = scoreComposition(['i', 'am', 'well', 'today'], tokens, weights);
    const plain = scoreComposition(['i', 'am', 'here', 'now'], tokens, weights);
    expect(withTrigram).toBeGreaterThan(plain);
  });

  it('scoreComposition rewards words that CONTINUE the moment', () => {
    const tokens = new Set<string>(['hello']);
    const weights = new Map<string, number>();
    const moment = new Set<string>(['apple', 'fruit']);
    const continues = scoreComposition(['hello', 'apple', 'fruit'], tokens, weights, moment);
    const ignores = scoreComposition(['hello', 'weather', 'rain'], tokens, weights, moment);
    expect(continues).toBeGreaterThan(ignores);
  });

  it('weighted walks favor trained trigram transitions', () => {
    const weights = new Map<string, number>([['i|am|well', 100]]);
    let trigramWins = 0;
    for (let round = 0; round < 50; round += 1) {
      const { sentence } = composeCreativeResponse(
        ['I am well today.', 'I go soon.'],
        '',
        { weights, utterance: 'how are you' }
      );
      if (sentence.toLowerCase().includes('i am well')) trigramWins += 1;
    }
    expect(trigramWins).toBeGreaterThan(40);
  });

  it('creativeReply ranks RELEVANT seeds first (token overlap with the utterance)', async () => {
    const localSession = new ObserverSession(OPTIONS, 100);
    await localSession.initialize();
    const localTeacher = new TeacherAgent(localSession, WORD_DECK);
    localTeacher.teachResponse({ cue: 'apple talk', response: 'Apples are tasty fruit.' });
    localTeacher.teachResponse({ cue: 'weather talk', response: 'The weather is warm today.' });
    localTeacher.teachResponse({ cue: 'hello', response: 'Hello there.' });

    const reply = localTeacher.creativeReply('what do you think about apple');
    // The apple-related memory must seed the composition (highest relevance).
    expect(reply.seedTraceIds.length).toBeGreaterThan(0);
    const bank: any = localSession.observer.getMemoryBank();
    const firstSeed = bank.get(reply.seedTraceIds[0]);
    expect(firstSeed.content).toBe('Apples are tasty fruit.');
    localSession.dispose();
  });

  it('weighted walks favor learned transitions over unlearned ones', () => {
    const weights = new Map<string, number>([['i|am', 100]]);
    // Give the unweighted path a chance to lose many times over.
    let weightedWins = 0;
    for (let round = 0; round < 50; round += 1) {
      const { sentence } = composeCreativeResponse(
        ['I am learning.', 'I go soon.'],
        '',
        { weights, utterance: 'what are you learning' }
      );
      if (sentence.toLowerCase().includes('i am')) weightedWins += 1;
    }
    expect(weightedWins).toBeGreaterThan(40);
  });

  it('creativeGradeFeedback also trains the composition weights', async () => {
    const localSession = new ObserverSession(OPTIONS, 100);
    await localSession.initialize();
    const localTeacher = new TeacherAgent(localSession, WORD_DECK);
    localTeacher.teachConversationDeck(CONVERSATION_DECK.slice(0, 2));
    const reply = localTeacher.creativeReply('how are you');
    const seedId = reply.seedTraceIds[0];
    const seedContent = localSession.observer.getMemoryBank().get(seedId)?.content ?? '';

    localTeacher.creativeGradeFeedback([seedId], CREATIVE_REINFORCE_SCORE + 0.1);
    // The seed content's transitions are now heavier.
    const probe = new Map<string, number>();
    updateCompositionWeights(probe, [seedContent], 0);
    const anyKey = [...probe.keys()][0];
    expect(anyKey).toBeDefined();
    updateCompositionWeights(probe, [seedContent], 0.1);
    expect(probe.get(anyKey)).toBeGreaterThan(1);

    localSession.dispose();
  });
});

describe('conversation curriculum learner (Chaperone-generated phrase pairs)', () => {
  it('validates proposed pairs: shape, length, duplicates, and identity', () => {
    const existing = new Set(['hello', 'goodbye']);
    const good: ConversationPairResult = { cue: 'what time is it', response: 'I think it is three o clock.' };
    expect(validateConversationPair(good, existing)).toEqual({
      cue: 'what time is it',
      response: 'I think it is three o clock.'
    });

    // Duplicate of an existing cue → rejected.
    expect(validateConversationPair({ cue: 'HELLO', response: 'Hi there.' }, existing)).toBeNull();
    // Response identical to the cue → rejected.
    expect(validateConversationPair({ cue: 'yes', response: 'yes' }, existing)).toBeNull();
    // Uppercase cue → rejected (must be lowercase printable English).
    expect(validateConversationPair({ cue: 'What Time Is It', response: 'Three o clock.' }, existing)).toBeNull();
    // Too-short response → rejected.
    expect(validateConversationPair({ cue: 'are you okay', response: 'ok' }, existing)).toBeNull();
    // Leading/trailing whitespace is trimmed.
    expect(validateConversationPair({ cue: '  are you okay  ', response: '  I am okay, thank you.  ' }, existing)).toEqual({
      cue: 'are you okay',
      response: 'I am okay, thank you.'
    });
  });

  it('parseConversationPairs tolerates prose-wrapped JSON, drops malformed entries, and dedups within itself', () => {
    const content = 'Here are some exchanges:\n```json\n{"pairs": [{"cue": "how are you", "response": "I am fine."}, {"cue": "BAD!", "response": "Also bad."}, {"cue": "how are you", "response": "Duplicate within payload."}]}\n```';
    const { pairs, rejected } = parseConversationPairs(content);
    expect(pairs).toEqual([{ cue: 'how are you', response: 'I am fine.' }]);
    expect(rejected).toEqual(expect.arrayContaining(['BAD!', 'how are you']));
  });

  it('generates and validates pairs through the provider, deduping against known cues', async () => {
    let requestedFormat = false;
    const provider: ChaperoneProvider = {
      name: 'fake',
      async completeRaw(prompt, options) {
        requestedFormat = options?.responseFormat !== undefined;
        void prompt;
        return JSON.stringify({
          pairs: [
            { cue: 'do you want tea', response: 'Yes, I would like some tea.' },
            { cue: 'hello', response: 'Duplicate.' },
            { cue: 'INVALID CUE', response: 'Also invalid.' }
          ]
        });
      },
      async complete() {
        return '';
      }
    };
    const chaperone = new Chaperone(provider);
    const run = await chaperone.generateConversationPairs({
      count: 2,
      existingCues: ['hello'],
      level: 'beginner'
    });

    expect(requestedFormat).toBe(true);
    expect(run.error).toBeNull();
    expect(run.pairs).toEqual([{ cue: 'do you want tea', response: 'Yes, I would like some tea.' }]);
    expect(run.rejected).toEqual(expect.arrayContaining(['hello', 'INVALID CUE']));
  });

  it('reports a clean failure when the provider cannot be asked', async () => {
    const provider: ChaperoneProvider = {
      name: 'basic',
      async complete() {
        return '';
      }
    };
    const chaperone = new Chaperone(provider);
    const run = await chaperone.generateConversationPairs({ count: 3, existingCues: [], level: 'beginner' });
    expect(run.pairs).toHaveLength(0);
    expect(run.error).toMatch(/structured output/i);
  });

  it('proposed pairs are teachable end to end', async () => {
    const provider: ChaperoneProvider = {
      name: 'fake',
      async completeRaw() {
        return JSON.stringify({ pairs: [{ cue: 'do you want tea', response: 'Yes, I would like some tea.' }] });
      },
      async complete() {
        return '';
      }
    };
    const chaperone = new Chaperone(provider);
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, WORD_DECK);
    const run = await chaperone.generateConversationPairs({ count: 1, existingCues: [], level: 'beginner' });
    const traceId = teacher.teachResponse(run.pairs[0]);
    expect(traceId).not.toBeNull();
    const answer = teacher.respond('do you want tea');
    expect(answer.response).toBe('Yes, I would like some tea.');
    session.dispose();
  });

  it('remembers generated pairs across a fresh session (traces survive restart)', async () => {
    const provider: ChaperoneProvider = {
      name: 'fake',
      async completeRaw() {
        return JSON.stringify({ pairs: [{ cue: 'do you want tea', response: 'Yes, I would like some tea.' }] });
      },
      async complete() {
        return '';
      }
    };
    const chaperone = new Chaperone(provider);
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, WORD_DECK);
    const run = await chaperone.generateConversationPairs({ count: 1, existingCues: [], level: 'beginner' });
    teacher.teachResponse(run.pairs[0]);
    const record = teacher.exportBootstrap('test');
    session.dispose();

    const fresh = new ObserverSession(OPTIONS, 100);
    await fresh.initialize();
    const freshTeacher = new TeacherAgent(fresh, WORD_DECK);
    const imported = freshTeacher.importBootstrap(record);
    expect(imported.conversations).toBe(1);
    const answer = freshTeacher.respond('do you want tea');
    expect(answer.response).toBe('Yes, I would like some tea.');
    fresh.dispose();
  });
});

describe('gap capture + self-teaching (learn from the conversation)', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, WORD_DECK);
  });

  afterEach(() => {
    session.dispose();
  });

  it('an unanswered utterance is recorded as a gap and the observer ASKS', () => {
    const answer = teacher.chatAnswer('what is the capital of mars');
    expect(answer.mode).toBe('ask');
    expect(teacher.listGaps()).toContain('what is the capital of mars');
    if (answer.mode === 'ask') {
      expect(answer.response).toMatch(/teach me|do not know/i);
    }
  });

  it('a weak creative answer also becomes a gap', () => {
    teacher.teachConversationDeck(CONVERSATION_DECK.slice(0, 1));
    teacher.creativeGradeFeedback([], 0.2, 'do you like the rain', 'Blue is a color.');
    expect(teacher.listGaps()).toContain('do you like the rain');
  });

  it('teaching a gap removes it and makes the observer answer it', () => {
    const answer = teacher.chatAnswer('what is the capital of mars');
    expect(answer.mode).toBe('ask');
    const traceId = teacher.teachGap('what is the capital of mars', 'I do not know the capital of mars yet.');
    expect(traceId).not.toBeNull();
    expect(teacher.listGaps()).not.toContain('what is the capital of mars');
    const after = teacher.chatAnswer('what is the capital of mars');
    expect(after.mode).toBe('memorized');
    if (after.mode === 'memorized') {
      expect(after.response).toContain('mars');
    }
  });

  it('gaps survive export/import (persisted learning material)', async () => {
    teacher.chatAnswer('what is the capital of mars');
    const record = teacher.exportBootstrap('test');
    session.dispose();

    const fresh = new ObserverSession(OPTIONS, 100);
    await fresh.initialize();
    const freshTeacher = new TeacherAgent(fresh, WORD_DECK);
    freshTeacher.importBootstrap(record);
    expect(freshTeacher.listGaps()).toContain('what is the capital of mars');
    fresh.dispose();
  });
});

describe('semantic grade parsing', () => {
  it('parses a clean grade object', () => {
    expect(parseGradeOutcome('{"score": 0.75, "feedback": "Sensible and relevant."}')).toEqual({
      score: 0.75,
      feedback: 'Sensible and relevant.'
    });
  });

  it('parses a grade wrapped in a code fence', () => {
    const raw = '```json\n{"score": 0.4, "feedback": "Mostly unrelated."}\n```';
    expect(parseGradeOutcome(raw)).toEqual({ score: 0.4, feedback: 'Mostly unrelated.' });
  });

  it('rejects out-of-range scores and missing feedback', () => {
    expect(parseGradeOutcome('{"score": 1.5, "feedback": "Too high."}')).toBeNull();
    expect(parseGradeOutcome('{"score": 0.5}')).toBeNull();
    expect(parseGradeOutcome('{"score": "high", "feedback": "Bad score."}')).toBeNull();
    expect(parseGradeOutcome('not a grade at all')).toBeNull();
  });
});

describe('bootstrap records (headless batch training → app import)', () => {
  it('transfers a trained record into a fresh session via exportBootstrap', async () => {
    const sourceSession = new ObserverSession(OPTIONS, 100);
    await sourceSession.initialize();
    const sourceTeacher = new TeacherAgent(sourceSession, WORD_DECK);
    sourceTeacher.teach('apple');
    sourceTeacher.teach('water');
    sourceTeacher.teachResponse({ cue: 'hello', response: 'Hello! I am learning English.' });
    const record = sourceTeacher.exportBootstrap('test');
    sourceSession.dispose();

    const targetSession = new ObserverSession(OPTIONS, 100);
    await targetSession.initialize();
    const targetTeacher = new TeacherAgent(targetSession, WORD_DECK);

    const result = targetTeacher.importBootstrap(record);
    expect(result.restored).toBe(3);
    expect(result.conversations).toBe(1);
    // The deck already carries authored definitions — the record's generated
    // ones must never overwrite them.
    expect(result.definitions).toBe(0);

    // The imported state is live: words are learned, definitions apply,
    // conversation answers work.
    const learned = targetTeacher.listWords().filter((w) => w.traceId !== null);
    expect(learned).toHaveLength(2);
    const apple = targetTeacher.listWords().find((w) => w.word.word === 'apple');
    expect(apple?.word.definition).toBe('a fruit');

    const answer = targetTeacher.respond('hello');
    expect(answer.response).toBe('Hello! I am learning English.');
    expect(answer.confidence).toBeGreaterThan(0);

    targetSession.dispose();
  });

  it('importing a record is idempotent — the second import does not duplicate traces', async () => {
    const sourceSession = new ObserverSession(OPTIONS, 100);
    await sourceSession.initialize();
    const sourceTeacher = new TeacherAgent(sourceSession, WORD_DECK);
    sourceTeacher.teach('water');
    sourceTeacher.teachResponse({ cue: 'goodbye', response: 'Goodbye!' });
    const record = sourceTeacher.exportBootstrap('test');
    sourceSession.dispose();

    const targetSession = new ObserverSession(OPTIONS, 100);
    await targetSession.initialize();
    const targetTeacher = new TeacherAgent(targetSession, WORD_DECK);
    targetTeacher.importBootstrap(record);
    const first = targetTeacher.listWords().filter((w) => w.traceId !== null).length;
    targetTeacher.importBootstrap(record);
    const second = targetTeacher.listWords().filter((w) => w.traceId !== null).length;

    expect(first).toBe(second);
    targetSession.dispose();
  });
});