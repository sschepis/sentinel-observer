/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  extractRelations,
  inheritanceChains,
  reconcileRelations,
  mergeRelations,
  predicateVerb,
  type Relation,
  type RelationPredicate
} from './relations';

const DECK = [
  { word: 'bird', definition: 'a creature with wings and feathers that can fly' },
  { word: 'robin', definition: 'a small bird with a red breast' },
  { word: 'dog', definition: 'a common animal with four legs that people keep as a pet' },
  { word: 'apple', definition: 'a round red or green fruit' },
  { word: 'water', definition: 'a clear liquid that falls as rain and is used for drinking' },
  { word: 'game', definition: 'a contest with rules that people play to win' },
  { word: 'tennis', definition: 'a game played with a ball and a racket' },
  { word: 'the', definition: 'used before a noun to mean a specific person or thing' },
  { word: 'more', definition: '(comparative of much) a greater amount' },
  { word: 'wings', definition: 'a part of a bird used for flying' },
  { word: 'fruit', definition: 'a sweet part of a plant that contains seeds' },
  { word: 'liquid', definition: 'a substance that flows and is not solid or gas' },
  { word: 'animal', definition: 'a living creature that can move and feel' },
  { word: 'rules', definition: 'a set of instructions for playing a game' }
];

describe('relational traces', () => {
  it('extracts is-a edges from WordNet-style definitions', () => {
    const relations = extractRelations(DECK);
    const isA = relations.filter((r) => r.predicate === 'is-a');
    expect(isA.some((r) => r.subject === 'robin' && r.object === 'bird')).toBe(true);
    expect(isA.some((r) => r.subject === 'apple' && r.object === 'fruit')).toBe(true);
    expect(isA.some((r) => r.subject === 'tennis' && r.object === 'game')).toBe(true);
  });

  it('extracts has-part edges ("with wings" -> wings)', () => {
    const relations = extractRelations(DECK);
    expect(relations.some((r) => r.subject === 'bird' && r.predicate === 'has-part' && r.object === 'wings')).toBe(true);
  });

  it('never treats modifiers as hypernyms ("small bird" -> bird, not small)', () => {
    const relations = extractRelations(DECK);
    const robinIsA = relations.find((r) => r.subject === 'robin' && r.predicate === 'is-a');
    expect(robinIsA?.object).toBe('bird');
  });

  it('skips non-WordNet glosses (function words and parentheticals)', () => {
    const relations = extractRelations(DECK);
    expect(relations.filter((r) => r.subject === 'the')).toHaveLength(0);
    expect(relations.filter((r) => r.subject === 'more')).toHaveLength(0);
  });

  it('excludes bare-singular "with" phrases ("with respect to")', () => {
    const relations = extractRelations([{ word: 'port', definition: 'a place with respect to which people enter a country' }]);
    expect(relations.some((r) => r.predicate === 'has-part' && r.object === 'respect')).toBe(false);
  });

  it('finds inheritance chains: robin is-a bird, bird has-part wings', () => {
    const deck = [
      { word: 'bird', definition: 'a creature with wings and feathers that can fly' },
      { word: 'robin', definition: 'a small bird with a red breast' },
      { word: 'wings', definition: 'a part of a bird used for flying' }
    ];
    const chains = inheritanceChains(extractRelations(deck));
    expect(chains.some((c) => c.subject === 'robin' && c.parent === 'bird' && c.part === 'wings')).toBe(true);
  });
});

describe('relation provenance and reconciliation', () => {
  const regex = (subject: string, predicate: RelationPredicate, object: string): Relation =>
    ({ subject, predicate, object, source: 'def', origin: 'regex' });
  const llm = (subject: string, predicate: RelationPredicate, object: string): Relation =>
    ({ subject, predicate, object, source: 'def', origin: 'chaperone' });

  it('extracted edges carry regex provenance; mergeRelations dedupes by key', () => {
    const extracted = extractRelations([
      { word: 'robin', definition: 'a small bird with a red breast' }
    ]);
    expect(extracted.every((r) => r.origin === 'regex')).toBe(true);

    const merged = mergeRelations(
      [regex('robin', 'is-a', 'bird')],
      [llm('robin', 'is-a', 'bird')]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].origin).toBe('regex'); // regex wins the tie
  });

  it('reconcileRelations separates agreed, LLM-only, and conflicts', () => {
    const { agreed, llmOnly, conflicts } = reconcileRelations(
      [
        regex('robin', 'is-a', 'bird'),
        regex('bird', 'has-part', 'wings'),
        regex('snow', 'has-property', 'cold')
      ],
      [
        llm('robin', 'is-a', 'bird'), // agreed
        llm('bird', 'capable-of', 'fly'), // new — LLM only
        llm('snow', 'has-property', 'wet'), // CONFLICT (regex says cold)
        llm('water', 'requires', 'cleanliness') // LLM only (no regex edge)
      ]
    );
    expect(agreed).toHaveLength(1);
    expect(llmOnly.map((r) => r.object)).toEqual(['fly', 'cleanliness']);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({
      subject: 'snow',
      predicate: 'has-property',
      regexObject: 'cold',
      llmObject: 'wet'
    });
  });

  it('a regex-only edge is neither a conflict nor an override (omission is not contradiction)', () => {
    const { agreed, llmOnly, conflicts } = reconcileRelations(
      [regex('bird', 'has-part', 'wings')],
      [llm('robin', 'capable-of', 'fly')]
    );
    expect(conflicts).toHaveLength(0);
    expect(llmOnly).toHaveLength(1);
    expect(agreed).toHaveLength(0);
  });

  it('predicateVerb renders natural English for belief phrasing', () => {
    expect(predicateVerb('is-a', 'animal')).toBe('is an');
    expect(predicateVerb('is-a', 'bird')).toBe('is a');
    expect(predicateVerb('has-part', 'wings')).toBe('has');
    expect(predicateVerb('capable-of', 'fly')).toBe('can');
    expect(predicateVerb('has-property', 'cold')).toBe('is');
    expect(predicateVerb('opposite-of', 'hot')).toBe('is the opposite of');
  });
});
