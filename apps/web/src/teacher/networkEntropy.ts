/**
 * NETWORK ENTROPY — the uncertainty of the observer's own answers, summed
 * over everything it knows about (docs/SYNTHETIC_MIND.md §1, task 39).
 *
 * The principle the observer is built on says coupling lowers entropy by
 * opening a channel between elements. Pinned to the observer as built: the
 * elements are concepts, the channels are relation edges, and the entropy is
 * how unsure the observer would be if asked about each concept. This module
 * is that measure. It is a READOUT — it changes nothing, it only looks.
 *
 * For every concept the observer knows (deck words and grown words) and
 * every question the operator layer can form about it — one SLOT per
 * predicate in ENTROPY_SLOTS, plus the definition — the slot is in one of
 * six states, read exactly as the answer layer would read it:
 *
 *   certain        a corroborated, unweakened edge (spoken flat)     0.95  0.29 bits
 *   single-source  one source class (spoken "I think")               0.75  0.81
 *   inherited      no own edge; an is-a ancestor has one (via …)     0.70  0.88
 *   weakened       grade-weakened (spoken "Probably")                0.65  0.93
 *   conflicted     asserted and denied (the contradiction ledger)    0.50  1.00
 *   unknown        nothing — the observer would have to ask          0.50  1.00
 *
 * The number is the probability the observer's answer would be right; the
 * slot's entropy is the binary entropy of that probability, in bits. So a
 * slot the observer knows nothing about costs one bit, a corroborated edge
 * costs 0.29, and a contradiction costs as much as ignorance — disagreement
 * IS uncertainty. A concept's entropy is the sum of its slots; the network's
 * is the sum over concepts. Each concept is also weighted by how often the
 * world asks about it (1 + its gap mentions), because a bit of ignorance
 * about a word nobody asks about matters less than one about a word asked
 * every day — the weighted total is what self-direction should minimize.
 *
 * Two totals are reported because vocabulary growth adds concepts: `total`
 * rises when the observer learns that a zebu exists and knows one thing
 * about it (honest: nine slots of new ignorance), so a benchmark that wants
 * to see learning on a fixed set of concepts passes `concepts` and reads
 * `mean` — the per-concept average — instead. The prediction the whole
 * design rests on (task 41) is that the steps that lower this the most are
 * the ones after which the observer does best on what it was never shown.
 */
import type { Negation, Relation, RelationPredicate } from './relations';
import { classesOf, hedgeFor } from './corroboration';
import { shannonEntropyBits } from '@sschepis/sentient-core';

/** The questions the operator layer can ask about any concept. */
export const ENTROPY_SLOTS: readonly RelationPredicate[] = [
  'is-a',
  'has-part',
  'has-property',
  'capable-of',
  'used-for',
  'made-of',
  'located-in',
  'causes',
  'requires',
  'opposite-of'
];

export type SlotState = 'certain' | 'single-source' | 'weakened' | 'inherited' | 'conflicted' | 'unknown';

/** P(answer right) the answer layer's own hedge ladder implies per state. */
export const SLOT_CONFIDENCE: Readonly<Record<SlotState, number>> = {
  certain: 0.95,
  'single-source': 0.75,
  weakened: 0.65,
  inherited: 0.7,
  conflicted: 0.5,
  unknown: 0.5
};

/** Binary entropy, bits. */
export function binaryEntropyBits(p: number): number {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return shannonEntropyBits([q, 1 - q]);
}

/** Bits per slot state (derived, fixed). */
export const SLOT_BITS: Readonly<Record<SlotState, number>> = Object.fromEntries(
  (Object.keys(SLOT_CONFIDENCE) as SlotState[]).map((state) => [state, binaryEntropyBits(SLOT_CONFIDENCE[state])])
) as Record<SlotState, number>;

const IS_A_MAX_DEPTH = 4;

export interface ConceptEntropy {
  word: string;
  /** Sum of slot bits (unweighted). */
  bits: number;
  /** 1 + gap mentions — how often the world asks about this word. */
  weight: number;
  /** Slot states, keyed by predicate (and 'definition'). */
  slots: Record<string, SlotState>;
}

