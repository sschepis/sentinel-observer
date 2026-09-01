#!/usr/bin/env node
/**
 * Generate the 20,000-word frequency deck (src/teacher/decks/en-20000.ts)
 * from Peter Norvig's public-domain English word-frequency list
 * (https://norvig.com/ngrams/count_1w.txt — derived from Google Books data,
 * widely redistributed; this app uses it only for education).
 *
 *   node scripts/fetch-deck.mjs [--count 20000] [--out src/teacher/decks/en-20000.ts]
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COUNT = 20000;
const OUT = resolve(process.cwd(), 'src/teacher/decks/en-20000.ts');
const SOURCE = 'https://norvig.com/ngrams/count_1w.txt';

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
const text = await response.text();

const words = [];
for (const line of text.split(/\r?\n/)) {
  const word = line.split(/\t| /)[0]?.trim().toLowerCase();
  if (!word) continue;
  // Keep only plain a-z words (drop contractions, URLs, proper nouns with
  // digits, punctuation artifacts) — a conversational learner's dictionary.
  if (!/^[a-z]+$/.test(word)) continue;
  if (word.length < 2) continue; // drop single letters except a/i — keep 'i' 'a' explicitly below
  if (word.length > 24) continue;
  words.push(word);
  if (words.length >= COUNT) break;
}
// Single-letter words that are real English: include them by hand.
for (const letter of ['i', 'a']) {
  if (!words.slice(0, COUNT).includes(letter)) {
    words.splice(Math.min(2, words.length), 0, letter);
  }
}
const deck = words.slice(0, COUNT);
if (new Set(deck).size !== deck.length) throw new Error('duplicate words in final deck');
if (deck.length !== COUNT) throw new Error(`expected ${COUNT} words, got ${deck.length}`);

const TEMPLATE = `/**
 * The 20,000-word frequency deck: the most common English words by corpus
 * frequency (Norvig's public-domain count_1w list, filtered to plain A-Z
 * words — ${COUNT} unique). Definitions and examples are intentionally
 * ABSENT: the Chaperone (LLM) generates and validates them, so the deck is
 * honest about what has been authored vs. generated.
 */

export const DECK_20000: ReadonlyArray<{ word: string; definition: string; example: string }> = [
`;
const rows = deck.map((word) => `  { word: ${JSON.stringify(word)}, definition: '', example: '' },`).join('\n');
const footer = `
].map((entry) => ({ word: entry.word, definition: '', example: '' }));
`;

writeFileSync(OUT, TEMPLATE + rows + footer, 'utf8');
console.log(`wrote ${COUNT} words to ${OUT}`);
console.log(`first 10: ${deck.slice(0, 10).join(', ')}`);
console.log(`last 10:  ${deck.slice(-10).join(', ')}`);