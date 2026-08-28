/**
 * Semantic Memory Bank
 *
 * Stores memory traces, each carrying a 16-axis SMF signature and a
 * holographic interference pattern, and recalls them by similarity search
 * (cosine similarity on the SMF plus phase-aware holographic correlation).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Fixes relative to `lib/sentient-memory.js`
 * ──────────────────────────────────────────────────────────────────────────
 *
 * 4. DEAD ENTROPY LOCK (`PRGraphMemory`, lib/sentient-memory.js:44/55)
 *
 *      put()  ->  { entropy: 1.0, ... }
 *      get()  ->  if (entry.entropy < this.lockThreshold /* 0.8 *\/ && ...)
 *
 *    `entropy` was hardwired to 1.0 and never recomputed, so the lock
 *    predicate `1.0 < 0.8` was permanently false: `getLockedMemories()` always
 *    returned `[]` and `stats().locked` was always 0. Dead code masquerading as
 *    a feature.
 *
 *    Fix: consolidation uses the trace's REAL normalized SMF entropy, refreshed
 *    on every access. A sharply-oriented (low-entropy) trace that has been
 *    recalled `minAccessCount` times consolidates, and consolidated traces are
 *    exempt from pruning. The rule demonstrably fires (asserted in tests).
 *
 * 5. PRUNE OVER-DELETION (`prune()`, lib/sentient-memory.js:1174-1202)
 *
 *      if (this.traces.size - toRemove.length > this.maxTraces) {
 *        ...
 *        const removeCount = this.traces.size - this.maxTraces;   // <-- bug
 *        for (...) toRemove.push(sorted[i].id);
 *      }
 *
 *    `removeCount` was computed from the full map size while `toRemove` already
 *    held the weak traces, so the weak traces were counted twice and the bank
 *    was trimmed to `maxTraces - weakCount` instead of `maxTraces`.
 *
 *    Fix: the overflow is computed against the size that will remain after the
 *    weak set is dropped, and the total deletion count is asserted.
 *
 * This module is pure math/bookkeeping with no dependency on the ESM library.
 */

import { randomUUID } from '../common/random';
import { SedenionMemoryField } from './SedenionMemoryField';
import { HolographicMemory } from './HolographicMemory';
import { clampRange, requireFinite, safeDivide } from './numeric';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** A stored memory trace. */
export interface MemoryTrace {
  readonly id: string;
  readonly content: string;
  readonly smf: SedenionMemoryField;
  readonly primes: readonly number[];
  readonly amplitudes: readonly number[];
  readonly pattern: HolographicMemory;
  readonly createdAt: number;
  lastAccessAt: number;
  accessCount: number;
  /** Decaying retrieval strength in [0, 1]. */
  strength: number;
  /** Caller-declared importance in [0, 1]; protects a trace from pruning. */
  importance: number;
  /** True once the consolidation rule has fired. */
  consolidated: boolean;
  /** Normalized SMF entropy at the last refresh, in [0, 1]. */
  smfEntropy: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Optional per-trace overrides for `store`. */
export interface StoreOptions {
  /** Amplitude per prime; defaults to 1 for every prime. */
  amplitudes?: readonly number[];
  /** Phase per prime; defaults to 0. */
  phases?: readonly number[];
  importance?: number;
  metadata?: Record<string, unknown>;
}

/** Recall cue. At least one of `smf` / `primes` must be supplied. */
export interface RecallQuery {
  smf?: SedenionMemoryField;
  primes?: readonly number[];
  amplitudes?: readonly number[];
  phases?: readonly number[];
}

/** Scored recall hit. */
export interface RecallResult {
  trace: MemoryTrace;
  /** Combined weighted score. */
  score: number;
  /** SMF cosine similarity in [-1, 1]. */
  smfScore: number;
  /** Phase-aware holographic correlation in [-1, 1]. */
  holographicScore: number;
  consolidated: boolean;
}

/** Bank statistics. */
export interface MemoryBankStats {
  traceCount: number;
  capacity: number;
  consolidatedCount: number;
  averageStrength: number;
  averageImportance: number;
  averageSmfEntropy: number;
  storeCount: number;
  recallCount: number;
  prunedCount: number;
  oldestAt: number | null;
  newestAt: number | null;
}

/** Construction options. */
export interface SemanticMemoryBankOptions {
  /** Maximum retained traces (default 256). */
  capacity?: number;
  /** Holographic grid size (default 64). */
  gridSize?: number;
  /** Prime basis for holographic patterns. Required to match query primes. */
  primes?: readonly number[];
  /** Weight of the SMF term in the combined score (default 0.6). */
  smfWeight?: number;
  /** Weight of the holographic term in the combined score (default 0.4). */
  holographicWeight?: number;
  /** Strength below which an unconsolidated trace becomes prunable (default 0.25). */
  minStrength?: number;
  /** Importance at or above which a trace is protected from weak-pruning (default 0.7). */
  importanceFloor?: number;
  /** Normalized SMF entropy at or below which a trace may consolidate (default 0.75). */
  entropyLockThreshold?: number;
  /** Access count required before a trace may consolidate (default 3). */
  minAccessCount?: number;
  /** Strength required before a trace may consolidate (default 0.5). */
  minLockStrength?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// BANK
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULTS = {
  capacity: 256,
  gridSize: 64,
  smfWeight: 0.6,
  holographicWeight: 0.4,
  minStrength: 0.25,
  importanceFloor: 0.7,
  entropyLockThreshold: 0.75,
  minAccessCount: 3,
  minLockStrength: 0.5
} as const;

export class SemanticMemoryBank {
  private readonly traces = new Map<string, MemoryTrace>();
  private readonly config: Required<Omit<SemanticMemoryBankOptions, 'primes'>> & { primes?: readonly number[] };
  private readonly gridSize: number;
  private readonly primeBasis?: readonly number[];

