/**
 * DIFFICULTY-TARGETED CURRICULUM — the lesson queue is a scored ranking,
 * not a static script.
 *
 * Four signals combine into one priority score per deck word:
 *
 *  1. FSRS difficulty — the scheduler's own learned per-item difficulty
 *     (`state.difficulty` in [1,10]) and how overdue the word is RELATIVE
 *     to the interval it was scheduled for (a word 2 interval-days late has
 *     decayed to ~0.55 retention; a 30-day-interval word one day late is
 *     still at ~0.87). "Most-due-past-desired" means overdue-per-interval,
 *     not raw wall-clock lateness.
 *  2. Semantic sparsity — how isolated the word's semantic-signature
 *     neighborhood is (semanticSignature.ts): the count of OTHER deck words
 *     sharing at least one signature prime. Few active edges = the word has
 *     no resonance partners to lean on, so it needs explicit teaching.
 *  3. Repeated gaps — persisted review history: items that keep appearing
 *     in review sets and keep failing across sessions. One miss is noise;
 *     a pattern of misses is a curriculum signal.
 *  4. Drill weakness — technical concepts that keep failing
 *     technical/drill.ts rounds (verdict unlearned/memorized instead of
 *     induced/rule-induced).
 *
 * The module is pure: it scores plain item data (duck-typed WordState
 * fields) so TeacherAgent, plan.ts and the benchmark share one ranking
 * without an import cycle. The FSRS SCHEDULE remains the primary contract —
 * due words are reviewed before new words are taught; the curriculum orders
 * WITHIN each pool, never against it.
 */
import { clampRange } from '@sschepis/sentient-core';

export type ReviewOutcome = 'correct' | 'wrong';

/** The WordState fields the curriculum reads (structural, cycle-free). */
export interface CurriculumItem {
  word: string;
  traceId: string | null;
  dueAt: number | null;
  stability: number;
  difficulty: number;
  lastIntervalDays: number | null;
  reviewHistory: readonly ReviewOutcome[];
}

/** Everything the scorer needs beyond the item itself. */
export interface CurriculumContext {
  /** word → prime signature (semanticSignature.ts scheme). */
  vocabulary: Readonly<Record<string, readonly number[]>>;
  /** concept → consecutive failed drill rounds (technical/drill.ts). */
  drillFailures?: Readonly<Record<string, number>>;
  /** Wall-clock for the overdue component (default Date.now()). */
  now?: number;
  /** Signal weights (defaults CURRICULUM_WEIGHTS). */
  weights?: Partial<CurriculumWeights>;
}

/** Teacher-side configuration: a switch off to the legacy scheduler (the
 *  benchmark control) and optional signal weights. */
export interface CurriculumConfig {
  /** false = the pre-curriculum scheduler (earliest dueAt, deck-order new
   *  words). Default true. */
  enabled?: boolean;
  weights?: Partial<CurriculumWeights>;
}

export interface CurriculumWeights {
  /** FSRS learned difficulty (1..10 → 0..1). */
  fsrs: number;
  /** Days past due relative to the scheduled interval. */
  overdue: number;
  /** Absolute days past due — the fairness floor: the relative term
   *  saturates for short-interval words, and without this term a
   *  perpetually-failing word could starve a merely-overdue one forever. */
  waiting: number;
  /** Sparse semantic neighborhood (few shared-prime edges). */
  sparsity: number;
  /** Repeatedly weak across sessions (persisted review history). */
  gap: number;
  /** Repeatedly failing drills. */
  drill: number;
}

/** Default signal mix. Weights are relative — the score is the weighted
 *  mean, so the total always lands in [0,1] regardless of scale. */
export const CURRICULUM_WEIGHTS: CurriculumWeights = {
  fsrs: 1,
  overdue: 1,
  waiting: 0.75,
  sparsity: 0.6,
  gap: 1,
  drill: 0.8
};

/** Cap on the persisted per-word review history (bounded like
 *  strengthHistory — the signal needs a trend, not a ledger). */
export const REVIEW_HISTORY_CAP = 24;
/** The review-history window the gap signal reads. */
const GAP_WINDOW = 8;
/** Wrongs required before weakness reads as a PATTERN, not noise. */
const GAP_PATTERN_WRONGS = 3;
/** Trailing wrongs that read as an active failure streak. */
const GAP_STREAK_CAP = 4;
/** Neighborhood decay: a word with this many shared-prime neighbors sits at
 *  sparsity e^-1 ≈ 0.37 — the edge count is a small-integer signal, so the
 *  decay must be gentle. */
const SPARSE_NEIGHBOR_DECAY = 6;
/** Interval-days overdue at which the overdue component saturates. */
const OVERDUE_SATURATION_INTERVALS = 2;
/** Absolute days overdue at which the waiting (fairness) component
 *  saturates — a word that has waited this long reads as fully neglected. */
