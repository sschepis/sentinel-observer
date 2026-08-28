import type { DeckWord } from '../deck';
import { DECK_100 } from './en-100';
import { DECK_1000 } from './en-1000';

/**
 * The deck the school teaches. DECK_1000 is the frequency deck (2,437
 * unique words, word-only until the Chaperone fills definitions); DECK_100
 * remains the fully-authored starter deck used by tests and small demos.
 */
export const ACTIVE_DECK: readonly DeckWord[] = DECK_1000;

export { DECK_100, DECK_1000 };
