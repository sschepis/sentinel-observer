#!/usr/bin/env node
/**
 * PATH-ENTROPY-BENCH (improvements.md §4.3 / improvements-tasks.md C.3) —
 * the CLI companion to teacher/pathEntropyBenchmark.test.ts.
 *
 * Deliberately corrupts ONE edge — the strongest edge on the strongest is-a
 * path — for each probe, under two corruptions:
 *   · REMOVE the edge — correctness = the is-a walk still reaches the
 *     target (a single-path claim flips, a multi-path claim survives);
 *   · WEAKEN the edge to 0.05 — correctness = the best surviving route's
 *     product clears the confident-answer floor (0.5, the holographic
 *     fallback's HOLO_YES_STRONG boundary).
 *
 * Then measures which PRE-corruption reading predicts post-corruption
 * correctness: the single surfaced path's strength, the path MASS (Σ edge-
 * strength products), the path count, or 1 − H̃ (the §4.3 branching
 * entropy). PASS: path mass predicts correctness better than the
 * single-path strength. Prints the probe table, the AUCs, the hedge
 * verdicts per probe, and the pass line.
 *
 * Usage:
 *   npx tsx src/cli/path-entropy-bench.ts
 */
import { isAPaths, isATypeOf } from '../teacher/chain';
import type { IsAPath } from '../teacher/chain';
import { normalizedEntropy } from '../teacher/cde';
import { pathEvidence, hedgedByPaths } from '../teacher/pathEvidence';
import type { Relation } from '../teacher/relations';

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

function corruptByRemoval(relations: readonly Relation[], paths: readonly IsAPath[]): Relation[] {
  const target = strongestEdgeOnStrongestPath(relations, paths);
  if (target === null) return [...relations];
  return relations.filter(
    (relation) =>
      !(relation.predicate === 'is-a' && relation.subject === target.subject && relation.object === target.object)
  );
}

function corruptByWeakening(relations: readonly Relation[], paths: readonly IsAPath[]): Relation[] {
  const target = strongestEdgeOnStrongestPath(relations, paths);
  if (target === null) return [...relations];
  return relations.map((relation) =>
    relation.predicate === 'is-a' && relation.subject === target.subject && relation.object === target.object
      ? { ...relation, strength: 0.05 }
      : relation
  );
}

const CONFIDENT_PRODUCT = 0.5;

interface Row {
  probe: string;
  count: number;
  single: number;
  mass: number;
  entropy: number;
  survived: boolean;
  hedged: boolean;
}

function measure(
  corrupt: (relations: readonly Relation[], paths: readonly IsAPath[]) => Relation[],
  stillCorrect: (corrupted: readonly Relation[], subject: string, object: string) => boolean
): Row[] {
  const rows: Row[] = [];
  for (const probe of PROBES) {
    const relations: Relation[] = [...GRAPH];
    const evidence = pathEvidence(relations, probe.subject, probe.object);
    const strengths = evidence.paths.map((p) => p.strength);
    const corrupted = corrupt(relations, evidence.paths);
    rows.push({
      probe: `${probe.subject}->${probe.object}`,
      count: evidence.count,
      single: strengths.length > 0 ? Math.max(...strengths) : 0,
      mass: evidence.mass,
      entropy: normalizedEntropy(strengths),
      survived: stillCorrect(corrupted, probe.subject, probe.object),
      hedged: hedgedByPaths(evidence)
    });
  }
  return rows;
}

function main(): void {
  // eslint-disable-next-line no-console
  console.log(`[path-entropy-bench] ${PROBES.length} probes, two corruptions of the strongest edge\n`);
  const removal = measure(corruptByRemoval, (corrupted, subject, object) => isATypeOf(corrupted, subject, object));
  const weaken = measure(corruptByWeakening, (corrupted, subject, object) => {
    const strengths = isAPaths(corrupted, subject, object).map((p) => p.strength);
    return strengths.length > 0 && Math.max(...strengths) >= CONFIDENT_PRODUCT;
  });

  for (const [label, rows] of [['REMOVE', removal], ['WEAKEN', weaken]] as const) {
    // eslint-disable-next-line no-console
    console.log(`── ${label} the strongest edge on the strongest path ──`);
    for (const row of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${row.probe.padEnd(20)} paths=${String(row.count).padStart(2)} single=${row.single.toFixed(2)} ` +
          `mass=${row.mass.toFixed(2)} H̃=${row.entropy.toFixed(2)} hedge=${row.hedged ? 'yes' : 'no'} -> ` +
          `${row.survived ? 'survived' : 'FLIPPED (wrong)'}`
      );
    }
    const ok = rows.filter((r) => r.survived);
    const flipped = rows.filter((r) => !r.survived);
    const mass = auc(ok.map((r) => r.mass), flipped.map((r) => r.mass));
    const single = auc(ok.map((r) => r.single), flipped.map((r) => r.single));
    const count = auc(ok.map((r) => r.count), flipped.map((r) => r.count));
    const entropy = auc(ok.map((r) => 1 - r.entropy), flipped.map((r) => 1 - r.entropy));
    // eslint-disable-next-line no-console
    console.log(
      `  AUC(path mass)=${mass.toFixed(3)} AUC(single-path strength)=${single.toFixed(3)} ` +
        `AUC(path count)=${count.toFixed(3)} AUC(1−H̃)=${entropy.toFixed(3)} ` +
        `-> mass beats single: ${mass > single ? 'YES' : 'no'}\n`
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    'PASS CRITERION (§4.6): path mass predicts post-corruption correctness better than the single\n' +
      'surfaced path\u2019s strength under BOTH corruptions — see teacher/pathEntropyBenchmark.test.ts\n' +
      'for the asserted gate and the TeacherAgent wiring.'
  );
}

main();
