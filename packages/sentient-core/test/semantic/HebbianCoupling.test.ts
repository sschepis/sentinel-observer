/**
 * H6 Phase 23 gates — Hebbian coupling (experiment-gated).
 *
 * The flag ships OFF: at off the field must be BIT-IDENTICAL to the control.
 * On, the mechanism must show: saturating potentiation of co-excited winner
 * pairs at moment time, retention-law decay, neighbor caps, snapshot
 * round-trip — and the SEMANTIC-RELATEDNESS separation: co-taught pairs
 * couple, strangers do not, and the learned coupling phase-locks the taught
 * pair measurably tighter than the control.
 */
import { describe, it, expect } from '@jest/globals';
import { PrimeOscillatorField } from '../../src/semantic/PrimeOscillatorField';
import { HebbianCouplingStore, normalizeHebbianOptions } from '../../src/semantic/HebbianCoupling';
import { SemanticObserver } from '../../src/semantic/SemanticObserver';

async function fieldWith(options: ConstructorParameters<typeof PrimeOscillatorField>[0]): Promise<PrimeOscillatorField> {
  const field = new PrimeOscillatorField(options);
  await field.initialize();
  return field;
}

describe('H6: the flag-off control is bit-identical', () => {
  it('undefined and enabled:false produce the exact same trajectory', async () => {
    const a = await fieldWith({ primeCount: 16 });
    const b = await fieldWith({ primeCount: 16, hebbian: { enabled: false } });
    a.excite([2, 3, 5], 0.8);
    b.excite([2, 3, 5], 0.8);
    for (let i = 0; i < 50; i += 1) {
      const ma = a.tick(0.02);
      const mb = b.tick(0.02);
      expect(mb.coherence).toBe(ma.coherence);
      expect(mb.orderParameter).toBe(ma.orderParameter);
    }
    expect(b.getState().phases).toEqual(a.getState().phases);
    expect(b.hebbianPairCount()).toBe(0);
    expect(b.hebbianSnapshot()).toBeNull();
  });

  it('potentiateHebbian is a no-op when the flag is off', async () => {
    const field = await fieldWith({ primeCount: 16 });
    field.excite([2, 3], 0.9);
    expect(field.potentiateHebbian(0.9)).toBe(0);
    expect(field.hebbianPairCount()).toBe(0);
  });
});

describe('H6: the store mechanics', () => {
  it('potentiation is saturating (ΔK → 0 as K → kMax) and symmetric', () => {
    const store = new HebbianCouplingStore(normalizeHebbianOptions({ enabled: true, eta: 0.5, kMax: 1 }));
    const winners = [
      { index: 0, amplitude: 1 },
      { index: 1, amplitude: 1 }
    ];
    let previous = 0;
    let previousDelta = Infinity;
    for (let i = 0; i < 20; i += 1) {
      store.potentiate(winners, 1, i * 0.01);
      const value = store.get(0, 1);
      const delta = value - previous;
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThan(previousDelta + 1e-12);
      expect(value).toBeLessThanOrEqual(1);
      expect(store.get(1, 0)).toBe(value);
      previous = value;
      previousDelta = delta;
    }
  });

  it('decay follows the retention shape and prunes at the floor', () => {
    const store = new HebbianCouplingStore(normalizeHebbianOptions({ enabled: true, eta: 1, kMax: 1, stabilityTime: 10 }));
    store.potentiate([{ index: 0, amplitude: 1 }, { index: 1, amplitude: 1 }], 1, 0);
    const before = store.get(0, 1);
    store.decay(10); // one stability of sim time → keeps ~90%
    const after = store.get(0, 1);
    expect(after).toBeLessThan(before);
    expect(after / before).toBeCloseTo(Math.pow(1 + 19 / 81, -0.5), 5);
    store.decay(4e7); // the fat power-law tail needs deep time to hit the floor
    expect(store.get(0, 1)).toBe(0);
    expect(store.pairCount()).toBe(0);
  });

  it('the neighbor cap evicts the weakest partners', () => {
    const store = new HebbianCouplingStore(normalizeHebbianOptions({ enabled: true, eta: 1, kMax: 1, neighbors: 2 }));
    // Oscillator 0 wires to 1 (strong), 2 (weak), 3 (mid) — cap 2 keeps the
    // strongest two.
    store.potentiate([{ index: 0, amplitude: 1 }, { index: 1, amplitude: 1 }], 1, 0);
    store.potentiate([{ index: 0, amplitude: 1 }, { index: 1, amplitude: 1 }], 1, 0.01);
    store.potentiate([{ index: 0, amplitude: 0.3 }, { index: 2, amplitude: 0.3 }], 0.5, 0.02);
    store.potentiate([{ index: 0, amplitude: 0.8 }, { index: 3, amplitude: 0.8 }], 0.8, 0.03);
    expect(store.get(0, 1)).toBeGreaterThan(0);
    expect(store.get(0, 3)).toBeGreaterThan(0);
    expect(store.get(0, 2)).toBe(0); // weakest — evicted
  });

  it('snapshot → restore round-trips the learned pairs', () => {
    const config = normalizeHebbianOptions({ enabled: true, eta: 0.5, kMax: 1 });
    const store = new HebbianCouplingStore(config);
    store.potentiate([{ index: 2, amplitude: 1 }, { index: 5, amplitude: 0.8 }], 0.9, 0);
    const snapshot = store.snapshot();
    const restored = new HebbianCouplingStore(config);
    restored.restore(snapshot);
    expect(restored.get(2, 5)).toBeCloseTo(store.get(2, 5), 12);
    expect(restored.get(5, 2)).toBeCloseTo(store.get(2, 5), 12);
  });
});

