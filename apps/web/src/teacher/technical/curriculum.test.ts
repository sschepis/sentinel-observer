/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  TECHNICAL_CONCEPTS,
  AUTHORED_CONCEPTS,
  CHECKABLE_CONCEPTS,
  ARITHMETIC_CONCEPTS,
  MEASUREMENT_CONCEPTS,
  SCIENCE_CONCEPTS,
  GEOMETRY_CONCEPTS,
  LOGIC_CONCEPTS,
  GRAMMAR_CONCEPTS,
  auditTechnicalCurriculum,
  layerTechnicalDeck,
  technicalRelations,
  prerequisiteOrder,
  nextTeachableConcept,
  curriculumProgress,
  auditCurriculum,
  knownDrills
} from './index';
import { DECK_20000 } from '../decks/en-20000';
import { deckVocabulary, auditDeck, PRIME_SPACE } from '../primeSignature';
import { isATypeOf } from '../chain';
import type { DeckWord } from '../deck';
import type { TechnicalConcept } from './types';

describe('the technical curriculum is well formed', () => {
  it('has no missing prerequisites, duplicates, or cycles', () => {
    const audit = auditTechnicalCurriculum();
    expect(audit.missing).toEqual([]);
    expect(audit.duplicates).toEqual([]);
    expect(audit.cycle).toEqual([]);
    expect(audit.valid).toBe(true);
  });

  it('covers mathematics, measurement, and six science strands at useful depth', () => {
    expect(ARITHMETIC_CONCEPTS.length).toBeGreaterThan(70);
    expect(MEASUREMENT_CONCEPTS.length).toBeGreaterThan(55);
    expect(SCIENCE_CONCEPTS.length).toBeGreaterThan(200);
    expect(TECHNICAL_CONCEPTS.length).toBe(
      ARITHMETIC_CONCEPTS.length +
        MEASUREMENT_CONCEPTS.length +
        SCIENCE_CONCEPTS.length +
        GEOMETRY_CONCEPTS.length +
        LOGIC_CONCEPTS.length +
        GRAMMAR_CONCEPTS.length
    );
    const scienceDepth = new Map<string, number>();
    for (const concept of SCIENCE_CONCEPTS) {
      scienceDepth.set(concept.strand, (scienceDepth.get(concept.strand) ?? 0) + 1);
    }
    for (const strand of ['scientific-practice', 'physics', 'chemistry', 'biology', 'earth-science', 'astronomy']) {
      expect(scienceDepth.get(strand)).toBeGreaterThan(20);
    }
  });

  it('declares no word in two strands — ordering would silently drop one', () => {
    const seen = new Map<string, string>();
    for (const concept of AUTHORED_CONCEPTS) {
      expect(seen.has(concept.word)).toBe(false);
      seen.set(concept.word, concept.strand);
    }
  });

  it('gives every concept real teaching content', () => {
    for (const concept of TECHNICAL_CONCEPTS) {
      expect(concept.definition.trim().length).toBeGreaterThan(10);
      expect(concept.example.trim().length).toBeGreaterThan(5);
    }
  });

  it('names a real generator for every checkable concept', () => {
    const drills = new Set(knownDrills());
    for (const concept of CHECKABLE_CONCEPTS) {
      expect(drills.has(concept.drill as string)).toBe(true);
    }
    expect(CHECKABLE_CONCEPTS.length).toBeGreaterThan(25);
  });

  it('catches an unteachable concept before it reaches the classroom', () => {
    const broken: TechnicalConcept[] = [
      { word: 'a', definition: 'x', example: 'x', strand: 'number', dependsOn: ['nowhere'] }
    ];
    expect(auditCurriculum(broken).missing).toEqual([{ concept: 'a', dependsOn: 'nowhere' }]);

    const cyclic: TechnicalConcept[] = [
      { word: 'a', definition: 'x', example: 'x', strand: 'number', dependsOn: ['b'] },
      { word: 'b', definition: 'x', example: 'x', strand: 'number', dependsOn: ['a'] }
    ];
    expect(auditCurriculum(cyclic).cycle.sort()).toEqual(['a', 'b']);
  });
});

describe('prerequisite ordering', () => {
  it('never places a concept before something it depends on', () => {
    const position = new Map(TECHNICAL_CONCEPTS.map((concept, index) => [concept.word, index]));
    for (const concept of TECHNICAL_CONCEPTS) {
      for (const prerequisite of concept.dependsOn) {
        expect(position.get(prerequisite)).toBeLessThan(position.get(concept.word) as number);
      }
    }
  });

  it('is stable across calls', () => {
    const first = prerequisiteOrder(TECHNICAL_CONCEPTS).map((c) => c.word);
    const second = prerequisiteOrder(TECHNICAL_CONCEPTS).map((c) => c.word);
    expect(first).toEqual(second);
  });

  it('offers only concepts whose prerequisites are already learned', () => {
    const learned = new Set<string>();
    const isLearned = (word: string) => learned.has(word);

    for (let step = 0; step < TECHNICAL_CONCEPTS.length; step += 1) {
      const next = nextTeachableConcept(TECHNICAL_CONCEPTS, isLearned);
      expect(next).not.toBeNull();
      for (const prerequisite of (next as TechnicalConcept).dependsOn) {
        expect(learned.has(prerequisite)).toBe(true);
      }
      learned.add((next as TechnicalConcept).word);
    }
    // Exhausted, not blocked: every concept became reachable.
    expect(nextTeachableConcept(TECHNICAL_CONCEPTS, isLearned)).toBeNull();
    expect(learned.size).toBe(TECHNICAL_CONCEPTS.length);
  });

  it('reports progress per strand', () => {
    const learned = new Set(['number', 'quantity']);
    const progress = curriculumProgress(TECHNICAL_CONCEPTS, (w) => learned.has(w));
    expect(progress.number.total).toBeGreaterThan(0);
    expect(progress.number.learned).toBe(2);
  });
});

