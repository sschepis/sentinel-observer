/**
 * PHASE-TERM ARMS (§4.2 DROP verdict, executed as a MEASURED weight change)
 *
 * The phase-frame experiment (PhaseFrame.test.ts at the unit level, the
 * teacher-level phaseFrameBenchmark at production) MEASURED the refutation
 * condition of improvements.md §4.2 / §11: the co-rotating frame does NOT
 * separate siblings (mean AUC 0.495 across the elapsed-time sweep vs 0.497
 * raw — chance in both frames). The moment carries no content beyond the
 * excitation; the phase term is a moment-PROXIMITY signal. Verdict DROP
 * recorded. This test executes the verdict as a weight decision: the bank
 * option `phaseTerm` selects
 *
 *   · 'proximity'  — the raw order parameter at `phaseWeight` (the control,
 *                    bit-identical to the pre-experiment engine);
 *   · 'coRotating' — the §4.2 frame θ_i = φ_i − ω_i·t at `phaseWeight`;
 *   · 'off'        — the term leaves the blend and the remaining SMF/overlap
 *                    weights renormalize (the raw R is still reported under
 *                    `holographicScore` as a weightless diagnostic).
 *
 * WHAT IS MEASURED HERE (bank-level, deck-scale-ish settings: production
 * capacity 50,000, the 128-dim sketch, ~5,300 stored traces, 250 sibling
 * pairs):
 *
 *   A. Recall separation. Sibling pairs share their ENTIRE prime signature
 *      (the overlap term cannot separate them by construction — the doc
 *      block's H1/H4 note) and sit at a 0.9 SMF cosine: the amplified
 *      regime where a 0.15 phase weight CAN flip a ranking, i.e. where the
 *      weight decision is actually exercised. (At production cosines,
 *      ~0.3–0.7, the phase term's ranking effect is strictly smaller.)
 *      Two cue classes, both faithful to the measured machinery:
 *        · class A "free-run re-cue": cue phases = the true moment's stored
 *          phases advanced by the free drift ω·τ (the drift-advanced
 *          re-excitation of PhaseFrame.test.ts) — the regime where the raw
 *          proximity signal CAN earn its weight at small τ (R → 1) and
 *          where the co-rotating frame locks at ~1 for EVERY τ;
 *        · class B "settled": cue phases are fresh and unrelated to every
 *          stored configuration (the measured settled-pipeline regime,
 *          where BOTH frames read chance — the AUC ≈ 0.5 finding).
 *   B. Fuzz-style false positives. Distractor cues carrying HALF a pair's
 *      primes and a foreign orientation must never score above the
 *      confident floor (0.6) — 0 FP in every arm, so the off arm cannot
 *      inflate distractor scores across the gate.
 *
 * THE TRIPWIRE. The production default is 'off' — the executed §4.2 DROP
 * (recorded at COMPACT_DEFAULTS.phaseTerm in CompactMemoryBank.ts). This
 * test RE-VERIFIES that measured decision on every run: 'off' must hold
 * recall within noise of the control AND every arm must stay at 0 fuzz FP.
 * If either assertion fails, the default needs re-measuring — the
 * proximity signal may have started earning its weight again.
 */
import { describe, it, expect } from '@jest/globals';
import { CompactMemoryBank, SedenionMemoryField } from '../../src/semantic';

const WIDTH = 128;          // the production sketch width
const CAPACITY = 50000;     // the production (deck-scale) capacity
const PAIRS = 250;          // sibling pairs — the amplified measurement set
const PAIR_PRIME_COUNT = 6;
const BACKGROUND_TRACES = 4800; // scale mass stored behind the pairs
const BACKGROUND_GROUP = 4;     // traces sharing one background signature
const FP_THRESHOLD = 0.6;       // the bank-level confident floor (fuzz analog)
const SIBLING_COSINE = 0.9;     // amplified regime: phase noise CAN flip
const TWO_PI = Math.PI * 2;
/** The phase-frame bench's free-run sweep — the raw term decays across it. */
const CLASS_A_TAUS = [0.5, 3, 20, 120];

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function wrap(angle: number): number {
  let w = angle % TWO_PI;
  if (w < 0) w += TWO_PI;
  return w;
}

