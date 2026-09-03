import type { RecallResult } from '@sschepis/sentient-core';
import type { ObserverSession } from '../observer/engine';
import type { PersistenceStore } from '../persistence/store';
import { lessonText, productionCue, recognitionCue, hasDefinition, type DeckWord } from './deck';
import { retentionProbability, dueIntervalDays, decayToward, FSRS_TARGET_RETENTION, STABILITY_PRESETS } from './retention';
import {
  FSRS_INITIAL_STABILITY,
  FSRS_INITIAL_DIFFICULTY,
  FSRS_CONSOLIDATED_STABILITY,
  FSRS_OVERDUE_BONUS,
  FSRS_DIFFICULTY_SCALE,
  reviewRetrievability,
  applyRetentionDecay,
  type RetentionParams
} from './fsrs';
import { bumpAgedWeights, decayAgedWeights, capAgedWeights, type WeightMeta } from './agedWeights';
import { CalibrationLedger, type CalibrationReport } from './calibration';
import {
  CONVERSATION_RECALL_FLOOR,
  CREATIVE_UNLOCK_THRESHOLD,
  composeCreativeResponse,
  type ConversationPair,
  type CreativeComposition,
  type TransitionWeights
} from './conversation';
import { applyOperator, isClockOrDateQuestion, clockAnswer, clusterGaps, questionFormOf, parseNegationStatement, type OperatorResult } from './operators';
import { composeGrounded, criticize, groundedSubjects, hedgeComposition, framesFor } from './groundedFrames';
import { deniedFromNegations } from './chain';
import { readText } from './reading';
import { LearnedFrameStore } from './learnedFrames';
import { chooseGoal, executeGoalStep, goalId, type LearningGoal, type GoalType } from './plan';
import {
  nextCurriculumWord,
  rankCurriculum,
  rankLegacy,
  REVIEW_HISTORY_CAP,
  type CurriculumConfig,
  type CurriculumContext,
  type CurriculumItem
} from './curriculum';
import { semanticVocabulary } from './semanticSignature';
import { classifyUtterance, blendReward, fadeCriteria, type GradeClass } from './fade';
import { JUDGE_COMPOSITE } from './trust';
import { compositeScore } from './composite';
import { groundingScore, groundingAttribution, stripHedges } from './grounding';
import { extractRelations, mergeRelations, reconcileRelations, predicateVerb, sourceClassForOrigin, isSourceClass, type Relation, type RelationPredicate, type Negation, type SourceClass } from './relations';
import {
  corroborationConfidence,
  distinctClasses,
  evidenceInText
} from './corroboration';
import {
  GraderReliabilityModel,
  difficultyBandOf,
  gradeBandOf,
  ruleBandForGrounding,
  bandsAgree,
  GRADE_STRONG_THRESHOLD,
  WORLD_FEEDBACK_WEIGHT,
  type AnswerType,
  type DifficultyBand,
  type GradeBand,
  type GradeCriteria,
  type ReliabilitySnapshot
} from './reliability';
import { RelationalHologram, mulberry32 } from '@sschepis/sentient-core';
import { matchArgs, evaluate, canonicalNumber, conversionPairOf, type DSLExpr } from './technical/dsl';
import { RuleStore, RULE_GRADE_DELTA, type DerivationDenial, type RewriteRule, type RuleOrigin } from './rules/types';
import { PEANO_RULES, natFromDecimal, natToDecimal } from './rules/peano';
import { DIGITS_RULES } from './rules/digits';
import { INT_RULES } from './rules/int';
import { LOGIC_RULES } from './rules/logic';
import { ALG_RULES } from './rules/alg';
import { reduce } from './rules/engine';
import { parseRewritePrompt, decodeNormalForm } from './rules/parse';
import { CompositionRuleStore } from './rules/compositionSeeds';
import { induceRuleSet, validateHeldOut, type InductionInstance } from './rules/induction';
import { termBits, termToString } from './rules/terms';
import { generateExercises, chanceLevel } from './technical/verify';
import { rewriteTargetFor, INDUCTION_MARGIN, MIN_INDUCTION_HITS } from './technical/drill';
import { RULE_CORROBORATION_HORIZON_MS, drillForRuleName } from './rules/maintenance';
import { parseTaughtRule, validateTaughtRule, taughtRuleSpecFor, type TaughtRuleSpec } from './rules/instruction';
import { technicalRelations } from './technical';
import { SUPPLEMENTAL_RELATIONS } from './decks/relationSupplements';
import { GROUNDED_FACTS_RELATIONS } from './decks/groundedFacts';
import { OperatorLearner } from './operators/learning';
import { TokenCostModel } from './mdl';
import { ACTIVE_DECK } from './decks';
import { loadConversations } from './conversations';
import { computeDrives, chooseBehavior, updateDriveWeight, ARCHETYPAL_BEHAVIORS, DEFAULT_BEHAVIOR_WEIGHTS, type DriveSignals, type DriveState, type BehaviorOption, type BehaviorWeights } from './drives';
import { WorkingMemory, resolveReferences, extractUnknownSubject, tokenizeText, singularize, isContentWord, cosineSimilarity, type WorkingTurn } from './context';
import { EpisodicMemory, EPISODIC_SPOKEN_RELEVANCE_FLOOR, type EpisodicFact, type RememberedFact } from './episodic';
import { clampRange } from '@sschepis/sentient-core';
import {
  BOOTSTRAP_VERSION,
  BOOTSTRAP_MIN_SUPPORTED_VERSION,
  BOOTSTRAP_VOCABULARY_SCHEME,
  type BootstrapRecord
} from './bootstrap';
import { TeacherAgentCore, type Constructor, type CrossFacultyApi } from './agent/base';
import { GoalsMixin } from './agent/goals';
import { AutoLoopMixin } from './agent/autoloop';
import { CurriculumMixin } from './agent/curriculum';
import { OperatorsMixin } from './agent/operators';
import { RulesMixin } from './agent/rules';
import { RelationsMixin } from './agent/relations';
import { MotivationMixin } from './agent/motivation';
import { ConversationMixin } from './agent/conversation';
import { WordLoopMixin } from './agent/wordloop';
import { CreativeMixin } from './agent/creative';
import { PersistenceMixin } from './agent/persistence';
import {
  // Module-scope vocabulary moved to agent/support.ts (public names are
  // re-exported below; the internal ones are imported for the class body).
  CREATIVE_REINFORCE_SCORE,
  VERIFY_UNLOCK_THRESHOLD,
  RETENTION_FRACTION,
  CREATIVE_WEAKEN_SCORE,
  REVIEW_STRENGTH_THRESHOLD,
  SOON_STRENGTH_THRESHOLD,
  RECALL_SETTLE_STEPS,
  PERSIST_DEBOUNCE_MS,
  PERSIST_MAX_DELAY_MS,
  isTouchedWordState,
  ANSWER_GRADES_CAP,
  SWEEP_RESOLVED_CAP,
  EMPTY_PROVENANCE,
  edgeKey,
  operatorEdges,
  creativeGradeDelta,
  CREATIVE_GRADE_DELTA,
  QUIZ_GRADE_DELTA,
  QUIZ_WEAKEN_FLOOR,
  CONTENT_RECALL_FLOOR,
  CONTENT_RECALL_MARGIN,
  meaningCueOf,
  normalizedContentTokens,
  CONVERSATION_HIGH_CONFIDENCE,
  CONVERSATION_MIN_MARGIN,
  READING_WORD_BUDGET,
  authoritativeRecall,
  sleep,
  SETTLE_DT,
  matchesCue,
  isStaleEncoding,
  type CompiledRule,
  type WordStatus,
  type WordState,
  type TeachResult,
  type QuizAnswer,
  type GradeVerdict,
  type GradeResult,
  type ConversationAnswer,
  type ConversationReport,
  type EdgeRef,
  type AnswerGradeEntry,
  type AnswerProvenance,
  type ChatAnswer,
  type ChatAnswerWithMemory,
  type CreativeReply,
  type AutoLoopPhase,
  type AutoLoopStep,
  type AutoLoopHandle,
  type AutoLoopOptions,
  type WordDueStatus,
  type WordReport,
  type RetentionReport
} from './agent/support';

