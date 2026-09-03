/**
 * The shared core of the TeacherAgent (the agent split refactor).
 *
 * TeacherAgentCore holds ALL state the faculties read: the constructor-
 * injected observer session / persistence store / PRNGs / operator learner /
 * curriculum facts, plus every working field of the old single class, moved
 * verbatim with `private` -> `protected`. Fields declared here are assigned
 * either by their own initializers or by the final TeacherAgent constructor
 * (definite-assignment `!`); the base deliberately has no constructor of its
 * own, so initializers run in declaration order when the composed class is
 * constructed — exactly as they did in the single class.
 *
 * CrossFacultyApi is the type-level contract between faculties: methods one
 * mixin calls on another are declared here as the compiler demands them, so
 * no faculty ever imports another faculty at runtime and the mixin
 * composition order is free. Only methods (public, or widened to public)
 * that are genuinely invoked across a faculty boundary live here — at the
 * end it documents the internal coupling surface.
 */
import type { ObserverSession } from '../../observer/engine';
import type { PersistenceStore } from '../../persistence/store';
import {
  RECALL_SETTLE_STEPS,
  REVIEW_STRENGTH_THRESHOLD,
  type WordState,
  type AutoLoopStep,
  type CompiledRule,
  type AnswerGradeEntry,
  type AnswerProvenance,
  type TeachResult,
  type QuizAnswer,
  type GradeResult,
  type ConversationAnswer
} from './support';
import { EpisodicMemory } from '../episodic';
import { OperatorLearner } from '../operators/learning';
import { mulberry32, type RelationalHologram } from '@sschepis/sentient-core';
import type { CurriculumConfig } from '../curriculum';
import { CalibrationLedger } from '../calibration';
import { WorkingMemory } from '../context';
import { LearnedFrameStore } from '../learnedFrames';
import { RuleStore } from '../rules/types';
import { PEANO_RULES } from '../rules/peano';
import { DIGITS_RULES } from '../rules/digits';
import { INT_RULES } from '../rules/int';
import { LOGIC_RULES } from '../rules/logic';
import { ALG_RULES } from '../rules/alg';
import { CompositionRuleStore } from '../rules/compositionSeeds';
import { TokenCostModel } from '../mdl';
import { ACTIVE_DECK } from '../decks';
import { GraderReliabilityModel, type GradeBand, type DifficultyBand } from '../reliability';
import type { GradeClass } from '../fade';
import type { LearningGoal, GoalType } from '../plan';
import { groundingAttribution } from '../grounding';
import type { BehaviorWeights, BehaviorOption } from '../drives';
import type { TransitionWeights, ConversationPair } from '../conversation';
import type { WeightMeta } from '../agedWeights';
import type { Relation, SourceClass, Negation, RelationPredicate } from '../relations';
import type { DerivationDenial } from '../rules/types';

export type Constructor<T = object> = new (...args: any[]) => T;

/**
 * The type-level contract between faculties: methods one mixin calls on
 * another are declared here as the compiler demands them. Members are public
 * (methods widened to public when they cross a faculty boundary); fields stay
 * centralized on TeacherAgentCore, so this interface never carries state.
 * Implementations live in the faculty mixins or, until a faculty is split
 * out, on the composed TeacherAgent itself — the mixin chain's base is cast
 * to include this API at the composition site in TeacherAgent.ts.
 */