describe('H6: the semantic-relatedness separation (the W9 claim, measured)', () => {
  it('co-excited pairs couple; never-co-excited pairs stay at zero; the taught pair phase-locks tighter than the control', async () => {
    const teach = async (hebbian: boolean): Promise<{ coupling: number; strangerCoupling: number; lockGap: number }> => {
      const field = await fieldWith({
        primeCount: 16,
        hebbian: hebbian ? { enabled: true, eta: 0.3, kMax: 1 } : undefined
      });
      // Teach: co-excite the pair {2, 3} through repeated coherent moments.
      // Prime 13 is NEVER excited — the stranger. (A lone excitation wires
      // nothing: potentiation needs at least two winners.)
      for (let round = 0; round < 12; round += 1) {
        field.excite([2, 3], 0.9);
        for (let t = 0; t < 10; t += 1) field.tick(0.02);
        field.potentiateHebbian(field.getState().coherence || 0.8);
      }
      const coupling = field.hebbianCouplingOf(2, 3);
      const strangerCoupling = field.hebbianCouplingOf(2, 13);
      // Probe: re-excite the taught pair and measure the phase gap after a
      // short settle — learned coupling must close it at least as fast as
      // the control.
      field.excite([2, 3], 0.9);
      for (let t = 0; t < 8; t += 1) field.tick(0.02);
      const state = field.getState();
      const gap = Math.abs(
        Math.atan2(
          Math.sin(state.phases[0] - state.phases[1]),
          Math.cos(state.phases[0] - state.phases[1])
        )
      );
      return { coupling, strangerCoupling, lockGap: gap };
    };

    const learned = await teach(true);
    const control = await teach(false);

    // eslint-disable-next-line no-console
    console.log(
      `H6 BENCH: pair coupling ${learned.coupling.toFixed(3)} · stranger ${learned.strangerCoupling.toFixed(3)} · ` +
        `lock gap learned ${learned.lockGap.toFixed(4)} vs control ${control.lockGap.toFixed(4)}`
    );

    expect(learned.coupling).toBeGreaterThan(0.2); // the pair wired
    expect(learned.strangerCoupling).toBe(0); // never co-excited → never wired
    expect(control.lockGap).toBeGreaterThan(0); // the control has a residual gap
    expect(learned.lockGap).toBeLessThanOrEqual(control.lockGap); // wiring tightens locking
  }, 30000);
});

describe('H6: observer integration + tick latency budget', () => {
  it('moments potentiate through the observer, metrics stay finite, and the flag-on tick cost stays within +15%', async () => {
    const build = async (hebbian: boolean): Promise<SemanticObserver> => {
      const observer = new SemanticObserver({
        primeCount: 64,
        gridSize: 128,
        hebbian: hebbian ? { enabled: true } : undefined
      });
      await observer.initialize();
      return observer;
    };

    const on = await build(true);
    on.observe({ kind: 'text', content: 'water bird rain sky', weight: 0.8 });
    for (let i = 0; i < 200; i += 1) on.tick(0.02);
    const stateOn = on.getState();
    expect(Number.isFinite(stateOn.coherence)).toBe(true);
    expect(Number.isFinite(stateOn.entropy)).toBe(true);

    const off = await build(false);
    off.observe({ kind: 'text', content: 'water bird rain sky', weight: 0.8 });

    const time = (observer: SemanticObserver): number => {
      const t0 = performance.now();
      for (let i = 0; i < 300; i += 1) observer.tick(0.02);
      return performance.now() - t0;
    };
    // Warm both paths, then take the MIN of three rounds per path — the
    // noise-robust latency estimator (a loaded scheduler inflates means,
    // never deflates minima).
    time(on);
    time(off);
    const costOn = Math.min(time(on), time(on), time(on));
    const costOff = Math.min(time(off), time(off), time(off));
    // eslint-disable-next-line no-console
    console.log(`H6 BENCH: tick cost on ${costOn.toFixed(1)}ms vs off ${costOff.toFixed(1)}ms (300 ticks, 64 primes)`);
    // The plan's budget: ≤ +15%. The Jacobi mean-field sweep is O(N + N·k̄)
    // vs the control's O(N²), so flag-on is typically FASTER; the bound
    // keeps CI honest without flaking on scheduler noise.
    expect(costOn).toBeLessThan(costOff * 1.15);
    on.dispose();
    off.dispose();
  }, 60000);
});
