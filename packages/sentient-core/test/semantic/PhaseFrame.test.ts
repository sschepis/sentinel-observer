/**
 * PHASE-FRAME (improvements.md §4.2 / Phase C.2) — the co-rotating phase
 * frame for the compact bank's phase order parameter.
 *
 * THE HYPOTHESIS UNDER TEST. The raw phase term compares stored and cue
 * phases directly, so every oscillator's free drift ω_i·Δt dominates the
 * difference ensemble: the term measures moment PROXIMITY, not content (the
 * honest reading in CompactMemoryBank's doc block). The co-rotating frame
 * stores each side's simulated time and natural frequencies and compares
 *
 *     θ_i = φ_i − ω_i·t (mod 2π),
 *
 * so the free drift cancels EXACTLY and whatever remains is the deviation
 * coupling produced during the moment.
 *
 * WHAT IS MEASURED HERE (unit level; the teacher-level sibling AUC bench is
 * apps/web/src/teacher/phaseFrameBenchmark.test.ts):
 *   1. CONTROL PINNING: the 'proximity' arm (explicit since the §4.2 DROP
 *      execution moved the default to 'off') is bit-identical to the
 *      pre-experiment engine, even when the new metadata is stored.
 *   2. Time-invariance: a drift-advanced re-cue of the SAME moment scores
 *      ~1 in the co-rotating frame at every elapsed time, while the raw
 *      frame decays with elapsed time.
 *   3. Sibling separation: same-prime different-content moments (siblings)
 *      separate in the co-rotating frame INDEPENDENT of elapsed time, where
 *      the raw frame's separation collapses as elapsed time grows.
 *   4. Honest absence rules: a trace or cue without the frame metadata
 *      scores 0 on the term (never a fabricated reading).
 *   5. The metadata survives serialize/restore.
 *   6. The observer captures the clock and frequencies at store and recall.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  CompactMemoryBank,
  SemanticKernel,
  SemanticObserver,
  SedenionMemoryField
} from '../../src/semantic';
import { freshKernel } from './helpers';

const TWO_PI = Math.PI * 2;

/** A distinct SMF orientation per word (unit vector rotated per index). */
function orientation(index: number): SedenionMemoryField {
  const smf = SedenionMemoryField.identity();
  const a = index % 16;
  const b = (index * 7 + 3) % 16;
  if (a !== 0) smf.set(a, 0.6);
  if (b !== a && b !== 0) smf.set(b, 0.4);
  smf.normalize();
  return smf;
}

/** Wrap an angle into [0, 2π) deterministically. */
function wrap(angle: number): number {
  let w = angle % TWO_PI;
  if (w < 0) w += TWO_PI;
  return w;
}

/**
 * The mean resultant length of a phase-difference ensemble by hand — the
 * reference implementation of the raw term, so the control arm is pinned to
 * the pre-experiment formula rather than to the code under test.
 */
function rawOrderParameter(
  cuePhases: readonly number[],
  tracePhases: readonly number[]
): number {
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < cuePhases.length; i += 1) {
    const delta = tracePhases[i] - cuePhases[i];
    sx += Math.cos(delta);
    sy += Math.sin(delta);
  }
  return Math.min(1, Math.hypot(sx, sy) / cuePhases.length);
}

const PRIMES = [3, 5, 7];
/** Arbitrary but fixed natural frequencies (rad/s) for the unit ensemble. */
const OMEGAS = [0.4, 0.9, 1.6];

