import type { Relation } from './relations';

/**
 * CHAINING — reasoning as a short walk over relational traces.
 *
 * A single operator maps question → answer from one edge; two composable
 * edges give INFERENCE: "does a robin have wings?" is answered by following
 * robin is-a bird, then bird has-part wings. Each step is grounded in a
 * stored relation — no ungrounded intermediate is ever assumed, and when no
 * path exists the observer honestly declines (absence of evidence is never
 * answered as evidence of absence).
 *
 * EXCEPTIONS (P8 propagation): every walk takes an optional `denied` veto —
 * the confirmed-false store as a predicate. A negation on the subject's own
 * claim overrides any inherited positive (penguin is-a bird, bird capable-of
 * fly, but "a penguin cannot fly" wins), and a negated is-a edge is never
 * walked. Taught falsehoods outrank extraction at every hop, not just on
 * the exact question form.
 */

const MAX_DEPTH = 4;

/** A claim veto: true when (subject, predicate, object) is confirmed false. */
export type DeniedClaim = (subject: string, predicate: string, object: string) => boolean;

const NEVER_DENIED: DeniedClaim = () => false;

/** Build a `DeniedClaim` veto from the confirmed-false store. */
export function deniedFromNegations(
  negations: readonly { subject: string; predicate: string; object: string }[]
): DeniedClaim {
  if (negations.length === 0) return NEVER_DENIED;
  const keys = new Set(negations.map((n) => `${n.subject}\u0000${n.predicate}\u0000${n.object}`));
  return (subject, predicate, object) => keys.has(`${subject}\u0000${predicate}\u0000${object}`);
}

/** The is-a ancestry map shared by every walk (built once per call). */
function isAAncestors(relations: readonly Relation[], denied: DeniedClaim): Map<string, string[]> {
  const bySubject = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.predicate !== 'is-a') continue;
    if (denied(relation.subject, 'is-a', relation.object)) continue;
    const list = bySubject.get(relation.subject) ?? [];
    list.push(relation.object);
    bySubject.set(relation.subject, list);
  }
  return bySubject;
}

/** All is-a ancestors of `subject` (up to MAX_DEPTH), including itself. */
export function ancestors(relations: readonly Relation[], subject: string, denied: DeniedClaim): string[] {
  const bySubject = isAAncestors(relations, denied);
  const reached = [subject];
  const seen = new Set<string>([subject]);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const frontier = reached.slice();
    for (const word of frontier) {
      for (const parent of bySubject.get(word) ?? []) {
        if (!seen.has(parent)) {
          seen.add(parent);
          reached.push(parent);
        }
      }
    }
  }
  return reached;
}

/** Is `subject` (transitively, up to MAX_DEPTH is-a edges) a `target`? */
export function isATypeOf(
  relations: readonly Relation[],
  subject: string,
  target: string,
  denied: DeniedClaim = NEVER_DENIED
): boolean {
  if (denied(subject, 'is-a', target)) return false;
  if (subject === target) return true;
  const bySubject = isAAncestors(relations, denied);
  const frontier = [subject];
  const seen = new Set<string>([subject]);
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const word of frontier) {
      for (const parent of bySubject.get(word) ?? []) {
        if (parent === target) return true;
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier.length = 0;
    frontier.push(...next);
  }
  return false;
}

/** One is-a path from a subject to a target: the nodes walked plus the
 *  product of the edges' strength weights along it (§4.3 path evidence). */
export interface IsAPath {
  /** The nodes along the path, subject first and target last. */
  nodes: string[];
  /** Product of edge strengths along the path (absent strength = 1). */
  strength: number;
}

/** The strongest is-a edge strength for `subject -> object` (absent = 1).
 *  Exported for the §4.3 path-evidence reading (pathEvidence.ts). */
export function isAEdgeStrength(relations: readonly Relation[], subject: string, object: string): number {
  let best = -Infinity;
  for (const relation of relations) {
    if (relation.subject === subject && relation.predicate === 'is-a' && relation.object === object) {
      best = Math.max(best, relation.strength ?? 1);
    }
  }
  return Number.isFinite(best) ? best : 1;
}

