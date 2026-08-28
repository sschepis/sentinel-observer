/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { DECK_100 } from './decks/en-100';
import { DECK_1000 } from './decks/en-1000';
import { PRIME_SPACE, SIGNATURE_LENGTH, auditDeck, primeSignature } from './primeSignature';

describe('deck prime-signature audit', () => {
  it('en-100 has unique, distinct, in-basis signatures', () => {
    const result = auditDeck(DECK_100, PRIME_SPACE);
    expect(result.words).toBe(100);
    expect(result.uniqueSignatures).toBe(100);
    expect(result.collisions).toHaveLength(0);
  });

  it('en-1000 (2437 words) has unique, distinct signatures', () => {
    const result = auditDeck(DECK_1000, PRIME_SPACE);
    // eslint-disable-next-line no-console
    console.log(`AUDIT: ${result.words} words, ${result.uniqueSignatures} unique signatures, ${result.collisions.length} collisions`);
    expect(result.uniqueSignatures).toBe(result.words);
    expect(result.collisions).toHaveLength(0);
  });

  it('every signature uses distinct primes from the prime space', () => {
    for (const entry of [...DECK_100.slice(0, 20), ...DECK_1000.slice(0, 20)]) {
      const signature = primeSignature(entry.word, PRIME_SPACE);
      expect(signature).toHaveLength(SIGNATURE_LENGTH);
      expect(new Set(signature).size).toBe(SIGNATURE_LENGTH);
      for (const p of signature) {
        expect(PRIME_SPACE.includes(p)).toBe(true);
      }
    }
  });

  it('near-identical words are separable (the apple/apply problem)', () => {
    const apple = primeSignature('apple');
    const apply = primeSignature('apply');
    expect(apple).not.toEqual(apply);
    const overlap = apple.filter((p) => apply.includes(p));
    expect(overlap.length).toBeLessThan(3);
  });
});