export interface CrossFacultyApi {
  // ── wordloop ────────────────────────────────────────────────────────────
  teach(word: string): TeachResult;
  ask(word: string, direction?: 'recognition' | 'production'): QuizAnswer;
  grade(word: string, question: QuizAnswer): GradeResult;
  applyRetention(now?: number): void;
  applyDefinitions(definitions: ReadonlyArray<{ word: string; definition: string; example: string }>): number;
  recordAnswerGrade(utterance: string, mode: string, verdict: AnswerGradeEntry['verdict'], provenance: AnswerProvenance): void;
  difficultyBandOfSeeds(seedTraceIds: readonly string[]): DifficultyBand;
  exciteAndSettle(utterance: string): void;
  recallMemories(utterance: string, topK?: number): Array<{ content: string; id: string; score: number }>;
  // ── curriculum ──────────────────────────────────────────────────────────
  nextReview(): string | null;
  nextNewWord(): string | null;
  // ── relations ───────────────────────────────────────────────────────────
  relations(): Relation[];
  addEdgeSource(subject: string, predicate: string, object: string, sourceClass: SourceClass): void;
  bumpEdge(subject: string, predicate: string, object: string, delta: number): void;
  removeEdgeSource(subject: string, predicate: string, object: string, sourceClass: SourceClass): void;
  storeNegation(subject: string, predicate: RelationPredicate, object: string, evidence: string, origin?: Negation['origin']): void;
  invalidateRelations(): void;
  // ── rules ───────────────────────────────────────────────────────────────
  weakenRule(id: string, weight: number, denial?: Partial<DerivationDenial>): void;
  // ── operators ───────────────────────────────────────────────────────────
  rebuildLearnedOperators(): void;
  // ── motivation ──────────────────────────────────────────────────────────
  noteBehaviorOutcome(option: BehaviorOption, win: boolean): void;
  recordGap(utterance: string): void;
  forgetGap(utterance: string): void;
  deficitBeliefs(): Array<{ about: string; content: string }>;
  // ── conversation ────────────────────────────────────────────────────────
  storeBelief(about: string, content: string, beliefKind: string, basis: Record<string, unknown>, contradicts?: boolean): boolean;
  respond(utterance: string): ConversationAnswer;
  teachResponse(pair: ConversationPair): string | null;
  latestBelief(about: string): {
    traceId: string;
    content: string;
    beliefKind: string;
    contradicts: boolean;
    basis: Record<string, unknown>;
    strength: number;
  } | null;
  // ── creative ────────────────────────────────────────────────────────────
  creditRetention(traceId: string): void;
  seedLegacyFadeState(fade: { lambda?: Record<string, number> }): void;
  // ── goals ───────────────────────────────────────────────────────────────
  storeGoalIfNewInStatic(trace: unknown): void;
  // ── persistence ─────────────────────────────────────────────────────────
  maybePersist(): void;
}

export class TeacherAgentCore {
  // ── Constructor-injected (assigned by TeacherAgent's constructor) ─────────
  protected session!: ObserverSession;
  protected persistence: PersistenceStore | null = null;
  protected persistEvery = 1;
  protected settleSteps = RECALL_SETTLE_STEPS;
  protected episodic!: EpisodicMemory;
  protected operatorLearner!: OperatorLearner;
  protected knownWords!: ReadonlySet<string>;
  protected compositionRng!: () => number;
  protected hiddenRelationKeys: ReadonlySet<string> | null = null;
  protected curriculumConfig: CurriculumConfig = {};
  protected rewriteInduction = false;