export const WAIT_SATURATION_DAYS = 14;
/** Drill rounds failed before weakness reads as full. */
const DRILL_WEAK_ROUNDS = 3;
/** The default interval when a word has never been scheduled (fresh teach). */
const DEFAULT_INTERVAL_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Signal components ───────────────────────────────────────────────────────

/** FSRS learned difficulty in [1,10] → [0,1]. */
export function fsrsDifficulty(state: CurriculumItem): number {
  return clampRange((state.difficulty - 1) / 9, 0, 1);
}

/** How overdue the word is RELATIVE to its scheduled interval: a word two
 *  interval-days past due saturates at 1 (retention ≈ 0.55); a healthy word
 *  reviewed on time sits at 0. This is the "most-due-past-desired" sense —
 *  absolute lateness would starve short-interval items for long-interval
 *  ones that are barely decayed. */
export function overdueUrgency(state: CurriculumItem, now: number = Date.now()): number {
  if (state.dueAt === null) return 0;
  const overdueDays = (now - state.dueAt) / DAY_MS;
  if (overdueDays <= 0) return 0;
  const intervalDays = Math.max(0.5, state.lastIntervalDays ?? DEFAULT_INTERVAL_DAYS);
  return clampRange(overdueDays / (intervalDays * OVERDUE_SATURATION_INTERVALS), 0, 1);
}

/** Absolute days past due, capped — the fairness floor. The relative term
 *  saturates for short-interval words, so this is the ONLY thing that
 *  eventually pushes a perpetually-starved word up the queue. */
export function waitingUrgency(state: CurriculumItem, now: number = Date.now()): number {
  if (state.dueAt === null) return 0;
  const overdueDays = (now - state.dueAt) / DAY_MS;
  if (overdueDays <= 0) return 0;
  return clampRange(overdueDays / WAIT_SATURATION_DAYS, 0, 1);
}

/** prime → words index over a vocabulary (one pass; the O(n·k) graph is the
 *  expensive part, so every multi-word ranking shares a single build). */
export function neighborIndex(
  vocabulary: Readonly<Record<string, readonly number[]>>
): Map<number, string[]> {
  const index = new Map<number, string[]>();
  for (const [word, signature] of Object.entries(vocabulary)) {
    for (const prime of new Set(signature)) {
      const list = index.get(prime);
      if (list === undefined) index.set(prime, [word]);
      else list.push(word);
    }
  }
  return index;
}

/** Other words sharing at least one signature prime — the word's active
 *  semantic neighborhood size (semanticSignature.ts edge count). */
export function neighborhoodEdges(
  word: string,
  vocabulary: Readonly<Record<string, readonly number[]>>,
  index?: Map<number, string[]>
): number {
  const signature = vocabulary[word];
  // HONEST NO-EVIDENCE GUARD: a word whose vocabulary entry is not a real
  // signature array (a prototype-shadowed key, a legacy table gap) carries
  // no neighborhood information — the curriculum scores it on the signals
  // it has, and never crashes the queue on a malformed entry.
  if (!Array.isArray(signature) || signature.length === 0) return 0;
  const built = index ?? neighborIndex(vocabulary);
  const neighbors = new Set<string>();
  for (const prime of new Set(signature)) {
    for (const other of built.get(prime) ?? []) {
      if (other !== word) neighbors.add(other);
    }
  }
  return neighbors.size;
}

/** Sparse-neighborhood signal: 1 for an isolated word (no shared primes with
 *  anything — no resonance partners), decaying exponentially with the active
 *  edge count. A word absent from the vocabulary carries no evidence, so it
 *  scores 0 — the curriculum never invents sparsity for an unknown encoding. */
export function neighborhoodSparsity(
  word: string,
  vocabulary: Readonly<Record<string, readonly number[]>>,
  index?: Map<number, string[]>
): number {
  if (vocabulary[word] === undefined) return 0;
  const edges = neighborhoodEdges(word, vocabulary, index);
  return Math.exp(-edges / SPARSE_NEIGHBOR_DECAY);
}

/** Repeated-gap signal from the persisted review history: the share of the
 *  recent window that failed, gated by the pattern threshold (three misses
 *  before weakness is a pattern, not noise) plus the current failure
 *  streak. An item with no history scores 0 — it has never been in a
 *  review set, so it cannot be a repeated gap. */
export function gapSignal(state: Pick<CurriculumItem, 'reviewHistory'>): number {
  const history = state.reviewHistory;
  const window = history.slice(-GAP_WINDOW);
  if (window.length === 0) return 0;
  let wrongs = 0;
  let streak = 0;
  for (const outcome of window) if (outcome === 'wrong') wrongs += 1;
  for (let i = window.length - 1; i >= 0 && window[i] === 'wrong'; i -= 1) streak += 1;
  const weakShare = wrongs / window.length;
  const pattern = Math.min(1, wrongs / GAP_PATTERN_WRONGS);
  const activeStreak = Math.min(1, streak / GAP_STREAK_CAP);
  return clampRange((0.6 * weakShare + 0.4 * activeStreak) * pattern, 0, 1);
}

