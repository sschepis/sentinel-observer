/**
 * Module-scope types, constants, and helpers of the TeacherAgent — the
 * shared vocabulary of the agent faculties (moved verbatim from the
 * original TeacherAgent.ts). Kept out of TeacherAgent.ts so the faculty
 * files can import it without an import cycle.
 */
import { FSRS_INITIAL_STABILITY, FSRS_INITIAL_DIFFICULTY } from '../fsrs';
import { CONVERSATION_RECALL_FLOOR, type CreativeComposition } from '../conversation';
import { tokenizeText, isContentWord, singularize } from '../context';
import type { OperatorResult } from '../operators';
import type { RecallResult } from '@sschepis/sentient-core';
import type { DSLExpr } from '../technical/dsl';
import type { DeckWord } from '../deck';
import type { RelationPredicate } from '../relations';
import type { EpisodicFact, RememberedFact } from '../episodic';

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
  /** Separation from the best competing trace (0 when nothing was recalled)
   *  — the ambiguity reading the answering gate uses at deck scale. */
  margin?: number;
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
  /** The rewrite rules the answer derived through (R5) — a wrong grade
   *  weakens exactly those rules, never the whole store. */
  ruleIds?: string[];
}

/** The ledger's cap — bounded like strengthHistory, never unbounded growth. */
const ANSWER_GRADES_CAP = 200;
/** The sweep resolution ledger's cap — bounded like the grade ledger. */
const SWEEP_RESOLVED_CAP = 500;

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
  /** The rewrite rules the answer derived through (R5), with the derivation
   *  step count. A grade credits or weakens exactly these rules. */
  ruleIds?: string[];
  derivationSteps?: number;
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

/**
 * L1b (Phase 18.2): the creative grade delta is SURPRISE-SCALED by the
 * grade's margin beyond its gate — a 0.95 grade moves seeds more than a
 * 0.71, a 0.05 grade weakens more than a 0.28 — floored at 0.25 of the base
 * delta so a gate-edge grade still moves. The BAND never changes (mirroring
 * the reliability model's contract: scale deltas, never bands); mid-band
 * grades stay 0. The extremes reproduce the pre-L1b magnitudes exactly:
 * creativeGradeDelta(1) = +CREATIVE_GRADE_DELTA, creativeGradeDelta(0) =
 * −CREATIVE_GRADE_DELTA — the world-feedback channels (re-ask = full
 * weaken, retention confirm = full reinforce × RETENTION_FRACTION) route
 * through those extremes.
 */
export function creativeGradeDelta(score: number): number {
  if (score >= CREATIVE_REINFORCE_SCORE) {
    const margin = (score - CREATIVE_REINFORCE_SCORE) / (1 - CREATIVE_REINFORCE_SCORE);
    return CREATIVE_GRADE_DELTA * Math.max(0.25, Math.min(1, margin));
  }
  if (score <= CREATIVE_WEAKEN_SCORE) {
    const margin = (CREATIVE_WEAKEN_SCORE - score) / CREATIVE_WEAKEN_SCORE;
    return -CREATIVE_GRADE_DELTA * Math.max(0.25, Math.min(1, margin));
  }
  return 0;
}
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
// Phase 24.2: the scheduler's constants and pure functions live in fsrs.ts;
// they are imported here and re-exported for the existing importers.

/**
 * Chat routing threshold: a memorized exchange is only authoritative when
 * recall confidence clears this. Taught cues recall at 0.84-0.98; weak
 * partial overlaps (0.6-0.8) are NOT the same exchange and must not be
 * answered as if they were.
 */
const CONVERSATION_HIGH_CONFIDENCE = 0.8;

/**
 * MARGIN GATE — the separation a memorized answer must show over its best
 * competitor when its absolute score sits in the 0.6-0.8 band.
 *
 * MEASURED (200 taught cues, 728-pair curriculum + 200 words): the true
 * trace ranks FIRST for 98.5% of taught cues, but its mean score is 0.686 —
 * the absolute 0.8 threshold was calibrated on a much smaller curriculum
 * (its comment still says "taught cues recall at 0.84-0.98") and now
 * refuses a third of correct, unambiguous recalls. Mean margin over the
 * runner-up is +0.104 for true matches. Gating on SEPARATION rather than an
 * absolute constant keeps the honesty contract intact — the answer must
 * still be the taught exchange by cue identity AND clearly beat every
 * competitor — while letting correct recalls through at deck scale.
 */
const CONVERSATION_MIN_MARGIN = 0.05;

/** Words one passage may teach: reading widens vocabulary, but a single
 *  book must not flood the bank or hijack the review schedule. */
const READING_WORD_BUDGET = 64;

/**
 * Whether a recalled exchange may be SPOKEN as memorized: the cue identity
 * must match, and the recall must either clear the absolute confidence bar
 * or clear the recall floor with a clear margin over its best competitor.
 */
function authoritativeRecall(score: number, margin: number, cue: string, matchedCue: string): boolean {
  if (!matchesCue(cue.trim().toLowerCase(), matchedCue.trim().toLowerCase())) return false;
  if (score >= CONVERSATION_HIGH_CONFIDENCE) return true;
  return score >= CONVERSATION_RECALL_FLOOR && margin >= CONVERSATION_MIN_MARGIN;
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

// L3 (Phase 19.1): the legacy tiered half-life decay (`applyTimeDecay`) is
// DELETED. There is exactly one forgetting law — the FSRS retention curve
// below (`applyRetentionDecay`): strength IS the model's prediction. The
// legacy curve survived only in the CLI retention sim's comment and the
// modelSettings tests, which now exercise the real law.

// ── P9: the retention model ─────────────────────────────────────────────────
// L3 (Phase 19.4): the curve itself lives in retention.ts — THE one law.
// Phase 24.2: the FSRS scheduler (constants, retrievability, trace decay)
// lives in fsrs.ts. Both are re-exported here for existing importers.


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

// Internal names the class body and faculties use — exported so the agent
// files can import them (the module surface of ./TeacherAgent is frozen via
// its own explicit re-exports, so widening exports here changes nothing
// externally).
export {
  PERSIST_DEBOUNCE_MS,
  PERSIST_MAX_DELAY_MS,
  isTouchedWordState,
  ANSWER_GRADES_CAP,
  SWEEP_RESOLVED_CAP,
  EMPTY_PROVENANCE,
  edgeKey,
  operatorEdges,
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
  isStaleEncoding
};
