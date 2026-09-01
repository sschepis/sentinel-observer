/**
 * Compact memory bank — the scale-oriented sibling of SemanticMemoryBank.
 *
 * Where the full bank stores a ~32 KB holographic pattern per trace, this
 * bank stores only the lean trace (content, the SMF sketch vector — width
 * configurable, q8-compact in persistence, ~1.1 KB at the 128-dim production
 * width — prime list, amplitudes) plus an inverted index (prime -> trace ids)
 * for candidate prefiltering.
 *
 * Recall ranks by three terms:
 *   - SMF cosine (the same sketch-orientation similarity as the full bank),
 *     gated by the cue moment's Kuramoto coherence — an incoherent moment
 *     has no reliable orientation, so its orientation term is deweighted;
 *   - amplitude-overlap: how strongly the cue's primes are present in the
 *     trace's stored excitation, normalized (reported under `overlapScore`);
 *  - phase order parameter (W1): traces also store the moment's phase
 *    configuration (the sparse active set), and the cue's converged phase
 *    configuration is compared as the weighted mean resultant length of the
 *    phase-DIFFERENCE ensemble — the Kuramoto order parameter of the two
 *    moments locking against each other (reported under `holographicScore`:
 *    a real reading, never a fabricated 0).
 *
 *    HONEST READING OF THE TERM: because every oscillator's phase advances
 *    at its natural frequency each tick, the phase-difference ensemble over
 *    shared primes is largely determined by the simulated time between the
 *    stored moment and the cue — R → 1 for ANY two same-prime moments close
 *    in time, and R decays with elapsed time even for identical content. The
 *    term is therefore a moment-proximity (recency-weighted lock) signal, not
 *    a content discriminator: it cannot separate same-prime different-content
 *    moments (siblings), and it systematically favors just-stored traces over
 *    older ones. Its weight (phaseWeight, default 0.15) is deliberately small;
 *    discrimination between moments rides on the SMF and overlap terms.
 *
 *   NOTE on the overlap term: the semantic signature scheme (semantic-is-a)
 *   deliberately gives SIBLINGS shared category primes, so the overlap term
 *   cannot separate siblings by construction (the H1 win / H4 cost tradeoff)
 *   — sibling discrimination rides on the SMF term alone. Nothing in this
 *   bank's pruning or recall may assume overlap-based separability.
 *
 * This is the phase-3 substrate from docs/SCALING.md: at 5,000 words the
 * full bank would hold ~160 MB of holographic patterns in a browser; the
 * compact bank holds the lean traces instead (~1.1 KB per trace SERIALIZED
 * at the 128-dim width with q8; live memory per trace is dominated by the
 * 256-prime + 256-amplitude basis arrays plus the SMF components — the SMF
 * projection matrix is lazy and never allocated inside stored traces). The
 * default capacity is deck-scale (50,000) so a bare observer over the 20k
 * vocabulary never thrashes (W10).
 */

import { SedenionMemoryField, SMF_DIMENSION } from './SedenionMemoryField';
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
  /**
   * The stored moment's phase configuration, in radians, parallel to
   * `phasePrimes` (W1). Sparse by design: only the primes that carried
   * meaningful excitation at store time have a stored phase — the phase of
   * a quiescent oscillator is not a reading. Empty when the storing layer
   * captured no phase data (legacy traces, the full bank).
   */
  readonly phases: readonly number[];
  /** The primes whose phases `phases` holds (parallel to `phases`). */
  readonly phasePrimes: readonly number[];
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
  /**
   * Cue-side excitation amplitudes, index-aligned with `primes`. When the
   * query also carries `phases`, they gate the phase term on the cue side
   * exactly like the store side: a quiescent oscillator's phase is not a
   * reading (W1). Without them the cue is treated as excited, preserving
   * legacy callers that do not observe excitation.
   */
  amplitudes?: readonly number[];
  /**
   * The cue moment's phase configuration, aligned with `primes` by index
   * (W1). When present, recall adds the phase order parameter of the
   * phase-difference ensemble — how well the cue's moment phase-locks with
   * each trace's stored moment — under `phaseWeight`.
   */
  phases?: readonly number[];
  /**
   * The cue moment's Kuramoto coherence in [0, 1]. When present it gates
   * the SMF term: an incoherent moment's orientation is deweighted toward
   * half strength, a fully coherent moment keeps its full weight.
   */
  coherence?: number;
}

