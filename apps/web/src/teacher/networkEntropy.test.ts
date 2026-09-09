/**
 * @jest-environment node
 *
 * NETWORK ENTROPY (task 39) — the readout must move the way the principle
 * says: a channel (edge) lowers a concept's uncertainty, corroboration lowers
 * it further, a contradiction raises it back to ignorance, and re-teaching a
 * known word — which opens no channel — moves nothing.
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import type { DeckWord } from './deck';
import type { Relation, Negation } from './relations';
import { ENTROPY_SLOTS, SLOT_BITS, closureBits, conceptEntropies, describeEntropy, networkEntropy, slotState } from './networkEntropy';

const DECK: readonly DeckWord[] = [
  { word: 'dog', definition: 'a common animal with four legs that people keep as a pet', example: 'The dog barks.' },
  { word: 'animal', definition: 'a living creature that is not a plant', example: 'A dog is an animal.' },
  { word: 'mammal', definition: 'an animal that feeds its young with milk', example: 'A whale is a mammal.' },
  { word: 'fur', definition: 'the thick hair that covers the body of some animals', example: 'A cat has fur.' }
];
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  smfWidth: 128,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

const edge = (subject: string, predicate: Relation['predicate'], object: string, extra: Partial<Relation> = {}): Relation => ({
  subject,
  predicate,
  object,
  source: 'test',
  // 'curriculum' is a SOURCE CLASS, not an origin; an edge that came in
  // through the curriculum has origin 'conceptnet'. Each case below still
  // sets `sourceClasses` explicitly, which is what the entropy reads.
  origin: 'conceptnet',
  ...extra
});

describe('slot bits', () => {
  it('ignorance costs a bit, one corroborated edge costs 0.51, and the ladder is monotone', () => {
    expect(SLOT_BITS.unknown).toBeCloseTo(1, 6);
    expect(SLOT_BITS.conflicted).toBeCloseTo(1, 6);
    expect(SLOT_BITS.certain).toBeCloseTo(closureBits(0.95), 9);
    expect(closureBits(0)).toBe(1);
    // THE CLOSURE PROPERTY (the 2026-09-09 correction): a second derivable
    // object lowers the slot again — reach, not the best single derivation.
    expect(closureBits(0.95 + 0.7)).toBeLessThan(closureBits(0.95));
    expect(SLOT_BITS.certain).toBeLessThan(SLOT_BITS['single-source']);
    expect(SLOT_BITS['single-source']).toBeLessThan(SLOT_BITS.inherited);
    expect(SLOT_BITS.inherited).toBeLessThan(SLOT_BITS.weakened);
    expect(SLOT_BITS.weakened).toBeLessThan(SLOT_BITS.unknown);
  });

  it('reads a slot the way the answer layer would speak it', () => {
    expect(slotState([], false, false)).toBe('unknown');
    expect(slotState([], false, true)).toBe('inherited');
    expect(slotState([edge('dog', 'is-a', 'mammal')], false, false)).toBe('single-source');
    expect(slotState([edge('dog', 'is-a', 'mammal', { sourceClasses: ['curriculum', 'reading'] })], false, false)).toBe('certain');
    expect(slotState([edge('dog', 'is-a', 'mammal', { sourceClasses: ['curriculum', 'reading'], strength: 0.4 })], false, false)).toBe('weakened');
    expect(slotState([edge('dog', 'is-a', 'mammal', { sourceClasses: ['curriculum', 'reading'] })], true, false)).toBe('conflicted');
  });
});

describe('networkEntropy (pure)', () => {
  const words = [
    { word: 'dog', definition: 'a pet' },
    { word: 'mammal', definition: 'an animal that nurses' },
    { word: 'zebu', definition: '' }
  ];

  it('an edge lowers the concept it couples; corroboration lowers it further; a contradiction raises it to ignorance', () => {
    const none = networkEntropy({ words, relations: [], negations: [] });
    // Three concepts × (10 slots + definition): two defined, one not.
    expect(none.concepts).toBe(3);
    expect(none.byState.unknown).toBe(3 * ENTROPY_SLOTS.length + 1);
    expect(none.total).toBeCloseTo(3 * ENTROPY_SLOTS.length + 1 + 2 * SLOT_BITS.certain, 2);

    const single = networkEntropy({ words, relations: [edge('dog', 'is-a', 'mammal')], negations: [] });
    expect(single.total).toBeLessThan(none.total);
    expect(single.byState['single-source']).toBe(1);

    const corroborated = networkEntropy({ words, relations: [edge('dog', 'is-a', 'mammal', { sourceClasses: ['curriculum', 'conceptnet'] })], negations: [] });
    expect(corroborated.total).toBeLessThan(single.total);
    expect(corroborated.byState.certain).toBe(3); // the edge + two definitions

    const denial: Negation = { subject: 'dog', predicate: 'is-a', object: 'mammal', evidence: 'test', origin: 'taught' };
    const conflicted = networkEntropy({ words, relations: [edge('dog', 'is-a', 'mammal', { sourceClasses: ['curriculum', 'conceptnet'] })], negations: [denial] });
    expect(conflicted.byState.conflicted).toBe(1);
    expect(conflicted.total).toBeCloseTo(none.total, 6); // disagreement costs exactly what ignorance costs
  });

  it('the closure counts: a second is-a edge lowers the slot again, and a grandparent is a derivable is-a object', () => {
    const one = networkEntropy({ words, relations: [edge('dog', 'is-a', 'mammal')], negations: [] });
    const two = networkEntropy({ words, relations: [edge('dog', 'is-a', 'mammal'), edge('dog', 'is-a', 'pet')], negations: [] });
    expect(two.total).toBeLessThan(one.total);
    // dog is-a mammal, mammal is-a animal: "animal" is derivable for dog's
    // is-a slot through the chain — the chain density recovery grows with.
    const chain = networkEntropy({ words, relations: [edge('dog', 'is-a', 'mammal'), edge('mammal', 'is-a', 'animal')], negations: [] });
    const dog = conceptEntropies({ words, relations: [edge('dog', 'is-a', 'mammal'), edge('mammal', 'is-a', 'animal')], negations: [] }).find((c) => c.word === 'dog')!;
    expect(dog.reach['is-a']).toBe(2);
    expect(chain.total).toBeLessThan(one.total);
    // Compared with the single edge alone, the chain lowers dog's is-a slot.
    const dogOne = conceptEntropies({ words, relations: [edge('dog', 'is-a', 'mammal')], negations: [] }).find((c) => c.word === 'dog')!;
    expect(dog.bits).toBeLessThan(dogOne.bits);
  });

  it('an is-a channel lets a concept inherit what its ancestor knows — and a subject-level exception is not a conflict', () => {
    const relations = [edge('dog', 'is-a', 'mammal', { sourceClasses: ['curriculum', 'reading'] }), edge('mammal', 'has-part', 'fur', { sourceClasses: ['curriculum', 'reading'] })];
    const inherited = networkEntropy({ words, relations, negations: [] });
    expect(inherited.byState.inherited).toBe(1);
    // "a dog has no fur" (the world said so): the inherited slot goes back to
    // unknown — the denial resolves it, it does not contradict the dog.
    const exception: Negation = { subject: 'dog', predicate: 'has-part', object: 'fur', evidence: 'test', origin: 'taught' };
    const excepted = networkEntropy({ words, relations, negations: [exception] });
    expect(excepted.byState.inherited).toBe(0);
    expect(excepted.byState.conflicted).toBe(0);
  });

  it('weights a concept by how often the world asks about it, and can measure a fixed set', () => {
    const gaps = new Map([['what is a zebu', 3], ['is a zebu a cow', 2]]);
    const weighted = networkEntropy({ words, relations: [], negations: [], gapCounts: gaps });
    expect(weighted.top[0].word).toBe('zebu');
    expect(weighted.top[0].weight).toBe(6);
    expect(weighted.weightedTotal).toBeGreaterThan(weighted.total);
    const fixed = networkEntropy({ words, relations: [], negations: [], concepts: new Set(['dog']) });
    expect(fixed.concepts).toBe(1);
    expect(fixed.mean).toBeCloseTo(ENTROPY_SLOTS.length + SLOT_BITS.certain, 3);
    const detail = conceptEntropies({ words, relations: [], negations: [], gapCounts: gaps });
    expect(detail[0].word).toBe('zebu');
    expect(detail[0].slots.definition).toBe('unknown');
    expect(describeEntropy(weighted, fixed)).toMatch(/^entropy: .* bits over 3 concepts/);
  });
});

describe('networkEntropy (on a teacher)', () => {
  it('re-teaching a known word moves nothing; a new corroborated channel moves exactly one concept; a denial raises it', async () => {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK, null, 500, 4, 7);
    for (const entry of DECK) teacher.teach(entry.word);
    const before = teacher.networkEntropy();
    expect(before.concepts).toBeGreaterThanOrEqual(DECK.length);

    // Re-teaching opens no channel: byte-identical readout.
    teacher.teach('dog');
    teacher.teach('mammal');
    const again = teacher.networkEntropy();
    expect(again.total).toBe(before.total);
    expect(again.byState).toEqual(before.byState);

    // A ConceptNet row about a deck word: one new single-source edge.
    teacher.ingestRelationBatch({
      relations: [{ subject: 'mammal', predicate: 'has-part', object: 'fur', source: 'conceptnet:HasA:w=2:n=2', origin: 'conceptnet' }],
      negations: [],
      skipped: 0,
      read: 1
    });
    const coupled = teacher.networkEntropy();
    expect(coupled.total).toBeLessThan(before.total);
    const mammalBefore = teacher.conceptEntropies({ concepts: new Set(['mammal']) })[0];
    // A second, independent class corroborates the same edge: lower still.
    teacher.addEdgeSource('mammal', 'has-part', 'fur', 'reading');
    const corroborated = teacher.networkEntropy();
    expect(corroborated.total).toBeLessThan(coupled.total);
    expect(teacher.conceptEntropies({ concepts: new Set(['mammal']) })[0].bits).toBeLessThan(mammalBefore.bits);
    // Whatever dog holds or inherits under has-part, it is no longer ignorance.
    const dog = teacher.conceptEntropies({ concepts: new Set(['dog']) })[0];
    if (teacher.relations().some((r) => r.subject === 'dog' && r.predicate === 'is-a' && r.object === 'mammal')) {
      expect(dog.slots['has-part']).not.toBe('unknown');
    }
    // The world denies the corroborated edge: the concept is now conflicted.
    teacher.storeNegation('mammal', 'has-part', 'fur', 'test denial', 'taught');
    const denied = teacher.networkEntropy();
    expect(denied.byState.conflicted).toBeGreaterThanOrEqual(1);
    expect(denied.total).toBeGreaterThan(corroborated.total);
    expect(denied.ms).toBeLessThan(2000);
    session.dispose();
  }, 60000);
});
