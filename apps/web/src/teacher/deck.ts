/**
 * The curriculum deck: what the teacher teaches the observer.
 *
 * All content is hand-curated starter material (no licensing constraints):
 * simple, concrete words with a plain definition and an example sentence.
 */

export interface DeckWord {
  /** The word the observer is learning. */
  word: string;
  /** Plain-English definition, phrased as a noun phrase the observer can associate. */
  definition: string;
  /** Short example sentence using the word. */
  example: string;
}

/** The lesson content the teacher presents for a word. */
export function lessonText(entry: DeckWord): string {
  if (entry.definition.trim().length === 0) {
    // Word-only learning: the trace content is the word itself until the
    // Chaperone provides a definition. Never fabricated content.
    return entry.word;
  }
  return `${entry.word}: ${entry.definition}. ${entry.example}`;
}

/** Whether the word has chaperoned (or authored) meaning content. */
export function hasDefinition(entry: DeckWord): boolean {
  return entry.definition.trim().length > 0;
}

/** The recall cue asking the observer to produce the word from its meaning. */
export function productionCue(entry: DeckWord): string {
  return entry.definition;
}

/** The recall cue asking the observer to recognize the word. */
export function recognitionCue(entry: DeckWord): string {
  return entry.word;
}