export interface NetworkEntropyReport {
  /** Concepts measured. */
  concepts: number;
  /** Σ concept bits. */
  total: number;
  /** Σ weight × concept bits — what self-direction should minimize. */
  weightedTotal: number;
  /** total / concepts — comparable across vocabulary sizes. */
  mean: number;
  /** Slots by state, over the whole network. */
  byState: Record<SlotState, number>;
  /** Bits by slot (predicate or 'definition'), summed over concepts. */
  bySlot: Record<string, number>;
  /** The highest-entropy concepts (weighted), most uncertain first. */
  top: Array<{ word: string; bits: number; weight: number }>;
  /** Wall-clock cost of the measurement. */
  ms: number;
}

export interface NetworkEntropyInput {
  /** Every concept the observer knows: deck words and grown words. */
  words: ReadonlyArray<{ word: string; definition: string }>;
  relations: readonly Relation[];
  negations: readonly Negation[];
  /** Gap utterance → miss count (the curiosity ledger). */
  gapCounts?: ReadonlyMap<string, number>;
  /** Measure only these concepts (a fixed set for a benchmark). */
  concepts?: ReadonlySet<string>;
  /** How many top concepts to list (default 20). */
  topN?: number;
}

/** Unweighted bits of a set of slot states. */
export function conceptBits(slots: Readonly<Record<string, SlotState>>): number {
  let bits = 0;
  for (const state of Object.values(slots)) bits += SLOT_BITS[state];
  return bits;
}

/**
 * The state of one slot, given the concept's own edges under the predicate,
 * whether any of them is denied, and whether an is-a ancestor holds one.
 */
export function slotState(
  own: readonly Relation[],
  conflicted: boolean,
  inherited: boolean
): SlotState {
  if (conflicted) return 'conflicted';
  if (own.length > 0) {
    // The best-supported edge decides: the answer layer speaks the strongest.
    let best: SlotState = 'weakened';
    for (const edge of own) {
      const hedge = hedgeFor(classesOf(edge), edge.strength ?? 1);
      if (hedge === '') return 'certain';
      if (hedge === 'I think') best = 'single-source';
    }
    return best;
  }
  return inherited ? 'inherited' : 'unknown';
}

const key3 = (s: string, p: string, o: string): string => `${s}\u0000${p}\u0000${o}`;

