/**
 * PHASE-CLUSTER METRIC tests.
 *
 * `phaseClusterMetrics` is the partial-synchronization readout that the
 * opt-in `momentCriterion: 'phase-clusters'` gates on. It must be
 * DETERMINISTIC (same input, same output, no randomness, no iteration order
 * dependence), BOUNDED (every order parameter in [0, 1], counts integral),
 * and it must refuse fabricated readings the way the rest of the field does.
 *
 * The exact definition it is tested against is documented on the function.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  NonFiniteValueError,
  PrimeOscillatorField,
  phaseClusterMetrics,
  PHASE_CLUSTER_DEFAULTS,
  SemanticKernel
} from '../../src/semantic';
import { freshKernel } from './helpers';

const TWO_PI = Math.PI * 2;

/** Amplitudes that make every entry active under the default threshold. */
function allActive(n: number): number[] {
  return new Array<number>(n).fill(1);
}

describe('phaseClusterMetrics', () => {
  // ── Quiescence ─────────────────────────────────────────────────────────

  it('reports the quiescent zero reading when nothing is active', () => {
    const metrics = phaseClusterMetrics([0, 1, 2], [0, 0, 0]);
    expect(metrics).toEqual({
      clusterCount: 0,
      withinR: 0,
      betweenR: 0,
      activeCount: 0,
      sizes: [],
      signature: ''
    });
  });

  it('ignores oscillators below the active threshold', () => {
    // Two phases 180 degrees apart, but only one is active.
    const metrics = phaseClusterMetrics([0, Math.PI], [1, 0.01], { activeThreshold: 0.05 });
    expect(metrics.activeCount).toBe(1);
    expect(metrics.clusterCount).toBe(1);
    expect(metrics.withinR).toBeCloseTo(1, 12);
  });

  it('treats a non-finite amplitude as inactive rather than guessing', () => {
    const metrics = phaseClusterMetrics([0, Math.PI], [1, Number.NaN]);
    expect(metrics.activeCount).toBe(1);
  });

  it('refuses a non-finite phase on an ACTIVE oscillator', () => {
    expect(() => phaseClusterMetrics([0, Number.NaN], [1, 1])).toThrow(NonFiniteValueError);
    // ...but not when that oscillator is quiescent: it was never a reading.
    expect(() => phaseClusterMetrics([0, Number.NaN], [1, 0])).not.toThrow();
  });

  // ── Single cluster (the global-sync regime) ────────────────────────────

  it('a fully synchronized field is ONE cluster with withinR = 1, betweenR = 1', () => {
    const metrics = phaseClusterMetrics([0.3, 0.3, 0.3, 0.3], allActive(4));
    expect(metrics.clusterCount).toBe(1);
    expect(metrics.withinR).toBeCloseTo(1, 12);
    // One cluster reports betweenR = 1 BY CONSTRUCTION: there is no
    // separation to measure, so it can never satisfy a maxBetweenR gate.
    expect(metrics.betweenR).toBe(1);
    expect(metrics.sizes).toEqual([4]);
  });

  it('with one cluster, withinR equals the GLOBAL order parameter R', () => {
    const phases = [0.05, 0.1, 0.12, 0.2, 0.22];
    let sx = 0;
    let sy = 0;
    for (const p of phases) {
      sx += Math.cos(p);
      sy += Math.sin(p);
    }
    const globalR = Math.hypot(sx, sy) / phases.length;
    const metrics = phaseClusterMetrics(phases, allActive(phases.length), { phaseBins: 12 });
    expect(metrics.clusterCount).toBe(1);
    expect(metrics.withinR).toBeCloseTo(globalR, 12);
  });

  it('every bin occupied means no separating gap: one cluster, not B clusters', () => {
    const bins = 8;
    // One oscillator dead-centre in each of the 8 bins.
    const phases = Array.from({ length: bins }, (_, b) => ((b + 0.5) / bins) * TWO_PI);
    const metrics = phaseClusterMetrics(phases, allActive(bins), { phaseBins: bins });
    expect(metrics.clusterCount).toBe(1);
    expect(metrics.activeCount).toBe(bins);
    expect(metrics.betweenR).toBe(1);
  });

  // ── Multi-cluster (the chimera regime) ─────────────────────────────────

  it('two tight antipodal groups: k=2, withinR = 1, betweenR = 0', () => {
    const metrics = phaseClusterMetrics(
      [0, 0, 0, Math.PI, Math.PI, Math.PI],
      allActive(6),
      { phaseBins: 12 }
    );
    expect(metrics.clusterCount).toBe(2);
    expect(metrics.withinR).toBeCloseTo(1, 12);
    // Equal-size antipodal centroids cancel exactly.
    expect(metrics.betweenR).toBeCloseTo(0, 12);
    expect(metrics.sizes).toEqual([3, 3]);
    // The global order parameter calls this state INCOHERENT (R = 0) while
    // the ensemble is perfectly organized — this is the whole point.
    expect(Math.hypot(3 * Math.cos(0) + 3 * Math.cos(Math.PI), 0) / 6).toBeCloseTo(0, 12);
  });

  it('three evenly spaced tight groups: k=3, withinR = 1, betweenR = 0', () => {
    const phases = [0, 0, TWO_PI / 3, TWO_PI / 3, (2 * TWO_PI) / 3, (2 * TWO_PI) / 3];
    const metrics = phaseClusterMetrics(phases, allActive(6), { phaseBins: 12 });
    expect(metrics.clusterCount).toBe(3);
    expect(metrics.withinR).toBeCloseTo(1, 12);
    expect(metrics.betweenR).toBeCloseTo(0, 12);
    expect(metrics.sizes).toEqual([2, 2, 2]);
  });

  it('withinR is SIZE-WEIGHTED, not a plain mean over clusters', () => {
    // Cluster A: 4 oscillators at one phase (R = 1).
    // Cluster B: 2 oscillators split across the same bin at +/- 0.2 rad.
    const spread = 0.2;
    const phases = [0, 0, 0, 0, Math.PI - spread, Math.PI + spread];
    const metrics = phaseClusterMetrics(phases, allActive(6), { phaseBins: 12 });
    expect(metrics.clusterCount).toBe(2);
    const rB = Math.cos(spread); // |e^{-is} + e^{+is}| / 2 = cos(s)
    const expected = (4 * 1 + 2 * rB) / 6;
    expect(metrics.withinR).toBeCloseTo(expected, 12);
    // A plain per-cluster mean would be (1 + rB) / 2 — measurably different.
    expect(metrics.withinR).not.toBeCloseTo((1 + rB) / 2, 6);
  });

  it('betweenR is SIZE-WEIGHTED over cluster mean phases', () => {
    // 5 at phase 0, 1 at phase pi. Centroids are antipodal but unequal, so
    // the between-cluster resultant is |5 - 1| / 6.
    const phases = [0, 0, 0, 0, 0, Math.PI];
    const metrics = phaseClusterMetrics(phases, allActive(6), { phaseBins: 12 });
    expect(metrics.clusterCount).toBe(2);
    expect(metrics.betweenR).toBeCloseTo(4 / 6, 12);
  });

  // ── Determinism ────────────────────────────────────────────────────────

  it('is invariant to a global phase rotation that does not cross a bin edge', () => {
    const base = [0.02, 0.03, Math.PI + 0.02, Math.PI + 0.03];
    const a = phaseClusterMetrics(base, allActive(4), { phaseBins: 4 });
    const b = phaseClusterMetrics(
      base.map(p => p + 0.01),
      allActive(4),
      { phaseBins: 4 }
    );
    expect(b.clusterCount).toBe(a.clusterCount);
    expect(b.sizes).toEqual(a.sizes);
    expect(b.withinR).toBeCloseTo(a.withinR, 12);
    expect(b.betweenR).toBeCloseTo(a.betweenR, 12);
  });

  it('is invariant to the ORDER the oscillators are listed in', () => {
    const phases = [0.1, Math.PI, 0.2, Math.PI + 0.1, 0.15];
    const forward = phaseClusterMetrics(phases, allActive(5), { phaseBins: 12 });
    const reversed = phaseClusterMetrics([...phases].reverse(), allActive(5), { phaseBins: 12 });
    expect(reversed.clusterCount).toBe(forward.clusterCount);
    expect(reversed.withinR).toBeCloseTo(forward.withinR, 12);
    expect(reversed.betweenR).toBeCloseTo(forward.betweenR, 12);
    // Sizes are reported in scan order, which is phase order, not input order.
    expect([...reversed.sizes].sort()).toEqual([...forward.sizes].sort());
  });

  it('does not depend on where a run wraps around 2pi', () => {
    // The same two groups (each an identical 0.02 rad pair), once away from
    // the wrap and once straddling it.
    const inner = phaseClusterMetrics(
      [Math.PI / 2 - 0.01, Math.PI / 2 + 0.01, Math.PI * 1.5 - 0.01, Math.PI * 1.5 + 0.01],
      allActive(4),
      { phaseBins: 12 }
    );
    const wrapped = phaseClusterMetrics(
      [TWO_PI - 0.01, 0.01, Math.PI - 0.01, Math.PI + 0.01],
      allActive(4),
      { phaseBins: 12 }
    );
    expect(wrapped.clusterCount).toBe(inner.clusterCount);
    expect(wrapped.sizes).toEqual(inner.sizes);
    expect(wrapped.withinR).toBeCloseTo(inner.withinR, 10);
    expect(wrapped.betweenR).toBeCloseTo(inner.betweenR, 10);
  });

  it('is invariant to adding whole turns to a phase', () => {
    const base = [0.4, 0.4, Math.PI, Math.PI];
    const shifted = [0.4 + TWO_PI * 3, 0.4 - TWO_PI * 2, Math.PI + TWO_PI, Math.PI - TWO_PI * 4];
    const a = phaseClusterMetrics(base, allActive(4), { phaseBins: 12 });
    const b = phaseClusterMetrics(shifted, allActive(4), { phaseBins: 12 });
    expect(b.signature).toBe(a.signature);
    expect(b.withinR).toBeCloseTo(a.withinR, 10);
    expect(b.betweenR).toBeCloseTo(a.betweenR, 10);
  });

  it('returns identical results across repeated calls (no hidden state)', () => {
    const phases = [0.1, 0.2, 3.0, 3.1, 5.5];
    const first = phaseClusterMetrics(phases, allActive(5));
    for (let i = 0; i < 5; i++) {
      expect(phaseClusterMetrics(phases, allActive(5))).toEqual(first);
    }
  });

  // ── Bounds ─────────────────────────────────────────────────────────────

  it('keeps every reading bounded and integral over randomized inputs', () => {
    // Deterministic LCG — a fixed sweep, not a flaky random test.
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 400; trial++) {
      const n = 1 + Math.floor(next() * 40);
      const phases = Array.from({ length: n }, () => (next() - 0.5) * 40);
      const amplitudes = Array.from({ length: n }, () => next());
      const bins = 2 + Math.floor(next() * 40);
      const m = phaseClusterMetrics(phases, amplitudes, { phaseBins: bins, activeThreshold: 0.05 });
      expect(m.withinR).toBeGreaterThanOrEqual(0);
      expect(m.withinR).toBeLessThanOrEqual(1);
      expect(m.betweenR).toBeGreaterThanOrEqual(0);
      expect(m.betweenR).toBeLessThanOrEqual(1);
      expect(Number.isInteger(m.clusterCount)).toBe(true);
      expect(Number.isInteger(m.activeCount)).toBe(true);
      expect(m.clusterCount).toBeLessThanOrEqual(Math.min(m.activeCount, Math.ceil(bins / 2)));
      expect(m.sizes.reduce((s, v) => s + v, 0)).toBe(m.activeCount);
      expect(m.clusterCount).toBe(m.sizes.length);
    }
  });

  it('clamps the bin count instead of accepting a degenerate one', () => {
    const phases = [0, Math.PI];
    const amps = allActive(2);
    // Below the floor, every value behaves exactly as the clamped value 2.
    // At B = 2 the two phases occupy BOTH bins, leaving no empty bin, so the
    // documented consequence is ONE cluster: two bins cannot resolve two
    // groups because a separating gap needs a third bin.
    const floor = phaseClusterMetrics(phases, amps, { phaseBins: 2 });
    expect(phaseClusterMetrics(phases, amps, { phaseBins: 0 })).toEqual(floor);
    expect(phaseClusterMetrics(phases, amps, { phaseBins: 1 })).toEqual(floor);
    expect(phaseClusterMetrics(phases, amps, { phaseBins: -7 })).toEqual(floor);
    expect(floor.clusterCount).toBe(1);
    // Four bins DO resolve them (B = 3 still lands them in ADJACENT bins,
    // which is one run: the resolution is a property of the binning, and it
    // is reported honestly rather than assumed).
    expect(phaseClusterMetrics(phases, amps, { phaseBins: 3 }).clusterCount).toBe(1);
    expect(phaseClusterMetrics(phases, amps, { phaseBins: 4 }).clusterCount).toBe(2);
    // Above the ceiling, every value behaves exactly as the clamped value 360.
    const ceiling = phaseClusterMetrics(phases, amps, { phaseBins: 360 });
    expect(phaseClusterMetrics(phases, amps, { phaseBins: 1e9 })).toEqual(ceiling);
    expect(ceiling.clusterCount).toBe(2);
    expect(() => phaseClusterMetrics(phases, amps, { phaseBins: Number.NaN })).toThrow(
      NonFiniteValueError
    );
    expect(() => phaseClusterMetrics(phases, amps, { activeThreshold: Number.NaN })).toThrow(
      NonFiniteValueError
    );
  });

  it('uses the documented defaults', () => {
    expect(PHASE_CLUSTER_DEFAULTS.phaseBins).toBe(12);
    expect(PHASE_CLUSTER_DEFAULTS.activeThreshold).toBe(0.05);
  });

  it('reads only the entries both arrays cover', () => {
    const m = phaseClusterMetrics([0, Math.PI, Math.PI / 2], [1, 1]);
    expect(m.activeCount).toBe(2);
  });

  // ── Signature ──────────────────────────────────────────────────────────

  it('the signature identifies the partition, and changes when it changes', () => {
    const a = phaseClusterMetrics([0, 0, Math.PI, Math.PI], allActive(4), { phaseBins: 12 });
    const same = phaseClusterMetrics([0.01, 0.01, Math.PI, Math.PI], allActive(4), { phaseBins: 12 });
    // A different SPLIT of the same 4 oscillators across the same two bins.
    const moved = phaseClusterMetrics([0, 0, 0, Math.PI], allActive(4), { phaseBins: 12 });
    expect(same.signature).toBe(a.signature);
    expect(moved.signature).not.toBe(a.signature);
    expect(a.signature).toBe('100000100000|2,2');
  });
});

