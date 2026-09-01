/**
 * Prime Oscillator Field
 *
 * Prime-indexed oscillator bank built on tinyaleph's `KuramotoModel`.
 *
 * Semantics: oscillator `i` is bound to prime `pᵢ` with natural frequency
 * `primeToFrequency(pᵢ)`. Exciting a prime raises that oscillator's amplitude;
 * Kuramoto coupling then pulls the active oscillators toward a common phase.
 * Phase concentration among the active oscillators is the field's coherence.
 *
 * Fixes relative to `lib/prsc.js`:
 *   - The legacy fallback class reported `orderParameter() => 0.5`,
 *     `amplitudeEntropy() => 0.5`, `getGlobalCoherence() => 1.0` and, because
 *     the real library never loaded, those constants were the only values the
 *     engine ever saw. Here every metric comes from the real Kuramoto model.
 *   - All divisions are guarded and every returned metric is asserted finite,
 *     so a `NaN` surfaces as an exception instead of poisoning downstream math.
 */

import type { Initializable } from '../common/types';
import { SemanticKernel, getSharedKernel, type TAKuramotoModel } from './tinyaleph';
import { clampRange, NonFiniteValueError, requireAllFinite, requireFinite, safeDivide } from './numeric';
import { ConfigurationLimitError, MAX_PRIME_COUNT, NotInitializedError } from './errors';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Construction options for the field. */
export interface PrimeOscillatorFieldOptions {
  /** Number of prime-indexed oscillators (default 16, matching the SMF axes). */
  primeCount?: number;
  /** Kuramoto coupling strength K (default 0.45). */
  coupling?: number;
  /** Amplitude decay rate applied per tick, on top of the model's own decay. */
  decayRate?: number;
  /** Amplitude at or above which an oscillator counts as active (default 0.05). */
  activeThreshold?: number;
  /** Shared kernel override (mainly for tests). */
  kernel?: SemanticKernel;

  // ── COMPETITION (P12) ────────────────────────────────────────────────
  // Purely positive Kuramoto coupling pulls EVERY oscillator toward every
  // other one, so the field's stable state is one global mode that every
  // stored trace shares. These three knobs make oscillators COMPETE. All
  // three default to OFF, and at their defaults the field is bit-identical
  // to the uncompeted control — that identity is asserted by a test.

  /**
   * (a) DIVISIVE NORMALIZATION: the total excitation budget the oscillators
   * compete for. After every tick, when `Σaⱼ` exceeds `activationBudget`,
   * every amplitude is scaled by `budget / Σaⱼ`.
   *
   * Excitation is ADDITIVE and un-normalized, so a re-excited prime is
   * topped back up every stimulus while stale background activation is only
   * ever scaled down: the budget makes fresh excitation crowd out the
   * residual instead of accumulating on top of it. 0 (default) = off.
   */
  activationBudget?: number;

  /**
   * (b) INHIBITORY COUPLING between unrelated primes, in [0, 1].
   *
   * The pairwise Kuramoto weight becomes `+1` for primes in the same
   * ACTIVITY GROUP (both at/above `activeThreshold`, or both below) and
   * `1 − 2·inhibition` across groups. So:
   *   - 0   (default) → weight +1 everywhere = the uncompeted control;
   *   - 0.5           → the excited group and the silent background are
   *                     completely decoupled;
   *   - 1             → weight −1 across groups: locking one group actively
   *                     pushes everything else into anti-phase.
   *
   * "Unrelated" is defined by co-excitation, not by index distance: primes
   * excited by the same stimulus belong to one word's signature, and a
   * silent oscillator is by construction not part of it.
   */
  inhibition?: number;

  /**
   * (c) k-WINNER-TAKE-ALL: after every tick, only the `k` largest amplitudes
   * survive; the rest are zeroed. Ties break by amplitude descending then
   * oscillator index ascending, so the winner set is fully deterministic.
   * 0 (default), or any k at/above the oscillator count, = off.
   */
  winnerTakeAll?: number;
}

/** The competition configuration actually in force (see the options above). */
export interface CompetitionConfig {
  activationBudget: number;
  inhibition: number;
  winnerTakeAll: number;
}

/** Metrics returned by a single `tick`. */
export interface OscillatorFieldTick {
  /** Phase concentration among active oscillators, in [0, 1]. */
  coherence: number;
  /**
   * Shannon entropy (bits) of the oscillator amplitude distribution, using
   * the tinyaleph `oscillatorEntropy` convention: each oscillator's
   * amplitude normalized by the raw amplitude sum.
   */
  entropy: number;
  /** Real amplitude-weighted Kuramoto order parameter, in [0, 1]. */
  orderParameter: number;
}

