/**
 * @jest-environment node
 *
 * PATH-ENTROPY-BENCH (improvements.md §4.3 / improvements-tasks.md C.3) —
 * branching entropy along chain walks: does the candidate distribution over
 * is-a PATHS predict a claim's survival of a corrupted edge better than the
 * single surfaced path's strength?
 *
 * THE HYPOTHESIS UNDER TEST. A chained "Yes" surfaces *a* path. Two claims
 * can both be answered while resting on very different evidence: one reached
 * by a single path through a weakened edge, another by several independent
 * paths through strong edges. Path MASS (Σ edge-strength products over all
 * routes) should predict post-corruption correctness better than the single
 * strongest path's strength, because a multi-path claim survives the loss
 * of any one edge while a single-path claim dies with its one edge — even
 * when that single edge is full strength (penguin) or the alternative
 * routes are weak (snake's 0.35 direct edge survives because a 2-hop route
 * backs it).
 *
 * THE CONSTRUCTION. A deterministic is-a graph of leaves with varied route
 * redundancy (the same shape cde-bench's CHAIN section measures): robin and
 * trout with several independent routes, horse/penguin/goat with exactly
 * one, snake with two weak routes, lamb with a diamond. Two corruptions,
 * each hitting the STRONGEST edge on the strongest path:
 *   · REMOVE the edge — correctness = the is-a walk still reaches the
 *     target (a single-path claim flips).
 *   · WEAKEN the edge to 0.05 — correctness = the best surviving route's
 *     product clears 0.5 (the confident-answer floor the holographic
 *     fallback already uses: HOLO_YES_STRONG), so a claim that could only
 *     be spoken "Probably" is no longer a confident Yes.
 * Predictors measured pre-corruption: single (max path strength), mass,
 * count, H̃. Discriminative power is Mann–Whitney AUC of the predictor
 * against post-corruption correctness.
 *
 * VERDICT RULE (§4.6): PASS when path mass predicts correctness better than
 * the single-path strength. The numbers are reported and the pass is
 * asserted — this bench is a gate, not an observation.
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { isATypeOf, isAPaths, deniedFromNegations } from './chain';
import type { IsAPath } from './chain';
import { normalizedEntropy } from './cde';
import { pathEvidence, hedgedByPaths, pathHedgeWord } from './pathEvidence';
import type { Relation } from './relations';

/** Mann–Whitney AUC: P(a random positive scores above a random negative). */
function auc(positive: readonly number[], negative: readonly number[]): number {
  if (positive.length === 0 || negative.length === 0) return 0.5;
  let rank = 0;
  for (const p of positive) {
    for (const n of negative) {
      if (p > n) rank += 1;
      else if (p === n) rank += 0.5;
    }
  }
  return rank / (positive.length * negative.length);
}

function edge(subject: string, object: string, strength: number): Relation {
  return { subject, predicate: 'is-a', object, source: '', origin: 'authored', strength };
}

/** Leaves with varied route redundancy to 'animal' (see the header). */
const GRAPH: readonly Relation[] = [
  edge('robin', 'bird', 1),
  edge('bird', 'animal', 1),
  edge('robin', 'animal', 0.5),
  edge('sparrow', 'bird', 1),
  edge('sparrow', 'animal', 0.7),
  edge('dog', 'mammal', 1),
  edge('mammal', 'animal', 1),
  edge('dog', 'animal', 0.3),
  edge('cat', 'mammal', 1),
  edge('cat', 'animal', 0.85),
  edge('horse', 'mammal', 0.9),
  edge('trout', 'fish', 1),
  edge('fish', 'animal', 1),
  edge('trout', 'vertebrate', 0.9),
  edge('vertebrate', 'animal', 1),
  edge('fish', 'vertebrate', 0.8),
  edge('trout', 'animal', 0.45),
  edge('salmon', 'fish', 1),
  edge('salmon', 'vertebrate', 0.9),
  edge('penguin', 'bird', 1),
  edge('hen', 'bird', 1),
  edge('hen', 'farm', 1),
  edge('farm', 'animal', 0.2),
  edge('snake', 'reptile', 0.4),
  edge('reptile', 'animal', 0.5),
  edge('snake', 'animal', 0.35),
  edge('lamb', 'sheep', 0.9),
  edge('sheep', 'animal', 1),
  edge('sheep', 'mammal', 1),
  edge('lamb', 'mammal', 0.1),
  edge('goat', 'mammal', 0.3),
  edge('frog', 'amphibian', 0.9),
  edge('amphibian', 'animal', 0.9),
  edge('frog', 'animal', 0.8)
];

