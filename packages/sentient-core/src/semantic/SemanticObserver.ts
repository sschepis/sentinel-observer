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
import {
  PrimeOscillatorField,
  type OscillatorFieldState,
  type OscillatorFieldTick,
  type PrimeOscillatorSnapshot
} from './PrimeOscillatorField';
import { SedenionMemoryField } from './SedenionMemoryField';
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

  /**
   * Store the current orientation as a memory trace.
   * Returns the created trace (null when the field is quiescent).
   */
  storeMemory(content: string): MemoryTrace | null {
    this.requireInitialized();
    const state = this.field.getState();
    if (state.totalAmplitude <= 0) return null;

    const amplitudes = this.memoryPatternAmplitudes(state);
    return this.memory.store(content, this.smf.clone(), this.field.primes, { amplitudes });
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
    return this.memory.recall(
      { smf: this.smf.clone(), primes: queryPrimes },
      topK
    );
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
