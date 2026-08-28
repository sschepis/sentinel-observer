import type { RecallResult } from '@sschepis/sentient-core';
import type { ObserverSession } from '../observer/engine';
import type { PersistenceStore } from '../persistence/store';
import { lessonText, productionCue, recognitionCue, hasDefinition, type DeckWord } from './deck';

/**
 * The word loop: teach → test → grade → reinforce, with the OBSERVER as the
 * learner. The teacher owns the curriculum and the answer key; the observer
 * owns its own memory — the teacher can only observe traces and feed graded
 * events back into the observer's field.
 */

export type WordStatus = 'new' | 'learning' | 'consolidated';

export interface WordState {
  word: DeckWord;
  traceId: string | null;
  taughtAt: number | null;
  lastAskedAt: number | null;
  lastGrade: 'correct' | 'wrong' | null;
  successes: number;
  failures: number;
  /** Strength history samples (retention record, capped at 100). */
  strengthHistory: Array<{ at: number; strength: number }>;
}

export interface TeachResult {
  word: DeckWord;
  traceId: string | null;
  note: string;
}

export interface QuizAnswer {
  word: DeckWord;
  cue: string;
  /** What the observer "said" — the content of its best-recalled trace. */
  answer: string;
  /** The recall result the answer came from (null when the observer drew a blank). */
  recall: RecallResult | null;
}

export type GradeVerdict = 'correct' | 'wrong';

export interface GradeResult {
  word: DeckWord;
  verdict: GradeVerdict;
  /** The observer's answer that was graded. */
  answer: string;
  /** The expected answer (definition when cued by word, word when cued by meaning). */
  expected: string;
  /** Recall confidence in [0,1] for correct answers (null when wrong). */
  confidence: number | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Autonomous teaching loop
// ────────────────────────────────────────────────────────────────────────────

export type AutoLoopPhase = 'idle' | 'teaching' | 'asking' | 'grading' | 'done' | 'error';

export interface AutoLoopStep {
  phase: AutoLoopPhase;
  word: string | null;
  cue: string | null;
  answer: string | null;
  grade: GradeResult | null;
  message: string;
}

export interface AutoLoopHandle {
  stop(): void;
  readonly running: boolean;
}

export interface AutoLoopOptions {
  /** Pause after teaching before the quiz (ms). */
  teachPauseMs?: number;
  /** Pause after the quiz before grading (ms). */
  askPauseMs?: number;
  /** Pause after grading before the next word (ms). */
  gradePauseMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strength below which a trace NEEDS review (the curiosity threshold). */
export const REVIEW_STRENGTH_THRESHOLD = 0.6;

/** Strength below which a trace is projected to be due within a day. */
export const SOON_STRENGTH_THRESHOLD = 0.75;

/**
 * Apply wall-clock forgetting to every restored trace: strength decays
 * exponentially since its last access, with a half-life that grows as the
 * trace is reinforced (unreinforced 2 days, practiced 7 days, consolidated
 * 30 days). This is what turns the observer's memory into a real spaced-
 * repetition system — time passes, memories fade, the curiosity engine asks
 * for reviews.
 */
function applyTimeDecay(traces: Iterable<{ lastAccessAt: number; strength: number; accessCount: number; consolidated: boolean }>, now = Date.now()): void {
  const DAY = 24 * 60 * 60 * 1000;
  for (const trace of traces) {
    const elapsed = Math.max(0, now - trace.lastAccessAt);
    if (elapsed < 60 * 1000) continue; // sub-minute: no measurable forgetting

    const halfLifeDays = trace.consolidated ? 30 : trace.accessCount >= 2 ? 7 : 2;
    const halfLifeMs = halfLifeDays * DAY;
    trace.strength = trace.strength * Math.pow(0.5, elapsed / halfLifeMs);
  }
}

/**
 * Review scheduling state per word, from the trace's live strength.
 */
export type WordDueStatus = 'new' | 'due' | 'soon' | 'healthy' | 'consolidated';

export interface WordReport {
  word: string;
  status: WordDueStatus;
  strength: number | null;
  /** Strength change since the previous session sample (null without history). */
  delta: number | null;
  successes: number;
  failures: number;
}

export interface RetentionReport {
  total: number;
  learned: number;
  consolidatedCount: number;
  dueCount: number;
  healthyCount: number;
  words: WordReport[];
}

/**
 * Detect a pre-focused-encoding trace by its DATA:
 *  - a near-identity SMF (norm below epsilon — it imprinted nothing), or
 *  - a FLAT amplitude profile: most of the basis primes carry meaningful
 *    excitation (the old lesson-text excitation spread across everything).
 *
 * A focused trace excites only the word's signature primes — a small
 * fraction of the basis — so the active-prime ratio cleanly separates the
 * two eras regardless of any serialization marker.
 */
function isStaleEncoding(data: { smf: number[]; amplitudes: number[] }): boolean {
  let smfNormSq = 0;
  for (const v of data.smf) {
    if (Number.isFinite(v)) smfNormSq += v * v;
  }
  if (Math.sqrt(smfNormSq) < 0.05) return true;

  if (data.amplitudes.length === 0) return true;
  let active = 0;
  for (const amplitude of data.amplitudes) {
    if (Number.isFinite(amplitude) && amplitude > 0.05) active += 1;
  }
  return active / data.amplitudes.length > 0.6;
}

export class TeacherAgent {
  private readonly states = new Map<string, WordState>();
  private autoLoopToken = 0;
  private autoLoopRunning = false;
  private autoStep: AutoLoopStep | null = null;
  private readonly autoListeners = new Set<(step: AutoLoopStep) => void>();