const PROBES: ReadonlyArray<{ subject: string; object: string }> = [
  { subject: 'robin', object: 'animal' },
  { subject: 'sparrow', object: 'animal' },
  { subject: 'dog', object: 'animal' },
  { subject: 'cat', object: 'animal' },
  { subject: 'horse', object: 'animal' },
  { subject: 'trout', object: 'animal' },
  { subject: 'salmon', object: 'animal' },
  { subject: 'penguin', object: 'animal' },
  { subject: 'hen', object: 'animal' },
  { subject: 'snake', object: 'animal' },
  { subject: 'lamb', object: 'animal' },
  { subject: 'goat', object: 'animal' },
  { subject: 'frog', object: 'animal' }
];

/** The strongest edge lying on the strongest path (ties keep the first). */
function strongestEdgeOnStrongestPath(
  relations: readonly Relation[],
  paths: readonly IsAPath[]
): { subject: string; object: string } | null {
  let bestPath: IsAPath | null = null;
  for (const path of paths) {
    if (bestPath === null || path.strength > bestPath.strength) bestPath = path;
  }
  if (bestPath === null) return null;
  let strongest: { subject: string; object: string; strength: number } | null = null;
  for (let i = 0; i + 1 < bestPath.nodes.length; i += 1) {
    let best = -Infinity;
    for (const relation of relations) {
      if (
        relation.predicate === 'is-a' &&
        relation.subject === bestPath.nodes[i] &&
        relation.object === bestPath.nodes[i + 1]
      ) {
        best = Math.max(best, relation.strength ?? 1);
      }
    }
    if (strongest === null || best > strongest.strength) {
      strongest = { subject: bestPath.nodes[i], object: bestPath.nodes[i + 1], strength: best };
    }
  }
  return strongest ?? null;
}

/** REMOVE the strongest edge on the strongest path. */
function corruptByRemoval(relations: readonly Relation[], paths: readonly IsAPath[]): Relation[] {
  const target = strongestEdgeOnStrongestPath(relations, paths);
  if (target === null) return [...relations];
  return relations.filter(
    (relation) =>
      !(relation.predicate === 'is-a' && relation.subject === target.subject && relation.object === target.object)
  );
}

/** WEAKEN the strongest edge on the strongest path to a hedged strength. */
function corruptByWeakening(relations: readonly Relation[], paths: readonly IsAPath[]): Relation[] {
  const target = strongestEdgeOnStrongestPath(relations, paths);
  if (target === null) return [...relations];
  return relations.map((relation) =>
    relation.predicate === 'is-a' && relation.subject === target.subject && relation.object === target.object
      ? { ...relation, strength: 0.05 }
      : relation
  );
}

/** The confident-answer floor: below this product a claim may only be
 *  spoken hedged (the holographic fallback's HOLO_YES_STRONG boundary). */
const CONFIDENT_PRODUCT = 0.5;

interface CorruptionRow {
  probe: string;
  count: number;
  single: number;
  mass: number;
  entropy: number;
  survived: boolean;
}

/** Corrupt the strongest edge on each probe's strongest path and measure
 *  whether the claim survives under `stillCorrect`. */
