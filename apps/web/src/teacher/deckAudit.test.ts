/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { DECK_100 } from './decks/en-100';
import { DECK_1000 } from './decks/en-1000';
import { DECK_20000 } from './decks/en-20000';
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

  it('en-20000 (the ACTIVE_DECK) has unique signatures and well-formed entries', () => {
    const result = auditDeck(DECK_20000, PRIME_SPACE);
    // eslint-disable-next-line no-console
    console.log(`AUDIT-20K: ${result.words} words, ${result.uniqueSignatures} unique signatures, ${result.collisions.length} collisions`);
    expect(result.uniqueSignatures).toBe(result.words);
    expect(result.collisions).toHaveLength(0);
    // Every entry must be a plain lowercase A-Z word, and the deck must be
    // in the honest documented state: definitions for the overwhelming
    // majority (83.7% — the WordNet-sourced share), examples for a
    // substantial share, with the audited shortfall counted loudly so a
    // regeneration that SHRINKS coverage fails here.
    let emptyDefinitions = 0;
    let emptyExamples = 0;
    for (const entry of DECK_20000) {
      expect(entry.word).toMatch(/^[a-z]+$/);
      if (entry.definition.trim().length === 0) emptyDefinitions += 1;
      if (entry.example.trim().length === 0) emptyExamples += 1;
    }
    const definitionsCoverage = (DECK_20000.length - emptyDefinitions) / DECK_20000.length;
    const examplesCoverage = (DECK_20000.length - emptyExamples) / DECK_20000.length;
    // eslint-disable-next-line no-console
    console.log(
      `AUDIT-20K: definitions ${(definitionsCoverage * 100).toFixed(1)}% (${emptyDefinitions} empty) · examples ${(examplesCoverage * 100).toFixed(1)}% (${emptyExamples} empty)`
    );
    expect(definitionsCoverage).toBeGreaterThan(0.8);
    expect(examplesCoverage).toBeGreaterThan(0.3);
    expect(emptyDefinitions).toBeLessThanOrEqual(3269);
    expect(emptyExamples).toBeLessThanOrEqual(12779);
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
