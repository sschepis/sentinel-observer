/**
 * CURRICULUM FACULTY — review queues + curriculum ranking (agent split refactor).
 *
 * Review scheduling moved from a flat "earliest dueAt" policy to a
 * difficulty-targeted curriculum queue: due words first scored by FSRS
 * difficulty + overdue + sparse semantic neighborhood + failure history, then
 * never-taught words (sparse-first). State: curriculumConfig and the lazy
 * curriculumVocabCache live on TeacherAgentCore; drillFailures too.
 */
import { TeacherAgentCore, type Constructor, type CrossFacultyApi } from './base';

import { nextCurriculumWord, rankCurriculum, rankLegacy, REVIEW_HISTORY_CAP, type CurriculumConfig, type CurriculumContext, type CurriculumItem } from '../curriculum';
import { semanticVocabulary } from '../semanticSignature';
import { clampRange } from '@sschepis/sentient-core';
import { primeSignature, PRIME_SPACE } from '../primeSignature';
import { FSRS_INITIAL_DIFFICULTY, FSRS_INITIAL_STABILITY } from '../fsrs';
import { WORD_SHAPE } from '../../curriculum/types';

/** What growVocabulary did. */
export interface VocabularyGrowth {
  /** Words added, in order, with the signature each received. */
  added: Array<{ word: string; primes: number[] }>;
  /** Words refused: already known, wrong shape, or a duplicate in the request. */
  skipped: number;
}



