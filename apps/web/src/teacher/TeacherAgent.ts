import type { RecallResult } from '@sschepis/sentient-core';
import type { ObserverSession } from '../observer/engine';
import type { PersistenceStore } from '../persistence/store';
import { lessonText, productionCue, recognitionCue, hasDefinition, type DeckWord } from './deck';
import {
  CONVERSATION_RECALL_FLOOR,
  CREATIVE_UNLOCK_THRESHOLD,
  composeCreativeResponse,
  updateCompositionWeights,
  type ConversationPair,
  type CreativeComposition,
  type TransitionWeights
} from './conversation';
import { applyOperator, isClockOrDateQuestion, clockAnswer, clusterGaps, questionFormOf, parseNegationStatement, type OperatorResult } from './operators';
import { composeGrounded, criticize, groundedSubjects, hedgeComposition } from './groundedFrames';
import { deniedFromNegations } from './chain';
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
import { emptyFadeState, updateFadeState, effectiveLambda, isUncertain, classifyUtterance, blendReward, FADE_FLOOR, type FadeState, type GradeClass } from './fade';
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
  type AnswerType,
  type DifficultyBand,
  type GradeCriteria,
  type ReliabilitySnapshot
} from './reliability';
import { RelationalHologram, mulberry32 } from '@sschepis/sentient-core';
import { matchArgs, evaluate, canonicalNumber, conversionPairOf, type DSLExpr } from './technical/dsl';

/** An executable rule compiled from drill induction (P2). */
export interface CompiledRule {
  id: string;
  concept: string;
  drill: string;
  program: DSLExpr;
  /** MDL size of the program. */
  nodes: number;
  /** Description length of the program in bits. */
  bits: number;
  trainCount: number;
  instanceBits: number;
  /** For the conversion families (H2): the exact unit pair the rule was
   *  induced on — the fire-time guard that a unit-blind multiplier never
   *  answers a prompt of another family or direction. */
  conversionFrom?: string;
  conversionTo?: string;
}
import { technicalRelations } from './technical';
import { SUPPLEMENTAL_RELATIONS } from './decks/relationSupplements';
import { GROUNDED_FACTS_RELATIONS } from './decks/groundedFacts';
import { OperatorLearner } from './operators/learning';
import { TokenCostModel } from './mdl';
import { ACTIVE_DECK } from './decks';
import { loadConversations } from './conversations';
import { computeDrives, chooseBehavior, updateDriveWeight, ARCHETYPAL_BEHAVIORS, type DriveSignals, type DriveState, type BehaviorOption, type BehaviorWeights } from './drives';
import { WorkingMemory, resolveReferences, extractUnknownSubject, tokenizeText, singularize, isContentWord, cosineSimilarity, type WorkingTurn } from './context';
import { EpisodicMemory, EPISODIC_SPOKEN_RELEVANCE_FLOOR, type EpisodicFact, type RememberedFact } from './episodic';
import { clampRange } from '@sschepis/sentient-core';
import {
  BOOTSTRAP_VERSION,
  BOOTSTRAP_VOCABULARY_SCHEME,
  type BootstrapRecord
} from './bootstrap';

export type WordStatus = 'new' | 'learning' | 'consolidated';

/** How long a burst of mutations is coalesced before one write goes out. */
const PERSIST_DEBOUNCE_MS = 750;
/** Ceiling on that coalescing, so a continuous loop still reaches storage. */
const PERSIST_MAX_DELAY_MS = 4000;

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
  /** P9 FSRS: stability in days (the interval that decays to target retention). */
  stability: number;
  /** P9 FSRS: difficulty in [1, 10], learned from the review history. */
  difficulty: number;
  /** P9 FSRS: the next review is due at this timestamp (null until taught). */
  dueAt: number | null;
  /** P9 FSRS: the interval scheduled at the last review (days). */
  lastIntervalDays: number | null;
  /** P-curriculum: persisted review outcomes, capped — the repeated-gap
   *  signal ("items that keep appearing in review sets and keep failing")
   *  must survive reloads, so the queue stays honest across sessions. */
  reviewHistory: Array<'correct' | 'wrong'>;
}

/**
 * True when a word carries learning worth storing. Restore rebuilds every
 * other word from the deck at its defaults, so writing them is pure cost.
 */
function isTouchedWordState(state: WordState): boolean {
  return (
    state.traceId !== null ||
    state.taughtAt !== null ||
    state.lastAskedAt !== null ||
    state.lastGrade !== null ||
    state.successes > 0 ||
    state.failures > 0 ||
    state.strengthHistory.length > 0 ||
    state.stability !== FSRS_INITIAL_STABILITY ||
    state.difficulty !== FSRS_INITIAL_DIFFICULTY ||
    state.reviewHistory.length > 0 ||
    state.dueAt !== null
  );
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
// Conversation (Phase 1: memorized exchanges)
// ────────────────────────────────────────────────────────────────────────────

export interface ConversationAnswer {
  /** The human's utterance as heard. */
  utterance: string;
  /** What the observer says (null when nothing is confidently recalled). */
  response: string | null;
  /** Recall confidence in [0,1] for the chosen response (null when blank). */
  confidence: number | null;
  /** The trace id of the memorized exchange (null when blank). */
  traceId: string | null;
  /** The cue this response was taught under (null when blank). */
  cue: string | null;
  /** What kind of memory won: a taught exchange or a stored creative moment. */
  kind: 'conversation' | 'creative' | null;
}

export interface ConversationReport {
  taught: number;
  /** Pairs recalled at least once — the observer has produced each of them. */
  recalled: number;
  /** recalled / taught. */
  competency: number;
  /** True when competency clears the creative-mode unlock threshold. */
  creativeUnlocked: boolean;
}

/** A typed edge reference — the answerable unit for surgical repair (P7/P8). */
export interface EdgeRef {
  subject: string;
  predicate: RelationPredicate;
  object: string;
}

/** One graded answer and the producers that must bear its verdict (P7). */
export interface AnswerGradeEntry {
  at: number;
  utterance: string;
  mode: string;
  verdict: 'correct' | 'wrong' | 'strong' | 'weak' | 'neutral';
  traceIds: string[];
  edges: EdgeRef[];
  operatorId?: string;
}

/** The ledger's cap — bounded like strengthHistory, never unbounded growth. */
const ANSWER_GRADES_CAP = 200;

/**
 * Who produced an answer: the memory traces it was built from, the typed
 * edges it cited, and the operator identity that fired. Recorded on EVERY
 * answer so a bad grade can weaken exactly the producers (P7) and edge
 * confidence can be maintained per-edge (P8).
 */
export interface AnswerProvenance {
  traceIds: string[];
  edges: EdgeRef[];
  /** The grounded templates the answer was composed from (P5 learned
   *  frames): the world's grade credits or discounts exactly those
   *  structures. Absent = non-grounded or pre-learned-frames callers. */
  templateIds?: string[];
  /** Operator identity: built-in kind, learned patternId, or compiled-rule id. */
  operatorId?: string;
}

export type ChatAnswer =
  | { mode: 'memorized'; response: string; confidence: number | null; cue: string | null; provenance: AnswerProvenance }
  | { mode: 'operator'; response: string; operator: OperatorResult; provenance: AnswerProvenance }
  | { mode: 'creative'; response: string; confidence: number | null; seedTraceIds: string[]; seedCount: number; grounded: boolean; hedged: boolean; templateIds: string[]; provenance: AnswerProvenance }
  | { mode: 'ask'; response: string; provenance: AnswerProvenance }
  | { mode: 'decline'; provenance: AnswerProvenance };

/**
 * A chat answer with the episodic-memory envelope attached: `remembered`
 * names the persistent facts clearly relevant to this turn (each tagged as
 * remembered — never an inference), and `stored` names the facts this turn
 * CREATED (new memories, surfaced to the learning stream). The working-memory
 * window itself stays session-scoped; this is the selective, honest channel
 * across sessions.
 */
export type ChatAnswerWithMemory = ChatAnswer & { remembered?: RememberedFact[]; stored?: EpisodicFact[] };

export interface CreativeReply extends CreativeComposition {
  /** Recall confidence of the seed memories (null when nothing recalled). */
  confidence: number | null;
  /** The observer's own trace ids the composition was built from. */
  seedTraceIds: string[];
  /** P5: true when the sentence was generated from typed frames and passed
   *  the internal critic; false = the labeled Markov fallback. */
  grounded: boolean;
  /** P14: true when the spoken sentence carries a corroboration hedge (any
   *  cited claim is single-source or weakened by grades). */
  hedged: boolean;
  /** The edges backing a grounded composition (empty for the fallback). */
  edges: EdgeRef[];
  /** The template ids the grounded composition was built from (fixed:... and
   *  learned:...); empty for the fallback — the world's grade is attributed
   *  back to these templates (learned frames induction). */
  templateIds: string[];
}

/** An answer that cited nothing — the honest default for non-relational modes. */
const EMPTY_PROVENANCE: AnswerProvenance = { traceIds: [], edges: [] };

/** The stable edge identity key used by the confidence overlay (P8). */
function edgeKey(subject: string, predicate: string, object: string): string {
  return `${subject}\u0000${predicate}\u0000${object}`;
}

/**
 * The typed edges a relational operator answer cited, derived from its
 * result. Non-relational operators cite nothing. This is the P7/P8 hook:
 * a graded answer's provenance names exactly the edges to strengthen or
 * weaken.
 */
function operatorEdges(operator: OperatorResult): EdgeRef[] {
  const edge = (subject: string, predicate: RelationPredicate, object: string): EdgeRef | null =>
    // Identity answers ("is a bird a bird" — true by reflexivity, not by a
    // stored edge) must never cite a phantom (x,is-a,x) edge: a grade on the
    // answer would otherwise bump a confidence key that no real edge owns.
    subject === object ? null : { subject, predicate, object };
  switch (operator?.kind) {
    case 'is-a': { const e = edge(operator.subject, 'is-a', operator.target); return e === null ? [] : [e]; }
    case 'has-part': return [{ subject: operator.subject, predicate: 'has-part', object: operator.part }];
    case 'made-of': return [{ subject: operator.subject, predicate: 'made-of', object: operator.material }];
    case 'has-property': return [{ subject: operator.subject, predicate: 'has-property', object: operator.property }];
    case 'capable-of': return [{ subject: operator.subject, predicate: 'capable-of', object: operator.action }];
    case 'used-for': return [{ subject: operator.subject, predicate: 'used-for', object: operator.purpose }];
    case 'causes': return [{ subject: operator.subject, predicate: 'causes', object: operator.effect }];
    case 'opposite-of': return [{ subject: operator.subject, predicate: 'opposite-of', object: operator.opposite }];
    case 'requires': return [{ subject: operator.subject, predicate: 'requires', object: operator.requirement }];
    case 'where': return [{ subject: operator.object, predicate: 'located-in', object: operator.place }];
    // P10: a composed answer cites the chain's STORED hops — never the
    // derived claim, which no edge states (a grade must not strengthen a
    // phantom (x, capable-of, y) key).
    case 'composed': return operator.hops;
    default: return [];
  }
}

/** A creative answer graded this well reinforces its seed memories. */
export const CREATIVE_REINFORCE_SCORE = 0.7;
/** Contradictions required before the acquired 'verify' drive unlocks. */
export const VERIFY_UNLOCK_THRESHOLD = 3;
/** World-feedback retention: how much of the full grade delta a later recall
 *  carries (the world confirms slowly, the teacher sharply). */
export const RETENTION_FRACTION = 0.25;
/** A creative answer graded this poorly weakens its seed memories. */
export const CREATIVE_WEAKEN_SCORE = 0.3;
/** Strength delta applied per seed when a composition is graded. */
const CREATIVE_GRADE_DELTA = 0.05;
/** Strength delta applied to the producing trace on a wrong quiz grade (P7). */
const QUIZ_GRADE_DELTA = 0.1;
/** Traces below this floor are never weakened further by a failed quiz. */
const QUIZ_WEAKEN_FLOOR = 0.3;

/**
 * P13 COMPREHENSION FLOOR: the production cue is the DEFINITION, whose words
 * carry different prime signatures than the word's own trace — the overlap
 * term structurally cannot match the word (W11). The content-overlap path
 * answers production when it covers ≥ this fraction of the cue's tokens.
 */
const CONTENT_RECALL_FLOOR = 0.4;
const CONTENT_RECALL_MARGIN = 0.1;

function meaningCueOf(text: string): string | null {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const patterns = [
    /^(?:what|which) (?:word|term) (?:means|describes|matches) (.+)$/,
    /^(?:what|which) (?:word|term) is described by (.+)$/,
    /^what is the (?:word|term) for (.+)$/,
    /^what do you call (.+)$/
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match !== null && match[1].trim().length > 0) return match[1].trim();
  }
  return null;
}