describe('layering onto the English deck', () => {
  const layered = layerTechnicalDeck(DECK_20000 as readonly DeckWord[]);

  it('keeps every English word and adds the new technical vocabulary', () => {
    const base = new Set(DECK_20000.map((e) => e.word));
    const after = new Set(layered.map((e) => e.word));
    for (const word of base) expect(after.has(word)).toBe(true);
    expect(after.size).toBeGreaterThan(base.size);
  });

  it('never duplicates a word — a duplicate would corrupt its prime signature', () => {
    const seen = new Set<string>();
    for (const entry of layered) {
      expect(seen.has(entry.word)).toBe(false);
      seen.add(entry.word);
    }
  });

  it('leaves every existing prime signature untouched', () => {
    const before = deckVocabulary(DECK_20000 as readonly DeckWord[]);
    const after = deckVocabulary(layered);
    for (const word of Object.keys(before)) {
      expect(after[word]).toEqual(before[word]);
    }
  });

  it('replaces an everyday sense with the technical one in place', () => {
    const baseIndex = DECK_20000.findIndex((e) => e.word === 'number');
    expect(baseIndex).toBeGreaterThanOrEqual(0);
    // Same position, technical definition.
    expect(layered[baseIndex].word).toBe('number');
    expect(layered[baseIndex].definition).toBe('a value that tells how many or how much');
  });

  it('gives the layered deck unique, well-formed prime signatures', () => {
    const audit = auditDeck(layered, PRIME_SPACE);
    expect(audit.uniqueSignatures).toBe(audit.words);
    expect(audit.collisions).toHaveLength(0);
    // Technical concepts may be multi-word ("least common multiple"), but
    // nothing else may sneak in — notation in a deck KEY would not survive
    // the tokenizer.
    for (const entry of layered) expect(entry.word).toMatch(/^[a-z]+( [a-z]+)*$/);
  });

  it('appends genuinely new concepts after the English curriculum', () => {
    const newConcept = layered.findIndex((e) => e.word === 'least common multiple');
    expect(newConcept).toBeGreaterThanOrEqual(DECK_20000.length);
  });

  it('preserves prerequisite order among the appended concepts', () => {
    const positions = new Map(layered.map((entry, index) => [entry.word, index]));
    for (const concept of TECHNICAL_CONCEPTS) {
      for (const prerequisite of concept.dependsOn) {
        // Only meaningful for concepts that were appended; replaced-in-place
        // words keep their English frequency position by design.
        const appended = (positions.get(concept.word) as number) >= DECK_20000.length;
        const parentAppended = (positions.get(prerequisite) as number) >= DECK_20000.length;
        if (appended && parentAppended) {
          expect(positions.get(prerequisite)).toBeLessThan(positions.get(concept.word) as number);
        }
      }
    }
  });
});

describe('the authored relation graph', () => {
  const relations = technicalRelations();

  it('emits an edge for every prerequisite', () => {
    const dependencyEdges = relations.filter((r) => r.predicate === 'depends-on');
    const declared = TECHNICAL_CONCEPTS.reduce((sum, c) => sum + c.dependsOn.length, 0);
    expect(dependencyEdges.length).toBe(declared);
  });

  it('carries the defining prose as provenance', () => {
    for (const relation of relations) {
      expect(relation.source.length).toBeGreaterThan(0);
    }
  });

  it('walks through the existing inference code', () => {
    // special-case-of behaves like is-a for the chain walker once mapped.
    const asIsA = relations
      .filter((r) => r.predicate === 'special-case-of')
      .map((r) => ({ ...r, predicate: 'is-a' as const }));
    expect(asIsA.length).toBeGreaterThan(0);
    expect(isATypeOf(asIsA, 'square', 'exponentiation')).toBe(true);
    expect(isATypeOf(asIsA, 'square', 'fraction')).toBe(false);
  });

  it('carries representative science classifications and parts', () => {
    expect(relations).toContainEqual(expect.objectContaining({ subject: 'bacterium', predicate: 'is-a', object: 'prokaryote' }));
    expect(relations).toContainEqual(expect.objectContaining({ subject: 'kinetic energy', predicate: 'is-a', object: 'energy' }));
    expect(relations).toContainEqual(expect.objectContaining({ subject: 'ionic bond', predicate: 'is-a', object: 'chemical bond' }));
    expect(relations).toContainEqual(expect.objectContaining({ subject: 'chromosome', predicate: 'made-of', object: 'dna' }));
    expect(relations).toContainEqual(expect.objectContaining({ subject: 'igneous rock', predicate: 'is-a', object: 'rock' }));
    expect(relations).toContainEqual(expect.objectContaining({ subject: 'galaxy', predicate: 'has-part', object: 'star' }));
  });
});
