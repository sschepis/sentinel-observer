/**
 * Semantic Observer
 *
 * Orchestrator for the semantic engine - the "Sentient Observer" from the
 * legacy design, rebuilt on the corrected components:
 *
 *   input ──► SemanticBackend ──► PrimeOscillatorField ──► SedenionMemoryField
 *                                                    └──► HolographicMemory
 *   state  ──► SafetyMonitor (fail-closed gating)
 *   output ──► coherence-crossing "moments" on a typed Observable
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Fixes relative to `lib/sentient-core.js`
 * ──────────────────────────────────────────────────────────────────────────
 *
 * 1. The legacy observer loaded `@aleph-ai/tinyaleph` with a synchronous
 *    `require()` (crash on Node < 20.19) - see `tinyaleph.ts` for the async
 *    loader used here instead.
 * 2. `tick()` caught errors and then emitted `'error'` on a raw EventEmitter
 *    from inside the catch block. With no `'error'` listener attached (the
 *    default for `this.events`), Node terminates the process - so a single
 *    transient failure was a guaranteed crash. Here errors are published on a
 *    typed `Subject` (the `Observable` pattern in `src/common/patterns/`),
 *    which is always safe: `error()` is a no-op when nobody subscribed.
 * 3. Moments were emitted from an opaque `TemporalLayer.update()`. Here a
 *    moment is a first-class, deterministic event: the coherence line must
 *    CROSS the configured threshold going UP (previous tick below/equal,
 *    current tick above). No randomness, no hidden threshold.
 */

import { randomUUID } from '../common/random';
import type { Initializable } from '../common/types';
import { Observable, type Observer } from '../common/patterns/Observable';
import { SemanticKernel, getSharedKernel } from './tinyaleph';
import type { Stimulus, StimulusContext, StimulusResult } from './stimulus';
import { SignalStream, type ObserverSignal } from './ObserverSignals';
import {
  PrimeOscillatorField,
  phaseClusterMetrics,
  PHASE_CLUSTER_DEFAULTS,
  type OscillatorFieldState,
  type OscillatorFieldTick,
  type PhaseClusterMetrics,
  type PrimeOscillatorSnapshot
} from './PrimeOscillatorField';
import { SedenionMemoryField, SMF_DIMENSION, MAX_SMF_WIDTH } from './SedenionMemoryField';
import { SMF_AXES, type SMFAxisIndex } from '../common/types';
import { HolographicMemory } from './HolographicMemory';
import {
  SemanticMemoryBank,
  type MemoryTrace,
  type RecallResult,
  type SemanticMemoryBankOptions
} from './SemanticMemoryBank';
import {
  CompactMemoryBank,
  type CompactMemoryBankOptions,
  type MemoryBank,
  type TraceLike
} from './CompactMemoryBank';
import { ShardedMemoryBank, type ShardedMemoryBankOptions } from './ShardedMemoryBank';
import { SEVERITY_WEIGHT,
  SafetyMonitor,
  type SafetyCheckResult,
  type SafetyViolation
} from './SafetyMonitor';
import { clampRange, NonFiniteValueError, requireFinite, safeDivide } from './numeric';
import {
  ConfigurationLimitError,
  MAX_GRID_SIZE,
  MAX_PRIME_COUNT,
  SemanticObserverConfigError
} from './errors';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Which physical event counts as a MOMENT.
 *
 * - `'global-R'` (default, the honest control): the global Kuramoto order
 *   parameter over the active oscillators crosses `momentThreshold` going up.
 *   This is the historical criterion and every shipped measurement was taken
 *   under it.
 * - `'phase-clusters'`: the field enters a stable PARTIAL-synchronization
 *   (cluster / chimera) partition — see `ClusterMomentCriterionOptions`.
 *
 * MEASURED, and kept default-off as a documented control (docs/SCALING.md
 * §17): the two criteria produce IDENTICAL retrieval (mean margin +0.1351
 * both, top-1 100% both) because emission is decoupled from storage — the
 * teacher calls `storeMemory` directly and 0 moments are emitted across a
 * full training run under EITHER criterion. Worse, the cluster criterion
 * fires 54% MORE OFTEN on an UNCOUPLED (K = 0) field than on the coupled
 * one, so what it detects in this field is frequency dispersion rather than
 * locking. `'phase-clusters'` is a refused hypothesis kept as a control, not
 * a recommended setting.
 */
export type MomentCriterion = 'global-R' | 'phase-clusters';

/**
 * The cluster-structure emission criterion (`momentCriterion:
 * 'phase-clusters'`).
 *
 * A tick SATISFIES the criterion when the live phase-cluster reading
 * (`phaseClusterMetrics`, exact definition in `PrimeOscillatorField.ts`)
 * meets ALL of:
 *
 *   clusterCount >= minClusters    — at least two groups exist at all
 *   withinR      >= minWithinR     — each group is internally locked
 *   betweenR     <= maxBetweenR    — the groups sit at DIFFERENT phases
 *
 * and the partition SIGNATURE (occupied-bin pattern + cluster sizes) has been
 * identical for `stabilityTicks` consecutive satisfying ticks. Stability is
 * what separates a locked partition from oscillators drifting past each other:
 * an uncoupled ensemble sweeps through many transient partitions and holds
 * none of them.
 *
 * Emission is a RISING EDGE, exactly like the global-R crossing: the moment
 * fires on the tick the criterion becomes satisfied, not on every tick it
 * stays satisfied.
 */
export interface ClusterMomentCriterionOptions {
  /** Phase bins spanning [0, 2π) (default 12, clamped to [2, 360]). */
  phaseBins?: number;
  /** Minimum number of phase clusters (default 2). */
  minClusters?: number;
  /** Minimum size-weighted within-cluster order parameter (default 0.9). */
  minWithinR?: number;
  /** Maximum between-cluster order parameter (default 0.5). */
  maxBetweenR?: number;
  /** Consecutive ticks the partition signature must hold (default 2, min 1). */
  stabilityTicks?: number;
}

/** Resolved cluster-criterion configuration. */
export const CLUSTER_MOMENT_DEFAULTS = {
  phaseBins: PHASE_CLUSTER_DEFAULTS.phaseBins,
  minClusters: 2,
  minWithinR: 0.9,
  maxBetweenR: 0.5,
  stabilityTicks: 2
} as const;

