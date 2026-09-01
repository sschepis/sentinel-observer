/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { DECK_20000 } from './decks/en-20000';
import { DEFINITION_OVERRIDES, applyDefinitionOverrides } from './definitionOverrides';
import type { DeckWord } from './deck';

/*
 * Static regression guards for the curated sense overrides. The overrides
 * exist because WordNet's first synset was confidently wrong (famous-person
 * senses, US-department senses, stale facts); these tests keep the map
 * honest: every key must still be a real deck word, every replacement must
 * actually replace something, and no override may reintroduce the failure
 * classes it was written to remove.
 */
describe('definition overrides', () => {
  const deckByWord = new Map(DECK_20000.map((entry) => [entry.word, entry]));

  it('every override key exists in DECK_20000', () => {
    const missing: string[] = [];
    for (const word of DEFINITION_OVERRIDES.keys()) {
      if (!deckByWord.has(word)) missing.push(word);
    }
    expect(missing).toEqual([]);
  });

  it('no override definition is empty or identical to the deck definition it replaces', () => {
    for (const [word, override] of DEFINITION_OVERRIDES) {
      expect(override.definition.trim().length).toBeGreaterThan(0);
      expect(override.example.trim().length).toBeGreaterThan(0);
      const deckEntry = deckByWord.get(word);
      if (deckEntry !== undefined) {
        expect(override.definition).not.toBe(deckEntry.definition);
      }
    }
  });

  it('no override reintroduces a famous-person birth-year or United States sense', () => {
    const birthYears = /\(\d{4}[-–]\d{4}\)/;
    for (const [word, override] of DEFINITION_OVERRIDES) {
      expect(`${word}: ${override.definition}`).not.toMatch(birthYears);
      expect(override.definition).not.toContain('United States');
    }
  });

  it('applyDefinitionOverrides preserves deck length and order', () => {
    const deck = DECK_20000 as readonly DeckWord[];
    const applied = applyDefinitionOverrides(deck);
    expect(applied.length).toBe(deck.length);
    for (let i = 0; i < deck.length; i += 1) {
      expect(applied[i].word).toBe(deck[i].word);
    }
    /* Spot-check that an override actually landed where expected. */
    const truthIndex = deck.findIndex((entry) => entry.word === 'truth');
    expect(truthIndex).toBeGreaterThanOrEqual(0);
    expect(applied[truthIndex].definition).toBe(DEFINITION_OVERRIDES.get('truth')?.definition);
  });
});
