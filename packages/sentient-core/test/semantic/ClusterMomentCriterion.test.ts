/**
 * CLUSTER MOMENT CRITERION tests.
 *
 * `momentCriterion: 'phase-clusters'` is an OPT-IN alternative to the global
 * Kuramoto threshold crossing. These tests pin three things:
 *
 *   1. the DEFAULT is unchanged — `'global-R'` produces exactly the moment
 *      sequence it always did, so every shipped measurement stays valid;
 *   2. the cluster criterion is a real state machine — structure AND
 *      stability AND a rising edge, each of which can independently refuse;
 *   3. a GLOBALLY SYNCHRONIZED field emits nothing under it, which is the
 *      whole physical claim: R -> 1 is one cluster, and one cluster is not a
 *      partition.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  CLUSTER_MOMENT_DEFAULTS,
  PrimeOscillatorField,
  SemanticKernel,
  SemanticObserver,
  type PrimeOscillatorSnapshot,
  type SemanticMoment
} from '../../src/semantic';
import { freshKernel } from './helpers';

/**
 * Hold the field in a crafted phase configuration across a tick.
 *
 * `restore()` writes phases/amplitudes directly, and the tick that follows
 * uses a step so small (1e-7) that the Kuramoto evolution cannot move a
 * phase across a 12-bin boundary. The partition under test is therefore the
 * partition the criterion sees — no randomness, no waiting for the dynamics
 * to cooperate.
 */
function holdPhases(
  field: PrimeOscillatorField,
  phases: readonly number[],
  amplitude = 0.6
): PrimeOscillatorSnapshot {
  const size = field.size;
  return {
    phases: Array.from({ length: size }, (_, i) => phases[i] ?? 0),
    amplitudes: Array.from({ length: size }, (_, i) => (i < phases.length ? amplitude : 0)),
    baseAmplitudes: new Array<number>(size).fill(0),
    elapsed: 0,
    tickCount: 0,
    lastMetrics: { coherence: 0, entropy: 0, orderParameter: 0 }
  };
}

const TWO_PI = Math.PI * 2;
/** Four oscillators in two tight, well-separated groups (k = 2, sizes 2/2). */
const TWO_CLUSTERS = [0, 0.01, Math.PI, Math.PI + 0.01];
/** The same two bins, re-split 4/2 — the same k, a DIFFERENT partition. */
const TWO_CLUSTERS_RESPLIT = [0, 0.01, 0.02, 0.03, Math.PI, Math.PI + 0.01];
/** Three tight groups at 0, 2pi/3, 4pi/3 (k = 3). */
const THREE_CLUSTERS = [0, 0.01, TWO_PI / 3, TWO_PI / 3 + 0.01, (2 * TWO_PI) / 3, (2 * TWO_PI) / 3 + 0.01];