describe('PrimeOscillatorField.clusterStructure', () => {
  let kernel: SemanticKernel;

  beforeAll(async () => {
    kernel = await freshKernel();
  });

  it('reads the live field over the SAME active set coherence uses', async () => {
    const field = new PrimeOscillatorField({ primeCount: 16, kernel });
    await field.initialize();

    // Quiescent: coherence 0, no clusters — not a fabricated reading.
    field.tick(0.016);
    expect(field.getMetrics().coherence).toBe(0);
    expect(field.clusterStructure().clusterCount).toBe(0);
    expect(field.clusterStructure().activeCount).toBe(0);

    field.excite([2, 3, 5, 7], 0.5);
    const metrics = field.tick(0.016);
    const clusters = field.clusterStructure();
    expect(clusters.activeCount).toBe(4);
    // Freshly reset phases are identical, so the field is one cluster and
    // its within-cluster order parameter IS the global coherence.
    expect(clusters.clusterCount).toBe(1);
    expect(clusters.withinR).toBeCloseTo(metrics.coherence, 10);
  });

  it('is read-only: it never advances or perturbs the field', async () => {
    const field = new PrimeOscillatorField({ primeCount: 16, kernel });
    await field.initialize();
    field.excite([2, 3, 5, 7, 11], 0.5);
    field.tick(0.016);

    const before = field.snapshot();
    for (let i = 0; i < 10; i++) field.clusterStructure();
    const after = field.snapshot();

    expect(after.phases).toEqual(before.phases);
    expect(after.amplitudes).toEqual(before.amplitudes);
    expect(after.tickCount).toBe(before.tickCount);
    expect(after.elapsed).toBe(before.elapsed);
  });
});
