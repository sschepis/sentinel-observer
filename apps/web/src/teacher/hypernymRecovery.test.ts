/**
 * H.3 `hypernym-recovery-bench` (§9.8) — concept synthesis as MDL
 * abstraction, measured against held-out known hypernyms.
 *
 * The `is-a` edges to a set of known hypernyms (bird, tool, vehicle) are
 * HELD OUT: the members remain with their part/property/capability edges,
 * and induction must re-invent the hypernym from the shared edges alone.
 * Measured:
 *   · recovery rate — an induced node whose edge set matches the hidden
 *     hypernym's (vs. a subject-shuffled chance baseline);
 *   · precision — induced nodes matching NO word/hypernym are candidate
 *     discoveries (inspected by hand here: the container cluster is real);
 *   · false-inheritance rate — claims inherited through an induced node
 *     that are false under the full graph: 0 in ASSERTED speech (a claim
 *     satisfied by the member's own edge is a graph edge), hedged speech
 *     counted separately (the ostrich-fly generalization).
 *
 * Refutation condition (§9.8): induced nodes are mostly gloss-template
 * artifacts — then the edge distribution is too template-driven for MDL
 * abstraction.
 *
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { TokenCostModel } from './mdl';
import { gainX, induceConcepts, type InducedConcept } from './conceptSynthesis';
import { mulberry32 } from '@sschepis/sentient-core';
import type { Relation, RelationPredicate } from './relations';

const r = (subject: string, predicate: RelationPredicate, object: string): Relation =>
  ({ subject, predicate, object, source: 'bench', origin: 'authored' } as Relation);

/** The full graph (ground truth): everything, INCLUDING the held-out is-a
 *  edges that induction must not see. */
const FULL: Relation[] = [];
const add = (s: string, p: RelationPredicate, o: string): void => {
  FULL.push(r(s, p, o));
};

// Birds: 4 full members + the hypernym node. The member → bird is-a edges
// are the HELD-OUT ground truth (listed separately below).
for (const b of ['robin', 'sparrow', 'crow', 'finch']) {
  add(b, 'has-part', 'wings');
  add(b, 'has-part', 'feathers');
  add(b, 'capable-of', 'fly');
  add(b, 'has-part', 'beak');
}
add('robin', 'located-in', 'tree');
add('sparrow', 'located-in', 'bush');
add('crow', 'located-in', 'field');
add('finch', 'located-in', 'nest');
add('bird', 'has-part', 'wings');
add('bird', 'has-part', 'feathers');
add('bird', 'capable-of', 'fly');
add('bird', 'has-part', 'beak');
// Penguin and kiwi: share 3 edges with the bird cluster but carry a
// confirmed-false capable-of fly — they join WITH an exception (the
// negation costs bits and blocks their fly inheritance).
add('penguin', 'has-part', 'wings');
add('penguin', 'has-part', 'feathers');
add('penguin', 'has-part', 'beak');
add('kiwi', 'has-part', 'wings');
add('kiwi', 'has-part', 'feathers');
add('kiwi', 'has-part', 'beak');
// Ostrich: shares 2 edges, no negation — the greedy generalizes fly to it
// (the §9.2 "even if the definition never said so"), FALSE under ground
// truth: the bench's hedged false-inheritance case.
add('ostrich', 'has-part', 'wings');
add('ostrich', 'has-part', 'feathers');
// Tools and vehicles.
for (const t of ['hammer', 'saw', 'wrench', 'drill']) {
  add(t, 'has-part', 'handle');
  add(t, 'made-of', 'metal');
  add(t, 'used-for', 'work');
}
add('tool', 'has-part', 'handle');
add('tool', 'made-of', 'metal');
add('tool', 'used-for', 'work');
for (const v of ['car', 'truck', 'bus']) {
  add(v, 'has-part', 'wheels');
  add(v, 'has-part', 'engine');
  add(v, 'capable-of', 'move');
}
add('vehicle', 'has-part', 'wheels');
add('vehicle', 'has-part', 'engine');
add('vehicle', 'capable-of', 'move');
// A cluster with NO word: the candidate discovery (a real container
// concept, to be inspected by hand).
for (const c of ['cup', 'bowl', 'mug', 'pitcher']) {
  add(c, 'made-of', 'ceramic');
  add(c, 'has-part', 'handle');
  add(c, 'has-part', 'lid');
}
add('cup', 'located-in', 'kitchen');
add('bowl', 'located-in', 'pantry');
add('mug', 'located-in', 'desk');
add('pitcher', 'located-in', 'fridge');

/** The held-out edges: member is-a hypernym — ground truth, NOT seen by
 *  induction. */
