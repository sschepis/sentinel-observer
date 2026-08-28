/**
 * Compact memory bank — the scale-oriented sibling of SemanticMemoryBank.
 *
 * Where the full bank stores a ~32 KB holographic pattern per trace, this
 * bank stores only the lean trace (~400 bytes: content, 16-dim SMF vector,
 * prime list, amplitudes) plus an inverted index (prime -> trace ids) for
 * candidate prefiltering.
 *
 * Recall ranks by two terms:
 *   - SMF cosine (the same 16-dim orientation similarity as the full bank)
 *   - amplitude-overlap: how strongly the cue's primes are present in the
 *     trace's stored excitation, normalized — the lean replacement for the
 *     per-trace holographic correlation (reported under `overlapScore`;
 *     `holographicScore` is 0 here, never a fabricated correlation).
 *
 * This is the phase-3 substrate from docs/SCALING.md: at 5,000 words the
 * full bank would hold ~160 MB of patterns in a browser; the compact bank
 * holds ~2 MB.
 */

import { SedenionMemoryField } from './SedenionMemoryField';
import { clampRange, requireFinite, safeDivide } from './numeric';
import { randomUUID } from '../common/random';

// ────────────────────────────────────────────────────────────────────────────
// Shared shapes
// ────────────────────────────────────────────────────────────────────────────

/** The fields every memory trace has, regardless of bank kind. */
export interface TraceLike {
  readonly id: string;
  readonly content: string;
  readonly smf: SedenionMemoryField;
  readonly primes: readonly number[];
  readonly amplitudes: readonly number[];
  readonly createdAt: number;
  lastAccessAt: number;
  accessCount: number;
  strength: number;
  importance: number;
  consolidated: boolean;
  smfEntropy: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RecallQuery {
  smf?: SedenionMemoryField;
  primes?: readonly number[];
  amplitudes?: readonly number[];
  phases?: readonly number[];
}

export interface RecallResultLike<TTrace extends TraceLike = TraceLike> {
  trace: TTrace;
  score: number;
  smfScore: number;
  /** Prime-amplitude overlap in [0, 1] (compact banks; 0 for the full bank). */
  overlapScore: number;
  holographicScore: number;
  consolidated: boolean;
}

/**
 * The persistence shape shared by both banks: the full bank's serialized
 * trace plus an optional 'compact' marker. Either bank restores either shape.
 */
export interface SerializedTraceData {
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
  bank?: 'compact';
}

/** The surface SemanticObserver and the teacher depend on. */
export interface MemoryBank {
  readonly size: number;
  readonly capacity: number;
  store(
    content: string,
    smf: SedenionMemoryField,
    primes: readonly number[],
    options?: { amplitudes?: readonly number[]; importance?: number; metadata?: Record<string, unknown> }
  ): TraceLike;
  recall(query: RecallQuery, topK?: number): RecallResultLike[];
  get(id: string): TraceLike | undefined;
  all(): readonly TraceLike[];
  serializeTrace(traceId: string): SerializedTraceData | null;
  restoreTrace(data: SerializedTraceData): TraceLike | null;
  clear(): void;
  setCapacity(capacity: number): void;
  stats(): { traceCount: number; capacity: number; consolidatedCount: number; storeCount: number; recallCount: number; prunedCount: number };
}

// ────────────────────────────────────────────────────────────────────────────
// Compact bank
// ────────────────────────────────────────────────────────────────────────────

export interface CompactTrace extends TraceLike {
  readonly pattern: null;
}

export interface CompactMemoryBankOptions {
  /** Maximum resident traces (default 5000). */
  capacity?: number;
  /** Weight of the SMF cosine term (default 0.5). */
  smfWeight?: number;
  /** Weight of the amplitude-overlap term (default 0.5). */
  overlapWeight?: number;
  /** Amplitude below which a prime is not indexed (default 1e-4). */
  indexThreshold?: number;
  /** Strength below which an unconsolidated trace is prunable (default 0.25). */
  pruneStrength?: number;
  /** Access count for consolidation (default 3). */
  minAccessCount?: number;
  /** Strength floor for consolidation (default 0.7). */
  minLockStrength?: number;
  /** SMF entropy ceiling for consolidation (default 0.9). */
  entropyLockThreshold?: number;
}

const COMPACT_DEFAULTS = {
  capacity: 5000,
  smfWeight: 0.5,
  overlapWeight: 0.5,
  indexThreshold: 1e-4,
  pruneStrength: 0.25,
  minAccessCount: 3,
  minLockStrength: 0.7,
  entropyLockThreshold: 0.9
};

export class CompactMemoryBank implements MemoryBank {
  private readonly traces = new Map<string, CompactTrace>();
  private readonly index = new Map<number, Set<string>>();
  private readonly config: Required<CompactMemoryBankOptions>;
  private storeCounter = 0;
  private recallCounter = 0;
  private prunedCounter = 0;

