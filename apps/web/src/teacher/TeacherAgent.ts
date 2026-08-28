import type { RecallResult } from '@sschepis/sentient-core';
import type { ObserverSession } from '../observer/engine';
import { lessonText, productionCue, recognitionCue, type DeckWord } from './deck';

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

export class TeacherAgent {
  private readonly states = new Map<string, WordState>();

  constructor(
    private readonly session: ObserverSession,
    deck: readonly DeckWord[]
  ) {
    for (const entry of deck) {
      this.states.set(entry.word, {
        word: entry,
        traceId: null,
        taughtAt: null,
        lastAskedAt: null,
        lastGrade: null,
        successes: 0,
        failures: 0
      });
    }
  }

  /** Present a lesson: the observer encodes the word into its field + memory. */
  teach(word: string): TeachResult {
    const state = this.requiredState(word);
    const lesson = lessonText(state.word);

    this.session.observeText(lesson);
    const trace = this.session.storeMemory(lesson);
    if (trace !== null) {
      state.traceId = trace.id;
      state.taughtAt = Date.now();
      return { word: state.word, traceId: trace.id, note: 'stored in the observer\'s memory' };
    }
    return { word: state.word, traceId: null, note: 'field was quiescent — nothing stored' };
  }

  /**
   * Ask the observer a question: cue it, let it recall, return what it said.
   *
   * The teacher first OBSERVES the cue (the observer hears the question — its
   * field aligns to what it is being asked), then the recall itself remains a
   * pure read that never excites the field.
   */
  ask(word: string, direction: 'recognition' | 'production' = 'recognition'): QuizAnswer {
    const state = this.requiredState(word);
    const cue = direction === 'production' ? productionCue(state.word) : recognitionCue(state.word);

    this.session.observeText(cue);
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
    const expected = state.word.definition;

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

    return { word: state.word, verdict, answer: question.answer, expected, confidence };
  }

  /**
   * The observer's curiosity: the next word it should review is the one whose
   * trace is weakest — learned-but-decaying words first, then never-asked
   * words, then the rest.
   */
  nextReview(): string | null {
    let best: { word: string; strength: number; prio: number } | null = null;

    for (const state of this.states.values()) {
      if (state.traceId === null) continue;
      const trace = this.traceOf(state.traceId);
      if (trace === undefined) continue;

      // Priority: decaying traces (strength < 0.5) above everything,
      // otherwise weakest first.
      const prio = trace.strength < 0.5 ? 0 : 1;
      if (best === null || prio < best.prio || (prio === best.prio && trace.strength < best.strength)) {
        best = { word: state.word.word, strength: trace.strength, prio };
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