const HELD_OUT: Relation[] = [];
for (const b of ['robin', 'sparrow', 'crow', 'finch']) HELD_OUT.push(r(b, 'is-a', 'bird'));
for (const t of ['hammer', 'saw', 'wrench', 'drill']) HELD_OUT.push(r(t, 'is-a', 'tool'));
for (const v of ['car', 'truck', 'bus']) HELD_OUT.push(r(v, 'is-a', 'vehicle'));

/** Induction input: the full graph minus the held-out is-a edges. */
const heldOutKeys = new Set(HELD_OUT.map((x) => `${x.subject}\u0000${x.predicate}\u0000${x.object}`));
const INDUCTION_INPUT: Relation[] = FULL.filter(
  (x) => !heldOutKeys.has(`${x.subject}\u0000${x.predicate}\u0000${x.object}`)
);

const WORDS = [
  'robin', 'sparrow', 'crow', 'finch', 'penguin', 'kiwi', 'ostrich', 'bird',
  'hammer', 'saw', 'wrench', 'drill', 'tool', 'car', 'truck', 'bus', 'vehicle',
  'cup', 'bowl', 'mug', 'pitcher', 'wings', 'feathers', 'beak', 'fly',
  'tree', 'bush', 'field', 'nest', 'handle', 'metal', 'work', 'wheels', 'engine',
  'move', 'ceramic', 'lid', 'kitchen', 'pantry', 'desk', 'fridge'
];

const COSTS = new TokenCostModel(WORDS);
const NEGATIONS = [
  { subject: 'penguin', predicate: 'capable-of' as RelationPredicate, object: 'fly' },
  { subject: 'kiwi', predicate: 'capable-of' as RelationPredicate, object: 'fly' }
];
/** Ground-truth falsehoods BEYOND the graph (the false-inheritance table). */
const GROUND_TRUTH_FALSE = new Set(['ostrich\u0000capable-of\u0000fly']);

/** The known hypernyms and their edge sets (the recovery targets). */
const HYPERNYM_EDGES: Record<string, Set<string>> = {
  bird: new Set(['has-part:wings', 'has-part:feathers', 'capable-of:fly', 'has-part:beak']),
  tool: new Set(['has-part:handle', 'made-of:metal', 'used-for:work']),
  vehicle: new Set(['has-part:wheels', 'has-part:engine', 'capable-of:move'])
};

const edgeSetOf = (node: InducedConcept): Set<string> =>
  new Set(node.edges.map((e) => `${e.predicate}:${e.object}`));
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((k) => b.has(k));

const recoveredHypernyms = (nodes: readonly InducedConcept[]): Set<string> => {
  const recovered = new Set<string>();
  for (const [word, keys] of Object.entries(HYPERNYM_EDGES)) {
    for (const node of nodes) {
      if (sameSet(edgeSetOf(node), keys)) recovered.add(word);
    }
  }
  return recovered;
};

