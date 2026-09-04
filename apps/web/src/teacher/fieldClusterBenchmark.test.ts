/**
 * H.6 `field-cluster-bench` (§9.4, SPECULATIVE) — with Hebbian coupling ON,
 * do members of a known hypernym, co-taught together, form a phase-locked
 * sub-population ABOVE the field's overall coherence — and does a control
 * set (unrelated words, the same co-teaching count) not?
 *
 * §9.4 caution honored: the prime signatures are ADDRESSES, not semantics —
 * robin's and sparrow's primes share nothing by construction, so any
 * within-group wiring the field can learn comes only from the co-teaching
 * schedule (rehearsal), not shared structure. The bench therefore measures
 * exactly the paper's refutation condition: if the taught set and the
 * control behave the SAME way, field-level synthesis is not distinguishable
 * from rehearsal, and only the hologram path should be pursued.
 *
 * Protocol (deterministic, identical for both arms): alternating bare-word
 * excitation without settling — the dip–rise pattern that opens the
 * coherent-moment potentiation gate — at the production prime basis
 * (primeCount 256, the same basis the app trains under, so every
 * vocabulary prime maps to a real oscillator). `requireSafetyClear: false`
 * gives the experiment's physics a fair run (the fail-closed safety gate
 * is a STORAGE gate, not part of the §9.4 hypothesis). After co-teaching:
 * settle, excite one member, converge, and measure the sub-population's
 * internal order parameter against the field's coherence. A hebbian-OFF
 * arm over the same group is the bit-identical control the flag gates.
 *
 * OUTCOME RECORDED (deterministic — seeded phases, verified reproducible):
 * the potentiation gate barely opens at this teaching scale (0–1 moments),
 * the Hebbian store stays empty, and NEITHER arm's sub-population
 * phase-locks above the field's coherence (taught R ≈ 0.980 vs field
 * 0.984; control R ≈ 0.971 vs field 0.996; hebbian-off R ≈ 0.975). The
 * arms are indistinguishable (ΔR ≈ 0.008) — field-level synthesis is NOT
 * distinguishable from rehearsal. VERDICT: REFUTED, per §9.8 pursue only
 * the hologram path (the H.4 prototype).
 *
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { deckVocabulary, PRIME_SPACE } from './primeSignature';

const WORDS = [
  'robin', 'sparrow', 'crow', 'finch', 'bird', 'wings', 'feathers', 'beak', 'fly', 'animal',
  'cloud', 'river', 'music', 'shadow', 'dream', 'winter', 'salt', 'forest', 'vapor', 'sky',
  'water', 'melody', 'darkness', 'sleep', 'cold', 'mineral', 'trees', 'moisture', 'sound', 'silence'
];
const DECK = WORDS.map((word) => ({ word }));
const VOCAB = deckVocabulary(DECK, PRIME_SPACE);

const ROUNDS = 6;
const TICKS_PER_WORD = 12;

interface ArmReading {
  moments: number;
  hebbianPairs: number;
  withinGroupPairs: number;
  /** The sub-population's internal order parameter (all group primes). */
  groupR: number;
  /** The field's overall coherence (active-set Kuramoto R). */
  fieldCoherence: number;
}

function makeSession(hebbian: boolean): ObserverSession {
  return new ObserverSession({
    primeCount: 256,
    gridSize: 512,
    memoryMode: 'compact',
    vocabulary: VOCAB,
    hebbian: hebbian ? { enabled: true, eta: 0.05 } : undefined,
    dt: 0.05,
    momentThreshold: 0.85,
    // The fail-closed safety gate is a storage gate; the §9.4 hypothesis is
    // about the field physics — give the potentiation gate a fair run.
    requireSafetyClear: false
  }, 100);
}

