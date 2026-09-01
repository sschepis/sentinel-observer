import type { DeckWord } from '../deck';
import type { RelationPredicate } from '../relations';

/**
 * THE TECHNICAL CURRICULUM — a different knowledge atom.
 *
 * English words are learned one at a time: "apple" means something on its
 * own. A technical concept does not. "derivative" is only meaning-bearing
 * through its relations — to limit, to function, to rate of change — and it
 * cannot be taught before those exist. So a technical entry carries two
 * things an English deck entry never needed:
 *
 *   1. `dependsOn` — the prerequisite edges. Technical knowledge is a DAG,
 *      not a frequency list, and teaching order must respect it.
 *   2. `relations` — AUTHORED typed edges. The prose extractor in
 *      relations.ts is precision-first and only fires on "a|an ..." noun
 *      phrases, which technical definitions almost never are. Mining them
 *      would yield an empty graph, so the edges are stated as data.
 */

/** Which strand of the curriculum a concept belongs to. */
export type TechnicalStrand =
  | 'number'
  | 'operation'
  | 'measurement'
  | 'unit'
  | 'scientific-practice'
  | 'physics'
  | 'chemistry'
  | 'biology'
  | 'earth-science'
  | 'astronomy'
  | 'geometry'
  | 'logic'
  | 'grammar';

/**
 * Relation predicates the technical curriculum adds on top of the four
 * prose-extractable ones (is-a / has-part / located-in / made-of).
 */
export type TechnicalPredicate = RelationPredicate;

export interface AuthoredRelation {
  predicate: TechnicalPredicate;
  object: string;
}

export interface TechnicalConcept {
  /** Canonical name. May be multi-word ("least common multiple"). */
  word: string;
  definition: string;
  example: string;
  strand: TechnicalStrand;
  /** Concepts that must come first. Every entry must name a real concept. */
  dependsOn: readonly string[];
  /** Authored edges beyond the prerequisites. */
  relations?: readonly AuthoredRelation[];
  /**
   * Exercise generator key. Present only when the concept is CHECKABLE —
   * when correctness is a fact rather than an opinion, so grading needs no
   * LLM. See technical/verify.ts.
   */
  drill?: string;
}

/** The deck form of a concept (what the teacher actually teaches). */
export function conceptToDeckWord(concept: TechnicalConcept): DeckWord {
  return { word: concept.word, definition: concept.definition, example: concept.example };
}

/** Every edge a concept declares, prerequisites included. */
export function conceptRelations(concept: TechnicalConcept): AuthoredRelation[] {
  return [
    ...concept.dependsOn.map((object): AuthoredRelation => ({ predicate: 'depends-on', object })),
    ...(concept.relations ?? [])
  ];
}