export function CurriculumMixin<TBase extends Constructor<TeacherAgentCore & CrossFacultyApi>>(Base: TBase) {
  return class CurriculumFaculty extends Base {

    /**
     * APPEND-ONLY VOCABULARY GROWTH. A corpus states things about words the
     * deck never taught ("zebu is-a mammal"). The observer can hold such a
     * word the way it holds a word it has heard but cannot define: a
     * word-only entry (empty definition — recognition quizzes only, encounter
     * counts drive the curiosity to ask what it means) with its own prime
     * signature, so it encodes, recalls and joins the relation graph like any
     * deck word.
     *
     * The signature is the plain hash scheme (primeSignature), salted until
     * it collides with nothing the observer already holds. NOTHING EXISTING
     * MOVES: every stored trace was encoded under the deck's signatures, and
     * the bench (vocabularyGrowth.test.ts) asserts they are byte-identical
     * after growth. The deck-derived fingerprint is untouched — grown words
     * are persisted separately, with their exact primes, and re-added on
     * restore. Single tokens only: a multi-word concept has no token here.
     *
     * `primes` may be supplied (restore) — then the word is re-added with
     * exactly that signature and never re-salted.
     */
    growVocabulary(words: ReadonlyArray<string | { word: string; primes: readonly number[] }>): VocabularyGrowth {
      const observer = this.session.observer;
      const added: VocabularyGrowth['added'] = [];
      let skipped = 0;
      // Every signature already in use — the deck's and the grown ones — so a
      // new word never lands on an existing one.
      const used = new Set<string>();
      for (const word of this.states.keys()) {
        const signature = observer.vocabularySignature(word);
        if (signature !== undefined) used.add(signature.join(','));
      }
      for (const primes of this.grownWords.values()) used.add(primes.join(','));
      for (const entry of words) {
        const word = (typeof entry === 'string' ? entry : entry.word).trim().toLowerCase();
        // Two letters at least: a one-letter "word" is a letter, not a word to know.
        if (word.length < 2 || !WORD_SHAPE.test(word) || this.states.has(word) || observer.vocabularySignature(word) !== undefined) {
          skipped += 1;
          continue;
        }
        let primes: number[];
        if (typeof entry !== 'string') {
          primes = [...entry.primes];
        } else {
          let salt = 0;
          primes = primeSignature(word, PRIME_SPACE, salt);
          while (used.has(primes.join(','))) {
            salt += 1;
            primes = primeSignature(word, PRIME_SPACE, salt);
          }
        }
        used.add(primes.join(','));
        observer.extendVocabulary({ [word]: primes });
        (this.knownWords as Set<string>).add(word);
        this.states.set(word, {
          word: { word, definition: '', example: '' },
          traceId: null,
          taughtAt: null,
          lastAskedAt: null,
          lastGrade: null,
          successes: 0,
          failures: 0,
          strengthHistory: [],
          stability: FSRS_INITIAL_STABILITY,
          difficulty: FSRS_INITIAL_DIFFICULTY,
          dueAt: null,
          lastIntervalDays: null,
          reviewHistory: []
        });
        this.grownWords.set(word, primes);
        added.push({ word, primes });
      }
      if (added.length > 0) {
        // The sparsity neighborhood and the relation graph both index the
        // vocabulary; both re-derive on the next read.
        this.curriculumVocabCache = null;
        this.invalidateRelations();
      }
      return { added, skipped };
    }

    /** The grown words with their signatures (persisted; read-only). */
    grownWordList(): Array<{ word: string; primes: number[] }> {
      return [...this.grownWords.entries()].map(([word, primes]) => ({ word, primes: [...primes] }));
    }

    /** Whether the observer knows a word exists (deck or grown). */
    knowsWord(word: string): boolean {
      return this.states.has(word.trim().toLowerCase());
    }

    /**
     * The observer's curiosity: the next word that NEEDS review. P9: the
     * schedule is the model — a word is due when its FSRS `dueAt` has passed
     * (the interval that decayed stability to the target retention). P-curriculum:
     * WITHIN the due pool the queue is ordered by the difficulty-targeted
     * score (FSRS difficulty + overdue-relative-to-interval + sparse semantic
     * neighborhood + repeated-gap history + drill weakness), so a hard,
     * overdue, isolated word with a failure streak is reviewed before a
     * merely-due one. Untaught words follow (sparse neighborhoods first), so
     * the loop still feeds new material. Returns null when nothing is due and
     * nothing is new.
     */
    nextReview(): string | null {
      if (this.curriculumConfig.enabled === false) {
        return this.legacyNextReview();
      }
      return nextCurriculumWord(this.curriculumItems(), this.curriculumContext());
    }

    /** The pre-curriculum scheduler verbatim: earliest dueAt, tie → lowest
     *  stability, then the first untaught word. The benchmark control. */
    protected legacyNextReview(): string | null {
      const now = Date.now();
      let bestDue: { word: string; dueAt: number; stability: number } | null = null;
      let bestNew: string | null = null;

      for (const state of this.states.values()) {
        if (state.traceId === null) {
          if (bestNew === null) bestNew = state.word.word;
          continue;
        }
        if (state.dueAt !== null && state.dueAt <= now) {
          if (
            bestDue === null ||
            state.dueAt < bestDue.dueAt ||
            (state.dueAt === bestDue.dueAt && state.stability < bestDue.stability)
          ) {
            bestDue = { word: state.word.word, dueAt: state.dueAt, stability: state.stability };
          }
        }
      }
      return bestDue !== null ? bestDue.word : bestNew;
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

    /** The next word the observer has never been taught — sparse semantic
     *  neighborhoods first (isolated words have no resonance partners, so
     *  they need the explicit lesson most). */
    nextNewWord(): string | null {
      if (this.curriculumConfig.enabled === false) {
        for (const state of this.states.values()) {
          if (state.traceId === null) return state.word.word;
        }
        return null;
      }
      const fresh = this.curriculumItems().filter((item) => item.traceId === null);
      return nextCurriculumWord(fresh, this.curriculumContext());
    }

    /**
     * The P-curriculum scoring context: the semantic vocabulary over the
     * teacher's own deck (lazy, cached) plus the persisted drill failures.
     * `now` is injectable for deterministic scheduling tests.
     */
    curriculumContext(now?: number): CurriculumContext {
      return {
        vocabulary: this.curriculumVocabulary(),
        drillFailures: this.drillFailuresSnapshot(),
        goalStalls: this.goalStallsSnapshot(),
        now,
        weights: this.curriculumConfig.weights
      };
    }

    /** The lazy semantic vocabulary over this teacher's deck — the sparsity
     *  signal's neighborhood graph. Computed once (≈75 ms at the 20k deck). */
    curriculumVocabulary(): Record<string, number[]> {
      if (this.curriculumVocabCache === null) {
        this.curriculumVocabCache = semanticVocabulary(
          [...this.states.values()].map((state) => ({ word: state.word.word, definition: state.word.definition }))
        );
      }
      return this.curriculumVocabCache;
    }

    /**
     * The prioritized lesson queue: due words first (curriculum-scored), then
     * never-taught words (sparse-first), then healthy learned words when
     * asked. Read-only — the auto-loop consumes it via nextReview.
     */
    curriculumQueue(options: { includeHealthy?: boolean; limit?: number } = {}): ReturnType<typeof rankCurriculum> {
      return rankCurriculum(this.curriculumItems(), this.curriculumContext(), options);
    }

    /** The state snapshot the curriculum ranks on (word → string, no refs). */
    protected curriculumItems(): CurriculumItem[] {
      return [...this.states.values()].map((state) => ({
        word: state.word.word,
        traceId: state.traceId,
        dueAt: state.dueAt,
        stability: state.stability,
        difficulty: state.difficulty,
        lastIntervalDays: state.lastIntervalDays,
        reviewHistory: state.reviewHistory
      }));
    }

    /**
     * Record a drill round's verdict — the weak-drill curriculum signal.
     * A concept that INDUCED (or compiled) a rule is no longer weak; anything
     * else that keeps failing stays on the queue. Persisted with the learning
     * state, so weakness survives reloads.
     */
    recordDrillResult(concept: string, verdict: 'unlearned' | 'memorized' | 'induced' | 'rule-induced'): void {
      if (verdict === 'induced' || verdict === 'rule-induced') {
        this.drillFailures.delete(concept);
      } else {
        const failures = (this.drillFailures.get(concept) ?? 0) + 1;
        this.drillFailures.set(concept, Math.min(failures, 10));
      }
      this.maybePersist();
    }

    /** Consecutive failed drill rounds per concept (read-only). Built on a
     *  null-prototype record: a concept named 'constructor' must read as its
     *  own count — or undefined — never as the inherited Object.prototype
     *  function (which made `clampRange(NaN)` throw inside the curriculum). */
    drillFailuresSnapshot(): Record<string, number> {
      return Object.assign(Object.create(null) as Record<string, number>, Object.fromEntries(this.drillFailures));
    }

    /** Stalled goals per target (TASKS.md #18) — the curriculum's stall
     *  signal, read-only. Null-prototype for the same reason as above. */
    goalStallsSnapshot(): Record<string, number> {
      return Object.assign(Object.create(null) as Record<string, number>, Object.fromEntries(this.goalStalls));
    }

    /** The pre-curriculum due-order ranking, for comparison/introspection. */
    legacyQueue(): ReturnType<typeof rankLegacy> {
      return rankLegacy(this.curriculumItems());
    }
  };
}