describe('PhaseFrame: co-rotating phase comparison (compact bank)', () => {
  it("'proximity' is the pre-experiment control: bit-identical with and without the frame metadata (the default is now 'off')", () => {
    // The production default has moved to `phaseTerm: 'off'` (the §4.2 DROP
    // verdict, executed in PhaseTermArms.test.ts), so the control is pinned
    // EXPLICITLY here — the raw-frame blend must stay bit-identical to the
    // pre-experiment engine whether or not the frame metadata is stored.
    const plain = new CompactMemoryBank({ phaseTerm: 'proximity' });
    const metadated = new CompactMemoryBank({ phaseTerm: 'proximity' });
    const phases = [1.0, 1.15, 5.5];
    const amplitudes = [0.7, 0.7, 0.7];
    plain.store('lock-a', orientation(1), PRIMES, { amplitudes, phases });
    metadated.store('lock-a', orientation(1), PRIMES, {
      amplitudes,
      phases,
      simTime: 10,
      phaseFrequencies: OMEGAS
    });

    // The same cue, WITH the new query fields — the raw frame must ignore
    // them entirely, so both banks answer identically to the last bit.
    const cue = {
      smf: orientation(1),
      primes: PRIMES,
      phases: [2.0, 3.1, 0.5],
      amplitudes,
      simTime: 100,
      phaseFrequencies: OMEGAS
    };
    const a = plain.recallAll(cue);
    const b = metadated.recallAll(cue);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(b[0].score).toBe(a[0].score);
    expect(b[0].smfScore).toBe(a[0].smfScore);
    expect(b[0].overlapScore).toBe(a[0].overlapScore);
    expect(b[0].holographicScore).toBe(a[0].holographicScore);
    // And the raw term is the pre-experiment formula, exactly.
    expect(a[0].holographicScore).toBeCloseTo(rawOrderParameter(cue.phases, phases), 12);
  });

  it('the co-rotating frame cancels free drift exactly: a drift-advanced re-cue scores ~1 at every elapsed time', () => {
    const bank = new CompactMemoryBank({ coRotatingPhases: true });
    const tStore = 10;
    const phi0 = [0.8, 2.1, 5.0];
    bank.store('moment', orientation(1), PRIMES, {
      amplitudes: [1, 1, 1],
      phases: phi0,
      simTime: tStore,
      phaseFrequencies: OMEGAS
    });

    for (const elapsed of [0, 0.1, 5, 120, 3600]) {
      const tCue = tStore + elapsed;
      // The cue is the SAME moment re-excited after `elapsed` seconds of
      // free drift only: φ_cue = φ_0 + ω·elapsed (mod 2π). Absent coupling,
      // this is exactly what the oscillator does with no content change.
      const phiCue = phi0.map((p, i) => wrap(p + OMEGAS[i] * elapsed));
      const result = bank.recall(
        {
          smf: orientation(1),
          primes: PRIMES,
          phases: phiCue,
          amplitudes: [1, 1, 1],
          simTime: tCue,
          phaseFrequencies: OMEGAS
        },
        1
      )[0];
      // Co-rotating: θ_trace − θ_cue = 0 for every prime, every elapsed time.
      expect(result.holographicScore).toBeGreaterThan(1 - 1e-9);

      // The raw frame over the SAME pair decays with elapsed time — this is
      // the proximity signal the co-rotating frame removes.
      const rawBank = new CompactMemoryBank();
      rawBank.store('moment', orientation(1), PRIMES, {
        amplitudes: [1, 1, 1],
        phases: phi0
      });
      const raw = rawBank.recall(
        { smf: orientation(1), primes: PRIMES, phases: phiCue, amplitudes: [1, 1, 1] },
        1
      )[0];
      expect(raw.holographicScore).toBeCloseTo(rawOrderParameter(phiCue, phi0), 12);
      if (elapsed > 5) expect(raw.holographicScore).toBeLessThan(1 - 1e-6);
    }
  });

  it('sibling separation is independent of elapsed time in the co-rotating frame and collapses in the raw frame', () => {
    // Two moments on the SAME primes, different content (siblings): the case
    // the raw term cannot separate by construction. A's config is the true
    // match; B's differs by a content deviation on every prime.
    const tStore = 50;
    const phiA = [0.6, 1.4, 4.2];
    const deviation = [0.9, 2.2, 4.6];
    const phiB = phiA.map((p, i) => wrap(p + deviation[i]));

    const coBank = new CompactMemoryBank({ coRotatingPhases: true });
    coBank.store('true', orientation(1), PRIMES, {
      amplitudes: [1, 1, 1],
      phases: phiA,
      simTime: tStore,
      phaseFrequencies: OMEGAS
    });
    coBank.store('sibling', orientation(2), PRIMES, {
      amplitudes: [1, 1, 1],
      phases: phiB,
      simTime: tStore,
      phaseFrequencies: OMEGAS
    });
    const rawBank = new CompactMemoryBank();
    rawBank.store('true', orientation(1), PRIMES, { amplitudes: [1, 1, 1], phases: phiA });
    rawBank.store('sibling', orientation(2), PRIMES, { amplitudes: [1, 1, 1], phases: phiB });

    // The expected co-rotating separation, by hand: θ_trace − θ_cue is the
    // pure content deviation, with NO elapsed-time term anywhere.
    const expectedCoSibling = rawOrderParameter(phiA, phiB);

    for (const elapsed of [0, 1, 60, 3000]) {
      const tCue = tStore + elapsed;
      const phiCue = phiA.map((p, i) => wrap(p + OMEGAS[i] * elapsed));
      const cue = (bank: CompactMemoryBank, withFrame: boolean): Map<string, number> => {
        const results = bank.recallAll(
          withFrame
            ? {
                smf: orientation(1),
                primes: PRIMES,
                phases: phiCue,
                amplitudes: [1, 1, 1],
                simTime: tCue,
                phaseFrequencies: OMEGAS
              }
            : { smf: orientation(1), primes: PRIMES, phases: phiCue, amplitudes: [1, 1, 1] }
        );
        return new Map(results.map((r) => [r.trace.content, r.holographicScore]));
      };

      const co = cue(coBank, true);
      const raw = cue(rawBank, false);

      // Co-rotating: the true match locks at ~1 for EVERY elapsed time…
      expect(co.get('true')!).toBeGreaterThan(1 - 1e-9);
      // …and the sibling reads exactly the content deviation, the same
      // number at every elapsed time (time-invariance, pinned to 1e-9).
      expect(co.get('sibling')!).toBeCloseTo(expectedCoSibling, 9);
      // The raw frame stays the pre-experiment formula on both scores.
      expect(raw.get('true')!).toBeCloseTo(rawOrderParameter(phiCue, phiA), 12);
      expect(raw.get('sibling')!).toBeCloseTo(rawOrderParameter(phiCue, phiB), 12);
    }

    // THE TIME-DEPENDENCE SWEEP. The co-rotating separation is a constant of
    // elapsed time; the raw separation is a FUNCTION of elapsed time (the
    // drift wraps, sometimes concentrating, sometimes spreading). Over a
    // fixed grid there exist elapsed times where the raw term collapses and
    // the co-rotating term still separates — measured, not argued.
    const coSeparationAt = (elapsed: number): number => {
      const tCue = tStore + elapsed;
      const phiCue = phiA.map((p, i) => wrap(p + OMEGAS[i] * elapsed));
      const results = coBank.recallAll({
        smf: orientation(1),
        primes: PRIMES,
        phases: phiCue,
        amplitudes: [1, 1, 1],
        simTime: tCue,
        phaseFrequencies: OMEGAS
      });
      const r = new Map(results.map((x) => [x.trace.content, x.holographicScore]));
      return r.get('true')! - r.get('sibling')!;
    };
    const rawSeparationAt = (elapsed: number): number => {
      const phiCue = phiA.map((p, i) => wrap(p + OMEGAS[i] * elapsed));
      const results = rawBank.recallAll({
        smf: orientation(1),
        primes: PRIMES,
        phases: phiCue,
        amplitudes: [1, 1, 1]
      });
      const r = new Map(results.map((x) => [x.trace.content, x.holographicScore]));
      return r.get('true')! - r.get('sibling')!;
    };

    let coMin = Number.POSITIVE_INFINITY;
    let coMax = Number.NEGATIVE_INFINITY;
    let rawMin = Number.POSITIVE_INFINITY;
    let rawMax = Number.NEGATIVE_INFINITY;
    for (let step = 0; step <= 2000; step += 1) {
      const elapsed = step * 0.05;
      coMin = Math.min(coMin, coSeparationAt(elapsed));
      coMax = Math.max(coMax, coSeparationAt(elapsed));
      rawMin = Math.min(rawMin, rawSeparationAt(elapsed));
      rawMax = Math.max(rawMax, rawSeparationAt(elapsed));
    }
    // Co-rotating: flat — the separation IS the content deviation everywhere.
    expect(coMax - coMin).toBeLessThan(1e-9);
    expect(coMin).toBeCloseTo(1 - expectedCoSibling, 9);
    // Raw: a function of elapsed time, and somewhere in the sweep it fails
    // where the co-rotating frame still separates.
    expect(rawMax - rawMin).toBeGreaterThan(0.3);
    expect(rawMin).toBeLessThan(coMin - 0.3);
  });

  it('honest absence: a trace or cue without the frame metadata scores 0 on the term', () => {
    const bank = new CompactMemoryBank({ coRotatingPhases: true });
    // Legacy trace: phases but no sim time / frequencies.
    bank.store('legacy', orientation(1), PRIMES, { amplitudes: [1, 1, 1], phases: [1.0, 2.0, 3.0] });
    // Partial frequency array (1 of 3): dropped whole, never a fabricated frame.
    bank.store('partial', orientation(2), PRIMES, {
      amplitudes: [1, 1, 1],
      phases: [1.0, 2.0, 3.0],
      simTime: 10,
      phaseFrequencies: [0.4]
    });

    const full = {
      smf: orientation(1),
      primes: PRIMES,
      phases: [1.0, 2.0, 3.0],
      amplitudes: [1, 1, 1],
      simTime: 10,
      phaseFrequencies: OMEGAS
    };
    const results = bank.recallAll(full);
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.holographicScore).toBe(0);

    // A cue without the clock disables the term entirely: the blend is the
    // smf/overlap two-term blend, exactly.
    const framed = bank.store('framed', orientation(3), PRIMES, {
      amplitudes: [1, 1, 1],
      phases: [0.5, 1.5, 2.5],
      simTime: 10,
      phaseFrequencies: OMEGAS
    });
    const noClock = bank.recall(
      { smf: orientation(3), primes: PRIMES, phases: [0.5, 1.5, 2.5], amplitudes: [1, 1, 1] },
      3
    );
    const hit = noClock.find((r) => r.trace.id === framed.id)!;
    expect(hit.holographicScore).toBe(0);
    // smf = 1 (identical orientation), overlap = 1 (identical primes/amps):
    // score = (0.5·1·1 + 0.5·1) / (0.5 + 0.5) = 1 — no phase weight anywhere.
    expect(hit.score).toBeCloseTo(1, 10);
  });

  it('the frame metadata survives serialize/restore and still cancels drift afterwards', () => {
    const bank = new CompactMemoryBank({ coRotatingPhases: true });
    const phi0 = [0.8, 2.1, 5.0];
    const trace = bank.store('moment', orientation(1), PRIMES, {
      amplitudes: [1, 1, 1],
      phases: phi0,
      simTime: 10,
      phaseFrequencies: OMEGAS
    });
    const data = bank.serializeTrace(trace.id)!;
    expect(data.storedSimTime).toBe(10);
    expect(data.phaseFrequencies).toEqual(OMEGAS);

    const restoredBank = new CompactMemoryBank({ coRotatingPhases: true });
    restoredBank.restoreTrace(data);
    const restored = restoredBank.get(trace.id)!;
    expect(restored.storedSimTime).toBe(10);
    expect([...restored.phaseFrequencies!]).toEqual(OMEGAS);

    const elapsed = 500;
    const phiCue = phi0.map((p, i) => wrap(p + OMEGAS[i] * elapsed));
    const hit = restoredBank.recall(
      {
        smf: orientation(1),
        primes: PRIMES,
        phases: phiCue,
        amplitudes: [1, 1, 1],
        simTime: 10 + elapsed,
        phaseFrequencies: OMEGAS
      },
      1
    )[0];
    expect(hit.holographicScore).toBeGreaterThan(1 - 1e-9);

    // Legacy serialized records (no frame metadata) restore fine and score
    // 0 on the term under the co-rotating frame — the honest absence.
    const legacyBank = new CompactMemoryBank();
    const legacyTrace = legacyBank.store('legacy', orientation(1), PRIMES, {
      amplitudes: [1, 1, 1],
      phases: phi0
    });
    const legacyData = legacyBank.serializeTrace(legacyTrace.id)!;
    expect(legacyData.storedSimTime).toBeUndefined();
    expect(legacyData.phaseFrequencies).toBeUndefined();
    const coBank = new CompactMemoryBank({ coRotatingPhases: true });
    coBank.restoreTrace(legacyData);
    const legacyHit = coBank.recall(
      {
        smf: orientation(1),
        primes: PRIMES,
        phases: phi0,
        amplitudes: [1, 1, 1],
        simTime: 10,
        phaseFrequencies: OMEGAS
      },
      1
    )[0];
    expect(legacyHit.holographicScore).toBe(0);
  });
});