  constructor(options: CompactMemoryBankOptions = {}) {
    this.config = { ...COMPACT_DEFAULTS, ...options };
  }

  get size(): number {
    return this.traces.size;
  }

  get capacity(): number {
    return this.config.capacity;
  }

  setCapacity(capacity: number): void {
    this.config.capacity = Math.max(1, Math.floor(capacity));
    this.pruneToCapacity();
  }

  store(
    content: string,
    smf: SedenionMemoryField,
    primes: readonly number[],
    options: { amplitudes?: readonly number[]; importance?: number; metadata?: Record<string, unknown> } = {}
  ): CompactTrace {
    const primeList = Array.from(primes);
    if (primeList.length === 0) {
      throw new Error('CompactMemoryBank.store requires at least one prime');
    }
    const amplitudes = options.amplitudes
      ? Array.from(options.amplitudes).slice(0, primeList.length)
      : primeList.map(() => 1);
    while (amplitudes.length < primeList.length) amplitudes.push(1);

    const now = Date.now();
    const trace: CompactTrace = {
      id: randomUUID(),
      content,
      smf: smf.clone(),
      primes: primeList,
      amplitudes,
      pattern: null,
      createdAt: now,
      lastAccessAt: now,
      accessCount: 0,
      strength: 1,
      importance: clampRange(options.importance ?? 0.5, 0, 1),
      consolidated: false,
      smfEntropy: smf.normalizedEntropy(),
      metadata: options.metadata ? { ...options.metadata } : {}
    };

    this.traces.set(trace.id, trace);
    this.storeCounter += 1;
    this.indexTrace(trace);
    this.pruneToCapacity();
    return trace;
  }