/** Construction options. */
export interface SemanticObserverOptions {
  /** Oscillator count (default 16, matching the SMF axes). */
  primeCount?: number;
  /** Kuramoto coupling strength (default 0.45). */
  coupling?: number;
  /** Holographic grid size (default 64). */
  gridSize?: number;
  /** Coherence threshold for moment emission, in (0, 1] (default 0.85). */
  momentThreshold?: number;
  /**
   * Which physical event counts as a moment (default `'global-R'`, the
   * honest control — the historical global-Kuramoto threshold crossing).
   *
   * `'phase-clusters'` gates emission on stable PARTIAL synchronization
   * instead; `momentThreshold` is then unused. See `MomentCriterion`.
   */
  momentCriterion?: MomentCriterion;
  /**
   * Tuning for `momentCriterion: 'phase-clusters'`. Ignored under the
   * default global-R criterion.
   */
  clusterCriterion?: ClusterMomentCriterionOptions;
  /** Default integration step for `tick()` (default 0.016). */
  dt?: number;
  /** Memory bank capacity (default 256). */
  memoryCapacity?: number;
  /** Reject the field state when this is false instead of emitting a moment. */
  requireSafetyClear?: boolean;
  /** Kernel override (mainly for tests). */
  kernel?: SemanticKernel;
  /** Safety monitor override (mainly for tests). */
  safety?: SafetyMonitor;
  /** Ticks in the drift-detection trend window (default 40). */
  driftWindowTicks?: number;
  /** Minimum coherence lost over the window to count as drift (default 0.03). */
  driftDropThreshold?: number;
  /** Fraction of window steps that must be non-increasing to count as drift (default 0.75). */
  driftDecliningRatio?: number;
  /**
   * Explicit word -> primes vocabulary for the semantic backend.
   *
   * Words in this table excite EXACTLY their assigned primes (folded into
   * the field basis) instead of the backend's per-character hashing. This is
   * how a curriculum gives every word a real, auditable prime signature.
   */
  vocabulary?: Record<string, readonly number[]>;
  /**
   * SPARSE EXCITATION (default undefined = OFF, the honest control).
   *
   * When set, a stimulus excites only its top-`k` basis primes instead of
   * every prime its tokens resolve to. The selection is DETERMINISTIC and
   * CONTENT-DERIVED — never random:
   *
   *   1. weight each folded basis prime by how many of the stimulus's own
   *      token-emitted primes land on it (a prime carried by several tokens
   *      of the utterance is more central to that utterance);
   *   2. break ties by first appearance in the utterance;
   *   3. break remaining ties by the prime itself.
   *
   * The same selection runs on BOTH sides of the encoder — the excitation
   * that produces a stored trace and the cue resolution that queries it —
   * so the two arms differ in sparsity, not in symmetry.
   *
   * Note the ambient-noise drive (`observe({kind:'noise'})`) is deliberately
   * excluded: it is a basis-wide resting floor by definition, not a stimulus.
   */
  excitationTopK?: number;
  /**
   * Memory bank kind (default 'full').
   *
   * 'compact' stores lean traces (~400 bytes, no per-trace holograms) with
   * candidate prefiltering — the scale substrate for thousands of words.
   * 'autoshard' wraps the compact bank in the entropy-driven shard manager
   * (ShardedMemoryBank): traces partition across shards by prime-vocabulary
   * overlap so retrieval interference entropy H(T|P) is minimized — the
   * fix for paraphrase-colliding cues ("good morning" / "good evening").
   * Same recall semantics per shard; only the candidate set narrows.
   */
  memoryMode?: 'full' | 'compact' | 'autoshard';
  /**
   * Optional tuning for the memory bank (weights, thresholds, capacity).
   * Passed through to whichever bank `memoryMode` selects.
   */
  memoryBankOptions?: Partial<CompactMemoryBankOptions & ShardedMemoryBankOptions & SemanticMemoryBankOptions>;
  /**
   * SMF sketch width (default 16 = the named SMF_AXES). Wider sketches spread
   * the orientation's discrimination across more dimensions; the first 16
   * components stay the named axes.
   */
  smfWidth?: number;
  /**
   * Imprint via the seeded signed random projection instead of the legacy
   * `axis = j mod width` fold (default true). Disabling restores the fold for
   * A/B measurement of the projection's effect.
   */
  smfProjection?: boolean;
  /** Determinism seed for the SMF projection matrix (default 0x5eed). */
  smfProjectionSeed?: number;
  /** Non-zero density of the SMF projection rows in (0, 1] (default 1). */
  smfProjectionDensity?: number;

  // ── COMPETITION in the oscillator field (P12) ────────────────────────
  // Purely positive Kuramoto coupling locks everything to everything: the
  // field's stable state is ONE global mode, every stored trace carries the
  // whole basis, and the discriminating signal is a small residual on a
  // shared component. These knobs let primes compete instead. All default
  // to OFF, which is the honest control, and at their defaults the field
  // evolves bit-identically to the uncompeted engine.
  // See `PrimeOscillatorFieldOptions` for the exact mechanics.

  /**
   * (a) DIVISIVE NORMALIZATION: total per-tick excitation budget the primes
   * compete for (0 = off). Amplitudes are rescaled by `budget / Σaⱼ`
   * whenever the field exceeds the budget.
   */
  activationBudget?: number;
  /**
   * (b) INHIBITORY COUPLING between unrelated (non-co-excited) primes, in
   * [0, 1] (0 = off, the control). The cross-group Kuramoto weight is
   * `1 − 2·inhibition`: 0.5 decouples the groups, 1 makes locking one group
   * actively push the rest into anti-phase.
   */
  inhibition?: number;
  /**
   * (c) k-WINNER-TAKE-ALL: keep only the `k` largest amplitudes each tick
   * (0 = off). Deterministic ties (amplitude desc, index asc).
   */
  winnerTakeAll?: number;
}

/** A coherence-driven moment. */
export interface SemanticMoment {
  id: string;
  /** Index of the tick on which the threshold was crossed. */
  tick: number;
  /** Simulated time at crossing. */
  time: number;
  /** Coherence at crossing. */
  coherence: number;
  /** Coherence on the previous tick. */
  previousCoherence: number;
  /** The configured threshold that was crossed. */
  threshold: number;
  /** Oscillator-derived metrics at crossing. */
  field: OscillatorFieldState;
  /** SMF orientation snapshot at crossing. */
  smf: number[];
  /** Safety verdict for the crossing tick. */
  safety: SafetyCheckResult;
  /**
   * Which criterion produced this moment. Present on every moment so the two
   * emission regimes can be told apart in a mixed recording.
   */
  criterion: MomentCriterion;
  /**
   * The phase-cluster structure at emission. Read-only and computed ONLY on
   * the tick a moment actually fires, so recording it costs the control
   * nothing and cannot influence which ticks emit.
   */
  clusters: PhaseClusterMetrics;
}

/** Aggregate observer state. */
export interface SemanticObserverState {
  tickCount: number;
  time: number;
  coherence: number;
  entropy: number;
  orderParameter: number;
  smf: number[];
  /** Normalized SMF entropy in [0, 1]. */
  smfNormalizedEntropy: number;
  holographicEnergy: number;
  holographicEntropy: number;
  /** Holographic similarity to the previous tick's encoding, in [-1, 1]. */
  holographicDrift: number;
  activePrimes: readonly number[];
  activePrimeCount: number;
  totalAmplitude: number;
  momentCount: number;
  lastMomentId: string | null;
  memoryTraceCount: number;
  /** null until the first tick. */
  safety: SafetyCheckResult | null;
  /** Loader diagnostics for the tinyaleph dependency. */
  kernel: { loaded: boolean; degraded: boolean };
}

/** Events emitted by `tick()`. */
export interface SemanticObserverTickEvent {
  tick: number;
  time: number;
  metrics: OscillatorFieldTick;
  smfNormalizedEntropy: number;
  /** Holographic similarity to the previous tick's encoding, in [-1, 1]. */
  holographicDrift: number;
  safety: SafetyCheckResult | null;
  moment: SemanticMoment | null;
}

/** Input that was accepted by `processInput`. */
export type SemanticInput = string | readonly number[];

// ═══════════════════════════════════════════════════════════════════════════
// OBSERVER
// ═══════════════════════════════════════════════════════════════════════════