/** Full observable state of the field. */
export interface OscillatorFieldState extends OscillatorFieldTick {
  primes: readonly number[];
  phases: number[];
  amplitudes: number[];
  /**
   * The exact normalization of the SAME distribution used by `entropy`:
   * `entropy / log2(primeCount)`, in [0, 1]. Derived from the `entropy`
   * metric itself, so the two readouts can never disagree on the
   * distribution convention.
   */
  normalizedEntropy: number;
  /** Sum of oscillator amplitudes. */
  totalAmplitude: number;
  /** Indices of oscillators at or above `activeThreshold`. */
  activeIndices: number[];
  /** Primes of the active oscillators. */
  activePrimes: number[];
  /** Accumulated simulated time. */
  time: number;
  /** Number of ticks executed since construction or `reset()`. */
  ticks: number;
}

/** Captured evolution state, used for atomic rollback (see `restore`). */
export interface PrimeOscillatorSnapshot {
  /** Oscillator phases at snapshot time. */
  phases: readonly number[];
  /** Oscillator amplitudes at snapshot time. */
  amplitudes: readonly number[];
  /** Oscillator base amplitudes at snapshot time. */
  baseAmplitudes: readonly number[];
  /** Simulated time. */
  elapsed: number;
  /** Tick counter. */
  tickCount: number;
  /** Metrics cached from the most recent tick. */
  lastMetrics: OscillatorFieldTick;
}

// ═══════════════════════════════════════════════════════════════════════════
// FIELD
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULTS = {
  primeCount: 16,
  coupling: 0.45,
  decayRate: 0.01,
  activeThreshold: 0.05,
  activationBudget: 0,
  inhibition: 0,
  winnerTakeAll: 0
} as const;

/**
 * tinyaleph's `KuramotoModel.tick` applies this fixed decay after its phase
 * sweep. The inhibitory sweep replaces that method wholesale, so it has to
 * reproduce the same dissipation or the two arms would differ by more than
 * the coupling structure under test.
 */
const TA_MODEL_DECAY_RATE = 0.02;

/**
 * Validate a competition knob. Out-of-range is refused LOUDLY rather than
 * clamped: silently reinterpreting `inhibition: 5` as `1` would make a
 * benchmark row a fiction.
 */
function requireInRange(label: string, value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new NonFiniteValueError(`${label} (expected ${min}..${max})`, value);
  }
  return value;
}

export class PrimeOscillatorField implements Initializable {
  private readonly kernel: SemanticKernel;
  private readonly options: Required<Omit<PrimeOscillatorFieldOptions, 'kernel'>>;

  private model: TAKuramotoModel | null = null;
  private primeList: number[] = [];
  private primeIndex: Map<number, number> = new Map();
  private elapsed = 0;
  private tickCount = 0;
  private lastMetrics: OscillatorFieldTick = { coherence: 0, entropy: 0, orderParameter: 0 };

  constructor(options: PrimeOscillatorFieldOptions = {}) {
    this.kernel = options.kernel ?? getSharedKernel();
    const rawPrimeCount = options.primeCount ?? DEFAULTS.primeCount;
    if (!Number.isFinite(rawPrimeCount)) throw new NonFiniteValueError('primeCount', rawPrimeCount);
    const primeCount = Math.max(2, Math.floor(rawPrimeCount));
    if (primeCount > MAX_PRIME_COUNT) {
      throw new ConfigurationLimitError('primeCount', MAX_PRIME_COUNT, primeCount);
    }
    this.options = {
      primeCount,
      coupling: options.coupling ?? DEFAULTS.coupling,
      decayRate: Math.max(0, options.decayRate ?? DEFAULTS.decayRate),
      activeThreshold: Math.max(0, options.activeThreshold ?? DEFAULTS.activeThreshold),
      activationBudget: requireInRange(
        'activationBudget',
        options.activationBudget ?? DEFAULTS.activationBudget,
        0,
        Number.POSITIVE_INFINITY
      ),
      inhibition: requireInRange('inhibition', options.inhibition ?? DEFAULTS.inhibition, 0, 1),
      winnerTakeAll: Math.floor(
        requireInRange(
          'winnerTakeAll',
          options.winnerTakeAll ?? DEFAULTS.winnerTakeAll,
          0,
          Number.POSITIVE_INFINITY
        )
      )
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.model) return;
    if (!this.kernel.isInitialized()) await this.kernel.initialize();

    this.primeList = this.kernel.firstNPrimes(this.options.primeCount);
    if (this.primeList.length !== this.options.primeCount) {
      throw new Error(
        `Expected ${this.options.primeCount} primes, tinyaleph returned ${this.primeList.length}`
      );
    }
    this.primeIndex = new Map(this.primeList.map((p, i) => [p, i]));

    const frequencies = this.primeList.map(p =>
      requireFinite(this.kernel.primeToFrequency(p), `primeToFrequency(${p})`)
    );
    this.model = this.kernel.createKuramotoModel(frequencies, this.options.coupling);
    this.elapsed = 0;
    this.tickCount = 0;
    this.lastMetrics = { coherence: 0, entropy: 0, orderParameter: 0 };
  }

