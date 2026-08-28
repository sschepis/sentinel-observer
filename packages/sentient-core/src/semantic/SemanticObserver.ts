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
  type OscillatorFieldState,
  type OscillatorFieldTick,
  type PrimeOscillatorSnapshot
} from './PrimeOscillatorField';
import { SedenionMemoryField, SMF_DIMENSION } from './SedenionMemoryField';
import { SMF_AXES, type SMFAxisIndex } from '../common/types';
import { HolographicMemory } from './HolographicMemory';
import {
  SemanticMemoryBank,
  type MemoryTrace,
  type RecallResult
} from './SemanticMemoryBank';
import {
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
  private readonly options: Required<
    Omit<SemanticObserverOptions, 'kernel' | 'safety'>
  > & { safety?: SafetyMonitor };

  private readonly field: PrimeOscillatorField;
  private readonly smf = SedenionMemoryField.identity();
  private readonly memory: SemanticMemoryBank;
  private hologram: HolographicMemory;
  private previousHologram: HolographicMemory | null = null;
  private readonly safety: SafetyMonitor;

  private momentThreshold: number;
  private previousCoherence: number | null = null;
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
      driftWindowTicks: Math.max(10, Math.floor(options.driftWindowTicks ?? 40)),
      driftDropThreshold: options.driftDropThreshold ?? 0.03,
      driftDecliningRatio: options.driftDecliningRatio ?? 0.75,
      dt: options.dt ?? 0.016,
      memoryCapacity: Math.max(1, Math.floor(options.memoryCapacity ?? 256)),
      requireSafetyClear: options.requireSafetyClear ?? true,
      safety: options.safety
    };

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

    this.momentThreshold = clampRange(this.options.momentThreshold, Number.EPSILON, 1);

    this.field = new PrimeOscillatorField({
      primeCount: this.options.primeCount,
      coupling: this.options.coupling,
      kernel: this.kernel
    });

    this.memory = new SemanticMemoryBank({
      capacity: this.options.memoryCapacity,
      gridSize: this.options.gridSize,
      primes: undefined // basis is chosen per encode call from the field primes
    });

    this.hologram = new HolographicMemory({ gridSize: this.options.gridSize });
    this.safety = options.safety ?? SafetyMonitor.forObserver();
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
    const state = this.field.getState();
    return state.totalAmplitude > 0 ? this.field.getMetrics().coherence : 0;
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
    const factor = (kindFactor[focus] ?? 1) * (0.5 + 0.5 * intensity);
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
    for (let i = 0; i < SMF_DIMENSION; i++) {
      if (Math.abs(projection.get(i) - this.smf.get(i)) > 1e-9) {
        touched.push(SMF_AXES[i as SMFAxisIndex].name);
      }
    }
    return touched;
  }

  /**
   * Store the current orientation as a memory trace.
   * Returns the created trace (null when the field is quiescent).
   */
  storeMemory(content: string): MemoryTrace | null {
    this.requireInitialized();
    const state = this.field.getState();
    if (state.totalAmplitude <= 0) return null;

    const amplitudes = this.memoryPatternAmplitudes(state);
    const trace = this.memory.store(content, this.smf.clone(), this.field.primes, { amplitudes });
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
   */
  recallMemory(content?: string, topK = 5): RecallResult[] {
    this.requireInitialized();
    const folded = content ? this.resolvePrimes(content) : undefined;
    const queryPrimes = folded ? folded.filter(p => p > 0) : undefined;
    const results = this.memory.recall(
      { smf: this.smf.clone(), primes: queryPrimes },
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

      // 5. Moment detection: coherence must CROSS the threshold going up.
      let moment: SemanticMoment | null = null;
      if (this.previousCoherence !== null) {
        const crossed = this.previousCoherence <= this.momentThreshold && metrics.coherence > this.momentThreshold;
        if (crossed && (!this.options.requireSafetyClear || safety.allowed)) {
          this.momentCount += 1;
          this.lastMomentId = randomUUID();
          moment = {
            id: this.lastMomentId,
            tick: this.tickCount,
            time: this.elapsed,
            coherence: metrics.coherence,
            previousCoherence: this.previousCoherence,
            threshold: this.momentThreshold,
            field: state,
            smf: this.smf.toArray(),
            safety
          };
          this.momentEvents.next(moment);
        }
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
      this.updateDriftDetection(metrics.coherence, step);
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
   * Drift detection: emit a warning when coherence has trended downward
   * across a window of ticks. Real coherence is noisy, so the criterion is a
   * trend, not strict monotonicity: at least `driftDecliningRatio` of
   * tick-to-tick steps must be non-increasing AND the window must lose at
   * least `driftDropThreshold` coherence. The episode ends when the window is
   * clearly rising again (< 60% declining), so a sustained decline emits
   * exactly one signal. Window and thresholds are constructor options.
   */
  private updateDriftDetection(coherence: number, step: number): void {
    void step;
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
  getMemoryBank(): SemanticMemoryBank {
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

  /** Change the moment threshold. */
  setMomentThreshold(threshold: number): void {
    this.momentThreshold = clampRange(threshold, Number.EPSILON, 1);
  }

  /** Reset runtime state (configuration and safety rules are preserved). */
  reset(): void {
    this.requireInitialized();
    this.field.reset();
    this.smf.set(0, 1);
    for (let i = 1; i < 16; i++) this.smf.set(i, 0);
    this.hologram.clear();
    this.previousHologram = null;
    this.memory.clear();
    this.previousCoherence = null;
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
   * `recallMemory` (which must stay a pure read).
   */
  private resolvePrimes(input: SemanticInput): number[] {
    let primes: number[];
    if (typeof input === 'string') {
      const backend = this.kernel.createSemanticBackend({});
      primes = backend.encode(input);
    } else {
      primes = Array.from(input);
    }
    if (primes.length === 0) return [];

    const basis = this.field.primes;
    return primes.map(p => {
      if (!Number.isFinite(p) || p <= 0) return -1;
      const rank = this.kernel.primeRankOf(p);
      if (rank >= 0) return basis[rank % basis.length];
      return basis[(p % basis.length + basis.length) % basis.length];
    });
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

const SEVERITY_WEIGHT: Record<SafetyViolation['severity'], number> = {
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  critical: 1
};

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