  private storeCount = 0;
  private recallCount = 0;
  private prunedCount = 0;

  constructor(options: SemanticMemoryBankOptions = {}) {
    this.gridSize = Math.max(4, Math.floor(options.gridSize ?? DEFAULTS.gridSize));
    this.primeBasis = options.primes ? Array.from(options.primes) : undefined;

    const smfWeight = requireFinite(options.smfWeight ?? DEFAULTS.smfWeight, 'smfWeight');
    const holographicWeight = requireFinite(
      options.holographicWeight ?? DEFAULTS.holographicWeight,
      'holographicWeight'
    );
    if (smfWeight === 0 && holographicWeight === 0) {
      throw new Error(
        'SemanticMemoryBank: smfWeight and holographicWeight cannot both be 0; every recall score would be 0'
      );
    }

    this.config = {
      capacity: Math.max(1, Math.floor(options.capacity ?? DEFAULTS.capacity)),
      gridSize: this.gridSize,
      smfWeight,
      holographicWeight,
      minStrength: clampRange(options.minStrength ?? DEFAULTS.minStrength, 0, 1),
      importanceFloor: clampRange(options.importanceFloor ?? DEFAULTS.importanceFloor, 0, 1),
      entropyLockThreshold: clampRange(options.entropyLockThreshold ?? DEFAULTS.entropyLockThreshold, 0, 1),
      minAccessCount: Math.max(1, Math.floor(options.minAccessCount ?? DEFAULTS.minAccessCount)),
      minLockStrength: clampRange(options.minLockStrength ?? DEFAULTS.minLockStrength, 0, 1),
      primes: this.primeBasis
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Structure
  // ─────────────────────────────────────────────────────────────────────────

  get size(): number {
    return this.traces.size;
  }

  get capacity(): number {
    return this.config.capacity;
  }

  /**
   * Resize the bank. Shrinking below the current size trims immediately
   * (weakest-first, consolidated traces protected).
   */
  setCapacity(capacity: number): void {
    this.config.capacity = Math.max(1, Math.floor(capacity));
    if (this.traces.size > this.config.capacity) this.prune();
  }

  /** Lookup by id. */
  get(id: string): MemoryTrace | undefined {
    return this.traces.get(id);
  }

  /** Snapshot of all traces in insertion order. */
  all(): readonly MemoryTrace[] {
    return Array.from(this.traces.values());
  }

  /** Traces that have satisfied the consolidation rule. */
  consolidated(): readonly MemoryTrace[] {
    return Array.from(this.traces.values()).filter(t => t.consolidated);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Storage
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Store a trace. The SMF is cloned so later mutation of the caller's field
   * cannot retroactively rewrite stored memory. The holographic pattern is
   * built with the trace's OWN primes as its basis, so every encoded prime
   * is represented - nothing is silently dropped by a mismatched basis.
   * Storing with an empty prime list throws: a trace with no pattern would
   * be unrecoverable.
   */
  store(
    content: string,
    smf: SedenionMemoryField,
    primes: readonly number[],
    options: StoreOptions = {}
  ): MemoryTrace {
    const smfCopy = smf.clone();
    const primeList = Array.from(primes);
    if (primeList.length === 0) {
      throw new Error('SemanticMemoryBank.store requires at least one prime');
    }
    const amplitudes = options.amplitudes
      ? Array.from(options.amplitudes).slice(0, primeList.length)
      : primeList.map(() => 1);
    while (amplitudes.length < primeList.length) amplitudes.push(1);

    const pattern = this.createPattern(primeList);
    pattern.encode(primeList, amplitudes, options.phases);

    const now = Date.now();
    const trace: MemoryTrace = {
      id: randomUUID(),
      content,
      smf: smfCopy,
      primes: primeList,
      amplitudes,
      pattern,
      createdAt: now,
      lastAccessAt: now,
      accessCount: 0,
      strength: 1,
      importance: clampRange(options.importance ?? 0.5, 0, 1),
      consolidated: false,
      smfEntropy: smfCopy.normalizedEntropy(),
      metadata: options.metadata ? { ...options.metadata } : {}
    };

    this.traces.set(trace.id, trace);
    this.storeCount += 1;

    if (this.traces.size > this.config.capacity) this.prune();

    return trace;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Recall
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Similarity search over the bank.
   *
   * Score = `smfWeight · cos(SMF_query, SMF_trace) + holographicWeight ·
   * Re(corr(H_query, H_trace))`, with each term omitted (and the weights
   * renormalized) when the query does not supply that modality. Missing
   * modalities are never replaced with a neutral 0.5.
   */
  recall(query: RecallQuery, topK = 5): RecallResult[] {
    if (!query.smf && (!query.primes || query.primes.length === 0)) {
      throw new Error('SemanticMemoryBank.recall requires an smf and/or primes cue');
    }
    const limit = Math.max(0, Math.floor(topK));
    if (limit === 0 || this.traces.size === 0) return [];

    this.recallCount += 1;

    // Cue primes are deduplicated defensively: text folding can map several
    // tokens onto the same prime, and a holographic basis with duplicate
    // primes is invalid by construction.
    const cuePrimes = query.primes ? [...new Set(query.primes)] : undefined;

    let queryPattern: HolographicMemory | null = null;
    if (cuePrimes && cuePrimes.length > 0) {
      const amplitudes = query.amplitudes
        ? Array.from(query.amplitudes)
        : cuePrimes.map(() => 1);
      queryPattern = this.createPattern(cuePrimes);
      queryPattern.encode(cuePrimes, amplitudes, query.phases);
    }

    const useSmf = query.smf !== undefined;
    const useHolo = queryPattern !== null;
    const weightTotal =
      (useSmf ? this.config.smfWeight : 0) + (useHolo ? this.config.holographicWeight : 0);

    const scored: RecallResult[] = [];
    for (const trace of this.traces.values()) {
      const smfScore = useSmf && query.smf ? query.smf.coherenceWith(trace.smf) : 0;
      const holographicScore = queryPattern ? queryPattern.similarity(trace.pattern) : 0;

      const weighted =
        (useSmf ? this.config.smfWeight * smfScore : 0) +
        (useHolo ? this.config.holographicWeight * holographicScore : 0);

      scored.push({
        trace,
        score: requireFinite(safeDivide(weighted, weightTotal, 0), 'recall.score'),
        smfScore,
        holographicScore,
        consolidated: trace.consolidated
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, limit);

    // Accessing a trace reinforces it and re-evaluates consolidation with the
    // trace's REAL entropy.
    for (const hit of hits) this.touch(hit.trace);
    for (const hit of hits) hit.consolidated = hit.trace.consolidated;

    return hits;
  }

  /**
   * Register an access: bump the counters, reinforce strength, refresh the real
   * SMF entropy and re-test the consolidation rule.
   */
  touch(trace: MemoryTrace): void {
    trace.accessCount += 1;
    trace.lastAccessAt = Date.now();
    trace.strength = clampRange(trace.strength + 0.1, 0, 1);
    trace.smfEntropy = trace.smf.normalizedEntropy();

    if (
      !trace.consolidated &&
      trace.accessCount >= this.config.minAccessCount &&
      trace.strength >= this.config.minLockStrength &&
      trace.smfEntropy <= this.config.entropyLockThreshold
    ) {
      trace.consolidated = true;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Maintenance
  // ─────────────────────────────────────────────────────────────────────────

  /** Decay every unconsolidated trace's strength. Consolidated traces persist. */
  decay(rate = 0.02): void {
    const factor = 1 - clampRange(rate, 0, 1);
    for (const trace of this.traces.values()) {
      if (trace.consolidated) continue;
      trace.strength = clampRange(trace.strength * factor, 0, 1);
    }
  }

  /**
   * Trim the bank to capacity.
   *
   * Two passes, with the second sized against the post-first-pass count so the
   * weak set is never counted twice:
   *   1. Drop unconsolidated, low-strength, low-importance traces.
   *   2. If still over capacity, drop the lowest-scoring remaining traces -
   *      exactly `remaining - capacity` of them.
   *
   * Consolidated traces are never pruned.
   *
   * @returns the number of traces removed.
   */
  prune(): number {
    const doomed = new Set<string>();

    for (const trace of this.traces.values()) {
      if (trace.consolidated) continue;
      if (trace.strength < this.config.minStrength && trace.importance < this.config.importanceFloor) {
        doomed.add(trace.id);
      }
    }

    const remaining = this.traces.size - doomed.size;
    const overflow = remaining - this.config.capacity;

    if (overflow > 0) {
      const candidates = Array.from(this.traces.values())
        .filter(t => !doomed.has(t.id) && !t.consolidated)
        .sort((a, b) => this.retentionScore(a) - this.retentionScore(b));

      const take = Math.min(overflow, candidates.length);
      for (let i = 0; i < take; i++) doomed.add(candidates[i].id);
    }

    let removed = 0;
    for (const id of doomed) {
      if (this.traces.delete(id)) removed += 1;
    }

    if (removed !== doomed.size) {
      throw new Error(`prune() removal mismatch: expected ${doomed.size}, deleted ${removed}`);
    }

    this.prunedCount += removed;
    return removed;
  }

  /** Retention priority: higher survives. */
  private retentionScore(trace: MemoryTrace): number {
    const ageMs = Math.max(0, Date.now() - trace.lastAccessAt);
    const recency = 1 / (1 + ageMs / 60_000);
    const accessBonus = 1 - 1 / (1 + trace.accessCount);
    return requireFinite(
      0.35 * trace.strength + 0.35 * trace.importance + 0.2 * recency + 0.1 * accessBonus,
      'retentionScore'
    );
  }

  /** Remove a single trace. */
  delete(id: string): boolean {
    return this.traces.delete(id);
  }

  /** Drop everything (statistics counters are preserved). */
  clear(): void {
    this.traces.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Statistics
  // ─────────────────────────────────────────────────────────────────────────

  stats(): MemoryBankStats {
    let strength = 0;
    let importance = 0;
    let entropy = 0;
    let consolidatedCount = 0;
    let oldestAt: number | null = null;
    let newestAt: number | null = null;

    for (const trace of this.traces.values()) {
      strength += trace.strength;
      importance += trace.importance;
      entropy += trace.smfEntropy;
      if (trace.consolidated) consolidatedCount += 1;
      if (oldestAt === null || trace.createdAt < oldestAt) oldestAt = trace.createdAt;
      if (newestAt === null || trace.createdAt > newestAt) newestAt = trace.createdAt;
    }

    const n = this.traces.size;
    return {
      traceCount: n,
      capacity: this.config.capacity,
      consolidatedCount,
      averageStrength: requireFinite(safeDivide(strength, n, 0), 'averageStrength'),
      averageImportance: requireFinite(safeDivide(importance, n, 0), 'averageImportance'),
      averageSmfEntropy: requireFinite(safeDivide(entropy, n, 0), 'averageSmfEntropy'),
      storeCount: this.storeCount,
      recallCount: this.recallCount,
      prunedCount: this.prunedCount,
      oldestAt,
      newestAt
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build a holographic pattern field.
   *
   * With explicit `primes` (the trace's or the query's primes) the pattern's
   * basis is exactly those primes, so every encoded prime has a wavenumber
   * slot. Without them the bank's construction-time `primes` basis is used.
   */
  private createPattern(primes?: readonly number[]): HolographicMemory {
    return new HolographicMemory({
      gridSize: this.gridSize,
      primes: primes ?? this.primeBasis
    });
  }
}