  /** Seeded stream so the arbitration PRNG is a genuine mulberry32; the
   *  composition stream is injected (session-seeded or Math.random). */
  protected readonly arbitrationRng: () => number = mulberry32(0xd21ce5);
  protected readonly states = new Map<string, WordState>();
  protected autoLoopToken = 0;
  protected autoLoopRunning = false;
  protected autoStep: AutoLoopStep | null = null;
  protected readonly autoListeners = new Set<(step: AutoLoopStep) => void>();
  /** Trace ids of memorized conversation exchanges (kind: 'conversation'). */
  protected readonly conversationTraceIds = new Set<string>();
  /** Cues that have been taught, so re-teaching is a no-op. */
  protected readonly taughtConversationCues = new Set<string>();
  /** Cues the observer has actually spoken in reply (competency measure). */
  protected readonly producedConversationCues = new Set<string>();
  /** Uttered keys of stored creative answers — O(1) dedup (no bank scan). */
  protected readonly creativeUtteredKeys = new Set<string>();
  /** Belief traces stored about the observer's own state — dedup keys. */
  protected readonly beliefsStored = new Set<string>();
  /** Last measured recall confidence per cue (belief-drops detection). */
  protected readonly lastRecallConfidence = new Map<string, number>();
  /** Learned arbitration weights — experience modifies what the observer
   *  prioritizes. Persisted; absent weights use archetypal defaults. */
  protected behaviorWeights: BehaviorWeights = {};
  /** Outcome cascade per behavior — the credit history behind the weights. */
  protected readonly behaviorOutcomes: Record<BehaviorOption, { wins: number; losses: number }> = {
    answer: { wins: 0, losses: 0 },
    ask: { wins: 0, losses: 0 },
    compose: { wins: 0, losses: 0 },
    practice: { wins: 0, losses: 0 },
    verify: { wins: 0, losses: 0 }
  };
  /** Learned transition weights for creative composition (surprise terrain). */
  protected readonly compositionWeights: TransitionWeights = new Map<string, number>();
  /** L3 (19.2): per-n-gram use stamps — the decay clock of the weights. */
  protected readonly compositionWeightMeta: WeightMeta = new Map<string, number>();
  /** L3 (19.3): per-behavior last-outcome stamps — the drive drift clock. */
  protected readonly behaviorOutcomeAt = new Map<BehaviorOption, number>();
  /** Phase 24.3 (W8): the read-only calibration ledger — the riskiest
   *  confidence gates record (score, outcome) evidence; benches read drift. */
  protected readonly calibration = new CalibrationLedger();
  /** Trace ids of memorized STRONG creative answers (kind: 'creative'). */
  protected readonly creativeMemoryIds = new Set<string>();
  /** Utterances the observer could not answer (kind: 'gap' traces). */
  protected readonly gapUtterances = new Set<string>();
  /** Trace ids of recorded gaps (kind: 'gap'). */
  protected readonly gapTraceIds = new Set<string>();
  /** How many times each gap was re-encountered unanswered (curiosity fuel). */
  protected readonly gapMissCounts = new Map<string, number>();
  /** Deck words the observer has heard often without a definition. */
  protected readonly encounterCounts = new Map<string, number>();
  /** Content words the observer has heard in conversation (introspection). */
  protected readonly exposureCounts = new Map<string, number>();
  /** Last recall confidence per practiced cue (for review-curiosity). */
  protected readonly cueConfidence = new Map<string, number>();
  /** Curiosity triggers already asked (one question per trigger). */
  protected readonly curiosityAsked = new Set<string>();
  /** Answer-mode counters — the deviation meter (session-scoped by design:
   *  grounding is measured over the live session, not across restarts). */
  protected readonly modeCounts: Record<string, number> = {};
  /** Per-composition grounding accumulation — the deviation meter's
   *  attribution: composed answers split into grounded (own material) and
   *  deviated (stitched) exposure. */
  protected readonly groundingTotal = { answers: 0, grounded: 0, deviated: 0 };

  protected noteAnswerMode(mode: string): void {
    this.modeCounts[mode] = (this.modeCounts[mode] ?? 0) + 1;
  }

  /** Session answer-mode counts: memorized/operator (grounded), creative
   *  (composed — deviation expected), ask/decline (abstained). */
  answerModeCounts(): Readonly<Record<string, number>> {
    return { ...this.modeCounts };
  }

  /** The deviation meter's grounding attribution (Phase 8): across all
   *  composed answers, how much speaks the observer's own material vs.
   *  deviated from it. */
  groundingAttribution(): { answers: number; groundedShare: number; deviatedShare: number } {
    if (this.groundingTotal.answers === 0) {
      return { answers: 0, groundedShare: 0, deviatedShare: 0 };
    }
    return {
      answers: this.groundingTotal.answers,
      groundedShare: this.groundingTotal.grounded / this.groundingTotal.answers,
      deviatedShare: this.groundingTotal.deviated / this.groundingTotal.answers
    };
  }