  constructor(
    private readonly session: ObserverSession,
    deck: readonly DeckWord[],
    private readonly persistence: PersistenceStore | null = null
  ) {
    for (const entry of deck) {
      this.states.set(entry.word, {
        word: entry,
        traceId: null,
        taughtAt: null,
        lastAskedAt: null,
        lastGrade: null,
        successes: 0,
        failures: 0,
        strengthHistory: []
      });
    }
  }

  /**
   * Restore the observer's learning record from persistence: memory traces
   * go back into its memory bank (same ids, strengths and counters), word
   * states rebind to them.
   *
   * Encoding-epoch migration: traces from before the focused-encoding era
   * carry FLAT amplitude profiles (the old lesson-text excitation spread
   * across the whole basis) and near-identity SMFs — restoring them would
   * poison recall. The detector inspects the DATA, not a marker (a marker
   * can be re-badged by a later persist; flat data cannot hide). Stale
   * words are reset to 'new' so the teacher re-teaches them.
   */
  async restoreFromPersistence(): Promise<{ restored: number; stale: number }> {
    if (this.persistence === null) return { restored: 0, stale: 0 };
    const [traces, states] = await Promise.all([
      this.persistence.loadTraces(),
      this.persistence.loadWordStates()
    ]);

    const bank = this.session.observer.getMemoryBank();
    const staleTraceIds = new Set<string>();
    let restored = 0;

    for (const data of traces) {
      if (isStaleEncoding(data)) {
        staleTraceIds.add(data.id);
        continue;
      }
      const trace = bank.restoreTrace(data);
      if (trace !== null) restored += 1;
    }

    // Wall-clock forgetting: time passed while the observer was away.
    applyTimeDecay(bank.all());

    if (states !== null) {
      for (const state of states) {
        const current = this.states.get(state.word.word);
        if (!current) continue;
        // Words bound to stale (pre-encoding) traces are re-learned from
        // scratch; their historical grade counts reset with them.
        if (state.traceId !== null && staleTraceIds.has(state.traceId)) {
          current.traceId = null;
          current.taughtAt = null;
          current.lastAskedAt = null;
          current.lastGrade = null;
          current.successes = 0;
          current.failures = 0;
          continue;
        }
        current.traceId = state.traceId;
        current.taughtAt = state.taughtAt;
        current.lastAskedAt = state.lastAskedAt;
        current.lastGrade = state.lastGrade;
        current.successes = state.successes;
        current.failures = state.failures;
        current.strengthHistory = Array.isArray(state.strengthHistory) ? state.strengthHistory : [];
      }
    }
    return { restored, stale: staleTraceIds.size };
  }

  /**
   * Persist the complete learning record (word states + serialized traces).
   * Failures are logged, never thrown: a broken store must not break school.
   * Each save also appends a strength sample to the word's retention history.
   */
  async persistAll(): Promise<void> {
    if (this.persistence === null) return;
    try {
      const bank = this.session.observer.getMemoryBank();
      const traces = [];
      const now = Date.now();
      for (const state of this.states.values()) {
        if (state.traceId === null) continue;
        const data = bank.serializeTrace(state.traceId);
        if (data !== null) {
          traces.push(data);
          state.strengthHistory.push({ at: now, strength: data.strength });
          while (state.strengthHistory.length > 100) state.strengthHistory.shift();
        }
      }
      await Promise.all([
        this.persistence.saveWordStates([...this.states.values()]),
        this.persistence.saveTraces(traces)
      ]);
    } catch (error) {
      console.warn('persistence save failed', error);
    }
  }

