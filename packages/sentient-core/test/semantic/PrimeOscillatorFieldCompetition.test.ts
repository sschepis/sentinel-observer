/**
 * P12 COMPETITION — unit tests for the three opt-in competition mechanisms.
 *
 * The contract these tests hold:
 *   1. OFF IS THE CONTROL. With every knob at its default the field evolves
 *      BIT-IDENTICALLY to the engine before this experiment. An honest A/B
 *      needs a control arm that is not merely "close".
 *   2. Each mechanism does exactly what it claims, and nothing else.
 *   3. Everything is deterministic: same construction + same excitation
 *      sequence => identical phases and amplitudes, every run.
 *   4. Out-of-range knobs are refused loudly, never clamped into a
 *      different experiment than the one that was asked for.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  NonFiniteValueError,
  PrimeOscillatorField,
  SemanticKernel,
  SemanticObserver,
  type PrimeOscillatorFieldOptions,
  type SemanticObserverOptions
} from '../../src/semantic';
import { freshKernel } from './helpers';

const PRIME_COUNT = 32;
/** A word-sized signature: a few primes out of the basis. */
const SIGNATURE = [2, 7, 19, 41];

describe('PrimeOscillatorField competition (P12)', () => {
  let kernel: SemanticKernel;

  beforeAll(async () => {
    kernel = await freshKernel();
  });

  type CompetitionOptions = Pick<
    PrimeOscillatorFieldOptions,
    'activationBudget' | 'inhibition' | 'winnerTakeAll'
  >;

  async function build(options: CompetitionOptions = {}): Promise<PrimeOscillatorField> {
    const field = new PrimeOscillatorField({ primeCount: PRIME_COUNT, kernel, ...options });
    await field.initialize();
    return field;
  }

  /** Excite a signature and let the field run, the way the observer does. */
  function run(
    field: PrimeOscillatorField,
    ticks = 30,
    dt = 0.05,
    primes: readonly number[] = SIGNATURE
  ): void {
    field.excite(primes, 0.6);
    for (let i = 0; i < ticks; i += 1) field.tick(dt);
  }

  // ── 1. The default IS the control ──────────────────────────────────────

  it('defaults to no competition at all', async () => {
    const field = await build();
    expect(field.competition).toEqual({ activationBudget: 0, inhibition: 0, winnerTakeAll: 0 });
  });

  it('a below-budget field is untouched: the budget is a ceiling, not a rescale', async () => {
    const control = await build();
    // The settled field carries well under 100 total amplitude, so a budget
    // of 100 can never bind — the two arms must agree exactly.
    const generous = await build({ activationBudget: 100 });
    run(control);
    run(generous);
    expect(generous.getAmplitudes()).toEqual(control.getAmplitudes());
    expect(generous.getPhases()).toEqual(control.getPhases());
  });

  it('k-winner-take-all at or above the oscillator count is a no-op', async () => {
    const control = await build();
    const wide = await build({ winnerTakeAll: PRIME_COUNT });
    run(control);
    run(wide);
    expect(wide.getAmplitudes()).toEqual(control.getAmplitudes());
    expect(wide.getPhases()).toEqual(control.getPhases());
  });

  it('the inhibitory sweep reproduces the control EXACTLY on a trivial partition', async () => {
    // The mechanism only distinguishes ACROSS activity groups. Excite the
    // whole basis and every oscillator is in one group, so even maximal
    // inhibition must reproduce tinyaleph's own Kuramoto tick bit-for-bit.
    // This is the structural proof that the replacement sweep differs from
    // the model's only in the pairwise weight — not in its integration
    // order, its K/N scaling, or its dissipation.
    const control = await build();
    const inhibited = await build({ inhibition: 1 });
    run(control, 20, 0.05, control.primes);
    run(inhibited, 20, 0.05, inhibited.primes);
    expect(inhibited.getPhases()).toEqual(control.getPhases());
    expect(inhibited.getAmplitudes()).toEqual(control.getAmplitudes());
  });

  it('the inhibitory sweep reproduces the control EXACTLY on a quiescent field', async () => {
    const control = await build();
    const inhibited = await build({ inhibition: 1 });
    for (let i = 0; i < 10; i += 1) {
      control.tick(0.05);
      inhibited.tick(0.05);
    }
    expect(inhibited.getPhases()).toEqual(control.getPhases());
  });

  // ── 2. (a) Divisive normalization ──────────────────────────────────────

  it('divisive normalization holds total excitation at the budget', async () => {
    const field = await build({ activationBudget: 1 });
    for (let round = 0; round < 5; round += 1) {
      field.excite(field.primes, 0.9); // drive the whole basis hard
      for (let i = 0; i < 5; i += 1) {
        field.tick(0.05);
        expect(field.getState().totalAmplitude).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
    // It is a real ceiling, not a collapse: the field is still active.
    expect(field.getState().totalAmplitude).toBeGreaterThan(0.5);
  });

  it('divisive normalization preserves the amplitude RATIOS it rescales', async () => {
    const field = await build({ activationBudget: 0.5 });
    field.excite([2], 0.9);
    field.excite([3], 0.3);
    field.tick(0.05);
    const amplitudes = field.getAmplitudes();
    const total = amplitudes.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(0.5, 9);
    // Competition here is for SHARE of a fixed budget: the ratio between two
    // co-active primes is exactly what it was before the rescale.
    expect(amplitudes[0] / amplitudes[1]).toBeCloseTo(0.9 / 0.3, 6);
  });

  it('divisive normalization never inflates a quiescent field into activity', async () => {
    const field = await build({ activationBudget: 4 });
    for (let i = 0; i < 5; i += 1) field.tick(0.05);
    expect(field.getState().totalAmplitude).toBe(0);
  });

  // ── 3. (b) Inhibitory coupling ─────────────────────────────────────────

  it('inhibition pushes the excited group away from the silent background', async () => {
    // The claim: locking one group actively suppresses the phase agreement
    // of everything else. Measured as the circular distance between the two
    // groups' mean phases — 0 is a global mode, π is full anti-phase.
    const gaps: number[] = [];
    for (const inhibition of [0, 0.5, 1]) {
      const field = await build({ inhibition });
      run(field, 40, 0.05);
      const state = field.getState();
      const active: number[] = [];
      const silent: number[] = [];
      for (let i = 0; i < state.amplitudes.length; i += 1) {
        (state.amplitudes[i] >= 0.05 ? active : silent).push(state.phases[i]);
      }
      expect(active.length).toBe(SIGNATURE.length);
      expect(silent.length).toBeGreaterThan(0);
      gaps.push(circularGap(circularMean(active), circularMean(silent)));
    }
    // Monotone in the inhibition strength, and materially wider than the
    // uncompeted control at full strength.
    expect(gaps[1]).toBeGreaterThan(gaps[0]);
    expect(gaps[2]).toBeGreaterThan(gaps[1]);
    expect(gaps[2] - gaps[0]).toBeGreaterThan(0.5);
  });

  it('inhibition leaves amplitudes alone — it is a coupling, not a gain', async () => {
    const control = await build();
    const inhibited = await build({ inhibition: 1 });
    run(control);
    run(inhibited);
    // Decay is amplitude-only and identical on both paths; only phases move.
    expect(inhibited.getAmplitudes()).toEqual(control.getAmplitudes());
    expect(inhibited.getPhases()).not.toEqual(control.getPhases());
  });

  it('inhibition barely acts on the STORE path: one tick after a settle is not enough', async () => {
    // The honest structural limit of mechanism (b) in this engine. `reset()`
    // puts every phase at 0, so on the first tick sin(φⱼ − φᵢ) is 0 for the
    // first oscillator and only grows as the in-place sweep moves earlier
    // phases: the coupling term — inhibitory or not — has essentially no
    // room to act. The teacher stores every trace exactly one tick after a
    // settle, so a STORED trace cannot see this mechanism, while the recall
    // path (which settles for five ticks) can.
    const storePath = await inhibitionPhaseDelta([0.02]);
    const recallPath = await inhibitionPhaseDelta([0.02, 0.05, 0.05, 0.05, 0.05]);
    expect(storePath).toBeLessThan(1e-3);
    // More than an order of magnitude between "cannot act" and "acts".
    expect(recallPath).toBeGreaterThan(storePath * 20);
  });

  /**
   * Max |Δphase| between an uninhibited and a fully inhibited field on the
   * PRODUCTION basis (256 oscillators), which is the configuration the
   * benchmark and docs quote.
   */
  async function inhibitionPhaseDelta(steps: readonly number[]): Promise<number> {
    const control = new PrimeOscillatorField({ primeCount: 256, kernel });
    const inhibited = new PrimeOscillatorField({ primeCount: 256, kernel, inhibition: 1 });
    await control.initialize();
    await inhibited.initialize();
    control.excite(SIGNATURE, 0.6);
    inhibited.excite(SIGNATURE, 0.6);
    for (const dt of steps) {
      control.tick(dt);
      inhibited.tick(dt);
    }
    const a = control.getPhases();
    const b = inhibited.getPhases();
    let max = 0;
    for (let i = 0; i < a.length; i += 1) max = Math.max(max, Math.abs(a[i] - b[i]));
    return max;
  }

  // ── 4. (c) k-winner-take-all ───────────────────────────────────────────

  it('k-winner-take-all keeps exactly the k largest amplitudes', async () => {
    const field = await build({ winnerTakeAll: 3 });
    field.excite([2, 3, 5, 7, 11], 0.2);
    field.excite([2], 0.5); // 2 is the clear winner
    field.excite([3], 0.3);
    field.tick(0.05);
    const amplitudes = field.getAmplitudes();
    const survivors = amplitudes.map((a, i) => ({ a, i })).filter((x) => x.a > 0);
    expect(survivors).toHaveLength(3);
    // Oscillator index 0/1/2 are primes 2/3/5 — the three biggest injections.
    expect(survivors.map((s) => s.i)).toEqual([0, 1, 2]);
  });

  it('k-winner-take-all sparsifies the field it hands to memory', async () => {
    const control = await build();
    const wta = await build({ winnerTakeAll: 4 });
    run(control, 20, 0.05, control.primes);
    run(wta, 20, 0.05, wta.primes);
    expect(control.getState().activeIndices.length).toBe(PRIME_COUNT);
    expect(wta.getState().activeIndices.length).toBe(4);
  });

  it('k-winner-take-all breaks ties deterministically by oscillator index', async () => {
    const field = await build({ winnerTakeAll: 2 });
    // Four oscillators at EXACTLY the same amplitude: the winner set must be
    // the two lowest indices, not whatever the sort happens to produce.
    field.excite([2, 3, 5, 7], 0.5);
    field.tick(0.05);
    const survivors = field
      .getAmplitudes()
      .map((a, i) => ({ a, i }))
      .filter((x) => x.a > 0)
      .map((x) => x.i);
    expect(survivors).toEqual([0, 1]);
  });

  // ── 5. Determinism ─────────────────────────────────────────────────────

  it('every variant is deterministic across identical runs', async () => {
    const variants: CompetitionOptions[] = [
      {},
      { activationBudget: 1 },
      { inhibition: 1 },
      { winnerTakeAll: 4 },
      { activationBudget: 1, inhibition: 0.5, winnerTakeAll: 8 }
    ];
    for (const options of variants) {
      const a = await build(options);
      const b = await build(options);
      for (let round = 0; round < 4; round += 1) {
        a.excite(SIGNATURE, 0.6);
        b.excite(SIGNATURE, 0.6);
        a.excite([3, 5], 0.25);
        b.excite([3, 5], 0.25);
        for (let i = 0; i < 8; i += 1) {
          a.tick(0.05);
          b.tick(0.05);
        }
      }
      expect(b.getPhases()).toEqual(a.getPhases());
      expect(b.getAmplitudes()).toEqual(a.getAmplitudes());
    }
  });

  it('competition survives snapshot/restore exactly', async () => {
    const field = await build({ activationBudget: 1, inhibition: 1, winnerTakeAll: 8 });
    run(field, 10);
    const snapshot = field.snapshot();
    run(field, 10);
    field.restore(snapshot);
    expect(field.getPhases()).toEqual([...snapshot.phases]);
    expect(field.getAmplitudes()).toEqual([...snapshot.amplitudes]);
  });

  // ── 6. Validation ──────────────────────────────────────────────────────

  it('refuses out-of-range competition knobs instead of clamping them', () => {
    expect(() => new PrimeOscillatorField({ inhibition: 1.5, kernel })).toThrow(NonFiniteValueError);
    expect(() => new PrimeOscillatorField({ inhibition: -0.1, kernel })).toThrow(NonFiniteValueError);
    expect(() => new PrimeOscillatorField({ inhibition: NaN, kernel })).toThrow(NonFiniteValueError);
    expect(() => new PrimeOscillatorField({ activationBudget: -1, kernel })).toThrow(NonFiniteValueError);
    expect(() => new PrimeOscillatorField({ activationBudget: NaN, kernel })).toThrow(NonFiniteValueError);
    expect(() => new PrimeOscillatorField({ winnerTakeAll: -1, kernel })).toThrow(NonFiniteValueError);
    expect(() => new PrimeOscillatorField({ winnerTakeAll: Infinity, kernel })).toThrow(NonFiniteValueError);
    // The boundaries themselves are legal.
    expect(new PrimeOscillatorField({ inhibition: 0, kernel }).competition.inhibition).toBe(0);
    expect(new PrimeOscillatorField({ inhibition: 1, kernel }).competition.inhibition).toBe(1);
    // k is an oscillator count, so it truncates rather than fabricating a
    // fractional winner set.
    expect(new PrimeOscillatorField({ winnerTakeAll: 3.9, kernel }).competition.winnerTakeAll).toBe(3);
  });
});

function circularMean(phases: readonly number[]): number {
  let sx = 0;
  let sy = 0;
  for (const phase of phases) {
    sx += Math.cos(phase);
    sy += Math.sin(phase);
  }
  return Math.atan2(sy, sx);
}

function circularGap(a: number, b: number): number {
  let delta = Math.abs(a - b) % (2 * Math.PI);
  if (delta > Math.PI) delta = 2 * Math.PI - delta;
  return delta;
}

// ═══════════════════════════════════════════════════════════════════════════
// THREADING: the knobs must reach the field through SemanticObserverOptions
// ═══════════════════════════════════════════════════════════════════════════

describe('SemanticObserver competition options (P12)', () => {
  let kernel: SemanticKernel;

  beforeAll(async () => {
    kernel = await freshKernel();
  });

  async function observer(options: Partial<SemanticObserverOptions> = {}): Promise<SemanticObserver> {
    const instance = new SemanticObserver({ primeCount: 32, gridSize: 64, kernel, ...options });
    await instance.initialize();
    return instance;
  }

  it('defaults to the control: no competition anywhere in the stack', async () => {
    const instance = await observer();
    expect(instance.getOscillatorField().competition).toEqual({
      activationBudget: 0,
      inhibition: 0,
      winnerTakeAll: 0
    });
    instance.dispose();
  });

  it('threads every knob through to the oscillator field', async () => {
    const instance = await observer({ activationBudget: 2, inhibition: 0.75, winnerTakeAll: 6 });
    expect(instance.getOscillatorField().competition).toEqual({
      activationBudget: 2,
      inhibition: 0.75,
      winnerTakeAll: 6
    });
    instance.dispose();
  });

  it('a bad knob fails at construction, not silently mid-run', () => {
    expect(() => new SemanticObserver({ primeCount: 32, gridSize: 64, kernel, inhibition: 2 })).toThrow(
      NonFiniteValueError
    );
    expect(() => new SemanticObserver({ primeCount: 32, gridSize: 64, kernel, activationBudget: -1 })).toThrow(
      NonFiniteValueError
    );
  });

  it('k-winner-take-all constrains what the observer stores', async () => {
    const control = await observer();
    const wta = await observer({ winnerTakeAll: 4 });
    for (const instance of [control, wta]) {
      instance.processInput('alpha beta gamma delta epsilon', 0.6);
      instance.tick(0.02);
    }
    // The observer's own readout, not the field's: the state that reaches
    // the SMF, the hologram and the memory bank is the sparsified one.
    expect(wta.getState().activePrimeCount).toBeLessThanOrEqual(4);
    expect(control.getState().activePrimeCount).toBeGreaterThan(4);
    control.dispose();
    wta.dispose();
  });

  it('the activation budget caps the total amplitude the observer carries', async () => {
    const instance = await observer({ activationBudget: 0.5 });
    for (let round = 0; round < 5; round += 1) {
      instance.processInput('alpha beta gamma delta epsilon', 0.9);
      instance.tick(0.02);
      expect(instance.getState().totalAmplitude).toBeLessThanOrEqual(0.5 + 1e-9);
    }
    instance.dispose();
  });
});