export { retentionProbability, dueIntervalDays, FSRS_TARGET_RETENTION } from './retention';
export {
  FSRS_INITIAL_STABILITY,
  FSRS_INITIAL_DIFFICULTY,
  FSRS_CONSOLIDATED_STABILITY,
  reviewRetrievability,
  applyRetentionDecay,
  type RetentionParams
} from './fsrs';
// The previously-public module-scope surface, frozen (see agent/support.ts).
export {
  CREATIVE_REINFORCE_SCORE,
  VERIFY_UNLOCK_THRESHOLD,
  RETENTION_FRACTION,
  CREATIVE_WEAKEN_SCORE,
  creativeGradeDelta,
  REVIEW_STRENGTH_THRESHOLD,
  SOON_STRENGTH_THRESHOLD,
  RECALL_SETTLE_STEPS
} from './agent/support';
export type {
  CompiledRule,
  WordStatus,
  WordState,
  TeachResult,
  QuizAnswer,
  GradeVerdict,
  GradeResult,
  ConversationAnswer,
  ConversationReport,
  EdgeRef,
  AnswerGradeEntry,
  AnswerProvenance,
  ChatAnswer,
  ChatAnswerWithMemory,
  CreativeReply,
  AutoLoopPhase,
  AutoLoopStep,
  AutoLoopHandle,
  AutoLoopOptions,
  WordDueStatus,
  WordReport,
  RetentionReport
} from './agent/support';

