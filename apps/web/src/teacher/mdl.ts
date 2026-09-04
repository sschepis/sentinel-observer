import { tokenizeText } from './context';

/**
 * MDL COST MODEL — the philosophy becomes the criterion.
 *
 * An operator earns its place when adopting it compresses the memory bank:
 * the bits saved by explaining stored instances must exceed the bits needed
 * to encode the operator itself. Token costs follow a Zipf-style prior over
 * the deck's frequency order — common words are cheap, rare words are
 * expensive — so a single demonstration of an expensive response can justify
 * an operator, while cheap common-word responses need more evidence. That is
 * the principled replacement for the fixed "two demonstrations" gate.
 *
 * D.6 (§5.2 rows 5–6) replaces the two fixed MDL costs with measured ones,
 * each behind a flag defaulting OFF (the constant is the CONTROL):
 *   · the unknown-token cost (20 bits) → −log₂ of the unseen-word mass under
 *     a Good–Turing estimate over the deck's frequency table — the estimate
 *     drifts correctly as the deck grows (more observed mass ⇒ higher cost
 *     of the unknown);
 *   · the slot annotation cost (15 bits, operators/learning.ts SLOT_COST) →
 *     −log₂ P(slot position | shell grammar) estimated from the
 *     learned-operator library's templates, smoothed by the same Good–Turing
 *     table (an unseen position costs the unseen mass).
 */

/** The fixed unknown-token cost (bits) — the CONTROL of the Good–Turing gate. */
export const UNKNOWN_TOKEN_COST = 20;

/** The fixed slot-annotation cost (bits) — the CONTROL of the shell-grammar
 *  gate (mirrors operators/learning.ts SLOT_COST; the bench asserts parity). */
export const SLOT_ANNOTATION_CONTROL_BITS = 15;

/** Per-gate enable flags — ALL OFF by default (the constants are the
 *  controls; a gate flips on only behind its bench). */
export const MDL_MEASURED_FLAGS: { slot: boolean; unknown: boolean } = { slot: false, unknown: false };

export type MeasuredMdlGate = keyof typeof MDL_MEASURED_FLAGS;

/** Enable/disable one measured MDL gate. */
export function setMeasuredMdlGate(gate: MeasuredMdlGate, enabled: boolean): void {
  MDL_MEASURED_FLAGS[gate] = enabled;
}

/** Reset both gates behind their controls (the constants report's state). */
export function resetMeasuredMdlGates(): void {
  MDL_MEASURED_FLAGS.slot = false;
  MDL_MEASURED_FLAGS.unknown = false;
}

// ────────────────────────────────────────────────────────────────────────────
// Good–Turing over the deck frequency table (§5.2 row 6)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The deck's frequency table as integer token counts: the deck is a
 * frequency-ORDERED word list, so the Zipf rank weights (1/(i+1)) are the
 * implied frequencies, scaled so the rarest word carries one token. The
 * resulting count table is what the Good–Turing estimate reads.
 */
function impliedDeckCounts(words: readonly string[]): number[] {
  const n = words.length;
  if (n === 0) return [];
  const min = 1 / n;
  const counts: number[] = [];
  for (let i = 0; i < n; i += 1) {
    counts.push(Math.max(1, Math.round(1 / (i + 1) / min)));
  }
  return counts;
}

export interface GoodTuringTable {
  /** The probability mass of unseen types: N₁ / N. */
  unseenMass: number;
  /** The Good–Turing-adjusted probability of an observed count c
   *  ((c+1)·N_{c+1} / (N_c·N)); falls back to the unseen mass where the
   *  table carries no mass for c. */
  probabilityOfCount(count: number): number;
}

/** The Good–Turing table over a frequency-of-frequency count table
 *  (Gale & Sampson 1995). Null when the table is empty. */
export function goodTuringTable(counts: readonly number[]): GoodTuringTable | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (counts.length === 0 || total <= 0) return null;
  const freqOfFreq = new Map<number, number>();
  for (const c of counts) {
    if (c > 0) freqOfFreq.set(c, (freqOfFreq.get(c) ?? 0) + 1);
  }
  const typesAt = (c: number): number => freqOfFreq.get(c) ?? 0;
  const unseenMass = typesAt(1) / total;
  return {
    unseenMass,
    probabilityOfCount: (count: number): number => {
      if (count <= 0) return unseenMass;
      const here = typesAt(count);
      if (here === 0) return unseenMass;
      const next = typesAt(count + 1);
      // Standard Good–Turing: r* = (r+1)·N_{r+1}/N_r while the next
      // frequency of frequency exists; above the table's top the estimate
      // falls back to the empirical count (Gale & Sampson's simple version).
      const adjusted = next > 0 ? ((count + 1) * next) / here : count;
      return adjusted / total;
    }
  };
}