  /**
   * Apply chaperoned (or authored) definitions to the deck in place. Words
   * gain their meaning content and the school's quizzes upgrade from
   * word-only recognition to full recognition + production. Content that is
   * already defined is never overwritten by generated text.
   */
  applyDefinitions(definitions: ReadonlyArray<{ word: string; definition: string; example: string }>): number {
    let applied = 0;
    for (const generated of definitions) {
      const state = this.states.get(generated.word);
      if (!state || state.word.definition.trim().length > 0) continue;
      state.word.definition = generated.definition;
      state.word.example = generated.example;
      applied += 1;
    }
    return applied;
  }

  /**
   * The retention report: where every word stands, whether it is due for
   * review, and how its strength moved since the previous session.
   */
  report(): RetentionReport {
    let consolidatedCount = 0;
    let dueCount = 0;
    let healthyCount = 0;
    let learned = 0;
    const words: WordReport[] = [];

    for (const state of this.states.values()) {
      const trace = state.traceId !== null ? this.traceOf(state.traceId) : undefined;
      if (trace === undefined) {
        words.push({
          word: state.word.word,
          status: 'new',
          strength: null,
          delta: null,
          successes: state.successes,
          failures: state.failures
        });
        continue;
      }

      learned += 1;
      let status: WordDueStatus;
      if (trace.consolidated) {
        status = 'consolidated';
        consolidatedCount += 1;
      } else if (trace.strength < REVIEW_STRENGTH_THRESHOLD) {
        status = 'due';
        dueCount += 1;
      } else if (trace.strength < SOON_STRENGTH_THRESHOLD) {
        status = 'soon';
      } else {
        status = 'healthy';
        healthyCount += 1;
      }

      const history = state.strengthHistory;
      const previous = history.length >= 2 ? history[history.length - 2] : null;
      words.push({
        word: state.word.word,
        status,
        strength: trace.strength,
        delta: previous !== null ? trace.strength - previous.strength : null,
        successes: state.successes,
        failures: state.failures
      });
    }

    return {
      total: this.states.size,
      learned,
      consolidatedCount,
      dueCount,
      healthyCount,
      words
    };
  }

  /**
   * Present a lesson: the observer encodes the word into its field + memory.
   *
   * Focused encoding (phase 2): the field is SETTLED first so residual
   * amplitude from previous lessons cannot contaminate this trace, then only
   * the WORD is excited (its whole-word prime signature via the vocabulary),
   * the field is ticked once so the SMF imprints the word's orientation, and
   * the trace is stored. The full lesson text still lives in the trace
   * content — the encoding is what is focused, not the record.
   */
  teach(word: string): TeachResult {
    const state = this.requiredState(word);
    const lesson = lessonText(state.word);

    this.session.settleField();
    this.session.observeText(state.word.word);
    this.session.observer.tick(0.02);
    const trace = this.session.storeMemory(lesson);
    if (trace !== null) {
      state.traceId = trace.id;
      state.taughtAt = Date.now();
      void this.persistAll();
      return { word: state.word, traceId: trace.id, note: 'stored in the observer\'s memory' };
    }
    return { word: state.word, traceId: null, note: 'field was quiescent — nothing stored' };
  }

  /**
   * Ask the observer a question: cue it, let it recall, return what it said.
   *
   * The teacher first OBSERVES the cue (the observer hears the question — its
   * field aligns to what it is being asked) and ticks once so the SMF
   * imprints the cue's orientation; the recall itself remains a pure read
   * that never excites the field.
   */
  ask(word: string, direction: 'recognition' | 'production' = 'recognition'): QuizAnswer {
    const state = this.requiredState(word);
    const cue = direction === 'production' ? productionCue(state.word) : recognitionCue(state.word);

    this.session.observeText(cue);
    this.session.observer.tick(0.02);
    const results = this.session.recall(cue, 5);
    const top = results[0] ?? null;
    return {
      word: state.word,
      cue,
      answer: top?.trace.content ?? '',
      recall: top
    };
  }