function measure(input: NetworkEntropyInput): { report: NetworkEntropyReport; perConcept: ConceptEntropy[] } {
  const started = Date.now();
  const topN = input.topN ?? 20;
  const denied = new Set(input.negations.map((n) => key3(n.subject, n.predicate, n.object)));
  // Indexes, built once.
  const bySubjectPredicate = new Map<string, Relation[]>();
  const isAParents = new Map<string, string[]>();
  for (const edge of input.relations) {
    const k = `${edge.subject}\u0000${edge.predicate}`;
    const list = bySubjectPredicate.get(k) ?? [];
    list.push(edge);
    bySubjectPredicate.set(k, list);
    if (edge.predicate === 'is-a' && !denied.has(key3(edge.subject, 'is-a', edge.object))) {
      const parents = isAParents.get(edge.subject) ?? [];
      parents.push(edge.object);
      isAParents.set(edge.subject, parents);
    }
  }
  // A denial's subject+predicate marks a slot as possibly conflicted; the
  // slot is conflicted when an own edge (or an inherited one) asserts the
  // denied object — the same reading contradictions.ts makes, without the
  // triage.
  const deniedBySlot = new Map<string, Set<string>>();
  for (const n of input.negations) {
    const k = `${n.subject}\u0000${n.predicate}`;
    const set = deniedBySlot.get(k) ?? new Set<string>();
    set.add(n.object);
    deniedBySlot.set(k, set);
  }
  const ancestorsOf = (word: string): string[] => {
    const reached: string[] = [];
    const seen = new Set<string>([word]);
    let frontier = [word];
    for (let depth = 0; depth < IS_A_MAX_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const w of frontier) {
        for (const parent of isAParents.get(w) ?? []) {
          if (seen.has(parent)) continue;
          seen.add(parent);
          reached.push(parent);
          next.push(parent);
        }
      }
      frontier = next;
    }
    return reached;
  };
  // Gap mentions per word: a gap utterance mentions every token in it.
  const mentions = new Map<string, number>();
  if (input.gapCounts !== undefined) {
    for (const [utterance, count] of input.gapCounts) {
      for (const token of new Set(utterance.toLowerCase().split(/[^a-z']+/).filter((t) => t.length > 1))) {
        mentions.set(token, (mentions.get(token) ?? 0) + count);
      }
    }
  }

  const byState: Record<SlotState, number> = { certain: 0, 'single-source': 0, weakened: 0, inherited: 0, conflicted: 0, unknown: 0 };
  const bySlot: Record<string, number> = { definition: 0 };
  for (const p of ENTROPY_SLOTS) bySlot[p] = 0;
  const perConcept: ConceptEntropy[] = [];
  let total = 0;
  let weightedTotal = 0;

  for (const entry of input.words) {
    const word = entry.word.toLowerCase();
    if (input.concepts !== undefined && !input.concepts.has(word)) continue;
    const slots: Record<string, SlotState> = {};
    const ancestors = ancestorsOf(word);
    for (const predicate of ENTROPY_SLOTS) {
      const slotKey = `${word}\u0000${predicate}`;
      const own = (bySubjectPredicate.get(slotKey) ?? []).filter((e) => !denied.has(key3(word, predicate, e.object)));
      const deniedObjects = deniedBySlot.get(slotKey);
      let conflicted = false;
      let inherited = false;
      if (deniedObjects !== undefined && deniedObjects.size > 0) {
        // Own edge asserting a denied object → conflicted (the denial and
        // the edge are both live: the filter above removed exact matches, so
        // look at the unfiltered list).
        for (const e of bySubjectPredicate.get(slotKey) ?? []) {
          if (deniedObjects.has(e.object)) {
            conflicted = true;
            break;
          }
        }
      }
      if (!conflicted) {
        for (const ancestor of ancestors) {
          const up = bySubjectPredicate.get(`${ancestor}\u0000${predicate}`);
          if (up === undefined || up.length === 0) continue;
          for (const e of up) {
            if (denied.has(key3(word, predicate, e.object))) {
              // A subject-level exception is not a conflict (penguin cannot
              // fly): it is a resolved denial; the slot simply is not inherited
              // through that object.
              continue;
            }
            inherited = true;
            break;
          }
          if (inherited) break;
        }
      }
      const state = slotState(own, conflicted, inherited);
      slots[predicate] = state;
      byState[state] += 1;
      bySlot[predicate] += SLOT_BITS[state];
    }
    const definitionState: SlotState = entry.definition.trim().length > 0 ? 'certain' : 'unknown';
    slots.definition = definitionState;
    byState[definitionState] += 1;
    bySlot.definition += SLOT_BITS[definitionState];

    const bits = conceptBits(slots);
    const weight = 1 + (mentions.get(word) ?? 0);
    total += bits;
    weightedTotal += weight * bits;
    perConcept.push({ word, bits, weight, slots });
  }

  const top = perConcept
    .slice()
    .sort((a, b) => b.weight * b.bits - a.weight * a.bits || a.word.localeCompare(b.word))
    .slice(0, topN)
    .map(({ word, bits, weight }) => ({ word, bits: round(bits), weight }));

  const report: NetworkEntropyReport = {
    concepts: perConcept.length,
    total: round(total),
    weightedTotal: round(weightedTotal),
    mean: perConcept.length === 0 ? 0 : round(total / perConcept.length),
    byState,
    bySlot: Object.fromEntries(Object.entries(bySlot).map(([k, v]) => [k, round(v)])),
    top,
    ms: Date.now() - started
  };
  return { report, perConcept };
}

/** Measure the network. Pure; O(edges + concepts × slots × ancestors). */
export function networkEntropy(input: NetworkEntropyInput): NetworkEntropyReport {
  return measure(input).report;
}

/** Per-concept detail (for the goal loop and the benches), most uncertain first. */
export function conceptEntropies(input: NetworkEntropyInput): ConceptEntropy[] {
  return measure(input).perConcept.sort((a, b) => b.weight * b.bits - a.weight * a.bits || a.word.localeCompare(b.word));
}

/** One line for the learning stream. */
export function describeEntropy(report: NetworkEntropyReport, previous?: NetworkEntropyReport | null): string {
  const delta = previous ? ` (Δ ${signed(report.total - previous.total)} bits, mean ${signed(report.mean - previous.mean)})` : '';
  const states = `${report.byState.certain} certain · ${report.byState['single-source']} single-source · ${report.byState.weakened} weakened · ${report.byState.inherited} inherited · ${report.byState.conflicted} conflicted · ${report.byState.unknown} unknown`;
  return `entropy: ${report.total} bits over ${report.concepts} concepts, mean ${report.mean}, weighted ${report.weightedTotal}${delta} · ${states} · ${report.ms} ms`;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;
const signed = (x: number): string => `${x >= 0 ? '+' : ''}${round(x)}`;
