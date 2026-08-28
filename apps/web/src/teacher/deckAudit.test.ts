/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { DECK_100 } from './decks/en-100';
import { PRIME_SPACE, SIGNATURE_LENGTH, auditDeck, primeSignature } from './primeSignature';

/**
 * The encoding's CI gate (docs/SCALING.md phase 2): every word must receive
 * exactly SIGNATURE_LENGTH distinct primes from the field basis, and no two
 * words may share a full signature — near-identical words must be separable.
 */
describe('deck prime-signature audit', () => {
  it('en-100 has unique, distinct, in-basis signatures', () => {
    const result = auditDeck(DECK_100, PRIME_SPACE);
    expect(result.words).toBe(100);
    expect(result.uniqueSignatures).toBe(100);
    expect(result.collisions).toHaveLength(0);
  });

  it('every signature uses distinct primes from the prime space', () => {
    for (const entry of DECK_100) {
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
