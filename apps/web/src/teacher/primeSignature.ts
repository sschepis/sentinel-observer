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

/** First N primes — the field basis the app's observer uses for N=256;
 *  the scale bench builds larger bases (512/1024) from the same sequence. */
export function firstPrimes(count: number): number[] {
  const primes: number[] = [];
  let candidate = 2;
  while (primes.length < count) {
    let isPrime = true;
    for (const p of primes) {
      if (p * p > candidate) break;
      if (candidate % p === 0) {
        isPrime = false;
        break;
      }
    }
    if (isPrime) primes.push(candidate);
    candidate += 1;
  }
  return primes;
}

export const PRIME_SPACE: readonly number[] = firstPrimes(256);

// Guards: the computed space must begin with the canonical first primes.
if (PRIME_SPACE[0] !== 2 || PRIME_SPACE[63] !== 311 || PRIME_SPACE.length !== 256) {
  throw new Error('primeSignature: PRIME_SPACE is not the first 256 primes');
}

/** 4 primes per word (C(64,4) ≈ 635k signatures — collision-free at deck scale). */
export const SIGNATURE_LENGTH = 4;

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
 * Deterministic prime signature for a word: SIGNATURE_LENGTH distinct primes
 * from the prime space, derived from the whole-word hash. `salt` disambiguates
 * hash collisions (the deck vocabulary builder increments it until unique).
 */
export function primeSignature(word: string, primeSpace: readonly number[] = PRIME_SPACE, salt = 0): number[] {
  const hash = fnv1a(salt === 0 ? word.toLowerCase() : `${salt}:${word.toLowerCase()}`);
  const space = primeSpace.length;
  const picks: number[] = [];
  let slot = 0;
  while (picks.length < SIGNATURE_LENGTH) {
    let candidate = (hash >>> (slot * 5)) % space;
    let guard = 0;
    while (picks.includes(candidate) && guard < space) {
      candidate = (candidate + 1) % space;
      guard += 1;
    }
    if (guard >= space) break;
    picks.push(candidate);
    slot += 1;
  }
  return picks.map((index) => primeSpace[index]);
}

/**
 * F.2 SENSE SIGNATURES (§7.2) — one four-prime signature per SENSE of a
 * polysemous surface word (bank#1, bank#2). Derived from a keyed string that
 * includes the sense index, so the surface word's own signature — and every
 * legacy vocabulary entry — stays byte-identical. `salt` escalates for
 * collision-avoidance exactly like the deck builder's salts, so a caller
 * that reserves existing signatures can mint unique sense signatures.
 */
export function sensePrimeSignature(
  word: string,
  senseIndex: number,
  primeSpace: readonly number[] = PRIME_SPACE,
  salt = 0
): number[] {
  const key = salt === 0
    ? `sense:${senseIndex}:${word.toLowerCase()}`
    : `${salt}:sense:${senseIndex}:${word.toLowerCase()}`;
  return primeSignature(key, primeSpace);
}

/**
 * Vocabulary table for a deck: word -> its prime signature.
 *
 * Collision-aware: when two words hash to the same signature, the later
 * word is re-hashed with an increasing salt until its signature is unique.
 * Deterministic for any given deck, so the audit always reproduces it.
 */
export function deckVocabulary(deck: ReadonlyArray<{ word: string }>, primeSpace: readonly number[] = PRIME_SPACE): Record<string, number[]> {
  // Null-prototype record: a word named 'constructor' must never read back
  // as the inherited Object.prototype function (same guard as the semantic
  // vocabulary — see semanticSignature.ts).
  const vocabulary: Record<string, number[]> = Object.create(null) as Record<string, number[]>;
  const seen = new Set<string>();
  for (const entry of deck) {
    const word = entry.word.toLowerCase();
    let salt = 0;
    let signature = primeSignature(word, primeSpace, salt);
    while (seen.has(signature.join(','))) {
      salt += 1;
      signature = primeSignature(word, primeSpace, salt);
    }
    seen.add(signature.join(','));
    vocabulary[word] = signature;
  }
  return vocabulary;
}

/**
 * Collision audit: verify every deck word receives SIGNATURE_LENGTH distinct
 * in-basis primes and a UNIQUE signature (the salted assignment guarantees
 * uniqueness by construction; this is the independent check), and that the
 * assignment is deterministic across calls.
 */
export function auditDeck(deck: ReadonlyArray<{ word: string }>, primeSpace: readonly number[] = PRIME_SPACE): {
  words: number;
  uniqueSignatures: number;
  collisions: Array<{ word: string; signature: number[] }>;
  valid: boolean;
} {
  const first = deckVocabulary(deck, primeSpace);
  const second = deckVocabulary(deck, primeSpace);

  const collisions: Array<{ word: string; signature: number[] }> = [];
  const seen = new Map<string, string>();

  for (const entry of deck) {
    const signature = first[entry.word.toLowerCase()];
    // Determinism: the salted assignment must reproduce identically.
    if (second[entry.word.toLowerCase()].join(',') !== signature.join(',')) {
      collisions.push({ word: entry.word, signature });
      continue;
    }
    if (new Set(signature).size !== SIGNATURE_LENGTH) {
      throw new Error(`word "${entry.word}" produced a degenerate signature: [${signature}]`);
    }
    for (const p of signature) {
      if (!primeSpace.includes(p)) {
        throw new Error(`word "${entry.word}" has an out-of-basis prime: ${p}`);
      }
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
