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
 */

const MAX_DEPTH = 4;

/** The is-a ancestry map shared by every walk (built once per call). */
function isAAncestors(relations: readonly Relation[]): Map<string, string[]> {
  const bySubject = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.predicate !== 'is-a') continue;
    const list = bySubject.get(relation.subject) ?? [];
    list.push(relation.object);
    bySubject.set(relation.subject, list);
  }
  return bySubject;
}

/** All is-a ancestors of `subject` (up to MAX_DEPTH), including itself. */
function ancestors(relations: readonly Relation[], subject: string): string[] {
  const bySubject = isAAncestors(relations);
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
export function isATypeOf(relations: readonly Relation[], subject: string, target: string): boolean {
  if (subject === target) return true;
  const bySubject = isAAncestors(relations);
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

/**
 * Does `subject` have `part` — directly or inherited through its is-a
 * ancestors? Returns the chain via which the part was inherited, or null.
 */
export function inheritsPart(relations: readonly Relation[], subject: string, part: string): { via: string } | null {
  if (relations.some((r) => r.subject === subject && r.predicate === 'has-part' && r.object === part)) {
    return null; // direct — no chain needed
  }
  const bySubject = isAAncestors(relations);
  const frontier = [subject];
  const seen = new Set<string>([subject]);
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const word of frontier) {
      for (const parent of bySubject.get(word) ?? []) {
        if (relations.some((r) => r.subject === parent && r.predicate === 'has-part' && r.object === part)) {
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
  object: string
): { via: string } | null {
  if (relations.some((r) => r.subject === subject && r.predicate === predicate && r.object === object)) {
    return null; // direct — no chain needed
  }
  for (const ancestor of ancestors(relations, subject)) {
    if (ancestor === subject) continue;
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
export function edgeObjects(relations: readonly Relation[], subject: string, predicate: string): string[] {
  const seen = new Set<string>();
  const objects: string[] = [];
  for (const ancestor of ancestors(relations, subject)) {
    for (const relation of relations) {
      if (relation.subject === ancestor && relation.predicate === predicate && !seen.has(relation.object)) {
        seen.add(relation.object);
        objects.push(relation.object);
      }
    }
  }
  return objects;
}