export class SemanticObserver implements Initializable {
  private readonly kernel: SemanticKernel;
  private readonly options: Omit<
    Required<
      Omit<
        SemanticObserverOptions,
        | 'kernel'
        | 'safety'
        | 'vocabulary'
        | 'excitationTopK'
        | 'memoryMode'
        | 'memoryCapacity'
        | 'memoryBankOptions'
        | 'smfProjectionSeed'
        | 'smfProjectionDensity'
        | 'clusterCriterion'
      >
    >,
    never
  > & { memoryCapacity: number | undefined; safety?: SafetyMonitor };
  private readonly vocabulary: Readonly<Record<string, readonly number[]>>;
  /**
   * Sparse-excitation budget, or null when the option is off (the control).
   * Read from the raw options like `memoryMode` — it is not defaulted into
   * `this.options`, so "unset" stays distinguishable from "set to the basis
   * size".
   */
  private readonly excitationTopK: number | null;

  private readonly field: PrimeOscillatorField;
  private readonly smf: SedenionMemoryField;
  private readonly memory: MemoryBank;
  /**
   * W1: whether the bank consumes the moment's phase configuration and
   * coherence in retrieval. The compact bank's phase ORDER PARAMETER is
   * robust to the teach/recall evolution-depth difference (it measures the
   * concentration of the differences, not their absolute values); the full
   * bank's exact pattern correlation is not — feeding it differently-evolved
   * phases would decorrelate exact cues. The full bank keeps its
   * phase-free pattern correlation, which is already phase-aware by design.
   */
  private readonly momentPhasesInRetrieval: boolean;
  private hologram: HolographicMemory;
  private previousHologram: HolographicMemory | null = null;
  private readonly safety: SafetyMonitor;

  private momentThreshold: number;
  private previousCoherence: number | null = null;
  /**
   * Cluster-criterion state (unused under the default global-R criterion):
   * the partition signature currently being held, how many consecutive ticks
   * it has held for, and whether the criterion was already satisfied on the
   * previous tick — the rising-edge memory that mirrors `previousCoherence`.
   */
  private readonly clusterCriterion: Required<ClusterMomentCriterionOptions>;
  private clusterSignature: string | null = null;
  private clusterStableTicks = 0;
  private clusterSatisfied = false;
  private tickCount = 0;
  private elapsed = 0;
  private momentCount = 0;
  private lastMomentId: string | null = null;
  private lastSafety: SafetyCheckResult | null = null;
  private initialized = false;

  // Typed observables. Unlike a raw EventEmitter, an error published with no
  // subscribers is safely discarded (see Subject.error), never a process crash.
  // IsolatedSubject additionally quarantines throwing subscribers: one broken
  // subscriber can neither block its siblings nor fail the producer's tick.
  private readonly tickEvents = new IsolatedSubject<SemanticObserverTickEvent>();
  private readonly momentEvents = new IsolatedSubject<SemanticMoment>();
  private readonly errorEvents = new IsolatedSubject<Error>();

  // ── Signal stream (typed outputs) ───────────────────────────────────────
  private readonly signals = new SignalStream();
  private lastStimulusId: string | null = null;
  private ambientLevel = 0;
  private readonly coherenceHistory: Array<{ at: number; coherence: number }> = [];
  private driftEpisodeActive = false;
  private readonly decayFlagged = new Set<string>();
  private memorySweepCounter = 0;