/** The Good–Turing unseen-word mass over the deck's frequency table
 *  (null when the deck is empty — no table to estimate from). */
export function goodTuringUnseenMass(words: readonly string[]): number | null {
  return goodTuringTable(impliedDeckCounts(words))?.unseenMass ?? null;
}

/** −log₂ of the unseen-word mass — the measured unknown-token cost (bits).
 *  Null when the deck is empty (the control constant then stays). */
export function goodTuringUnknownCost(words: readonly string[]): number | null {
  const mass = goodTuringUnseenMass(words);
  if (mass === null) return null;
  const safe = Math.max(mass, 1e-9); // finite estimate, never log(0)
  return -Math.log2(safe);
}

// ────────────────────────────────────────────────────────────────────────────
// The slot annotation cost from the shell grammar (§5.2 row 5)
// ────────────────────────────────────────────────────────────────────────────

/** The token index of the {slot} marker in a learned shell template
 *  (relation holes read as single placeholder tokens so indices are real
 *  token positions). −1 when the template carries no slot. */
function slotPositionOf(template: string): number {
  const tokens = tokenizeText(template.replace(/\{p:[a-z-]+(?::\d+)?\}/g, 'hole').replace(/\{slot\}/g, 'slot'));
  return tokens.indexOf('slot');
}

/**
 * −log₂ P(slot position | shell grammar), estimated from the learned-
 * operator library's templates: the library's slot positions form the
 * grammar's position table, and each position costs −log₂ of its
 * Good–Turing-adjusted probability (an unseen position costs the unseen
 * mass). Returns the library-wide mean annotation cost (bits), or null when
 * no template carries a slot.
 */
export function shellSlotAnnotationCost(templates: readonly string[]): number | null {
  const counts = new Map<number, number>();
  for (const template of templates) {
    const position = slotPositionOf(template);
    if (position >= 0) counts.set(position, (counts.get(position) ?? 0) + 1);
  }
  const table = goodTuringTable([...counts.values()]);
  if (table === null || counts.size === 0) return null;
  let totalBits = 0;
  let slots = 0;
  for (const [position, count] of counts) {
    const p = Math.max(table.probabilityOfCount(count), 1e-9);
    totalBits += count * -Math.log2(p);
    slots += count;
  }
  return slots === 0 ? null : totalBits / slots;
}

/** The LIVE slot-annotation cost: the library-estimated value when the gate
 *  is on, else the 15-bit constant (the control). */
export function measuredSlotAnnotationCost(templates: readonly string[], fallback = SLOT_ANNOTATION_CONTROL_BITS): number {
  if (!MDL_MEASURED_FLAGS.slot) return fallback;
  const estimated = shellSlotAnnotationCost(templates);
  return estimated !== null && Number.isFinite(estimated) ? estimated : fallback;
}

/** Zipf-style bit cost per token, derived from deck frequency order. */
export class TokenCostModel {
  private readonly costs = new Map<string, number>();
  /** The Good–Turing measured unknown-token cost (null when the deck is
   *  empty — no frequency table to estimate from). */
  private readonly measuredUnknown: number | null;

  constructor(words: readonly string[], private readonly unknownCost = UNKNOWN_TOKEN_COST) {
    const n = words.length;
    if (n === 0) {
      this.measuredUnknown = null;
      return;
    }
    const weights = words.map((_, i) => 1 / (i + 1));
    const total = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i += 1) {
      this.costs.set(words[i], -Math.log2(weights[i] / total));
    }
    this.measuredUnknown = goodTuringUnknownCost(words);
  }

  costOf(token: string): number {
    const known = this.costs.get(token);
    if (known !== undefined) return known;
    // D.6: with the gate on, an unseen token costs −log₂ of the Good–Turing
    // unseen mass; off (or an empty deck), the fixed constant is the control.
    if (MDL_MEASURED_FLAGS.unknown && this.measuredUnknown !== null) return this.measuredUnknown;
    return this.unknownCost;
  }

  costOfText(text: string): number {
    return tokenizeText(text).reduce((sum, token) => sum + this.costOf(token), 0);
  }

  /** The unknown-token cost the model applies right now (measured or control). */
  unknownTokenCost(): number {
    if (MDL_MEASURED_FLAGS.unknown && this.measuredUnknown !== null) return this.measuredUnknown;
    return this.unknownCost;
  }
}
