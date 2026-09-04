/**
 * D.6 (§5.2 rows 5–6) — the measured MDL costs, behind flags.
 *
 * The fixed constants stay the CONTROL:
 *   · unknown-token cost 20 bits → −log₂ of the unseen-word mass under a
 *     Good–Turing estimate over the deck's frequency table (row 6);
 *   · slot annotation cost 15 bits → −log₂ P(slot position | shell grammar)
 *     estimated from the learned-operator library's templates (row 5).
 *
 * This bench pins the estimates finite and drifting correctly as the deck
 * grows (more observed mass ⇒ the unknown costs MORE), the flag gating
 * (off = the constants everywhere), and the Zipf control behavior unchanged.
 *
 * @jest-environment node
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import {
  TokenCostModel,
  UNKNOWN_TOKEN_COST,
  SLOT_ANNOTATION_CONTROL_BITS,
  MDL_MEASURED_FLAGS,
  goodTuringTable,
  goodTuringUnseenMass,
  goodTuringUnknownCost,
  shellSlotAnnotationCost,
  measuredSlotAnnotationCost,
  resetMeasuredMdlGates,
  setMeasuredMdlGate
} from './mdl';
import { SLOT_COST } from './operators/learning';

afterEach(() => {
  resetMeasuredMdlGates();
});

const FREQUENCY_ORDER = ['the', 'be', 'and', 'of', 'a', 'in', 'to', 'have', 'it', 'you', 'he', 'that', 'for', 'on', 'with', 'as', 'do', 'say', 'at', 'this'];

describe('the Good–Turing estimator over the deck frequency table', () => {
  it('the unseen mass is a positive fraction and the implied counts follow the Zipf rank order', () => {
    const mass = goodTuringUnseenMass(['a', 'b', 'c', 'd', 'e']);
    expect(mass).not.toBeNull();
    // Implied counts for 5 words: [5, 3, 2, 1, 1] — singletons = 2, N = 12.
    expect(mass!).toBeCloseTo(2 / 12, 10);
  });

  it('goodTuringTable adjusts counts with the empirical fallback above the table top', () => {
    const table = goodTuringTable([3, 1]);
    expect(table).not.toBeNull();
    // N₁ = 1, N = 4 → unseen mass 0.25; count 3 is the table top → empirical 3/4.
    expect(table!.unseenMass).toBeCloseTo(0.25, 10);
    expect(table!.probabilityOfCount(3)).toBeCloseTo(0.75, 10);
    expect(table!.probabilityOfCount(0)).toBeCloseTo(0.25, 10);
  });

  it('the unknown-token cost is finite and RISES as the deck grows (unseen mass falls)', () => {
    const small = goodTuringUnknownCost(FREQUENCY_ORDER.slice(0, 5));
    const mid = goodTuringUnknownCost(FREQUENCY_ORDER.slice(0, 10));
    const large = goodTuringUnknownCost(FREQUENCY_ORDER);
    expect(small).not.toBeNull();
    expect(mid).not.toBeNull();
    expect(large).not.toBeNull();
    for (const cost of [small, mid, large]) {
      expect(Number.isFinite(cost)).toBe(true);
      expect(cost!).toBeGreaterThan(0);
    }
    expect(mid!).toBeGreaterThan(small!);
    expect(large!).toBeGreaterThan(mid!);
    // An empty deck has no frequency table — the estimate is null and the
    // control constant stays.
    expect(goodTuringUnknownCost([])).toBeNull();
  });
});

describe('TokenCostModel — the measured unknown-token cost behind its flag', () => {
  it('flag OFF (default): unseen tokens cost the 20-bit control; known tokens keep the Zipf prior', () => {
    expect(MDL_MEASURED_FLAGS.unknown).toBe(false);
    const model = new TokenCostModel(FREQUENCY_ORDER);
    expect(model.unknownTokenCost()).toBe(UNKNOWN_TOKEN_COST);
    expect(model.costOf('zzz-not-a-word')).toBe(UNKNOWN_TOKEN_COST);
    // The Zipf costs are the same −log₂ of the rank weights as before.
    const weights = FREQUENCY_ORDER.map((_, i) => 1 / (i + 1));
    const total = weights.reduce((a, b) => a + b, 0);
    expect(model.costOf('the')).toBeCloseTo(-Math.log2(weights[0] / total), 10);
    expect(model.costOf('be')).toBeCloseTo(-Math.log2(weights[1] / total), 10);
  });

  it('flag ON: unseen tokens cost −log₂ of the Good–Turing unseen mass', () => {
    const model = new TokenCostModel(FREQUENCY_ORDER.slice(0, 5));
    setMeasuredMdlGate('unknown', true);
    const expected = goodTuringUnknownCost(FREQUENCY_ORDER.slice(0, 5));
    expect(expected).not.toBeNull();
    expect(model.unknownTokenCost()).toBeCloseTo(expected!, 10);
    expect(model.costOf('quark')).toBeCloseTo(expected!, 10);
    // Known-word costs are untouched by the gate.
    const control = new TokenCostModel(FREQUENCY_ORDER.slice(0, 5));
    expect(model.costOf('the')).toBeCloseTo(control.costOf('the'), 10);
  });

  it('an empty deck has no frequency table — the control stays even with the flag on', () => {
    const model = new TokenCostModel([]);
    setMeasuredMdlGate('unknown', true);
    expect(model.costOf('anything')).toBe(UNKNOWN_TOKEN_COST);
  });

  it('the measured cost drifts correctly as the deck grows: a bigger deck charges more for the unknown', () => {
    setMeasuredMdlGate('unknown', true);
    const small = new TokenCostModel(FREQUENCY_ORDER.slice(0, 5)).unknownTokenCost();
    const large = new TokenCostModel(FREQUENCY_ORDER).unknownTokenCost();
    expect(Number.isFinite(small)).toBe(true);
    expect(large).toBeGreaterThan(small);
  });
});

describe('the shell-grammar slot annotation cost (row 5)', () => {
  it('a library where the slot always sits at one position costs ~0 bits; a spread library costs more', () => {
    const concentrated = ['yes i like {slot}', 'no i like {slot}', 'do you like {slot}'];
    const spread = ['yes i like {slot}', 'no {slot} please', '{slot} please'];
    const a = shellSlotAnnotationCost(concentrated);
    const b = shellSlotAnnotationCost(spread);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(Number.isFinite(a)).toBe(true);
    expect(Number.isFinite(b)).toBe(true);
    // Concentrated positions are cheaper to annotate than spread ones.
    expect(a!).toBeLessThan(b!);
  });

  it('matches the empirical position rates: two positions at 2/2 → 1 bit per slot', () => {
    // Positions 3 and 1, two templates each — P(position) = 0.5 each → 1 bit.
    const library = ['yes i like {slot}', 'yes i like {slot}', 'no {slot} please', 'no {slot} please'];
    expect(shellSlotAnnotationCost(library)).toBeCloseTo(1, 10);
  });

  it('relation holes read as placeholders — the position is a real token index', () => {
    const library = ['{slot} is a {p:is-a}'];
    // The slot sits at token 0, the hole at token 3 — the slot position is 0.
    const cost = shellSlotAnnotationCost(library);
    expect(cost).not.toBeNull();
    expect(Number.isFinite(cost)).toBe(true);
  });

  it('a library with no slot-bearing template yields null; the flag gates the live cost', () => {
    expect(shellSlotAnnotationCost(['no marker here', ''])).toBeNull();
    expect(MDL_MEASURED_FLAGS.slot).toBe(false);
    expect(measuredSlotAnnotationCost(['yes i like {slot}'])).toBe(SLOT_ANNOTATION_CONTROL_BITS);
    expect(SLOT_ANNOTATION_CONTROL_BITS).toBe(SLOT_COST); // parity with the control constant
    setMeasuredMdlGate('slot', true);
    const live = measuredSlotAnnotationCost(['yes i like {slot}', 'yes i like {slot}']);
    expect(live).toBeLessThan(SLOT_ANNOTATION_CONTROL_BITS);
  });
});