  constructor(options: SemanticObserverOptions = {}) {
    this.kernel = options.kernel ?? getSharedKernel();

    const rawPrimeCount = options.primeCount ?? 16;
    const rawGridSize = options.gridSize ?? 64;
    if (!Number.isFinite(rawPrimeCount)) throw new NonFiniteValueError('primeCount', rawPrimeCount);
    if (!Number.isFinite(rawGridSize)) throw new NonFiniteValueError('gridSize', rawGridSize);

    this.options = {
      primeCount: Math.max(2, Math.floor(rawPrimeCount)),
      coupling: options.coupling ?? 0.45,
      gridSize: Math.max(8, Math.floor(rawGridSize)),
      momentThreshold: options.momentThreshold ?? 0.85,
      momentCriterion: options.momentCriterion ?? 'global-R',
      driftWindowTicks: Math.max(10, Math.floor(options.driftWindowTicks ?? 40)),
      driftDropThreshold: options.driftDropThreshold ?? 0.03,
      driftDecliningRatio: options.driftDecliningRatio ?? 0.75,
      dt: options.dt ?? 0.016,
      // Undefined lets each memory bank use its own documented default
      // (compact mode scales to thousands of traces) instead of overriding
      // it with a small generic number.
      memoryCapacity: options.memoryCapacity !== undefined ? Math.max(1, Math.floor(options.memoryCapacity)) : undefined,
      smfWidth: Math.max(1, Math.floor(options.smfWidth ?? SMF_DIMENSION)),
      smfProjection: options.smfProjection ?? true,
      requireSafetyClear: options.requireSafetyClear ?? true,
      // P12 competition: raw pass-through. The field is the single place
      // these are validated, so an out-of-range knob fails loudly at
      // construction instead of being silently clamped into a different
      // experiment than the one that was requested.
      activationBudget: options.activationBudget ?? 0,
      inhibition: options.inhibition ?? 0,
      winnerTakeAll: options.winnerTakeAll ?? 0,
      safety: options.safety
    };

    // Vocabulary validation: every entry must be a finite, positive prime
    // list; garbage is refused loudly rather than silently ignored.
    const vocabulary: Record<string, readonly number[]> = {};
    if (options.vocabulary !== undefined) {
      for (const [word, primes] of Object.entries(options.vocabulary)) {
        if (!Array.isArray(primes) || primes.length === 0) {
          throw new NonFiniteValueError(`vocabulary[${word}]`, primes as never);
        }
        for (const p of primes) {
          if (!Number.isFinite(p) || p <= 0 || !Number.isInteger(p)) {
            throw new NonFiniteValueError(`vocabulary[${word}] prime`, p);
          }
        }
        vocabulary[word.toLowerCase()] = [...primes];
      }
    }
    this.vocabulary = vocabulary;

    // Sparse excitation: opt-in, and refused loudly when it is not a usable
    // budget. A silently clamped k would make the arm unreadable — the whole
    // point of the option is that the number in the report is the number the
    // encoder used.
    if (options.excitationTopK === undefined) {
      this.excitationTopK = null;
    } else {
      const k = options.excitationTopK;
      if (!Number.isFinite(k) || !Number.isInteger(k) || k < 1) {
        throw new NonFiniteValueError('excitationTopK', k);
      }
      this.excitationTopK = k;
    }

    // Upfront validation: the same rules the holographic layer enforces,
    // rejected here with typed errors instead of failing mid-run.
    if (this.options.primeCount > MAX_PRIME_COUNT) {
      throw new ConfigurationLimitError('primeCount', MAX_PRIME_COUNT, this.options.primeCount);
    }
    if (this.options.gridSize > MAX_GRID_SIZE) {
      throw new ConfigurationLimitError('gridSize', MAX_GRID_SIZE, this.options.gridSize);
    }
    if (this.options.primeCount >= this.options.gridSize) {
      throw new SemanticObserverConfigError(
        `SemanticObserver: primeCount (${this.options.primeCount}) must be smaller than ` +
          `gridSize (${this.options.gridSize}); the holographic basis needs one integer ` +
          `wavenumber per prime inside the grid`
      );
    }
    if (this.options.smfWidth > MAX_SMF_WIDTH) {
      throw new ConfigurationLimitError('smfWidth', MAX_SMF_WIDTH, this.options.smfWidth);
    }

    this.momentThreshold = clampRange(this.options.momentThreshold, Number.EPSILON, 1);

    // Cluster criterion: resolved once, bounded here, so a hot tick never
    // re-validates. Order parameters are clamped to [0, 1]; the bin count and
    // stability window are clamped by `phaseClusterMetrics` / `Math.max`.
    const cluster = options.clusterCriterion ?? {};
    this.clusterCriterion = {
      phaseBins: Math.min(360, Math.max(2, Math.floor(cluster.phaseBins ?? CLUSTER_MOMENT_DEFAULTS.phaseBins))),
      minClusters: Math.max(1, Math.floor(cluster.minClusters ?? CLUSTER_MOMENT_DEFAULTS.minClusters)),
      minWithinR: clampRange(cluster.minWithinR ?? CLUSTER_MOMENT_DEFAULTS.minWithinR, 0, 1),
      maxBetweenR: clampRange(cluster.maxBetweenR ?? CLUSTER_MOMENT_DEFAULTS.maxBetweenR, 0, 1),
      stabilityTicks: Math.max(1, Math.floor(cluster.stabilityTicks ?? CLUSTER_MOMENT_DEFAULTS.stabilityTicks))
    };
    for (const [key, value] of Object.entries(this.clusterCriterion)) {
      if (!Number.isFinite(value)) throw new NonFiniteValueError(`clusterCriterion.${key}`, value);
    }

    this.field = new PrimeOscillatorField({
      primeCount: this.options.primeCount,
      coupling: this.options.coupling,
      activationBudget: this.options.activationBudget,
      inhibition: this.options.inhibition,
      winnerTakeAll: this.options.winnerTakeAll,
      kernel: this.kernel
    });

    this.memory =
      options.memoryMode === 'compact'
        ? new CompactMemoryBank({ capacity: this.options.memoryCapacity, ...options.memoryBankOptions })
        : options.memoryMode === 'autoshard'
          ? new ShardedMemoryBank({ capacity: this.options.memoryCapacity, ...options.memoryBankOptions })
          : new SemanticMemoryBank({
              capacity: this.options.memoryCapacity,
              gridSize: this.options.gridSize,
              primes: undefined, // basis is chosen per encode call from the field primes
              ...options.memoryBankOptions
            });
    this.momentPhasesInRetrieval = options.memoryMode === 'compact' || options.memoryMode === 'autoshard';

    this.hologram = new HolographicMemory({ gridSize: this.options.gridSize });
    this.safety = options.safety ?? SafetyMonitor.forObserver();

    // The SMF sketch: width-configurable, and imprinted via the seeded JL
    // projection (the field knows the oscillator count it reads from). The
    // projection can be disabled to A/B against the legacy mod-width fold.
    this.smf = SedenionMemoryField.identity({
      width: this.options.smfWidth,
      ...(this.options.smfProjection ? { primeCount: this.options.primeCount } : {}),
      projectionSeed: options.smfProjectionSeed,
      projectionDensity: options.smfProjectionDensity
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.kernel.initialize();
    await this.field.initialize();
    this.hologram = new HolographicMemory({
      gridSize: this.options.gridSize,
      primes: this.field.primes
    });
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /** Tear down event streams. */
  dispose(): void {
    this.tickEvents.complete();
    this.momentEvents.complete();
    this.errorEvents.complete();
    this.signals.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Events
  // ─────────────────────────────────────────────────────────────────────────

  /** Per-tick metrics events (type-safe, crash-safe). */
  get ticks() {
    return this.tickEvents.asObservable();
  }

  /** Coherence-threshold crossing events. */
  get moments() {
    return this.momentEvents.asObservable();
  }

  /** Tick-level failures. Subscribe for diagnostics; unsubscribed is safe. */
  get errors() {
    return this.errorEvents.asObservable();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Input
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Feed the observer.
   *
   * `text`   -> tokenized to primes by the real `SemanticBackend`, then folded
   *             into the oscillator basis deterministically (prime rank mod N).
   * `primes` -> used as given, folded the same way.
   *
   * Excitation is silent - it only changes what the next `tick()` observes.
   *
   * @returns the primes actually excited (post-folding).
   */
  processInput(input: SemanticInput, amplitude = 0.5): number[] {
    this.requireInitialized();

    const primes = this.resolvePrimes(input);
    if (primes.length === 0) return [];

    this.field.excite(primes, amplitude);

    return primes;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stimulus interface
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Observe a typed learning stimulus and return its immediate effect.
   *
   * Every stimulus carries a unique id; subsequent signals reference it as
   * `causeId`, so an interpreter can always answer "why did this change".
   *
   * Semantics (see docs/OBSERVER_INTERFACES.md):
   * - text:      excite the content's primes
   * - attention: modulate Kuramoto coupling (focus rises, idle falls)
   * - event:     success reinforces the concept's primes and raises coupling;
   *              failure perturbs them and lowers it
   * - noise:     set the ambient drive level applied every tick
   */
  observe(stimulus: Stimulus, ctx: StimulusContext = {}): StimulusResult {
    this.requireInitialized();

    const stimulusId = randomUUID();
    const coherenceBefore = this.currentCoherence();

    let excitedPrimes: number[] = [];
    let note: string | undefined;

    switch (stimulus.kind) {
      case 'text': {
        const weight = this.normalizeWeight(stimulus.weight);
        excitedPrimes = this.resolvePrimes(stimulus.content);
        if (excitedPrimes.length > 0) this.field.excite(excitedPrimes, weight);
        break;
      }

      case 'attention': {
        this.applyAttention(stimulus.focus, stimulus.intensity);
        break;
      }

      case 'event': {
        const primes = stimulus.detail ? this.resolvePrimes(stimulus.detail) : [];
        const baseWeight = primes.length > 0 ? (stimulus.outcome === 'success' ? 0.6 : 0.4) : 0;
        if (primes.length > 0) {
          this.field.excite(primes, baseWeight);
          excitedPrimes = primes;
        }
        // Success tightens the field's follow-through; failure loosens it.
        const couplingFactor = stimulus.outcome === 'success' ? 1.15 : 0.85;
        this.applyCouplingFactor(couplingFactor);

        if (stimulus.type === 'source.ingested' || stimulus.type === 'note.created') {
          const content = stimulus.detail ?? '';
          const trace = content.length > 0 ? this.storeMemory(content) : null;
          note = trace ? `memory stored: ${trace.id}` : 'no memory stored (field quiescent)';
        }
        break;
      }

      case 'noise': {
        this.setAmbientLevel(stimulus.level);
        break;
      }
    }

    const touchedAxes = this.projectTouchedAxes();
    const coherenceAfter = this.currentCoherence();
    this.lastStimulusId = stimulusId;

    const result: StimulusResult = {
      stimulusId,
      kind: stimulus.kind,
      excitedPrimes: [...new Set(excitedPrimes)],
      touchedAxes,
      coherenceDelta: coherenceAfter - coherenceBefore,
      activePrimeCount: this.field.getState().activePrimes.length,
      ...(note !== undefined ? { note } : {})
    };

    this.signals.push({
      kind: 'stimulus',
      at: Date.now(),
      causeId: ctx.causeId ?? null,
      payload: { stimulusId, stimulus }
    });

    return result;
  }

  /**
   * The observer's signal stream: metrics, insights, drift warnings, and
   * memory lifecycle events, each with its causal stimulus id.
   */
  getSignals(): SignalStream {
    return this.signals;
  }

  /** Id of the most recent stimulus (null when nothing has been observed). */
  getLastStimulusId(): string | null {
    return this.lastStimulusId;
  }

  /** Set the ambient drive level applied every tick (resting baseline). */
  setNoiseLevel(level: number): void {
    if (!Number.isFinite(level) || level < 0) {
      throw new NonFiniteValueError('noise level', level);
    }
    this.ambientLevel = level;
  }

  // ── stimulus internals ───────────────────────────────────────────────────

  private currentCoherence(): number {
    // getState() recomputes metrics from the live field; getMetrics() returns
    // the value cached at the last tick, which observe() never advances.
    const state = this.field.getState();
    return state.totalAmplitude > 0 ? state.coherence : 0;
  }

  private normalizeWeight(weight: number | undefined): number {
    if (weight === undefined) return 0.5;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new NonFiniteValueError('stimulus weight', weight);
    }
    return Math.min(weight, 1);
  }

  private applyAttention(focus: 'reading' | 'review' | 'quiz' | 'idle', intensity: number): void {
    if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
      throw new NonFiniteValueError('attention intensity', intensity);
    }
    const kindFactor: Record<string, number> = { reading: 1, review: 0.9, quiz: 1.1, idle: 0.3 };
    const factor = kindFactor[focus] * (0.5 + 0.5 * intensity);
    this.applyCouplingFactor(factor);
  }

  /** Set coupling relative to the configured base coupling, clamped safely. */
  private applyCouplingFactor(factor: number): void {
    const base = this.options.coupling;
    const next = Math.max(0.01, Math.min(base * 4, base * factor));
    this.field.setCoupling(next);
  }

  private setAmbientLevel(level: number): void {
    this.setNoiseLevel(level);
  }

  /**
   * Project which SMF axes the next tick's imprint would move.
   *
   * Computed on a CLONE: observing is side-effect free for the SMF, and the
   * projection uses exactly the imprint math the next tick applies.
   */
  private projectTouchedAxes(): string[] {
    const projection = this.smf.clone();
    projection.updateFromPrimeActivity(this.field.getState());
    const touched: string[] = [];
    for (let i = 0; i < projection.width; i++) {
      if (Math.abs(projection.get(i) - this.smf.get(i)) > 1e-9) {
        touched.push(i < SMF_DIMENSION ? SMF_AXES[i as SMFAxisIndex].name : `axis:${i}`);
      }
    }
    return touched;
  }

  /**
   * Store the current orientation as a memory trace.
   * Returns the created trace (null when the field is quiescent).
   *
   * W1: the moment's phase configuration is stored with the trace — the
   * observer's own phase participates in its measurement, so recall can
   * later ask how well the cue's converged moment phase-locks with this
   * stored moment (the phase order parameter of the difference ensemble).
   */
  storeMemory(content: string, options: { metadata?: Record<string, unknown> } = {}): TraceLike | null {
    this.requireInitialized();
    const state = this.field.getState();
    if (state.totalAmplitude <= 0) return null;

    const amplitudes = this.memoryPatternAmplitudes(state);
    const trace = this.memory.store(content, this.smf.clone(), this.field.primes, {
      amplitudes,
      // W1: the compact bank stores the moment's phase configuration (state.phases
      // is indexed by oscillator = by basis prime, exactly the alignment
      // `trace.primes` — the full basis — expects). The full bank encodes
      // phases into its holographic pattern only when the caller provides
      // them; it does not, so its behavior is unchanged.
      ...(this.momentPhasesInRetrieval ? { phases: state.phases } : {}),
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {})
    });
    this.signals.push({
      kind: 'memory',
      at: Date.now(),
      causeId: this.lastStimulusId,
      payload: { event: 'stored', traceId: trace.id, content }
    });
    return trace;
  }

  /**
   * Similarity search over stored traces, on the current orientation.
   * Returns [] when no memories are stored.
   *
   * `content` is resolved to a prime cue against a TRANSIENT projection: the
   * oscillator field is never excited by a recall, so querying memory cannot
   * change what the next `tick()` observes.
   *
   * W1: the cue carries the field's CURRENT phase configuration (aligned to
   * the resolved cue primes) and the moment's Kuramoto coherence, so the
   * compact bank's phase order parameter and the coherence gate on the SMF
   * term are fed by the live field.
   */
  recallMemory(content?: string, topK = 5): RecallResult[] {
    this.requireInitialized();
    const folded = content ? this.resolvePrimes(content) : undefined;
    const queryPrimes = folded ? folded.filter(p => p > 0) : undefined;
    // W1 (compact bank only): the cue carries the field's CURRENT phase
    // configuration (aligned to the resolved cue primes) and the moment's
    // Kuramoto coherence, so the phase order parameter and the coherence
    // gate on the SMF term are fed by the live field. The live amplitudes
    // ride along so the bank can gate the cue side of the phase ensemble
    // like the store side — a quiescent oscillator's phase is not a reading.
    // The full bank keeps its exact pattern correlation phase-free at the
    // query side.
    let queryPhases: number[] | undefined;
    let queryAmplitudes: number[] | undefined;
    let queryCoherence: number | undefined;
    if (this.momentPhasesInRetrieval) {
      const state = this.field.getState();
      queryPhases =
        queryPrimes !== undefined && queryPrimes.length > 0
          ? queryPrimes.map(p => {
              const index = this.field.indexOfPrime(p);
              return index >= 0 ? state.phases[index] : 0;
            })
          : undefined;
      queryAmplitudes =
        queryPrimes !== undefined && queryPrimes.length > 0
          ? queryPrimes.map(p => {
              const index = this.field.indexOfPrime(p);
              return index >= 0 ? state.amplitudes[index] : 0;
            })
          : undefined;
      queryCoherence = state.coherence;
    }
    const results = this.memory.recall(
      {
        smf: this.smf.clone(),
        primes: queryPrimes,
        phases: queryPhases,
        amplitudes: queryAmplitudes,
        coherence: queryCoherence
      },
      topK
    );
    for (const result of results) {
      if (result.consolidated) {
        this.signals.push({
          kind: 'memory',
          at: Date.now(),
          causeId: this.lastStimulusId,
          payload: { event: 'consolidated', traceId: result.trace.id, content: result.trace.content, strength: result.trace.strength }
        });
      }
    }
    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Main loop
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Advance the system by one integration step.
   *
   * Ordering: oscillators -> SMF imprint -> holographic encode/evolve ->
   * safety gate -> moment detection -> memory reinforce. Returns the emitted
   * event (with `moment === null` when no threshold was crossed).
   *
   * The tick is ATOMIC: every piece of mutable state it touches is snapshotted
   * first, and a mid-tick failure rolls the observer back to that snapshot
   * before the error is published and rethrown. A failed tick therefore
   * leaves no partial mutation behind.
   */
  tick(dt?: number): SemanticObserverTickEvent {
    this.requireInitialized();

    // Atomicity snapshot: declared before the try so the catch can see it.
    // All captures are read-only; when they are null the tick failed before
    // any mutation and the rollback is skipped.
    let fieldSnapshot: PrimeOscillatorSnapshot | null = null;
    let smfSnapshot: number[] | null = null;
    let hologramSnapshot: HolographicMemory | null = null;
    let previousHologramSnapshot: HolographicMemory | null = null;
    let tickCountSnapshot = 0;
    let elapsedSnapshot = 0;
    let previousCoherenceSnapshot: number | null = null;
    let clusterSignatureSnapshot: string | null = null;
    let clusterStableTicksSnapshot = 0;
    let clusterSatisfiedSnapshot = false;
    let momentCountSnapshot = 0;
    let lastMomentIdSnapshot: string | null = null;
    let lastSafetySnapshot: SafetyCheckResult | null = null;

    try {
      const step = dt ?? this.options.dt;
      if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`SemanticObserver.tick requires a positive finite dt, got ${String(step)}`);
      }

      fieldSnapshot = this.field.snapshot();
      smfSnapshot = this.smf.toArray();
      hologramSnapshot = this.hologram.clone();
      previousHologramSnapshot = this.previousHologram;
      tickCountSnapshot = this.tickCount;
      elapsedSnapshot = this.elapsed;
      previousCoherenceSnapshot = this.previousCoherence;
      clusterSignatureSnapshot = this.clusterSignature;
      clusterStableTicksSnapshot = this.clusterStableTicks;
      clusterSatisfiedSnapshot = this.clusterSatisfied;
      momentCountSnapshot = this.momentCount;
      lastMomentIdSnapshot = this.lastMomentId;
      lastSafetySnapshot = this.lastSafety;

      this.tickCount += 1;

      // 0. Ambient drive: the resting baseline set via observe({kind:'noise'}).
      //    A real constant excitation, so the field has a floor but never
      //    fabricates activity it was not given.
      if (this.ambientLevel > 0) {
        this.field.excite(this.field.primes, this.ambientLevel * step);
      }

      // 1. Evolve the prime oscillators.
      const metrics = this.field.tick(step);
      const state = this.field.getState();

      // 2. Imprint the oscillator field onto the SMF.
      this.smf.updateFromPrimeActivity(state);

      // 3. Encode + evolve the hologram.
      const amplitudes = this.memoryPatternAmplitudes(state);
      this.hologram.encode(this.field.primes, amplitudes, state.phases);
      this.hologram.evolve(step);
      // 4. Fail-closed safety gate on the real metrics.
      const safety = this.safety.checkMetrics({
        coherence: metrics.coherence,
        orderParameter: metrics.orderParameter,
        entropy: metrics.entropy,
        fieldEnergy: this.hologram.energy()
      });
      this.lastSafety = safety;

      // 5. Moment detection. Two criteria, one rising-edge contract:
      //    'global-R'       — coherence CROSSES momentThreshold going up.
      //    'phase-clusters' — the field ENTERS a stable multi-cluster
      //                       partition (partial synchronization).
      //    Both fire on the transition, never on every tick they hold.
      let moment: SemanticMoment | null = null;
      const emit =
        this.options.momentCriterion === 'phase-clusters'
          ? this.evaluateClusterCriterion(state)
          : this.previousCoherence !== null &&
            this.previousCoherence <= this.momentThreshold &&
            metrics.coherence > this.momentThreshold;

      if (emit && (!this.options.requireSafetyClear || safety.allowed)) {
        this.momentCount += 1;
        this.lastMomentId = randomUUID();
        moment = {
          id: this.lastMomentId,
          tick: this.tickCount,
          time: this.elapsed,
          coherence: metrics.coherence,
          previousCoherence: this.previousCoherence ?? metrics.coherence,
          threshold: this.momentThreshold,
          field: state,
          smf: this.smf.toArray(),
          safety,
          criterion: this.options.momentCriterion,
          // Read-only, and computed only on the tick a moment actually
          // fires: recording the partition costs the control nothing and
          // cannot influence which ticks emit.
          clusters: phaseClusterMetrics(state.phases, state.amplitudes, {
            phaseBins: this.clusterCriterion.phaseBins
          })
        };
        this.momentEvents.next(moment);
      }

      // 6. Accumulate clock AFTER the event so the moment carries tick-start time.
      this.elapsed += step;
      this.previousCoherence = metrics.coherence;

      const holographicDrift = this.previousHologram
        ? this.previousHologram.similarity(this.hologram)
        : 0;
      this.previousHologram = this.hologram.clone();

      const event: SemanticObserverTickEvent = {
        tick: this.tickCount,
        time: this.elapsed,
        metrics,
        smfNormalizedEntropy: this.smf.normalizedEntropy(),
        holographicDrift,
        safety,
        moment
      };
      this.tickEvents.next(event);

      // ── Signal stream emission (no throw paths after this point) ──────
      this.signals.push({
        kind: 'metric',
        at: Date.now(),
        causeId: this.lastStimulusId,
        payload: {
          coherence: metrics.coherence,
          entropy: metrics.entropy,
          orderParameter: metrics.orderParameter,
          activePrimeCount: state.activePrimes.length,
          totalAmplitude: state.totalAmplitude,
          holographicEnergy: this.hologram.energy()
        }
      });
      if (moment) {
        this.signals.push({
          kind: 'insight',
          at: Date.now(),
          causeId: this.lastStimulusId,
          payload: { momentId: moment.id, axis: 'coherence', coherence: moment.coherence }
        });
      }
      this.updateDriftDetection(metrics.coherence);
      this.sweepMemorySignals();

      return event;
    } catch (err) {
      // ── Rollback: the tick either completes or leaves no trace ─────────
      if (fieldSnapshot && smfSnapshot && hologramSnapshot) {
        this.field.restore(fieldSnapshot);
        for (let i = 0; i < smfSnapshot.length; i++) this.smf.set(i, smfSnapshot[i]);
        this.hologram = hologramSnapshot;
        this.previousHologram = previousHologramSnapshot;
        this.tickCount = tickCountSnapshot;
        this.elapsed = elapsedSnapshot;
        this.previousCoherence = previousCoherenceSnapshot;
        this.clusterSignature = clusterSignatureSnapshot;
        this.clusterStableTicks = clusterStableTicksSnapshot;
        this.clusterSatisfied = clusterSatisfiedSnapshot;
        this.momentCount = momentCountSnapshot;
        this.lastMomentId = lastMomentIdSnapshot;
        this.lastSafety = lastSafetySnapshot;
      }

      const error = err instanceof Error ? err : new Error(String(err));
      // Typed error channel: no EventEmitter 'error' semantics, no crash.
      this.errorEvents.next(error);
      throw error;
    }
  }

  // ── signal internals (called inside the atomic tick region) ─────────────

  /**
   * The cluster emission criterion, evaluated on the live field state.
   *
   * STRUCTURE: the partition must have at least `minClusters` groups, a
   * size-weighted within-cluster order parameter of at least `minWithinR`,
   * and a between-cluster order parameter no greater than `maxBetweenR` —
   * groups that lock internally at DIFFERENT phases.
   *
   * STABILITY: that partition's signature must hold for `stabilityTicks`
   * consecutive ticks. Oscillators drifting past each other sweep through
   * many transient partitions and hold none, so stability is what separates
   * a locked chimera from accidental bunching.
   *
   * EDGE: returns true only on the tick the criterion becomes satisfied. A
   * CHANGE of partition re-arms the edge — a different partition is a
   * different code and earns its own moment once it has held.
   *
   * The bookkeeping it mutates is part of the tick's atomic region and is
   * rolled back with everything else if the tick throws.
   */
  private evaluateClusterCriterion(state: OscillatorFieldState): boolean {
    const clusters = phaseClusterMetrics(state.phases, state.amplitudes, {
      phaseBins: this.clusterCriterion.phaseBins
    });

    const structured =
      clusters.clusterCount >= this.clusterCriterion.minClusters &&
      clusters.withinR >= this.clusterCriterion.minWithinR &&
      clusters.betweenR <= this.clusterCriterion.maxBetweenR;

    if (!structured) {
      this.clusterSignature = null;
      this.clusterStableTicks = 0;
      this.clusterSatisfied = false;
      return false;
    }

    if (clusters.signature !== this.clusterSignature) {
      this.clusterSignature = clusters.signature;
      this.clusterStableTicks = 1;
      this.clusterSatisfied = false;
    } else {
      this.clusterStableTicks += 1;
    }

    const satisfied = this.clusterStableTicks >= this.clusterCriterion.stabilityTicks;
    const rising = satisfied && !this.clusterSatisfied;
    this.clusterSatisfied = satisfied;
    return rising;
  }

  /**
   * Drift detection: emit a warning when coherence has trended downward
   * across a window of ticks. Real coherence is noisy, so the criterion is a
   * trend, not strict monotonicity: at least `driftDecliningRatio` of
   * tick-to-tick steps must be non-increasing AND the window must lose at
   * least `driftDropThreshold` coherence. The episode ends when the window is
   * clearly rising again (< 60% declining), so a sustained decline emits
   * exactly one signal. Window and thresholds are constructor options.
   */
  private updateDriftDetection(coherence: number): void {
    const windowTicks = this.options.driftWindowTicks;
    this.coherenceHistory.push({ at: this.elapsed, coherence });
    while (this.coherenceHistory.length > windowTicks * 3) {
      this.coherenceHistory.shift();
    }

    const window = this.coherenceHistory.slice(-windowTicks);
    if (window.length < windowTicks) return;

    let decliningSteps = 0;
    for (let i = 1; i < window.length; i++) {
      if (window[i].coherence <= window[i - 1].coherence) {
        decliningSteps += 1;
      }
    }
    const steps = window.length - 1;
    const decliningRatio = decliningSteps / steps;

    if (decliningRatio < 0.6) {
      this.driftEpisodeActive = false;
    }

    if (this.driftEpisodeActive) return;
    if (decliningRatio < this.options.driftDecliningRatio) return;

    const start = window[0];
    const end = window[window.length - 1];
    if (start.coherence - end.coherence < this.options.driftDropThreshold) return;

    this.driftEpisodeActive = true;
    this.signals.push({
      kind: 'drift',
      at: Date.now(),
      causeId: this.lastStimulusId,
      payload: {
        axis: 'coherence',
        direction: 'down',
        durationMs: Math.round((end.at - start.at) * 1000),
        coherenceStart: start.coherence,
        coherenceEnd: end.coherence
      }
    });
  }

  /**
   * Memory lifecycle sweep (throttled to every 50 ticks): traces whose
   * retrieval strength decays below the threshold emit a 'decaying' signal
   * exactly once; a recovered trace is re-armed.
   */
  private sweepMemorySignals(): void {
    this.memorySweepCounter += 1;
    if (this.memorySweepCounter % 50 !== 0) return;

    // Pruned traces leave the bank but their decay flags would otherwise
    // persist forever (the resident-only sweep below can never re-arm them).
    // Reconcile the flag set against residency once per sweep so the set
    // stays bounded at the resident trace count.
    if (this.decayFlagged.size > 0) {
      for (const id of this.decayFlagged) {
        if (this.memory.get(id) === undefined) this.decayFlagged.delete(id);
      }
    }

    for (const trace of this.memory.all()) {
      if (trace.strength < 0.5 && !this.decayFlagged.has(trace.id)) {
        this.decayFlagged.add(trace.id);
        this.signals.push({
          kind: 'memory',
          at: Date.now(),
          causeId: this.lastStimulusId,
          payload: { event: 'decaying', traceId: trace.id, content: trace.content, strength: trace.strength }
        });
      } else if (trace.strength >= 0.6 && this.decayFlagged.has(trace.id)) {
        this.decayFlagged.delete(trace.id);
      }
    }
  }

  /**
   * Settle the field: reset the oscillators to rest and clear the coherence
   * history. Used by a teacher BETWEEN lessons so the next lesson's trace
   * records only its own excitation — without it, un-decayed amplitude from
   * previous lessons contaminates every new memory trace.
   *
   * This is an intentional reset, so it also clears the drift detector: a
   * settle is not a focus decline and must never emit a drift warning.
   */
  settleField(): void {
    this.requireInitialized();
    this.field.reset();
    this.coherenceHistory.length = 0;
    this.driftEpisodeActive = false;
    // The reset destroys the phase partition, so the cluster criterion's
    // stability memory is stale: a settle must not let a pre-settle partition
    // count toward a post-settle moment.
    this.clusterSignature = null;
    this.clusterStableTicks = 0;
    this.clusterSatisfied = false;
  }

  /** Tick repeatedly until `predicate` holds or `maxTicks` is reached. */
  runTicks(maxTicks: number, dt?: number, predicate?: (event: SemanticObserverTickEvent) => boolean): SemanticObserverTickEvent[] {
    const events: SemanticObserverTickEvent[] = [];
    const limit = Math.max(0, Math.floor(maxTicks));
    for (let i = 0; i < limit; i++) {
      const event = this.tick(dt);
      events.push(event);
      if (predicate && predicate(event)) break;
    }
    return events;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State & introspection
  // ─────────────────────────────────────────────────────────────────────────

  /** Aggregate state (no simulation advance). */
  getState(): SemanticObserverState {
    const metrics = this.field.getMetrics();
    const state = this.field.getState();

    return {
      tickCount: this.tickCount,
      time: this.elapsed,
      coherence: metrics.coherence,
      entropy: metrics.entropy,
      orderParameter: metrics.orderParameter,
      smf: this.smf.toArray(),
      smfNormalizedEntropy: this.smf.normalizedEntropy(),
      holographicEnergy: this.hologram.energy(),
      holographicEntropy: this.hologram.entropy(),
      holographicDrift: this.previousHologram ? this.previousHologram.similarity(this.hologram) : 0,
      activePrimes: state.activePrimes,
      activePrimeCount: state.activePrimes.length,
      totalAmplitude: state.totalAmplitude,
      momentCount: this.momentCount,
      lastMomentId: this.lastMomentId,
      memoryTraceCount: this.memory.size,
      safety: this.lastSafety,
      kernel: { loaded: this.kernel.isInitialized(), degraded: this.kernel.isDegraded }
    };
  }

  /** The SMF orientation. */
  getMemoryField(): SedenionMemoryField {
    return this.smf;
  }

  /** The oscillator field. */
  getOscillatorField(): PrimeOscillatorField {
    return this.field;
  }

  /** The hologram. */
  getHologram(): HolographicMemory {
    return this.hologram;
  }

  /** The memory bank. */
  getMemoryBank(): MemoryBank {
    return this.memory;
  }

  /** The safety monitor. */
  getSafetyMonitor(): SafetyMonitor {
    return this.safety;
  }

  /** The active moment threshold. */
  getMomentThreshold(): number {
    return this.momentThreshold;
  }

  /** Which criterion currently gates moment emission. */
  getMomentCriterion(): MomentCriterion {
    return this.options.momentCriterion;
  }

  /**
   * Live phase-cluster structure of the oscillator field (read-only).
   *
   * Available under BOTH criteria: the control can be audited for cluster
   * structure it is not gating on, which is what makes the two arms
   * comparable on the same measurement.
   */
  getClusterStructure(): PhaseClusterMetrics {
    this.requireInitialized();
    return this.field.clusterStructure({ phaseBins: this.clusterCriterion.phaseBins });
  }

  /** Change the moment threshold. */
  setMomentThreshold(threshold: number): void {
    this.momentThreshold = clampRange(threshold, Number.EPSILON, 1);
  }

  /** Reset runtime state (configuration and safety rules are preserved). */
  reset(): void {
    this.requireInitialized();
    this.field.reset();
    this.smf.set(0, 1);
    for (let i = 1; i < this.smf.width; i++) this.smf.set(i, 0);
    this.hologram.clear();
    this.previousHologram = null;
    this.memory.clear();
    this.previousCoherence = null;
    this.clusterSignature = null;
    this.clusterStableTicks = 0;
    this.clusterSatisfied = false;
    this.tickCount = 0;
    this.elapsed = 0;
    this.momentCount = 0;
    this.lastMomentId = null;
    this.lastSafety = null;
    this.lastStimulusId = null;
    this.ambientLevel = 0;
    this.coherenceHistory.length = 0;
    this.driftEpisodeActive = false;
    this.decayFlagged.clear();
    this.memorySweepCounter = 0;
    this.signals.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────────

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error('SemanticObserver.initialize() must be awaited before use');
    }
  }

  /**
   * Resolve an input into folded basis primes WITHOUT mutating any state.
   * Shared by `processInput` (which then excites the field) and
   * `recallMemory` (which must stay a pure read) — so when sparse excitation
   * is on, the stored side and the cue side are encoded by the same rule.
   */
  private resolvePrimes(input: SemanticInput): number[] {
    let primes: number[];
    // Pre-dedup emission order, kept only to weight the sparse selection.
    let emitted: readonly number[];
    if (typeof input === 'string') {
      const backend = this.kernel.createSemanticBackend({
        vocabulary: this.vocabulary as Record<string, number[]>
      });
      // Vocabulary words must encode even when the backend's default NLP
      // stop-word list tags them as stop words ('the', 'a', 'of', ...): a
      // curriculum assigns every deck word an explicit prime signature, and
      // dropping stop words here would silence a large share of a frequency
      // deck — nothing stored, nothing recalled. Unknown stop tokens are
      // still excluded, preserving default behavior for ordinary sentences.
      const tokenPrimes = backend
        .tokenize(input, false)
        .filter((token) => token.known || !token.isStop)
        .flatMap((token) => token.primes);
      emitted = tokenPrimes;
      primes = [...new Set(tokenPrimes)];
    } else {
      primes = Array.from(input);
      emitted = primes;
    }
    if (primes.length === 0) return [];

    const folded = primes.map(p => this.foldPrime(p));
    if (this.excitationTopK === null) return folded;
    return this.selectSparseExcitation(folded, emitted);
  }

  /**
   * Fold a source prime into the field basis (prime rank mod N).
   * Integers only: a fractional prime would index `basis[2.5]` -> undefined,
   * so it is mapped to the -1 sentinel the excite path already ignores.
   */
  private foldPrime(p: number): number {
    const basis = this.field.primes;
    if (!Number.isInteger(p) || p <= 0) return -1;
    const rank = this.kernel.primeRankOf(p);
    if (rank >= 0) return basis[rank % basis.length];
    return basis[p % basis.length];
  }

  /**
   * The `excitationTopK` selection: the k basis primes a stimulus excites.
   *
   * Deterministic and content-derived, in this exact order:
   *   1. WEIGHT — how many of the stimulus's own token-emitted primes fold
   *      onto this basis prime. This is the stimulus's own signature mass on
   *      that oscillator, so it is the "highest-amplitude" reading available
   *      at encode time (the field itself excites every stimulus prime to
   *      the SAME scalar amplitude, so field amplitude cannot rank them).
   *   2. FIRST APPEARANCE in the utterance.
   *   3. The prime itself.
   *
   * Same input -> same primes, always. Nothing here consults the field, the
   * clock, or a random source.
   */
  private selectSparseExcitation(folded: readonly number[], emitted: readonly number[]): number[] {
    const k = this.excitationTopK;
    if (k === null) return [...folded];

    const weight = new Map<number, number>();
    for (const p of emitted) {
      const f = this.foldPrime(p);
      if (f <= 0) continue;
      weight.set(f, (weight.get(f) ?? 0) + 1);
    }

    const firstSeen = new Map<number, number>();
    const unique: number[] = [];
    for (let i = 0; i < folded.length; i += 1) {
      const p = folded[i];
      if (p <= 0 || firstSeen.has(p)) continue;
      firstSeen.set(p, i);
      unique.push(p);
    }
    if (unique.length <= k) return unique;

    unique.sort((a, b) => {
      const byWeight = (weight.get(b) ?? 0) - (weight.get(a) ?? 0);
      if (byWeight !== 0) return byWeight;
      const byOrder = (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0);
      if (byOrder !== 0) return byOrder;
      return a - b;
    });
    return unique.slice(0, k);
  }

  /**
   * Per-prime pattern amplitudes for holographic encoding.
   * The holographic basis is exactly the field's prime list; only active
   * primes carry a nonzero amplitude.
   */
  private memoryPatternAmplitudes(state: OscillatorFieldState): number[] {
    const amplitudes = new Array<number>(state.primes.length).fill(0);
    for (let i = 0; i < state.primes.length; i++) {
      if (i < state.amplitudes.length) amplitudes[i] = state.amplitudes[i];
    }
    return amplitudes;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Subject whose subscribers are quarantined from each other: a throwing
 * `next`/`error`/`complete` handler is caught and discarded, so one broken
 * subscriber can neither block the remaining subscribers nor turn a
 * successful emission into a producer-side exception.
 */
class IsolatedSubject<T> {
  private readonly observers = new Set<Observer<T>>();
  private closedFlag = false;

  get closed(): boolean {
    return this.closedFlag;
  }

  next(value: T): void {
    if (this.closedFlag) return;
    for (const observer of Array.from(this.observers)) {
      try {
        observer.next(value);
      } catch {
        // Subscriber failure is its own problem, not the producer's.
      }
    }
  }

  error(err: Error): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const observer of Array.from(this.observers)) {
      try {
        observer.error?.(err);
      } catch {
        // Isolated.
      }
    }
    this.observers.clear();
  }

  complete(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const observer of Array.from(this.observers)) {
      try {
        observer.complete?.();
      } catch {
        // Isolated.
      }
    }
    this.observers.clear();
  }

  asObservable(): Observable<T> {
    return new Observable(observer => {
      this.observers.add(observer);
      return () => this.observers.delete(observer);
    });
  }
}

/**
 * Map a safety verdict onto a [0, 1] score so callers can chart it: 1.0 when
 * the check allowed, otherwise `1 / (1 + worstSeverityWeight)`. A denial can
 * never score 1.0.
 */
export function safetyScore(result: SafetyCheckResult): number {
  if (result.allowed && result.violations.length === 0) return 1;
  let worst = 0;
  for (const violation of result.violations) {
    const weight = SEVERITY_WEIGHT[violation.severity];
    if (weight > worst) worst = weight;
  }
  return requireFinite(safeDivide(1, 1 + worst, 0), 'safetyScore');
}
