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

export const STARTER_DECK: readonly DeckWord[] = [
  { word: 'apple', definition: 'a round red or green fruit', example: 'I eat an apple every morning.' },
  { word: 'water', definition: 'the clear liquid we drink', example: 'Please give me a glass of water.' },
  { word: 'friend', definition: 'a person you like and trust', example: 'My friend and I play together.' },
  { word: 'house', definition: 'a building where people live', example: 'They live in a small house.' },
  { word: 'morning', definition: 'the early part of the day', example: 'I wake up early in the morning.' },
  { word: 'book', definition: 'pages with words that you read', example: 'She is reading an interesting book.' },
  { word: 'travel', definition: 'to go from one place to another', example: 'We travel by train in summer.' },
  { word: 'music', definition: 'sounds arranged to be pleasant', example: 'He listens to music at night.' },
  { word: 'learn', definition: 'to get new knowledge or skill', example: 'I want to learn to speak English.' },
  { word: 'speak', definition: 'to say words out loud', example: 'Can you speak more slowly, please?' },
  { word: 'work', definition: 'an activity done as a job', example: 'She goes to work by bus.' },
  { word: 'sleep', definition: 'to rest with your eyes closed', example: 'I sleep eight hours every night.' }
];

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