export interface RecallResultLike<TTrace extends TraceLike = TraceLike> {
  trace: TTrace;
  score: number;
  smfScore: number;
  /** Prime-amplitude overlap in [0, 1] (compact banks; 0 for the full bank). */
  overlapScore: number;
  /**
   * The phase order parameter of the cue-vs-stored phase-difference
   * ensemble, in [0, 1] — real in the compact bank since W1 (0 only when
   * either side carries no phase data).
   */
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
  /**
   * The stored moment's phase configuration (W1): `phasePrimes` names the
   * primes, `phases` their phases in radians. Absent = legacy trace.
   */
  phasePrimes?: number[];
  phases?: number[];
  createdAt: number;
  lastAccessAt: number;
  accessCount: number;
  strength: number;
  importance: number;
  consolidated: boolean;
  smfEntropy: number;
  metadata: Record<string, unknown>;
  bank?: 'compact';
  /** When present, `smf` holds q8 fixed-point integers (dequantized on
   *  restore) instead of float components — the wide-sketch footprint lever. */
  smfEncoding?: 'q8';
  /** Max absolute component used to scale the q8 fixed-point encoding. */
  smfMax?: number;
  /** P11: grade-evidence utility extra, restored so usefulness survives. */
  utilityExtra?: number;
}

/** The surface SemanticObserver and the teacher depend on. */
export interface MemoryBank {
  readonly size: number;
  readonly capacity: number;
  store(
    content: string,
    smf: SedenionMemoryField,
    primes: readonly number[],
    options?: { amplitudes?: readonly number[]; phases?: readonly number[]; importance?: number; metadata?: Record<string, unknown> }
  ): TraceLike;
  recall(query: RecallQuery, topK?: number): RecallResultLike[];
  get(id: string): TraceLike | undefined;
  all(): readonly TraceLike[];
  serializeTrace(traceId: string): SerializedTraceData | null;
  restoreTrace(data: SerializedTraceData): TraceLike | null;
  /**
   * Adjust a trace's strength by `amount` (positive = reinforce, negative =
   * weaken) and refresh its access bookkeeping, as if it had been practiced.
   * Returns false when the trace does not exist.
   */
  reinforce(traceId: string, amount?: number): boolean;
  /** P11: accumulate grade evidence for a trace (retrieval usefulness). */
  bumpUtility(traceId: string, amount: number): void;
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
  /** Maximum resident traces (default 50000 — deck scale, W10). */
  capacity?: number;
  /** Weight of the SMF cosine term (default 0.5). */
  smfWeight?: number;
  /** Weight of the amplitude-overlap term (default 0.5). */
  overlapWeight?: number;
  /** Weight of the phase order-parameter term (W1, default 0.15). */
  phaseWeight?: number;
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
  /**
   * SKETCH CENTERING (default false — the honest control).
   *
   * Measured on the real deck: the corpus mean sketch carries ~75% of a
   * typical trace's magnitude, so unrelated traces sit at ~0.30 cosine
   * instead of ~0.08. That shared offset compresses the usable range of
   * the SMF term and starves the identity gate. With centering on, the
   * cosine is taken between (cue - mean) and (trace - mean): a READOUT
   * change only — nothing about storage or persistence changes, so
   * existing bootstrap records keep working.
   */
  centerSketches?: boolean;
}

const COMPACT_DEFAULTS = {
  // Deck-scale default: the 20k-word vocabulary plus conversations, creative
  // answers, gaps, and beliefs MUST fit without thrashing — a default of
  // 5000 against a 20k deck pruned 75% of everything a bare observer stored
  // (W10). The production config sets the same value explicitly.
  capacity: 50000,
  smfWeight: 0.5,
  overlapWeight: 0.5,
  phaseWeight: 0.15,
  indexThreshold: 1e-4,
  pruneStrength: 0.25,
  minAccessCount: 3,
  minLockStrength: 0.7,
  entropyLockThreshold: 0.9,
  centerSketches: false
};

// ── P11 UTILITY-BASED PRUNING ───────────────────────────────────────────────
// Retrieval usefulness, not raw strength: a frequently-retrieved weak trace
// outlives a never-retrieved strong one. The score combines retrieval
// frequency (accessCount, log-scaled), recency (the strongest usefulness
// predictor), the stored importance, the retention strength (the scheduler's
// prediction), and the grade-evidence extra (graded-correct answers bump it).

