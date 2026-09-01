/**
 * EPISODIC MEMORY — the selective, honest record of the learner's life.
 *
 * The working-memory window (context.ts) is deliberately SESSION-SCOPED:
 * raw conversation must not survive restarts. This module is the deliberate
 * exception to that rule, and it earns the exception by being selective:
 * it persists only SALIENT facts, never transcripts.
 *
 *   · user-fact   — explicit first-person statements the human made about
 *                   themselves ("I am learning English for work")
 *   · vocabulary  — deck words the user demonstrated mastery or failure of
 *                   (from grades — the observer's own measurements)
 *   · topic       — content words that recur across turns and sessions
 *   · time        — session boundaries and the gaps between sessions
 *
 * Everything stored is BOUNDED (salience-ranked pruning — recency +
 * frequency + task-relevance — in the same one-signal-per-episode spirit as
 * the observer's drift episodes: the memory holds episodes, not logs), and
 * everything retrieved is TAGGED as remembered. The observer can therefore
 * reference a fact only when the current turn makes it clearly relevant,
 * and can never present a guess as a memory.
 */

import { tokenizeText, isContentWord, singularize } from './context';

export type EpisodicFactKind = 'user-fact' | 'vocabulary' | 'topic' | 'time';

export interface EpisodicFact {
  id: string;
  kind: EpisodicFactKind;
  /** The fact, in the observer's own honest words (as the human said it,
   *  or as the observer measured it). */
  content: string;
  /** Topic tokens used for relevance matching ('' for time facts). */
  topics: string[];
  /** The source turn or event the fact came from (provenance). */
  probe: string;
  firstSeenAt: number;
  lastSeenAt: number;
  timesSeen: number;
  /** Vocabulary only: the last demonstrated outcome. */
  lastVerdict?: 'correct' | 'wrong';
  correctCount?: number;
  wrongCount?: number;
  /** Sessions the fact was observed in (capped recency window) + total. */
  sessions: string[];
  sessionCount: number;
}

/** A retrieved memory — tagged as remembered, never presented as inference. */
export interface RememberedFact {
  fact: EpisodicFact;
  /** How relevant the fact is to the current turn (0 = not retrieved). */
  relevance: number;
  /** How worth remembering the fact is (the persistent ranking score). */
  salience: number;
  /** Always true: a retrieved entry IS a remembered fact. */
  remembered: true;
}

export interface EpisodicTurnResult {
  /** Facts CREATED by this turn (new memories — event-worthy). */
  stored: EpisodicFact[];
  /** Facts strengthened by this turn (already known — no new event). */
  touched: EpisodicFact[];
  /** True when this turn opened a new session (a measured time gap). */
  sessionStarted: boolean;
  /** The gap to the previous turn when a session boundary was crossed. */
  gapMs: number | null;
}

/** A session boundary is a turn at least this long after the previous one. */
export const SESSION_GAP_MS = 30 * 60 * 1000;
/** The store's hard bound — salience-ranked pruning keeps it there. */
export const MAX_EPISODIC_FACTS = 64;
/** A content word becomes a topic fact after this many user turns. */
export const TOPIC_MIN_SEEN = 3;
/** Below this relevance a remembered fact is NOT injected (honesty gate). */
export const RECALL_RELEVANCE_FLOOR = 0.05;
/** Relevance at which the observer may SPEAK a remembered fact itself. */
export const EPISODIC_SPOKEN_RELEVANCE_FLOOR = 0.15;
/** Salience below which a fact is forgotten (pruned). */
const SALIENCE_FLOOR = 0.08;
/** Age beyond which a session-gap fact is forgotten (they are context, not lore). */
const TIME_FACT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How many session-gap facts are kept (the recent session history). */
const MAX_TIME_FACTS = 4;
/** Half-life of the recency term — a fact's freshness halves weekly. */
const RECENCY_HALFLIFE_MS = 7 * 24 * 60 * 60 * 1000;
/** Sightings at which the frequency term saturates (~4). */
const FREQUENCY_SATURATION = 4;
/** Base salience per kind: facts about the human outrank mechanics. */
const KIND_BASE: Record<EpisodicFactKind, number> = {
  'user-fact': 1.0,
  vocabulary: 0.8,
  topic: 0.6,
  time: 0.4
};
/** Repeated demonstrated failure is task-relevant — it must not age away. */
const STRUGGLE_BOOST = 1.4;
/** Topic counters are persisted so recurrence survives restarts, but bounded. */
const MAX_TOPIC_COUNTERS = 256;
/** A fact's session list is a recency window, never an unbounded log. */
const MAX_SESSIONS_PER_FACT = 8;

