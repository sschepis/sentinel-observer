/**
 * WORDLOOP FACULTY - teach / ask / grade / retention / report (agent split
 * refactor).
 *
 * The core lesson cycle over the deck states: teaching words as memory
 * traces, quizzing (recognition/production/content), grading against the
 * reliability model, the P9 one-law retention decay (which also decays the
 * learned weights), and the report views. State lives on TeacherAgentCore
 * (states, calibration, lastRecallConfidence, answerGrades,
 * reliabilityModel, cueConfidence, ...).
 */
import { TeacherAgentCore, type Constructor, type CrossFacultyApi } from './base';
import type {
  RecallResult
} from '@sschepis/sentient-core';
import {
  lessonText,
  productionCue,
  recognitionCue
} from '../deck';
import {
  dueIntervalDays,
  decayToward,
  FSRS_TARGET_RETENTION,
  STABILITY_PRESETS
} from '../retention';
import {
  FSRS_INITIAL_DIFFICULTY,
  FSRS_CONSOLIDATED_STABILITY,
  FSRS_OVERDUE_BONUS,
  FSRS_DIFFICULTY_SCALE,
  reviewRetrievability,
  applyRetentionDecay,
  storeSurprise,
  surpriseInitialStability,
  type RetentionParams
} from '../fsrs';
import {
  decayAgedWeights,
  capAgedWeights,
  type WeightMeta
} from '../agedWeights';
import {
  type CalibrationReport
} from '../calibration';
import {
  REVIEW_HISTORY_CAP
} from '../curriculum';
import {
  classifyUtterance
} from '../fade';
import {
  type Relation
} from '../relations';
import {
  GraderReliabilityModel,
  difficultyBandOf,
  type AnswerType,
  type DifficultyBand,
  type GradeCriteria
} from '../reliability';
import {
  DEFAULT_BEHAVIOR_WEIGHTS,
  type BehaviorOption
} from '../drives';
import {
  tokenizeText,
  singularize,
  cosineSimilarity
} from '../context';
import {
  clampRange
} from '@sschepis/sentient-core';
import {
  ANSWER_GRADES_CAP,
  QUIZ_GRADE_DELTA,
  QUIZ_WEAKEN_FLOOR,
  CONTENT_RECALL_FLOOR,
  CONTENT_RECALL_MARGIN,
  normalizedContentTokens,
  SETTLE_DT,
  type WordStatus,
  type WordState,
  type TeachResult,
  type QuizAnswer,
  type GradeVerdict,
  type GradeResult,
  type AnswerGradeEntry,
  type AnswerProvenance,
  type WordDueStatus,
  type WordReport,
  type RetentionReport
} from './support';