/**
 * ALL is-a paths from `subject` to `target` (up to MAX_DEPTH edges), each
 * with its product of edge strengths — the candidate distribution §4.3's
 * branching entropy reads (a claim reached by one path vs. many independent
 * routes). `isATypeOf` is the single-path decision; this retains every path
 * the walk visits so a claim's robustness can be measured. Subject ===
 * target (the identity case) yields no edge path; simple paths only (no
 * node revisited) and a denied is-a edge is never walked.
 */
export function isAPaths(
  relations: readonly Relation[],
  subject: string,
  target: string,
  denied: DeniedClaim = NEVER_DENIED
): IsAPath[] {
  if (subject === target) return [];
  const bySubject = isAAncestors(relations, denied);
  const paths: IsAPath[] = [];
  const stack: Array<{ node: string; nodes: string[]; product: number }> = [
    { node: subject, nodes: [subject], product: 1 }
  ];
  while (stack.length > 0) {
    const { node, nodes, product } = stack.pop()!;
    for (const parent of bySubject.get(node) ?? []) {
      if (nodes.includes(parent)) continue;
      const nextNodes = [...nodes, parent];
      const nextProduct = product * isAEdgeStrength(relations, node, parent);
      if (parent === target) {
        paths.push({ nodes: nextNodes, strength: nextProduct });
      } else if (nextNodes.length - 1 < MAX_DEPTH) {
        stack.push({ node: parent, nodes: nextNodes, product: nextProduct });
      }
    }
  }
  paths.sort(
    (a, b) =>
      a.nodes.length - b.nodes.length ||
      a.nodes.join('\u0000').localeCompare(b.nodes.join('\u0000'))
  );
  return paths;
}

/**
 * Does `subject` have `part` — directly or inherited through its is-a
 * ancestors? Returns the chain via which the part was inherited, or null.
 */
export function inheritsPart(
  relations: readonly Relation[],
  subject: string,
  part: string,
  denied: DeniedClaim = NEVER_DENIED
): { via: string } | null {
  // A subject-level exception overrides any inherited positive.
  if (denied(subject, 'has-part', part)) return null;
  if (relations.some((r) => r.subject === subject && r.predicate === 'has-part' && r.object === part)) {
    return null; // direct — no chain needed
  }
  const bySubject = isAAncestors(relations, denied);
  const frontier = [subject];
  const seen = new Set<string>([subject]);
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const word of frontier) {
      for (const parent of bySubject.get(word) ?? []) {
        if (
          !denied(parent, 'has-part', part) &&
          relations.some((r) => r.subject === parent && r.predicate === 'has-part' && r.object === part)
        ) {
          return { via: parent };
        }
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier.length = 0;
    frontier.push(...next);
  }
  return null;
}

/**
 * Does `subject` hold `object` under `predicate` — directly or inherited
 * through its is-a ancestors? Returns the ancestor the edge was found on
 * (null = direct). The generic sibling of `inheritsPart`.
 */
export function inheritsEdge(
  relations: readonly Relation[],
  subject: string,
  predicate: string,
  object: string,
  denied: DeniedClaim = NEVER_DENIED
): { via: string } | null {
  // A subject-level exception overrides any inherited positive.
  if (denied(subject, predicate, object)) return null;
  if (relations.some((r) => r.subject === subject && r.predicate === predicate && r.object === object)) {
    return null; // direct — no chain needed
  }
  for (const ancestor of ancestors(relations, subject, denied)) {
    if (ancestor === subject) continue;
    if (denied(ancestor, predicate, object)) continue;
    if (relations.some((r) => r.subject === ancestor && r.predicate === predicate && r.object === object)) {
      return { via: ancestor };
    }
  }
  return null;
}

/**
 * All objects `subject` holds under `predicate`, direct and inherited
 * (deduplicated). Used by open questions ("what does a bird do?").
 */
export function edgeObjects(
  relations: readonly Relation[],
  subject: string,
  predicate: string,
  denied: DeniedClaim = NEVER_DENIED
): string[] {
  const seen = new Set<string>();
  const objects: string[] = [];
  for (const ancestor of ancestors(relations, subject, denied)) {
    for (const relation of relations) {
      if (relation.subject !== ancestor || relation.predicate !== predicate || seen.has(relation.object)) continue;
      // Vetoed at the subject (the exception) or at the ancestor holding the edge.
      if (denied(subject, predicate, relation.object)) continue;
      if (denied(ancestor, predicate, relation.object)) continue;
      seen.add(relation.object);
      objects.push(relation.object);
    }
  }
  return objects;
}