  /**
   * Candidate-prefiltered recall.
   *
   * Only traces whose indexed (excited) primes intersect the cue's primes
   * are scored; without a prime cue all traces are candidates. The cue with
   * no overlap anywhere yields no results rather than noise.
   */
  recall(query: RecallQuery, topK = 5): RecallResultLike<CompactTrace>[] {
    if (!query.smf && (!query.primes || query.primes.length === 0)) {
      throw new Error('CompactMemoryBank.recall requires an smf and/or primes cue');
    }
    const limit = Math.max(0, Math.floor(topK));
    if (limit === 0 || this.traces.size === 0) return [];

    this.recallCounter += 1;

    const cuePrimes = query.primes ? [...new Set(query.primes)] : undefined;
    const candidates = this.candidatesFor(cuePrimes);

    const useSmf = query.smf !== undefined;
    const useOverlap = cuePrimes !== undefined && cuePrimes.length > 0;
    const weightTotal = (useSmf ? this.config.smfWeight : 0) + (useOverlap ? this.config.overlapWeight : 0);

    const scored: RecallResultLike<CompactTrace>[] = [];
    for (const trace of candidates) {
      const smfScore = useSmf && query.smf ? query.smf.coherenceWith(trace.smf) : 0;
      const overlapScore = useOverlap ? this.amplitudeOverlap(cuePrimes, trace) : 0;
      const weighted =
        (useSmf ? this.config.smfWeight * smfScore : 0) +
        (useOverlap ? this.config.overlapWeight * overlapScore : 0);
      scored.push({
        trace,
        score: requireFinite(safeDivide(weighted, weightTotal, 0), 'compact-recall.score'),
        smfScore,
        overlapScore,
        holographicScore: 0,
        consolidated: trace.consolidated
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, limit);
    for (const hit of hits) this.touch(hit.trace);
    for (const hit of hits) hit.consolidated = hit.trace.consolidated;
    return hits;
  }

  get(id: string): CompactTrace | undefined {
    return this.traces.get(id);
  }

  all(): readonly CompactTrace[] {
    return [...this.traces.values()];
  }

  serializeTrace(traceId: string): SerializedTraceData | null {
    const trace = this.traces.get(traceId);
    if (!trace) return null;
    return {
      id: trace.id,
      content: trace.content,
      smf: trace.smf.toArray(),
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
      bank: 'compact'
    };
  }

  restoreTrace(data: SerializedTraceData): CompactTrace | null {
    const snapshot = data as {
      id?: string; content?: string; smf?: number[]; primes?: number[];
      amplitudes?: number[]; createdAt?: number; lastAccessAt?: number;
      accessCount?: number; strength?: number; importance?: number;
      consolidated?: boolean; smfEntropy?: number; metadata?: Record<string, unknown>;
    } | null;
    if (snapshot === null || typeof snapshot !== 'object' || typeof snapshot.id !== 'string') return null;
    if (this.traces.has(snapshot.id)) return null;

    const primeList = Array.from(snapshot.primes ?? []);
    if (primeList.length === 0) return null;
    const amplitudes = Array.from(snapshot.amplitudes ?? []);
    while (amplitudes.length < primeList.length) amplitudes.push(1);

    const trace: CompactTrace = {
      id: snapshot.id,
      content: snapshot.content ?? '',
      smf: SedenionMemoryField.fromArray(snapshot.smf ?? new Array(16).fill(0)),
      primes: primeList,
      amplitudes,
      pattern: null,
      createdAt: snapshot.createdAt ?? Date.now(),
      lastAccessAt: snapshot.lastAccessAt ?? snapshot.createdAt ?? Date.now(),
      accessCount: snapshot.accessCount ?? 0,
      strength: snapshot.strength ?? 1,
      importance: snapshot.importance ?? 0.5,
      consolidated: snapshot.consolidated ?? false,
      smfEntropy: snapshot.smfEntropy ?? 0,
      metadata: snapshot.metadata ? { ...snapshot.metadata } : {}
    };
    this.traces.set(trace.id, trace);
    this.storeCounter += 1;
    this.indexTrace(trace);
    return trace;
  }

  clear(): void {
    this.traces.clear();
    this.index.clear();
  }

  /** Decay every unconsolidated trace's strength. Consolidated traces persist. */
  decay(rate = 0.02): void {
    const factor = 1 - clampRange(rate, 0, 1);
    for (const trace of this.traces.values()) {
      if (trace.consolidated) continue;
      trace.strength = clampRange(trace.strength * factor, 0, 1);
    }
  }

  /** Trim to capacity: weakest unconsolidated traces first. */
  prune(): number {
    const before = this.traces.size;
    const prunable = [...this.traces.values()].filter(
      (t) => !t.consolidated && t.strength < this.config.pruneStrength
    );
    prunable.sort((a, b) => a.strength - b.strength);
    for (const trace of prunable) {
      if (this.traces.size <= this.config.capacity) break;
      this.removeTrace(trace.id);
    }
    const after = this.traces.size;
    this.prunedCounter += before - after;
    return before - after;
  }

  stats(): {
    traceCount: number;
    capacity: number;
    consolidatedCount: number;
    storeCount: number;
    recallCount: number;
    prunedCount: number;
  } {
    return {
      traceCount: this.traces.size,
      capacity: this.config.capacity,
      consolidatedCount: [...this.traces.values()].filter((t) => t.consolidated).length,
      storeCount: this.storeCounter,
      recallCount: this.recallCounter,
      prunedCount: this.prunedCounter
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private indexTrace(trace: CompactTrace): void {
    for (let i = 0; i < trace.primes.length; i++) {
      if (trace.amplitudes[i] < this.config.indexThreshold) continue;
      const prime = trace.primes[i];
      let ids = this.index.get(prime);
      if (!ids) {
        ids = new Set();
        this.index.set(prime, ids);
      }
      ids.add(trace.id);
    }
  }

  private removeTrace(id: string): void {
    const trace = this.traces.get(id);
    if (!trace) return;
    for (const prime of trace.primes) {
      const ids = this.index.get(prime);
      if (ids) {
        ids.delete(id);
        if (ids.size === 0) this.index.delete(prime);
      }
    }
    this.traces.delete(id);
  }

  private candidatesFor(cuePrimes: readonly number[] | undefined): CompactTrace[] {
    if (cuePrimes === undefined || cuePrimes.length === 0) {
      return [...this.traces.values()];
    }
    const ids = new Set<string>();
    for (const prime of cuePrimes) {
      const matches = this.index.get(prime);
      if (matches) {
        for (const id of matches) ids.add(id);
      }
    }
    const candidates: CompactTrace[] = [];
    for (const id of ids) {
      const trace = this.traces.get(id);
      if (trace) candidates.push(trace);
    }
    return candidates;
  }

  /**
   * Normalized overlap between the cue's primes and the trace's stored
   * excitation: Σ over cue primes of trace amplitude, divided by the trace's
   * amplitude norm (so traces excited on exactly the cue score ~1).
   */
  private amplitudeOverlap(cuePrimes: readonly number[], trace: CompactTrace): number {
    if (cuePrimes.length === 0) return 0;
    const byPrime = new Map<number, number>();
    for (let i = 0; i < trace.primes.length; i++) {
      byPrime.set(trace.primes[i], trace.amplitudes[i]);
    }
    let dot = 0;
    let norm = 0;
    for (let i = 0; i < trace.amplitudes.length; i++) {
      norm += trace.amplitudes[i] * trace.amplitudes[i];
    }
    for (const prime of cuePrimes) {
      dot += byPrime.get(prime) ?? 0;
    }
    if (norm <= 0) return 0;
    return Math.min(1, dot / (Math.sqrt(cuePrimes.length) * Math.sqrt(norm)));
  }

  private touch(trace: CompactTrace): void {
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

  private pruneToCapacity(): void {
    if (this.traces.size <= this.config.capacity) return;
    this.prune();
  }
}
