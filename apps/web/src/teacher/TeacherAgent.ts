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

const TeacherAgentComposed = WordLoopMixin(
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
    const [traces, states, learningState] = await Promise.all([
      this.persistence.loadTraces(),
      this.persistence.loadWordStates(),
      this.persistence.loadLearningState()
    ]);

    const bank = this.session.observer.getMemoryBank();
    const staleTraceIds = new Set<string>();
    let restored = 0;
    // The vocabulary-scheme check guards against a MISMATCHED encoding basis.
    // A MISSING learningState (pre-v4 IndexedDB, or a saveLearningState that
    // failed while saveTraces succeeded — they run as concurrent siblings) is
    // NOT evidence of a mismatch: those traces were written by this app under
    // this scheme, and declaring them all stale silently wipes the record on
    // the next persist (H6). When the scheme is unknown, the per-trace
    // isStaleEncoding check is the only guard — it already separates the
    // pre-focused era by encoding shape.
    const schemeKnown =
      learningState !== null &&
      learningState !== undefined &&
      learningState.vocabularyScheme !== undefined;
    const persistenceCompatible =
      traces.length === 0 ||
      !schemeKnown ||
      learningState.vocabularyScheme === BOOTSTRAP_VOCABULARY_SCHEME;

    for (const data of traces) {
      if (!persistenceCompatible || isStaleEncoding(data)) {
        staleTraceIds.add(data.id);
        continue;
      }
      const trace = bank.restoreTrace(data);
      if (trace !== null) {
        restored += 1;
        if (trace.metadata?.kind === 'conversation' && typeof trace.metadata.cue === 'string') {
          this.conversationTraceIds.add(trace.id);
          this.taughtConversationCues.add(trace.metadata.cue);
        }
        if (trace.metadata?.kind === 'creative') {
          this.creativeMemoryIds.add(trace.id);
        }
        if (trace.metadata?.kind === 'gap' && typeof trace.metadata.uttered === 'string') {
          this.gapUtterances.add(trace.metadata.uttered);
          this.gapMissCounts.set(trace.metadata.uttered, 1);
          this.gapTraceIds.add(trace.id);
        }
        if (trace.metadata?.kind === 'belief') {
          // Rebuild the dedup set so beliefs never re-fire after restore.
          const beliefKind = String(trace.metadata.beliefKind ?? '');
          const about = String(trace.metadata.about ?? '');
          if (about.length > 0) this.beliefsStored.add(`${beliefKind}:${about}`);
        }
        if (trace.metadata?.kind === 'goal') {
          this.storeGoalIfNewInStatic(trace);
        }
      }
    }

    this.rebuildLearnedOperators();
    this.rebuildCompositionWeightsFromMemory();

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
          current.reviewHistory = [];
          continue;
        }
        current.traceId = state.traceId;
        current.taughtAt = state.taughtAt;
        current.lastAskedAt = state.lastAskedAt;
        current.lastGrade = state.lastGrade;
        current.successes = state.successes;
        current.failures = state.failures;
        current.strengthHistory = Array.isArray(state.strengthHistory) ? state.strengthHistory : [];
        // P9: FSRS state rides the word states; old records default to the
        // fresh-word curve (their dueAt is reset so they review promptly).
        current.stability = typeof state.stability === 'number' && state.stability > 0 ? state.stability : FSRS_INITIAL_STABILITY;
        current.difficulty = typeof state.difficulty === 'number' ? state.difficulty : FSRS_INITIAL_DIFFICULTY;
        current.dueAt = typeof state.dueAt === 'number' ? state.dueAt : Date.now();
        current.lastIntervalDays = typeof state.lastIntervalDays === 'number' ? state.lastIntervalDays : null;
        // P-curriculum: records written before the review history existed
        // default to empty — the repeated-gap signal starts from zero.
        current.reviewHistory = Array.isArray(state.reviewHistory)
          ? (state.reviewHistory as Array<'correct' | 'wrong'>).filter((o) => o === 'correct' || o === 'wrong').slice(-REVIEW_HISTORY_CAP)
          : [];
      }
    }

    // P9 wall-clock forgetting: strength is the MODEL's retention prediction
    // at the elapsed interval (the per-word FSRS curve). Runs AFTER the word
    // states bind, so each trace decays on ITS stability — time passed while
    // the observer was away decays exactly what the model predicts.
    this.applyRetention(Date.now());

    // EPISODIC MEMORY: the salient-facts journal survives restarts. A store
    // failure degrades to a fresh memory (the chat degrades to session-only
    // context, reported honestly — the same contract as the other layers).
    try {
      const episodicSnapshot = await this.persistence.loadEpisodicMemory();
      if (episodicSnapshot !== null) this.episodic.deserialize(episodicSnapshot);
    } catch (error) {
      console.warn('episodic-memory restore failed — starting fresh', error);
    }

    // THE FULL LEARNING STATE: the deliberative layers must survive a
    // reload — composition weights (its tiny language model, so fluency
    // survives and the handover does not reset to scaffolded), drive
    // weights, goal history, the fade state, and the exposure counters.
    try {
      if (persistenceCompatible && learningState !== null) {
        if (typeof learningState.compositionWeights === 'object' && learningState.compositionWeights !== null) {
          this.compositionWeights.clear();
          for (const [key, value] of Object.entries(learningState.compositionWeights as Record<string, number>)) {
            this.compositionWeights.set(key, value);
          }
        }
        // L3 (19.2/19.3): adopt the decay clocks when present; a legacy
        // record without them starts every clock at the first decay sweep.
        if (typeof learningState.compositionWeightMeta === 'object' && learningState.compositionWeightMeta !== null) {
          this.compositionWeightMeta.clear();
          for (const [key, value] of Object.entries(learningState.compositionWeightMeta as Record<string, number>)) {
            if (Number.isFinite(value)) this.compositionWeightMeta.set(key, value);
          }
        }
        if (typeof learningState.behaviorOutcomeAt === 'object' && learningState.behaviorOutcomeAt !== null) {
          for (const [key, value] of Object.entries(learningState.behaviorOutcomeAt as Record<string, number>)) {
            if (Number.isFinite(value)) this.behaviorOutcomeAt.set(key as BehaviorOption, value);
          }
        }
        // Phase 24.3 (additive): calibration evidence survives reloads.
        if (typeof learningState.calibration === 'object' && learningState.calibration !== null) {
          this.calibration.restore(learningState.calibration);
        }
        if (typeof learningState.behaviorWeights === 'object' && learningState.behaviorWeights !== null) {
          this.behaviorWeights = { ...(learningState.behaviorWeights as BehaviorWeights) };
        }
        if (typeof learningState.behaviorOutcomes === 'object' && learningState.behaviorOutcomes !== null) {
          const outcomes = learningState.behaviorOutcomes as Record<BehaviorOption, { wins: number; losses: number }>;
          for (const option of Object.keys(this.behaviorOutcomes) as BehaviorOption[]) {
            const record = outcomes[option];
            if (record !== undefined) {
              this.behaviorOutcomes[option] = { wins: record.wins, losses: record.losses };
            }
          }
        }
        if (typeof learningState.goalHistory === 'object' && learningState.goalHistory !== null) {
          for (const [type, record] of Object.entries(learningState.goalHistory as Record<string, { completed: number; abandoned: number }>)) {
            const key = type as GoalType;
            if (key in this.goalHistory) {
              this.goalHistory[key] = { completed: record.completed, abandoned: record.abandoned };
            }
          }
        }
        if (typeof learningState.fadeState === 'object' && learningState.fadeState !== null) {
          // L2 (20.4) MIGRATION: λ is no longer stored — it is derived from
          // the trust kernel. A legacy record's earned λ is preserved by
          // seeding equivalent kernel evidence, so teacher-dependence does
          // NOT reset to scaffolded on upgrade.
          this.seedLegacyFadeState(learningState.fadeState as { lambda?: Record<string, number> });
        }
        if (typeof learningState.exposureCounts === 'object' && learningState.exposureCounts !== null) {
          this.exposureCounts.clear();
          for (const [word, value] of Object.entries(learningState.exposureCounts as Record<string, number>)) {
            this.exposureCounts.set(word, value);
          }
        }
        if (typeof learningState.encounterCounts === 'object' && learningState.encounterCounts !== null) {
          this.encounterCounts.clear();
          for (const [word, value] of Object.entries(learningState.encounterCounts as Record<string, number>)) {
            this.encounterCounts.set(word, value);
          }
        }
        if (typeof learningState.drillFailures === 'object' && learningState.drillFailures !== null) {
          // P-curriculum: the weak-drill signal survives reloads — a concept
          // that kept failing drills yesterday is still weak today.
          this.drillFailures.clear();
          for (const [concept, value] of Object.entries(learningState.drillFailures as Record<string, unknown>)) {
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
              this.drillFailures.set(concept, Math.floor(value));
            }
          }
        }
        if (Array.isArray(learningState.relations)) {
          // Chaperone edges survive reloads: they were reconciled and tagged
          // on ingestion, and re-tagging on restore keeps provenance honest.
          this.chaperoneRelations = (learningState.relations as Array<Partial<Relation>>)
            .filter((r) => typeof r?.subject === 'string' && typeof r?.predicate === 'string' && typeof r?.object === 'string')
            .map((r) => ({
              subject: r.subject as string,
              predicate: r.predicate as Relation['predicate'],
              object: r.object as string,
              source: typeof r.source === 'string' ? r.source : '',
              origin: 'chaperone' as const
            }));
        }
        // M5 (22.5): the standing hypothesis tier (absent on legacy records —
        // the next relations rebuild re-proposes from the loose extraction).
        if (Array.isArray(learningState.hypothesisEdges)) {
          this.hypothesisEdges = (learningState.hypothesisEdges as Array<Partial<Relation>>)
            .filter((r) => typeof r?.subject === 'string' && typeof r?.predicate === 'string' && typeof r?.object === 'string')
            .map((r) => ({
              subject: r.subject as string,
              predicate: r.predicate as Relation['predicate'],
              object: r.object as string,
              source: typeof r.source === 'string' ? r.source : '',
              origin: (typeof r.origin === 'string' ? r.origin : 'regex') as Relation['origin'],
              sourceClasses: Array.isArray(r.sourceClasses) ? r.sourceClasses.filter(isSourceClass) : undefined,
              tier: 'hypothesis' as const
            }));
        }
        if (Array.isArray(learningState.compiledRules)) {
          // Executable drill rules survive reloads; malformed entries are
          // dropped loudly-free (a program that cannot parse is not a rule).
          this.compiledRules = (learningState.compiledRules as Array<Partial<CompiledRule>>)
            .filter(
              (r) =>
                typeof r?.id === 'string' &&
                typeof r?.concept === 'string' &&
                typeof r?.drill === 'string' &&
                typeof r?.program === 'object' &&
                r?.program !== null &&
                'op' in (r.program as object)
            )
            .map((r) => ({
              id: r.id as string,
              concept: r.concept as string,
              drill: r.drill as string,
              program: r.program as DSLExpr,
              nodes: typeof r.nodes === 'number' ? r.nodes : 0,
              bits: typeof r.bits === 'number' ? r.bits : 0,
              trainCount: typeof r.trainCount === 'number' ? r.trainCount : 0,
              instanceBits: typeof r.instanceBits === 'number' ? r.instanceBits : 0
            }));
        }
        if (Array.isArray(learningState.rewriteRules)) {
          // R5: LEARNED rewrite rules survive reloads (the authored decks are
          // code, re-seeded every construction). Malformed rules are dropped.
          for (const rule of learningState.rewriteRules as Array<Partial<RewriteRule>>) {
            if (
              typeof rule?.id === 'string' &&
              typeof rule?.name === 'string' &&
              typeof rule?.lhs === 'object' &&
              rule?.lhs !== null &&
              typeof rule?.rhs === 'object' &&
              rule?.rhs !== null
            ) {
              try {
                this.ruleStore.register({
                  id: rule.id,
                  name: rule.name,
                  lhs: rule.lhs as RewriteRule['lhs'],
                  rhs: rule.rhs as RewriteRule['rhs'],
                  origin: rule.origin === 'induced' || rule.origin === 'taught' || rule.origin === 'chaperone' || rule.origin === 'consolidated' ? rule.origin : 'induced',
                  strength: typeof rule.strength === 'number' ? rule.strength : 1,
                  sourceClasses: Array.isArray(rule.sourceClasses) ? rule.sourceClasses.filter((c) => typeof c === 'string') : [],
                  bits: typeof rule.bits === 'number' ? rule.bits : 0,
                  evidence: typeof rule.evidence === 'number' ? rule.evidence : undefined,
                  schema: rule.schema === 'structural' || rule.schema === 'measure' || rule.schema === 'accessor' || rule.schema === 'search' || rule.schema === 'scalar' ? rule.schema : undefined,
                  active: rule.active !== false,
                  createdAt: typeof rule.createdAt === 'number' ? rule.createdAt : 0,
                  useCount: typeof rule.useCount === 'number' ? rule.useCount : 0,
                  lastUsedAt: typeof rule.lastUsedAt === 'number' ? rule.lastUsedAt : undefined
                });
              } catch {
                // An unregisterable rule is not a rule — dropped.
              }
            }
          }
        }
        if (Array.isArray(learningState.rewriteDenials)) {
          for (const denial of learningState.rewriteDenials as Array<Partial<DerivationDenial>>) {
            if (typeof denial?.ruleId === 'string') {
              this.ruleStore.recordDenial({
                ruleId: denial.ruleId,
                input: typeof denial.input === 'string' ? denial.input : undefined,
                output: typeof denial.output === 'string' ? denial.output : undefined,
                expected: typeof denial.expected === 'string' ? denial.expected : undefined,
                evidence: denial.evidence === 'taught' || denial.evidence === 'verified-wrong' ? denial.evidence : 'graded-wrong',
                at: typeof denial.at === 'number' ? denial.at : 0
              });
            }
          }
        }
        if (Array.isArray(learningState.ruleResolutions)) {
          this.ruleResolutions.clear();
          for (const id of learningState.ruleResolutions as unknown[]) {
            if (typeof id === 'string') this.ruleResolutions.add(id);
          }
        }
        if (typeof learningState.rewriteRuleStats === 'object' && learningState.rewriteRuleStats !== null) {
          for (const [id, stats] of Object.entries(learningState.rewriteRuleStats as Record<string, unknown>)) {
            const rule = this.ruleStore.get(id);
            if (rule === undefined || typeof stats !== 'object' || stats === null) continue;
            const entry = stats as Partial<{ uses: number; lastUsedAt: number }>;
            if (typeof entry.uses === 'number') rule.useCount = entry.uses;
            if (typeof entry.lastUsedAt === 'number') rule.lastUsedAt = entry.lastUsedAt;
          }
        }
        if (Array.isArray(learningState.answerGrades)) {
          // The grade ledger survives reloads — malformed entries are dropped.
          this.answerGrades = (learningState.answerGrades as Array<Partial<AnswerGradeEntry>>)
            .filter((g) => typeof g?.at === 'number' && typeof g?.utterance === 'string' && Array.isArray(g.traceIds))
            .slice(-ANSWER_GRADES_CAP)
            .map((g) => ({
              at: g.at as number,
              utterance: g.utterance as string,
              mode: typeof g.mode === 'string' ? g.mode : 'unknown',
              verdict: (g.verdict as AnswerGradeEntry['verdict']) ?? 'neutral',
              traceIds: (g.traceIds as string[]).filter((id) => typeof id === 'string'),
              edges: Array.isArray(g.edges)
                ? (g.edges as EdgeRef[]).filter((e) => typeof e?.subject === 'string' && typeof e?.object === 'string')
                : [],
              operatorId: typeof g.operatorId === 'string' ? g.operatorId : undefined,
              ruleIds: Array.isArray(g.ruleIds) ? g.ruleIds.filter((id): id is string => typeof id === 'string') : undefined
            }));
        }
        if (Array.isArray(learningState.authoredAnswers)) {
          // The world-feedback credit map survives reloads (P7).
          this.authoredAnswers.clear();
          for (const entry of learningState.authoredAnswers as Array<Partial<{ utterance: string; traceIds: string[]; at: number; score?: number; provider?: string; template?: string }>>) {
            if (typeof entry?.utterance === 'string' && Array.isArray(entry.traceIds) && typeof entry.at === 'number') {
              this.authoredAnswers.set(entry.utterance, {
                traceIds: entry.traceIds.filter((id) => typeof id === 'string'),
                at: entry.at,
                score: typeof entry.score === 'number' ? entry.score : undefined,
                provider: typeof entry.provider === 'string' ? entry.provider : undefined,
                template: typeof entry.template === 'string' ? entry.template : undefined
              });
            }
          }
        }
        if (typeof learningState.edgeConfidence === 'object' && learningState.edgeConfidence !== null) {
          // The P8 confidence overlay survives reloads (agreement + grades).
          this.edgeConfidence.clear();
          for (const [key, value] of Object.entries(learningState.edgeConfidence as Record<string, unknown>)) {
            if (typeof value === 'number' && Number.isFinite(value)) this.edgeConfidence.set(key, value);
          }
        }
        if (typeof learningState.edgeSources === 'object' && learningState.edgeSources !== null) {
          // P14: the corroboration source classes survive reloads — evidence
          // mined yesterday still corroborates today (malformed entries drop).
          this.edgeSources.clear();
          for (const [key, value] of Object.entries(learningState.edgeSources as Record<string, unknown>)) {
            if (Array.isArray(value)) {
              const classes = (value as unknown[]).filter(isSourceClass);
              if (classes.length > 0) this.edgeSources.set(key, classes);
            }
          }
        }
        if (Array.isArray(learningState.negations)) {
          // The confirmed-false store survives reloads (P8).
          this.negations = (learningState.negations as Array<Partial<Negation>>)
            .filter((n) => typeof n?.subject === 'string' && typeof n?.object === 'string' && typeof n?.predicate === 'string')
            .map((n) => ({
              subject: n.subject as string,
              predicate: n.predicate as RelationPredicate,
              object: n.object as string,
              evidence: typeof n.evidence === 'string' ? n.evidence : '',
              origin: n.origin === 'graded' ? 'graded' : 'taught'
            }));
        }
        if (Array.isArray(learningState.resolvedSweepConflicts)) {
          // The sweep resolution ledger survives reloads — a resolved
          // conflict stays resolved (one-shot, no ping-pong).
          this.resolvedSweepConflicts = new Set(
            (learningState.resolvedSweepConflicts as unknown[]).filter(
              (id): id is string => typeof id === 'string'
            )
          );
        }
        if (typeof learningState.bootstrapImportedMeta === 'object' && learningState.bootstrapImportedMeta !== null) {
          const meta = learningState.bootstrapImportedMeta as { generatedAt: string; words: number };
          if (typeof meta.generatedAt === 'string' && typeof meta.words === 'number') {
            this.bootstrapImportedMeta = meta;
          }
        }
        if (typeof learningState.graderReliability === 'object' && learningState.graderReliability !== null) {
          // The grader reliability model survives reloads — per-bucket
          // agreement evidence is cumulative, never re-learned from scratch.
          this.reliabilityModel.restore(learningState.graderReliability as ReliabilitySnapshot);
        }
        this.restoreProducedCues(
          learningState.producedCues,
          learningState.cueConfidence as Record<string, number> | undefined
        );
      }
    } catch (error) {
      console.warn('learning-state restore failed — starting fresh for the deliberative layers', error);
    }
    return { restored, stale: staleTraceIds.size };
  }

  /**
   * Re-adopt the cues the observer has actually spoken. Only cues still
   * backed by a taught trace are kept, so a pruned or stale exchange can
   * never push the numerator past the denominator.
   *
   * Call AFTER the trace loop has rebuilt `taughtConversationCues`.
   */
  protected restoreProducedCues(cues: unknown, confidence?: Record<string, number>): void {
    if (Array.isArray(cues)) {
      for (const cue of cues) {
        if (typeof cue !== 'string' || !this.taughtConversationCues.has(cue)) continue;
        this.producedConversationCues.add(cue);
        const score = confidence?.[cue];
        if (typeof score === 'number') this.cueConfidence.set(cue, score);
      }
      return;
    }
    // A record written before this field existed. An empty array means
    // "genuinely none produced" and is honoured above; only a MISSING field
    // falls through to recovery.
    this.recoverProducedCuesFromTraces();
  }

  /**
   * Recover the produced set from recorded evidence: accessCount starts at
   * zero and only a recall increments it, so a conversation trace with at
   * least one access was demonstrably produced. Traces never recalled stay
   * out — the count is measured, never inferred.
   */
  protected recoverProducedCuesFromTraces(): void {
    for (const trace of this.session.observer.getMemoryBank().all()) {
      if (trace.metadata?.kind !== 'conversation' || (trace.accessCount ?? 0) < 1) continue;
      const cue = trace.metadata.cue;
      if (typeof cue === 'string' && this.taughtConversationCues.has(cue)) {
        this.producedConversationCues.add(cue);
      }
    }
  }

  /** Rebuild the composition transition weights from the observer's own
   *  strong creative traces — the tiny language model, reconstructed from
   *  memory (the handover's fluency signal must survive a reload). */
  protected rebuildCompositionWeightsFromMemory(): void {
    const bank = this.session.observer.getMemoryBank();
    for (const trace of bank.all()) {
      if (trace.metadata?.kind !== 'creative') continue;
      const score = typeof trace.metadata.score === 'number' ? trace.metadata.score : 0.7;
      if (score < CREATIVE_REINFORCE_SCORE) continue;
      bumpAgedWeights(this.compositionWeights, this.compositionWeightMeta, [trace.content], CREATIVE_GRADE_DELTA);
    }
  }

  /**
   * Throttled persistence hook: only every `persistEvery`-th action marks the
   * record dirty, so large batch runs do not spend the run re-serializing their
   * own history (which would otherwise be O(n²) in words taught).
   */
  maybePersist(): void {
    this.persistCounter += 1;
    if (this.persistCounter % this.persistEvery === 0) {
      this.schedulePersist();
    }
  }

  /**
   * Coalesce a burst of mutations into one write. One autonomous cycle fires
   * a dozen mutations; without this each would re-serialize the whole record
   * and the writes would queue up faster than they drain.
   */
  protected schedulePersist(): void {
    if (this.persistence === null) return;
    const now = Date.now();
    if (this.dirtySince === null) this.dirtySince = now;
    // A continuous stream of mutations must still reach storage: past the
    // ceiling the pending write goes out instead of being deferred again.
    if (now - this.dirtySince >= PERSIST_MAX_DELAY_MS) {
      this.runScheduledPersist();
      return;
    }
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.runScheduledPersist(), PERSIST_DEBOUNCE_MS);
  }

  protected runScheduledPersist(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.dirtySince = null;
    void this.persistAll();
  }

  /**
   * Write any coalesced mutation immediately and wait for every queued write
   * to land. Call this before the page goes away — a debounced save that
   * never ran is a lost lesson.
   */
  async flush(): Promise<void> {
    if (this.persistence === null) return;
    const pending = this.persistTimer !== null || this.dirtySince !== null;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.dirtySince = null;
    if (pending) {
      await this.persistAll();
      return;
    }
    await this.persistChain;
  }

  /**
   * Persist the complete learning record (word states + serialized traces).
   * Failures are logged, never thrown: a broken store must not break school.
   * Each save also appends a strength sample to the word's retention history.
   */
  async persistAll(): Promise<void> {
    if (this.persistence === null) return;
    const run = this.persistChain.then(() => this.writeRecord());
    // The chain must survive a failed write, or every later save is skipped.
    this.persistChain = run.catch(() => {});
    return run;
  }

  protected async writeRecord(): Promise<void> {
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
      // Conversation exchanges, memorized creative answers, gaps, BELIEFS
      // and GOALS are traces too — the observer's full learning record must
      // survive restart, including its self-knowledge and its plans.
      for (const trace of bank.all()) {
        const kind = trace.metadata?.kind;
        if (
          (kind === 'conversation' && !this.conversationTraceIds.has(trace.id)) ||
          (kind === 'creative' && !this.creativeMemoryIds.has(trace.id)) ||
          (kind === 'gap' && !this.gapTraceIds.has(trace.id)) ||
          kind === 'belief' ||
          kind === 'goal'
        ) {
          const data = bank.serializeTrace(trace.id);
          if (data !== null) traces.push(data);
        }
      }
      for (const traceId of this.conversationTraceIds) {
        const data = bank.serializeTrace(traceId);
        if (data !== null) traces.push(data);
      }
      for (const traceId of this.creativeMemoryIds) {
        const data = bank.serializeTrace(traceId);
        if (data !== null) traces.push(data);
      }
      for (const traceId of this.gapTraceIds) {
        const data = bank.serializeTrace(traceId);
        if (data !== null) traces.push(data);
      }
      // THE FULL LEARNING STATE: the deliberative layers (composition
      // weights — the tiny language model, drive weights, goal history,
      // fade state, exposure counters) as one record — otherwise a reload
      // resets the observer's preferences and its self-grading handover.
      const learningState: Record<string, unknown> = {
        vocabularyScheme: BOOTSTRAP_VOCABULARY_SCHEME,
        compositionWeights: Object.fromEntries(this.compositionWeights),
        // L3 (19.2/19.3): the decay clocks ride the same record (additive —
        // absent on legacy records, which start their clocks at restore).
        compositionWeightMeta: Object.fromEntries(this.compositionWeightMeta),
        behaviorOutcomeAt: Object.fromEntries(this.behaviorOutcomeAt),
        // Phase 24.3 (additive): the calibration gates' evidence.
        calibration: this.calibration.snapshot(),
        behaviorWeights: this.behaviorWeights,
        behaviorOutcomes: this.behaviorOutcomes,
        goalHistory: this.goalHistory,
        // L2 (20.4): fadeState is GONE — λ is derived from the trust kernel,
        // whose evidence rides the graderReliability snapshot below.
        exposureCounts: Object.fromEntries(this.exposureCounts),
        encounterCounts: Object.fromEntries(this.encounterCounts),
        drillFailures: Object.fromEntries(this.drillFailures),
        producedCues: [...this.producedConversationCues],
        cueConfidence: Object.fromEntries(this.cueConfidence),
        relations: this.chaperoneRelations,
        // M5 (22.5, additive): the standing hypothesis tier survives reloads
        // so accumulated corroboration can promote across sessions.
        hypothesisEdges: this.hypothesisEdges,
        compiledRules: this.compiledRules,
        answerGrades: this.answerGrades,
        edgeConfidence: Object.fromEntries(this.edgeConfidence),
        edgeSources: Object.fromEntries(this.edgeSources),
        negations: this.negations,
        resolvedSweepConflicts: [...this.resolvedSweepConflicts],
        // R5: the rewrite rules are memories — only the LEARNED ones persist
        // (the authored decks are code; a stale persisted deck would decode
        // against mismatched primitives). Denials and the one-shot stop
        // ledger ride with them.
        rewriteRules: this.ruleStore
          .all()
          .filter((rule) => rule.origin !== 'authored')
          .map((rule) => ({ ...rule })),
        rewriteDenials: this.ruleStore.allDenials(),
        ruleResolutions: [...this.ruleResolutions],
        rewriteRuleStats: Object.fromEntries(
          this.ruleStore
            .all()
            .filter((rule) => rule.useCount > 0 || rule.lastUsedAt !== undefined)
            .map((rule) => [
              rule.id,
              { uses: rule.useCount, lastUsedAt: rule.lastUsedAt ?? rule.createdAt }
            ])
        ),
        authoredAnswers: [...this.authoredAnswers.entries()].map(([utterance, entry]) => ({
          utterance,
          traceIds: entry.traceIds,
          at: entry.at,
          score: typeof entry.score === 'number' ? entry.score : undefined,
          provider: typeof entry.provider === 'string' ? entry.provider : undefined,
          template: typeof entry.template === 'string' ? entry.template : undefined
        })),
        bootstrapImportedMeta: this.bootstrapImportedMeta,
        graderReliability: this.reliabilityModel.snapshot()
      };
      await Promise.all([
        // Untouched words carry nothing but constructor defaults; writing
        // all 20k of them on every save is what made the record too slow to
        // keep up with the learning loop.
        this.persistence.saveWordStates([...this.states.values()].filter(isTouchedWordState)),
        this.persistence.saveTraces(traces),
        this.persistence.saveLearningState(learningState),
        // The episodic journal (salient facts, bounded by its own policy).
        this.persistence.saveEpisodicMemory(this.episodic.serialize())
      ]);
    } catch (error) {
      console.warn('persistence save failed', error);
    }
  }

  /**
   * Import a headlessly-trained bootstrap record into this session: restore
   * every trace into the memory bank, bind the word states, load the
   * conversation exchanges, and apply the definitions. Identical semantics
   * to a fresh-session persistence restore — so the app can reach an
   * "initially trained" state in one step instead of hours of UI teaching.
   */
  importBootstrap(record: BootstrapRecord): { restored: number; conversations: number; definitions: number; droppedWords: number; stale: number } {
    if (
      record.version < BOOTSTRAP_MIN_SUPPORTED_VERSION ||
      record.version > BOOTSTRAP_VERSION ||
      record.vocabularyScheme !== BOOTSTRAP_VOCABULARY_SCHEME
    ) {
      throw new Error('bootstrap vocabulary encoding is incompatible; regenerate it with npm run train');
    }
    const bank = this.session.observer.getMemoryBank();
    let restored = 0;
    let conversations = 0;
    let stale = 0;
    let droppedWords = 0;

    for (const data of record.traces) {
      if (isStaleEncoding(data)) {
        // Pre-encoding-era trace — rejected silently for years; count it so
        // the caller can report why the record restored fewer than exported.
        stale += 1;
        continue;
      }
      // Deduplicated records omit the per-trace basis copy — reconstruct it
      // from the record header. Legacy records carry primes per trace.
      const primes = data.primes.length === 0 && record.primeBasis !== undefined ? record.primeBasis : data.primes;
      const trace = bank.restoreTrace(
        record.encoding === 'q16' ? { ...data, primes, amplitudes: data.amplitudes.map((a) => a / 65535) } : { ...data, primes }
      );
      if (trace !== null) {
        restored += 1;
        if (trace.metadata?.kind === 'belief') {
          const beliefKind = String(trace.metadata.beliefKind ?? '');
          const about = String(trace.metadata.about ?? '');
          if (about.length > 0) this.beliefsStored.add(`${beliefKind}:${about}`);
        }
        if (trace.metadata?.kind === 'conversation' && typeof trace.metadata.cue === 'string') {
          this.conversationTraceIds.add(trace.id);
          this.taughtConversationCues.add(trace.metadata.cue);
          conversations += 1;
        }
        if (trace.metadata?.kind === 'creative') {
          this.creativeMemoryIds.add(trace.id);
          if (typeof trace.metadata.uttered === 'string') {
            this.creativeUtteredKeys.add(trace.metadata.uttered);
          }
        }
        if (trace.metadata?.kind === 'gap' && typeof trace.metadata.uttered === 'string') {
          this.gapUtterances.add(trace.metadata.uttered);
          this.gapMissCounts.set(trace.metadata.uttered, 1);
          this.gapTraceIds.add(trace.id);
        }
      }
    }

    for (const state of record.wordStates) {
      const current = this.states.get(state.word);
      // A word this deck does not teach, or a state bound to a trace that
      // failed to restore, can never be bound here — count the drop so the
      // import summary reports it instead of losing it silently.
      if (!current || state.traceId === null) {
        droppedWords += 1;
        continue;
      }
      // A word whose trace failed to restore is left untaught — never bound
      // to a phantom trace.
      if (bank.get(state.traceId) === undefined) {
        droppedWords += 1;
        continue;
      }
      current.traceId = state.traceId;
      current.taughtAt = state.taughtAt;
      current.lastAskedAt = state.lastAskedAt;
      current.lastGrade = state.lastGrade;
      current.successes = state.successes;
      current.failures = state.failures;
      current.strengthHistory = Array.isArray(state.strengthHistory) ? state.strengthHistory : [];
      // P9: FSRS state rides the word states; old records default fresh.
      current.stability = typeof state.stability === 'number' && state.stability > 0 ? state.stability : FSRS_INITIAL_STABILITY;
      current.difficulty = typeof state.difficulty === 'number' ? state.difficulty : FSRS_INITIAL_DIFFICULTY;
      current.dueAt = typeof state.dueAt === 'number' ? state.dueAt : Date.now();
      current.lastIntervalDays = typeof state.lastIntervalDays === 'number' ? state.lastIntervalDays : null;
      current.reviewHistory = Array.isArray(state.reviewHistory)
        ? (state.reviewHistory as Array<'correct' | 'wrong'>).filter((o) => o === 'correct' || o === 'wrong').slice(-REVIEW_HISTORY_CAP)
        : [];
    }

    const definitions = this.applyDefinitions(record.definitions);
    if (Array.isArray(record.relations)) {
      this.chaperoneRelations = record.relations
        .filter((r) => typeof r?.subject === 'string' && typeof r?.predicate === 'string' && typeof r?.object === 'string')
        .map((r) => ({
          subject: r.subject,
          predicate: r.predicate,
          object: r.object,
          source: typeof r.source === 'string' ? r.source : '',
          origin: 'chaperone' as const
        }));
      this.invalidateRelations();
    }
    if (Array.isArray(record.compiledRules)) {
      this.compiledRules = record.compiledRules
        .filter((r) => typeof r?.id === 'string' && typeof r?.concept === 'string' && typeof r?.drill === 'string' && typeof r?.program === 'object' && r?.program !== null)
        .map((r) => ({
          id: r.id,
          concept: r.concept,
          drill: r.drill,
          program: r.program,
          nodes: typeof r.nodes === 'number' ? r.nodes : 0,
          bits: typeof r.bits === 'number' ? r.bits : 0,
          trainCount: typeof r.trainCount === 'number' ? r.trainCount : 0,
          instanceBits: typeof r.instanceBits === 'number' ? r.instanceBits : 0
        }));
    }
    if (Array.isArray(record.answerGrades)) {
      this.answerGrades = record.answerGrades
        .filter((g) => typeof g?.at === 'number' && typeof g?.utterance === 'string' && Array.isArray(g.traceIds))
        .slice(-ANSWER_GRADES_CAP)
        .map((g) => ({
          at: g.at,
          utterance: g.utterance,
          mode: typeof g.mode === 'string' ? g.mode : 'unknown',
          verdict: g.verdict ?? 'neutral',
          traceIds: g.traceIds.filter((id) => typeof id === 'string'),
          edges: Array.isArray(g.edges)
            ? g.edges.filter((e) => typeof e?.subject === 'string' && typeof e?.object === 'string')
            : [],
          operatorId: typeof g.operatorId === 'string' ? g.operatorId : undefined,
          ruleIds: Array.isArray(g.ruleIds) ? g.ruleIds.filter((id): id is string => typeof id === 'string') : undefined
        }));
    }
    if (Array.isArray(record.authoredAnswers)) {
      this.authoredAnswers.clear();
      for (const entry of record.authoredAnswers) {
        if (typeof entry?.utterance === 'string' && Array.isArray(entry.traceIds) && typeof entry.at === 'number') {
          this.authoredAnswers.set(entry.utterance, {
            traceIds: entry.traceIds.filter((id) => typeof id === 'string'),
            at: entry.at,
            score: typeof entry.score === 'number' ? entry.score : undefined,
            provider: typeof entry.provider === 'string' ? entry.provider : undefined,
            template: typeof entry.template === 'string' ? entry.template : undefined
          });
        }
      }
    }
    if (typeof record.edgeConfidence === 'object' && record.edgeConfidence !== null) {
      this.edgeConfidence.clear();
      for (const [key, value] of Object.entries(record.edgeConfidence as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) this.edgeConfidence.set(key, value);
      }
    }
    if (typeof record.edgeSources === 'object' && record.edgeSources !== null) {
      // P14: corroboration source classes ride the bootstrap record.
      this.edgeSources.clear();
      for (const [key, value] of Object.entries(record.edgeSources as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          const classes = (value as unknown[]).filter(isSourceClass);
          if (classes.length > 0) this.edgeSources.set(key, classes);
        }
      }
    }
    if (Array.isArray(record.negations)) {
      this.negations = record.negations
        .filter((n) => typeof n?.subject === 'string' && typeof n?.object === 'string' && typeof n?.predicate === 'string')
        .map((n) => ({
          subject: n.subject,
          predicate: n.predicate,
          object: n.object,
          evidence: typeof n.evidence === 'string' ? n.evidence : '',
          origin: n.origin === 'graded' ? 'graded' : 'taught'
        }));
    }
    if (Array.isArray(record.resolvedSweepConflicts)) {
      // The sweep resolution ledger survives imports — a resolved conflict
      // stays resolved (one-shot, no ping-pong).
      this.resolvedSweepConflicts = new Set(
        (record.resolvedSweepConflicts as unknown[]).filter(
          (id): id is string => typeof id === 'string'
        )
      );
    }
    if (Array.isArray(record.rewriteRules)) {
      // R5: learned rewrite rules survive imports, exactly like reloads.
      for (const rule of record.rewriteRules as Array<Partial<RewriteRule>>) {
        if (
          typeof rule?.id === 'string' &&
          typeof rule?.name === 'string' &&
          typeof rule?.lhs === 'object' &&
          rule?.lhs !== null &&
          typeof rule?.rhs === 'object' &&
          rule?.rhs !== null
        ) {
          try {
            this.ruleStore.register({
              id: rule.id,
              name: rule.name,
              lhs: rule.lhs as RewriteRule['lhs'],
              rhs: rule.rhs as RewriteRule['rhs'],
              origin: rule.origin === 'induced' || rule.origin === 'taught' || rule.origin === 'chaperone' || rule.origin === 'consolidated' ? rule.origin : 'induced',
              strength: typeof rule.strength === 'number' ? rule.strength : 1,
              sourceClasses: Array.isArray(rule.sourceClasses) ? rule.sourceClasses.filter((c) => typeof c === 'string') : [],
              bits: typeof rule.bits === 'number' ? rule.bits : 0,
              evidence: typeof rule.evidence === 'number' ? rule.evidence : undefined,
              schema: rule.schema === 'structural' || rule.schema === 'measure' || rule.schema === 'accessor' || rule.schema === 'search' || rule.schema === 'scalar' ? rule.schema : undefined,
              active: rule.active !== false,
              createdAt: typeof rule.createdAt === 'number' ? rule.createdAt : 0,
              useCount: typeof rule.useCount === 'number' ? rule.useCount : 0,
              lastUsedAt: typeof rule.lastUsedAt === 'number' ? rule.lastUsedAt : undefined
            });
          } catch {
            // Unregisterable rules are dropped.
          }
        }
      }
    }
    if (Array.isArray(record.rewriteDenials)) {
      for (const denial of record.rewriteDenials as Array<Partial<DerivationDenial>>) {
        if (typeof denial?.ruleId === 'string') {
          this.ruleStore.recordDenial({
            ruleId: denial.ruleId,
            input: typeof denial.input === 'string' ? denial.input : undefined,
            output: typeof denial.output === 'string' ? denial.output : undefined,
            expected: typeof denial.expected === 'string' ? denial.expected : undefined,
            evidence: denial.evidence === 'taught' || denial.evidence === 'verified-wrong' ? denial.evidence : 'graded-wrong',
            at: typeof denial.at === 'number' ? denial.at : 0
          });
        }
      }
    }
    if (Array.isArray(record.ruleResolutions)) {
      this.ruleResolutions.clear();
      for (const id of record.ruleResolutions as unknown[]) {
        if (typeof id === 'string') this.ruleResolutions.add(id);
      }
    }
    this.rebuildLearnedOperators();
    if (record.driveWeights !== undefined) {
      this.behaviorWeights = { ...record.driveWeights } as BehaviorWeights;
    }
    if (record.goalHistory !== undefined) {
      for (const [type, record2] of Object.entries(record.goalHistory)) {
        const key = type as GoalType;
        if (key in this.goalHistory) {
          this.goalHistory[key] = { completed: record2.completed, abandoned: record2.abandoned };
        }
      }
    }
    // The FULL higher-order state: composition weights (the tiny language
    // model), outcome history, fade λ, exposure — the entire teacher from a
    // headless record.
    if (record.learningState !== undefined) {
      const ls = record.learningState;
      if (typeof ls.compositionWeights === 'object' && ls.compositionWeights !== null) {
        this.compositionWeights.clear();
        for (const [key, value] of Object.entries(ls.compositionWeights)) this.compositionWeights.set(key, value);
      }
      // L3 (19.2/19.3): the decay clocks (absent on legacy records — the
      // first decay sweep after import starts them).
      if (typeof ls.compositionWeightMeta === 'object' && ls.compositionWeightMeta !== null) {
        this.compositionWeightMeta.clear();
        for (const [key, value] of Object.entries(ls.compositionWeightMeta)) {
          if (Number.isFinite(value)) this.compositionWeightMeta.set(key, value);
        }
      }
      if (typeof ls.behaviorOutcomeAt === 'object' && ls.behaviorOutcomeAt !== null) {
        for (const [key, value] of Object.entries(ls.behaviorOutcomeAt)) {
          if (Number.isFinite(value)) this.behaviorOutcomeAt.set(key as BehaviorOption, value);
        }
      }
      if (typeof ls.behaviorOutcomes === 'object' && ls.behaviorOutcomes !== null) {
        for (const option of Object.keys(this.behaviorOutcomes) as BehaviorOption[]) {
          const record2 = ls.behaviorOutcomes[option];
          if (record2 !== undefined) {
            this.behaviorOutcomes[option] = { wins: record2.wins, losses: record2.losses };
          }
        }
      }
      if (typeof ls.fadeState === 'object' && ls.fadeState !== null && ls.fadeState.lambda != null) {
        // L2 (20.4) MIGRATION: legacy stored λ seeds equivalent kernel
        // evidence (see restoreFromPersistence).
        this.seedLegacyFadeState(ls.fadeState as { lambda?: Record<string, number> });
      }
      if (typeof ls.exposureCounts === 'object' && ls.exposureCounts !== null) {
        this.exposureCounts.clear();
        for (const [word, count] of Object.entries(ls.exposureCounts)) this.exposureCounts.set(word, count);
      }
      if (typeof ls.encounterCounts === 'object' && ls.encounterCounts !== null) {
        this.encounterCounts.clear();
        for (const [word, count] of Object.entries(ls.encounterCounts)) this.encounterCounts.set(word, count);
      }
      if (typeof ls.drillFailures === 'object' && ls.drillFailures !== null) {
        this.drillFailures.clear();
        for (const [concept, count] of Object.entries(ls.drillFailures as Record<string, unknown>)) {
          if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
            this.drillFailures.set(concept, Math.floor(count));
          }
        }
      }
      if (typeof ls.graderReliability === 'object' && ls.graderReliability !== null) {
        this.reliabilityModel.restore(ls.graderReliability as ReliabilitySnapshot);
      }
      this.restoreProducedCues(ls.producedCues, ls.cueConfidence);
    }
    return { restored, conversations, definitions, droppedWords, stale };
  }

  /** Number of stored creative memories (strong answers, incl. hybrid). */
  creativeMemoryCount(): number {
    return this.creativeMemoryIds.size;
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

  /** The learned composition transition weights (read-only — the observer's
   *  tiny language model, exposed for the Phase 7a correlation bench). */
  getCompositionWeights(): TransitionWeights {
    return this.compositionWeights;
  }

  /** L3 (19.2): the weights' decay clocks (read-only — round-trip gates). */
  getCompositionWeightMeta(): ReadonlyMap<string, number> {
    return this.compositionWeightMeta;
  }

  /**
   * The observer's CREATIVE answer: it hears the utterance, recalls its own
   * memorized conversational sentences, and composes a NEW sentence from
   * those words alone (no LLM in the generation path). With a limited
   * vocabulary the composition is naturally limited — it can only say what
   * it has learned to say. The composition is what gets graded semantically
   * afterwards.
   */
  creativeReply(utterance: string, extraSeeds: readonly string[] = []): CreativeReply {
    const cue = utterance.trim();
    if (cue.length === 0) {
      return { sentence: '', seedCount: 0, confidence: null, seedTraceIds: [], grounded: false, hedged: false, edges: [], templateIds: [] };
    }

    // The moment (converged field) selects the seeds — recallMemories
    // excites and settles the field, then ranks by resonance with the
    // moment's amplitude distribution. The top memory's words ARE the
    // moment's language: the composition continues the coherence pattern.
    const memories = this.recallMemories(utterance, 6);
    const contents = memories.map((memory) => memory.content);
    const seedTraceIds = memories.map((memory) => memory.id);
    const bestScore = memories.length > 0 ? memories[0].score : null;
    const momentTokens = memories.length > 0 ? contents[0].split(' ') : [];
    // Recent working-memory turns are context seeds (low priority, capped)
    // so compositions can continue the topic at hand.
    for (const seed of extraSeeds) {
      const content = seed.trim();
      if (content.length > 0 && !contents.includes(content)) contents.push(content);
      if (contents.length >= 8) break;
    }

    // P5 GROUNDED FIRST: typed frames filled from the relation graph, every
    // content word from a stored edge, verified by the internal critic. The
    // Markov path below is the LABELED fallback. The utterance's own known
    // words are the preferred subjects; an utterance that names a known but
    // EDGELESS topic falls back (answering about a different subject would
    // be non-responsive), while a content-free utterance ("tell me more")
    // lets the recent memory supply the topic.
    const relations = this.relations();
    const denied = deniedFromNegations(this.negations);
    const utteranceContent = tokenizeText(cue).filter(isContentWord);
    const utteranceSubjects = groundedSubjects(utteranceContent, relations, denied);
    const memorySubjects = groundedSubjects(tokenizeText(contents.join(' ')), relations, denied);
    const useGrounded = utteranceSubjects.length > 0 || utteranceContent.length === 0;
    const grounded = useGrounded
      ? composeGrounded(
          [...utteranceSubjects, ...memorySubjects],
          relations,
          this.compositionRng,
          undefined,
          { negations: this.negations, cost: this.compositionCost, extraRules: this.compositionRules.admitted() },
          this.learnedFrames
        )
      : null;
    if (grounded !== null && grounded.edges.length > 0) {
      // The critic already verified the composition in composeGrounded;
      // re-verify against the full graph + negations for the final sentence.
      const verdict = criticize(grounded.sentence, relations, this.negations, {
        cost: this.compositionCost,
        extraRules: this.compositionRules.admitted()
      });
      if (verdict.grounded) {
        // P14: the claims are graph-backed, but single-source claims are
        // still WEAK — phrase them with their corroboration hedge instead of
        // asserting them flatly. Corroborated claims are spoken assertively.
        const spoken = hedgeComposition(grounded.sentence, relations);
        return {
          sentence: spoken.sentence,
          seedCount: memories.length,
          confidence: bestScore,
          seedTraceIds,
          grounded: true,
          hedged: spoken.hedged,
          edges: verdict.edges,
          templateIds: grounded.templateIds
        };
      }
      // A composition the re-parse refuses counts against the templates that
      // produced it (learned templates are demoted on repeated refusal).
      this.learnedFrames.observeRejection(grounded.templateIds ?? []);
    } else if (grounded !== null) {
      this.learnedFrames.observeRejection(grounded.templateIds ?? []);
    }

    const composed = composeCreativeResponse(contents, memories[0]?.content ?? '', {
      weights: this.compositionWeights,
      utterance: cue,
      momentTokens,
      rng: this.compositionRng
    });
    return {
      sentence: composed.sentence,
      seedCount: composed.seedCount,
      confidence: bestScore,
      seedTraceIds,
      grounded: false,
      hedged: false,
      edges: [],
      templateIds: []
    };
  }

  /**
   * Close the creative loop the way the word loop closes: a semantic grade
   * is feedback, not just a number. Strong compositions reinforce their seed
   * memories AND lower the surprise of the transitions they used; weak ones
   * weaken both slightly — creativity becomes a learned behavior on top of
   * memorization, driven by entropy descent over the composition weights.
   *
   * Additionally, a STRONG answer (>= CREATIVE_REINFORCE_SCORE) is itself
   * memorized as a new creative trace keyed by its utterance — the observer
   * "remembers what worked", so a good answer becomes a repeatable answer
   * (and its words join the composition pool for future novelty). Weak
   * answers are never stored: memory stays honest.
   *
   * The producers are named by PROVENANCE (P7): the seed traces the answer
   * was built from — and, once edges carry confidence (P8), the typed edges
   * it cited. A bad grade weakens exactly those, never the whole bank.
   *
   * `weight` (0..1, default 1) scales the FEEDBACK DELTAS — trace
   * reinforcement, the composition-weight gradient, and the P8 edge bumps —
   * never the grade's BAND: the store/gap/negation decisions still read the
   * unweighted score, so a damped grade can never silently change class.
   * The grader reliability model supplies this weight so low-reliability
   * buckets contribute less to edge strengthening/weakening and to the
   * memory updates the grade drives.
   */
  creativeGradeFeedback(
    provenance: AnswerProvenance | readonly string[],
    score: number | null,
    utterance = '',
    answer = '',
    weight = 1
  ): boolean {
    // Backward-compatible: a bare trace-id list (pre-P7 callers) is a
    // provenance without edges.
    const producers: AnswerProvenance = Array.isArray(provenance)
      ? { traceIds: [...(provenance as readonly string[])], edges: [] }
      : (provenance as AnswerProvenance);
    const seedTraceIds = producers.traceIds;
    const citedEdges = producers.edges;
    const templateIds = producers.templateIds ?? [];
    const citedRules = producers.ruleIds ?? [];
    if (score === null) return false;
    // THE FADING CONTROLLER (Phase 7c): when the student's own composite
    // has proven it can judge (measured agreement ≥ threshold), the reward
    // blends — λ·composite + (1−λ)·teacher — so the observer gradually
    // self-grades what it has learned to judge while the teacher remains
    // the authority on novel/uncertain terrain. The composite is judged
    // against the answer's REAL seeds (the producing trace contents), never
    // against the answer itself.
    if (utterance.trim().length > 0 && answer.trim().length > 0) {
      const seedContents: string[] = [];
      const bankForSeeds = this.session.observer.getMemoryBank();
      for (const traceId of seedTraceIds) {
        const trace = bankForSeeds.get(traceId);
        if (trace !== undefined && !seedContents.includes(trace.content)) {
          seedContents.push(trace.content);
        }
      }
      score = this.fadeReward(utterance, answer, score, seedContents);
    }
    const feedbackWeight = Math.max(0, Math.min(1, weight));
    const bank = this.session.observer.getMemoryBank();
    // L1b (18.2): the delta is surprise-scaled by the grade's margin beyond
    // its gate; the BAND (reinforce/weaken/neutral) is unchanged.
    const rawDelta = creativeGradeDelta(score);
    const delta = rawDelta * feedbackWeight;
    // P5 learned frames: the world's verdict is attributed to the templates
    // the grounded composition used. A strong answer also demonstrates its
    // structure — the induction reconstructs the template from the accepted
    // sentence (content still read from stored edges at generation time).
    const accepted = score >= CREATIVE_REINFORCE_SCORE;
    this.learnedFrames.observeUse(templateIds, accepted);
    if (delta > 0 && templateIds.length > 0 && answer.trim().length > 0) {
      this.learnedFrames.induce(answer, this.relations(), this.negations);
    }
    // R4b: a cited chain is evidence for its predicate sequence — the
    // composition-rule store's acceptance baseline is the seeds' own rate.
    if (citedEdges.length >= 2) {
      this.compositionRules.observe(citedEdges.map((edge) => edge.predicate), accepted);
    }
    if (delta === 0) {
      // P7 contract: the ledger records the producers of EVERY graded
      // answer — a mid-grade (0.3–0.7) answer carries no reinforcement but
      // its producers must still be named for surgical repair.
      this.recordAnswerGrade(utterance, 'creative', 'neutral', {
        traceIds: seedTraceIds,
        edges: citedEdges,
        ruleIds: citedRules.length > 0 ? citedRules : undefined
      });
      this.maybePersist();
      return false;
    }
    // The learned model updates from the SEED contents (the memory that
    // produced the answer) AND from the ANSWER ITSELF — a strong answer is
    // the observer's own new material, and its n-grams must enter the
    // transition model or the student never gains fluency on its own voice
    // (the 7d finding: without this, the uncertainty fallback never
    // releases).
    const contents: string[] = [answer];
    for (const traceId of seedTraceIds) {
      const trace = bank.get(traceId);
      if (trace === undefined) continue;
      if (!contents.includes(trace.content)) contents.push(trace.content);
      bank.reinforce(traceId, delta);
    }
    bumpAgedWeights(this.compositionWeights, this.compositionWeightMeta, contents, delta);
    // P11: a strongly-graded answer makes its seed traces more useful to keep
    // (grade evidence feeds the bank's retrieval-usefulness pruning).
    if (delta > 0) {
      for (const traceId of seedTraceIds) {
        this.session.observer.getMemoryBank().bumpUtility(traceId, 1);
      }
    }
    // P8: a grade on an answer that CITED edges adjusts exactly those —
    // a strong answer confirms them, a weak one calls them into question.
    // The edge delta is scaled by the same feedback weight, so a grade from
    // a low-reliability bucket weakens/strengthens edges less (P8 rides on
    // the weighted grade, never on its unweighted band).
    const edgeDelta = rawDelta > 0 ? 0.2 * feedbackWeight : rawDelta < 0 ? -0.2 * feedbackWeight : 0;
    for (const edge of citedEdges) {
      this.bumpEdge(edge.subject, edge.predicate, edge.object, edgeDelta);
    }
    // P14: the world's verdict is a source class. An ACCEPTED graded answer
    // corroborates the edges it cited (>= 2 independent classes -> spoken
    // assertively); a rejected one withdraws that credit.
    for (const edge of citedEdges) {
      if (delta > 0) this.addEdgeSource(edge.subject, edge.predicate, edge.object, 'world-feedback');
      else if (delta < 0) this.removeEdgeSource(edge.subject, edge.predicate, edge.object, 'world-feedback');
    }
    // R5: the world's verdict on an answer that DERIVED through rules
    // credits or weakens exactly those rules — the rule analog of P8's
    // per-edge confidence. A strong grade corroborates (the hedge lifts);
    // a weak one weakens, records the denial, and stops a doubly-denied
    // rule at the floor (never deleted).
    for (const ruleId of citedRules) {
      if (delta > 0) this.ruleStore.addSourceClass(ruleId, 'world-feedback');
      else if (delta < 0) this.weakenRule(ruleId, feedbackWeight);
    }
    // The P7 grade ledger: this answer's producers (and the edges it cited —
    // consumed by P8's per-edge confidence) are recorded for surgical repair.
    this.recordAnswerGrade(utterance, 'creative', rawDelta > 0 ? 'strong' : rawDelta < 0 ? 'weak' : 'neutral', {
      traceIds: seedTraceIds,
      edges: citedEdges,
      ruleIds: citedRules.length > 0 ? citedRules : undefined
    });

    // Memorize strong answers as creative traces (surprise-gated: only store
    // if this exact answer is not already an utterance-keyed memory).
    let stored = false;
    if (score >= CREATIVE_REINFORCE_SCORE && utterance.trim().length > 0 && answer.trim().length > 0) {
      const key = utterance.trim().toLowerCase();
      if (!this.creativeUtteredKeys.has(key) && !this.taughtConversationCues.has(key)) {
        // Excite the field with the utterance so the answer stores under a
        // real cue orientation — never store into a quiescent field.
        this.session.settleField();
        this.session.observeText(utterance);
        this.session.observer.tick(0.02);
        const trace = this.session.storeMemory(answer.trim(), {
          metadata: { kind: 'creative', uttered: key, score }
        });
        if (trace !== null) {
          this.creativeMemoryIds.add(trace.id);
          this.creativeUtteredKeys.add(key);
          stored = true;
        }
      }
      // OPERATOR DISCOVERY: a strong answer is a pattern demonstration.
      // The learner itself dedups identical demonstrations (replay guard).
      this.operatorLearner.learn(utterance, answer, score);
    }

    // A weak creative answer is a GAP: the observer could not answer this
    // utterance, so it becomes learning material for the self-teaching loop.
    if (score <= CREATIVE_WEAKEN_SCORE && utterance.trim().length > 0) {
      // A weak creative answer is a GAP: the observer could not answer this
      // utterance, so it becomes learning material for the self-teaching loop.
      this.recordGap(utterance);
      // LEARNED GRADIENT: a weak composition credits compose as a loss.
      this.noteBehaviorOutcome('compose', false);
    }
    if (score >= CREATIVE_REINFORCE_SCORE) {
      // LEARNED GRADIENT: a strong composition credits compose as a win.
      this.noteBehaviorOutcome('compose', true);
      // P8 GRADED-CONFIRMED "NO": a strong answer that IS a negative statement
      // ("No, golf is not a bird.") confirms the falsehood — evidence-backed.
      if (answer.trim().length > 0) {
        const negated = parseNegationStatement(answer.replace(/^no,?\s+/i, ''));
        if (negated !== null) {
          this.storeNegation(negated.subject, negated.predicate, negated.object, answer, 'graded');
        }
      }
    }

    this.maybePersist();
    return stored;
  }

  /**
   * THE GRADER-RELIABILITY GRADING PATH (the LLM teacher, reliability-
   * weighted). Grades a semantically graded answer the way the app now
   * grades everything LLM-graded:
   *
   *   1. BUCKET the grade by criteria — answer type (creative), the FSRS
   *      difficulty band of its seed words, the question template (fade
   *      classification), and the provider name.
   *   2. RULE CHECK — the composition grounding check predicts a band
   *      (fabrication → weak, echo → mid, grounded composition → strong).
   *      Agreeing bands are evidence FOR the bucket; disagreeing bands are
   *      evidence AGAINST it, and the disagreement schedules a RE-GRADE
   *      (the UI's confirmation queue / deferral) whose resolution feeds
   *      the same model.
   *   3. WEIGHT — the bucket's feedback weight scales the feedback deltas
   *      (never the band): low-reliability buckets contribute less to edge
   *      strengthening/weakening and memory updates.
   *   4. The grade's own LLM score is recorded with the authored answer, so
   *      later WORLD feedback (a re-ask contradicting a strong grade, a
   *      retention confirming it) counts as agreement evidence too.
   *
   * Returns what was applied and whether a re-grade is pending — the caller
   * reports the pending disagreement instead of silently overruling it.
   */
  gradeCreativeWithReliability(
    provenance: AnswerProvenance | readonly string[],
    score: number | null,
    utterance: string,
    answer: string,
    provider: string
  ): { stored: boolean; weight: number; disagreement: boolean; regradeId: string | null } {
    const producers: AnswerProvenance = Array.isArray(provenance)
      ? { traceIds: [...(provenance as readonly string[])], edges: [] }
      : (provenance as AnswerProvenance);
    if (score === null) {
      return { stored: false, weight: 1, disagreement: false, regradeId: null };
    }

    const bank = this.session.observer.getMemoryBank();
    const seedContents: string[] = [];
    for (const traceId of producers.traceIds) {
      const trace = bank.get(traceId);
      if (trace !== undefined && !seedContents.includes(trace.content)) seedContents.push(trace.content);
    }

    const criteria: GradeCriteria = {
      answerType: 'creative',
      difficultyBand: this.difficultyBandOfSeeds(producers.traceIds),
      template: classifyUtterance(utterance),
      provider
    };

    // The rule-based check: the composition's grounding predicts its band.
    // No seeds = no check (a seedless grade is uncheckable, not suspect).
    const ruleBand = seedContents.length > 0 ? ruleBandForGrounding(groundingScore(answer, seedContents)) : null;
    const llmBand = gradeBandOf(score);
    const agree = bandsAgree(llmBand, ruleBand);
    this.reliabilityModel.recordAgreement(criteria, agree);
    // Phase 24.3 (read-only): the creative band gates' calibration evidence.
    if (ruleBand !== null) this.calibration.record('creative-grade', score, agree);

    // Disagreement → schedule the re-grade (the resolution updates the
    // model). The feedback below is applied DAMPED, never withheld.
    let regradeId: string | null = null;
    if (ruleBand !== null && !agree) {
      regradeId = this.reliabilityModel.scheduleRegrade(criteria, {
        utterance,
        answer,
        llmScore: score,
        llmBand,
        ruleBand,
        reason:
          ruleBand === 'weak'
            ? 'the answer grounds on none of its seeds — fabrication'
            : ruleBand === 'mid'
              ? 'the answer echoes its seeds — no composition happened'
              : 'the answer composes its seeds — the rule check expects a strong grade'
      });
    }

    // The grade's own band travels with the authored answer so later world
    // verdicts (re-ask / retention) can confirm or contradict it — and L2
    // (20.3): the STUDENT's band travels too, so the same world verdicts
    // measure the composite judge under the same bucket.
    if (utterance.trim().length > 0) {
      const authored = this.previousAnswerFor(utterance);
      if (authored !== undefined) {
        const composite = compositeScore(answer, utterance, this.compositionWeights, seedContents).composite;
        this.authoredAnswers.set(utterance.trim().toLowerCase(), {
          traceIds: authored.traceIds,
          at: authored.at,
          score,
          provider,
          template: criteria.template,
          compositeBand: composite > 0 ? gradeBandOf(composite) : null
        });
      }
    }

    const weight = this.reliabilityModel.feedbackWeight(criteria);
    const stored = this.creativeGradeFeedback(producers, score, utterance, answer, weight);
    return { stored, weight, disagreement: !agree, regradeId };
  }

  /**
   * Assemble the current session into an exportable bootstrap record — the
   * same shape the batch trainer writes, so a session can be moved between
   * machines (or into a fresh browser) with one import.
   */
  exportBootstrap(deck = 'en-20000'): BootstrapRecord {
    const bank = this.session.observer.getMemoryBank();
    const traces: BootstrapRecord['traces'] = [];
    const wordStates: BootstrapRecord['wordStates'] = [];
    const now = new Date().toISOString();

    // The field's prime basis — every trace carried the identical 256-prime
    // array; store it once and drop the per-trace copy.
    const firstTrace = bank.all()[0];
    const primeBasis: number[] = firstTrace !== undefined ? [...firstTrace.primes] : [];
    const dedupPrimes = (primes: readonly number[]): number[] =>
      primeBasis.length > 0 && primes.length === primeBasis.length && primes.every((p, i) => p === primeBasis[i]) ? [] : [...primes];

    // Record-level compact encoding: amplitudes are quantized to uint16
    // fixed-point (the moment's per-prime distribution is stored to 1/65535
    // resolution — nothing below noise), and review histories are capped at
    // the last 20 events (enough for any trend the report reads).
    const quantize = (amplitudes: readonly number[]): number[] =>
      amplitudes.map((value) => Math.max(0, Math.min(65535, Math.round(value * 65535))));

    for (const state of this.states.values()) {
      if (state.traceId === null) continue;
      const trace = bank.serializeTrace(state.traceId);
      if (trace !== null) traces.push({ ...trace, primes: dedupPrimes(trace.primes), amplitudes: quantize(trace.amplitudes) });
      wordStates.push({
        word: state.word.word,
        traceId: state.traceId,
        taughtAt: state.taughtAt,
        lastAskedAt: state.lastAskedAt,
        lastGrade: state.lastGrade,
        successes: state.successes,
        failures: state.failures,
        strengthHistory: state.strengthHistory.slice(-20),
        stability: state.stability,
        difficulty: state.difficulty,
        dueAt: state.dueAt,
        lastIntervalDays: state.lastIntervalDays,
        reviewHistory: state.reviewHistory.slice(-20)
      });
    }
    for (const trace of bank.all()) {
      if (trace.metadata?.kind !== 'conversation' && trace.metadata?.kind !== 'creative' && trace.metadata?.kind !== 'gap' && trace.metadata?.kind !== 'belief' && trace.metadata?.kind !== 'goal') continue;
      const data = bank.serializeTrace(trace.id);
      if (data !== null && !traces.some((existing) => existing.id === data.id)) {
        traces.push({ ...data, primes: dedupPrimes(data.primes), amplitudes: quantize(data.amplitudes) });
      }
    }

    const definitions: BootstrapRecord['definitions'] = [];
    for (const state of this.states.values()) {
      if (state.word.definition.trim().length === 0 || state.word.example.trim().length === 0) continue;
      definitions.push({ word: state.word.word, definition: state.word.definition, example: state.word.example });
    }

    const weights: Record<string, number> = {};
    for (const option of Object.keys(this.behaviorWeights) as BehaviorOption[]) {
      const value = this.behaviorWeights[option];
      if (value !== undefined) weights[option] = value;
    }
    const goalHistory: Record<string, { completed: number; abandoned: number }> = {};
    for (const [type, record] of Object.entries(this.goalHistory)) {
      if (record.completed > 0 || record.abandoned > 0) goalHistory[type] = { ...record };
    }
    // The FULL higher-order state, so a headlessly-trained record handed to
    // the web restores the entire teacher (its tiny language model, its
    // outcome history, its handover λ, its exposure).
    const learningState: BootstrapRecord['learningState'] = {
      compositionWeights: Object.fromEntries(this.compositionWeights),
      // L3 (19.2/19.3): the decay clocks ride the record (additive fields).
      compositionWeightMeta: Object.fromEntries(this.compositionWeightMeta),
      behaviorOutcomeAt: Object.fromEntries(this.behaviorOutcomeAt),
      behaviorOutcomes: Object.fromEntries(
        Object.entries(this.behaviorOutcomes).map(([option, record]) => [option, { ...record }])
      ) as Record<string, { wins: number; losses: number }>,
      // L2 (20.4): fadeState is GONE — λ derives from the trust kernel; its
      // evidence rides graderReliability below.
      exposureCounts: Object.fromEntries(this.exposureCounts),
      encounterCounts: Object.fromEntries(this.encounterCounts),
      drillFailures: Object.fromEntries(this.drillFailures),
      producedCues: [...this.producedConversationCues],
      cueConfidence: Object.fromEntries(this.cueConfidence),
      bootstrapImportedMeta: this.bootstrapImportedMeta ?? undefined,
      graderReliability: this.reliabilityModel.snapshot()
    };

    return {
      version: BOOTSTRAP_VERSION,
      vocabularyScheme: BOOTSTRAP_VOCABULARY_SCHEME,
      deck,
      generatedAt: now,
      encoding: 'q16' as const,
      primeBasis: primeBasis.length > 0 ? primeBasis : undefined,
      source: {
        words: wordStates.map((state) => state.word),
        conversation: this.conversationTraceIds.size > 0,
        definitionsFilled: definitions.length > 0
      },
      traces,
      wordStates,
      definitions,
      relations: this.chaperoneRelations.length > 0 ? this.chaperoneRelations : undefined,
      compiledRules: this.compiledRules.length > 0 ? this.compiledRules : undefined,
      answerGrades: this.answerGrades.length > 0 ? this.answerGrades : undefined,
      edgeConfidence:
        this.edgeConfidence.size > 0 ? Object.fromEntries(this.edgeConfidence) : undefined,
      edgeSources: this.edgeSources.size > 0 ? Object.fromEntries(this.edgeSources) : undefined,
      negations: this.negations.length > 0 ? this.negations : undefined,
      resolvedSweepConflicts:
        this.resolvedSweepConflicts.size > 0 ? [...this.resolvedSweepConflicts] : undefined,
      rewriteRules:
        this.ruleStore.all().filter((rule) => rule.origin !== 'authored').length > 0
          ? this.ruleStore
              .all()
              .filter((rule) => rule.origin !== 'authored')
              .map((rule) => ({ ...rule }))
          : undefined,
      rewriteDenials: this.ruleStore.allDenials().length > 0 ? this.ruleStore.allDenials() : undefined,
      ruleResolutions: this.ruleResolutions.size > 0 ? [...this.ruleResolutions] : undefined,
      authoredAnswers:
        this.authoredAnswers.size > 0
          ? [...this.authoredAnswers.entries()].map(([utterance, entry]) => ({
              utterance,
              traceIds: entry.traceIds,
              at: entry.at,
              score: typeof entry.score === 'number' ? entry.score : undefined,
              provider: typeof entry.provider === 'string' ? entry.provider : undefined,
              template: typeof entry.template === 'string' ? entry.template : undefined
            }))
          : undefined,
      driveWeights: Object.keys(weights).length > 0 ? weights : undefined,
      goalHistory: Object.keys(goalHistory).length > 0 ? goalHistory : undefined,
      learningState
    };
  }

  /** Note a creative answer the observer itself produced (the seed traces
   *  it was composed from + when). */
  protected noteAuthoredAnswer(utterance: string, seedTraceIds: string[]): void {
    const key = utterance.trim().toLowerCase();
    if (key.length === 0) return;
    this.authoredAnswers.set(key, { traceIds: seedTraceIds, at: Date.now() });
  }

  /** The answer the observer last gave for an utterance (for re-ask credit). */
  protected previousAnswerFor(utterance: string): { traceIds: string[]; at: number; score?: number | null; provider?: string | null; template?: string | null; compositeBand?: GradeBand | null } | undefined {
    return this.authoredAnswers.get(utterance.trim().toLowerCase());
  }

  /** The reliability criteria of an authored answer, rebuilt at world-
   *  feedback time. The provider and the question template travel with the
   *  entry (captured at grade time); the difficulty band comes from the
   *  seeds' FSRS state. */
  protected worldFeedbackCriteria(authored: { traceIds: string[]; provider?: string | null; template?: string | null }, utterance: string): GradeCriteria {
    return {
      answerType: 'creative',
      difficultyBand: this.difficultyBandOfSeeds(authored.traceIds),
      template: authored.template ?? classifyUtterance(utterance),
      provider: authored.provider ?? ''
    };
  }

  /** RE-ASK CREDIT: the user asked this again — the prior answer failed.
   *  Weaken the composition paths it used (the same gradient the LLM's weak
   *  grade applies), and record the miss as an unanswered gap. */
  protected creditReAsk(utterance: string): void {
    const prior = this.previousAnswerFor(utterance);
    if (prior === undefined) return;
    // GRADER RELIABILITY — WORLD FEEDBACK: the world just contradicted the
    // prior answer. A grade that called it STRONG was wrong; a grade that
    // called it WEAK was right. Counted as weak evidence — the world
    // confirms slowly, and this bucket's reliability moves only a little.
    if (typeof prior.score === 'number') {
      this.reliabilityModel.recordWorldFeedback(
        this.worldFeedbackCriteria(prior, utterance),
        gradeBandOf(prior.score) !== 'strong'
      );
    }
    // L2 (20.3): the same world verdict measures the COMPOSITE judge — a
    // re-ask contradicts a composite that called the answer strong.
    if (prior.compositeBand !== undefined && prior.compositeBand !== null) {
      this.reliabilityModel.recordJudgeAgreement(
        JUDGE_COMPOSITE,
        this.worldFeedbackCriteria(prior, utterance),
        prior.compositeBand !== 'strong',
        WORLD_FEEDBACK_WEIGHT
      );
    }
    const bank = this.session.observer.getMemoryBank();
    const contents: string[] = [];
    for (const id of prior.traceIds) {
      const trace = bank.get(id);
      if (trace !== undefined) contents.push(trace.content);
    }
    if (contents.length > 0) {
      // L1b: the re-ask is the world's full-strength weaken — the helper's
      // weak extreme (creativeGradeDelta(0) = −CREATIVE_GRADE_DELTA).
      bumpAgedWeights(this.compositionWeights, this.compositionWeightMeta, contents, creativeGradeDelta(0));
    }
    for (const id of prior.traceIds) {
      const trace = bank.get(id);
      if (trace !== undefined) bank.reinforce(id, creativeGradeDelta(0));
    }
    // The gap is recorded by the ask path itself — never double-bump.
  }

  /** RETENTION CREDIT: this trace was recalled again later — the answer was
   *  worth keeping. Reinforce its composition paths by the small retention
   *  delta (a weaker, cumulative signal than the LLM grade — the world
   *  confirms slowly, the teacher confirms sharply). */
  creditRetention(traceId: string): void {
    const trace = this.session.observer.getMemoryBank().get(traceId);
    if (trace === undefined) return;
    // GRADER RELIABILITY — WORLD FEEDBACK: the world kept this answer. A
    // grade that called it STRONG is confirmed; a grade that called it WEAK
    // was wrong. The authored answer that stored it carries the grade.
    for (const authored of this.authoredAnswers.values()) {
      if (!authored.traceIds.includes(traceId) || typeof authored.score !== 'number') continue;
      this.reliabilityModel.recordWorldFeedback(
        this.worldFeedbackCriteria(authored, trace.content),
        gradeBandOf(authored.score) === 'strong'
      );
      // L2 (20.3): retention confirms a composite that called it strong.
      if (authored.compositeBand !== undefined && authored.compositeBand !== null) {
        this.reliabilityModel.recordJudgeAgreement(
          JUDGE_COMPOSITE,
          this.worldFeedbackCriteria(authored, trace.content),
          authored.compositeBand === 'strong',
          WORLD_FEEDBACK_WEIGHT
        );
      }
      break;
    }
    // L1b: retention is the world's slow confirm — the helper's strong
    // extreme (creativeGradeDelta(1) = +CREATIVE_GRADE_DELTA) × the
    // retention fraction.
    bumpAgedWeights(this.compositionWeights, this.compositionWeightMeta, [trace.content], creativeGradeDelta(1) * RETENTION_FRACTION);
    this.session.observer.getMemoryBank().reinforce(traceId, creativeGradeDelta(1) * RETENTION_FRACTION);
  }

  /** Feed a freshly measured bench agreement (7a Spearman window) into the
   *  kernel as composite-judge evidence: a window at/above the strong band
   *  agrees, below it disagrees. The raw value is kept as telemetry. */
  noteFadeAgreement(cls: GradeClass, agreement: number): void {
    this.fadeAgreementTelemetry[cls] = agreement;
    this.reliabilityModel.recordJudgeAgreement(JUDGE_COMPOSITE, fadeCriteria(cls), agreement >= GRADE_STRONG_THRESHOLD);
  }

  /** L2 (20.4) MIGRATION: a legacy record's stored per-class λ becomes
   *  equivalent kernel evidence — 20 samples at the stored agreement rate —
   *  so an upgraded observer keeps its earned handover instead of resetting
   *  to scaffolded. (Additive: runs once per restored legacy record; new
   *  records carry no fadeState.) */
  seedLegacyFadeState(fade: { lambda?: Record<string, number> }): void {
    if (typeof fade.lambda !== 'object' || fade.lambda === null) return;
    for (const cls of ['conversational', 'operator', 'other'] as const) {
      const lambda = fade.lambda[cls];
      if (typeof lambda !== 'number' || !Number.isFinite(lambda) || lambda <= 0) continue;
      const criteria = fadeCriteria(cls);
      const mass = 20;
      const agreeMass = clampRange(lambda, 0, 1) * mass;
      if (agreeMass > 0) this.reliabilityModel.recordJudgeAgreement(JUDGE_COMPOSITE, criteria, true, agreeMass);
      if (mass - agreeMass > 0) this.reliabilityModel.recordJudgeAgreement(JUDGE_COMPOSITE, criteria, false, mass - agreeMass);
    }
  }

  /** The latest measured bench agreement per class (telemetry). */
  fadeAgreements(): Record<GradeClass, number | null> {
    return { ...this.fadeAgreementTelemetry };
  }

  /** The current per-class λ (read-only) — DERIVED from the trust kernel. */
  fadeLambdas(): Record<GradeClass, number> {
    return {
      conversational: this.reliabilityModel.lambdaFor(fadeCriteria('conversational')),
      operator: this.reliabilityModel.lambdaFor(fadeCriteria('operator')),
      other: this.reliabilityModel.lambdaFor(fadeCriteria('other'))
    };
  }

  /** The last-imported bootstrap meta (read-only, null = never imported). */
  lastBootstrapImported(): { generatedAt: string; words: number } | null {
    return this.bootstrapImportedMeta;
  }

  /** Record that a bootstrap deploy was imported (persisted in the
   *  learning state so the comparison survives reloads). */
  markBootstrapImported(meta: { generatedAt: string; words: number }): void {
    this.bootstrapImportedMeta = meta;
    this.maybePersist();
  }

  /** Teacher-dependence rate (20.5): the traffic-weighted mean TEACHER SHARE
   *  (1 − λ) over graded answers. 0 = fully handed-over; 1 = fully
   *  scaffolded; 0 before any graded traffic. */
  teacherDependenceRate(): number {
    if (this.lambdaTraffic.count === 0) return 0;
    return clampRange(1 - this.lambdaTraffic.sum / this.lambdaTraffic.count, 0, 1);
  }

  /** The blended reward for a graded answer: λ·composite + (1−λ)·teacher,
   *  with λ the EMERGENT handover weight (normalized trust, L2). The
   *  student's composite is also a MEASURED JUDGE (20.3): its band is
   *  checked against the rule-based grounding band right here, so every
   *  graded answer feeds the very trust that λ is computed from.
   *
   *  The composite is the student's judgment ON ITS OWN MATERIAL: it must be
   *  computed against the answer's actual SEEDS (the recalled memories the
   *  composition was built from). Grading the answer against itself as its
   *  own seed collapses novelty to 0 and the composite to 0, and the
   *  blendReward guard passes the teacher grade through — the abstention
   *  path (subsuming the old isUncertain fallback: the composite is
   *  multiplicative, so fluency 0 ⇒ composite 0 ⇒ teacher grades). */
  fadeReward(utterance: string, answer: string, teacherGrade: number, seeds: readonly string[]): number {
    const cls = classifyUtterance(utterance);
    const criteria = fadeCriteria(cls);
    const { composite } = compositeScore(answer, utterance, this.compositionWeights, seeds);
    // 20.3: the composite judges — measure it. Only when it HAS an opinion
    // (composite > 0) and a rule check exists (seeds present): an abstaining
    // judge earns no evidence either way.
    if (composite > 0 && seeds.length > 0 && answer.trim().length > 0) {
      const ruleBand = ruleBandForGrounding(groundingScore(answer, seeds));
      this.reliabilityModel.recordJudgeAgreement(
        JUDGE_COMPOSITE,
        criteria,
        bandsAgree(gradeBandOf(composite), ruleBand)
      );
    }
    const lambda = this.reliabilityModel.lambdaFor(criteria);
    // Dependence accounting (20.5): the teacher's share of THIS reward. A
    // composite with no opinion consults the teacher fully (λ-effective 0).
    const effective = composite > 0 ? lambda : 0;
    this.lambdaTraffic.sum += effective;
    this.lambdaTraffic.count += 1;
    return blendReward(teacherGrade, composite, lambda);
  }
}