// ────────────────────────────────────────────────────────────────────────────
// User-fact extraction
// ────────────────────────────────────────────────────────────────────────────

/**
 * Transient states are not facts: "I am tired" is today's weather, not
 * something the observer should remember about the human. Everything else in
 * an "I am X" statement may be durable.
 */
const TRANSIENT_STATES = new Set([
  'well', 'fine', 'okay', 'ok', 'good', 'bad', 'tired', 'busy', 'hungry',
  'thirsty', 'happy', 'sad', 'angry', 'bored', 'ready', 'sure', 'sorry',
  'afraid', 'excited', 'sick', 'late', 'here', 'back', 'home', 'new', 'old',
  'young', 'glad', 'proud', 'done', 'lost', 'confused', 'surprised', 'sleepy',
  'cold', 'hot', 'so', 'very', 'just', 'not'
]);

/** First-person statements about the human, most specific first. The clause
 *  is everything after the cue. */
const USER_FACT_PATTERNS: ReadonlyArray<{ re: RegExp; transientGated?: boolean }> = [
  { re: /^i am learning (.+)$/i },
  { re: /^i am studying (.+)$/i },
  { re: /^i am practicing (.+)$/i },
  { re: /^i am preparing (?:for|to) (.+)$/i },
  { re: /^i am trying to (.+)$/i },
  { re: /^i am going to (.+)$/i },
  { re: /^i want to (.+)$/i },
  { re: /^i want (.+)$/i },
  { re: /^i need to (.+)$/i },
  { re: /^i have to (.+)$/i },
  { re: /^i (?:do not|don't) like (.+)$/i },
  { re: /^i (?:really )?like (.+)$/i },
  { re: /^i love (.+)$/i },
  { re: /^i work (?:as|at|in|for) (.+)$/i },
  { re: /^my job is (.+)$/i },
  { re: /^my name is (.+)$/i },
  { re: /^i am from (.+)$/i },
  { re: /^i (?:am living|live) in (.+)$/i },
  { re: /^i am a (.+)$/i },
  // The catch-all: "I am X" — gated by the transient-state list.
  { re: /^i am (.+)$/i, transientGated: true }
];

/**
 * Gerunds at the start of a clause are the CUE's verb, not the object's
 * topic: "I want to LEARN English" is about English, not about learning.
 * Leading tokens in this set are stripped before topic extraction.
 */
const CLAUSE_SKIP = new Set(['learn', 'learning', 'study', 'studying', 'practice', 'practicing', 'prepare', 'preparing', 'try', 'trying']);

export interface MatchedUserFact {
  /** The statement as the human said it (original casing, trimmed). */
  statement: string;
  /** Content words of the clause — the retrieval keys. */
  topics: string[];
}

/**
 * Match a first-person statement about the human. Conservative by design:
 * only explicit, declarative "I ..." statements about the human's learning,
 * work, preferences, and situation become facts; transient states and
 * non-first-person statements never do. Returns null when nothing durable
 * was said.
 */
export function matchUserFact(text: string): MatchedUserFact | null {
  const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  for (const sentence of sentences) {
    for (const pattern of USER_FACT_PATTERNS) {
      const match = pattern.re.exec(sentence);
      if (match === null) continue;
      const clause = match[1].trim();
      if (clause.length === 0) continue;
      if (pattern.transientGated === true) {
        // Catch-all "I am X": a transient state is weather, not a fact.
        const first = clause.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
        if (TRANSIENT_STATES.has(first)) continue;
      }
      // Strip the cue's own verb when it leads the clause ("learning english"
      // is about english, not learning).
      const words = clause.split(/\s+/);
      let start = 0;
      while (start < words.length && CLAUSE_SKIP.has(words[start].toLowerCase().replace(/[^a-z]/g, ''))) {
        start += 1;
      }
      const topics = [...new Set(words.slice(start).map((w) => singularize(w.toLowerCase())).filter(isContentWord))];
      if (topics.length === 0) continue;
      return { statement: sentence, topics };
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Salience & relevance
// ────────────────────────────────────────────────────────────────────────────

/**
 * The persistent ranking score: kind base × a recency/frequency blend.
 * A fact's freshness halves every week; the frequency term saturates at ~4
 * sightings so one more mention cannot overwhelm everything else. Repeated
 * failure of a word is task-relevant and resists decay (the struggle boost).
 */
export function salienceOf(fact: EpisodicFact, now = Date.now()): number {
  let base = KIND_BASE[fact.kind];
  if (fact.kind === 'vocabulary' && fact.lastVerdict === 'wrong' && (fact.wrongCount ?? 0) >= 2) {
    base *= STRUGGLE_BOOST;
  }
  const age = Math.max(0, now - fact.lastSeenAt);
  const recency = Math.pow(0.5, age / RECENCY_HALFLIFE_MS);
  const frequency = 1 - Math.exp(-fact.timesSeen / FREQUENCY_SATURATION);
  return base * (0.55 * recency + 0.45 * frequency);
}

/**
 * Relevance to the current turn — the honesty gate. A fact is only
 * retrieved when the turn actually touches one of its topics; coverage of
 * the fact's own topics raises the score. Zero overlap means zero
 * relevance: the observer never volunteers unrelated memories.
 */
export function relevanceOf(fact: EpisodicFact, tokens: ReadonlySet<string>, now = Date.now()): number {
  const hit = fact.topics.filter((topic) => tokens.has(topic)).length;
  if (hit === 0) return 0;
  const coverage = Math.min(1, hit / Math.max(1, fact.topics.length));
  return salienceOf(fact, now) * (0.5 + 0.5 * coverage);
}

/** The human-readable form of a remembered fact — always tagged as such. */
export function formatRemembered(entry: RememberedFact): string {
  return `[remembered: ${entry.fact.content}]`;
}

/** "2 days 3 hours", "1 hour 20 min", "45 min" — the gap between sessions. */
export function humanizeGap(ms: number): string {
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;
  if (ms >= DAY) {
    const days = Math.floor(ms / DAY);
    const hours = Math.round((ms % DAY) / HOUR);
    return hours > 0
      ? `${days} day${days > 1 ? 's' : ''} ${hours} hour${hours > 1 ? 's' : ''}`
      : `${days} day${days > 1 ? 's' : ''}`;
  }
  if (ms >= HOUR) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.round((ms % HOUR) / MIN);
    return minutes > 0
      ? `${hours} hour${hours > 1 ? 's' : ''} ${minutes} min`
      : `${hours} hour${hours > 1 ? 's' : ''}`;
  }
  return `${Math.max(1, Math.round(ms / MIN))} min`;
}

/** The honest phrasing of a vocabulary fact from its measured counts. */
export function vocabularyContent(word: string, correct: number, wrong: number): string {
  if (correct >= 2 && wrong === 0) return `you have mastered "${word}"`;
  if (wrong >= 1 && wrong >= correct) return `you have been struggling with "${word}"`;
  return `you practiced "${word}"`;
}

// ────────────────────────────────────────────────────────────────────────────
// The memory
// ────────────────────────────────────────────────────────────────────────────

export interface EpisodicMemorySnapshot {
  version: 1;
  facts: EpisodicFact[];
  topicCounters: Array<{ topic: string; count: number; sessions: string[]; sessionCount: number; lastSeenAt: number }>;
  sessionId: string | null;
  lastTurnAt: number | null;
}

interface TopicCounter {
  topic: string;
  count: number;
  sessions: string[];
  sessionCount: number;
  lastSeenAt: number;
}

export class EpisodicMemory {
  private readonly facts = new Map<string, EpisodicFact>();
  private readonly topicCounters = new Map<string, TopicCounter>();
  private sessionId: string | null = null;
  private lastTurnAt: number | null = null;

  constructor(
    private readonly sessionGapMs = SESSION_GAP_MS,
    private readonly maxFacts = MAX_EPISODIC_FACTS
  ) {}

  /**
   * Observe a turn. Session boundaries are MEASURED (a gap longer than
   * `sessionGapMs` opens a new session — with its gap remembered as a time
   * fact), so no external session bookkeeping is needed. Only user turns
   * yield user-facts and topic recurrence; the observer's own words are
   * never evidence about the human.
   */
  observeTurn(role: 'user' | 'observer', text: string, at = Date.now()): EpisodicTurnResult {
    const trimmed = text.trim();
    if (trimmed.length === 0) return { stored: [], touched: [], sessionStarted: false, gapMs: null };

    const sessionStarted = this.lastTurnAt === null || at - this.lastTurnAt >= this.sessionGapMs;
    let gapMs: number | null = null;
    if (sessionStarted) {
      this.sessionId = `session-${at}`;
      if (this.lastTurnAt !== null) {
        gapMs = at - this.lastTurnAt;
        this.upsert(
          'time',
          `time:${this.sessionId}`,
          `a new session began after a gap of ${humanizeGap(gapMs)}`,
          [],
          'session boundary',
          at,
          this.sessionId
        );
      }
    }
    this.lastTurnAt = at;
    if (role !== 'user') return { stored: [], touched: [], sessionStarted, gapMs };

    const stored: EpisodicFact[] = [];
    const touched: EpisodicFact[] = [];

    const match = matchUserFact(trimmed);
    if (match !== null) {
      const id = `user-fact:${match.topics.slice().sort().join('|')}`;
      const isNew = !this.facts.has(id);
      const fact = this.upsert(
        'user-fact',
        id,
        match.statement,
        match.topics,
        trimmed,
        at,
        this.sessionId ?? undefined
      );
      (isNew ? stored : touched).push(fact);
    }

    for (const fact of this.trackTopics(trimmed, at, this.sessionId ?? undefined)) {
      stored.push(fact);
    }

    return { stored, touched, sessionStarted, gapMs };
  }

  /**
   * Record a demonstrated outcome for a deck word — the observer's own
   * measurement of mastery or failure, upserted into one fact per word.
   */
  noteGrade(word: string, verdict: 'correct' | 'wrong', at = Date.now()): EpisodicFact | null {
    const existing = this.facts.get(`vocabulary:${word}`);
    const correctCount = (existing?.correctCount ?? 0) + (verdict === 'correct' ? 1 : 0);
    const wrongCount = (existing?.wrongCount ?? 0) + (verdict === 'wrong' ? 1 : 0);
    return this.upsert(
      'vocabulary',
      `vocabulary:${word}`,
      vocabularyContent(word, correctCount, wrongCount),
      [word],
      `grade:${verdict}`,
      at,
      this.sessionId ?? undefined,
      { lastVerdict: verdict, correctCount, wrongCount }
    );
  }

  /**
   * Retrieve the remembered facts clearly relevant to the current turn,
   * salience-ranked. Topic-gated: no topic overlap, no retrieval. On the
   * first turn of a new session the most recent gap fact rides along — the
   * "you were away for X" context is relevant exactly then, and only then.
   */
  recall(utterance: string, options: { topK?: number; sessionStarted?: boolean } = {}): RememberedFact[] {
    const now = Date.now();
    const tokens = new Set(tokenizeText(utterance).map(singularize));
    const candidates: Array<{ fact: EpisodicFact; relevance: number }> = [];
    for (const fact of this.facts.values()) {
      if (fact.kind === 'time') continue;
      const relevance = relevanceOf(fact, tokens, now);
      if (relevance >= RECALL_RELEVANCE_FLOOR) candidates.push({ fact, relevance });
    }
    if (options.sessionStarted === true) {
      const gap = this.newestTimeFact();
      if (gap !== null) candidates.push({ fact: gap, relevance: salienceOf(gap, now) });
    }
    candidates.sort((a, b) => b.relevance - a.relevance);
    const topK = options.topK ?? 3;
    return candidates.slice(0, topK).map(({ fact, relevance }) => ({
      fact,
      relevance,
      salience: salienceOf(fact, now),
      remembered: true as const
    }));
  }

  /** Every stored fact (read-only — introspection/UI). */
  all(): readonly EpisodicFact[] {
    return [...this.facts.values()];
  }

  /** The most recent session-gap fact, or null. */
  newestTimeFact(): EpisodicFact | null {
    let best: EpisodicFact | null = null;
    for (const fact of this.facts.values()) {
      if (fact.kind !== 'time') continue;
      if (best === null || fact.lastSeenAt > best.lastSeenAt) best = fact;
    }
    return best;
  }

  /**
   * Compaction — the memory stays bounded. Stale gap facts fall off on a
   * TTL (they are context, not lore), facts below the salience floor are
   * forgotten, and beyond the cap the lowest-salience facts are evicted.
   * Called on every mutation and at serialization.
   */
  prune(now = Date.now()): void {
    const timeFacts = [...this.facts.values()]
      .filter((fact) => fact.kind === 'time')
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    const keepTime = new Set(
      timeFacts
        .slice(0, MAX_TIME_FACTS)
        .filter((fact) => now - fact.lastSeenAt <= TIME_FACT_TTL_MS)
        .map((fact) => fact.id)
    );
    const survivors = [...this.facts.values()].filter((fact) =>
      fact.kind === 'time' ? keepTime.has(fact.id) : salienceOf(fact, now) >= SALIENCE_FLOOR
    );
    if (survivors.length > this.maxFacts) {
      // Oldest first on ties, so an equal-salience burst evicts the oldest
      // facts, never the freshest.
      survivors.sort((a, b) => salienceOf(b, now) - salienceOf(a, now) || a.lastSeenAt - b.lastSeenAt);
      survivors.length = this.maxFacts;
    }
    const keep = new Set(survivors.map((fact) => fact.id));
    for (const id of [...this.facts.keys()]) {
      if (!keep.has(id)) this.facts.delete(id);
    }
    this.pruneTopicCounters();
  }

  /** The durable, JSON-serializable record (persisted via the store). */
  serialize(now = Date.now()): EpisodicMemorySnapshot {
    this.prune(now);
    return {
      version: 1,
      facts: [...this.facts.values()].map((fact) => ({
        ...fact,
        topics: [...fact.topics],
        sessions: [...fact.sessions]
      })),
      topicCounters: [...this.topicCounters.values()].map((counter) => ({
        ...counter,
        sessions: [...counter.sessions]
      })),
      sessionId: this.sessionId,
      lastTurnAt: this.lastTurnAt
    };
  }

  /** Restore a persisted snapshot. Malformed entries are dropped loudly-free
   *  (the same discipline as the trace/learning-state restore paths). */
  deserialize(snapshot: EpisodicMemorySnapshot): void {
    if (snapshot === null || typeof snapshot !== 'object') return;
    this.facts.clear();
    this.topicCounters.clear();
    if (Array.isArray(snapshot.facts)) {
      for (const raw of snapshot.facts) {
        const fact = this.sanitizeFact(raw);
        if (fact !== null) this.facts.set(fact.id, fact);
      }
    }
    if (Array.isArray(snapshot.topicCounters)) {
      for (const raw of snapshot.topicCounters) {
        if (typeof raw !== 'object' || raw === null || typeof raw.topic !== 'string' || typeof raw.count !== 'number') {
          continue;
        }
        this.topicCounters.set(raw.topic, {
          topic: raw.topic,
          count: Math.max(1, Math.floor(raw.count)),
          sessions: Array.isArray(raw.sessions) ? raw.sessions.filter((s) => typeof s === 'string').slice(-MAX_SESSIONS_PER_FACT) : [],
          sessionCount: typeof raw.sessionCount === 'number' ? raw.sessionCount : 0,
          lastSeenAt: typeof raw.lastSeenAt === 'number' ? raw.lastSeenAt : Date.now()
        });
      }
    }
    this.sessionId = typeof snapshot.sessionId === 'string' ? snapshot.sessionId : null;
    this.lastTurnAt = typeof snapshot.lastTurnAt === 'number' ? snapshot.lastTurnAt : null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Topic recurrence: count content words across user turns; at the third
   *  sighting a topic becomes a fact whose session list records continuity
   *  across sessions. Counters persist so near-threshold recurrence survives
   *  restarts (a topic first mentioned twice in session 1 and once in
   *  session 2 still becomes a fact — with both sessions on record). */
  private trackTopics(text: string, at: number, sessionId: string | undefined): EpisodicFact[] {
    const created: EpisodicFact[] = [];
    const words = new Set(tokenizeText(text).map(singularize).filter(isContentWord));
    for (const word of words) {
      const existing = this.facts.get(`topic:${word}`);
      if (existing !== undefined) {
        this.touch(existing, at, sessionId);
        continue;
      }
      const counter = this.topicCounters.get(word);
      if (counter !== undefined) {
        counter.count += 1;
        this.addSession(counter, sessionId);
        counter.lastSeenAt = at;
        if (counter.count >= TOPIC_MIN_SEEN) {
          this.topicCounters.delete(word);
          created.push(
            this.upsert(
              'topic',
              `topic:${word}`,
              `you have talked about "${word}" in ${counter.sessionCount} sessions`,
              [word],
              text,
              at,
              sessionId,
              { timesSeen: counter.count, sessions: counter.sessions, sessionCount: counter.sessionCount }
            )
          );
        }
      } else {
        this.topicCounters.set(word, {
          topic: word,
          count: 1,
          sessions: sessionId !== undefined ? [sessionId] : [],
          sessionCount: sessionId !== undefined ? 1 : 0,
          lastSeenAt: at
        });
      }
    }
    this.pruneTopicCounters();
    return created;
  }

  /** Merge-or-create: one fact per (kind, key); re-observation strengthens
   *  the existing fact instead of duplicating it (the episode discipline —
   *  the drift detector emits one signal per episode, this stores one fact
   *  per episode). */
  private upsert(
    kind: EpisodicFactKind,
    id: string,
    content: string,
    topics: readonly string[],
    probe: string,
    at: number,
    sessionId?: string,
    extra?: Partial<EpisodicFact>
  ): EpisodicFact {
    const existing = this.facts.get(id);
    if (existing !== undefined) {
      existing.content = content;
      existing.probe = probe;
      existing.lastSeenAt = at;
      existing.timesSeen += 1;
      this.addSession(existing, sessionId);
      if (extra !== undefined) Object.assign(existing, extra);
      this.prune(at);
      return existing;
    }
    const fact: EpisodicFact = {
      id,
      kind,
      content,
      topics: [...topics],
      probe,
      firstSeenAt: at,
      lastSeenAt: at,
      timesSeen: 1,
      sessions: sessionId !== undefined ? [sessionId] : [],
      sessionCount: sessionId !== undefined ? 1 : 0,
      ...extra
    };
    this.facts.set(id, fact);
    this.prune(at);
    return fact;
  }

  private touch(fact: EpisodicFact, at: number, sessionId: string | undefined): void {
    fact.lastSeenAt = at;
    fact.timesSeen += 1;
    this.addSession(fact, sessionId);
    if (fact.kind === 'topic') {
      fact.content = `you have talked about "${fact.topics[0]}" in ${fact.sessionCount} sessions`;
    }
  }

  private addSession(target: { sessions: string[]; sessionCount: number }, sessionId: string | undefined): void {
    if (sessionId === undefined) return;
    if (!target.sessions.includes(sessionId)) {
      target.sessions.push(sessionId);
      if (target.sessions.length > MAX_SESSIONS_PER_FACT) target.sessions.shift();
      target.sessionCount += 1;
    }
  }

  private pruneTopicCounters(): void {
    if (this.topicCounters.size <= MAX_TOPIC_COUNTERS) return;
    const entries = [...this.topicCounters.values()].sort(
      (a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt
    );
    this.topicCounters.clear();
    for (const entry of entries.slice(0, MAX_TOPIC_COUNTERS)) {
      this.topicCounters.set(entry.topic, entry);
    }
  }

  private sanitizeFact(raw: unknown): EpisodicFact | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Partial<EpisodicFact>;
    if (typeof record.id !== 'string' || typeof record.kind !== 'string') return null;
    if (!(record.kind in KIND_BASE)) return null;
    const fact: EpisodicFact = {
      id: record.id,
      kind: record.kind as EpisodicFactKind,
      content: typeof record.content === 'string' ? record.content : '',
      topics: Array.isArray(record.topics) ? record.topics.filter((t) => typeof t === 'string') : [],
      probe: typeof record.probe === 'string' ? record.probe : '',
      firstSeenAt: typeof record.firstSeenAt === 'number' ? record.firstSeenAt : Date.now(),
      lastSeenAt: typeof record.lastSeenAt === 'number' ? record.lastSeenAt : Date.now(),
      timesSeen: typeof record.timesSeen === 'number' ? Math.max(1, record.timesSeen) : 1,
      sessions: Array.isArray(record.sessions) ? record.sessions.filter((s) => typeof s === 'string').slice(-MAX_SESSIONS_PER_FACT) : [],
      sessionCount: typeof record.sessionCount === 'number' ? record.sessionCount : 0
    };
    if (record.lastVerdict === 'correct' || record.lastVerdict === 'wrong') {
      fact.lastVerdict = record.lastVerdict;
    }
    if (typeof record.correctCount === 'number') fact.correctCount = record.correctCount;
    if (typeof record.wrongCount === 'number') fact.wrongCount = record.wrongCount;
    return fact;
  }
}
