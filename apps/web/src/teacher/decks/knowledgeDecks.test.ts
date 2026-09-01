/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../../observer/engine';
import { TeacherAgent } from '../TeacherAgent';
import { CONVERSATION_CUE_TOKENS } from '../conversation';
import { PRIME_SPACE, deckVocabulary } from '../primeSignature';
import { RELATION_PREDICATES } from '../relations';
import { parseNegationStatement } from '../operators';
import { applyDefinitionOverrides } from '../definitionOverrides';
import { layerTechnicalDeck } from '../technical';
import type { DeckWord } from '../deck';
import { DECK_20000 } from './en-20000';
import { ACTIVE_DECK } from './index';
import { SUPPLEMENTAL_RELATIONS } from './relationSupplements';
import { GROUNDED_FACTS_DECK, GROUNDED_FACTS_RELATIONS, layerGroundedFacts } from './groundedFacts';
import { NEGATION_DECK, teachNegationDeck } from './negations';

describe('supplemental everyday relations (static)', () => {
  it('meets the coverage goal and uses only valid predicates', () => {
    expect(SUPPLEMENTAL_RELATIONS.length).toBeGreaterThanOrEqual(300);
    const valid = new Set<string>(RELATION_PREDICATES);
    for (const relation of SUPPLEMENTAL_RELATIONS) {
      expect(valid.has(relation.predicate)).toBe(true);
      expect(relation.origin).toBe('authored');
    }
  });

  it('has no duplicate subject+predicate+object triples', () => {
    const keys = SUPPLEMENTAL_RELATIONS.map((r) => `${r.subject}\u0000${r.predicate}\u0000${r.object}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('subjects and objects are lowercase single- or two-word strings', () => {
    const WORDISH = /^[a-z]+( [a-z]+)?$/;
    for (const relation of SUPPLEMENTAL_RELATIONS) {
      expect(relation.subject).toMatch(WORDISH);
      expect(relation.object).toMatch(WORDISH);
    }
  });
});

describe('negation deck (static round-trip)', () => {
  it('every statement parses to exactly its declared subject, predicate, and object', () => {
    expect(NEGATION_DECK.length).toBeGreaterThanOrEqual(60);
    for (const entry of NEGATION_DECK) {
      const parsed = parseNegationStatement(entry.statement);
      expect(parsed).not.toBeNull();
      expect(parsed!.subject).toBe(entry.subject);
      expect(parsed!.predicate).toBe(entry.predicate);
      expect(parsed!.object).toBe(entry.object);
    }
  });

  it('has no duplicate claims', () => {
    const keys = NEGATION_DECK.map((e) => `${e.subject}\u0000${e.predicate}\u0000${e.object}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('grounded facts deck (static)', () => {
  it('every entry has a nonempty extractable definition and an example', () => {
    expect(GROUNDED_FACTS_DECK.length).toBeGreaterThanOrEqual(45);
    for (const entry of GROUNDED_FACTS_DECK) {
      expect(entry.word).toMatch(/^[a-z]+$/);
      expect(entry.definition.trim().length).toBeGreaterThan(0);
      expect(entry.example.trim().length).toBeGreaterThan(0);
    }
  });

  it('its relations use valid predicates and carry no duplicates', () => {
    expect(GROUNDED_FACTS_RELATIONS.length).toBeGreaterThanOrEqual(75);
    const valid = new Set<string>(RELATION_PREDICATES);
    const keys: string[] = [];
    for (const relation of GROUNDED_FACTS_RELATIONS) {
      expect(valid.has(relation.predicate)).toBe(true);
      expect(relation.origin).toBe('authored');
      keys.push(`${relation.subject}\u0000${relation.predicate}\u0000${relation.object}`);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('layerGroundedFacts replaces in place and appends only new words, preserving order', () => {
    // The exact base ACTIVE_DECK is built from, minus the grounded layer.
    const base = layerTechnicalDeck(applyDefinitionOverrides(DECK_20000 as readonly DeckWord[]));
    const layered = layerGroundedFacts(base);
    const baseWords = new Set(base.map((entry) => entry.word));
    const appended = GROUNDED_FACTS_DECK.filter((entry) => !baseWords.has(entry.word));
    expect(layered.length).toBe(base.length + appended.length);
    // No reordering: position i still holds the same WORD (its definition
    // may have been replaced in place — that is the point of the layer).
    for (let i = 0; i < base.length; i += 1) {
      expect(layered[i].word).toBe(base[i].word);
    }
    expect(layered.slice(base.length).map((entry) => entry.word)).toEqual(appended.map((entry) => entry.word));
    // And ACTIVE_DECK is exactly this layering.
    expect(ACTIVE_DECK.length).toBe(layered.length);
    // A curated sense won over WordNet: may is a month in the active deck.
    const may = ACTIVE_DECK.find((entry) => entry.word === 'may');
    expect(may?.definition).toContain('month');
  });
});

describe('knowledge decks in a session', () => {
  const DECK: readonly DeckWord[] = [
    { word: 'whale', definition: 'a very large animal that lives in the sea', example: 'The whale swam past the boat.' },
    { word: 'fish', definition: 'an animal that lives in water', example: 'The fish swam in the pond.' },
    { word: 'spider', definition: 'a small animal with eight legs', example: 'The spider made a web.' },
    { word: 'insect', definition: 'a small animal with six legs', example: 'The insect landed on the leaf.' },
    { word: 'dog', definition: 'a friendly pet that barks', example: 'The dog ran to the gate.' },
    { word: 'animal', definition: 'a living creature that can move', example: 'The animal slept in the shade.' },
    { word: 'bird', definition: 'an animal with wings', example: 'A bird can fly.' },
    { word: 'bat', definition: 'a small animal that flies at night', example: 'The bat left the cave at dusk.' },
    { word: 'snake', definition: 'a long thin animal that crawls on the ground', example: 'The snake lay in the sun.' },
    { word: 'legs', definition: 'the parts of the body used for walking', example: 'The table has four legs.' },
    { word: 'pet', definition: 'an animal kept at home', example: 'The pet waited by the door.' },
    { word: 'water', definition: 'a clear liquid that falls as rain', example: 'Water is wet.' }
  ];

  const OPTIONS = {
    primeCount: 64,
    gridSize: 128,
    memoryMode: 'compact' as const,
    vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
  };

  async function setupTeacher(): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK);
    for (const entry of DECK) teacher.teach(entry.word);
    return { session, teacher };
  }

  it('teachNegationDeck stores the confirmed-false claims for the taught subjects', async () => {
    const { session, teacher } = await setupTeacher();
    const known = new Set(DECK.map((entry) => entry.word));
    const subset = NEGATION_DECK.filter((entry) => known.has(entry.subject));
    expect(subset.length).toBeGreaterThan(0);
    const taught = teachNegationDeck(teacher, subset);
    expect(taught).toBe(subset.length);
    const negations = teacher.negationsList();
    for (const entry of subset) {
      expect(
        negations.some(
          (n) => n.subject === entry.subject && n.predicate === entry.predicate && n.object === entry.object
        )
      ).toBe(true);
    }
    session.dispose();
  });

  it('supplemental edges answer relational questions prose extraction never could', async () => {
    const { session, teacher } = await setupTeacher();
    // 'dog' is defined as a pet here, so no regex edge says dog is-a animal —
    // the edge can only come from SUPPLEMENTAL_RELATIONS via the authored pool.
    const edge = teacher
      .relations()
      .find((r) => r.subject === 'dog' && r.predicate === 'is-a' && r.object === 'animal');
    expect(edge).toBeDefined();
    expect(edge!.origin).toBe('authored');
    session.dispose();
  });
});