  /** Note a composed answer's grounding into the meter. */
  protected noteGrounding(grounding: number): void {
    const attribution = groundingAttribution(grounding);
    this.groundingTotal.answers += 1;
    this.groundingTotal.grounded += attribution.grounded;
    this.groundingTotal.deviated += attribution.deviated;
  }

  /** Recent conversation turns (session-scoped context for references). */
  protected readonly workingMemory = new WorkingMemory();
  /** Lazily extracted relational edges over the deck definitions. */
  protected relationsCache: Relation[] | null = null;
  /** LLM-supplied (Chaperone) edges, reconciled and provenance-tagged. */
  protected chaperoneRelations: Relation[] = [];
  /**
   * Per-edge confidence overlay (P8): key = subject\u0000predicate\u0000object,
   * value = the signed delta applied over the derived graph's base strength
   * (1 per stated source). Agreement bumps +1; wrong grades of answers citing
   * the edge weaken it. Persisted with the learning state.
   */
  protected edgeConfidence = new Map<string, number>();
  /**
   * P14 per-edge corroboration store: key = subject\u0000predicate\u0000object,
   * value = the INDEPENDENT source classes that support the edge beyond its
   * own origin class — conversation evidence mined from user statements,
   * world-feedback from accepted graded answers, and definition-class credit
   * from an agreeing chaperone edge. Rides the derived graph as
   * `Relation.sourceClasses`; persisted with the learning state.
   */
  protected edgeSources = new Map<string, SourceClass[]>();
  /**
   * M5 (Phase 22): THE HYPOTHESIS TIER — proposer/validator split. Loose
   * extractions (objects that are real content words but not deck words —
   * "a bird is a creature", "with feathers") are held here as standing
   * hypotheses: spoken only hedged, never chained, never merged into the
   * asserted graph — until CORROBORATION promotes them (a second
   * independent source class via addEdgeSource, e.g. conversation mining or
   * a strong world grade citing the edge). Precision lives in the promotion
   * gate, not the proposer. Bounded FIFO.
   */
  protected hypothesisEdges: Relation[] = [];
  /**
   * P14 example corpus index: content token -> deck example sentences (from
   * the taught states' `example` fields). Built once per relations-cache
   * build; a chaperone edge corroborated by a curriculum example sentence
   * ("A bird can fly." is the deck itself confirming bird capable-of fly)
   * gains the 'curriculum' class.
   */
  protected exampleIndex: Map<string, string[]> | null = null;
  /** P14 user statements from PERSISTED conversations, mined once at
   *  construction (the live turns are mined as they arrive). */
  protected readonly persistedConversationTexts: string[] = [];
  /**
   * The confirmed-false store (P8): claims explicitly taught ("golf is not a
   * bird") or confirmed by a graded "No" answer. The ONLY source of "No" —
   * absence of evidence never answers absence.
   */
  protected negations: Negation[] = [];
  /**
   * The contradiction-sweep resolution ledger: conflict ids the world has
   * resolved through the sweep. ONE-SHOT — a resolved conflict is never
   * re-reported (no ping-pong), even when its edges still show both sides
   * (a multi-source positive edge cannot fall below the support floor).
   * Persisted with the learning state, capped like the grade ledger.
   */
  protected resolvedSweepConflicts: Set<string> = new Set();
  /**
   * The distributed-vector VIEW over the relation graph (P1): H(subject) =
   * Σ bind(role, object), rebuilt whenever the cache is invalidated. It is a
   * pure function of relations() — never persisted.
   */
  protected relationalHologram: RelationalHologram | null = null;
  /**
   * LEARNED LANGUAGE TEMPLATES (P5 extension): the relation-hole templates
   * induced from accepted grounded answers, admitted only when they survive
   * the internal critic and match or beat the fixed-frame acceptance
   * baseline. Session-scoped like the deviation meter (modeCounts/
   * groundingTotal) — the fixed frames remain the evergreen seed set.
   */
  protected readonly learnedFrames = new LearnedFrameStore();
  /** Executable rules induced from drills (P2): DSL programs compiled into
   *  first-class operators. Persisted with the learning state. */
  protected compiledRules: CompiledRule[] = [];
  /**
   * THE REWRITE RULE STORE (R0–R5): the observer's procedures as memories.
   * Authored decks (Peano naturals, digit strings, signed integers, the
   * boolean/logic deck) are seeded from code; induced rules are added by
   * the drill loop and restored from the bootstrap record. Rules are
   * gradeable, corroborated, denied, and stopped — never deleted.
   */
  protected readonly ruleStore = new RuleStore([...PEANO_RULES, ...DIGITS_RULES, ...INT_RULES, ...LOGIC_RULES, ...ALG_RULES]);
  /** Composition rules as a learnable seed set (R4b): the fixed table stays
   *  the evergreen floor; the world's accepted chains admit new sequences. */
  protected readonly compositionRules = new CompositionRuleStore();
  /** One-shot ledger of stopped rules (R5) — a rule the world denied twice
   *  stays stopped across reloads; the record is kept, never re-litigated. */
  protected readonly ruleResolutions = new Set<string>();
  /** R11: open rule questions — the drill loop raised "what is the rule
   *  for X?" and a procedure answer is being awaited (concept → drill).
   *  The chat's teach-reply consumes one entry when the user's text parses
   *  as a rule for it. */
  protected readonly pendingRuleQuestions = new Map<string, string>();
  /** The MDL frequency prior for composition gating (P10): the full deck's
   *  Zipf costs, fixed once per agent — the same prior the operator learner
   *  uses, so generation and operator paths gate chains identically. */
  protected readonly compositionCost = new TokenCostModel(ACTIVE_DECK.map((entry) => entry.word));
  /**
   * Bounded per-answer grade ledger (P7): who produced each graded answer
   * and how it was graded — the surgical-repair record. Persisted like
   * strengthHistory.
   */
  protected answerGrades: AnswerGradeEntry[] = [];
  /**
   * THE GRADER RELIABILITY MODEL: per-criteria (answer type, FSRS difficulty
   * band, question template, provider) agreement between the LLM teacher's
   * grades and the rule-based checks / later world verdicts. Low-reliability
   * buckets contribute less to edge confidence, trace reinforcement, and
   * FSRS state updates; disagreements schedule re-grades whose outcomes feed
   * the same model. Persisted with the learning state.
   */
  protected readonly reliabilityModel = new GraderReliabilityModel();
  protected persistCounter = 0;
  /**
   * Writes are chained, never overlapped: the store's saveWordStates and
   * saveTraces both clear-then-bulkPut, so two concurrent runs can
   * interleave into a truncated table. The chain is the serialization
   * point; `flush()` awaits it.
   */
  protected persistChain: Promise<void> = Promise.resolve();
  protected persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Wall-clock of the first unwritten mutation (bounds the coalescing). */
  protected dirtySince: number | null = null;
  /**
   * Runtime-tunable behaviour. Never the prime basis — changing that would
   * decode stored traces against a mismatched encoding.
   */
  protected tuning = { forgettingRate: 1, reviewThreshold: REVIEW_STRENGTH_THRESHOLD };

