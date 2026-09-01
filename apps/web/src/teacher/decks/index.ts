import type { DeckWord } from '../deck';
import { DECK_100 } from './en-100';
import { DECK_1000 } from './en-1000';
import { DECK_20000 } from './en-20000';
import { layerTechnicalDeck } from '../technical';
import { applyDefinitionOverrides } from '../definitionOverrides';
import { layerGroundedFacts } from './groundedFacts';

/**
 * The deck the school teaches: the 20,000-word frequency deck with the
 * technical curriculum layered on top. Layering replaces the everyday sense
 * of a word the technical strand claims ("number", "second") in place and
 * appends the genuinely new vocabulary at the end — so the observer meets
 * arithmetic and measurement AFTER English, in prerequisite order, sharing
 * one memory.
 *
 * Grounded facts are layered LAST so their curated day/month/season and
 * astronomy senses win over WordNet's wrong-domain first synsets ("may" the
 * modal, "march" the walk).
 *
 * DECK_1000 and DECK_100 remain for tests and small demos.
 */
export const ACTIVE_DECK: readonly DeckWord[] = layerGroundedFacts(
  layerTechnicalDeck(applyDefinitionOverrides(DECK_20000 as readonly DeckWord[]))
);

/** The English deck alone, without the technical layer. */
export const ENGLISH_DECK: readonly DeckWord[] = DECK_20000 as readonly DeckWord[];

export { DECK_100, DECK_1000, DECK_20000 };