const UTILITY_ACCESS_SCALE = 20;
const UTILITY_RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const UTILITY_EXTRA_SCALE = 5;

/**
 * The retrieval-usefulness score of a trace, in [0, 1]. Pure and
 * deterministic — the prune order is `traceUtility` ascending.
 */
export function traceUtility(
  trace: Pick<TraceLike, 'accessCount' | 'importance' | 'strength' | 'lastAccessAt'>,
  now: number,
  extra = 0
): number {
  const access = Math.min(1, Math.log2(1 + trace.accessCount) / Math.log2(1 + UTILITY_ACCESS_SCALE));
  const elapsed = Math.max(0, now - trace.lastAccessAt);
  const recency = Math.pow(0.5, elapsed / UTILITY_RECENCY_HALF_LIFE_MS);
  const graded = Math.min(1, Math.max(0, extra) / UTILITY_EXTRA_SCALE);
  return (
    0.35 * access +
    0.3 * recency +
    0.2 * clampRange(trace.importance, 0, 1) +
    0.1 * clampRange(trace.strength, 0, 1) +
    0.05 * graded
  );
}

/** (v - mean) normalized to unit length; a zero result stays zero. */
function centerAndNormalize(vector: readonly number[], mean: Float64Array): Float64Array {
  const out = new Float64Array(vector.length);
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const value = vector[i] - (mean[i] ?? 0);
    out[i] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-12) return out;
  for (let i = 0; i < out.length; i += 1) out[i] /= norm;
  return out;
}

/** Cosine of two unit vectors, clamped to [0, 1]: a below-average-similarity
 *  trace is simply "not similar" — the score keeps its [0,1] semantics. */
function centeredCosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i];
  return dot < 0 ? 0 : dot > 1 ? 1 : dot;
}

export class CompactMemoryBank implements MemoryBank {
  private readonly traces = new Map<string, CompactTrace>();
  private readonly index = new Map<number, Set<string>>();
  private readonly config: Required<CompactMemoryBankOptions>;
  private storeCounter = 0;
  private recallCounter = 0;
  private prunedCounter = 0;
  /** P11: grade-evidence extras (graded-correct answers), per trace id. */
  private readonly utilityExtras = new Map<string, number>();
  // ── Sketch centering state (readout only) ─────────────────────────────
  /** Running sum of stored sketch vectors (null until the first store). */
  private sketchSum: Float64Array | null = null;
  private sketchCount = 0;
  /** The mean the centered cache was built against, and its trace count —
   *  the mean is a slowly-moving statistic, refreshed when the population
   *  moved by >5% (or 8 traces), which keeps the cache stable. */
  private meanSnapshot: Float64Array | null = null;
  private meanSnapshotCount = 0;
  private readonly centeredCache = new Map<string, Float64Array>();

  constructor(options: CompactMemoryBankOptions = {}) {
    this.config = {
      ...COMPACT_DEFAULTS,
      ...options,
      // A caller passing `capacity: undefined` (the observer does when no
      // memoryCapacity is configured) must NOT defeat the default — an
      // undefined capacity would prune every new trace under utility rules.
      capacity: Math.max(1, Math.floor(options.capacity ?? COMPACT_DEFAULTS.capacity))
    };
  }

  /** Accumulate (sign +1) or remove (sign -1) a sketch from the running sum. */
  private noteSketch(smf: SedenionMemoryField, sign: 1 | -1): void {
    if (!this.config.centerSketches) return;
    const vector = smf.toArray();
    if (this.sketchSum === null) this.sketchSum = new Float64Array(vector.length);
    for (let i = 0; i < this.sketchSum.length && i < vector.length; i += 1) {
      this.sketchSum[i] += sign * vector[i];
    }
    this.sketchCount += sign;
    if (this.sketchCount < 0) this.sketchCount = 0;
  }