async function runArm(group: readonly string[], hebbian: boolean): Promise<ArmReading> {
  const session = makeSession(hebbian);
  await session.initialize();
  const field = session.observer.getOscillatorField();
  const indexOf = new Map(field.primes.map((prime, index) => [prime, index]));
  const groupIndices = new Set<number>();
  for (const word of group) {
    for (const prime of VOCAB[word]) {
      const index = indexOf.get(prime);
      if (index !== undefined) groupIndices.add(index);
    }
  }
  // The vocabulary is built from the SAME prime space as the field basis —
  // every group prime maps to a real oscillator (protocol validity).
  expect(groupIndices.size).toBeGreaterThan(0);

  // CO-TEACHING: alternating excitation without settling — the dip–rise
  // pattern that opens the coherent-moment potentiation gate. Both arms
  // get the identical schedule, so rehearsal is exactly matched.
  let moments = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const word of group) {
      session.observeText(word);
      for (let t = 0; t < TICKS_PER_WORD; t += 1) {
        const event = session.observer.tick(0.05);
        if (event.moment !== null) moments += 1;
      }
    }
  }

  let hebbianPairs = 0;
  let withinGroupPairs = 0;
  for (const [i, j, value] of field.hebbianSnapshot()?.pairs ?? []) {
    if (value > 0.05) {
      hebbianPairs += 1;
      if (groupIndices.has(i) && groupIndices.has(j)) withinGroupPairs += 1;
    }
  }

  // The sub-population probe: settle, excite ONE member, converge, and read
  // the group's internal order parameter.
  session.settleField();
  session.observeText(group[0]);
  session.observer.tick(0.02);
  for (let t = 0; t < 8; t += 1) session.observer.tick(0.05);
  const phases = field.getPhases();
  let x = 0;
  let y = 0;
  for (const index of groupIndices) {
    x += Math.cos(phases[index]);
    y += Math.sin(phases[index]);
  }
  const groupR = Math.hypot(x, y) / groupIndices.size;
  const fieldCoherence = session.observer.getState().coherence;
  session.dispose();
  return { moments, hebbianPairs, withinGroupPairs, groupR, fieldCoherence };
}

describe('H.6 field-cluster bench: does co-teaching phase-lock a sub-population above field coherence?', () => {
  const TAUGHT = ['robin', 'sparrow', 'crow', 'finch'];
  const CONTROL = ['cloud', 'river', 'music', 'shadow'];

  it('the taught set and the control are indistinguishable — field-level synthesis is not distinguishable from rehearsal (the §9.8 refutation)', async () => {
    const taught = await runArm(TAUGHT, true);
    const control = await runArm(CONTROL, true);
    const taughtOff = await runArm(TAUGHT, false);

    // The hebbian-OFF control gates the experiment flag: no learned pairs.
    expect(taughtOff.hebbianPairs).toBe(0);

    // (1) NEITHER sub-population phase-locks above the field's coherence.
    expect(taught.groupR).toBeLessThan(taught.fieldCoherence);
    expect(control.groupR).toBeLessThan(control.fieldCoherence);
    // (2) The arms are indistinguishable in clustering behavior — coupling
    //     follows the co-teaching schedule (rehearsal), not shared structure.
    expect(Math.abs(taught.groupR - control.groupR)).toBeLessThan(0.05);
    // (3) The hebbian flag changes nothing observable at this teaching
    //     scale: the potentiation gate barely opens (moments ≈ 0) and the
    //     wiring it would record never becomes an attractor.
    expect(Math.abs(taught.groupR - taughtOff.groupR)).toBeLessThan(0.05);

    // Determinism: seeded phases make the run reproducible — a second
    // taught arm is bit-identical, so the recorded numbers are physics,
    // not sampling noise.
    const taughtAgain = await runArm(TAUGHT, true);
    expect(taughtAgain.groupR).toBeCloseTo(taught.groupR, 6);
    expect(taughtAgain.moments).toBe(taught.moments);

    // Record the outcome for the §11 checklist (I.2): the refutation.
    // eslint-disable-next-line no-console
    console.log(
      `[fieldClusterBench] taught: R=${taught.groupR.toFixed(3)} (field coherence ${taught.fieldCoherence.toFixed(3)}), ` +
        `moments=${taught.moments}, pairs=${taught.hebbianPairs} (${taught.withinGroupPairs} within group)`
    );
    // eslint-disable-next-line no-console
    console.log(
      `[fieldClusterBench] control: R=${control.groupR.toFixed(3)} (field coherence ${control.fieldCoherence.toFixed(3)}), ` +
        `moments=${control.moments}, pairs=${control.hebbianPairs} (${control.withinGroupPairs} within group)`
    );
    // eslint-disable-next-line no-console
    console.log(
      `[fieldClusterBench] VERDICT: REFUTED — arms indistinguishable (ΔR=${Math.abs(taught.groupR - control.groupR).toFixed(3)}), ` +
        'no sub-population phase-locks above field coherence; field-level synthesis is not distinguishable from rehearsal → hologram path only (§9.8).'
    );
  }, 120000);
});