  /**
   * Grade the observer's answer against the answer key and feed the verdict
   * back into the observer as a quiz event (success reinforces the trace;
   * failure perturbs it and lets it decay).
   *
   * The verdict is about the IDENTITY of the recall: did the observer recall
   * the right trace? When it did, the answer is correct — the raw similarity
   * score is reported separately as recall CONFIDENCE and never demotes a
   * right answer. A blank, a wrong trace, or no recall is wrong, period.
   */
  grade(word: string, question: QuizAnswer): GradeResult {
    const state = this.requiredState(word);
    const expected = state.word.definition.trim().length > 0 ? state.word.definition : state.word.word;

    const top = question.recall;
    const matchedTrace =
      top !== null && state.traceId !== null && top.trace.id === state.traceId;
    const blank = question.answer.trim().length === 0;

    const verdict: GradeVerdict = matchedTrace && !blank ? 'correct' : 'wrong';
    const confidence = verdict === 'correct' && top !== null ? top.score : null;

    const detail = `${state.word.word}: ${state.word.definition}`;
    this.session.observeEvent(
      'quiz.answer',
      verdict === 'correct' ? 'success' : 'failure',
      detail
    );

    state.lastAskedAt = Date.now();
    state.lastGrade = verdict;
    if (verdict === 'correct') {
      state.successes += 1;
    } else {
      state.failures += 1;
    }
    void this.persistAll();

    return { word: state.word, verdict, answer: question.answer, expected, confidence };
  }

  /**
   * The observer's curiosity: the next word that NEEDS review — the weakest
   * trace below the review threshold (decaying first). Returns null when
   * nothing is weak enough to need work.
   */
  nextReview(): string | null {
    let best: { word: string; strength: number; prio: number } | null = null;

    for (const state of this.states.values()) {
      if (state.traceId === null) continue;
      const trace = this.traceOf(state.traceId);
      if (trace === undefined || trace.strength >= REVIEW_STRENGTH_THRESHOLD) continue;

      // Priority: decaying traces (strength < 0.5) above everything,
      // otherwise weakest first.
      const prio = trace.strength < 0.5 ? 0 : 1;
      if (best === null || prio < best.prio || (prio === best.prio && trace.strength < best.strength)) {
        best = { word: state.word.word, strength: trace.strength, prio };
      }
    }
    return best?.word ?? null;
  }

  /** Any learned word, weakest first (manual-quiz fallback when nothing needs review). */
  nextLearnedWord(): string | null {
    let best: { word: string; strength: number } | null = null;
    for (const state of this.states.values()) {
      if (state.traceId === null) continue;
      const trace = this.traceOf(state.traceId);
      if (trace === undefined) continue;
      if (best === null || trace.strength < best.strength) {
        best = { word: state.word.word, strength: trace.strength };
      }
    }
    return best?.word ?? null;
  }