function measureCorruption(
  corrupt: (relations: readonly Relation[], paths: readonly IsAPath[]) => Relation[],
  stillCorrect: (corrupted: readonly Relation[], subject: string, object: string) => boolean
): CorruptionRow[] {
  const rows: CorruptionRow[] = [];
  for (const probe of PROBES) {
    const relations: Relation[] = [...GRAPH];
    const paths = isAPaths(relations, probe.subject, probe.object);
    const strengths = paths.map((p) => p.strength);
    const corrupted = corrupt(relations, paths);
    rows.push({
      probe: `${probe.subject}->${probe.object}`,
      count: paths.length,
      single: strengths.length > 0 ? Math.max(...strengths) : 0,
      mass: strengths.reduce((a, b) => a + b, 0),
      entropy: normalizedEntropy(strengths),
      survived: stillCorrect(corrupted, probe.subject, probe.object)
    });
  }
  return rows;
}

/** Removal: the walk must still reach the target on the corrupted graph. */
function removalCorrect(corrupted: readonly Relation[], subject: string, object: string): boolean {
  return isATypeOf(corrupted, subject, object);
}

/** Weakening: the best surviving route must still clear the confident floor. */
function weakenCorrect(corrupted: readonly Relation[], subject: string, object: string): boolean {
  const strengths = isAPaths(corrupted, subject, object).map((p) => p.strength);
  return strengths.length > 0 && Math.max(...strengths) >= CONFIDENT_PRODUCT;
}

