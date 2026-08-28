/**
 * Whole-word prime signatures for the curriculum.
 *
 * Each word gets 3 distinct primes from the observer's field basis (the
 * first `PRIME_SPACE` primes) via FNV-1a over the WHOLE word — so
 * near-identical words ('apple' vs 'apply') receive unrelated signatures,
 * unlike the backend's per-character hashing.
 *
 * Deterministic and auditable: `scripts/audit-deck.mjs` verifies uniqueness
 * over the deck and the recall-accuracy benchmark measures the result.
 */

/** First 32 primes — the field basis the app's observer uses (primeCount 32). */
export const PRIME_SPACE: readonly number[] = [
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53,
  59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131
];

/** 3 primes per word. */
export const SIGNATURE_LENGTH = 3;

/** FNV-1a 32-bit hash over the word's code points. */
export function fnv1a(word: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    hash ^= word.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic prime signature for a word: 3 distinct primes from the
 * prime space, derived from the whole-word hash.
 */
export function primeSignature(word: string, primeSpace: readonly number[] = PRIME_SPACE): number[] {
  const hash = fnv1a(word.toLowerCase());
  const space = primeSpace.length;
  const first = hash % space;
  const second = (hash >>> 5) % (space - 1);
  const third = (hash >>> 10) % (space - 2);

  const picks = [first];
  let candidate = second;
  while (picks.includes(candidate)) candidate = (candidate + 1) % space;
  picks.push(candidate);
  candidate = third;
  while (picks.includes(candidate)) candidate = (candidate + 1) % space;
  picks.push(candidate);

  return picks.map((index) => primeSpace[index]);
}

/** Vocabulary table for a deck: word -> its prime signature. */
export function deckVocabulary(deck: ReadonlyArray<{ word: string }>, primeSpace: readonly number[] = PRIME_SPACE): Record<string, number[]> {
  const vocabulary: Record<string, number[]> = {};
  for (const entry of deck) {
    vocabulary[entry.word.toLowerCase()] = primeSignature(entry.word, primeSpace);
  }
  return vocabulary;
}

/** Collision audit result: every word must have a unique, distinct signature. */
export function auditDeck(deck: ReadonlyArray<{ word: string }>, primeSpace: readonly number[] = PRIME_SPACE): {
  words: number;
  uniqueSignatures: number;
  collisions: Array<{ word: string; signature: number[] }>;
  valid: boolean;
} {
  const seen = new Map<string, string>();
  const collisions: Array<{ word: string; signature: number[] }> = [];

  for (const entry of deck) {
    const signature = primeSignature(entry.word, primeSpace);
    if (new Set(signature).size !== SIGNATURE_LENGTH) {
      throw new Error(`word "${entry.word}" produced a degenerate signature: [${signature}]`);
    }
    const key = signature.join(',');
    const existing = seen.get(key);
    if (existing !== undefined) {
      collisions.push({ word: entry.word, signature });
    }
    seen.set(key, entry.word);
  }

  return {
    words: deck.length,
    uniqueSignatures: seen.size,
    collisions,
    valid: collisions.length === 0
  };
}