  isInitialized(): boolean {
    return this.model !== null;
  }

  private bank(): TAKuramotoModel {
    if (!this.model) {
      throw new NotInitializedError('PrimeOscillatorField');
    }
    return this.model;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Structure
  // ─────────────────────────────────────────────────────────────────────────

  /** The prime assigned to each oscillator, in index order. */
  get primes(): readonly number[] {
    return this.primeList;
  }

  /** Oscillator count. */
  get size(): number {
    return this.options.primeCount;
  }

  /** Kuramoto coupling strength. */
  get coupling(): number {
    return this.options.coupling;
  }

  /**
   * Index of the oscillator bound to `prime`, or -1 when the prime is outside
   * this field's basis.
   */
  indexOfPrime(prime: number): number {
    const index = this.primeIndex.get(prime);
    return index === undefined ? -1 : index;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Excitation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Excite the oscillators bound to `primes`.
   *
   * Primes outside the field basis are ignored (and reported in the return
   * value) rather than being silently folded onto an unrelated oscillator.
   *
   * @returns the number of oscillators actually excited.
   */
  excite(primes: readonly number[], amplitude = 0.5): number {
    const bank = this.bank();
    if (!Number.isFinite(amplitude) || amplitude <= 0) return 0;

    const indices: number[] = [];
    for (const p of primes) {
      const index = this.primeIndex.get(p);
      if (index !== undefined) indices.push(index);
    }
    if (indices.length === 0) return 0;

    bank.exciteByIndices(indices, amplitude);
    return indices.length;
  }

  /** Excite by oscillator index (bounds-checked). */
  exciteIndices(indices: readonly number[], amplitude = 0.5): number {
    const bank = this.bank();
    if (!Number.isFinite(amplitude) || amplitude <= 0) return 0;
    const valid = indices.filter(i => Number.isInteger(i) && i >= 0 && i < this.options.primeCount);
    if (valid.length === 0) return 0;
    bank.exciteByIndices(valid, amplitude);
    return valid.length;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Evolution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Advance the field by `dt` and return real coherence/entropy/order metrics.
   *
   * `KuramotoModel.tick` already applies its own 2%/unit-time amplitude decay;
   * `decayRate` adds configurable extra dissipation on top of it.
   *
   * P12 COMPETITION: when enabled, the phase sweep is replaced by the
   * inhibitory one and the settled amplitudes are then passed through the
   * divisive-normalization budget and the k-winner-take-all filter, in that
   * order — both read amplitudes AFTER all dissipation, so the budget and the
   * winner set describe the state the SMF and memory actually see.
   */
  tick(dt = 0.016): OscillatorFieldTick {
    const bank = this.bank();
    if (!Number.isFinite(dt) || dt <= 0) {
      throw new Error(`PrimeOscillatorField.tick requires a positive finite dt, got ${String(dt)}`);
    }

    if (this.options.inhibition > 0) this.tickInhibited(dt);
    else bank.tick(dt);

    if (this.options.decayRate > 0) bank.decayAll(this.options.decayRate, dt);

    this.applyActivationBudget();
    this.applyWinnerTakeAll();

    this.elapsed += dt;
    this.tickCount += 1;

    const metrics = this.computeMetrics();
    this.lastMetrics = metrics;
    return metrics;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Competition (P12)
  // ─────────────────────────────────────────────────────────────────────────

  /** The competition configuration in force (all zeros = the control). */
  get competition(): CompetitionConfig {
    return {
      activationBudget: this.options.activationBudget,
      inhibition: this.options.inhibition,
      winnerTakeAll: this.options.winnerTakeAll
    };
  }

  /**
   * (b) One Kuramoto phase sweep with INHIBITORY cross-group coupling.
   *
   * Structurally identical to `KuramotoModel.tick`: the same in-place
   * (Gauss–Seidel) sweep order, the same `K·Σ/N · dt` scaling, the same
   * trailing 2%/unit-time decay. The ONLY difference is the pairwise weight,
   * which is `+1` within an activity group and `1 − 2·inhibition` across
   * groups. At `inhibition = 0` that weight is `+1` everywhere and this
   * method reproduces the model's own tick exactly.
   *
   * Activity groups are read ONCE, before the sweep: `Oscillator.tick` moves
   * only the phase, so amplitudes — and therefore group membership — are
   * constant across a sweep and every oscillator sees the same partition.
   */
  private tickInhibited(dt: number): void {
    const oscillators = this.bank().oscillators;
    const n = oscillators.length;
    if (n === 0) return;

    const k = this.bank().K;
    const crossWeight = 1 - 2 * this.options.inhibition;
    const threshold = this.options.activeThreshold;

    const active = new Array<boolean>(n);
    for (let i = 0; i < n; i++) active[i] = oscillators[i].amplitude >= threshold;

    for (let i = 0; i < n; i++) {
      const osc = oscillators[i];
      const phase = osc.phase;
      const group = active[i];
      let sum = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const weight = active[j] === group ? 1 : crossWeight;
        sum += weight * Math.sin(oscillators[j].phase - phase);
      }
      osc.tick(dt, ((k * sum) / n) * dt);
    }

    for (const osc of oscillators) osc.decay(TA_MODEL_DECAY_RATE, dt);
  }

  /**
   * (a) DIVISIVE NORMALIZATION: rescale amplitudes onto a fixed excitation
   * budget. A field below budget is untouched, so a quiescent field stays
   * quiescent and is never inflated into activity it was not given.
   */
  private applyActivationBudget(): void {
    const budget = this.options.activationBudget;
    if (budget <= 0) return;

    const oscillators = this.bank().oscillators;
    let total = 0;
    for (const osc of oscillators) total += osc.amplitude;
    if (!(total > budget)) return;

    const scale = budget / total;
    for (const osc of oscillators) osc.amplitude *= scale;
  }

  /**
   * (c) k-WINNER-TAKE-ALL: keep the `k` largest amplitudes, zero the rest.
   *
   * The ranking is total and deterministic — amplitude descending, then
   * oscillator index ascending — so a tie can never be resolved by the sort
   * implementation's internal ordering.
   */
  private applyWinnerTakeAll(): void {
    const k = this.options.winnerTakeAll;
    if (k <= 0) return;

    const oscillators = this.bank().oscillators;
    const n = oscillators.length;
    if (k >= n) return;

    const order = new Array<number>(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => {
      const delta = oscillators[b].amplitude - oscillators[a].amplitude;
      return delta !== 0 ? delta : a - b;
    });
    for (let rank = k; rank < n; rank++) oscillators[order[rank]].amplitude = 0;
  }

  /** Reset all oscillators to the quiescent state and zero the clocks. */
  reset(): void {
    if (this.model) this.model.reset();
    this.elapsed = 0;
    this.tickCount = 0;
    this.lastMetrics = { coherence: 0, entropy: 0, orderParameter: 0 };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Snapshot / rollback
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Capture the field's evolution state. Used by the observer for atomic
   * ticks: a mid-tick failure can be rolled back exactly with `restore()`.
   */
  snapshot(): PrimeOscillatorSnapshot {
    const bank = this.bank();
    return {
      phases: this.getPhases(),
      amplitudes: this.getAmplitudes(),
      baseAmplitudes: bank.oscillators.map(oscillator => oscillator.baseAmplitude),
      elapsed: this.elapsed,
      tickCount: this.tickCount,
      lastMetrics: { ...this.lastMetrics }
    };
  }

  /**
   * Roll the field back to a previously captured snapshot. The oscillators'
   * phase/amplitude/baseAmplitude are rewritten in place (the model reads
   * them directly), and the clocks and cached metrics are restored.
   */
  restore(snapshot: PrimeOscillatorSnapshot): void {
    const oscillators = this.bank().oscillators;
    const count = Math.min(oscillators.length, snapshot.amplitudes.length);
    for (let i = 0; i < count; i++) {
      oscillators[i].phase = snapshot.phases[i];
      oscillators[i].amplitude = snapshot.amplitudes[i];
      oscillators[i].baseAmplitude = snapshot.baseAmplitudes[i];
    }
    this.elapsed = snapshot.elapsed;
    this.tickCount = snapshot.tickCount;
    this.lastMetrics = { ...snapshot.lastMetrics };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Readouts
  // ─────────────────────────────────────────────────────────────────────────

  /** Oscillator phases in radians. */
  getPhases(): number[] {
    const phases = this.bank().getPhases();
    requireAllFinite(phases, 'phases');
    return phases;
  }

  /** Oscillator amplitudes. */
  getAmplitudes(): number[] {
    const amplitudes = this.bank().getAmplitudes();
    requireAllFinite(amplitudes, 'amplitudes');
    return amplitudes;
  }

  /**
   * Set the Kuramoto coupling strength (attention modulation).
   *
   * Higher coupling makes the field follow excitation faster (focused);
   * lower coupling lets excitations decay (idle). Non-finite or negative
   * values are refused loudly rather than clamped silently.
   */
  setCoupling(k: number): void {
    if (!Number.isFinite(k) || k < 0) {
      throw new NonFiniteValueError('coupling', k);
    }
    const model = this.bank();
    model.K = k;
  }

  /** The live coupling strength (throws before initialize). */
  getCoupling(): number {
    return this.bank().K;
  }

  /**
   * Metrics from the most recent tick.
   *
   * Throws `NotInitializedError` before `initialize()`: a pre-init zero is a
   * fabricated metric, not a reading, so it is refused instead of returned.
   */
  getMetrics(): OscillatorFieldTick {
    if (!this.model) {
      throw new NotInitializedError('PrimeOscillatorField');
    }
    return { ...this.lastMetrics };
  }

  /** Complete field state, safe to hand to the SMF and holographic layers. */
  getState(): OscillatorFieldState {
    const phases = this.getPhases();
    const amplitudes = this.getAmplitudes();
    const metrics = this.computeMetrics(phases, amplitudes);

    const activeIndices: number[] = [];
    let totalAmplitude = 0;
    for (let i = 0; i < amplitudes.length; i++) {
      totalAmplitude += amplitudes[i];
      if (amplitudes[i] >= this.options.activeThreshold) activeIndices.push(i);
    }

    return {
      primes: this.primeList,
      phases,
      amplitudes,
      coherence: metrics.coherence,
      entropy: metrics.entropy,
      orderParameter: metrics.orderParameter,
      // The normalization of the SAME distribution `entropy` was computed
      // from: entropy / log2(primeCount). Both readouts therefore share one
      // distribution convention (amplitudes normalized by their raw sum).
      normalizedEntropy: requireFinite(
        clampRange(safeDivide(metrics.entropy, Math.log2(this.options.primeCount), 0), 0, 1),
        'normalizedEntropy'
      ),
      totalAmplitude: requireFinite(totalAmplitude, 'totalAmplitude'),
      activeIndices,
      activePrimes: activeIndices.map(i => this.primeList[i]),
      time: this.elapsed,
      ticks: this.tickCount
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Metric computation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Coherence is the phase concentration `|Σ e^{iφⱼ}| / n` over the *active*
   * oscillators only. A quiescent field has no active oscillators and reports
   * 0 - not 0.5, and not NaN from a 0/0 division.
   */
  private computeMetrics(
    phasesIn?: number[],
    amplitudesIn?: number[]
  ): OscillatorFieldTick {
    const bank = this.bank();
    const phases = phasesIn ?? this.getPhases();
    const amplitudes = amplitudesIn ?? this.getAmplitudes();

    let sx = 0;
    let sy = 0;
    let active = 0;
    for (let i = 0; i < phases.length; i++) {
      if (amplitudes[i] < this.options.activeThreshold) continue;
      sx += Math.cos(phases[i]);
      sy += Math.sin(phases[i]);
      active += 1;
    }

    const coherence = active === 0 ? 0 : clampRange(safeDivide(Math.hypot(sx, sy), active, 0), 0, 1);
    const entropy = this.kernel.oscillatorEntropy(bank);
    const orderParameter = clampRange(bank.orderParameter(), 0, 1);

    return {
      coherence: requireFinite(coherence, 'coherence'),
      entropy: requireFinite(entropy, 'entropy'),
      orderParameter: requireFinite(orderParameter, 'orderParameter')
    };
  }
}