  /** The next word the observer has never been taught. */
  nextNewWord(): string | null {
    for (const state of this.states.values()) {
      if (state.traceId === null) return state.word.word;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Autonomous teaching loop
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Run the school automatically: teach → ask → grade → next, continuously.
   *
   * The observer's own state drives WHAT to learn (curiosity: decaying
   * traces first, then untaught words) and the quiz direction (recognition
   * until a word has a success, then production — asking it to speak the
   * word from its meaning). The teacher only decides WHEN, on a human-
   * watchable cadence. The loop stops when the deck is exhausted and
   * nothing is decaying, or on stop()/dispose.
   */
  startAutoLoop(options: AutoLoopOptions = {}): AutoLoopHandle {
    if (this.autoLoopRunning) {
      return { stop: () => this.stopAutoLoop(), get running() { return false; } };
    }

    const token = ++this.autoLoopToken;
    this.autoLoopRunning = true;
    const teachPauseMs = options.teachPauseMs ?? 1500;
    const askPauseMs = options.askPauseMs ?? 1500;
    const gradePauseMs = options.gradePauseMs ?? 2500;

    const setStep = (step: AutoLoopStep) => {
      if (token !== this.autoLoopToken) return;
      this.autoStep = step;
      for (const listener of [...this.autoListeners]) {
        try {
          listener(step);
        } catch {
          // An isolated UI listener can never break the teaching loop.
        }
      }
    };

    void (async () => {
      setStep({ phase: 'idle', word: null, cue: null, answer: null, grade: null, message: 'the school begins' });
      try {
        while (token === this.autoLoopToken) {
          const word = this.nextReview() ?? this.nextNewWord();
          if (word === null) {
            setStep({
              phase: 'done',
              word: null,
              cue: null,
              answer: null,
              grade: null,
              message: 'the deck is learned — nothing is decaying and nothing is new'
            });
            break;
          }

          // Teach only what is new; reviews exercise existing traces.
          if (this.requiredState(word).traceId === null) {
            const teachResult = this.teach(word);
            setStep({
              phase: 'teaching',
              word,
              cue: null,
              answer: null,
              grade: null,
              message: teachResult.traceId !== null
                ? `teaching "${word}" — stored in the observer's memory`
                : `teaching "${word}" — the field was quiescent, nothing stored`
            });
            await sleep(teachPauseMs);
            if (token !== this.autoLoopToken) break;
          }

          // Recognition first: what does the word mean?
          const recognition = this.ask(word, 'recognition');
          setStep({
            phase: 'asking',
            word,
            cue: recognition.cue,
            answer: recognition.answer,
            grade: null,
            message: 'asking it for the meaning of the word'
          });
          await sleep(askPauseMs);
          if (token !== this.autoLoopToken) break;
          const recognitionGrade = this.grade(word, recognition);
          setStep({
            phase: 'grading',
            word,
            cue: recognition.cue,
            answer: recognition.answer,
            grade: recognitionGrade,
            message: `graded ${recognitionGrade.verdict}${recognitionGrade.confidence !== null ? ` (confidence ${recognitionGrade.confidence.toFixed(2)})` : ''}`
          });
          await sleep(gradePauseMs);
          if (token !== this.autoLoopToken) break;

          // Production: speak the word from its meaning — only when a
          // meaning exists. Word-only words are practiced by recognition
          // until the Chaperone fills their definitions.
          if (!hasDefinition(this.requiredState(word).word)) continue;
          const production = this.ask(word, 'production');
          setStep({
            phase: 'asking',
            word,
            cue: production.cue,
            answer: production.answer,
            grade: null,
            message: 'asking it to speak the word from its meaning'
          });
          await sleep(askPauseMs);
          if (token !== this.autoLoopToken) break;
          const productionGrade = this.grade(word, production);
          setStep({
            phase: 'grading',
            word,
            cue: production.cue,
            answer: production.answer,
            grade: productionGrade,
            message: `graded ${productionGrade.verdict}${productionGrade.confidence !== null ? ` (confidence ${productionGrade.confidence.toFixed(2)})` : ''}`
          });
          await sleep(gradePauseMs);
        }
      } catch (error) {
        setStep({
          phase: 'error',
          word: null,
          cue: null,
          answer: null,
          grade: null,
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        if (token === this.autoLoopToken) {
          this.autoLoopRunning = false;
        }
      }
    })();

    const agent = this;
    return {
      stop: () => agent.stopAutoLoop(),
      get running() {
        return token === agent.autoLoopToken && agent.autoLoopRunning;
      }
    };
  }

  stopAutoLoop(): void {
    this.autoLoopToken += 1;
    this.autoLoopRunning = false;
  }

  /** Subscribe to loop steps; returns an unsubscribe function. */
  onAutoStep(listener: (step: AutoLoopStep) => void): () => void {
    this.autoListeners.add(listener);
    if (this.autoStep !== null) {
      listener(this.autoStep);
    }
    return () => this.autoListeners.delete(listener);
  }

  /** The latest loop step (null when the loop has never run). */
  getAutoStep(): AutoLoopStep | null {
    return this.autoStep;
  }

  /** Whether the autonomous loop is currently running. */
  isAutoLoopRunning(): boolean {
    return this.autoLoopRunning;
  }

  /** Snapshot of every word's learning state, for the teacher UI. */
  listWords(): Array<WordState & { strength: number | null; status: WordStatus }> {
    return [...this.states.values()].map((state) => {
      const trace = state.traceId !== null ? this.traceOf(state.traceId) : undefined;
      let status: WordStatus = 'new';
      if (trace !== undefined) {
        status = trace.consolidated === true || state.successes >= 3 ? 'consolidated' : 'learning';
      }
      return { ...state, strength: trace?.strength ?? null, status };
    });
  }

  private traceOf(traceId: string): ReturnType<ReturnType<ObserverSession['observer']['getMemoryBank']>['get']> {
    return this.session.observer.getMemoryBank().get(traceId);
  }

  private requiredState(word: string): WordState {
    const state = this.states.get(word);
    if (!state) {
      throw new Error(`Unknown deck word: ${word}`);
    }
    return state;
  }
}
