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
import type { TraceLike, MemoryBank, RecallResultLike } from './CompactMemoryBank';
import { HolographicMemory } from './HolographicMemory';
import { clampRange, requireFinite, safeDivide } from './numeric';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** A stored memory trace. */
export interface MemoryTrace extends TraceLike {
  readonly pattern: HolographicMemory;
}

/**
 * Plain-data snapshot of a trace for persistence.
 *
 * Note: oscillator PHASES are not part of a trace (they are session state);
 * a restored trace re-encodes its holographic pattern from the stored
 * amplitudes, so content, SMF, strength and identity survive exactly while
 * holographic correlation is equivalent-but-not-identical.
 */
export interface SerializedTrace {
  id: string;
  content: string;
  smf: number[];
  primes: number[];
  amplitudes: number[];
  createdAt: number;
  lastAccessAt: number;
  accessCount: number;
  strength: number;
  importance: number;
  consolidated: boolean;
  smfEntropy: number;
  metadata: Record<string, unknown>;
  /** When present, `smf` holds q8 fixed-point integers (dequantized on
   *  restore) instead of float components — the wide-sketch footprint lever. */
  smfEncoding?: 'q8';
  /** Max absolute component used to scale the q8 fixed-point encoding. */
  smfMax?: number;
  /** P11: grade-evidence utility extra, restored so usefulness survives. */
  utilityExtra?: number;
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
  trace: TraceLike;
  /** Combined weighted score. */
  score: number;
  /** SMF cosine similarity in [-1, 1]. */
  smfScore: number;
  /** Phase-aware holographic correlation in [-1, 1]. */
  holographicScore: number;
  /** Prime-amplitude overlap in [0, 1] (0 for the full bank). */
  overlapScore: number;
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
  /** Weight of the SMF term in the combined score (default 0.4). */
  smfWeight?: number;
  /** Weight of the holographic term in the combined score (default 0.6). */
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
  // 0.4/0.6: the fold-era 0.6 SMF weight let the signed-random-projection
  // sketch's (decorrelated) orientation noise tip recognitions. The
  // holographic term is the strong exact-prime signal; SMF stays a
  // subordinate context cue (measured: 53.3% -> 100% on the 30-word gate).
  smfWeight: 0.4,
  holographicWeight: 0.6,
  minStrength: 0.25,
  importanceFloor: 0.7,
  entropyLockThreshold: 0.75,
  minAccessCount: 3,
  minLockStrength: 0.5
} as const;

export class SemanticMemoryBank implements MemoryBank {
  private readonly traces = new Map<string, MemoryTrace>();
  /** P11: grade-evidence extras (graded-correct answers), per trace id. */
  private readonly utilityExtras = new Map<string, number>();
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

