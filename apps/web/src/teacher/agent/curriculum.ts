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



export function CurriculumMixin<TBase extends Constructor<TeacherAgentCore & CrossFacultyApi>>(Base: TBase) {
  return class CurriculumFaculty extends Base {

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

    /** The pre-curriculum due-order ranking, for comparison/introspection. */
    legacyQueue(): ReturnType<typeof rankLegacy> {
      return rankLegacy(this.curriculumItems());
    }
  };
}
