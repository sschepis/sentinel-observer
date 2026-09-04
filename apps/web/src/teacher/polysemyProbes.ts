/**
 * POLYSEMY PROBES (§7.1 / §7.5) — the cross-sense fabrication probe set.
 *
 * §7.1 flags a latent fabrication path: the observer assigns one four-prime
 * signature and one trace per surface word, and merges senses. A word whose
 * relation graph carries is-a parents from UNRELATED closures (two is-a
 * parents that are not themselves related by is-a — e.g. 'bank' is-a
 * institution AND is-a slope) can answer cross-sense probes "Yes" with
 * provenance: a confident, wrong answer for the reading the user intended.
 * The adversarial bench cannot see it because its negative-target selector
 * (`negativeTargetsFor`) computes the MERGED closure, so it excludes the
 * cross-sense parent from the negative pool and never probes the claim.
 *
 * This module is PURE and shared by the unit test
 * (`polysemyProbeSet.test.ts`) and the population CLI
 * (`cli/polysemy-bench.ts`) — the same discipline as `adversarial.ts`. The
 * probe set is DERIVED from the relation graph, never hand-written, exactly
 * like `p1-relations-bench` derives its probes from the loose extraction.
 */
import type { Relation } from './relations';

/** The chain walk's is-a depth bound (chain.ts MAX_DEPTH). */
const IS_A_MAX_DEPTH = 4;

/** Direct is-a parents of `subject` (deduplicated, in graph order). */
export function isAParentsOf(relations: readonly Relation[], subject: string): string[] {
  const parents: string[] = [];
  for (const relation of relations) {
    if (relation.predicate === 'is-a' && relation.subject === subject && !parents.includes(relation.object)) {
      parents.push(relation.object);
    }
  }
  return parents;
}

/**
 * The is-a closure of `subject`: the subject plus every ancestor reachable
 * within IS_A_MAX_DEPTH is-a hops. Mirrors `chain.ts`'s `ancestors` / the
 * walk `isATypeOf` performs, so "unrelated" below means exactly what the
 * operator layer would and would not traverse.
 */
function isAClosureOf(parentsOf: Map<string, string[]>, subject: string): Set<string> {
  const seen = new Set<string>([subject]);
  const frontier = [subject];
  for (let depth = 0; depth < IS_A_MAX_DEPTH; depth += 1) {
    const next: string[] = [];
    for (const word of frontier) {
      for (const parent of parentsOf.get(word) ?? []) {
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier.length = 0;
    frontier.push(...next);
  }
  return seen;
}

/**
 * Words whose relation graph carries is-a parents in UNRELATED closures: two
 * is-a parents that are not themselves related by is-a in either direction
 * (within the chain walk's depth bound). This is the population the cross-
 * sense probe set sizes — the adversarial bench's blind spot.
 */
export function wordsWithUnrelatedIsAParents(relations: readonly Relation[]): string[] {
  const parentsOf = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.predicate !== 'is-a') continue;
    const list = parentsOf.get(relation.subject) ?? [];
    if (!list.includes(relation.object)) list.push(relation.object);
    parentsOf.set(relation.subject, list);
  }
  const closureCache = new Map<string, Set<string>>();
  const closureOf = (subject: string): Set<string> => {
    const cached = closureCache.get(subject);
    if (cached !== undefined) return cached;
    const closure = isAClosureOf(parentsOf, subject);
    closureCache.set(subject, closure);
    return closure;
  };
  const found: string[] = [];
  for (const [subject, parents] of parentsOf) {
    if (parents.length < 2) continue;
    let unrelated = false;
    for (let i = 0; i < parents.length && !unrelated; i += 1) {
      for (let j = i + 1; j < parents.length && !unrelated; j += 1) {
        if (!closureOf(parents[i]).has(parents[j]) && !closureOf(parents[j]).has(parents[i])) {
          unrelated = true;
        }
      }
    }
    if (unrelated) found.push(subject);
  }
  return found.sort();
}

/** The article-aware is-a question the operator layer answers for one parent. */
export function isAQuestion(subject: string, parent: string): string {
  const subjectArticle = /^[aeiou]/.test(subject) ? 'an' : 'a';
  const parentArticle = /^[aeiou]/.test(parent) ? 'an' : 'a';
  return `is ${subjectArticle} ${subject} ${parentArticle} ${parent}`;
}

/**
 * The cross-sense probe set for one word: every is-a parent is probed as a
 * claim ("is a bank an institution?", "is a bank a slope?"). §7.1 phrases the
 * river sense as "does a bank have a slope?" — that is the is-a parent 'slope'
 * surfacing as a claim, and the operator layer answers it from the same is-a
 * edge. The "converse" is the other parent's probe. All probes are derived
 * from the graph; the caller classifies confident vs hedged answers.
 */
export function crossSenseProbesFor(relations: readonly Relation[], subject: string): string[] {
  return isAParentsOf(relations, subject).map((parent) => isAQuestion(subject, parent));
}