const TeacherAgentComposed = PersistenceMixin(
  CreativeMixin(
    WordLoopMixin(
      ConversationMixin(
        MotivationMixin(
          RelationsMixin(
            RulesMixin(
              CurriculumMixin(
                OperatorsMixin(AutoLoopMixin(GoalsMixin(TeacherAgentCore as unknown as Constructor<TeacherAgentCore & CrossFacultyApi>)))
              )
            )
          )
        )
      )
    )
  )
);

export class TeacherAgent extends TeacherAgentComposed {
  /** P12 held-out gate: edge keys hidden from the symbolic graph only. */
  protected readonly hiddenRelationKeys: ReadonlySet<string> | null;

  /** Adjust behaviour that is read at the point of use. */
  setTuning(next: Partial<{ forgettingRate: number; reviewThreshold: number }>): void {
    if (typeof next.forgettingRate === 'number' && Number.isFinite(next.forgettingRate)) {
      this.tuning.forgettingRate = Math.max(0.01, next.forgettingRate);
    }
    if (typeof next.reviewThreshold === 'number' && Number.isFinite(next.reviewThreshold)) {
      this.tuning.reviewThreshold = Math.min(0.99, Math.max(0.01, next.reviewThreshold));
    }
  }

  constructor(
    session: ObserverSession,
    deck: readonly DeckWord[],
    persistence: PersistenceStore | null = null,
    /**
     * Persist the full record only every Nth teach/grade/respond — batch
     * training otherwise pays O(n) serialization per word (O(n²) overall,
     * which visibly crawls from the halfway point). The UI defaults to 1
     * (persist on every action); the batch CLI uses a coarser cadence and
     * calls persistAll() explicitly at the end.
     */
    persistEvery = 1,
    /**
     * Convergence steps after a perturbation: the field relaxes into the
     * MOMENT (the agreement state) before recall matches against it —
     * thinking is coherence making, and recall reads the converged moment.
     */
    settleSteps = RECALL_SETTLE_STEPS,
    /**
     * Determinism seed for the composition PRNG (P5). When provided, every
     * creative draw (seed pick, next-word roll, frame pick) is reproducible
     * — the same state produces the same sentence. Absent: Math.random.
     */
    compositionSeed?: number,
    /**
     * P12 HELD-OUT GATE: edge keys (subject\u0000predicate\u0000object) hidden
     * from the SYMBOLIC graph only. The loose hologram still binds them, so
     * chain questions recover through the graded layer — the held-out
     * relational-reasoning measurement.
     */
    hiddenRelationKeys?: ReadonlySet<string>,
    /**
     * P-curriculum: difficulty-targeted lesson priority. Enabled by default;
     * `{ enabled: false }` restores the pre-curriculum scheduler (earliest
     * dueAt, deck-order new words) — the honest benchmark control.
     */
    curriculumConfig?: CurriculumConfig,
    /**
     * The session-gap threshold for the episodic memory (default 30 min).
     * Exposed so tests can cross session boundaries deterministically;
     * the app never needs it.
     */
    episodicSessionGapMs?: number,
    /**
     * R4: rewrite-rule induction mode for the drill loop. When true, a
     * memorized drill routes to the rewrite engine's rule synthesis (the
     * A/B arm) instead of DSL compilation. Default false — the shipped
     * behavior is bit-identical.
     */
    rewriteInduction = false
  ) {
    super();
    this.session = session;
    this.persistence = persistence;
    this.persistEvery = Math.max(1, Math.floor(persistEvery));
    this.settleSteps = Math.max(0, Math.floor(settleSteps));
    this.hiddenRelationKeys = hiddenRelationKeys ?? null;
    this.curriculumConfig = curriculumConfig ?? {};
    this.rewriteInduction = rewriteInduction;
    this.episodic = new EpisodicMemory(episodicSessionGapMs);
    this.compositionRng = compositionSeed !== undefined ? mulberry32(compositionSeed) : Math.random;
    // The operator learner's MDL prior is the FULL frequency deck — token
    // costs are a fixed linguistic prior, not a property of the slice being
    // taught (an expensive rare-word answer can earn its operator in one
    // demonstration; cheap common-word answers need more evidence). Its
    // honesty guard (P6) also consults the relation graph so relation-hole
    // templates ("{slot} is a {p:is-a}") stay grounded by construction.
    this.operatorLearner = new OperatorLearner(
      new TokenCostModel(ACTIVE_DECK.map((entry) => entry.word)),
      () => this.relations(),
      () => deniedFromNegations(this.negations)
    );
    this.knownWords = new Set(deck.map((entry) => entry.word));
    for (const entry of deck) {
      this.states.set(entry.word, {
        word: entry,
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
    }
    // P14: mine PAST conversations as corroborating evidence. User statements
    // from persisted transcripts corroborate the deck's relations before the
    // session even starts ("my dog can bark" yesterday is still evidence for
    // dog capable-of bark today). Best-effort: no transcripts -> live turns
    // still mine as they arrive.
    try {
      for (const conversation of loadConversations()) {
        for (const message of conversation.messages) {
          if (message.role !== 'user') continue;
          if (this.persistedConversationTexts.length >= 300) break;
          this.persistedConversationTexts.push(message.text);
        }
      }
    } catch {
      // Transcripts unavailable — live-turn mining still applies.
    }
    if (this.persistedConversationTexts.length > 0) {
      this.noteConversationEvidence(this.persistedConversationTexts.join(' '));
    }
  }

  /**
   * The observer's single conversational entry point:
   *   1. memorized exchange (from its conversation memory),
   *   2. deterministic OPERATOR answer (novel questions computed from
   *      memory — what is X, do you know X, how many words, say X),
   *   3. CREATIVE composition (once recall competency unlocks it),
   *   4. ASK — the observer asks about what it does not know (the utterance
   *      is recorded as a gap so the answer, once received, can be
   *      memorized like any other knowledge),
   *   5. honest decline (empty/degenerate input only).
   * References ("it", "that") resolve against the recent working-memory
   * window first; the observer never guesses a referent.
   */
  chatAnswer(utterance: string): ChatAnswerWithMemory {
    // Resolve references against the window BEFORE noting the current turn —
    // otherwise the utterance would be its own referent source ("is it always
    // like that?" -> "alway"). Known words are preferred referents. Clock and
    // date questions use a DUMMY "it" ("what time is it") — never resolved.
    const known = this.knownWords;
    const resolved = isClockOrDateQuestion(utterance)
      ? utterance.trim()
      : resolveReferences(utterance, this.workingMemory.all(), (word) => known.has(word));
    this.workingMemory.note('user', utterance);
    // P14: the user's own words are corroborating evidence — a declarative
    // statement that expresses an existing relation ("my dog can bark")
    // adds the conversation source class to that edge. Questions and
    // negations never mine (evidenceInText gates them).
    this.noteConversationEvidence(resolved);
    // EPISODIC MEMORY: this turn is observed (user facts, topic recurrence,
    // session boundaries) and the facts clearly relevant to it are retrieved
    // — tagged as remembered, gated by topic overlap. The 8-turn working
    // window above is untouched: this is the selective long-term channel.
    const episodicTurn = this.episodic.observeTurn('user', utterance);
    const remembered = this.episodic.recall(utterance, {
      sessionStarted: episodicTurn.sessionStarted
    });
    const finish = <T extends ChatAnswer>(answer: T): ChatAnswerWithMemory => ({
      ...answer,
      remembered: remembered.length > 0 ? remembered : undefined,
      stored: episodicTurn.stored.length > 0 ? episodicTurn.stored : undefined
    });
    // Encounter tracking: deck words the observer HEARS but has no
    // definition for become curiosity fuel.
    for (const token of tokenizeText(utterance)) {
      const state = this.states.get(token);
      if (state !== undefined && state.word.definition.trim().length === 0) {
        this.encounterCounts.set(token, (this.encounterCounts.get(token) ?? 0) + 1);
      }
      if (isContentWord(token)) {
        this.exposureCounts.set(token, (this.exposureCounts.get(token) ?? 0) + 1);
      }
    }
    if (resolved.trim().length === 0) {
      this.noteAnswerMode('decline');
      return finish({ mode: 'decline', provenance: EMPTY_PROVENANCE });
    }

    // 0. Clock/date are DETERMINISTIC TRUTH — they must beat any memorized
    //    content (a taught "I do not know the time yet." is stale once the
    //    observer can tell time).
    if (isClockOrDateQuestion(resolved)) {
      const clock = clockAnswer(resolved);
      if (clock !== null) {
        this.workingMemory.note('observer', clock.answer);
        this.noteAnswerMode('operator');
        return finish({ mode: 'operator', response: clock.answer, operator: clock, provenance: EMPTY_PROVENANCE });
      }
    }

    // 1. Memorized exchange first — the observer's strongest, most practiced
    //    knowledge. Two invariants make it authoritative:
    //    a) moment-grounded recall (settle-to-agreement): partial overlaps
    //       fail to form a coherent attractor and score far below exact
    //       matches (fuzz bench: separation 0.35, 0% false positives in a
    //       realistic bank);
    //    b) IDENTITY: a memorized answer requires the question to be the
    //       taught exchange itself — the recall must carry the cue that was
    //       taught. Without this, degenerate tiny banks (a single trace)
    //       would still collapse onto any similar question.
    // A TAUGHT PHRASE BEATS A PRONOUN REWRITE. Anaphora resolution rewrites
    // "it/they/that" against the working-memory topic, which silently
    // corrupts fixed conversational cues ("how is it going" -> "how is
    // <topic> going") and makes the exchange unrecognizable. Measured: 93
    // of 728 taught cues were refused for exactly this reason even though
    // their raw form recalled with score AND margin to spare. So: try the
    // resolved form first (it is what reference-bearing questions need),
    // and fall back to the RAW utterance when the resolved lookup is not
    // authoritative but the raw one is.
    let memorized = this.respond(resolved);
    /** The utterance form the adopted recall was matched against. */
    let memorizedQuery = resolved;
    const resolvedAuthoritative =
      memorized.response !== null &&
      memorized.confidence !== null &&
      memorized.cue !== null &&
      authoritativeRecall(memorized.confidence, memorized.margin ?? 0, resolved, memorized.cue);
    if (!resolvedAuthoritative && resolved !== utterance) {
      const raw = this.respond(utterance);
      if (
        raw.response !== null &&
        raw.confidence !== null &&
        raw.cue !== null &&
        authoritativeRecall(raw.confidence, raw.margin ?? 0, utterance, raw.cue)
      ) {
        memorized = raw;
        memorizedQuery = utterance;
      }
    }
    const questionKey = resolved.trim().toLowerCase();
    const cueKey = (memorized.cue ?? '').toLowerCase();
    const cueMatches = matchesCue(questionKey, cueKey);
    if (
      memorized.response !== null &&
      memorized.confidence !== null &&
      memorized.cue !== null &&
      authoritativeRecall(memorized.confidence, memorized.margin ?? 0, memorizedQuery, memorized.cue)
    ) {
      this.workingMemory.note('observer', memorized.response);
      this.noteAnswerMode('memorized');
      return finish({
        mode: 'memorized',
        response: memorized.response,
        confidence: memorized.confidence,
        cue: memorized.cue,
        provenance: {
          traceIds: memorized.traceId !== null ? [memorized.traceId] : [],
          edges: []
        }
      });
    }

    // 1.5 NEGATION STATEMENTS (P8): "golf is not a bird" TEACHES a
    //     confirmed-false claim — explicit falsehood is evidence, and the
    //     exchange is memorized like any teaching. Only an explicit
    //     declarative negative reaches this step; questions fall through.
    const negationStatement = parseNegationStatement(resolved);
    if (negationStatement !== null) {
      const { subject, predicate, object } = negationStatement;
      this.storeNegation(subject, predicate, object, resolved, 'taught');
      const response = `Understood — ${subject} is not ${/^[aeiou]/.test(object) ? 'an' : 'a'} ${object}.`;
      this.teachResponse({ cue: resolved, response });
      this.workingMemory.note('observer', response);
      this.noteAnswerMode('operator');
      return finish({
        mode: 'operator',
        response,
        operator: { kind: 'compiled-rule', concept: subject, drill: 'negation', answer: response },
        provenance: { traceIds: [], edges: [{ subject, predicate, object }], operatorId: 'negation' }
      });
    }

    // 2. Operators: answer novel questions from memory deterministically.
    const operator = applyOperator(resolved, {
      isTaught: (word) => {
        const state = this.states.get(word);
        return state !== undefined && state.traceId !== null;
      },
      definitionOf: (word) => this.states.get(word)?.word.definition ?? '',
      wordCount: () => {
        let count = 0;
        for (const state of this.states.values()) {
          if (state.traceId !== null) count += 1;
        }
        return count;
      },
      phraseCount: () => this.conversationTraceIds.size,
      // Exposure counts words heard in PRIOR turns — the question itself
      // must not count as "having heard about" the word it asks about.
      exposureOf: (word) => Math.max(0, this.exposureOf(word) - (tokenizeText(resolved).includes(word) ? 1 : 0)),
      recallStrengthOf: (word) => this.recallStrengthOf(word),
      consolidatedWords: (limit) => this.consolidatedWords(limit),
      gapList: () => this.gapList(),
      relations: () => this.relations(),
      // P8: per-edge confidence (hedged answers when grades weakened it) and
      // the confirmed-false store (evidence-backed "No", never absence).
      edgeStrength: (subject, predicate, object) => this.edgeStrengthOf(subject, predicate, object),
      negationOf: (subject, predicate, object) => this.negationOf(subject, predicate, object),
      compositionCost: this.compositionCost,
      extraCompositionRules: this.compositionRules.admitted(),
      // The graded distributed-vector fallback (P1): used only when the
      // symbolic graph above is silent — never overrides a grounded edge.
      relationalScore: (subject, predicate, object) =>
        this.relationalHologram?.scoreOf(subject, predicate, object) ?? 0,
      relationalRecall: (subject, predicate, topK) =>
        this.relationalHologram?.candidates(subject, predicate, topK ?? 3, 0) ?? [],
      beliefAbout: (word) => this.beliefAboutForOperator(word),
      activeGoals: () => this.activeGoalView().map((g) => ({ target: g.target, reason: g.reason })),
      goalHistory: () => this.goalHistorySnapshot()
    });
    if (operator !== null) {
      this.workingMemory.note('observer', operator.answer);
      this.noteAnswerMode('operator');
      return finish({
        mode: 'operator',
        response: operator.answer,
        operator,
        provenance: {
          traceIds: [],
          edges: operatorEdges(operator),
          operatorId: operator.kind
        }
      });
    }

    // 2.5 LEARNED OPERATORS: patterns the observer discovered from its own
    //     strong answers ("do you like X" -> "Yes, I like X."). Grows the
    //     operator set — this is how new language patterns are acquired.
    const learned = this.operatorLearner.apply(resolved);
    if (learned !== null) {
      this.workingMemory.note('observer', learned.answer);
      this.noteAnswerMode('operator');
      return finish({
        mode: 'operator',
        response: learned.answer,
        operator: learned,
        provenance: { traceIds: [], edges: [], operatorId: learned.patternId }
      });
    }

    // 2.55 M5 (22.3) HYPOTHESIS TIER: the asserted graph and the operators
    //      declined — a standing hypothesis may answer, HEDGED only, one
    //      edge deep, blocked by the confirmed-false store. Its provenance
    //      cites the edge, so a later strong world grade promotes it.
    const hypothesis = this.hypothesisAnswerFor(resolved);
    if (hypothesis !== null) {
      this.workingMemory.note('observer', hypothesis.response);
      this.noteAnswerMode('operator');
      return finish({
        mode: 'operator',
        response: hypothesis.response,
        operator: hypothesis.operator,
        provenance: {
          traceIds: [],
          edges: [{ subject: hypothesis.edge.subject, predicate: hypothesis.edge.predicate, object: hypothesis.edge.object }],
          operatorId: 'hypothesis'
        }
      });
    }

    // 2.6 COMPILED RULES: executable programs induced from drills (P2). A
    //     memorized drill becomes a rule that computes fresh prompts of its
    //     family — deterministic computation beats stored instances, exactly
    //     as the clock beats a taught "I do not know the time yet."
    const compiled = this.applyCompiledRule(resolved);
    if (compiled !== null) {
      this.workingMemory.note('observer', compiled.answer);
      this.noteAnswerMode('operator');
      return finish({
        mode: 'operator',
        response: compiled.answer,
        operator: compiled,
        provenance: { traceIds: [], edges: [], operatorId: compiled.ruleId }
      });
    }

    // 2.7 REWRITE RULES (R3a): the observer derives answers by rewriting
    //     symbols with its rule decks — the same capacity mathematics,
    //     logic, and chained inference share. Legacy compiled rules shadow
    //     the engine on shipped records (byte-identical control); this
    //     layer is the computing path for families the DSL never compiled.
    //     A prompt that PARSES into the engine's domain but cannot derive
    //     (no rule for the family yet — gcf before induction) is a grounded
    //     computation question: it must route to ASK, never to the creative
    //     layer — composing over a computation request is a fabrication
    //     channel (the R7 finding: the creative path answered gcf prompts
    //     from memory on a fresh record).
    const rewriteProbe = this.applyRewriteRules(resolved);
    if (rewriteProbe !== null && rewriteProbe.kind === 'rewrite') {
      this.workingMemory.note('observer', rewriteProbe.answer);
      this.noteAnswerMode('operator');
      return finish({
        mode: 'operator',
        response: rewriteProbe.answer,
        operator: rewriteProbe,
        provenance: {
          traceIds: [],
          edges: [],
          operatorId: 'rewrite',
          ruleIds: rewriteProbe.ruleIds,
          derivationSteps: rewriteProbe.steps
        }
      });
    }
    /** A computation prompt the engine parsed but cannot yet derive —
     *  treated as a grounded question: ASK, never creative. */
    const underivableComputation = rewriteProbe !== null;

    const meaningCue = meaningCueOf(resolved);
    if (meaningCue !== null) {
      const semantic = this.identifyMeaning(meaningCue);
      if (semantic !== null) {
        const response = `The word is ${semantic.word}.`;
        const result: NonNullable<OperatorResult> = {
          kind: 'semantic-recall',
          word: semantic.word,
          answer: response,
          score: semantic.recall.score
        };
        this.workingMemory.note('observer', response);
        this.noteAnswerMode('operator');
        return {
          mode: 'operator',
          response,
          operator: result,
          provenance: {
            traceIds: [semantic.recall.trace.id],
            edges: [],
            operatorId: 'semantic-recall'
          }
        };
      }
    }

    // 3. Creative composition once unlocked — recent turns join the seed
    //    pool so the observer can continue the topic it was just on. The
    //    CURIOSITY drive can veto composition: when the observer is
    //    strongly driven to fill unknowns AND this exact utterance is an
    //    unanswered gap, it ASKS instead of composing — seeking learning is
    //    the archetypal priority.
    // Pure counter — no field excitation: asking is driven by pressure, not
    // by re-perturbing the moment (which would disturb the composition below).
    const curiosityDrivenAsk =
      this.gapUtterances.has(resolved.trim().toLowerCase()) && Math.min(1, this.curiosityPressure() / 4) >= 0.5;
    const unknownInUtterance = extractUnknownSubject(resolved, known);
    // THE EVASION RULE (extended): creative may compose freely about KNOWN
    // material — that is where the user EXPECTS deviation — but it must never
    // answer a recognized factual form ("what is X", "is X a Y", "does X
    // have Y", ...). A factual form that reached this point is UNANSWERED —
    // no memory, operator, or relation path supports it — so composing over
    // it would be confident nonsense. Those route to ASK.
    const questionForm = questionFormOf(resolved);
    const groundedQuestion = questionForm !== null || meaningCue !== null || underivableComputation;
    // Creative also needs something KNOWN to seed from — a known content
    // word, or a recall whose CUE is the utterance itself (phatic phrases
    // like "how are you" carry no content words yet are taught exchanges
    // recalled below the memorized threshold). Pure unknowns ("zzz xyz
    // qqq") have neither and route to ASK — degenerate recalls without cue
    // identity never qualify.
    const hasKnownContent =
      (memorized.response !== null && cueMatches) ||
      tokenizeText(resolved).some((token) => isContentWord(token) && known.has(token));
    if (this.conversationReport().creativeUnlocked && !curiosityDrivenAsk && !groundedQuestion && hasKnownContent) {
      const contextSeeds = this.workingMemory.recent(4).map((turn) => turn.text);
      const reply = this.creativeReply(resolved, contextSeeds);
      if (reply.sentence.trim().length > 0) {
        this.workingMemory.note('observer', reply.sentence);
        // CURIOSITY FEED: a creative answer to an utterance containing words
        // the observer has never heard still records the gap — fluency must
        // not starve the curiosity drive (a fluent observer that never asks
        // is a fluent observer that never learns).
        if (unknownInUtterance !== null) this.recordGap(utterance);
        this.noteAnswerMode('creative');
        // Phase 7b: remember this authored answer (with its seed traces) so
        // a future re-ask can credit the world's failure verdict.
        this.noteAuthoredAnswer(utterance, reply.seedTraceIds);
        // PHASE 8 GROUNDING: the deviation meter's per-composition verdict —
        // how much of this answer comes from the observer's own seeds vs.
        // stitched. Scored from the recalled seed contents themselves, with
        // the P14 hedge markers stripped: "I think" is presentation, not
        // stitched content.
        const seedContents = this.session.observer.getMemoryBank().all()
          .filter((trace) => reply.seedTraceIds.includes(trace.id))
          .map((trace) => trace.content);
        this.noteGrounding(groundingScore(stripHedges(reply.sentence), seedContents).grounding);
        return finish({
          mode: 'creative',
          response: reply.sentence,
          confidence: reply.confidence,
          seedTraceIds: reply.seedTraceIds,
          seedCount: reply.seedCount,
          grounded: reply.grounded,
          hedged: reply.hedged,
          templateIds: reply.templateIds,
          provenance: { traceIds: reply.seedTraceIds, edges: reply.edges, templateIds: reply.templateIds }
        });
      }
    }

    // 4. ASK: the observer does not know — it asks. The utterance is
    //    recorded as a gap; when the answer arrives (LLM or human) it is
    //    memorized normally and decay decides its fate.
    // WORLD RE-ASK (credited ONLY here, after routing): if the observer had
    // already answered this utterance before but still cannot answer it
    // now, the prior answer failed in the world — weaken its paths and let
    // the re-ask feed the gap. An utterance that now answers correctly
    // (memorized/operator/creative above) never pays the penalty.
    if (this.previousAnswerFor(resolved) !== undefined) {
      this.creditReAsk(resolved);
    }
    const gapKey = resolved.trim().toLowerCase();
    const gapKnownBefore = this.gapUtterances.has(gapKey);
    this.recordGap(utterance);
    // LEARNED GRADIENT: an already-recorded gap (from BEFORE this utterance)
    // that still fails is a failed ASK — the observer asked before, was
    // taught, and still cannot answer. A gap recorded just now is not a
    // failure — it is the first ask.
    if (gapKnownBefore) {
      this.noteBehaviorOutcome('ask', false);
    }
    const unknown = unknownInUtterance;
    // EPISODIC REFERENCE: when the turn mentions a word the human has
    // DEMONSTRATED failure on (a measured vocabulary fact, retrieved above
    // the spoken-relevance floor), the observer names that memory in its
    // question — "last time you struggled with X" is a stored fact, not a
    // guess. Anything below the floor is never spoken as a memory.
    const spokenStruggle = remembered.find(
      (entry) =>
        entry.fact.kind === 'vocabulary' &&
        entry.fact.lastVerdict === 'wrong' &&
        entry.relevance >= EPISODIC_SPOKEN_RELEVANCE_FLOOR
    );
    let question: string;
    if (spokenStruggle !== undefined) {
      const subject = spokenStruggle.fact.topics[0];
      question = `I remember you found "${subject}" hard last time — could you teach me about it?`;
    } else if (meaningCue !== null) {
      question = `I do not know which word matches "${meaningCue}". Could you teach me?`;
    } else if (unknown !== null && this.framesForSubject(unknown).length > 0) {
      // READ, NOT DEFINED. History, mythology and literature are about named
      // entities no dictionary deck contains: the observer has no definition
      // of "Zeus" to recite, but it does hold what it read about him. Saying
      // that is honest — the frames are built from stored edges and hedged
      // by corroboration, exactly like any other grounded answer.
      question = this.speakFromFrames(unknown);
    } else if (unknown !== null) {
      question = `I do not know what "${unknown}" means. Could you teach me?`;
    } else if (questionForm !== null && questionForm.object !== undefined) {
      // Honest unknown for an unsupported relational question — no relation
      // path exists, and absence of evidence is never answered as absence.
      const article = /^[aeiou]/.test(questionForm.object) ? 'an' : 'a';
      const claim = questionForm.kind === 'is-a'
        ? `whether ${questionForm.subject} is ${article} ${questionForm.object}`
        : questionForm.kind === 'made-of'
          ? `whether ${questionForm.subject} is made of ${questionForm.object}`
          : `whether ${questionForm.subject} has ${questionForm.object}`;
      question = `I do not know ${claim}. Could you teach me?`;
    } else {
      question = 'I do not know that yet. Could you teach me?';
    }
    this.workingMemory.note('observer', question);
    this.noteAnswerMode('ask');
    return finish({ mode: 'ask', response: question, provenance: EMPTY_PROVENANCE });
  }
}