describe('moment criterion', () => {
  let kernel: SemanticKernel;

  beforeAll(async () => {
    kernel = await freshKernel();
  });

  // ── The control is untouched ───────────────────────────────────────────

  it('defaults to global-R, and global-R behaves exactly as before', async () => {
    const observer = new SemanticObserver({ kernel, momentThreshold: 0.85 });
    await observer.initialize();
    expect(observer.getMomentCriterion()).toBe('global-R');

    const moments: SemanticMoment[] = [];
    const subscription = observer.moments.subscribe(m => moments.push(m));

    observer.tick(0.016);
    expect(moments).toHaveLength(0);

    observer.processInput([2, 3, 5], 0.5);
    const crossing = observer.tick(0.016);
    expect(crossing.moment).not.toBeNull();
    expect(crossing.moment!.criterion).toBe('global-R');
    expect(crossing.moment!.coherence).toBeGreaterThan(0.85);
    expect(observer.tick(0.016).moment).toBeNull();
    expect(moments).toHaveLength(1);

    // The recorded partition rides along read-only. A field that just
    // crossed R = 0.85 upward is ONE cluster: global sync has no partition.
    expect(moments[0].clusters.clusterCount).toBe(1);
    expect(moments[0].clusters.betweenR).toBe(1);

    subscription.unsubscribe();
    observer.dispose();
  });

  it('the cluster criterion emits NOTHING on a globally synchronized field', async () => {
    // The exact excitation that fires a global-R moment above.
    const observer = new SemanticObserver({
      kernel,
      momentCriterion: 'phase-clusters'
    });
    await observer.initialize();
    expect(observer.getMomentCriterion()).toBe('phase-clusters');

    observer.processInput([2, 3, 5], 0.5);
    for (let i = 0; i < 50; i++) {
      expect(observer.tick(0.016).moment).toBeNull();
    }
    expect(observer.getState().momentCount).toBe(0);
    // ...and the field really was synchronized the whole time.
    expect(observer.getClusterStructure().clusterCount).toBe(1);
    observer.dispose();
  });

  // ── The criterion is a real state machine ──────────────────────────────

  it('emits on the rising edge of a STABLE multi-cluster partition, once', async () => {
    const observer = new SemanticObserver({
      kernel,
      momentCriterion: 'phase-clusters',
      clusterCriterion: { stabilityTicks: 2, minClusters: 2, minWithinR: 0.9, maxBetweenR: 0.5 }
    });
    await observer.initialize();
    const field = observer.getOscillatorField();
    const held = holdPhases(field, TWO_CLUSTERS);

    // Tick 1: the partition is seen for the FIRST time — not yet stable.
    field.restore(held);
    expect(observer.tick(1e-7).moment).toBeNull();

    // Tick 2: the same partition holds -> stabilityTicks reached -> emit.
    field.restore(held);
    const emitted = observer.tick(1e-7);
    expect(emitted.moment).not.toBeNull();
    expect(emitted.moment!.criterion).toBe('phase-clusters');
    expect(emitted.moment!.clusters.clusterCount).toBe(2);
    expect(emitted.moment!.clusters.withinR).toBeGreaterThanOrEqual(0.9);
    expect(emitted.moment!.clusters.betweenR).toBeLessThanOrEqual(0.5);

    // Ticks 3..12: still the same partition -> the edge does not re-fire.
    for (let i = 0; i < 10; i++) {
      field.restore(held);
      expect(observer.tick(1e-7).moment).toBeNull();
    }
    expect(observer.getState().momentCount).toBe(1);
    observer.dispose();
  });

  it('a DIFFERENT partition re-arms the edge: which groups lock is the code', async () => {
    const observer = new SemanticObserver({
      kernel,
      momentCriterion: 'phase-clusters',
      clusterCriterion: { stabilityTicks: 2 }
    });
    await observer.initialize();
    const field = observer.getOscillatorField();

    const drive = (phases: readonly number[], ticks: number): number => {
      const held = holdPhases(field, phases);
      let emitted = 0;
      for (let i = 0; i < ticks; i++) {
        field.restore(held);
        if (observer.tick(1e-7).moment !== null) emitted += 1;
      }
      return emitted;
    };

    expect(drive(TWO_CLUSTERS, 4)).toBe(1);
    // Same k, same bins, different SIZES -> different partition -> new moment.
    expect(drive(TWO_CLUSTERS_RESPLIT, 4)).toBe(1);
    // A three-way partition is a third distinct code.
    expect(drive(THREE_CLUSTERS, 4)).toBe(1);
    expect(observer.getState().momentCount).toBe(3);
    observer.dispose();
  });

  it('refuses a partition that never holds for stabilityTicks', async () => {
    const observer = new SemanticObserver({
      kernel,
      momentCriterion: 'phase-clusters',
      clusterCriterion: { stabilityTicks: 3 }
    });
    await observer.initialize();
    const field = observer.getOscillatorField();

    // Alternate between two valid partitions every tick: each is structurally
    // fine, neither ever holds. An ensemble drifting past itself sweeps
    // exactly like this, and it must not be recorded as an organized moment.
    for (let i = 0; i < 30; i++) {
      field.restore(holdPhases(field, i % 2 === 0 ? TWO_CLUSTERS : THREE_CLUSTERS));
      expect(observer.tick(1e-7).moment).toBeNull();
    }
    expect(observer.getState().momentCount).toBe(0);
    observer.dispose();
  });

  it('each structural gate can refuse on its own', async () => {
    const spread = 0.9; // a loose group: withinR well under 0.9
    const cases: Array<{ name: string; phases: number[]; criterion: Record<string, number> }> = [
      // k = 1: one cluster is never a partition.
      { name: 'minClusters', phases: [0, 0.01, 0.02], criterion: { minClusters: 2 } },
      // Two groups that are NOT internally locked.
      {
        name: 'minWithinR',
        phases: [-spread, 0, spread, Math.PI - spread, Math.PI, Math.PI + spread],
        criterion: { minWithinR: 0.99 }
      },
      // Two groups that ARE separated in bins but sit close together in
      // PHASE, so their centroids reinforce instead of cancelling.
      {
        name: 'maxBetweenR',
        phases: [0, 0.01, 1.1, 1.11],
        criterion: { maxBetweenR: 0.1 }
      }
    ];

    for (const { name, phases, criterion } of cases) {
      const observer = new SemanticObserver({
        kernel,
        momentCriterion: 'phase-clusters',
        clusterCriterion: { stabilityTicks: 1, ...criterion }
      });
      await observer.initialize();
      const field = observer.getOscillatorField();
      const held = holdPhases(field, phases);
      for (let i = 0; i < 5; i++) {
        field.restore(held);
        expect([name, observer.tick(1e-7).moment]).toEqual([name, null]);
      }
      observer.dispose();
    }
  });

  it('settleField clears the stability memory (a reset is not a partition)', async () => {
    const observer = new SemanticObserver({
      kernel,
      momentCriterion: 'phase-clusters',
      clusterCriterion: { stabilityTicks: 2 }
    });
    await observer.initialize();
    const field = observer.getOscillatorField();
    const held = holdPhases(field, TWO_CLUSTERS);

    field.restore(held);
    expect(observer.tick(1e-7).moment).toBeNull(); // 1 of 2

    observer.settleField(); // the partition is destroyed

    field.restore(held);
    // Without the clear this would emit: the pre-settle tick would still
    // count toward the post-settle partition's stability.
    expect(observer.tick(1e-7).moment).toBeNull();
    field.restore(held);
    expect(observer.tick(1e-7).moment).not.toBeNull();
    observer.dispose();
  });

  // ── Determinism and bounds ─────────────────────────────────────────────

  it('is deterministic: identical drives produce identical emission ticks', async () => {
    const run = async (): Promise<number[]> => {
      const observer = new SemanticObserver({
        kernel,
        momentCriterion: 'phase-clusters',
        clusterCriterion: { stabilityTicks: 2 }
      });
      await observer.initialize();
      const field = observer.getOscillatorField();
      const ticks: number[] = [];
      const script = [TWO_CLUSTERS, TWO_CLUSTERS, THREE_CLUSTERS, THREE_CLUSTERS, THREE_CLUSTERS, TWO_CLUSTERS_RESPLIT, TWO_CLUSTERS_RESPLIT];
      for (const phases of script) {
        field.restore(holdPhases(field, phases));
        const event = observer.tick(1e-7);
        if (event.moment) ticks.push(event.tick);
      }
      observer.dispose();
      return ticks;
    };
    const a = await run();
    const b = await run();
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(0);
  });

  it('clamps its configuration instead of trusting it', async () => {
    const observer = new SemanticObserver({
      kernel,
      momentCriterion: 'phase-clusters',
      clusterCriterion: {
        phaseBins: -5,
        minClusters: -3,
        minWithinR: 42,
        maxBetweenR: -9,
        stabilityTicks: 0
      }
    });
    await observer.initialize();
    // minWithinR clamps to 1 and maxBetweenR to 0 — the strictest possible
    // gate, which refuses rather than accepting a nonsense configuration.
    const field = observer.getOscillatorField();
    for (let i = 0; i < 5; i++) {
      field.restore(holdPhases(field, TWO_CLUSTERS));
      expect(observer.tick(1e-7).moment).toBeNull();
    }
    observer.dispose();
  });

  it('refuses a non-finite criterion value loudly', async () => {
    expect(
      () => new SemanticObserver({ kernel, clusterCriterion: { minWithinR: Number.NaN } })
    ).toThrow();
    expect(
      () => new SemanticObserver({ kernel, clusterCriterion: { stabilityTicks: Number.POSITIVE_INFINITY } })
    ).toThrow();
  });

  it('exposes the documented defaults', () => {
    expect(CLUSTER_MOMENT_DEFAULTS).toEqual({
      phaseBins: 12,
      minClusters: 2,
      minWithinR: 0.9,
      maxBetweenR: 0.5,
      stabilityTicks: 2
    });
  });

  it('a failed tick rolls the cluster bookkeeping back with everything else', async () => {
    const observer = new SemanticObserver({
      kernel,
      momentCriterion: 'phase-clusters',
      clusterCriterion: { stabilityTicks: 2 }
    });
    await observer.initialize();
    const field = observer.getOscillatorField();
    const held = holdPhases(field, TWO_CLUSTERS);

    field.restore(held);
    expect(observer.tick(1e-7).moment).toBeNull(); // 1 of 2 seen

    // A rejected tick must not advance the stability counter.
    expect(() => observer.tick(-1)).toThrow();

    field.restore(held);
    const emitted = observer.tick(1e-7);
    expect(emitted.moment).not.toBeNull();
    expect(observer.getState().momentCount).toBe(1);
    observer.dispose();
  });
});