describe('H.3 hypernym recovery: MDL abstraction re-invents held-out hypernyms', () => {
  it('§9.1: gainX matches the paper accounting in the Zipf currency', () => {
    const shared = [
      { predicate: 'has-part' as RelationPredicate, object: 'wings' },
      { predicate: 'has-part' as RelationPredicate, object: 'feathers' },
      { predicate: 'capable-of' as RelationPredicate, object: 'fly' },
      { predicate: 'has-part' as RelationPredicate, object: 'beak' }
    ];
    const members = ['robin', 'sparrow', 'crow', 'finch'];
    // Four members store the four edges each; X stores them once plus one
    // is-a edge per member plus its name — positive exactly when the
    // redundancy pays for the abstraction.
    const gain = gainX(members, shared, [], { costs: COSTS });
    expect(gain).toBeGreaterThan(0);
    // The exception term subtracts a confirmed-false record's bits.
    const withException = gainX(members, shared, [{ member: 'robin', predicate: 'capable-of', object: 'fly' }], {
      costs: COSTS
    });
    expect(withException).toBeLessThan(gain);
    // A too-small cluster does not pay for itself (the greedy refuses it).
    const tooSmall = gainX(['robin', 'sparrow'], shared.slice(0, 2), [], { costs: COSTS });
    expect(tooSmall).toBeLessThanOrEqual(0);
  });

  it('recovers every held-out hypernym from the members\' shared edges, well above chance', () => {
    const induced = induceConcepts(INDUCTION_INPUT, { costs: COSTS, negations: NEGATIONS });
    const recovered = recoveredHypernyms(induced);
    expect(recovered.size).toBe(Object.keys(HYPERNYM_EDGES).length);

    // CHANCE BASELINE: shuffle the subjects of the induction input — the
    // edge structure is unchanged but no meaning survives — and count how
    // often the same hypernym edge sets re-appear.
    const rng = mulberry32(0x9f1e);
    let chanceRecovered = 0;
    const trials = 20;
    const subjects = INDUCTION_INPUT.map((x) => x.subject);
    for (let trial = 0; trial < trials; trial += 1) {
      const shuffled = [...subjects];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const noiseGraph = INDUCTION_INPUT.map((x, i) => ({ ...x, subject: shuffled[i] }));
      const noiseNodes = induceConcepts(noiseGraph, { costs: COSTS });
      chanceRecovered += recoveredHypernyms(noiseNodes).size;
    }
    const chanceRate = chanceRecovered / trials;
    const recoveryRate = recovered.size / Object.keys(HYPERNYM_EDGES).length;
    // The recovery is a ground-truth number with no LLM in the loop —
    // record it and require it to beat the shuffle baseline by a mile.
    // eslint-disable-next-line no-console
    console.log(`[hypernymRecoveryBench] recovery ${recoveryRate.toFixed(2)} vs chance ${chanceRate.toFixed(2)}`);
    expect(recoveryRate).toBe(1);
    expect(chanceRate).toBe(0);
  });

  it('precision: every induced node is a recovery or a genuine candidate discovery (none are junk)', () => {
    const induced = induceConcepts(INDUCTION_INPUT, { costs: COSTS, negations: NEGATIONS });
    const recovered = recoveredHypernyms(induced);
    const discoveries = induced.filter(
      (node) => !Object.values(HYPERNYM_EDGES).some((keys) => sameSet(edgeSetOf(node), keys))
    );
    // Hand inspection of the discovery: {made-of ceramic, has-part handle,
    // has-part lid} over cup/bowl/mug/pitcher is a REAL container concept,
    // not a gloss-template artifact.
    expect(discoveries.length).toBe(1);
    const discovery = discoveries[0];
    expect(discovery.members).toEqual(expect.arrayContaining(['cup', 'bowl', 'mug', 'pitcher']));
    // The recovered hypernyms are exactly the known set — no induced node
    // matches a word that is NOT a held-out hypernym (member-word matches
    // would be degenerate artifacts).
    expect(induced.length).toBe(recovered.size + discoveries.length);
    // eslint-disable-next-line no-console
    console.log(
      `[hypernymRecoveryBench] nodes ${induced.length}: recovered ${recovered.size}, discoveries ${discoveries.length} (${discovery.members.join(', ')})`
    );
  });

  it('false-inheritance: 0 in asserted speech, hedged generalization counted separately', () => {
    const induced = induceConcepts(INDUCTION_INPUT, { costs: COSTS, negations: NEGATIONS });
    const fullKeys = new Set(FULL.map((x) => `${x.subject}\u0000${x.predicate}\u0000${x.object}`));
    let assertedFalse = 0;
    let hedgedFalse = 0;
    let inheritedClaims = 0;
    for (const node of induced) {
      for (const member of node.members) {
        for (const edge of node.edges) {
          // The member's confirmed-false exception blocks inheritance —
          // the claim is never made at all (penguin/kiwi fly).
          const blocked = node.exceptions.some(
            (x) => x.member === member && x.predicate === edge.predicate && x.object === edge.object
          );
          if (blocked) continue;
          const hasOwn = fullKeys.has(`${member}\u0000${edge.predicate}\u0000${edge.object}`);
          // Asserted speech = the member's own graph edge; a graph edge is
          // never "false under the full graph" — the 0 is structural and
          // the bench pins it.
          if (hasOwn) {
            if (GROUND_TRUTH_FALSE.has(`${member}\u0000${edge.predicate}\u0000${edge.object}`)) assertedFalse += 1;
            continue;
          }
          inheritedClaims += 1;
          // Inherited (hedged) claims: permitted to be wrong, counted.
          if (GROUND_TRUTH_FALSE.has(`${member}\u0000${edge.predicate}\u0000${edge.object}`)) hedgedFalse += 1;
        }
      }
    }
    expect(assertedFalse).toBe(0);
    expect(hedgedFalse).toBe(1); // ostrich-fly — the hedged generalization
    expect(inheritedClaims).toBeGreaterThanOrEqual(1);
    // The exceptions did their job: penguin and kiwi fly are NOT inherited.
    const birdNode = induced.find((node) => node.members.includes('penguin'));
    expect(birdNode).toBeDefined();
    expect(birdNode!.exceptions.filter((x) => x.object === 'fly').length).toBe(2);
    // eslint-disable-next-line no-console
    console.log(
      `[hypernymRecoveryBench] false-inheritance: asserted ${assertedFalse}, hedged ${hedgedFalse} (of ${inheritedClaims} inherited claims)`
    );
  });
});