  /** The corpus mean sketch (null when centering is off or nothing stored).
   *  Refreshed when the population moved by >5% (or 8 traces) — the mean is
   *  a slowly-moving statistic and a stable snapshot keeps the cache warm. */
  private currentMean(): Float64Array | null {
    if (!this.config.centerSketches || this.sketchSum === null || this.sketchCount <= 0) return null;
    const drift = Math.abs(this.sketchCount - this.meanSnapshotCount);
    if (this.meanSnapshot === null || drift > Math.max(8, this.meanSnapshotCount * 0.05)) {
      const mean = new Float64Array(this.sketchSum.length);
      for (let i = 0; i < mean.length; i += 1) mean[i] = this.sketchSum[i] / this.sketchCount;
      this.meanSnapshot = mean;
      this.meanSnapshotCount = this.sketchCount;
      this.centeredCache.clear();
    }
    return this.meanSnapshot;
  }

  /** The trace's mean-centered unit sketch (cached against the current mean). */
  private centeredOf(trace: CompactTrace, mean: Float64Array): Float64Array {
    const cached = this.centeredCache.get(trace.id);
    if (cached !== undefined) return cached;
    const centered = centerAndNormalize(trace.smf.toArray(), mean);
    this.centeredCache.set(trace.id, centered);
    return centered;
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
    options: { amplitudes?: readonly number[]; phases?: readonly number[]; importance?: number; metadata?: Record<string, unknown> } = {}
  ): CompactTrace {
    const primeList = Array.from(primes);
    if (primeList.length === 0) {
      throw new Error('CompactMemoryBank.store requires at least one prime');
    }
    const amplitudes = options.amplitudes
      ? Array.from(options.amplitudes).slice(0, primeList.length)
      : primeList.map(() => 1);
    while (amplitudes.length < primeList.length) amplitudes.push(1);

    // W1: keep the moment's phase configuration SPARSELY — only primes that
    // carry meaningful excitation have a phase that is a reading. The phase
    // of a quiescent oscillator is not stored (and would be noise in the
    // phase order parameter).
    const phasePrimes: number[] = [];
    const phases: number[] = [];
    if (options.phases !== undefined) {
      for (let i = 0; i < primeList.length; i += 1) {
        const phase = options.phases[i];
        if (phase === undefined || !Number.isFinite(phase)) continue;
        if (amplitudes[i] < this.config.indexThreshold) continue;
        phasePrimes.push(primeList[i]);
        phases.push(phase);
      }
    }

    const now = Date.now();
    const trace: CompactTrace = {
      id: randomUUID(),
      content,
      smf: smf.clone(),
      primes: primeList,
      amplitudes,
      phases,
      phasePrimes,
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
    this.noteSketch(trace.smf, 1);
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
    // W1: the phase term joins the blend whenever the cue carries a phase
    // configuration — a trace without stored phases scores 0 on it (a moment
    // without a stored phase configuration cannot phase-lock with the cue).
    //
    // The cue ensemble is folded from the index-aligned query arrays BEFORE
    // the dedup `cuePrimes` performs, so a duplicate prime in the cue can
    // never misalign its phase/amplitude. The cue side is gated like the
    // store side: a quiescent oscillator's phase is not a reading, so a cue
    // prime whose live amplitude is below the index threshold is excluded
    // (absent amplitudes treat the cue as excited, preserving legacy calls).
    let cuePhasesByPrime: Map<number, number> | undefined;
    let cueAmpByPrime: Map<number, number> | undefined;
    if (useOverlap && query.phases !== undefined && query.phases.length > 0 && query.primes !== undefined) {
      cuePhasesByPrime = new Map();
      cueAmpByPrime = new Map();
      for (let i = 0; i < query.primes.length; i += 1) {
        const phase = query.phases[i];
        if (phase === undefined || !Number.isFinite(phase)) continue;
        cuePhasesByPrime.set(query.primes[i], phase);
        cueAmpByPrime.set(query.primes[i], query.amplitudes?.[i] ?? 1);
      }
    }
    const usePhase = cuePhasesByPrime !== undefined && cuePhasesByPrime.size > 0;
    // W1: the cue moment's coherence gates the orientation term — an
    // incoherent moment has no reliable orientation, so its SMF weight
    // halves at coherence 0 and reaches full at coherence 1.
    const coherence = query.coherence !== undefined && Number.isFinite(query.coherence)
      ? clampRange(query.coherence, 0, 1)
      : 1;
    const smfGate = 0.5 + 0.5 * coherence;
    const weightTotal =
      (useSmf ? this.config.smfWeight * smfGate : 0) +
      (useOverlap ? this.config.overlapWeight : 0) +
      (usePhase ? this.config.phaseWeight : 0);

    // SKETCH CENTERING (readout): the corpus mean carries most of a sketch's
    // magnitude, so the raw cosine floor sits high; centering both sides
    // restores the discriminative range. Off by default (honest control).
    const sketchMean = this.currentMean();
    const centeredCue =
      sketchMean !== null && query.smf !== undefined
        ? centerAndNormalize(query.smf.toArray(), sketchMean)
        : null;

    const scored: RecallResultLike<CompactTrace>[] = [];
    for (const trace of candidates) {
      // The trace's amplitude and phase lookups are built ONCE per candidate
      // and shared by both scorers — the recall loop never rebuilds them.
      const traceAmpByPrime = new Map<number, number>();
      let traceNormSq = 0;
      for (let i = 0; i < trace.primes.length; i += 1) {
        const amplitude = trace.amplitudes[i];
        traceAmpByPrime.set(trace.primes[i], amplitude);
        traceNormSq += amplitude * amplitude;
      }
      let tracePhaseByPrime: Map<number, number> | undefined;
      if (usePhase) {
        tracePhaseByPrime = new Map();
        for (let i = 0; i < trace.phasePrimes.length; i += 1) {
          tracePhaseByPrime.set(trace.phasePrimes[i], trace.phases[i]);
        }
      }
      const smfScore =
        useSmf && query.smf
          ? centeredCue !== null
            ? centeredCosine(centeredCue, this.centeredOf(trace, sketchMean!))
            : query.smf.coherenceWith(trace.smf)
          : 0;
      const overlapScore = useOverlap
        ? this.amplitudeOverlap(cuePrimes, traceAmpByPrime, traceNormSq)
        : 0;
      const phaseScore = usePhase
        ? this.phaseOrderParameter(cuePhasesByPrime!, cueAmpByPrime!, tracePhaseByPrime!, traceAmpByPrime)
        : 0;
      const weighted =
        (useSmf ? this.config.smfWeight * smfGate * smfScore : 0) +
        (useOverlap ? this.config.overlapWeight * overlapScore : 0) +
        (usePhase ? this.config.phaseWeight * phaseScore : 0);
      scored.push({
        trace,
        score: requireFinite(safeDivide(weighted, weightTotal, 0), 'compact-recall.score'),
        smfScore,
        overlapScore,
        holographicScore: phaseScore,
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

  reinforce(traceId: string, amount = 0.1): boolean {
    const trace = this.traces.get(traceId);
    if (!trace) return false;
    trace.strength = clampRange(trace.strength + amount, 0, 1);
    trace.lastAccessAt = Date.now();
    trace.smfEntropy = trace.smf.normalizedEntropy();
    return true;
  }

  all(): readonly CompactTrace[] {
    return [...this.traces.values()];
  }

  serializeTrace(traceId: string): SerializedTraceData | null {
    const trace = this.traces.get(traceId);
    if (!trace) return null;
    const { q, maxAbs } = SedenionMemoryField.toCompact(trace.smf.toArray());
    return {
      id: trace.id,
      content: trace.content,
      smf: q,
      primes: [...trace.primes],
      amplitudes: [...trace.amplitudes],
      phasePrimes: trace.phasePrimes.length > 0 ? [...trace.phasePrimes] : undefined,
      phases: trace.phases.length > 0 ? [...trace.phases] : undefined,
      createdAt: trace.createdAt,
      lastAccessAt: trace.lastAccessAt,
      accessCount: trace.accessCount,
      strength: trace.strength,
      importance: trace.importance,
      consolidated: trace.consolidated,
      smfEntropy: trace.smfEntropy,
      metadata: { ...trace.metadata },
      bank: 'compact',
      smfEncoding: 'q8',
      smfMax: maxAbs,
      utilityExtra: this.utilityExtras.get(trace.id) ?? undefined
    };
  }

  restoreTrace(data: SerializedTraceData): CompactTrace | null {
    const snapshot = data as {
      id?: string; content?: string; smf?: number[]; primes?: number[];
      amplitudes?: number[]; phasePrimes?: number[]; phases?: number[];
      createdAt?: number; lastAccessAt?: number;
      accessCount?: number; strength?: number; importance?: number;
      consolidated?: boolean; smfEntropy?: number; metadata?: Record<string, unknown>;
      smfEncoding?: 'q8'; smfMax?: number; utilityExtra?: number;
    } | null;
    if (snapshot === null || typeof snapshot !== 'object' || typeof snapshot.id !== 'string') return null;
    if (this.traces.has(snapshot.id)) return null;

    const primeList = Array.from(snapshot.primes ?? []);
    if (primeList.length === 0) return null;
    // Amplitudes must be finite: a NaN amplitude would leak NaN overlap and
    // phase scores to every consumer (NaN² → NaN norms, and NaN passes the
    // index-threshold guard). Non-finite entries are sanitized to 0 — the
    // prime then simply carries no excitation, mirroring the phase-pair rule.
    const amplitudes = Array.from(snapshot.amplitudes ?? []).map((a) =>
      Number.isFinite(a) ? a : 0
    );
    while (amplitudes.length < primeList.length) amplitudes.push(1);
    // W1: the stored phase configuration restores when present; a partial
    // or mismatched pair is dropped (a corrupt phase pair would poison the
    // order parameter, and 0 is the honest absence reading).
    const phasePrimes = Array.isArray(snapshot.phasePrimes) ? Array.from(snapshot.phasePrimes) : [];
    const phases = Array.isArray(snapshot.phases) ? Array.from(snapshot.phases) : [];
    const phasePairValid =
      phasePrimes.length === phases.length &&
      phases.every((phase) => Number.isFinite(phase));

    const smfValues =
      snapshot.smfEncoding === 'q8'
        ? SedenionMemoryField.fromCompact(snapshot.smf ?? [], snapshot.smfMax ?? 0)
        : snapshot.smf ?? new Array(SMF_DIMENSION).fill(0);

    const createdAt = Number.isFinite(snapshot.createdAt) ? snapshot.createdAt! : Date.now();
    const trace: CompactTrace = {
      id: snapshot.id,
      content: snapshot.content ?? '',
      smf: SedenionMemoryField.fromArray(smfValues),
      primes: primeList,
      amplitudes,
      phases: phasePairValid ? phases : [],
      phasePrimes: phasePairValid ? phasePrimes : [],
      pattern: null,
      createdAt,
      // lastAccessAt drives the retention/utility math: a non-finite value
      // would make `Date.now() - lastAccessAt` NaN and poison every sort.
      lastAccessAt: Number.isFinite(snapshot.lastAccessAt) ? snapshot.lastAccessAt! : createdAt,
      accessCount: Math.max(0, Number.isFinite(snapshot.accessCount) ? snapshot.accessCount! : 0),
      strength: clampRange(Number.isFinite(snapshot.strength) ? snapshot.strength! : 1, 0, 1),
      importance: clampRange(Number.isFinite(snapshot.importance) ? snapshot.importance! : 0.5, 0, 1),
      consolidated: snapshot.consolidated ?? false,
      smfEntropy: Number.isFinite(snapshot.smfEntropy) ? snapshot.smfEntropy! : 0,
      metadata: snapshot.metadata ? { ...snapshot.metadata } : {}
    };
    this.traces.set(trace.id, trace);
    this.noteSketch(trace.smf, 1);
    this.storeCounter += 1;
    this.indexTrace(trace);
    // P11: the grade-evidence extra survives reloads.
    if (typeof snapshot.utilityExtra === 'number' && snapshot.utilityExtra > 0) {
      this.utilityExtras.set(trace.id, snapshot.utilityExtra);
    }
    return trace;
  }

  clear(): void {
    this.traces.clear();
    this.index.clear();
    // P11: grade-evidence extras describe dead traces — dropping them with
    // the traces keeps the map bounded across resets.
    this.utilityExtras.clear();
  }

  /** Decay every unconsolidated trace's strength. Consolidated traces persist. */
  decay(rate = 0.02): void {
    const factor = 1 - clampRange(rate, 0, 1);
    for (const trace of this.traces.values()) {
      if (trace.consolidated) continue;
      trace.strength = clampRange(trace.strength * factor, 0, 1);
    }
  }

  /** Trim to capacity: least USEFUL traces first (P11). Retrieval usefulness
   *  replaces raw strength — a frequently-retrieved weak trace outlives a
   *  never-retrieved strong one. Consolidated traces are exempt until every
   *  unconsolidated trace is gone (capacity is the only forcing condition). */
  prune(): number {
    const before = this.traces.size;
    if (before <= this.config.capacity) return 0;
    const now = Date.now();
    const byUtility = (trace: CompactTrace): number =>
      traceUtility(trace, now, this.utilityExtras.get(trace.id) ?? 0);
    let removed = 0;

    // Pass 1: unconsolidated traces, least useful first.
    const unconsolidated = [...this.traces.values()]
      .filter((trace) => !trace.consolidated)
      .sort((a, b) => byUtility(a) - byUtility(b) || a.lastAccessAt - b.lastAccessAt);
    for (const trace of unconsolidated) {
      if (this.traces.size <= this.config.capacity) break;
      this.removeTrace(trace.id);
      removed += 1;
    }

    // Pass 2 (only when STILL over capacity): consolidated traces, least
    // useful first — a consolidation lock is a floor, not an immortality.
    if (this.traces.size > this.config.capacity) {
      const consolidated = [...this.traces.values()]
        .filter((trace) => trace.consolidated)
        .sort((a, b) => byUtility(a) - byUtility(b) || a.lastAccessAt - b.lastAccessAt);
      for (const trace of consolidated) {
        if (this.traces.size <= this.config.capacity) break;
        this.removeTrace(trace.id);
        removed += 1;
      }
    }

    this.prunedCounter += removed;
    return removed;
  }

  /** P11: accumulate grade evidence for a trace (graded-correct answers make
   *  it more useful to keep, whatever its raw strength says). */
  bumpUtility(traceId: string, amount: number): void {
    const current = this.utilityExtras.get(traceId) ?? 0;
    this.utilityExtras.set(traceId, Math.max(0, current + amount));
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
    const removed = this.traces.get(id);
    if (removed !== undefined) this.noteSketch(removed.smf, -1);
    this.centeredCache.delete(id);
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
   *
   * `traceAmpByPrime` and `traceNormSq` are precomputed once per candidate
   * by the recall loop and shared with the phase term.
   */
  private amplitudeOverlap(
    cuePrimes: readonly number[],
    traceAmpByPrime: Map<number, number>,
    traceNormSq: number
  ): number {
    if (cuePrimes.length === 0) return 0;
    let dot = 0;
    for (const prime of cuePrimes) {
      dot += traceAmpByPrime.get(prime) ?? 0;
    }
    if (traceNormSq <= 0) return 0;
    return Math.min(1, dot / (Math.sqrt(cuePrimes.length) * Math.sqrt(traceNormSq)));
  }

  /**
   * W1: the phase order parameter of the cue-vs-trace phase-difference
   * ensemble — the weighted mean resultant length of {φ_trace(p) − φ_cue(p)}
   * over the primes both sides excited. This is literally the Kuramoto order
   * parameter of the two moments locking against each other: R → 1 when the
   * cue's converged phase configuration matches the stored moment's (all
   * differences concentrate), R → 0 when the ensembles are unrelated. The
   * weight is the trace's amplitude at each shared prime (strongly-excited
   * oscillators count more), gated by the index threshold on both sides: the
   * trace side by its stored amplitudes, the cue side by the live amplitudes
   * the query carries (absent cue amplitudes treat the cue as excited).
   */
  private phaseOrderParameter(
    cuePhasesByPrime: Map<number, number>,
    cueAmpByPrime: Map<number, number>,
    tracePhaseByPrime: Map<number, number>,
    traceAmpByPrime: Map<number, number>
  ): number {
    if (tracePhaseByPrime.size === 0) return 0;
    let sx = 0;
    let sy = 0;
    let weightSum = 0;
    for (const [prime, cuePhase] of cuePhasesByPrime) {
      if ((cueAmpByPrime.get(prime) ?? 1) < this.config.indexThreshold) continue;
      const tracePhase = tracePhaseByPrime.get(prime);
      if (tracePhase === undefined) continue;
      const weight = traceAmpByPrime.get(prime) ?? 0;
      if (weight < this.config.indexThreshold) continue;
      const delta = tracePhase - cuePhase;
      sx += weight * Math.cos(delta);
      sy += weight * Math.sin(delta);
      weightSum += weight;
    }
    if (weightSum <= 0) return 0;
    return Math.min(1, Math.hypot(sx, sy) / weightSum);
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