function firstPrimes(count: number): number[] {
  const primes: number[] = [];
  for (let candidate = 2; primes.length < count; candidate += 1) {
    let isPrime = true;
    for (const p of primes) {
      if (p * p > candidate) break;
      if (candidate % p === 0) {
        isPrime = false;
        break;
      }
    }
    if (isPrime) primes.push(candidate);
  }
  return primes;
}

/** A distinct natural frequency per pool slot (parallel to the prime). */
function omegaOf(slot: number): number {
  return 0.4 + 0.1 * (slot % 12);
}

function randomOrientation(rng: () => number): SedenionMemoryField {
  const values: number[] = [];
  for (let i = 0; i < WIDTH; i += 1) values.push(rng() * 2 - 1);
  const smf = SedenionMemoryField.fromArray(values);
  smf.normalize();
  return smf;
}

/** A unit vector at exactly SIBLING_COSINE from `base` (base + a random
 *  perpendicular): discrimination rides on the SMF term alone, with the
 *  smallest gap the phase term could still flip. */
function nearSibling(rng: () => number, base: SedenionMemoryField): SedenionMemoryField {
  const baseArr = base.toArray();
  const noise: number[] = [];
  for (let i = 0; i < WIDTH; i += 1) noise.push(rng() * 2 - 1);
  let dot = 0;
  for (let i = 0; i < WIDTH; i += 1) dot += noise[i] * baseArr[i];
  const perp: number[] = [];
  let norm = 0;
  for (let i = 0; i < WIDTH; i += 1) {
    const value = noise[i] - dot * baseArr[i];
    perp.push(value);
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  const sinTheta = Math.sqrt(1 - SIBLING_COSINE * SIBLING_COSINE);
  const values: number[] = [];
  for (let i = 0; i < WIDTH; i += 1) values.push(SIBLING_COSINE * baseArr[i] + (sinTheta * perp[i]) / norm);
  return SedenionMemoryField.fromArray(values);
}

interface ArmPair {
  k: number;
  primes: number[];
  omega: number[];
  smfTrue: SedenionMemoryField;
  smfSibling: SedenionMemoryField;
  phiTrue: number[];
  tTrue: number;
  extraPrimes: number[];
}

interface ArmDeck {
  bank: CompactMemoryBank;
  pairs: ArmPair[];
}

/** Build the SAME deterministic deck under the given phaseTerm mode. */
function buildDeck(phaseTerm: 'proximity' | 'coRotating' | 'off'): ArmDeck {
  const rng = lcg(0x4a2);
  const backgroundGroups = BACKGROUND_TRACES / BACKGROUND_GROUP;
  const pool = firstPrimes(PAIRS * PAIR_PRIME_COUNT + backgroundGroups * PAIR_PRIME_COUNT + 8);
  const bank = new CompactMemoryBank({ capacity: CAPACITY, phaseTerm });
  const extraPrimes = pool.slice(pool.length - 8, pool.length - 5);

  const groupBase = PAIRS * PAIR_PRIME_COUNT;
  for (let g = 0; g < backgroundGroups; g += 1) {
    const start = groupBase + g * PAIR_PRIME_COUNT;
    const primes = pool.slice(start, start + PAIR_PRIME_COUNT);
    const omega = primes.map((_, i) => omegaOf(start + i));
    for (let m = 0; m < BACKGROUND_GROUP; m += 1) {
      bank.store(`background-${g}-${m}`, randomOrientation(rng), primes, {
        amplitudes: primes.map(() => 1),
        phases: primes.map(() => rng() * TWO_PI),
        simTime: g + m * 0.25,
        phaseFrequencies: omega
      });
    }
  }

  const pairs: ArmPair[] = [];
  for (let k = 0; k < PAIRS; k += 1) {
    const start = k * PAIR_PRIME_COUNT;
    const primes = pool.slice(start, start + PAIR_PRIME_COUNT);
    const omega = primes.map((_, i) => omegaOf(start + i));
    const smfTrue = randomOrientation(rng);
    const smfSibling = nearSibling(rng, smfTrue);
    const phiTrue = primes.map(() => rng() * TWO_PI);
    const phiSibling = primes.map(() => rng() * TWO_PI);
    const tTrue = 2000 + k * 10;
    bank.store(`true-${k}`, smfTrue, primes, {
      amplitudes: primes.map(() => 1),
      phases: phiTrue,
      simTime: tTrue,
      phaseFrequencies: omega
    });
    // The sibling stores AFTER the true trace: the proximity signal's
    // recency bias points at the WRONG trace, which is the honest stress.
    bank.store(`sibling-${k}`, smfSibling, primes, {
      amplitudes: primes.map(() => 1),
      phases: phiSibling,
      simTime: tTrue + 1,
      phaseFrequencies: omega
    });
    pairs.push({ k, primes, omega, smfTrue, smfSibling, phiTrue, tTrue, extraPrimes });
  }
  return { bank, pairs };
}

interface ClassMetrics {
  recall: number;
  margin: number;
}

interface ArmMetrics {
  classA: ClassMetrics;
  classB: ClassMetrics;
  fuzzFP: number;
  fuzzMax: number;
}

function measure(deck: ArmDeck): ArmMetrics {
  const rng = lcg(0xb33f);
  const { bank, pairs } = deck;
  let aHits = 0;
  let bHits = 0;
  let aMargin = 0;
  let bMargin = 0;
  let fuzzFP = 0;
  let fuzzMax = 0;

  for (const pair of pairs) {
    const amplitudes = pair.primes.map(() => 1);
    const scored = (query: {
      smf: SedenionMemoryField;
      primes: number[];
      phases: number[];
      simTime: number;
    }): { top: string; margin: number } => {
      const results = bank.recallAll({
        smf: query.smf,
        primes: query.primes,
        amplitudes,
        phases: query.phases,
        simTime: query.simTime,
        phaseFrequencies: pair.omega
      });
      let trueScore = 0;
      let siblingScore = 0;
      for (const r of results) {
        if (r.trace.content === `true-${pair.k}`) trueScore = r.score;
        else if (r.trace.content === `sibling-${pair.k}`) siblingScore = r.score;
      }
      return { top: results[0]?.trace.content ?? '', margin: trueScore - siblingScore };
    };

    // Class A: the drift-advanced re-cue of the TRUE moment after τ.
    const tauA = CLASS_A_TAUS[pair.k % CLASS_A_TAUS.length];
    const phiA = pair.phiTrue.map((p, i) => wrap(p + pair.omega[i] * tauA));
    const a = scored({ smf: pair.smfTrue, primes: pair.primes, phases: phiA, simTime: pair.tTrue + tauA });
    if (a.top === `true-${pair.k}`) aHits += 1;
    aMargin += a.margin;

    // Class B: the settled cue — fresh phases, unrelated to any stored
    // configuration (the measured regime where both frames read chance).
    const tauB = 0.5 + rng() * 200;
    const phiB = pair.primes.map(() => rng() * TWO_PI);
    const b = scored({ smf: pair.smfTrue, primes: pair.primes, phases: phiB, simTime: pair.tTrue + tauB });
    if (b.top === `true-${pair.k}`) bHits += 1;
    bMargin += b.margin;

    // Fuzz: HALF the pair's primes plus three primes no trace carries, a
    // foreign orientation, fresh phases — the confident-floor probe.
    const fuzzPrimes = [...pair.primes.slice(0, 3), ...pair.extraPrimes];
    const fuzzPhases = fuzzPrimes.map(() => rng() * TWO_PI);
    const fuzz = bank.recallAll({
      smf: randomOrientation(rng),
      primes: fuzzPrimes,
      amplitudes: fuzzPrimes.map(() => 1),
      phases: fuzzPhases,
      simTime: rng() * 3000,
      phaseFrequencies: [...pair.omega.slice(0, 3), 0.7, 0.7, 0.7]
    });
    const topScore = fuzz[0]?.score ?? 0;
    if (topScore >= FP_THRESHOLD) fuzzFP += 1;
    fuzzMax = Math.max(fuzzMax, topScore);
  }

  return {
    classA: { recall: aHits / PAIRS, margin: aMargin / PAIRS },
    classB: { recall: bHits / PAIRS, margin: bMargin / PAIRS },
    fuzzFP,
    fuzzMax
  };
}

function report(label: string, value: string): void {
  // eslint-disable-next-line no-console
  console.log(`[phaseTermArms] ${label.padEnd(30)} ${value}`);
}

describe('PhaseTermArms: the three phaseTerm modes at deck scale (§4.2 DROP execution)', () => {
  it('compares recall separation and fuzz false positives across proximity / coRotating / off', () => {
    const arms = {
      proximity: measure(buildDeck('proximity')),
      coRotating: measure(buildDeck('coRotating')),
      off: measure(buildDeck('off'))
    };

    // eslint-disable-next-line no-console
    console.log(
      `\n[phaseTermArms] PAIRS=${PAIRS} BACKGROUND=${BACKGROUND_TRACES} CAPACITY=${CAPACITY} ` +
        `WIDTH=${WIDTH} SIBLING_COSINE=${SIBLING_COSINE} FP_THRESHOLD=${FP_THRESHOLD}\n`
    );
    for (const [name, m] of Object.entries(arms)) {
      report(
        `${name} recall (re-cue A / settled B)`,
        `${(m.classA.recall * 100).toFixed(1)}% / ${(m.classB.recall * 100).toFixed(1)}%  ` +
          `margin ${m.classA.margin.toFixed(4)} / ${m.classB.margin.toFixed(4)}`
      );
      report(`${name} fuzz`, `${m.fuzzFP} FP · max distractor score ${m.fuzzMax.toFixed(4)}`);
    }

    // ── Structural invariants (hard) ────────────────────────────────────
    for (const m of Object.values(arms)) {
      expect(m.fuzzFP).toBe(0);
      expect(m.fuzzMax).toBeLessThan(FP_THRESHOLD);
      for (const c of [m.classA, m.classB]) {
        expect(Number.isFinite(c.recall)).toBe(true);
        expect(Number.isFinite(c.margin)).toBe(true);
      }
    }
    // The co-rotating frame locks on the drift-advanced re-cue at EVERY τ
    // (the one place the frame genuinely works — PhaseFrame.test.ts pins
    // the same reading at the unit level). Recall must be perfect.
    expect(arms.coRotating.classA.recall).toBe(1);
    // The term genuinely enters the control blend (the bench is not
    // vacuous): the off arm's re-cue scores differ from the control's.
    const proximityMarginA = arms.proximity.classA.margin;
    expect(Math.abs(proximityMarginA - arms.off.classA.margin)).toBeGreaterThan(1e-6);

    // ── THE TRIPWIRE (§4.2 execution): the production default rests on
    //    'off' holding recall within noise of the control AND 0 fuzz FP.
    //    If this ever fails, re-measure — the proximity signal may have
    //    started earning its weight again.
    const withinNoise =
      arms.off.classA.recall >= arms.proximity.classA.recall - 0.02 &&
      arms.off.classB.recall >= arms.proximity.classB.recall - 0.02;
    const fuzzClean = arms.proximity.fuzzFP === 0 && arms.coRotating.fuzzFP === 0 && arms.off.fuzzFP === 0;
    expect(withinNoise).toBe(true);
    expect(fuzzClean).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `\n[phaseTermArms] DEFAULT phaseTerm: 'off' (the executed §4.2 DROP) — ` +
        `${withinNoise && fuzzClean ? 're-verified: ' : 'TRIPWIRE FAILED — re-measure: '}` +
        `off recall ${(arms.off.classA.recall * 100).toFixed(1)}%/${(arms.off.classB.recall * 100).toFixed(1)}% vs ` +
        `control ${(arms.proximity.classA.recall * 100).toFixed(1)}%/${(arms.proximity.classB.recall * 100).toFixed(1)}%, ` +
        `fuzz ${arms.proximity.fuzzFP}/${arms.coRotating.fuzzFP}/${arms.off.fuzzFP} FP\n`
    );
  }, 120000);
});

