import type { DeckWord } from '../deck';
import type { Relation } from '../relations';
import { ARITHMETIC_CONCEPTS } from './arithmetic';
import { MEASUREMENT_CONCEPTS } from './measurement';
import { SCIENCE_CONCEPTS } from './science';
import { GEOMETRY_CONCEPTS } from './geometry';
import { LOGIC_CONCEPTS } from './logic';
import { GRAMMAR_CONCEPTS } from './grammar';
import { prerequisiteOrder, auditCurriculum } from './curriculum';
import { conceptToDeckWord, conceptRelations, type TechnicalConcept } from './types';

export * from './types';
export * from './curriculum';
export * from './verify';
export { ARITHMETIC_CONCEPTS } from './arithmetic';
export { MEASUREMENT_CONCEPTS } from './measurement';
export { SCIENCE_CONCEPTS } from './science';
export { GEOMETRY_CONCEPTS } from './geometry';
export { LOGIC_CONCEPTS } from './logic';
export { GRAMMAR_CONCEPTS } from './grammar';

/**
 * Every authored concept, exactly as written and BEFORE ordering.
 *
 * The audit runs against this, not against the ordered deck: the topological
 * sort collapses a word declared in two strands, so auditing its output
 * would hide the very collision the audit exists to catch. ("power" as
 * base^exponent and "power" as energy/time is a real one.)
 */
export const AUTHORED_CONCEPTS: readonly TechnicalConcept[] = [
  ...ARITHMETIC_CONCEPTS,
  ...MEASUREMENT_CONCEPTS,
  ...SCIENCE_CONCEPTS,
  ...GEOMETRY_CONCEPTS,
  ...LOGIC_CONCEPTS,
  ...GRAMMAR_CONCEPTS
];

/**
 * The technical curriculum, in prerequisite order.
 *
 * Ordering here rather than at teach time is what makes the layering work
 * for free: the deck is walked in order, so presenting the deck in
 * topological order already guarantees no concept is introduced before its
 * prerequisites.
 */
export const TECHNICAL_CONCEPTS: readonly TechnicalConcept[] = prerequisiteOrder(AUTHORED_CONCEPTS);

/** Concepts whose answers can be checked exactly, with no model involved. */
export const CHECKABLE_CONCEPTS: readonly TechnicalConcept[] = TECHNICAL_CONCEPTS.filter(
  (concept) => concept.drill !== undefined
);

/**
 * Layer the technical curriculum onto an existing deck.
 *
 * Words already in the base deck are REPLACED IN PLACE — "number" and
 * "second" exist in the English deck with everyday WordNet senses, and the
 * technical definition should win. Replacing in place (rather than
 * appending a duplicate) matters for a specific reason: `deckVocabulary`
 * assigns prime signatures by iterating the deck and salting on collision,
 * so a duplicated word would be re-salted and overwrite its own signature.
 * Keeping the word set and its order identical leaves every existing
 * signature — and therefore every trained bootstrap record — untouched.
 *
 * Genuinely new technical vocabulary is appended, which is what puts it
 * after the English curriculum in teaching order.
 */
export function layerTechnicalDeck(
  base: readonly DeckWord[],
  concepts: readonly TechnicalConcept[] = TECHNICAL_CONCEPTS
): DeckWord[] {
  const byWord = new Map(concepts.map((concept) => [concept.word, concept]));
  const inBase = new Set(base.map((entry) => entry.word));

  const layered = base.map((entry) => {
    const concept = byWord.get(entry.word);
    return concept === undefined ? entry : conceptToDeckWord(concept);
  });

  for (const concept of concepts) {
    if (!inBase.has(concept.word)) layered.push(conceptToDeckWord(concept));
  }
  return layered;
}

/**
 * The authored relation graph, in the shape `relations.ts` and `chain.ts`
 * already consume — so inference walks technical edges and prose-extracted
 * edges through the same code path.
 */
export function technicalRelations(
  concepts: readonly TechnicalConcept[] = TECHNICAL_CONCEPTS
): Relation[] {
  const relations: Relation[] = [];
  for (const concept of concepts) {
    for (const edge of conceptRelations(concept)) {
      relations.push({
        subject: concept.word,
        predicate: edge.predicate,
        object: edge.object,
        source: concept.definition,
        origin: 'authored'
      });
    }
  }
  return relations;
}

/** Concepts keyed by name, for prerequisite lookups at teach time. */
export const TECHNICAL_BY_WORD: ReadonlyMap<string, TechnicalConcept> = new Map(
  TECHNICAL_CONCEPTS.map((concept) => [concept.word, concept])
);

/** The curriculum's own integrity check (run by the test suite). */
export function auditTechnicalCurriculum() {
  return auditCurriculum(AUTHORED_CONCEPTS);
}