function normalizedContentTokens(text: string): Set<string> {
  return new Set(
    tokenizeText(text.toLowerCase())
      .filter(isContentWord)
      .map((token) => {
        if (token.endsWith('ing') && token.length > 4) return token.slice(0, -3);
        if (token.endsWith('ed') && token.length > 3) return token.slice(0, -2);
        return singularize(token);
      })
  );
}

// ── P9 FSRS SCHEDULING ──────────────────────────────────────────────────────
// Per-item difficulty/stability learned from the observer's own review
// history, replacing the strength < 0.6 review gate: strength becomes the
// MODEL's prediction (retention at the elapsed interval), and the schedule
// is dueAt = now + interval (the stability that decays to target retention).

/** Initial stability (days) of a freshly taught word. */
export const FSRS_INITIAL_STABILITY = 1;
/** Initial difficulty in [1, 10] — mid, the observer has no evidence yet. */
export const FSRS_INITIAL_DIFFICULTY = 5;
/** Target retention at review time: the due interval solves R(interval) = this. */
export const FSRS_TARGET_RETENTION = 0.9;
/** Stability multiplier on a correct recall (shrinks with difficulty). */
const FSRS_SUCCESS_GAIN = 1.0;
/** Difficulty scale of the success gain (e^(−D/scale)). */
const FSRS_DIFFICULTY_SCALE = 8;
/** Stability (days) beyond which a word reads as consolidated. */
export const FSRS_CONSOLIDATED_STABILITY = 30;
/** The FSRS v4 forgetting-curve constant (19/81). */
const FSRS_FORGETTING_FACTOR = 19 / 81;
/**
 * Chat routing threshold: a memorized exchange is only authoritative when
 * recall confidence clears this. Taught cues recall at 0.84-0.98; weak
 * partial overlaps (0.6-0.8) are NOT the same exchange and must not be
 * answered as if they were.
 */
const CONVERSATION_HIGH_CONFIDENCE = 0.8;

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
 * Moment-grounded recall: convergence steps run after a perturbation so the
 * field relaxes into the agreement state (the moment) before recall matches
 * against it. Each step evolves the field a small dt; the SMF integrates the
 * post-perturbation transient into a coherent attractor.
 */
export const RECALL_SETTLE_STEPS = 4;
const SETTLE_DT = 0.05;

/**
 * Whether a recalled cue matches the question it was taught under. The
 * memorized-answer layer requires IDENTITY: the question must be the taught
 * exchange itself, allowing only a short trailing extension ("what time is
 * it this morning" vs cue "what time is it"). The drive signals use the
 * SAME rule so self-consistency never claims what chat routing rejects.
 */
function matchesCue(questionKey: string, cueKey: string): boolean {
  return cueKey.length > 0 && (cueKey === questionKey || (questionKey.includes(cueKey) && questionKey.length - cueKey.length <= 8));
}

/**
 * Apply wall-clock forgetting to every restored trace: strength decays
 * exponentially since its last access, with a half-life that grows as the
 * trace is reinforced (unreinforced a week, practiced a month, consolidated
 * four months). These were measured too aggressive in practice — a freshly
 * taught word fell below the review floor after ~1.5 days idle, and real
 * users watched the observer "forget" overnight. The slower curve keeps
 * spaced repetition honest: forgetting happens, but on a human-timescale
 * schedule the review loop can actually service.
 *
 * `rate` scales every half-life: 2 forgets half as fast, 0.5 twice as fast.
 */
export function applyTimeDecay(
  traces: Iterable<{ lastAccessAt: number; strength: number; accessCount: number; consolidated: boolean }>,
  now = Date.now(),
  rate = 1
): void {
  const DAY = 24 * 60 * 60 * 1000;
  const scale = Math.max(0.01, rate);
  for (const trace of traces) {
    const elapsed = Math.max(0, now - trace.lastAccessAt);
    if (elapsed < 60 * 1000) continue; // sub-minute: no measurable forgetting

    const halfLifeDays = (trace.consolidated ? 120 : trace.accessCount >= 2 ? 30 : 7) * scale;
    const halfLifeMs = halfLifeDays * DAY;
    trace.strength = trace.strength * Math.pow(0.5, elapsed / halfLifeMs);
  }
}

// ── P9: the retention model ─────────────────────────────────────────────────

/**
 * The FSRS v4 forgetting curve: the probability the observer recalls a word
 * after `elapsedDays` given stability S. R(0) = 1, R(S) = the target
 * retention (0.9), monotone decreasing in time. Difficulty shapes the
 * STABILITY updates (the v4 separation), not the curve itself.
 */
export function retentionProbability(stabilityDays: number, difficulty: number, elapsedDays: number): number {
  if (stabilityDays <= 0) return 0;
  const ratio = elapsedDays / stabilityDays;
  return Math.pow(1 + FSRS_FORGETTING_FACTOR * ratio, -0.5);
}

/** The review interval (days) whose retention is `retention` — the inversion
 *  of the forgetting curve. At the target 0.9, interval ≈ stability. */
export function dueIntervalDays(stabilityDays: number, retention = FSRS_TARGET_RETENTION): number {
  if (stabilityDays <= 0) return 0;
  return (stabilityDays * (Math.pow(retention, -2) - 1)) / FSRS_FORGETTING_FACTOR;
}

/** The per-trace FSRS parameters the retention decay reads. */
export interface RetentionParams {
  stability: number;
  difficulty: number;
}

/**
 * P9 wall-clock forgetting: every trace's strength becomes the MODEL's
 * prediction — retentionProbability(S, D, elapsed) — replacing the tiered
 * half-life curve. Word traces decay on their per-word FSRS stability; other
 * traces (conversation/creative/gap/belief) use the default stability so
 * taught phrases still forget on a human timescale.
 *
 * `rate` scales stability: 2 forgets half as fast, 0.5 twice as fast.
 */