  /** Consecutive failed drill rounds per technical concept (weak-drill
   *  signal). Persisted with the learning state. */
  protected readonly drillFailures = new Map<string, number>();
  /** Lazy semantic vocabulary over the teacher's own deck (the sparsity
   *  signal's neighborhood graph) — ~75 ms at the full 20k deck, once. */
  protected curriculumVocabCache: Record<string, number[]> | null = null;

  /** Live observer state for model visualization (coherence, entropy, ...). */
  observerState(): { coherence: number; entropy: number; orderParameter: number; memoryTraceCount: number; momentCount: number; totalAmplitude: number } | null {
    try {
      const state = this.session.observer.getState();
      return {
        coherence: state.coherence,
        entropy: state.entropy,
        orderParameter: state.orderParameter,
        memoryTraceCount: state.memoryTraceCount,
        momentCount: state.momentCount,
        totalAmplitude: state.totalAmplitude
      };
    } catch {
      return null;
    }
  }

  /** The observer's memory bank (read-only access for benches/CLI). */
  getMemoryBank() {
    return this.session.observer.getMemoryBank();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Autonomous teaching loop
  // ─────────────────────────────────────────────────────────────────────────

  /** The goals the planner is pursuing (installed by adoptGoals). */
  protected readonly goals: LearningGoal[] = [];
  protected goalLoopToken = 0;
  protected goalLoopRunning = false;

  protected traceOf(traceId: string): ReturnType<ReturnType<ObserverSession['observer']['getMemoryBank']>['get']> {
    return this.session.observer.getMemoryBank().get(traceId);
  }

  protected requiredState(word: string): WordState {
    const state = this.states.get(word);
    if (!state) {
      throw new Error(`Unknown deck word: ${word}`);
    }
    return state;
  }

  // ── Planner support ───────────────────────────────────────────────────────

  /** Wait — a safe lookup that returns null instead of throwing. */
  tryState(word: string): WordState | null {
    return this.states.get(word) ?? null;
  }

  // ── WORLD FEEDBACK (Phase 7b): the world as junior judge ─────────────────
  //
  // The LLM is the teacher; the WORLD is the junior judge. Two signals need
  // no teacher at all, because they ARE the outcome:
  //   · RE-ASK — the user asks the same question again: the prior answer
  //     failed. Its composition paths must be weakened.
  //   · RETENTION — a stored creative trace gets recalled again later: the
  //     answer was worth keeping. Its paths must be reinforced.
  // Both flow into the SAME composition-weights gradient as the LLM grade,
  // so the observer learns from the world's replies even during scaffolding.

  /** Recently-produced creative answers, keyed by their utterance, with the
   *  trace ids they were composed from (for retention + re-ask credit). The
   *  LLM grade's score, provider, and question template travel with the
   *  entry so a later world verdict can confirm or contradict the grade
   *  under the ORIGINAL bucket (the reliability model's world-feedback
   *  channel). */
  protected readonly authoredAnswers = new Map<string, { traceIds: string[]; at: number; score?: number | null; provider?: string | null; template?: string | null; compositeBand?: GradeBand | null }>();

  // ── THE EMERGENT HANDOVER (L2, Phase 20 — replaced the Phase 7c fading
  // controller): λ is normalized trust from the kernel, not stored state. ──
  /** Latest measured bench agreement per class (telemetry only — the λ
   *  evidence is the kernel's, this is the report card's raw number). */
  protected readonly fadeAgreementTelemetry: Record<GradeClass, number | null> = {
    conversational: null,
    operator: null,
    other: null
  };
  /** λ-traffic accounting (20.5): the dependence rate is the traffic-
   *  weighted mean teacher share over graded answers. */
  protected readonly lambdaTraffic = { sum: 0, count: 0 };

  /** Which bootstrap deploy was last imported (generatedAt + word count) —
   *  so the UI can tell a NEWER headless deploy from stale IndexedDB state. */
  protected bootstrapImportedMeta: { generatedAt: string; words: number } | null = null;

  /** PER-GOAL-TYPE outcome history — the observer's own record of whether
   *  its plans tend to work (feeds expected-value choice + introspection). */
  protected readonly goalHistory: Record<GoalType, { completed: number; abandoned: number }> = {
    'learn-word': { completed: 0, abandoned: 0 },
    'fill-gap': { completed: 0, abandoned: 0 },
    practice: { completed: 0, abandoned: 0 },
    'verify-belief': { completed: 0, abandoned: 0 }
  };
}
