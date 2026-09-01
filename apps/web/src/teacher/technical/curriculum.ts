import type { TechnicalConcept } from './types';

/**
 * PREREQUISITE ORDERING — the replacement for frequency order.
 *
 * The English deck is ordered by corpus frequency, and `nextNewWord()` walks
 * it in that order. That is meaningless for technical material: "integral"
 * is a common word and a late concept. Here the order is a topological sort
 * of the `depends-on` DAG, so a concept is never introduced before the
 * concepts it is defined in terms of.
 */

export interface CurriculumAudit {
  /** Prerequisites naming a concept that does not exist. */
  missing: Array<{ concept: string; dependsOn: string }>;
  /** Concepts declared more than once. */
  duplicates: string[];
  /** A dependency cycle, if one exists (concepts that never become ready). */
  cycle: string[];
  valid: boolean;
}

/**
 * Check the curriculum before anyone tries to teach it: every prerequisite
 * must name a real concept, no concept may be declared twice, and the graph
 * must be acyclic. A typo here would otherwise produce a concept that is
 * silently never teachable.
 */
export function auditCurriculum(concepts: readonly TechnicalConcept[]): CurriculumAudit {
  const byWord = new Map<string, TechnicalConcept>();
  const duplicates: string[] = [];
  for (const concept of concepts) {
    if (byWord.has(concept.word)) duplicates.push(concept.word);
    byWord.set(concept.word, concept);
  }

  const missing: Array<{ concept: string; dependsOn: string }> = [];
  for (const concept of concepts) {
    for (const prerequisite of concept.dependsOn) {
      if (!byWord.has(prerequisite)) missing.push({ concept: concept.word, dependsOn: prerequisite });
    }
  }

  // Kahn's algorithm: whatever never reaches in-degree zero sits on a cycle.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const concept of concepts) indegree.set(concept.word, 0);
  for (const concept of concepts) {
    for (const prerequisite of concept.dependsOn) {
      if (!byWord.has(prerequisite)) continue;
      indegree.set(concept.word, (indegree.get(concept.word) ?? 0) + 1);
      const list = dependents.get(prerequisite) ?? [];
      list.push(concept.word);
      dependents.set(prerequisite, list);
    }
  }
  const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([word]) => word);
  let settled = 0;
  while (queue.length > 0) {
    const word = queue.shift() as string;
    settled += 1;
    for (const dependent of dependents.get(word) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  const cycle = settled === concepts.length ? [] : [...indegree.entries()].filter(([, n]) => n > 0).map(([w]) => w);

  return { missing, duplicates, cycle, valid: missing.length === 0 && duplicates.length === 0 && cycle.length === 0 };
}

/**
 * Order the concepts so every prerequisite precedes its dependents.
 *
 * Ties are broken by the authored order, which keeps the sequence stable
 * across runs — a curriculum that reshuffles itself would make training
 * runs incomparable.
 */
export function prerequisiteOrder(concepts: readonly TechnicalConcept[]): TechnicalConcept[] {
  const byWord = new Map(concepts.map((concept) => [concept.word, concept]));
  const ordered: TechnicalConcept[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();

  const visit = (concept: TechnicalConcept): void => {
    if (placed.has(concept.word) || visiting.has(concept.word)) return;
    visiting.add(concept.word);
    for (const prerequisite of concept.dependsOn) {
      const parent = byWord.get(prerequisite);
      if (parent !== undefined) visit(parent);
    }
    visiting.delete(concept.word);
    placed.add(concept.word);
    ordered.push(concept);
  };

  for (const concept of concepts) visit(concept);
  return ordered;
}

/**
 * The next concept whose prerequisites are ALL already learned, or null when
 * the curriculum is exhausted or blocked. This is the stricter gate: deck
 * order alone guarantees prerequisites were *presented* first, this
 * guarantees they were *learned* first.
 */
export function nextTeachableConcept(
  concepts: readonly TechnicalConcept[],
  isLearned: (word: string) => boolean
): TechnicalConcept | null {
  for (const concept of prerequisiteOrder(concepts)) {
    if (isLearned(concept.word)) continue;
    if (concept.dependsOn.every(isLearned)) return concept;
  }
  return null;
}

/** How far through the curriculum the observer is, per strand. */
export function curriculumProgress(
  concepts: readonly TechnicalConcept[],
  isLearned: (word: string) => boolean
): Record<string, { learned: number; total: number }> {
  const progress: Record<string, { learned: number; total: number }> = {};
  for (const concept of concepts) {
    const strand = (progress[concept.strand] ??= { learned: 0, total: 0 });
    strand.total += 1;
    if (isLearned(concept.word)) strand.learned += 1;
  }
  return progress;
}