export function applyRetentionDecay(
  traces: Iterable<{ id: string; lastAccessAt: number; strength: number }>,
  params: (traceId: string) => RetentionParams | null,
  now = Date.now(),
  rate = 1
): void {
  const DAY = 24 * 60 * 60 * 1000;
  const scale = Math.max(0.01, rate);
  for (const trace of traces) {
    const p = params(trace.id);
    const stability = p !== null ? Math.max(0.01, p.stability * scale) : FSRS_INITIAL_STABILITY * 7;
    const difficulty = p !== null ? p.difficulty : FSRS_INITIAL_DIFFICULTY;
    const elapsed = Math.max(0, now - trace.lastAccessAt);
    trace.strength = clampRange(retentionProbability(stability, difficulty, elapsed / DAY), 0.01, 1);
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
 *  - a near-identity SMF (norm FAR below a focused trace's floor — the
 *    pre-focused era imprinted nothing), or
 *  - a FLAT amplitude profile: most of the basis primes carry meaningful
 *    excitation (the old lesson-text excitation spread across everything).
 *
 * A focused trace excites only the word's signature primes — a small
 * fraction of the basis — so the active-prime ratio cleanly separates the
 * two eras regardless of any serialization marker. The SMF norm is NOT a
 * reliable age signal: focused lessons settle+re-excite repeatedly, so the
 * SMF naturally shrinks ~0.8x per lesson and long runs legitimately fall
 * far below an absolute floor. Hence the SMF test only rejects traces near
 * ZERO (truly blank), and the amplitude ratio does the real classification.
 */
function isStaleEncoding(data: { smf: number[]; amplitudes: number[] }): boolean {
  let smfNormSq = 0;
  for (const v of data.smf) {
    if (Number.isFinite(v)) smfNormSq += v * v;
  }
  if (Math.sqrt(smfNormSq) < 0.005) return true;

  if (data.amplitudes.length === 0) return true;
  // q16 quantization stores amplitudes as integers in 0..65535. The
  // spread-excitation "stale" heuristic (active ratio of amplitude > 0.05)
  // was written for float amplitudes in [0,1] — on q16 integers nearly
  // every value exceeds 0.05, so quantized records would ALL be rejected as
  // stale and restore nothing (the web imported "0 traces" from every
  // classroom record). Range-aware check: if the trace is quantized, the
  // stale heuristic does not apply — only true float traces are tested.
  const maxAmplitude = Math.max(...data.amplitudes.filter(Number.isFinite));
  if (maxAmplitude > 1) return false;
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
  /** Trace ids of memorized conversation exchanges (kind: 'conversation'). */
  private readonly conversationTraceIds = new Set<string>();
  /** Cues that have been taught, so re-teaching is a no-op. */
  private readonly taughtConversationCues = new Set<string>();
  /** Cues the observer has actually spoken in reply (competency measure). */
  private readonly producedConversationCues = new Set<string>();
  /** Uttered keys of stored creative answers — O(1) dedup (no bank scan). */
  private readonly creativeUtteredKeys = new Set<string>();
  /** Belief traces stored about the observer's own state — dedup keys. */
  private readonly beliefsStored = new Set<string>();
  /** Last measured recall confidence per cue (belief-drops detection). */
  private readonly lastRecallConfidence = new Map<string, number>();
  /** Learned arbitration weights — experience modifies what the observer
   *  prioritizes. Persisted; absent weights use archetypal defaults. */
  private behaviorWeights: BehaviorWeights = {};
  /** Outcome cascade per behavior — the credit history behind the weights. */
  private readonly behaviorOutcomes: Record<BehaviorOption, { wins: number; losses: number }> = {
    answer: { wins: 0, losses: 0 },
    ask: { wins: 0, losses: 0 },
    compose: { wins: 0, losses: 0 },
    practice: { wins: 0, losses: 0 },
    verify: { wins: 0, losses: 0 }
  };
  /** Learned transition weights for creative composition (surprise terrain). */
  private readonly compositionWeights: TransitionWeights = new Map<string, number>();
  /** Trace ids of memorized STRONG creative answers (kind: 'creative'). */
  private readonly creativeMemoryIds = new Set<string>();
  /** Utterances the observer could not answer (kind: 'gap' traces). */
  private readonly gapUtterances = new Set<string>();
  /** Trace ids of recorded gaps (kind: 'gap'). */
  private readonly gapTraceIds = new Set<string>();
  /** How many times each gap was re-encountered unanswered (curiosity fuel). */
  private readonly gapMissCounts = new Map<string, number>();
  /** Deck words the observer has heard often without a definition. */
  private readonly encounterCounts = new Map<string, number>();
  /** Content words the observer has heard in conversation (introspection). */
  private readonly exposureCounts = new Map<string, number>();
  /** Last recall confidence per practiced cue (for review-curiosity). */
  private readonly cueConfidence = new Map<string, number>();
  /** Curiosity triggers already asked (one question per trigger). */
  private readonly curiosityAsked = new Set<string>();
  /** Answer-mode counters — the deviation meter (session-scoped by design:
   *  grounding is measured over the live session, not across restarts). */
  private readonly modeCounts: Record<string, number> = {};
  /** Per-composition grounding accumulation — the deviation meter's
   *  attribution: composed answers split into grounded (own material) and
   *  deviated (stitched) exposure. */
  private readonly groundingTotal = { answers: 0, grounded: 0, deviated: 0 };

  private noteAnswerMode(mode: string): void {
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
  private noteGrounding(grounding: number): void {
    const attribution = groundingAttribution(grounding);
    this.groundingTotal.answers += 1;
    this.groundingTotal.grounded += attribution.grounded;
    this.groundingTotal.deviated += attribution.deviated;
  }

  /** Recent conversation turns (session-scoped context for references). */
  private readonly workingMemory = new WorkingMemory();
  /**
   * EPISODIC MEMORY: the selective journal that DOES survive restarts —
   * salient facts about the human, vocabulary mastery/failure, recurring
   * topics, and session gaps, bounded by its salience policy and tagged as
   * remembered at retrieval. Deliberately separate from the working window:
   * raw transcripts never persist; episodes do.
   */
  private readonly episodic: EpisodicMemory;
  /** Discovered language patterns (operators learned from strong answers). */
  private operatorLearner: OperatorLearner;
  /** Deck words the observer can know — immutable, cached once. */
  private readonly knownWords: ReadonlySet<string>;
  /** Lazily extracted relational edges over the deck definitions. */
  private relationsCache: Relation[] | null = null;
  /** LLM-supplied (Chaperone) edges, reconciled and provenance-tagged. */
  private chaperoneRelations: Relation[] = [];
  /**
   * Per-edge confidence overlay (P8): key = subject\u0000predicate\u0000object,
   * value = the signed delta applied over the derived graph's base strength
   * (1 per stated source). Agreement bumps +1; wrong grades of answers citing
   * the edge weaken it. Persisted with the learning state.
   */
  private edgeConfidence = new Map<string, number>();
  /**
   * P14 per-edge corroboration store: key = subject\u0000predicate\u0000object,
   * value = the INDEPENDENT source classes that support the edge beyond its
   * own origin class — conversation evidence mined from user statements,
   * world-feedback from accepted graded answers, and definition-class credit
   * from an agreeing chaperone edge. Rides the derived graph as
   * `Relation.sourceClasses`; persisted with the learning state.
   */
  private edgeSources = new Map<string, SourceClass[]>();
  /**
   * P14 example corpus index: content token -> deck example sentences (from
   * the taught states' `example` fields). Built once per relations-cache
   * build; a chaperone edge corroborated by a curriculum example sentence
   * ("A bird can fly." is the deck itself confirming bird capable-of fly)
   * gains the 'curriculum' class.
   */
  private exampleIndex: Map<string, string[]> | null = null;
  /** P14 user statements from PERSISTED conversations, mined once at
   *  construction (the live turns are mined as they arrive). */
  private readonly persistedConversationTexts: string[] = [];
  /**
   * The confirmed-false store (P8): claims explicitly taught ("golf is not a
   * bird") or confirmed by a graded "No" answer. The ONLY source of "No" —
   * absence of evidence never answers absence.
   */
  private negations: Negation[] = [];
  /**
   * The distributed-vector VIEW over the relation graph (P1): H(subject) =
   * Σ bind(role, object), rebuilt whenever the cache is invalidated. It is a
   * pure function of relations() — never persisted.
   */
  private relationalHologram: RelationalHologram | null = null;
  /**
   * LEARNED LANGUAGE TEMPLATES (P5 extension): the relation-hole templates
   * induced from accepted grounded answers, admitted only when they survive
   * the internal critic and match or beat the fixed-frame acceptance
   * baseline. Session-scoped like the deviation meter (modeCounts/
   * groundingTotal) — the fixed frames remain the evergreen seed set.
   */
  private readonly learnedFrames = new LearnedFrameStore();
  /** Executable rules induced from drills (P2): DSL programs compiled into
   *  first-class operators. Persisted with the learning state. */
  private compiledRules: CompiledRule[] = [];
  /** The composition PRNG (P5): seeded for determinism, Math.random by default. */
  private readonly compositionRng: () => number;
  /** The MDL frequency prior for composition gating (P10): the full deck's
   *  Zipf costs, fixed once per agent — the same prior the operator learner
   *  uses, so generation and operator paths gate chains identically. */
  private readonly compositionCost = new TokenCostModel(ACTIVE_DECK.map((entry) => entry.word));
  /** P12 held-out gate: edge keys hidden from the symbolic graph only. */
  private readonly hiddenRelationKeys: ReadonlySet<string> | null;
  /**
   * Bounded per-answer grade ledger (P7): who produced each graded answer
   * and how it was graded — the surgical-repair record. Persisted like
   * strengthHistory.
   */
  private answerGrades: AnswerGradeEntry[] = [];
  /**
   * THE GRADER RELIABILITY MODEL: per-criteria (answer type, FSRS difficulty
   * band, question template, provider) agreement between the LLM teacher's
   * grades and the rule-based checks / later world verdicts. Low-reliability
   * buckets contribute less to edge confidence, trace reinforcement, and
   * FSRS state updates; disagreements schedule re-grades whose outcomes feed
   * the same model. Persisted with the learning state.
   */
  private readonly reliabilityModel = new GraderReliabilityModel();
  private persistCounter = 0;
  private readonly persistEvery: number;
  private readonly settleSteps: number;
  /**
   * Writes are chained, never overlapped: the store's saveWordStates and
   * saveTraces both clear-then-bulkPut, so two concurrent runs can
   * interleave into a truncated table. The chain is the serialization
   * point; `flush()` awaits it.
   */
  private persistChain: Promise<void> = Promise.resolve();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Wall-clock of the first unwritten mutation (bounds the coalescing). */
  private dirtySince: number | null = null;
  /**
   * Runtime-tunable behaviour. Never the prime basis — changing that would
   * decode stored traces against a mismatched encoding.
   */
  private tuning = { forgettingRate: 1, reviewThreshold: REVIEW_STRENGTH_THRESHOLD };

  /**
   * P-curriculum: difficulty-targeted lesson priority. `enabled: false` is
   * the benchmark control — the pre-curriculum scheduler verbatim.
   */
  private readonly curriculumConfig: CurriculumConfig;
  /** Consecutive failed drill rounds per technical concept (weak-drill
   *  signal). Persisted with the learning state. */
  private readonly drillFailures = new Map<string, number>();
  /** Lazy semantic vocabulary over the teacher's own deck (the sparsity
   *  signal's neighborhood graph) — ~75 ms at the full 20k deck, once. */
  private curriculumVocabCache: Record<string, number[]> | null = null;

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
    private readonly session: ObserverSession,
    deck: readonly DeckWord[],
    private readonly persistence: PersistenceStore | null = null,
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
    episodicSessionGapMs?: number
  ) {
    this.persistEvery = Math.max(1, Math.floor(persistEvery));
    this.settleSteps = Math.max(0, Math.floor(settleSteps));
    this.hiddenRelationKeys = hiddenRelationKeys ?? null;
    this.curriculumConfig = curriculumConfig ?? {};
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
   * P9 wall-clock forgetting: set every trace's strength to the model's
   * retention prediction at its elapsed interval — word traces on their
   * per-word FSRS stability/difficulty, other traces on the default curve.
   * `forgettingRate` scales stability (2 forgets half as fast).
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
          const fade = learningState.fadeState as FadeState;
          if (typeof fade.lambda === 'object' && fade.lambda !== null && typeof fade.agreement === 'object' && fade.agreement !== null) {
            this.fadeState.agreement = { ...(fade.agreement as FadeState['agreement']) };
            this.fadeState.lambda = { ...(fade.lambda as FadeState['lambda']) };
          }
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
              operatorId: typeof g.operatorId === 'string' ? g.operatorId : undefined
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
  private restoreProducedCues(cues: unknown, confidence?: Record<string, number>): void {
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
  private recoverProducedCuesFromTraces(): void {
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
  private rebuildCompositionWeightsFromMemory(): void {
    const bank = this.session.observer.getMemoryBank();
    for (const trace of bank.all()) {
      if (trace.metadata?.kind !== 'creative') continue;
      const score = typeof trace.metadata.score === 'number' ? trace.metadata.score : 0.7;
      if (score < CREATIVE_REINFORCE_SCORE) continue;
      updateCompositionWeights(this.compositionWeights, [trace.content], CREATIVE_GRADE_DELTA);
    }
  }

  /** Restored goal traces rejoin the active goal content (without firing a
   *  duplicate storage — the trace is already in the bank). */
  private storeGoalIfNewInStatic(trace: unknown): void {
    const metadata = (trace as { metadata?: Record<string, unknown> }).metadata ?? {};
    const type = String(metadata.goalType ?? '') as GoalType;
    const target = String(metadata.target ?? '');
    const isGoalType = ['learn-word', 'fill-gap', 'practice', 'verify-belief'].includes(type);
    if (!isGoalType || target.length === 0) return;
    const existing = this.goals.find((g) => g.type === type && g.target === target && g.status === 'active');
    if (existing === undefined && (metadata.goalStatus ?? 'active') === 'active') {
      this.goals.push({
        id: goalId(type, target),
        type,
        target,
        completeWhen: () => false,
        describe: () => `${target} — restored goal`,
        steps: [],
        status: 'active',
        attempts: 0,
        priority: Number(metadata.priority ?? 0)
      });
    }
  }

  /**
   * Throttled persistence hook: only every `persistEvery`-th action marks the
   * record dirty, so large batch runs do not spend the run re-serializing their
   * own history (which would otherwise be O(n²) in words taught).
   */
  private maybePersist(): void {
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
  private schedulePersist(): void {
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

  private runScheduledPersist(): void {
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

  private async writeRecord(): Promise<void> {
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
        behaviorWeights: this.behaviorWeights,
        behaviorOutcomes: this.behaviorOutcomes,
        goalHistory: this.goalHistory,
        fadeState: this.fadeState,
        exposureCounts: Object.fromEntries(this.exposureCounts),
        encounterCounts: Object.fromEntries(this.encounterCounts),
        drillFailures: Object.fromEntries(this.drillFailures),
        producedCues: [...this.producedConversationCues],
        cueConfidence: Object.fromEntries(this.cueConfidence),
        relations: this.chaperoneRelations,
        compiledRules: this.compiledRules,
        answerGrades: this.answerGrades,
        edgeConfidence: Object.fromEntries(this.edgeConfidence),
        edgeSources: Object.fromEntries(this.edgeSources),
        negations: this.negations,
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
   * Import a headlessly-trained bootstrap record into this session: restore
   * every trace into the memory bank, bind the word states, load the
   * conversation exchanges, and apply the definitions. Identical semantics
   * to a fresh-session persistence restore — so the app can reach an
   * "initially trained" state in one step instead of hours of UI teaching.
   */
  importBootstrap(record: BootstrapRecord): { restored: number; conversations: number; definitions: number; droppedWords: number; stale: number } {
    if (record.version !== BOOTSTRAP_VERSION || record.vocabularyScheme !== BOOTSTRAP_VOCABULARY_SCHEME) {
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
          operatorId: typeof g.operatorId === 'string' ? g.operatorId : undefined
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
      if (typeof ls.behaviorOutcomes === 'object' && ls.behaviorOutcomes !== null) {
        for (const option of Object.keys(this.behaviorOutcomes) as BehaviorOption[]) {
          const record2 = ls.behaviorOutcomes[option];
          if (record2 !== undefined) {
            this.behaviorOutcomes[option] = { wins: record2.wins, losses: record2.losses };
          }
        }
      }
      if (typeof ls.fadeState === 'object' && ls.fadeState !== null && ls.fadeState.agreement != null && ls.fadeState.lambda != null) {
        this.fadeState.agreement = { ...(ls.fadeState.agreement as FadeState['agreement']) };
        this.fadeState.lambda = { ...(ls.fadeState.lambda as FadeState['lambda']) };
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
    const trace = this.session.storeMemory(lesson);
    if (trace !== null) {
      state.traceId = trace.id;
      state.taughtAt = Date.now();
      // P9: a freshly taught word starts on the default curve and is due for
      // its first review immediately (the auto-loop quizzes right after).
      state.stability = FSRS_INITIAL_STABILITY;
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

  private recallWithCue(state: WordState, cue: string, allowContent: boolean): QuizAnswer {
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
  private contentRecall(cue: string, ambiguityMargin = 0): RecallResult | null {
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

  private identifyMeaning(cue: string): { word: string; recall: RecallResult } | null {
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
      if (state.traceId !== null) {
        const producing = this.traceOf(state.traceId);
        if (producing !== undefined && producing.strength > QUIZ_WEAKEN_FLOOR) {
          this.session.observer.getMemoryBank().reinforce(state.traceId, -QUIZ_GRADE_DELTA);
        }
      }
    }
    // P9 FSRS UPDATE: the review history IS the model's training data. A
    // correct recall stretches stability (less for hard words) and eases
    // difficulty; a wrong one collapses stability (hard words keep less) and
    // raises difficulty. The next review is scheduled when the model predicts
    // the target retention has been reached — strength < 0.6 is gone.
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
    if (verdict === 'correct') {
      const gain = fsrsWeight * FSRS_SUCCESS_GAIN * Math.exp(-state.difficulty / FSRS_DIFFICULTY_SCALE);
      state.stability = state.stability * (1 + gain);
      state.difficulty = Math.max(1, state.difficulty - 0.1 * fsrsWeight);
    } else {
      const collapse = 0.2 * (state.difficulty / 10);
      state.stability = Math.max(0.01, state.stability * (fsrsWeight * collapse + (1 - fsrsWeight)));
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
      operatorId: provenance.operatorId
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
  private difficultyBandOfSeeds(seedTraceIds: readonly string[]): DifficultyBand {
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

  /** The learned language templates (P5 extension) — audit view for the
   *  bench/CLI: which structures were induced, admitted, and how the world
   *  grades them. */
  learnedTemplateAudit(): ReturnType<LearnedFrameStore['audit']> {
    return this.learnedFrames.audit();
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
  private legacyNextReview(): string | null {
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
  private curriculumItems(): CurriculumItem[] {
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

  /** Consecutive failed drill rounds per concept (read-only). */
  drillFailuresSnapshot(): Record<string, number> {
    return Object.fromEntries(this.drillFailures);
  }

  /** The pre-curriculum due-order ranking, for comparison/introspection. */
  legacyQueue(): ReturnType<typeof rankLegacy> {
    return rankLegacy(this.curriculumItems());
  }

  /**
   * Teach one conversational exchange: the observer hears the CUE, ticks once
   * so the field imprints the cue's orientation, and stores the RESPONSE as a
   * tagged conversation trace. Re-teaching the same cue is a no-op. Very
   * short cues ('hi', 'bye') sometimes leave the field too quiet to store, so
   * the excitation is retried a few times before giving up.
   */
  teachResponse(pair: ConversationPair): string | null {
    const key = pair.cue.toLowerCase();
    if (this.taughtConversationCues.has(key)) return null;

    let lastTraceId: string | null = null;
    for (let attempt = 0; attempt < 3 && lastTraceId === null; attempt += 1) {
      this.session.settleField();
      this.session.observeText(pair.cue);
      this.session.observer.tick(0.02);
      const trace = this.session.storeMemory(pair.response, {
        metadata: { kind: 'conversation', cue: key }
      });
      lastTraceId = trace?.id ?? null;
    }
    if (lastTraceId !== null) {
      // Mark the cue taught only AFTER the store succeeded — a quiescent
      // field must not burn the cue forever (re-teach stays possible).
      this.taughtConversationCues.add(key);
      this.conversationTraceIds.add(lastTraceId);
      this.maybePersist();
      return lastTraceId;
    }
    return null;
  }

  /** Teach every phrase in the conversation deck that is not yet taught. */
  teachConversationDeck(pairs: readonly ConversationPair[]): number {
    let taught = 0;
    for (const pair of pairs) {
      if (this.teachResponse(pair) !== null) taught += 1;
    }
    return taught;
  }

  /**
   * The observer's conversational reply: hear the utterance (excites its
   * primes and aligns the field), recall among CONVERSATION traces only, and
   * speak the best-matching taught response above the recall floor. Nothing
   * confidently recalled is an honest "I haven't learned that yet" — the
   * observer never invents an answer it cannot back with a memory trace.
   */
  respond(utterance: string): ConversationAnswer {
    const cue = utterance.trim().toLowerCase();
    if (cue.length === 0) {
      return { utterance, response: null, confidence: null, traceId: null, cue: null, kind: null };
    }

    this.exciteAndSettle(utterance);
    const results = this.session.recall(utterance, 10);

    // The strongest memory wins — memorized EXCHANGES and memorized CREATIVE
    // answers (stored hybrid/strong compositions) compete on score, so a
    // stored hybrid answer is recalled from memory, not shadowed by a weak
    // partial overlap with some other taught cue.
    let bestConversation: RecallResult | null = null;
    let bestCreative: RecallResult | null = null;
    for (const result of results) {
      const kind = result.trace.metadata?.kind;
      if (kind === 'conversation' && (bestConversation === null || result.score > bestConversation.score)) {
        bestConversation = result;
      } else if (kind === 'creative' && (bestCreative === null || result.score > bestCreative.score)) {
        bestCreative = result;
      }
    }
    let best = bestConversation;
    if (bestCreative !== null && (best === null || bestCreative.score > best.score)) {
      best = bestCreative;
    }

    if (best === null || best.score < CONVERSATION_RECALL_FLOOR) {
      return { utterance, response: null, confidence: null, traceId: null, cue: null, kind: null };
    }

    const bestKind = best.trace.metadata?.kind === 'creative' ? ('creative' as const) : ('conversation' as const);
    const matchedCue =
      typeof best.trace.metadata?.cue === 'string'
        ? best.trace.metadata.cue
        : typeof best.trace.metadata?.uttered === 'string'
          ? best.trace.metadata.uttered
          : null;
    if (matchedCue !== null && bestKind === 'conversation') {
      // Confidence tracking is a MEASUREMENT of the observer's own recall —
      // it updates on any match, including weak ones the answering layer
      // refuses to speak. The belief fires on the same measurement: a phrase
      // the observer used to recall well and now recalls poorly decays into
      // a memory about its own fading — "I used to recall X better." (the
      // forgetting curve, witnessed by itself).
      this.cueConfidence.set(matchedCue, best.score);
      const previous = this.lastRecallConfidence.get(matchedCue);
      this.lastRecallConfidence.set(matchedCue, best.score);
      if (previous !== undefined && previous >= CONVERSATION_HIGH_CONFIDENCE && best.score < CONVERSATION_RECALL_FLOOR + 0.1) {
        this.storeBelief(matchedCue, `I used to recall ${matchedCue} better.`, 'drop', { previous, current: best.score });
      }
      // The competency numerator, by contrast, counts only PRODUCED answers
      // — the pair counts only when its response was spoken, which is the
      // SAME gate chatAnswer applies before speaking a memorized answer:
      // identity (the recall's cue IS the taught exchange, not a partial
      // overlap) AND high confidence (>= 0.8). A 0.6–0.8 partial overlap
      // the answering layer refuses must not inflate competency toward the
      // creative unlock. A stored creative answer is a novel prompt, not a
      // taught phrase, and must not inflate the numerator past 100% (the
      // bestKind === 'conversation' check above).
      if (best.score >= CONVERSATION_HIGH_CONFIDENCE && matchesCue(cue, matchedCue.toLowerCase())) {
        this.producedConversationCues.add(matchedCue);
      }
    }

    // WORLD RETENTION (Phase 7b): recalling a CREATIVE trace again later is
    // the world confirming the answer was worth keeping — reinforce its
    // composition paths by the small retention fraction (the world confirms
    // slowly; the teacher confirms sharply).
    if (bestKind === 'creative') {
      this.creditRetention(best.trace.id);
    }

    return {
      utterance,
      response: best.trace.content,
      confidence: best.score,
      traceId: best.trace.id,
      cue: matchedCue,
      kind: bestKind
    };
  }

  /**
   * Conversation competency: the fraction of taught exchanges the observer
   * has actually produced in reply (recall exercises the trace; the pair
   * counts only when its response was spoken). Creative answers unlock when
   * this clears the configured threshold — measured memorization first,
   * then generation.
   */
  conversationReport(): ConversationReport {
    const taught = this.conversationTraceIds.size;
    const recalled = this.producedConversationCues.size;
    const competency = taught === 0 ? 0 : recalled / taught;
    return {
      taught,
      recalled,
      competency,
      creativeUnlocked: competency >= CREATIVE_UNLOCK_THRESHOLD
    };
  }

  /** Every taught conversation exchange (cue + memorized response). */
  listConversationPairs(): ConversationPair[] {
    const bank = this.session.observer.getMemoryBank();
    const pairs: ConversationPair[] = [];
    for (const traceId of this.conversationTraceIds) {
      const trace = bank.get(traceId);
      if (trace === undefined) continue;
      const cue = trace.metadata?.cue;
      if (typeof cue === 'string') pairs.push({ cue, response: trace.content });
    }
    return pairs;
  }

  /**
   * Record an utterance the observer could not answer (a GAP). Gaps are
   * persisted as traces (kind: 'gap') so a later session can teach them —
   * the observer learns from the conversations it actually had.
   */
  recordGap(utterance: string): void {
    const key = utterance.trim().toLowerCase();
    if (key.length === 0 || this.taughtConversationCues.has(key)) return;
    if (this.gapUtterances.has(key)) {
      // The observer keeps failing this — the curiosity engine notices.
      const misses = (this.gapMissCounts.get(key) ?? 1) + 1;
      this.gapMissCounts.set(key, misses);
      // BELIEF: repeated failure of the same utterance becomes a memory
      // about the observer's own ignorance — "I keep failing X."
      if (misses === 2) {
        this.storeBelief(key, `I keep failing ${key}.`, 'fail', { misses });
      }
      return;
    }
    this.gapUtterances.add(key);
    this.gapMissCounts.set(key, 1);
    // Excited under the utterance so the gap is a real memory of what was
    // heard but not understood.
    this.session.settleField();
    this.session.observeText(utterance);
    this.session.observer.tick(0.02);
    const trace = this.session.storeMemory(utterance.trim(), {
      metadata: { kind: 'gap', uttered: key }
    });
    if (trace !== null) this.gapTraceIds.add(trace.id);
    this.maybePersist();
  }

  /** Every un-answered utterance currently waiting to be taught. */
  listGaps(): string[] {
    return [...this.gapUtterances];
  }

  /**
   * Drop a gap without teaching it — for utterances that were exam items,
   * not questions to the teacher (the drill layer records the RULE gap
   * instead of the instances it just tested).
   */
  forgetGap(utterance: string): void {
    const key = utterance.trim().toLowerCase();
    if (!this.gapUtterances.has(key)) return;
    this.gapUtterances.delete(key);
    this.gapMissCounts.delete(key);
    for (const traceId of this.gapTraceIds) {
      const trace = this.session.observer.getMemoryBank().get(traceId);
      if (trace?.metadata?.uttered === key) {
        this.gapTraceIds.delete(traceId);
        break;
      }
    }
  }

  // ── BELIEF TRACES: the observer's own states as memories ──────────────────
  //
  // The introspection operators REPORT quantities; belief traces make them
  // MEMORIES — stor eable, decayable, recallable content about the observer
  // itself, through the identical associative machinery as world knowledge.
  // "I know water well." is not a computed template anymore once it has a
// trace that reinforcement and decay act on; a failed grade can
  // CONTRADICT it, storing a revising belief and demoting the original.

  private storeBelief(
    about: string,
    content: string,
    beliefKind: string,
    basis: Record<string, unknown>,
    contradicts = false
  ): boolean {
    if (about.length === 0) return false;
    const key = `${beliefKind}:${about}`;
    if (this.beliefsStored.has(key)) return false;
    // Same storage discipline as teach: settle the residue first, EXCITE
    // with the subject, then store — memory is NEVER stored into a
    // quiescent field (a belief about an inactive state is invented).
    this.session.settleField();
    this.session.observeText(about);
    this.session.observer.tick(0.02);
    const trace = this.session.storeMemory(content.trim(), {
      metadata: { kind: 'belief', beliefKind, about, basis, contradicts }
    });
    if (trace === null) return false;
    this.beliefsStored.add(key);
    this.maybePersist();
    return true;
  }

  /** All stored belief traces about a subject, most recent first. */
  beliefsOf(about: string): Array<{
    traceId: string;
    content: string;
    beliefKind: string;
    contradicts: boolean;
    basis: Record<string, unknown>;
    strength: number;
  }> {
    const bank = this.session.observer.getMemoryBank();
    return bank
      .all()
      .filter((trace) => trace.metadata?.kind === 'belief' && trace.metadata.about === about)
      .reverse()
      .map((trace) => ({
        traceId: trace.id,
        content: trace.content,
        beliefKind: String(trace.metadata.beliefKind ?? ''),
        contradicts: trace.metadata.contradicts === true,
        basis: (trace.metadata.basis ?? {}) as Record<string, unknown>,
        strength: trace.strength
      }));
  }

  /** The most recent belief about a subject (or null). */
  latestBelief(about: string): ReturnType<TeacherAgent['beliefsOf']>[number] | null {
    return this.beliefsOf(about)[0] ?? null;
  }

  /** The belief-facing view for the self-knowledge operator. */
  private beliefAboutForOperator(word: string): { content: string; contradicts: boolean } | null {
    const belief = this.latestBelief(word);
    return belief === null ? null : { content: belief.content, contradicts: belief.contradicts };
  }

  /**
   * Teach the observer how to answer a previously-recorded gap. Removes the
   * gap once the exchange is memorized.
   */
  teachGap(cue: string, response: string): string | null {
    const key = cue.trim().toLowerCase();
    const traceId = this.teachResponse({ cue, response });
    if (traceId !== null) {
      this.gapUtterances.delete(key);
      // The repeated-miss pressure is resolved with the gap.
      this.gapMissCounts.delete(key);
      // LEARNED GRADIENT: a gap that got taught and memorized is a
      // successful ASK — curiosity paid off.
      this.noteBehaviorOutcome('ask', true);
    }
    return traceId;
  }

  /** Drop the cached edge graph so the next read re-extracts (definitions
   *  may have changed, or chaperone edges arrived). Also drops the example
   *  corpus index — it is derived from the taught states like the graph. */
  invalidateRelations(): void {
    this.relationsCache = null;
    this.exampleIndex = null;
  }

  /**
   * The authored edge pool: the technical curriculum plus the everyday and
   * grounded-facts supplements, filtered to words the observer knows (memory
   * is the source of truth for what exists) and with the curriculum-only
   * 'special-case-of' folded into 'is-a' so inheritance walks it. Shared by
   * relations() and applyRelations() so both merge the identical pool.
   */
  private authoredRelationPool(): Relation[] {
    return [...technicalRelations(), ...SUPPLEMENTAL_RELATIONS, ...GROUNDED_FACTS_RELATIONS]
      .filter((relation) => this.knownWords.has(relation.subject) && this.knownWords.has(relation.object))
      .map((relation): Relation => relation.predicate === 'special-case-of'
        ? { ...relation, predicate: 'is-a' }
        : relation);
  }

  /**
   * Ingest chaperone-supplied edges: cross-check against the regex extractor,
   * keep the agreed + LLM-only edges in the graph, and turn any same-predicate
   * DISAGREEMENT into a belief to verify (never a silent override of the
   * precision-first regex edge). Subjects the observer does not know are
   * dropped — memory is the source of truth for what exists.
   */
  applyRelations(relations: readonly Relation[]): { accepted: number; conflicts: number } {
    if (relations.length === 0) return { accepted: 0, conflicts: 0 };
    const relevant = relations.filter((relation) => this.knownWords.has(relation.subject));
    const extracted = extractRelations(
      [...this.states.values()].map((s) => ({ word: s.word.word, definition: s.word.definition }))
    );
    const authored = this.authoredRelationPool();
    // Reconcile against the FULL precision-first graph (regex + authored),
    // not just the regex extractor — a same-predicate disagreement with the
    // technical curriculum is a belief to verify too.
    const { agreed, llmOnly, conflicts } = reconcileRelations(mergeRelations(extracted, authored), relevant);

    // P8/P14: AGREEMENT is evidence — a chaperone edge that matches an
    // existing one bumps that edge's confidence (+1 per agreeing source)
    // AND adds the LLM-definition source class, corroborating the claim
    // across independent classes (hedging is removed on the next read).
    for (const relation of agreed) {
      this.bumpEdge(relation.subject, relation.predicate, relation.object, +1);
      this.addEdgeSource(relation.subject, relation.predicate, relation.object, 'definition');
    }

    let accepted = 0;
    for (const relation of llmOnly) {
      const duplicate = this.chaperoneRelations.some(
        (r) => r.subject === relation.subject && r.predicate === relation.predicate && r.object === relation.object
      );
      if (!duplicate) {
        this.chaperoneRelations.push(relation);
        accepted += 1;
      }
    }

    for (const conflict of conflicts) {
      const content =
        `I was taught that ${conflict.subject} ${predicateVerb(conflict.predicate, conflict.regexObject)} ${conflict.regexObject}, ` +
        `but I also heard it ${predicateVerb(conflict.predicate, conflict.llmObject)} ${conflict.llmObject} — I should check which is true.`;
      this.storeBelief(
        conflict.subject,
        content,
        'relation-conflict',
        { predicate: conflict.predicate, regexObject: conflict.regexObject, llmObject: conflict.llmObject },
        true
      );
    }

    // Seed the cache from the work just done instead of discarding it: the
    // reconcile above already paid for the full-deck extraction and the
    // authored pool, and the next relations() read would otherwise repeat
    // both at 20k-deck scale for an identical result.
    this.buildRelationsCache(extracted, authored);
    return { accepted, conflicts: conflicts.length };
  }

  /**
   * Build the merged relation graph and seed the cache from already-computed
   * ingredients. The confidence overlay and hidden-edge gate are applied
   * here so every caller (fresh read or post-ingest reseed) derives the
   * graph identically.
   */
  private buildRelationsCache(extracted: readonly Relation[], authored: readonly Relation[]): Relation[] {
    // Provenance priority on ties: regex > authored > chaperone. Chaperone
    // edges that CONFLICTED with a regex edge were already diverted to
    // beliefs in applyRelations, so what lands here is agreed or new.
    this.relationsCache = mergeRelations(extracted, authored, this.chaperoneRelations)
      // P14: corroboration rides the derived graph — every edge carries its
      // source classes (its origin class + the accumulated independent
      // evidence: agreeing chaperone edges, mined conversation evidence,
      // accepted graded answers, curriculum example sentences) and its
      // effective strength (corroboration base + grade/agreement overlay),
      // floored so weakened edges still answer hedged.
      .map((relation) => {
        const key = edgeKey(relation.subject, relation.predicate, relation.object);
        const classes = this.classesFor(relation);
        return {
          ...relation,
          sourceClasses: classes,
          strength: Math.max(
            0.1,
            corroborationConfidence(classes) +
              (this.edgeConfidence.get(key) ?? 0)
          )
        };
      });
    // P12 held-out gate: hidden edges leave the SYMBOLIC graph only — the
    // loose hologram below still binds them, so graded recovery works.
    if (this.hiddenRelationKeys !== null && this.hiddenRelationKeys.size > 0) {
      this.relationsCache = this.relationsCache.filter(
        (relation) =>
          !this.hiddenRelationKeys!.has(edgeKey(relation.subject, relation.predicate, relation.object))
      );
    }
    this.rebuildRelationalHologram();
    return this.relationsCache;
  }

  /** Typed edges decomposed from the deck definitions (is-a, has-part, ...). */
  relations(): Relation[] {
    if (this.relationsCache === null) {
      const extracted = extractRelations(
        [...this.states.values()].map((s) => ({ word: s.word.word, definition: s.word.definition }))
      );
      return this.buildRelationsCache(extracted, this.authoredRelationPool());
    }
    return this.relationsCache;
  }

  /**
   * P14: the corroboration classes of a derived edge — its origin class,
   * plus the accumulated independent evidence for its key, plus curriculum
   * class credit when a taught EXAMPLE sentence states the same claim (the
   * reviewed deck itself confirming a chaperone-supplied edge).
   */
  private classesFor(relation: Relation): SourceClass[] {
    const key = edgeKey(relation.subject, relation.predicate, relation.object);
    const classes = [sourceClassForOrigin(relation.origin), ...(this.edgeSources.get(key) ?? [])];
    // Example sentences are curriculum material: an example that STATES the
    // edge ("A bird can fly.") corroborates a chaperone-only edge — the
    // reviewed deck agrees with the LLM.
    if (relation.origin === 'chaperone' && this.exampleCorroborates(relation)) {
      classes.push('curriculum');
    }
    return distinctClasses(classes);
  }

  /** P14: does any taught example sentence corroborate this relation? The
   *  example corpus is token-indexed once per cache build. */
  private exampleCorroborates(relation: Relation): boolean {
    if (this.exampleIndex === null) {
      const index = new Map<string, string[]>();
      for (const state of this.states.values()) {
        const example = state.word.example.trim().toLowerCase();
        if (example.length === 0) continue;
        const seen = new Set<string>();
        for (const token of tokenizeText(example)) {
          if (seen.has(token)) continue;
          seen.add(token);
          const list = index.get(token) ?? [];
          list.push(example);
          index.set(token, list);
        }
      }
      this.exampleIndex = index;
    }
    const candidates = this.exampleIndex.get(relation.subject) ?? [];
    for (const example of candidates) {
      if (evidenceInText(example, relation.subject, relation.predicate, relation.object)) return true;
    }
    return false;
  }

  /** P14: record an independent corroborating source class for an edge. */
  addEdgeSource(subject: string, predicate: string, object: string, sourceClass: SourceClass): void {
    const key = edgeKey(subject, predicate, object);
    const current = this.edgeSources.get(key) ?? [];
    if (current.includes(sourceClass)) return;
    this.edgeSources.set(key, [...current, sourceClass]);
    this.invalidateRelations();
  }

  /** P14: drop a corroborating source class (e.g. the world later rejected
   *  the claim it had accepted). */
  removeEdgeSource(subject: string, predicate: string, object: string, sourceClass: SourceClass): void {
    const key = edgeKey(subject, predicate, object);
    const current = this.edgeSources.get(key) ?? [];
    if (!current.includes(sourceClass)) return;
    this.edgeSources.set(key, current.filter((cls) => cls !== sourceClass));
    this.invalidateRelations();
  }

  /** P14: the corroborating source classes of an edge key (read-only). */
  edgeSourcesOf(subject: string, predicate: string, object: string): readonly SourceClass[] {
    const key = edgeKey(subject, predicate, object);
    const found = this.relations().find(
      (r) => r.subject === subject && r.predicate === predicate && r.object === object
    );
    return found !== undefined ? (found.sourceClasses ?? []) : (this.edgeSources.get(key) ?? []);
  }

  /**
   * P14 CONVERSATION-EVIDENCE MINING: a user statement is evidence — "my dog
   * can bark" corroborates dog capable-of bark, "a robin is a bird I saw"
   * corroborates robin is-a bird. Only DECLARATIVE statements with the
   * predicate expressed are mined (questions and negations never are), and
   * only for edges that already exist — an utterance never invents an edge.
   */
  private noteConversationEvidence(text: string): void {
    if (text.trim().length === 0) return;
    const tokens = new Set(tokenizeText(text).map(singularize));
    if (tokens.size === 0) return;
    // Deck objects are often plural ("wings", "legs") — match the raw form
    // or its singular ("the bird has wings" covers both).
    const mentioned = (word: string): boolean => tokens.has(word) || tokens.has(singularize(word));
    const relations = this.relations();
    let changed = false;
    for (const relation of relations) {
      if (!mentioned(relation.subject) || !mentioned(relation.object)) continue;
      if (!evidenceInText(text, relation.subject, relation.predicate, relation.object)) continue;
      const key = edgeKey(relation.subject, relation.predicate, relation.object);
      const current = this.edgeSources.get(key) ?? [];
      if (current.includes('conversation')) continue;
      this.edgeSources.set(key, [...current, 'conversation']);
      changed = true;
    }
    if (changed) this.invalidateRelations();
  }

  /** Rebuild the distributed-vector view from the current relation graph. */
  private rebuildRelationalHologram(): void {
    if (this.relationalHologram === null) {
      this.relationalHologram = new RelationalHologram({ slots: 128 });
    } else {
      this.relationalHologram.clear();
    }
    const bySubject = new Map<string, Relation[]>();
    // The curated graph (regex + authored + chaperone)...
    for (const relation of this.relationsCache ?? []) {
      const list = bySubject.get(relation.subject) ?? [];
      list.push(relation);
      bySubject.set(relation.subject, list);
    }
    // ...plus the LOOSE extraction: bind every content-word object the
    // precision-first graph intentionally drops ("a bird is a creature" when
    // creature is not a deck word, "with feathers" when feathers is not).
    // The graded layer answers those with unbind scores, never as edges.
    for (const relation of extractRelations(
      [...this.states.values()].map((s) => ({ word: s.word.word, definition: s.word.definition })),
      { loose: true }
    )) {
      const list = bySubject.get(relation.subject) ?? [];
      list.push(relation);
      bySubject.set(relation.subject, list);
    }
    for (const [subject, edges] of bySubject) {
      this.relationalHologram.setTrace(
        subject,
        edges.map((relation) => ({ predicate: relation.predicate, object: relation.object }))
      );
    }
  }

  /** Edges originating at a word. */
  edgesOf(word: string): Relation[] {
    return this.relations().filter((r) => r.subject === word);
  }

  /** The distributed-vector unbind+cleanup score (P1) — the graded closed-form
   *  signal the operators hedge on. 0 when the subject has no bound trace. */
  relationalScore(subject: string, predicate: string, object: string): number {
    return this.relationalHologram?.scoreOf(subject, predicate, object) ?? 0;
  }

  // ── Edge confidence + confirmed-false store (P8) ─────────────────────────

  /**
   * The confidence weight of a typed edge: 1 per stated source, plus the
   * accumulated agreement/grade delta. 0 when no edge exists. A weakened
   * edge (< 1) answers hedged, never deleted silently.
   */
  edgeStrengthOf(subject: string, predicate: string, object: string): number {
    for (const relation of this.relations()) {
      if (relation.subject === subject && relation.predicate === predicate && relation.object === object) {
        // relations() already carries the effective strength (base + overlay).
        return Math.max(0.1, relation.strength ?? 1);
      }
    }
    return 0;
  }

  /** Adjust the confidence overlay of an edge (P8): agreement +1, wrong
   *  grades −0.2, correct grades +0.2. Floored at 0.1 — a weakened edge
   *  answers hedged, it is never silently deleted. */
  bumpEdge(subject: string, predicate: string, object: string, delta: number): void {
    const key = edgeKey(subject, predicate, object);
    const current = (this.edgeConfidence.get(key) ?? 0) + delta;
    this.edgeConfidence.set(key, Math.max(-0.9, current));
    // The overlay is applied at graph-build time — a bump must force a rebuild.
    this.invalidateRelations();
  }

  /**
   * Record a confirmed-false claim. Deduped by (subject, predicate, object);
   * the evidence string is the taught exchange or graded answer that
   * confirmed it. A negation that CONTRADICTS a stored positive edge becomes
   * a belief to verify too (the P4 machinery) — never a silent override.
   */
  storeNegation(subject: string, predicate: RelationPredicate, object: string, evidence: string, origin: Negation['origin'] = 'taught'): void {
    if (subject === object) return;
    this.negations = this.negations.filter(
      (n) => !(n.subject === subject && n.predicate === predicate && n.object === object)
    );
    this.negations.push({ subject, predicate, object, evidence, origin });
    if (this.edgeStrengthOf(subject, predicate, object) > 0) {
      this.storeBelief(
        subject,
        `I was taught that ${subject} ${predicateVerb(predicate, object)} ${object}, but I was also told it does not — I should check which is true.`,
        'relation-conflict',
        { predicate, object, negation: evidence },
        true
      );
    }
  }

  /** The confirmed-false entry for a claim, or null (the honest absence). */
  negationOf(subject: string, predicate: string, object: string): Negation | null {
    return (
      this.negations.find(
        (n) => n.subject === subject && n.predicate === predicate && n.object === object
      ) ?? null
    );
  }

  /** The confirmed-false store (P8) — the only source of evidence-backed No. */
  negationsList(): readonly Negation[] {
    return this.negations;
  }

  // ── Compiled rules (P2 — executable rules from drills) ───────────────────

  /** The induced rules currently compiled into operators. */
  compiledRuleCount(): number {
    return this.compiledRules.length;
  }

  /**
   * Compile an induced DSL program into a first-class operator. The rule only
   * fires on prompts its own family's matcher fully parses — anything else
   * falls through untouched (the honesty audit).
   */
  registerCompiledRule(rule: Omit<CompiledRule, 'id'>): void {
    const id = `${rule.concept}\u0000${rule.drill}`;
    this.compiledRules = this.compiledRules.filter((existing) => existing.id !== id);
    this.compiledRules.push({ ...rule, id });
  }

  /** Apply the compiled rules to a fresh prompt (chatAnswer step 2.6). */
  private applyCompiledRule(utterance: string): { kind: 'compiled-rule'; ruleId: string; concept: string; drill: string; answer: string } | null {
    const text = utterance.trim();
    for (const rule of this.compiledRules) {
      // H2: a convert-LENGTH rule is bound to the unit pair it was induced on
      // (length factors vary per pair, so a unit-blind multiplier must never
      // fire on another pair). The time/mass/volume matchers are already
      // unit-specific and their families share one factor across both
      // generator directions — no further check needed. A legacy length rule
      // without its recorded pair never fires (honest decline → ask).
      if (rule.drill === 'convert-length') {
        const pair = conversionPairOf(text);
        if (
          pair === null ||
          rule.conversionFrom === undefined ||
          rule.conversionTo === undefined ||
          pair.from !== rule.conversionFrom ||
          pair.to !== rule.conversionTo
        ) {
          continue;
        }
      }
      const args = matchArgs(rule.drill, text);
      if (args === null) continue;
      const value = evaluate(rule.program, args);
      if (value === undefined) continue;
      const answer = typeof value === 'number' ? canonicalNumber(value) : String(value);
      return {
        kind: 'compiled-rule',
        ruleId: rule.id,
        concept: rule.concept,
        drill: rule.drill,
        answer: `The answer is ${answer}.`
      };
    }
    return null;
  }

  /** Number of learned language patterns that have cleared the bar. */
  learnedPatternCount(): number {
    return this.operatorLearner.fireableCount();
  }

  /** MDL audit view of the learned-operator library (gains, maturity). */
  operatorAuditView() {
    return this.operatorLearner.audit();
  }

  // ── Drive signals (archetypal resonance targets) ─────────────────────────

  /** Curiosity pressure: unanswered gaps + frequently-heard undefined words +
   *  stored fail-beliefs (the observer's own memory of repeated ignorance
   *  feeds its curiosity — beliefs as inputs to the drives). */
  curiosityPressure(): number {
    let pressure = 0;
    for (const misses of this.gapMissCounts.values()) pressure += misses;
    for (const count of this.encounterCounts.values()) pressure += count;
    for (const belief of this.deficitBeliefs()) pressure += 2;
    return pressure;
  }

    /** How many times a content word has been heard in conversation. */
  exposureOf(word: string): number {
    return this.exposureCounts.get(word) ?? 0;
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

  /** Unanswered gaps, most-missed first (introspection + curiosity fuel). */
  gapList(): string[] {
    return [...this.gapMissCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([gap]) => gap);
  }

  /**
   * Cluster gaps by shared content tokens — the observer can see DOMAINS of
   * ignorance, not just a queue of tokens.
   */
  gapClusters(): Array<{ words: string[]; members: string[] }> {
    return clusterGaps(this.gapList());
  }

  /** Conservation: fraction of memory above the retention floor (P9 —
   *  strength IS the model's prediction, so "strong" means retained). */
  conservationPressure(): number {
    const bank = this.session.observer.getMemoryBank();
    let strong = 0;
    let total = 0;
    for (const trace of bank.all()) {
      total += 1;
      if (trace.strength >= 0.5) strong += 1;
    }
    return total === 0 ? 0 : strong / total;
  }

  /** Novelty: how much of the utterance is new vs the recent context. */
  noveltyOf(utterance: string): number {
    const probe = utterance.trim();
    const recent = new Set(
      this.workingMemory
        .recent(6)
        .filter((turn) => turn.text.trim() !== probe)
        .flatMap((turn) => tokenizeText(turn.text))
    );
    const tokens = tokenizeText(utterance);
    if (tokens.length === 0) return 0;
    const novel = tokens.filter((token) => token.length > 2 && !recent.has(token)).length;
    return Math.min(1, novel / Math.max(1, tokens.length));
  }

  /** Coherence + self-consistency from a fresh recall of the utterance. */
  recallCoherence(utterance: string): { coherence: number; selfConsistency: number } {
    const answer = this.respond(utterance);
    if (answer.response === null || answer.confidence === null) {
      return { coherence: 0, selfConsistency: 0 };
    }
    const questionKey = utterance.trim().toLowerCase();
    const cueKey = (answer.cue ?? '').toLowerCase();
    const consistent = matchesCue(questionKey, cueKey);
    return { coherence: answer.confidence, selfConsistency: consistent ? 1 : 0.5 };
  }

  /** The drive vector for an utterance — the archetypes as numbers. */
  driveSignals(utterance: string): DriveSignals {
    const recall = this.recallCoherence(utterance);
    return {
      coherence: recall.coherence,
      // 2 repeated misses or encounters already reads as real pressure.
      curiosity: Math.min(1, this.curiosityPressure() / 4),
      novelty: this.noveltyOf(utterance),
      conservation: this.conservationPressure(),
      selfConsistency: recall.selfConsistency
    };
  }

  /**
   * READ-ONLY drive snapshot for visualization: never excites the field or
   * touches memory (safe to call during render / on a timer without
   * perturbing the learning process). Coherence comes from the live field
   * metrics; curiosity/novelty/conservation from counters and the bank.
   */
  driveSignalsStatic(): DriveSignals {
    return {
      coherence: this.observerState()?.coherence ?? 0,
      curiosity: Math.min(1, this.curiosityPressure() / 4),
      novelty: this.noveltyOf(this.workingMemory.recent(1)[0]?.text ?? 'hello'),
      conservation: this.conservationPressure(),
      selfConsistency: 0
    };
  }

  /** The drive state, normalized. */
  drives(utterance: string): DriveState {
    return computeDrives(this.driveSignals(utterance));
  }

  /** Drive-weighted choice between the possible next behaviors. The
   *  available set is the ACQUIRED-SET gate: 'verify' is not even
   *  considered until experience has contradicted enough beliefs. When the
   *  gate excludes EVERY option, answering is the sane default — never a
   *  silent bypass of the gate (chooseBehavior returns null in that case). */
  chooseNext(utterance: string, options: readonly BehaviorOption[]): BehaviorOption {
    const choice = chooseBehavior(this.drives(utterance), options, this.behaviorWeights, this.availableBehaviors());
    return choice ?? 'answer';
  }

  /** The learned arbitration weights (read-only snapshot). */
  driveWeights(): BehaviorWeights {
    return { ...this.behaviorWeights };
  }

  /** The outcome cascade per behavior — credit history (read-only). */
  behaviorOutcomeCounts(): Record<BehaviorOption, { wins: number; losses: number }> {
    return {
      answer: { ...this.behaviorOutcomes.answer },
      ask: { ...this.behaviorOutcomes.ask },
      compose: { ...this.behaviorOutcomes.compose },
      practice: { ...this.behaviorOutcomes.practice },
      verify: { ...this.behaviorOutcomes.verify }
    };
  }

  /** Credit a behavior with an outcome and update its learned weight. */
  noteBehaviorOutcome(option: BehaviorOption, win: boolean): void {
    const record = this.behaviorOutcomes[option];
    if (win) record.wins += 1;
    else record.losses += 1;
    updateDriveWeight(this.behaviorWeights, option, win);
    this.maybePersist();
  }

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

  /** Number of stored creative memories (strong answers, incl. hybrid). */
  creativeMemoryCount(): number {
    return this.creativeMemoryIds.size;
  }

  /**
   * Rebuild the learned-operator library from the observer's stored creative
   * memories — memory is the source of truth; the pattern library is a view.
   */
  private rebuildLearnedOperators(): void {
    const bank = this.session.observer.getMemoryBank();
    for (const trace of bank.all()) {
      if (trace.metadata?.kind !== 'creative' || typeof trace.metadata.uttered !== 'string') continue;
      const score = typeof trace.metadata.score === 'number' ? trace.metadata.score : 0.7;
      this.operatorLearner.learn(trace.metadata.uttered, trace.content, score);
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
    const memorized = this.respond(resolved);
    const questionKey = resolved.trim().toLowerCase();
    const cueKey = (memorized.cue ?? '').toLowerCase();
    const cueMatches = matchesCue(questionKey, cueKey);
    if (memorized.response !== null && memorized.confidence !== null && memorized.confidence >= CONVERSATION_HIGH_CONFIDENCE && cueMatches) {
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
    const groundedQuestion = questionForm !== null || meaningCue !== null;
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

  /** Record a turn in the working-memory window (used by external drivers).
   *  User turns are also observed by the episodic memory — a driver that
   *  bypasses chatAnswer must still feed the selective journal. */
  noteTurn(role: 'user' | 'observer', text: string): void {
    this.workingMemory.note(role, text);
    this.episodic.observeTurn(role, text);
  }

  /**
   * Perturb the field with external text — the council's "observing each
   * other". A transient excitation: the field is excited and settled, and
   * nothing is stored. Rotation of the moment changes what the next
   * creative recall resonates with; memory itself is untouched.
   */
  perturb(text: string): void {
    if (text.trim().length === 0) return;
    this.session.observeText(text);
    this.session.settleField();
  }

  /** The recent conversation window (for the UI context line). */
  getWorkingMemory(): WorkingTurn[] {
    return this.workingMemory.all();
  }

  /** Every stored episodic fact (read-only — the selective journal). */
  episodicFacts(): readonly EpisodicFact[] {
    return this.episodic.all();
  }

  /** The episodic facts clearly relevant to an utterance, tagged as
   *  remembered (topic-gated, salience-ranked). Consumed by the hybrid
   *  voice and any caller that needs the long-term context. */
  episodicRecall(utterance: string, topK = 3): RememberedFact[] {
    return this.episodic.recall(utterance, { topK });
  }

  /** The learned composition transition weights (read-only — the observer's
   *  tiny language model, exposed for the Phase 7a correlation bench). */
  getCompositionWeights(): TransitionWeights {
    return this.compositionWeights;
  }

  /** The stored seed contents most resembling a phrase (for novelty
   *  scoring — the echo-distance reference). */
  recallSeedContents(phrase: string): string[] {
    return this.recallMemories(phrase, 4).map((memory) => memory.content);
  }

  /** The observer's memory bank (read-only access for benches/CLI). */
  getMemoryBank() {
    return this.session.observer.getMemoryBank();
  }

  /**
   * PROACTIVE CURIOSITY: the observer asks about something it wants to
   * learn, when it can see its own gaps. Triggers, in priority order:
   *   1. a gap it keeps failing (missed >= 2 times) — ask what its subject
   *      means;
   *   2. a deck word it keeps HEARING without a definition (>= 3
   *      encounters) — ask to be taught it;
   *   3. a practiced phrase whose recall confidence dropped below the
   *      review floor — ask to practice it.
   * Each trigger is asked once (it is consumed). Returns null when nothing
   * is worth asking about.
   */
  curiosityQuestion(): string | null {
    const known = new Set(this.states.keys());

    // 1. Repeatedly-missed gaps (still unanswered — a gap the loop just
    //    taught is no longer worth asking about).
    let bestGap: string | null = null;
    let bestMisses = 0;
    for (const [gap, misses] of this.gapMissCounts) {
      if (misses >= 2 && this.gapUtterances.has(gap) && misses > bestMisses && !this.curiosityAsked.has(`gap:${gap}`)) {
        bestGap = gap;
        bestMisses = misses;
      }
    }
    if (bestGap !== null) {
      this.curiosityAsked.add(`gap:${bestGap}`);
      const subject = extractUnknownSubject(bestGap, known) ?? bestGap;
      return `I do not know what "${subject}" means. Could you teach me about it?`;
    }

    // 1.5 DOMAIN curiosity: several gaps share content words — the observer
    //     asks about the domain, not just a token.
    const clusters = this.gapClusters();
    if (clusters.length > 0) {
      const best = clusters[0];
      if (best.members.length >= 2) {
        const key = `domain:${best.words.slice(0, 3).join(' ')}`;
        if (!this.curiosityAsked.has(key)) {
          this.curiosityAsked.add(key);
          const teachable = best.words.filter((w) => this.states.has(w)).slice(0, 3);
          if (teachable.length > 0) {
            return `Many of my questions are about ${teachable.join(', ')}. Could you teach me about them?`;
          }
        }
      }
    }

    // 2. Frequently-heard words without definitions.
    for (const [word, count] of this.encounterCounts) {
      if (count >= 3 && !this.curiosityAsked.has(`word:${word}`)) {
        const state = this.states.get(word);
        if (state !== undefined && state.word.definition.trim().length === 0) {
          this.curiosityAsked.add(`word:${word}`);
          return `Can you teach me about "${word}"?`;
        }
      }
    }

    return null;
  }

  /**
   * Perturb the field with an utterance and let it CONVERGE: several
   * relaxation ticks so the SMF settles into the moment — the agreement
   * state — before recall matches against it. This is the mechanism behind
   * moment-grounded recall: the memory that resonates with the converged
   * moment is the answer, and fuzzy partial overlaps fail to form a coherent
   * attractor.
   */
  private exciteAndSettle(utterance: string): void {
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
          { negations: this.negations, cost: this.compositionCost },
          this.learnedFrames
        )
      : null;
    if (grounded !== null && grounded.edges.length > 0) {
      // The critic already verified the composition in composeGrounded;
      // re-verify against the full graph + negations for the final sentence.
      const verdict = criticize(grounded.sentence, relations, this.negations, {
        cost: this.compositionCost
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
    const rawDelta =
      score >= CREATIVE_REINFORCE_SCORE
        ? CREATIVE_GRADE_DELTA
        : score <= CREATIVE_WEAKEN_SCORE
          ? -CREATIVE_GRADE_DELTA
          : 0;
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
    if (delta === 0) {
      // P7 contract: the ledger records the producers of EVERY graded
      // answer — a mid-grade (0.3–0.7) answer carries no reinforcement but
      // its producers must still be named for surgical repair.
      this.recordAnswerGrade(utterance, 'creative', 'neutral', {
        traceIds: seedTraceIds,
        edges: citedEdges
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
    updateCompositionWeights(this.compositionWeights, contents, delta);
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
    // The P7 grade ledger: this answer's producers (and the edges it cited —
    // consumed by P8's per-edge confidence) are recorded for surgical repair.
    this.recordAnswerGrade(utterance, 'creative', rawDelta > 0 ? 'strong' : rawDelta < 0 ? 'weak' : 'neutral', {
      traceIds: seedTraceIds,
      edges: citedEdges
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
    // verdicts (re-ask / retention) can confirm or contradict it.
    if (utterance.trim().length > 0) {
      const authored = this.previousAnswerFor(utterance);
      if (authored !== undefined) {
        this.authoredAnswers.set(utterance.trim().toLowerCase(), {
          traceIds: authored.traceIds,
          at: authored.at,
          score,
          provider,
          template: criteria.template
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
      behaviorOutcomes: Object.fromEntries(
        Object.entries(this.behaviorOutcomes).map(([option, record]) => [option, { ...record }])
      ) as Record<string, { wins: number; losses: number }>,
      fadeState: {
        agreement: { ...this.fadeState.agreement },
        lambda: { ...this.fadeState.lambda }
      },
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

  // ─────────────────────────────────────────────────────────────────────────
  // Autonomous teaching loop
  // ─────────────────────────────────────────────────────────────────────────

  /** The goals the planner is pursuing (installed by adoptGoals). */
  private readonly goals: LearningGoal[] = [];
  private goalLoopToken = 0;
  private goalLoopRunning = false;

  /** Store a goal as an ordinary memory trace (kind: 'goal') — the observer
   *  holds its plans as content, alongside its beliefs and its knowledge.
   *  Stored under the target's orientation; returns the trace id. */
  private storeGoalTrace(goal: LearningGoal, status: 'active' | 'complete' | 'stalled'): string | null {
    this.session.settleField();
    this.session.observeText(goal.target);
    this.session.observer.tick(0.02);
    return this.session.storeMemory(
      `${goal.describe(this)} — ${status === 'complete' ? 'done' : status === 'stalled' ? 'could not finish' : 'in progress'}`,
      {
        metadata: {
          kind: 'goal',
          goalType: goal.type,
          target: goal.target,
          goalStatus: status,
          formedAt: Date.now(),
          priority: goal.priority
        }
      }
    )?.id ?? null;
  }

  /** One stored goal trace per (type, target) — the "what are you trying
   *  to do" recall source. */
  private storeGoalIfNew(goal: LearningGoal): void {
    const bank = this.session.observer.getMemoryBank();
    const exists = bank.all().some(
      (trace) =>
        trace.metadata?.kind === 'goal' &&
        trace.metadata.goalType === goal.type &&
        trace.metadata.target === goal.target &&
        trace.metadata.goalStatus === 'active'
    );
    if (!exists) this.storeGoalTrace(goal, 'active');
  }

  /** A stalled goal stores a REVISING GOAL-BELIEF — "I planned to learn X
   *  and could not" — the intent-analog of the belief contradiction. */
  private noteGoalFailure(goal: LearningGoal): void {
    const key = `goal-failed:${goal.id}`;
    if (this.beliefsStored.has(key)) return;
    this.session.settleField();
    this.session.observeText(goal.target);
    this.session.observer.tick(0.02);
    const trace = this.session.storeMemory(`I planned to learn ${goal.target} and could not.`, {
      metadata: { kind: 'belief', beliefKind: 'goal-failed', about: goal.id, basis: { type: goal.type }, contradicts: false }
    });
    if (trace !== null) this.beliefsStored.add(key);
  }

  /** Install the goals to pursue (replaces the current set). Each goal is
   *  stored as a memory trace — the observer holds its plans as content. */
  adoptGoals(goals: readonly LearningGoal[]): void {
    this.goals.length = 0;
    this.goals.push(...goals);
    for (const goal of goals) this.storeGoalIfNew(goal);
  }

  /** Snapshot of the current goals (deep copies — the planner mutates them). */
  goalList(): LearningGoal[] {
    return this.goals.map((g) => ({ ...g, steps: [...g.steps] }));
  }

  /**
   * GOAL-DRIVEN SCHOOL: each cycle picks the highest-priority ACTIVE goal
   * (ordered by the learned drive weights from Phase 2) and executes one
   * step of its plan (teach / quiz / expose / ask — all existing
   * primitives). Steps are progress-evaluated; a quiescent teach REVISES
   * the plan to the exposure route. Goals that cannot progress are marked
   * stalled — the loop ends when no active goals remain.
   */
  startGoalLoop(goals: readonly LearningGoal[], options: AutoLoopOptions = {}): AutoLoopHandle {
    if (this.goalLoopRunning) {
      return { stop: () => this.stopGoalLoop(), get running() { return false; } };
    }
    this.adoptGoals(goals);
    const token = ++this.goalLoopToken;
    this.goalLoopRunning = true;
    const self = this;
    const thisGoalLoopRunning = (): boolean => self.goalLoopRunning;
    const stepPauseMs = options.teachPauseMs ?? 500;

    void (async () => {
      try {
        while (token === this.goalLoopToken) {
          // EXPECTED-VALUE SELECTION (Phase 6b): each goal's type carries the
          // observer's own success rate — ends move with the observer's life.
          for (const g of this.goals) {
            const h = this.goalHistory[g.type] ?? { completed: 0, abandoned: 0 };
            const n = h.completed + h.abandoned;
            g.successRate = n === 0 ? 0.5 : h.completed / n; // Laplace prior 0.5
          }
          const goal = chooseGoal(this.goals, this);
          if (goal === null) break; // none active — all complete or stalled
          let result;
          try {
            result = await executeGoalStep(this, goal);
          } catch (reason) {
            // A step that THREW (unknown target, internal error) must not
            // kill the loop silently: the goal is marked STALLED honestly
            // (the "stalled, never hidden" contract) and the loop continues
            // with the remaining goals.
            goal.status = 'stalled';
            this.noteGoalOutcome(goal.type, false);
            this.noteGoalFailure(goal);
            const message = reason instanceof Error ? reason.message : String(reason);
            for (const listener of [...this.autoListeners]) {
              listener({ phase: 'idle', word: goal.target, cue: null, answer: null, grade: null, message: `goal error (${message}): ${goal.target}` });
            }
            await sleep(stepPauseMs);
            continue;
          }
          if (token !== this.goalLoopToken) break;
          if (result.outcome === 'complete') {
            // A completed VERIFY-BELIEF goal is a successful verification —
            // the acquired drive's outcome feeds its learned weight.
            if (goal.type === 'verify-belief') this.noteBehaviorOutcome('verify', true);
            // The goal-type history learns: this plan worked.
            this.noteGoalOutcome(goal.type, true);
            // The goal trace is reinforced — a memory of a fulfilled intent.
            const bank = this.session.observer.getMemoryBank();
            for (const trace of bank.all()) {
              if (trace.metadata?.kind === 'goal' && trace.metadata.goalType === goal.type && trace.metadata.target === goal.target) {
                bank.reinforce(trace.id, 0.1);
              }
            }
            for (const listener of [...this.autoListeners]) {
              listener({ phase: 'idle', word: goal.target, cue: null, answer: null, grade: null, message: `goal complete: ${goal.target}` });
            }
          } else if (result.outcome === 'failed' && goal.status === 'stalled') {
            // A stalled goal stores a revising goal-belief — the observer
            // remembers its own intention failing. And the history learns.
            this.noteGoalOutcome(goal.type, false);
            this.noteGoalFailure(goal);
          }
          await sleep(stepPauseMs);
        }
        for (const listener of [...this.autoListeners]) {
          listener({ phase: 'done', word: null, cue: null, answer: null, grade: null, message: 'all goals complete or stalled' });
        }
      } finally {
        this.goalLoopRunning = false;
      }
    })();

    return {
      stop: () => this.stopGoalLoop(),
      get running() { return thisGoalLoopRunning(); }
    };
  }

  stopGoalLoop(): void {
    this.goalLoopToken += 1;
    this.goalLoopRunning = false;
  }

  /** Goals stalling honestly — surfaced for introspection, never hidden. */
  stalledGoals(): LearningGoal[] {
    return this.goalList().filter((g) => g.status === 'stalled');
  }

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

  // ── Planner support ───────────────────────────────────────────────────────

  /** Wait — a safe lookup that returns null instead of throwing. */
  tryState(word: string): WordState | null {
    return this.states.get(word) ?? null;
  }

  /** The recall confidence of a taught phrase (0 when never recalled). */
  phraseStrength(cue: string): number {
    return this.cueConfidence.get(cue.trim().toLowerCase()) ?? 0;
  }

  /** Stored deficit beliefs ("I keep failing X") — the planner's raw feed. */
  deficitBeliefs(): Array<{ about: string; content: string }> {
    const bank = this.session.observer.getMemoryBank();
    const out: Array<{ about: string; content: string }> = [];
    for (const trace of bank.all()) {
      if (trace.metadata?.kind !== 'belief' || trace.metadata.beliefKind !== 'fail') continue;
      const about = String(trace.metadata.about ?? '');
      if (about.length > 0) out.push({ about, content: trace.content });
    }
    return out;
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
  private readonly authoredAnswers = new Map<string, { traceIds: string[]; at: number; score?: number | null; provider?: string | null; template?: string | null }>();

  /** Note a creative answer the observer itself produced (the seed traces
   *  it was composed from + when). */
  private noteAuthoredAnswer(utterance: string, seedTraceIds: string[]): void {
    const key = utterance.trim().toLowerCase();
    if (key.length === 0) return;
    this.authoredAnswers.set(key, { traceIds: seedTraceIds, at: Date.now() });
  }

  /** The answer the observer last gave for an utterance (for re-ask credit). */
  private previousAnswerFor(utterance: string): { traceIds: string[]; at: number; score?: number | null; provider?: string | null; template?: string | null } | undefined {
    return this.authoredAnswers.get(utterance.trim().toLowerCase());
  }

  /** The reliability criteria of an authored answer, rebuilt at world-
   *  feedback time. The provider and the question template travel with the
   *  entry (captured at grade time); the difficulty band comes from the
   *  seeds' FSRS state. */
  private worldFeedbackCriteria(authored: { traceIds: string[]; provider?: string | null; template?: string | null }, utterance: string): GradeCriteria {
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
  private creditReAsk(utterance: string): void {
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
    const bank = this.session.observer.getMemoryBank();
    const contents: string[] = [];
    for (const id of prior.traceIds) {
      const trace = bank.get(id);
      if (trace !== undefined) contents.push(trace.content);
    }
    if (contents.length > 0) {
      updateCompositionWeights(this.compositionWeights, contents, -CREATIVE_GRADE_DELTA);
    }
    for (const id of prior.traceIds) {
      const trace = bank.get(id);
      if (trace !== undefined) bank.reinforce(id, -CREATIVE_GRADE_DELTA);
    }
    // The gap is recorded by the ask path itself — never double-bump.
  }

  /** RETENTION CREDIT: this trace was recalled again later — the answer was
   *  worth keeping. Reinforce its composition paths by the small retention
   *  delta (a weaker, cumulative signal than the LLM grade — the world
   *  confirms slowly, the teacher confirms sharply). */
  private creditRetention(traceId: string): void {
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
      break;
    }
    updateCompositionWeights(this.compositionWeights, [trace.content], CREATIVE_GRADE_DELTA * RETENTION_FRACTION);
    this.session.observer.getMemoryBank().reinforce(traceId, CREATIVE_GRADE_DELTA * RETENTION_FRACTION);
  }

  /** How many stored beliefs have been contradicted by experience — the
   *  evidence that beliefs can be wrong (persistence-safe: derived from the
   *  bank, so it rebuilds identically on import). */
  beliefContradictions(): number {
    const bank = this.session.observer.getMemoryBank();
    let contradictions = 0;
    for (const trace of bank.all()) {
      // Real belief contradictions only — the plan-failure meta-beliefs
      // (beliefKind 'goal-failed') are not evidence that the observer's
      // self-knowledge was wrong, and must not unlock the verify drive.
      if (
        trace.metadata?.kind === 'belief' &&
        trace.metadata.contradicts === true &&
        trace.metadata.beliefKind !== 'goal-failed'
      ) {
        contradictions += 1;
      }
    }
    return contradictions;
  }

  /** The subject of the most recent contradiction (verification target). */
  verifyCandidate(): string | null {
    const bank = this.session.observer.getMemoryBank();
    let best: string | null = null;
    for (const trace of bank.all()) {
      // Same filter as beliefContradictions — never surface a goal-id as a
      // verification subject (plan-failure meta-beliefs are not subjects).
      if (
        trace.metadata?.kind === 'belief' &&
        trace.metadata.contradicts === true &&
        trace.metadata.beliefKind !== 'goal-failed'
      ) {
        const about = String(trace.metadata.about ?? '');
        if (about.length > 0) best = about;
      }
    }
    return best;
  }

  /** ACQUISITION GATE: enough contradictions teach the observer that its
   *  beliefs can be wrong — the 'verify' drive enters the available pool. */
  verifyUnlocked(): boolean {
    return this.beliefContradictions() >= VERIFY_UNLOCK_THRESHOLD;
  }

  /** The behaviors the observer currently considers available. */
  availableBehaviors(): ReadonlySet<BehaviorOption> {
    const available = new Set<BehaviorOption>(ARCHETYPAL_BEHAVIORS);
    if (this.verifyUnlocked()) available.add('verify');
    return available;
  }

  // ── FADING CONTROLLER (Phase 7c): the calibrated handover ────────────────
  /** Per-class fade state — how much the student's composite weights
   *  against the teacher's grade, per class, driven by measured agreement
   *  from the 7a bench. */
  private readonly fadeState: FadeState = emptyFadeState();
  /** Teacher-dependence accounting (Phase 7d): when the reward was actually
   *  consulted the teacher's judgment vs. graded by the student's own
   *  composite — the dependence rate is the handover's report card. */
  private readonly teacherConsultations = { consulted: 0, selfGraded: 0 };

  /** Update the controller with a freshly measured agreement (bench). */
  noteFadeAgreement(cls: GradeClass, agreement: number): void {
    updateFadeState(this.fadeState, cls, agreement);
  }

  /** The current per-class λ (read-only). */
  fadeLambdas(): Record<GradeClass, number> {
    return { ...this.fadeState.lambda };
  }

  /** Which bootstrap deploy was last imported (generatedAt + word count) —
   *  so the UI can tell a NEWER headless deploy from stale IndexedDB state. */
  private bootstrapImportedMeta: { generatedAt: string; words: number } | null = null;

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

  /** Teacher-dependence rate: fraction of graded answers that leaned on the
   *  teacher (λ-effective above the floor) vs self-graded. 0 = fully
   *  handed-over; 1 = fully scaffolded. */
  teacherDependenceRate(): number {
    const total = this.teacherConsultations.consulted + this.teacherConsultations.selfGraded;
    if (total === 0) return 0;
    return this.teacherConsultations.consulted / total;
  }

  /** The blended reward for a graded answer: λ·composite + (1−λ)·teacher,
   *  with the uncertainty fallback consulting the teacher on novel terrain,
   *  and the consultation accounted for the dependence metric.
   *
   *  The composite is the student's judgment ON ITS OWN MATERIAL: it must be
   *  computed against the answer's actual SEEDS (the recalled memories the
   *  composition was built from). Grading the answer against itself as its
   *  own seed collapses novelty to 0 and the composite to 0, silently
   *  reducing the blend to (1−λ)·teacher — and at λ ≳ 0.57 a strong teacher
   *  grade then reads as weak, actively unlearning the observer's best
   *  answers. An echo answer (no novel words beyond its seeds) honestly
   *  scores novelty 0 and stays teacher-graded; a genuinely composed answer
   *  earns the student a voice in its own grade. */
  fadeReward(utterance: string, answer: string, teacherGrade: number, seeds: readonly string[]): number {
    const cls = classifyUtterance(utterance);
    const weights = this.compositionWeights;
    const parts = compositeScore(answer, utterance, weights, seeds).parts;
    const uncertain = isUncertain(utterance, answer, weights, parts.fluency);
    const lambda = effectiveLambda(this.fadeState, cls, uncertain);
    // Dependence accounting: a λ-effective at the uncertainty floor means
    // the teacher's judgment is doing the grading; above it, the student
    // weighs in meaningfully.
    if (lambda <= FADE_FLOOR) this.teacherConsultations.consulted += 1;
    else this.teacherConsultations.selfGraded += 1;
    const composite = compositeScore(answer, utterance, weights, seeds).composite;
    return blendReward(teacherGrade, composite, lambda);
  }

  /** PER-GOAL-TYPE outcome history — the observer's own record of whether
   *  its plans tend to work (feeds expected-value choice + introspection). */
  private readonly goalHistory: Record<GoalType, { completed: number; abandoned: number }> = {
    'learn-word': { completed: 0, abandoned: 0 },
    'fill-gap': { completed: 0, abandoned: 0 },
    practice: { completed: 0, abandoned: 0 },
    'verify-belief': { completed: 0, abandoned: 0 }
  };

  /** The goal-type outcome history (read-only). */
  goalHistorySnapshot(): Record<GoalType, { completed: number; abandoned: number }> {
    return {
      'learn-word': { ...this.goalHistory['learn-word'] },
      'fill-gap': { ...this.goalHistory['fill-gap'] },
      practice: { ...this.goalHistory.practice },
      'verify-belief': { ...this.goalHistory['verify-belief'] }
    };
  }

  private noteGoalOutcome(type: GoalType, completed: boolean): void {
    const record = this.goalHistory[type];
    if (completed) record.completed += 1;
    else record.abandoned += 1;
  }

  /** The plan completed a goal — the observer's goal history learns. */
  noteGoalSuccess(type: GoalType): void {
    this.noteGoalOutcome(type, true);
  }

  /** A goal was abandoned — the observer's goal history learns. */
  noteGoalAbandon(type: GoalType): void {
    this.noteGoalOutcome(type, false);
  }

  /** DELIBERATION VIEW: the active goal traces, ranked by priority, with the
   *  reason computed from the observer's own goal history — the answer to
   *  "what are you trying to do" is its own evaluated plan, not a canned
   *  string. */
  activeGoalView(): Array<{ target: string; type: GoalType; priority: number; reason: string }> {
    const bank = this.session.observer.getMemoryBank();
    const active: Array<{ target: string; type: GoalType; priority: number }> = [];
    for (const trace of bank.all()) {
      if (trace.metadata?.kind !== 'goal' || trace.metadata.goalStatus !== 'active') continue;
      const type = String(trace.metadata.goalType ?? '') as GoalType;
      const target = String(trace.metadata.target ?? '');
      const priority = Number(trace.metadata.priority ?? 0);
      const isGoalType = ['learn-word', 'fill-gap', 'practice', 'verify-belief'].includes(type);
      if (isGoalType && target.length > 0) active.push({ target, type, priority });
    }
    for (const inMemory of this.goals) {
      if (inMemory.status !== 'active') continue;
      if (!active.some((g) => g.target === inMemory.target && g.type === inMemory.type)) {
        active.push({ target: inMemory.target, type: inMemory.type, priority: inMemory.priority });
      }
    }
    active.sort((a, b) => b.priority - a.priority);
    return active.map((goal) => {
      const history = this.goalHistory[goal.type] ?? { completed: 0, abandoned: 0 };
      const total = history.completed + history.abandoned;
      const successRate = total === 0 ? 0.5 : history.completed / total;
      const reason = successRate >= 0.5
        ? `${goal.type} has gone well for me (${history.completed}/${total})`
        : `I have not tried much ${goal.type} yet`;
      return { target: goal.target, type: goal.type, priority: goal.priority, reason };
    });
  }
}