/** Drill weakness: consecutive failed rounds (unlearned/memorized, never
 *  induced) out of the 3-round pattern threshold. */
export function drillWeakness(failures: number | undefined): number {
  if (failures === undefined || failures <= 0) return 0;
  return clampRange(failures / DRILL_WEAK_ROUNDS, 0, 1);
}

// ── Combination ─────────────────────────────────────────────────────────────

export interface CurriculumScore {
  word: string;
  /** The weighted combination in [0,1] — higher = more deserving of the
   *  next lesson. */
  score: number;
  fsrs: number;
  overdue: number;
  waiting: number;
  sparsity: number;
  gap: number;
  drill: number;
}

/** One item's full curriculum score. */
export function scoreWord(
  item: CurriculumItem,
  ctx: CurriculumContext,
  index?: Map<number, string[]>
): CurriculumScore {
  const now = ctx.now ?? Date.now();
  const parts = {
    fsrs: fsrsDifficulty(item),
    overdue: overdueUrgency(item, now),
    waiting: waitingUrgency(item, now),
    sparsity: neighborhoodSparsity(item.word, ctx.vocabulary, index),
    gap: gapSignal(item),
    drill: drillWeakness(ctx.drillFailures?.[item.word])
  };
  const weights = { ...CURRICULUM_WEIGHTS, ...ctx.weights };
  const total =
    weights.fsrs + weights.overdue + weights.waiting + weights.sparsity + weights.gap + weights.drill;
  const score = clampRange(
    (weights.fsrs * parts.fsrs +
      weights.overdue * parts.overdue +
      weights.waiting * parts.waiting +
      weights.sparsity * parts.sparsity +
      weights.gap * parts.gap +
      weights.drill * parts.drill) /
      total,
    0,
    1
  );
  return { word: item.word, score, ...parts };
}

export interface CurriculumRankOptions {
  /** Include learned-but-not-due words after the fresh pool (default false:
   *  the FSRS schedule decides when healthy words are reviewed; the
   *  curriculum must not override the schedule, only the order within it). */
  includeHealthy?: boolean;
  /** Cap the queue length. */
  limit?: number;
}

/** The prioritized lesson queue: due words first (FSRS schedule is the
 *  primary contract), then never-taught words, then — when asked — healthy
 *  learned words. Every pool is ordered by curriculum score, so a hard,
 *  overdue, isolated word with a failure streak beats a merely-due one. */
export function rankCurriculum(
  items: readonly CurriculumItem[],
  ctx: CurriculumContext,
  options: CurriculumRankOptions = {}
): CurriculumScore[] {
  const index = neighborIndex(ctx.vocabulary);
  const now = ctx.now ?? Date.now();
  const due: CurriculumScore[] = [];
  const fresh: CurriculumScore[] = [];
  const healthy: CurriculumScore[] = [];
  for (const item of items) {
    const score = scoreWord(item, ctx, index);
    if (item.traceId === null) {
      fresh.push(score);
    } else if (item.dueAt !== null && item.dueAt <= now) {
      due.push(score);
    } else {
      healthy.push(score);
    }
  }
  due.sort((a, b) => b.score - a.score);
  fresh.sort((a, b) => b.score - a.score);
  healthy.sort((a, b) => b.score - a.score);
  const ordered = [...due, ...fresh, ...(options.includeHealthy === true ? healthy : [])];
  return options.limit !== undefined ? ordered.slice(0, options.limit) : ordered;
}

/** The top of the queue (null when the queue is empty). */
export function nextCurriculumWord(
  items: readonly CurriculumItem[],
  ctx: CurriculumContext,
  options: CurriculumRankOptions = {}
): string | null {
  const top = rankCurriculum(items, ctx, { ...options, limit: 1 })[0];
  return top !== undefined ? top.word : null;
}

/** The pre-curriculum scheduler, exported as the honest benchmark control:
 *  due words ordered by earliest dueAt (tie: lowest stability), then the
 *  first never-taught word. This is exactly what TeacherAgent.nextReview did
 *  before the curriculum landing; the components it never read are 0. */
export function rankLegacy(items: readonly CurriculumItem[], now: number = Date.now()): CurriculumScore[] {
  const due = items
    .filter((item) => item.traceId !== null && item.dueAt !== null && item.dueAt <= now)
    .sort((a, b) => (a.dueAt as number) - (b.dueAt as number) || a.stability - b.stability);
  const fresh = items.filter((item) => item.traceId === null);
  return [...due, ...fresh].map((item) => ({
    word: item.word,
    score: 0,
    fsrs: fsrsDifficulty(item),
    overdue: overdueUrgency(item, now),
    waiting: waitingUrgency(item, now),
    sparsity: 0,
    gap: gapSignal(item),
    drill: 0
  }));
}