describe('PhaseFrame: the observer captures the clock and frequencies', () => {
  let kernel: SemanticKernel;

  beforeAll(async () => {
    kernel = await freshKernel();
  });

  it('stores sim time + natural frequencies and recalls finitely (default arm unchanged)', async () => {
    const observer = new SemanticObserver({
      kernel,
      primeCount: 16,
      gridSize: 32,
      memoryMode: 'compact'
    });
    await observer.initialize();
    observer.processInput([2, 3, 5, 7], 0.5);
    observer.tick(0.016);
    observer.tick(0.016);

    const frequencies = observer.getNaturalFrequencies();
    expect(frequencies).toHaveLength(16);
    expect(frequencies.every(Number.isFinite)).toBe(true);
    expect(observer.getSimTime()).toBeCloseTo(0.032, 12);

    const trace = observer.storeMemory('a moment');
    expect(trace).not.toBeNull();
    expect(trace!.storedSimTime).toBeCloseTo(0.032, 12);
    expect(trace!.phaseFrequencies).toHaveLength(trace!.phasePrimes.length);
    const primeSet = observer.getOscillatorField().primes;
    for (let i = 0; i < trace!.phasePrimes.length; i += 1) {
      const index = primeSet.indexOf(trace!.phasePrimes[i]);
      expect(trace!.phaseFrequencies![i]).toBeCloseTo(frequencies[index], 12);
    }

    const results = observer.recallMemory('a moment', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => Number.isFinite(r.holographicScore))).toBe(true);

    observer.dispose();
  });

  it("the default arm is bit-identical to an explicitly-off phaseTerm arm", async () => {
    const run = async (withExplicitOff: boolean): Promise<number[]> => {
      const observer = new SemanticObserver({
        kernel,
        primeCount: 16,
        gridSize: 32,
        memoryMode: 'compact',
        ...(withExplicitOff ? { memoryBankOptions: { phaseTerm: 'off' as const } } : {})
      });
      await observer.initialize();
      for (const word of ['resonance', 'coherence', 'consciousness']) {
        observer.processInput(word, 0.5);
        observer.tick(0.016);
        observer.storeMemory(word);
      }
      const scores: number[] = [];
      for (const word of ['resonance', 'coherence', 'consciousness']) {
        const top = observer.recallMemory(word, 3);
        for (const r of top) scores.push(r.score);
      }
      observer.dispose();
      return scores;
    };

    const control = await run(false);
    const explicitOff = await run(true);
    expect(explicitOff).toEqual(control);
  });
});
