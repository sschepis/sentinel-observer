/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent, type QuizAnswer } from './TeacherAgent';
import {
  EpisodicMemory,
  matchUserFact,
  salienceOf,
  relevanceOf,
  formatRemembered,
  vocabularyContent,
  humanizeGap,
  MAX_EPISODIC_FACTS,
  EPISODIC_SPOKEN_RELEVANCE_FLOOR,
  TOPIC_MIN_SEEN
} from './episodic';
import { MemoryPersistenceStore } from '../persistence/store';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';

const WORD_DECK: readonly DeckWord[] = [
  { word: 'apple', definition: 'a round fruit', example: 'I eat an apple.' },
  { word: 'water', definition: 'a clear liquid', example: 'I drink water.' },
  { word: 'hello', definition: 'a greeting', example: 'Hello there!' },
  { word: 'coffee', definition: '', example: '' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...WORD_DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ────────────────────────────────────────────────────────────────────────────
// Extraction: user facts
// ────────────────────────────────────────────────────────────────────────────

describe('user-fact extraction', () => {
  it('captures explicit first-person statements about the human', () => {
    const match = matchUserFact('I am learning English for work.');
    expect(match).not.toBeNull();
    // The sentence splitter strips the trailing period — the fact keeps the
    // human's own words otherwise.
    expect(match?.statement).toBe('I am learning English for work');
    expect(match?.topics).toEqual(expect.arrayContaining(['english', 'work']));
    expect(match?.topics).not.toContain('learning');
  });

  it('ignores transient states ("I am tired" is weather, not a fact)', () => {
    expect(matchUserFact('I am tired today.')).toBeNull();
    expect(matchUserFact('I am fine, thanks.')).toBeNull();
  });

  it('captures preferences including negations', () => {
    expect(matchUserFact('I like apples.')?.topics).toContain('apple');
    expect(matchUserFact('I do not like coffee.')?.topics).toContain('coffee');
    expect(matchUserFact('I love reading.')?.topics).toContain('reading');
  });

  it('captures work and situation statements', () => {
    expect(matchUserFact('my job is a nurse.')?.topics).toContain('nurse');
    expect(matchUserFact('I live in Berlin.')?.topics).toContain('berlin');
    expect(matchUserFact('I am from Brazil.')?.topics).toContain('brazil');
    expect(matchUserFact('I am a student.')?.topics).toContain('student');
  });

  it('never treats non-first-person statements as facts about the human', () => {
    expect(matchUserFact('you are learning English.')).toBeNull();
    expect(matchUserFact('Observer is learning English.')).toBeNull();
    expect(matchUserFact('what is the capital of mars?')).toBeNull();
  });

  it('matches one sentence at a time, not across sentence boundaries', () => {
    const match = matchUserFact('I like apples. What do you like?');
    expect(match?.statement).toBe('I like apples');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Extraction: topics + multi-session continuity
// ────────────────────────────────────────────────────────────────────────────

describe('topic recurrence and multi-session continuity', () => {
  it('turns a thrice-mentioned content word into a topic fact', () => {
    const memory = new EpisodicMemory();
    memory.observeTurn('user', 'I like apples.', 1000);
    memory.observeTurn('user', 'apples are good.', 2000);
    expect(memory.all().filter((f) => f.kind === 'topic')).toHaveLength(0);
    memory.observeTurn('user', 'tell me about apples again', 3000);
    const topics = memory.all().filter((f) => f.kind === 'topic');
    expect(topics).toHaveLength(1);
    expect(topics[0].topics).toEqual(['apple']);
    expect(topics[0].timesSeen).toBe(TOPIC_MIN_SEEN);
    expect(topics[0].content).toContain('apple');
  });

  it('records session continuity: the same topic across two sessions', () => {
    const memory = new EpisodicMemory(HOUR);
    memory.observeTurn('user', 'I like apples.', 1000);
    memory.observeTurn('user', 'apples are good.', 2000);
    // A session boundary (gap >= the configured threshold).
    const turn = memory.observeTurn('user', 'tell me about apples again', 2000 + HOUR);
    expect(turn.sessionStarted).toBe(true);
    expect(turn.gapMs).toBe(HOUR);
    const topic = memory.all().find((f) => f.kind === 'topic');
    expect(topic).toBeDefined();
    expect(topic?.sessionCount).toBe(2);
    expect(topic?.sessions).toHaveLength(2);
    expect(topic?.content).toContain('2 sessions');
  });

  it('persists near-threshold topic counters so recurrence survives restarts', () => {
    const first = new EpisodicMemory(HOUR);
    first.observeTurn('user', 'I like apples.', 1000);
    first.observeTurn('user', 'apples are good.', 2000);
    const snapshot = first.serialize(3000);
    expect(snapshot.topicCounters.find((c) => c.topic === 'apple')?.count).toBe(2);

    const second = new EpisodicMemory(HOUR);
    second.deserialize(snapshot);
    second.observeTurn('user', 'tell me about apples again', 2000 + HOUR);
    const topic = second.all().find((f) => f.kind === 'topic');
    expect(topic).toBeDefined();
    expect(topic?.sessionCount).toBe(2);
  });

  it('observes only user turns for facts; observer turns still move time', () => {
    const memory = new EpisodicMemory(HOUR);
    memory.observeTurn('user', 'I like apples.', 1000);
    memory.observeTurn('observer', 'Apples are tasty.', 2000);
    const turn = memory.observeTurn('observer', 'Anything else?', 2000 + HOUR);
    expect(turn.sessionStarted).toBe(true);
    expect(memory.all().filter((f) => f.kind === 'user-fact')).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Vocabulary facts (mastery / failure)
// ────────────────────────────────────────────────────────────────────────────

describe('vocabulary facts from grades', () => {
  it('records demonstrated failure and re-renders the honest phrasing', () => {
    const memory = new EpisodicMemory();
    memory.noteGrade('water', 'wrong', 1000);
    let fact = memory.all().find((f) => f.kind === 'vocabulary');
    expect(fact).toBeDefined();
    expect(fact?.lastVerdict).toBe('wrong');
    expect(fact?.wrongCount).toBe(1);
    expect(fact?.content).toBe('you have been struggling with "water"');
    memory.noteGrade('water', 'wrong', 2000);
    fact = memory.all().find((f) => f.kind === 'vocabulary');
    expect(fact?.wrongCount).toBe(2);
    expect(fact?.timesSeen).toBe(2);
  });

  it('records demonstrated mastery after repeated correct grades', () => {
    const memory = new EpisodicMemory();
    memory.noteGrade('apple', 'correct', 1000);
    memory.noteGrade('apple', 'correct', 2000);
    memory.noteGrade('apple', 'correct', 3000);
    const fact = memory.all().find((f) => f.kind === 'vocabulary');
    expect(fact?.correctCount).toBe(3);
    expect(fact?.content).toBe('you have mastered "apple"');
  });

  it('keeps one fact per word (episode merge, not a log)', () => {
    const memory = new EpisodicMemory();
    memory.noteGrade('water', 'wrong', 1000);
    memory.noteGrade('water', 'correct', 2000);
    memory.noteGrade('water', 'wrong', 3000);
    expect(memory.all().filter((f) => f.topics.includes('water'))).toHaveLength(1);
  });

  it('vocabularyContent stays honest across mixed outcomes', () => {
    expect(vocabularyContent('water', 0, 1)).toBe('you have been struggling with "water"');
    expect(vocabularyContent('water', 1, 1)).toBe('you have been struggling with "water"');
    expect(vocabularyContent('water', 3, 1)).toBe('you practiced "water"');
    expect(vocabularyContent('water', 2, 0)).toBe('you have mastered "water"');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Salience policy
// ────────────────────────────────────────────────────────────────────────────

describe('salience policy', () => {
  it('ranks recency: a fresher fact outranks an identical older one', () => {
    const fresh = { kind: 'topic' as const, timesSeen: 1, lastSeenAt: 2000 };
    const stale = { kind: 'topic' as const, timesSeen: 1, lastSeenAt: 1000 };
    const now = 2000;
    expect(salienceOf(fresh as never, now)).toBeGreaterThan(salienceOf(stale as never, now));
  });

  it('ranks frequency: more sightings outrank fewer at equal recency', () => {
    const often = { kind: 'topic' as const, timesSeen: 6, lastSeenAt: 1000 };
    const once = { kind: 'topic' as const, timesSeen: 1, lastSeenAt: 1000 };
    expect(salienceOf(often as never, 1000)).toBeGreaterThan(salienceOf(once as never, 1000));
  });

  it('ranks kind: facts about the human outrank mechanics at equal history', () => {
    const user = { kind: 'user-fact' as const, timesSeen: 1, lastSeenAt: 1000 };
    const topic = { kind: 'topic' as const, timesSeen: 1, lastSeenAt: 1000 };
    expect(salienceOf(user as never, 1000)).toBeGreaterThan(salienceOf(topic as never, 1000));
  });

  it('boosts repeated demonstrated failure (task-relevant)', () => {
    const struggle = { kind: 'vocabulary' as const, timesSeen: 2, lastSeenAt: 1000, lastVerdict: 'wrong', wrongCount: 2 };
    const practice = { kind: 'vocabulary' as const, timesSeen: 2, lastSeenAt: 1000, lastVerdict: 'correct', correctCount: 2 };
    expect(salienceOf(struggle as never, 1000)).toBeGreaterThan(salienceOf(practice as never, 1000));
  });

  it('keeps the store bounded at the cap, evicting the lowest-salience facts', () => {
    const memory = new EpisodicMemory();
    const total = MAX_EPISODIC_FACTS + 6;
    for (let i = 0; i < total; i += 1) {
      memory.observeTurn('user', `I like word${i}.`, 1000 + i * DAY);
    }
    expect(memory.all()).toHaveLength(MAX_EPISODIC_FACTS);
    // The six OLDEST single-seen facts were evicted; the newest survived.
    const surviving = new Set(memory.all().map((f) => f.topics[0]));
    expect(surviving.has('word0')).toBe(false);
    expect(surviving.has('word6')).toBe(false);
    expect(surviving.has(`word${total - 1}`)).toBe(true);
  });

  it('forgets facts below the salience floor, but keeps old facts about the human', () => {
    const memory = new EpisodicMemory();
    memory.observeTurn('user', 'I like apples.', 1000);
    memory.observeTurn('user', 'bananas are good.', 2000);
    // 6 months pass with no contact — pruning happens at the next mutation.
    memory.prune(1000 + 180 * DAY);
    const kinds = new Set(memory.all().map((f) => f.kind));
    // "bananas are good" was a one-off topic — forgotten. The user fact
    // ("I like apples") is about the human — it survives.
    expect(kinds.has('topic')).toBe(false);
    expect(kinds.has('user-fact')).toBe(true);
  });

  it('drops stale session-gap facts on a TTL and keeps only recent gaps', () => {
    const memory = new EpisodicMemory(1000);
    memory.observeTurn('user', 'hello', 1000);
    memory.observeTurn('user', 'back again', 1000 + HOUR); // gap fact 1
    memory.observeTurn('user', 'and again', 1000 + 2 * HOUR); // gap fact 2
    expect(memory.all().filter((f) => f.kind === 'time')).toHaveLength(2);
    memory.prune(1000 + 2 * HOUR + 40 * DAY); // 40 days later
    expect(memory.all().filter((f) => f.kind === 'time')).toHaveLength(0);
  });

  it('humanizeGap renders human-readable gaps', () => {
    expect(humanizeGap(2 * DAY + 3 * HOUR)).toBe('2 days 3 hours');
    expect(humanizeGap(2 * DAY)).toBe('2 days');
    expect(humanizeGap(90 * 60 * 1000)).toBe('1 hour 30 min');
    expect(humanizeGap(45 * 60 * 1000)).toBe('45 min');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Retrieval (the honesty contract)
// ────────────────────────────────────────────────────────────────────────────

describe('retrieval', () => {
  it('returns nothing when the turn touches no stored topic (no fabrication)', () => {
    const memory = new EpisodicMemory();
    memory.observeTurn('user', 'I am learning English for work.', 1000);
    expect(memory.recall('what time is it?', { topK: 5 })).toHaveLength(0);
    expect(memory.recall('zzz qqq unknown', { topK: 5 })).toHaveLength(0);
  });

  it('retrieves only clearly relevant facts, tagged as remembered', () => {
    const memory = new EpisodicMemory();
    memory.observeTurn('user', 'I am learning English for work.', 1000);
    memory.observeTurn('user', 'I like apples.', 2000);
    const recalled = memory.recall('tell me about english', { topK: 5 });
    expect(recalled).toHaveLength(1);
    expect(recalled[0].remembered).toBe(true);
    expect(recalled[0].fact.kind).toBe('user-fact');
    expect(recalled[0].fact.topics).toEqual(expect.arrayContaining(['english']));
    expect(formatRemembered(recalled[0])).toContain('[remembered:');
  });

  it('ranks by relevance: the more salient relevant fact comes first', () => {
    const memory = new EpisodicMemory();
    memory.observeTurn('user', 'I am learning English for work.', 1000);
    memory.noteGrade('apple', 'wrong', 1000);
    memory.noteGrade('apple', 'wrong', 2000); // struggle boost
    const recalled = memory.recall('english and apple are both interesting', { topK: 5 });
    expect(recalled.length).toBe(2);
    expect(recalled[0].fact.topics[0]).toBe('apple');
  });

  it('includes the session-gap fact only on the first turn of a new session', () => {
    const memory = new EpisodicMemory(1000);
    memory.observeTurn('user', 'hello', 1000);
    const midSession = memory.recall('hello', { sessionStarted: false });
    expect(midSession.some((r) => r.fact.kind === 'time')).toBe(false);
    memory.observeTurn('user', 'back again', 2000); // new session, gap fact
    const firstTurn = memory.recall('back again', { sessionStarted: true });
    const gap = firstTurn.find((r) => r.fact.kind === 'time');
    expect(gap).toBeDefined();
    expect(gap?.fact.content).toContain('gap of');
  });

  it('applies the spoken-relevance floor: only clearly relevant, alive facts may be quoted', () => {
    const memory = new EpisodicMemory();
    memory.observeTurn('user', 'I like apples.', 1000);
    memory.observeTurn('user', 'apples are good.', 2000);
    memory.observeTurn('user', 'tell me about apples again', 3000); // topic fact
    memory.noteGrade('water', 'wrong', 4000);
    memory.noteGrade('water', 'wrong', 5000); // fresh, boosted struggle fact
    // Six months later, a single-seen topic fact has decayed below what the
    // observer is willing to SPEAK as a memory...
    const oldNow = 1000 + 180 * DAY;
    const topic = memory.all().find((f) => f.kind === 'topic')!;
    expect(relevanceOf(topic, new Set(['apple']), oldNow)).toBeLessThan(EPISODIC_SPOKEN_RELEVANCE_FLOOR);
    // ...while a recently demonstrated struggle is still clearly relevant.
    const struggle = memory.all().find((f) => f.kind === 'vocabulary')!;
    expect(relevanceOf(struggle, new Set(['water']), oldNow)).toBeGreaterThanOrEqual(EPISODIC_SPOKEN_RELEVANCE_FLOOR);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Persistence round-trip
// ────────────────────────────────────────────────────────────────────────────

describe('episodic memory persistence round-trip', () => {
  it('serialize → deserialize restores facts, counters and session state', () => {
    const memory = new EpisodicMemory(HOUR);
    memory.observeTurn('user', 'I am learning English for work.', 1000);
    memory.observeTurn('user', 'apples are good.', 2000);
    memory.noteGrade('water', 'wrong', 3000);
    memory.observeTurn('user', 'tell me about apples again', 1000 + HOUR);

    const snapshot = memory.serialize(1000 + HOUR);
    const restored = new EpisodicMemory(HOUR);
    restored.deserialize(snapshot);

    expect(restored.all()).toHaveLength(memory.all().length);
    expect(restored.all().find((f) => f.kind === 'user-fact')?.content).toBe('I am learning English for work');
    const vocabulary = restored.all().find((f) => f.kind === 'vocabulary');
    expect(vocabulary?.wrongCount).toBe(1);
    expect(vocabulary?.lastVerdict).toBe('wrong');
    // Retrieval works on the restored memory.
    const recalled = restored.recall('what about english?', { topK: 5 });
    expect(recalled.some((r) => r.fact.topics.includes('english') && r.remembered === true)).toBe(true);
  });

  it('round-trips through the persistence store (persistenceDurability)', async () => {
    const store = new MemoryPersistenceStore();
    const memory = new EpisodicMemory(HOUR);
    memory.observeTurn('user', 'I am learning English for work.', 1000);
    memory.noteGrade('water', 'wrong', 2000);
    await store.saveEpisodicMemory(memory.serialize(3000));

    const snapshot = await store.loadEpisodicMemory();
    expect(snapshot).not.toBeNull();
    const restored = new EpisodicMemory(HOUR);
    restored.deserialize(snapshot!);
    expect(restored.all()).toHaveLength(2);
    expect(restored.recall('tell me about water', { topK: 5 })[0].fact.topics).toContain('water');
  });

  it('drops malformed snapshot entries loudly-free', () => {
    const memory = new EpisodicMemory();
    memory.deserialize({
      version: 1,
      facts: [
        { id: 'ok', kind: 'user-fact', content: 'x', topics: ['x'], probe: '', firstSeenAt: 1, lastSeenAt: 1, timesSeen: 1, sessions: [], sessionCount: 0 },
        { id: 42, kind: 'nonsense', topics: 'junk' },
        null
      ] as never,
      topicCounters: [{ topic: 1, count: 'x' }] as never,
      sessionId: null,
      lastTurnAt: 999
    });
    expect(memory.all()).toHaveLength(1);
    expect(memory.all()[0].id).toBe('ok');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Teacher integration: multi-session topic continuity through the agent
// ────────────────────────────────────────────────────────────────────────────

describe('TeacherAgent episodic integration across sessions', () => {
  let store: MemoryPersistenceStore;
  let clock: { now: number };
  let nowSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    store = new MemoryPersistenceStore();
    clock = { now: 1_000_000 };
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('remembers the learner across a restart and references measured struggles', async () => {
    // ── Session 1: the learner states a fact, repeats a topic, fails a word.
    const session1 = new ObserverSession(OPTIONS, 100);
    await session1.initialize();
    const teacher1 = new TeacherAgent(session1, WORD_DECK, store);
    teacher1.chatAnswer('I am learning English for work.');
    clock.now += 30_000;
    teacher1.chatAnswer('apples are good for breakfast.');
    clock.now += 30_000;
    teacher1.chatAnswer('I like apples.');
    const coffee = teacher1.tryState('coffee');
    expect(coffee).not.toBeNull();
    const quiz: QuizAnswer = { word: coffee!.word, cue: 'coffee', answer: '', recall: null };
    teacher1.grade('coffee', quiz);
    await teacher1.persistAll();
    session1.dispose();

    // ── Session 2: two days later, a fresh observer restores.
    clock.now = 3_000_000;
    const session2 = new ObserverSession(OPTIONS, 100);
    await session2.initialize();
    const teacher2 = new TeacherAgent(session2, WORD_DECK, store);
    await teacher2.restoreFromPersistence();

    // The user fact survived the restart.
    const facts = teacher2.episodicFacts();
    expect(facts.some((f) => f.kind === 'user-fact' && f.content.includes('learning English for work'))).toBe(true);
    expect(facts.some((f) => f.kind === 'vocabulary' && f.topics.includes('coffee') && f.lastVerdict === 'wrong')).toBe(true);

    // A topic mentioned in session 1 and again now is recalled across
    // sessions, tagged as remembered — with the session gap also remembered.
    const answer = teacher2.chatAnswer('tell me about apples again');
    const topic = answer.remembered?.find((r) => r.fact.kind === 'topic' && r.fact.topics.includes('apple'));
    expect(topic).toBeDefined();
    expect(topic?.remembered).toBe(true);
    expect(topic?.fact.sessionCount).toBe(2);
    expect(answer.remembered?.some((r) => r.fact.kind === 'time' && r.fact.content.includes('gap of'))).toBe(true);
    // The topic fact was CREATED by this turn — it lands in the learning
    // stream as a "remembers" event.
    expect(answer.stored?.some((f) => f.kind === 'topic' && f.topics.includes('apple'))).toBe(true);

    // The observer references the measured struggle instead of guessing:
    // "what does coffee mean" cannot be answered, and the memory of the
    // failed grade becomes part of the question.
    const ask = teacher2.chatAnswer('what does coffee mean');
    expect(ask.mode).toBe('ask');
    if (ask.mode === 'ask') {
      expect(ask.response).toContain('coffee');
      expect(ask.response).toContain('hard last time');
    }

    // The 8-turn working window stays session-scoped: nothing of session 1
    // leaks into reference resolution.
    expect(teacher2.getWorkingMemory().some((t) => t.text === 'I like apples.')).toBe(false);

    session2.dispose();
  });

  it('does not speak a struggle memory unless the turn clearly relates to it', async () => {
    const session1 = new ObserverSession(OPTIONS, 100);
    await session1.initialize();
    const teacher1 = new TeacherAgent(session1, WORD_DECK, store);
    const coffee = teacher1.tryState('coffee');
    teacher1.grade('coffee', { word: coffee!.word, cue: 'coffee', answer: '', recall: null });
    await teacher1.persistAll();
    session1.dispose();

    clock.now = 3_000_000;
    const session2 = new ObserverSession(OPTIONS, 100);
    await session2.initialize();
    const teacher2 = new TeacherAgent(session2, WORD_DECK, store);
    await teacher2.restoreFromPersistence();

    // An unrelated unknown keeps the plain ask — no remembered fact is
    // quoted (the topic gate blocks it).
    const ask = teacher2.chatAnswer('what is the capital of mars');
    expect(ask.mode).toBe('ask');
    if (ask.mode === 'ask') {
      expect(ask.response).not.toContain('coffee');
      expect(ask.response).toContain('mars');
    }
    session2.dispose();
  });
});