describe('PhaseTermArms: the off arm and the option aliases (unit level)', () => {
  const orientation = (index: number): SedenionMemoryField => {
    const smf = SedenionMemoryField.identity();
    smf.set(index % 16, 0.6);
    smf.set((index * 7 + 3) % 16, 0.4);
    smf.normalize();
    return smf;
  };
  const PRIMES = [3, 5, 7];
  const AMPS = [1, 1, 1];

  it("'off' removes the phase weight and renormalizes the SMF/overlap blend exactly", () => {
    const off = new CompactMemoryBank({ phaseTerm: 'off' });
    off.store('moment', orientation(1), PRIMES, { amplitudes: AMPS, phases: [0.5, 1.5, 2.5] });
    const control = new CompactMemoryBank({ phaseTerm: 'proximity' });
    control.store('moment', orientation(1), PRIMES, { amplitudes: AMPS, phases: [0.5, 1.5, 2.5] });
    const cue = { smf: orientation(1), primes: PRIMES, phases: [0.1, 0.2, 0.3], amplitudes: AMPS };

    const offHit = off.recallAll(cue)[0];
    const controlHit = control.recallAll(cue)[0];

    // smf = 1, overlap = 1: the off blend is (0.5·1 + 0.5·1)/(0.5 + 0.5) = 1
    // — no phase weight anywhere in the blend.
    expect(offHit.score).toBeCloseTo(1, 12);
    // The control carries the phase term, so its blend differs.
    expect(Math.abs(offHit.score - controlHit.score)).toBeGreaterThan(1e-9);
    // The raw order parameter is STILL reported under holographicScore in
    // the off arm — a weightless diagnostic, identical to the control's.
    expect(offHit.holographicScore).toBeCloseTo(controlHit.holographicScore, 12);
    // Frame metadata changes nothing under 'off': the term is excluded
    // whether or not the co-rotating fields are present.
    const framedOff = new CompactMemoryBank({ phaseTerm: 'off' });
    framedOff.store('moment', orientation(1), PRIMES, {
      amplitudes: AMPS,
      phases: [0.5, 1.5, 2.5],
      simTime: 10,
      phaseFrequencies: [0.4, 0.9, 1.6]
    });
    const framedHit = framedOff.recallAll({
      smf: orientation(1),
      primes: PRIMES,
      phases: [0.1, 0.2, 0.3],
      amplitudes: AMPS,
      simTime: 100,
      phaseFrequencies: [0.4, 0.9, 1.6]
    })[0];
    expect(framedHit.score).toBeCloseTo(offHit.score, 12);
  });

  it('a cue without phases gives the same blend in all three modes (the term never joins)', () => {
    const scores: number[] = [];
    for (const phaseTerm of ['proximity', 'coRotating', 'off'] as const) {
      const bank = new CompactMemoryBank({ phaseTerm });
      bank.store('moment', orientation(1), PRIMES, { amplitudes: AMPS });
      const hit = bank.recallAll({ smf: orientation(1), primes: PRIMES, amplitudes: AMPS })[0];
      scores.push(hit.score);
      expect(hit.holographicScore).toBe(0);
    }
    expect(scores[1]).toBe(scores[0]);
    expect(scores[2]).toBe(scores[0]);
  });

  it("the §4.2 boolean option is a working alias: coRotatingPhases: true ≡ phaseTerm: 'coRotating'", () => {
    const build = (options: { coRotatingPhases?: boolean; phaseTerm?: 'proximity' | 'coRotating' | 'off' }): number => {
      const bank = new CompactMemoryBank(options);
      bank.store('moment', orientation(1), PRIMES, {
        amplitudes: AMPS,
        phases: [0.8, 2.1, 5.0],
        simTime: 10,
        phaseFrequencies: [0.4, 0.9, 1.6]
      });
      return bank.recallAll({
        smf: orientation(1),
        primes: PRIMES,
        phases: [1.0, 3.0, 0.5],
        amplitudes: AMPS,
        simTime: 60,
        phaseFrequencies: [0.4, 0.9, 1.6]
      })[0].score;
    };
    expect(build({ coRotatingPhases: true })).toBe(build({ phaseTerm: 'coRotating' }));
    // `false` means "not co-rotating": the bank's default phaseTerm mode
    // (whatever the executed default is), exactly like passing nothing.
    expect(build({ coRotatingPhases: false })).toBe(build({}));
    // An explicit phaseTerm wins over the deprecated boolean.
    expect(build({ coRotatingPhases: true, phaseTerm: 'off' })).toBe(build({ phaseTerm: 'off' }));
  });
});