export function WordLoopMixin<TBase extends Constructor<TeacherAgentCore & CrossFacultyApi>>(Base: TBase) {
  return class WordLoopFaculty extends Base {

    /**
     * P9 wall-clock forgetting: set every trace's strength to the model's
     * retention prediction at its elapsed interval — word traces on their
     * per-word FSRS stability/difficulty, other traces on the default curve.
     * `forgettingRate` scales stability (2 forgets half as fast).
     *
     * L3 (Phase 19): this is THE one-law application point — the same call
     * that decays traces also decays the learned WEIGHTS (composition n-grams
     * toward the floor with pruning + cap; drive weights toward the archetypal
     * defaults). Weights are memories too.
     */
    applyRetention(now = Date.now()): void {
      const bank = this.session.observer.getMemoryBank();
      const byTrace = new Map<string, RetentionParams>();
      for (const state of this.states.values()) {
        if (state.traceId !== null) {
          byTrace.set(state.traceId, {
            stability: state.stability,
            difficulty: state.difficulty
          });
        }
      }
      applyRetentionDecay(bank.all(), (traceId) => byTrace.get(traceId) ?? null, now, this.tuning.forgettingRate);
      this.decayLearnedWeights(now);
    }

    /**
     * L3 (19.2/19.3): decay the learned weights under the one law.
     *   · Composition n-gram weights decay toward the floor when unused
     *     (fluency fades without practice), prune at the floor (an absent key
     *     is the fresh prior), and the map is hard-capped (weakest-evict).
     *   · Learned drive weights drift toward the archetypal defaults when no
     *     fresh outcome has landed — ancient wins stop dominating.
     */
    protected decayLearnedWeights(now = Date.now()): void {
      decayAgedWeights(this.compositionWeights, this.compositionWeightMeta, now);
      capAgedWeights(this.compositionWeights, this.compositionWeightMeta);
      for (const key of Object.keys(this.behaviorWeights) as BehaviorOption[]) {
        const stored = this.behaviorWeights[key];
        if (stored === undefined) continue;
        const at = this.behaviorOutcomeAt.get(key);
        if (at === undefined) {
          this.behaviorOutcomeAt.set(key, now);
          continue;
        }
        if (now <= at) continue;
        this.behaviorWeights[key] = decayToward(
          stored,
          DEFAULT_BEHAVIOR_WEIGHTS[key],
          now - at,
          STABILITY_PRESETS.driveWeightDays
        );
        this.behaviorOutcomeAt.set(key, now);
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
      if (applied > 0) this.invalidateRelations();
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
        // P9: the schedule is the MODEL — due by timestamp, soon within a day,
        // consolidated by stability (days). Strength is the retention
        // prediction, reported but never the review gate.
        const now = Date.now();
        const DAY = 24 * 60 * 60 * 1000;
        let status: WordDueStatus;
        if (state.dueAt !== null && state.dueAt <= now) {
          status = 'due';
          dueCount += 1;
        } else if (state.dueAt !== null && state.dueAt <= now + DAY) {
          status = 'soon';
        } else if (state.stability >= FSRS_CONSOLIDATED_STABILITY) {
          status = 'consolidated';
          consolidatedCount += 1;
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
      // Surprise-gated storage: a word already explained by an existing trace
      // is LOW surprise — the network already predicts it. Reinforce that
      // trace (re-structure minimally) instead of duplicating a near-identical
      // trace (needless added disorder).
      if (state.traceId !== null) {
        this.session.observer.getMemoryBank().reinforce(state.traceId, 0.1);
        return { word: state.word, traceId: state.traceId, note: 'already in memory — reinforced' };
      }
      const lesson = lessonText(state.word);

      this.session.settleField();
      this.session.observeText(state.word.word);
      this.session.observer.tick(0.02);
      // Store-time surprise (§4.1): recall the word's cue BEFORE storing, so
      // the bank's prediction of the stimulus — its best-recall-score and the
      // candidate-distribution entropy — measures how poorly it already
      // predicts the word. The surprise is recorded on the trace and seeds the
      // FSRS stability instead of the fixed default.
      const cueScores = this.session
        .recall(state.word.word, 5)
        .filter((result) => result.trace.metadata?.kind === undefined)
        .map((result) => result.score);
      const surprise = storeSurprise(cueScores);

      const trace = this.session.storeMemory(lesson, { metadata: { surprise } });
      if (trace !== null) {
        state.traceId = trace.id;
        state.taughtAt = Date.now();
        // P9: a freshly taught word starts on the surprise-scaled curve and is
        // due for its first review immediately (the auto-loop quizzes right
        // after).
        state.stability = surpriseInitialStability(surprise);
        state.difficulty = FSRS_INITIAL_DIFFICULTY;
        state.dueAt = Date.now();
        state.lastIntervalDays = null;
        this.maybePersist();
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
      return this.recallWithCue(state, cue, direction === 'production');
    }

    /**
     * P13: quiz a word with an ARBITRARY cue text — the paraphrase cues of the
     * semantic-recall benchmark. Same recall + comprehension path as ask().
     */
    askCue(word: string, cue: string): QuizAnswer {
      const state = this.requiredState(word);
      return this.recallWithCue(state, cue, true);
    }

    protected recallWithCue(state: WordState, cue: string, allowContent: boolean): QuizAnswer {
      this.session.observeText(cue);
      this.session.observer.tick(0.02);
      // Recognition is about WORD identity: traces the observer stored for
      // other purposes (conversation exchanges, gaps, beliefs, creative
      // answers) must never answer "which trace is this word?". They carry a
      // metadata.kind; word traces are the unmarked ones.
      const results = this.session
        .recall(cue, 5)
        .filter((result) => result.trace.metadata?.kind === undefined);
      let top = results[0] ?? null;
      // P13 COMPREHENSION PATH: the production cue is the DEFINITION, whose
      // words carry DIFFERENT prime signatures than the word's own trace — the
      // overlap term structurally cannot match the word (W11). When the
      // prime-overlap recall fails to retrieve the word's own trace, rank the
      // word traces by CONTENT overlap with the cue: the stored lesson shares
      // the definition's meaning, so the highest-coverage trace IS the word
      // the definition describes. Gated by the same honesty floor as the
      // graded layers — no coverage, no answer. Recognition NEVER uses it —
      // identity is the overlap term's job.
      if (allowContent && (top === null || top.trace.id !== state.traceId)) {
        const content = this.contentRecall(cue);
        if (content !== null && (top === null || content.score >= CONTENT_RECALL_FLOOR)) {
          top = content;
        }
      }
      return {
        word: state.word,
        cue,
        answer: top?.trace.content ?? '',
        recall: top
      };
    }

    /**
     * P13: the comprehension ranking — word traces whose stored lesson shares
     * the cue's tokens, coverage = |cue ∩ lesson| / |cue|. Null below the
     * floor (the observer does not know what the definition describes).
     */
    protected contentRecall(cue: string, ambiguityMargin = 0): RecallResult | null {
      const cueTokens = normalizedContentTokens(cue);
      if (cueTokens.size === 0) return null;
      const bank = this.session.observer.getMemoryBank();
      let best: { trace: RecallResult['trace']; score: number } | null = null;
      let secondScore = 0;
      for (const trace of bank.all()) {
        if (trace.metadata?.kind !== undefined) continue; // word traces only
        const lessonTokens = normalizedContentTokens(trace.content);
        if (lessonTokens.size === 0) continue;
        let covered = 0;
        for (const token of lessonTokens) if (cueTokens.has(token)) covered += 1;
        const score = covered / cueTokens.size;
        if (best === null || score > best.score) {
          secondScore = best?.score ?? 0;
          best = { trace, score };
        } else if (score > secondScore) {
          secondScore = score;
        }
      }
      if (best === null || best.score < CONTENT_RECALL_FLOOR) return null;
      if (best.score - secondScore < ambiguityMargin) return null;
      return {
        trace: best.trace,
        score: best.score,
        smfScore: 0,
        overlapScore: best.score,
        holographicScore: 0,
        consolidated: best.trace.consolidated
      };
    }

    protected identifyMeaning(cue: string): { word: string; recall: RecallResult } | null {
      const recall = this.contentRecall(cue, CONTENT_RECALL_MARGIN);
      if (recall === null) return null;
      for (const state of this.states.values()) {
        if (state.traceId === recall.trace.id) return { word: state.word.word, recall };
      }
      return null;
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
      // L1a: the surprise anchor of THIS review — the time since the LAST
      // review attempt — must be read BEFORE state.lastAskedAt is overwritten
      // below, or the FSRS update would always see a zero elapsed interval.
      const retrievalAnchor: { stability: number; lastAskedAt: number | null; taughtAt: number | null } = {
        stability: state.stability,
        lastAskedAt: state.lastAskedAt,
        taughtAt: state.taughtAt
      };

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
      // EPISODIC MEMORY: the verdict is a MEASURED fact about the human's
      // demonstrated mastery or failure of this word — recorded as a memory
      // the observer can reference in later sessions ("you found X hard").
      this.episodic.noteGrade(state.word.word, verdict);

      state.lastAskedAt = Date.now();
      state.lastGrade = verdict;
      // Phase 24.3 (read-only): the recall-confidence gate's calibration
      // evidence — the score distribution of identity-true vs false recalls.
      if (question.recall !== null) {
        this.calibration.record('quiz-recall', question.recall.score, verdict === 'correct');
      }
      // P-curriculum: every review outcome enters the persisted history —
      // the repeated-gap signal across sessions (capped like strengthHistory).
      state.reviewHistory.push(verdict);
      while (state.reviewHistory.length > REVIEW_HISTORY_CAP) state.reviewHistory.shift();
      if (verdict === 'correct') {
        state.successes += 1;
        // P11: a graded-correct trace is useful to keep — grade evidence feeds
        // the bank's retrieval-usefulness pruning.
        if (state.traceId !== null) {
          this.session.observer.getMemoryBank().bumpUtility(state.traceId, 1);
        }
        // LEARNED GRADIENT: a correct answer credits the answer behavior.
        this.noteBehaviorOutcome('answer', true);
        // PRACTICE: a word that was DUE and just survived a quiz is a
        // successful practice — conservation paid off (P9: due-ness is the
        // model's schedule, not the old strength floor).
        const trace = state.traceId !== null ? this.traceOf(state.traceId) : undefined;
        const wasDue = state.dueAt !== null && state.dueAt <= Date.now();
        if (trace !== undefined && wasDue) {
          this.noteBehaviorOutcome('practice', true);
        }
        // BELIEF: a word that has survived bounds its own learning loop earns
        // a stored self-knowledge — "I know X well." becomes a real memory.
        if (state.successes >= 2) {
          const beliefTrace = state.traceId !== null ? this.traceOf(state.traceId) : undefined;
          const strength = beliefTrace?.strength ?? 0;
          this.storeBelief(state.word.word, `I know ${state.word.word} well.`, 'know', { strength, grades: state.successes });
        }
      } else {
        state.failures += 1;
        // LEARNED GRADIENT: a wrong answer credits the answer behavior as a
        // loss.
        this.noteBehaviorOutcome('answer', false);
        // BELIEF CONTRADICTION — the second-order event: a stored "I know X
        // well." contradicted by experience stores a REVISING belief ("I
        // thought I knew X") and demotes the original belief trace, so an
        // outdated self-knowledge decays like any memory that stopped being
        // true.
        const positive = this.latestBelief(state.word.word);
        if (positive !== null && !positive.contradicts && positive.beliefKind === 'know') {
          this.storeBelief(
            state.word.word,
            `I thought I knew ${state.word.word}, but I just failed it.`,
            'revise',
            { strength: positive.strength, failures: state.failures },
            true
          );
          this.session.observer.getMemoryBank().reinforce(positive.traceId, -0.2);
        }
        // P7 SURGICAL WEAKENING: a wrong grade weakens the PRODUCING trace
        // itself (the memory that should have been recalled), not the whole
        // bank — gated by a floor so a single slip never erases a practiced
        // word; below the floor the trace decays passively instead.
        // L1a (Phase 17.5): the weakening is SURPRISE-SCALED — a confidently
        // wrong recall (high recall score on the wrong trace) weakens more than
        // a marginal one; a blank answer falls back to the producing trace's
        // own strength (a strong memory that failed to surface is a larger
        // surprise than a weak one).
        if (state.traceId !== null) {
          const producing = this.traceOf(state.traceId);
          if (producing !== undefined && producing.strength > QUIZ_WEAKEN_FLOOR) {
            const recallScore = question.recall?.score ?? producing.strength;
            const surprise = clampRange(recallScore, 0, 1);
            this.session.observer.getMemoryBank().reinforce(state.traceId, -QUIZ_GRADE_DELTA * surprise);
          }
        }
      }
      // P9 FSRS UPDATE: the review history IS the model's training data.
      // L1a (Phase 17): the update is SURPRISE-SCALED — the model's own
      // retention prediction at review time (reviewRetrievability) is the
      // surprise signal. A correct recall stretches stability by the classic
      // e^(−D/8) gain (less for hard words), PLUS an overdue bonus that grows
      // as the recall happens further past the due date; a wrong one keeps
      // clamp(1 − R, 0.05, 0.5) of its stability — a crammed lapse (R ≈ 1)
      // collapses to the floor, an on-time lapse keeps today's 0.1, an overdue
      // lapse keeps up to half (the forgetting already happened) — and raises
      // difficulty. The 2026-09 review's inverted multiplier (difficulty
      // scaling the COLLAPSE upward, punishing easy words hardest) is gone:
      // difficulty shapes the success gain only, as in FSRS v4. The next
      // review is scheduled when the model predicts the target retention.
      //
      // GRADER RELIABILITY: the update is weighted by the quiz bucket's
      // feedback weight — when re-grade outcomes and world feedback have shown
      // that grades in this answer-type/difficulty band are unreliable, the
      // schedule moves more conservatively (the deltas shrink, never the
      // direction). At the prior (no evidence) the weight is 1 and the update
      // is exactly the classic one.
      const quizCriteria: GradeCriteria = {
        answerType: question.cue.trim().toLowerCase() === state.word.word ? 'definition' : 'spelling',
        difficultyBand: difficultyBandOf(state.difficulty),
        template: 'quiz',
        provider: 'rule'
      };
      const fsrsWeight = this.reliabilityModel.feedbackWeight(quizCriteria);
      // L1a: SURPRISE IS SCHEDULE-RELATIVE. The model predicts a word at
      // target retention R = 0.9 at its due date — that is the scheduled
      // moment, NOT a surprise. R_eff = R / target therefore reads:
      //   · R_eff ≈ 1 at the due date — the on-time review, whose success gain
      //     (e^(κ(1−R_eff)) − 1 ≈ e^0 − 1 ≈ 0... at κ the gain below) and
      //     lapse keep (≈ 0.5) are calibrated to today's curve;
      //   · R_eff ≈ 1.11 for a crammed review (R ≈ 1 > target) — clamped to 1:
      //     an early correct review earns ~no gain and an early lapse keeps the
      //     0.05 floor — cramming is not rewarded;
      //   · R_eff < 1 for an OVERDUE review — a correct recall of a word the
      //     model thought was nearly gone is the genuinely surprising event
      //     (gain grows), while an overdue lapse keeps MORE stability (the
      //     forgetting already happened; R was already low).
      if (verdict === 'correct') {
        // Success (17.2): at or before the due date, R_eff = 1 and the gain is
        // exactly the pre-L1a growth; an OVERDUE correct recall (R_eff < 1)
        // earns the surprise bonus — rescuing a nearly-forgotten word is the
        // event that stretches stability most.
        const retrievalEff = Math.min(reviewRetrievability(retrievalAnchor) / FSRS_TARGET_RETENTION, 1);
        const gain =
          fsrsWeight *
          (1 + FSRS_OVERDUE_BONUS * (1 - retrievalEff)) *
          Math.exp(-state.difficulty / FSRS_DIFFICULTY_SCALE);
        state.stability = state.stability * (1 + gain);
        state.difficulty = Math.max(1, state.difficulty - 0.1 * fsrsWeight);
      } else {
        // Lapse (17.3): keep = clamp(1 − R, 0.05, 0.5) — pure surprise, no
        // difficulty term (the 2026-09 review's inverted multiplier is gone).
        //   · crammed lapse (R ≈ 1): the model was ~certain — keeps the 0.05
        //     floor, the harshest collapse in the system;
        //   · on-time lapse (R = 0.9): keeps 0.1 — exactly today's
        //     mid-difficulty behavior, the calibration anchor;
        //   · overdue lapse (R ≤ 0.5): keeps up to 0.5 — the forgetting
        //     already happened, the grade adds little information.
        const retrieval = reviewRetrievability(retrievalAnchor);
        const keep = clampRange(1 - retrieval, 0.05, 0.5);
        state.stability = Math.max(0.01, state.stability * (fsrsWeight * keep + (1 - fsrsWeight)));
        state.difficulty = Math.min(10, state.difficulty + 0.4 * fsrsWeight);
      }
      state.lastIntervalDays = dueIntervalDays(state.stability);
      state.dueAt = Date.now() + Math.round(state.lastIntervalDays * 24 * 60 * 60 * 1000);
      // The retention record samples the model's prediction (the trace's
      // strength IS retention), capped like before.
      if (state.traceId !== null) {
        const trace = this.traceOf(state.traceId);
        if (trace !== undefined) {
          state.strengthHistory.push({ at: Date.now(), strength: trace.strength });
          while (state.strengthHistory.length > 100) state.strengthHistory.shift();
        }
      }
      // P7 GRADE LEDGER: who produced this answer and how it was graded.
      this.recordAnswerGrade(word, 'quiz', verdict, {
        traceIds: state.traceId !== null ? [state.traceId] : [],
        edges: [],
        operatorId: undefined
      });
      this.maybePersist();

      return { word: state.word, verdict, answer: question.answer, expected, confidence };
    }

    /**
     * Append one graded answer to the bounded provenance ledger (P7). The
     * oldest entries fall off; the record names exactly which traces and edges
     * produced the graded answer, so a future failure can be repaired
     * surgically (P8 consumes the edge refs for per-edge confidence).
     */
    recordAnswerGrade(
      utterance: string,
      mode: string,
      verdict: AnswerGradeEntry['verdict'],
      provenance: AnswerProvenance
    ): void {
      this.answerGrades.push({
        at: Date.now(),
        utterance,
        mode,
        verdict,
        traceIds: provenance.traceIds,
        edges: provenance.edges,
        operatorId: provenance.operatorId,
        ruleIds: provenance.ruleIds
      });
      if (this.answerGrades.length > ANSWER_GRADES_CAP) {
        this.answerGrades.splice(0, this.answerGrades.length - ANSWER_GRADES_CAP);
      }
    }

    /** The bounded grade ledger (P7) — the surgical-repair record. */
    answerGradeLedger(): readonly AnswerGradeEntry[] {
      return this.answerGrades;
    }

    /** THE GRADER RELIABILITY MODEL — exposed so the corroboration and
     *  curriculum modules can query per-bucket reliability before acting on
     *  grade-sourced evidence (evidence(), pendingRegrades(), resolveRegrade). */
    graderReliability(): GraderReliabilityModel {
      return this.reliabilityModel;
    }

    /** The reliability evidence of an explicit criteria tuple (for modules
     *  that already know their bucket). */
    reliabilityOf(criteria: GradeCriteria): ReturnType<GraderReliabilityModel['evidence']> {
      return this.reliabilityModel.evidence(criteria);
    }

    /** The reliability evidence of a graded answer, built from the answer's
     *  own shape: question template (fade classification), answer type, FSRS
     *  difficulty band, and provider ('' = unknown — the provider dimension is
     *  skipped, the other three still apply). */
    reliabilityOfUtterance(utterance: string, answerType: AnswerType, difficulty: number, provider = ''): ReturnType<GraderReliabilityModel['evidence']> {
      return this.reliabilityModel.evidence({
        answerType,
        difficultyBand: difficultyBandOf(difficulty),
        template: classifyUtterance(utterance),
        provider
      });
    }

    /** The FSRS difficulty band of a graded answer's seed memories: the mean
     *  difficulty of the deck words whose traces were the seeds (5 when no
     *  word trace is among them). */
    difficultyBandOfSeeds(seedTraceIds: readonly string[]): DifficultyBand {
      const traceIdSet = new Set(seedTraceIds);
      let sum = 0;
      let count = 0;
      for (const state of this.states.values()) {
        if (state.traceId !== null && traceIdSet.has(state.traceId)) {
          sum += state.difficulty;
          count += 1;
        }
      }
      return difficultyBandOf(count === 0 ? FSRS_INITIAL_DIFFICULTY : sum / count);
    }

    /** The trace strength of a taught word (read-only introspection). */
    recallStrengthOf(word: string): number | null {
      const state = this.states.get(word);
      if (state === undefined || state.traceId === null) return null;
      return this.session.observer.getMemoryBank().get(state.traceId)?.strength ?? null;
    }

    /** Words whose traces have consolidated. */
    consolidatedWords(limit = 5): string[] {
      const bank = this.session.observer.getMemoryBank();
      const found: string[] = [];
      for (const state of this.states.values()) {
        if (state.traceId === null || found.length >= limit) continue;
        const trace = bank.get(state.traceId);
        if (trace !== undefined && trace.consolidated === true) found.push(state.word.word);
      }
      return found;
    }

    /** Phase 24.3: one gate's calibration drift report (read-only). */
    calibrationReport(gate: string): CalibrationReport {
      return this.calibration.report(gate);
    }

    /** Phase 24.3: every measured calibration gate. */
    calibrationGates(): string[] {
      return this.calibration.gateNames();
    }

    /** The stored seed contents most resembling a phrase (for novelty
     *  scoring — the echo-distance reference). */
    recallSeedContents(phrase: string): string[] {
      return this.recallMemories(phrase, 4).map((memory) => memory.content);
    }

    /**
     * Perturb the field with an utterance and let it CONVERGE: several
     * relaxation ticks so the SMF settles into the moment — the agreement
     * state — before recall matches against it. This is the mechanism behind
     * moment-grounded recall: the memory that resonates with the converged
     * moment is the answer, and fuzzy partial overlaps fail to form a coherent
     * attractor.
     */
    exciteAndSettle(utterance: string): void {
      this.session.settleField();
      this.session.observeText(utterance);
      this.session.observer.tick(0.02);
      for (let step = 0; step < this.settleSteps; step += 1) {
        this.session.observer.tick(SETTLE_DT);
      }
    }

    /**
     * The observer's own relevant memories for an utterance: the top recalled
     * conversation/creative traces (content + id + recall score),
     * relevance-ranked. The field is excited and CONVERGED first — the moment
     * selects what resonates. Used by creative composition AND by the hybrid
     * voice (the LLM speaks conditioned on these — the observer's memories,
     * not a blank model).
     */
    recallMemories(utterance: string, topK = 6): Array<{ content: string; id: string; score: number }> {
      const cue = utterance.trim();
      if (cue.length === 0) return [];
      this.exciteAndSettle(utterance);
      const results = this.session.recall(utterance, 10);

      // The MOMENT: the converged per-prime amplitude distribution of the
      // oscillator field. Traces whose stored imprint RESONATES with the
      // moment are the material — the field picks what to build from, not a
      // word-count heuristic.
      const bank = this.session.observer.getMemoryBank();
      const momentAmplitudes = this.session.observer.getOscillatorField().getState().amplitudes;

      const utteranceTokens = new Set(tokenizeText(cue).map(singularize));
      const ranked: Array<{ content: string; id: string; score: number; overlap: number; resonance: number }> = [];
      for (const result of results) {
        const kind = result.trace.metadata?.kind;
        if (kind !== 'conversation' && kind !== 'creative') continue;
        const content = result.trace.content.trim();
        if (content.length === 0 || ranked.some((entry) => entry.content === content)) continue;
        const contentTokens = new Set(tokenizeText(content).map(singularize));
        let overlap = 0;
        for (const token of utteranceTokens) {
          if (contentTokens.has(token)) overlap += 1;
        }
        const trace = bank.get(result.trace.id);
        const resonance = trace !== undefined ? cosineSimilarity(momentAmplitudes, trace.amplitudes ?? []) : 0;
        ranked.push({ content, id: result.trace.id, score: result.score, overlap, resonance });
      }
      // The moment selects (resonance first); token overlap breaks ties.
      ranked.sort((a, b) => b.resonance - a.resonance || b.overlap - a.overlap);
      return ranked.slice(0, topK).map((entry) => ({ content: entry.content, id: entry.id, score: entry.score }));
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

    /** The recall confidence of a taught phrase (0 when never recalled). */
    phraseStrength(cue: string): number {
      return this.cueConfidence.get(cue.trim().toLowerCase()) ?? 0;
    }
  };
}