function reportRows(rows: readonly CorruptionRow[]): void {
  for (const row of rows) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${row.probe.padEnd(20)} paths=${String(row.count).padStart(2)} single=${row.single.toFixed(2)} ` +
        `mass=${row.mass.toFixed(2)} H̃=${row.entropy.toFixed(2)} -> ${row.survived ? 'survived' : 'FLIPPED (wrong)'}`
    );
  }
}

function reportAucs(label: string, rows: readonly CorruptionRow[]): Record<string, number> {
  const ok = rows.filter((r) => r.survived);
  const flipped = rows.filter((r) => !r.survived);
  const result = {
    mass: auc(ok.map((r) => r.mass), flipped.map((r) => r.mass)),
    single: auc(ok.map((r) => r.single), flipped.map((r) => r.single)),
    count: auc(ok.map((r) => r.count), flipped.map((r) => r.count)),
    entropy: auc(ok.map((r) => 1 - r.entropy), flipped.map((r) => 1 - r.entropy))
  };
  // eslint-disable-next-line no-console
  console.log(
    `  [${label}] AUC(path mass)=${result.mass.toFixed(3)} AUC(single-path strength)=${result.single.toFixed(3)} ` +
      `AUC(path count)=${result.count.toFixed(3)} AUC(1−H̃)=${result.entropy.toFixed(3)}`
  );
  return result;
}

describe('pathEvidence (§4.3): the path distribution and the hedged-by-paths verdict', () => {
  it('reads mass, count, singlePath, and the weakest edge of the strongest path', () => {
    const robin = pathEvidence([...GRAPH], 'robin', 'animal');
    expect(robin.count).toBe(2);
    expect(robin.singlePath).toBe(false);
    expect(robin.mass).toBeCloseTo(1.5, 10);
    expect(robin.paths.map((p) => p.strength)).toEqual([0.5, 1]);

    const horse = pathEvidence([...GRAPH], 'horse', 'animal');
    expect(horse.count).toBe(1);
    expect(horse.singlePath).toBe(true);
    expect(horse.mass).toBeCloseTo(0.9, 10);
    expect(horse.weakestEdge).toBeCloseTo(0.9, 10);

    const penguin = pathEvidence([...GRAPH], 'penguin', 'animal');
    expect(penguin.count).toBe(1);
    expect(penguin.mass).toBeCloseTo(1.0, 10);
    expect(penguin.weakestEdge).toBeCloseTo(1, 10);

    const goat = pathEvidence([...GRAPH], 'goat', 'animal');
    expect(goat.mass).toBeCloseTo(0.3, 10);
    expect(goat.weakestEdge).toBeCloseTo(0.3, 10);

    // No route at all: no mass, never single-path.
    const none = pathEvidence([...GRAPH], 'robin', 'quargle');
    expect(none.count).toBe(0);
    expect(none.singlePath).toBe(false);
    expect(none.mass).toBe(0);
  });

  it('honors the denied veto: a negated is-a edge is never walked', () => {
    const notABird = deniedFromNegations([{ subject: 'penguin', predicate: 'is-a', object: 'bird' }]);
    const evidence = pathEvidence([...GRAPH], 'penguin', 'animal', notABird);
    expect(evidence.count).toBe(0);
    expect(evidence.mass).toBe(0);
  });

  it('hedgedByPaths: one weak path hedges; multi-path and full-strength single paths do not', () => {
    expect(hedgedByPaths(pathEvidence([...GRAPH], 'horse', 'animal'))).toBe(true);
    expect(hedgedByPaths(pathEvidence([...GRAPH], 'goat', 'animal'))).toBe(true);
    // A single FULL-strength path asserts under the default thresholds…
    expect(hedgedByPaths(pathEvidence([...GRAPH], 'penguin', 'animal'))).toBe(false);
    // …and the product threshold is its own knob: below 1.1 it hedges "I think".
    const strict = { pathProductMin: 1.1, edgeStrengthMin: 1 };
    expect(hedgedByPaths(pathEvidence([...GRAPH], 'penguin', 'animal'), strict)).toBe(true);
    expect(pathHedgeWord(pathEvidence([...GRAPH], 'penguin', 'animal'), strict)).toBe('I think');
    // Multi-path claims stay asserted — no single edge can flip them.
    expect(hedgedByPaths(pathEvidence([...GRAPH], 'robin', 'animal'))).toBe(false);
    // Weakened single edge hedges "Probably" (the P8 contract).
    expect(pathHedgeWord(pathEvidence([...GRAPH], 'horse', 'animal'))).toBe('Probably');
    // No path = no claim to hedge.
    expect(pathHedgeWord(pathEvidence([...GRAPH], 'robin', 'quargle'))).toBe('');
  });
});

describe('path-entropy-bench §4.3: corrupt one edge — what predicts surviving it?', () => {
  it('path mass predicts post-corruption correctness better than the single-path strength (REMOVE + WEAKEN)', () => {
    const removal = measureCorruption(corruptByRemoval, removalCorrect);
    const weaken = measureCorruption(corruptByWeakening, weakenCorrect);

    // eslint-disable-next-line no-console
    console.log('\n[pathEntropyBench] ── REMOVE the strongest edge on the strongest path ──');
    reportRows(removal);
    const removalAucs = reportAucs('REMOVE', removal);
    // eslint-disable-next-line no-console
    console.log('\n[pathEntropyBench] ── WEAKEN the strongest edge on the strongest path ──');
    reportRows(weaken);
    const weakenAucs = reportAucs('WEAKEN', weaken);

    // ── Structural invariants (asserted) ────────────────────────────────
    // The canonical single-route leaves flip under removal: their one edge
    // IS the corrupted one, whatever its strength.
    expect(removal.filter((r) => !r.survived).map((r) => r.probe).sort()).toEqual([
      'goat->animal',
      'horse->animal',
      'penguin->animal'
    ]);
    // The multi-route leaves survive: an independent route backs them.
    expect(removal.filter((r) => r.survived)).toHaveLength(PROBES.length - 3);

    // ── THE §4.6 PASS GATE: path mass predicts correctness better than
    //    the single surfaced path's strength, under BOTH corruptions. ────
    expect(removalAucs.mass).toBeGreaterThan(removalAucs.single);
    expect(weakenAucs.mass).toBeGreaterThan(weakenAucs.single);

    // eslint-disable-next-line no-console
    console.log(
      `\n[pathEntropyBench] VERDICT: path mass predicts post-corruption correctness better than the ` +
        `single-path strength — REMOVE ${removalAucs.mass.toFixed(3)} > ${removalAucs.single.toFixed(3)}, ` +
        `WEAKEN ${weakenAucs.mass.toFixed(3)} > ${weakenAucs.single.toFixed(3)}. PASS.`
    );
  });
});

describe('C.3 wiring: a claim on ONE weak path speaks hedged; multi-path claims stay asserted', () => {
  // 'emu' carries no authored edges in any curriculum pool — its only
  // relations come from the definitions below (emu is-a bird is the single
  // route the has-part chain rests on).
  const DECK = [
    { word: 'bird', definition: 'an animal with wings', example: 'A bird can fly.' },
    { word: 'emu', definition: 'a bird that runs', example: '' },
    { word: 'animal', definition: 'a living creature', example: '' },
    { word: 'wings', definition: 'used for flying', example: '' }
  ];
  // dog has TWO routes to animal (the direct edge and dog->mammal->animal):
  // a corrupted chain edge leaves the claim backed by the direct route.
  const MULTI_DECK = [
    { word: 'dog', definition: 'a friendly animal that barks', example: '' },
    { word: 'mammal', definition: 'an animal with hair', example: '' },
    { word: 'animal', definition: 'a living creature', example: '' }
  ];

  async function teacherOnDeck(
    deck: typeof DECK,
    pathHedging: boolean
  ): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
    const session = new ObserverSession({}, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, deck, null, 1, undefined, undefined, undefined, {}, undefined, false, false, 'fixed', pathHedging);
    for (const entry of deck) teacher.teach(entry.word);
    return { session, teacher };
  }

  it('the flag-OFF control is bit-identical: a chained claim weakened at the is-a hop still speaks flat "Yes"', async () => {
    const { session, teacher } = await teacherOnDeck(DECK, false);
    const chained = teacher.chatAnswer('does an emu have wings');
    expect(chained.mode).toBe('operator');
    if (chained.mode === 'operator') {
      expect(chained.response).toBe('Yes — emu is a bird, and bird has wings.');
    }
    // Wrong grades weaken the is-a hop: the CONTROL still asserts (the §4.3 gap).
    teacher.bumpEdge('emu', 'is-a', 'bird', -0.9);
    const weakened = teacher.chatAnswer('does an emu have wings');
    expect(weakened.mode).toBe('operator');
    if (weakened.mode === 'operator') {
      expect(weakened.response).toBe('Yes — emu is a bird, and bird has wings.');
    }
    session.dispose();
  });

  it('flag ON: the same claim on one weak path speaks hedged ("Probably, … — it rests on one source.")', async () => {
    const { session, teacher } = await teacherOnDeck(DECK, true);
    // Full-strength chain: single path, product 1.0 — asserted like the control.
    const confident = teacher.chatAnswer('does an emu have wings');
    expect(confident.mode).toBe('operator');
    if (confident.mode === 'operator') {
      expect(confident.response).toBe('Yes — emu is a bird, and bird has wings.');
    }
    // One weak is-a hop: the claim now rests on one weak path — hedged.
    teacher.bumpEdge('emu', 'is-a', 'bird', -0.9);
    const hedged = teacher.chatAnswer('does an emu have wings');
    expect(hedged.mode).toBe('operator');
    if (hedged.mode === 'operator') {
      expect(hedged.response).toBe('Probably, emu is a bird, and bird has wings — it rests on one source.');
    }
    // The direct single-edge claim gets the same caveat on top of its P8 hedge.
    const direct = teacher.chatAnswer('is an emu a bird');
    expect(direct.mode).toBe('operator');
    if (direct.mode === 'operator') {
      expect(direct.response).toBe('Probably, emu is a bird — it rests on one source.');
    }
    session.dispose();
  });

  it('flag ON: a multi-path claim SURVIVES the same corrupted edge and stays asserted', async () => {
    const { session, teacher } = await teacherOnDeck(MULTI_DECK, true);
    const asserted = teacher.chatAnswer('is a dog an animal');
    expect(asserted.mode).toBe('operator');
    if (asserted.mode === 'operator') {
      expect(asserted.response).toBe('Yes, dog is an animal.');
    }
    // Corrupt the chain hop dog->mammal: the direct dog->animal route still
    // backs the claim, so the answer stays asserted — the other path is
    // exactly the mass the hedge reads.
    teacher.bumpEdge('dog', 'is-a', 'mammal', -0.9);
    const survived = teacher.chatAnswer('is a dog an animal');
    expect(survived.mode).toBe('operator');
    if (survived.mode === 'operator') {
      expect(survived.response).toBe('Yes, dog is an animal.');
    }
    session.dispose();
  });
});