  /** Adjust a trace's strength (positive = reinforce, negative = weaken). */
  reinforce(traceId: string, amount = 0.1): boolean {
    const trace = this.traces.get(traceId);
    if (!trace) return false;
    trace.strength = clampRange(trace.strength + amount, 0, 1);
    trace.lastAccessAt = Date.now();
    trace.smfEntropy = trace.smf.normalizedEntropy();
    return true;
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
      // The full bank encodes phases into the holographic pattern itself
      // (W1: `pattern.encode(primes, amplitudes, phases)`); the trace-level
      // sparse phase pair is the compact bank's representation and stays
      // empty here.
      phases: [],
      phasePrimes: [],
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
    // primes is invalid by construction. The dedup is ZIP-ALIGNED: phase and
    // amplitude travel with their prime (first occurrence wins), so a caller
    // passing duplicates with index-aligned arrays can never have its phase
    // mispaired against the deduplicated prime list.
    const cueTriples: { prime: number; amplitude: number; phase: number | undefined }[] = [];
    if (query.primes !== undefined) {
      const seen = new Set<number>();
      for (let i = 0; i < query.primes.length; i += 1) {
        const prime = query.primes[i];
        if (seen.has(prime)) continue;
        seen.add(prime);
        cueTriples.push({
          prime,
          amplitude: query.amplitudes?.[i] ?? 1,
          phase: query.phases?.[i]
        });
      }
    }
    const cuePrimes = cueTriples.length > 0 ? cueTriples.map((t) => t.prime) : undefined;

    let queryPattern: HolographicMemory | null = null;
    if (cuePrimes && cuePrimes.length > 0) {
      const amplitudes = cueTriples.map((t) => t.amplitude);
      // Zip-aligned with cuePrimes; encode() treats any non-finite entry as 0.
      const phases = cueTriples.some((t) => t.phase !== undefined)
        ? (cueTriples.map((t) => t.phase) as number[])
        : undefined;
      queryPattern = this.createPattern(cuePrimes);
      queryPattern.encode(cuePrimes, amplitudes, phases);
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
        overlapScore: 0,
        consolidated: trace.consolidated
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, limit);

    // Accessing a trace reinforces it and re-evaluates consolidation with the
    // trace's REAL entropy.
    for (const hit of hits) this.touch(hit.trace as MemoryTrace);
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
    // P11: grade-evidence extras describe dead traces — drop them with the
    // traces so the map stays bounded across resets.
    this.utilityExtras.clear();
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
  // Persistence
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Plain-data snapshot of a trace for persistence.
   *
   * Note: oscillator PHASES are not part of a trace (they are session
   * state); a restored trace re-encodes its holographic pattern from the
   * stored amplitudes, so content, SMF, strength and identity survive
   * exactly while holographic correlation is equivalent-but-not-identical.
   */
  serializeTrace(traceId: string): SerializedTrace | null {
    const trace = this.traces.get(traceId);
    if (!trace) return null;
    const { q, maxAbs } = SedenionMemoryField.toCompact(trace.smf.toArray());
    return {
      id: trace.id,
      content: trace.content,
      smf: q,
      primes: [...trace.primes],
      amplitudes: [...trace.amplitudes],
      createdAt: trace.createdAt,
      lastAccessAt: trace.lastAccessAt,
      accessCount: trace.accessCount,
      strength: trace.strength,
      importance: trace.importance,
      consolidated: trace.consolidated,
      smfEntropy: trace.smfEntropy,
      metadata: { ...trace.metadata },
      smfEncoding: 'q8',
      smfMax: maxAbs,
      utilityExtra: this.utilityExtras.get(trace.id) ?? undefined
    };
  }

  /**
   * Recreate a trace from a serialized snapshot (same id, content, SMF,
   * strength and counters). Returns null when the id already exists — the
   * bank never silently overwrites a live trace with stale data.
   */
  restoreTrace(data: SerializedTrace): MemoryTrace | null {
    // Malformed payloads are refused like the compact bank does — a partial
    // snapshot must not crash the restore path with a raw TypeError.
    if (
      data === null ||
      typeof data !== 'object' ||
      typeof data.id !== 'string' ||
      data.id.length === 0 ||
      !Array.isArray(data.primes) ||
      data.primes.length === 0 ||
      !Array.isArray(data.amplitudes) ||
      !Array.isArray(data.smf)
    ) {
      return null;
    }
    if (this.traces.has(data.id)) return null;
    const primeList = Array.from(data.primes);
    if (primeList.length === 0) return null;

    const pattern = this.createPattern(primeList);
    // Non-finite amplitudes sanitized to 0 (they would leak NaN into every
    // pattern correlation); finite fields validated like the compact bank.
    const amplitudes = Array.from(data.amplitudes).map((a) =>
      Number.isFinite(a) ? a : 0
    );
    while (amplitudes.length < primeList.length) amplitudes.push(1);
    pattern.encode(primeList, amplitudes.slice(0, primeList.length));

    const smfValues =
      data.smfEncoding === 'q8'
        ? SedenionMemoryField.fromCompact(data.smf, data.smfMax ?? 0)
        : data.smf;

    // Timestamps and counters drive the prune's retentionScore
    // (`Date.now() - lastAccessAt`): a missing or non-finite lastAccessAt
    // would make the next capacity trim crash with NaN arithmetic instead of
    // refusing loudly at the restore site.
    const createdAt = Number.isFinite(data.createdAt) ? data.createdAt : Date.now();
    const trace: MemoryTrace = {
      id: data.id,
      content: data.content,
      smf: SedenionMemoryField.fromArray(smfValues),
      primes: primeList,
      amplitudes,
      phases: [],
      phasePrimes: [],
      pattern,
      createdAt,
      lastAccessAt: Number.isFinite(data.lastAccessAt) ? data.lastAccessAt : createdAt,
      accessCount: Math.max(0, Number.isFinite(data.accessCount) ? data.accessCount : 0),
      strength: clampRange(Number.isFinite(data.strength) ? data.strength : 1, 0, 1),
      importance: clampRange(Number.isFinite(data.importance) ? data.importance : 0.5, 0, 1),
      consolidated: data.consolidated ?? false,
      smfEntropy: Number.isFinite(data.smfEntropy) ? data.smfEntropy : 0,
      metadata: { ...(data.metadata ?? {}) }
    };
    this.traces.set(trace.id, trace);
    this.storeCount += 1;
    // P11: the grade-evidence extra survives reloads.
    if (typeof data.utilityExtra === 'number' && data.utilityExtra > 0) {
      this.utilityExtras.set(trace.id, data.utilityExtra);
    }
    return trace;
  }

  /** P11: accumulate grade evidence for a trace (retrieval usefulness). */
  bumpUtility(traceId: string, amount: number): void {
    const current = this.utilityExtras.get(traceId) ?? 0;
    this.utilityExtras.set(traceId, Math.max(0, current + amount));
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
