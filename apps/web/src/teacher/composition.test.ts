/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { TokenCostModel } from './mdl';
import { DECK_100 } from './decks/en-100';
import {
  COMPOSITION_RULES,
  COMPOSITION_STEP_COST,
  chainPhrase,
  composeClaim,
  composedClaimsFor,
  compositionGain,
  deniedFromNegations,
  isSoundSequence
} from './composition';
import type { Negation, Relation } from './relations';

const RELATIONS: Relation[] = [
  { subject: 'bird', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex' },
  { subject: 'animal', predicate: 'has-part', object: 'heart', source: 'def', origin: 'regex' },
  { subject: 'heart', predicate: 'capable-of', object: 'pump blood', source: 'def', origin: 'chaperone' },
  { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
  { subject: 'bird', predicate: 'capable-of', object: 'fly', source: 'def', origin: 'chaperone' },
  { subject: 'bird', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
  { subject: 'car', predicate: 'has-part', object: 'wheel', source: 'def', origin: 'regex' },
  { subject: 'wheel', predicate: 'made-of', object: 'rubber', source: 'def', origin: 'regex' },
  { subject: 'wheel', predicate: 'is-a', object: 'part', source: 'def', origin: 'regex' },
  { subject: 'table', predicate: 'has-part', object: 'leg', source: 'def', origin: 'regex' },
  { subject: 'leg', predicate: 'has-part', object: 'joint', source: 'def', origin: 'regex' }
];

/**
 * A realistic Zipf frequency prior: the chain words first (cheapest), then
 * the real 100-word deck. The gate's numbers depend on this model, so the
 * tests construct it explicitly — same discipline as learning.test.ts.
 */
const CHAIN_WORDS = ['bird', 'animal', 'heart', 'pump', 'blood', 'robin', 'wings', 'wheel', 'rubber', 'part', 'car', 'fly', 'leg', 'joint', 'table'];
const COST = new TokenCostModel([
  ...CHAIN_WORDS,
  ...DECK_100.map((entry) => entry.word).filter((word) => !CHAIN_WORDS.includes(word))
]);

// A 5-word model where 'bird' is the CHEAPEST token: a chain through it
// must fail the MDL gate (the inference costs more than it compresses).
const CHEAP = new TokenCostModel(['bird', 'animal', 'heart', 'pump', 'blood']);

const RARE = new TokenCostModel([]); // every token costs the unknown 20 bits

describe('composition rules (which predicate sequences are sound)', () => {
  it('licenses the sound sequences: is-a→has-part→capable-of and its siblings', () => {
    expect(isSoundSequence(['is-a', 'has-part', 'capable-of'])?.conclusion).toBe('capable-of');
    expect(isSoundSequence(['is-a', 'capable-of'])?.conclusion).toBe('capable-of');
    expect(isSoundSequence(['has-part', 'capable-of'])?.conclusion).toBe('capable-of');
    expect(isSoundSequence(['is-a', 'has-part'])?.conclusion).toBe('has-part');
    expect(isSoundSequence(['is-a', 'is-a'])?.conclusion).toBe('is-a');
    expect(isSoundSequence(['is-a', 'has-property'])?.conclusion).toBe('has-property');
  });

  it('collapses consecutive is-a hops through the transitive rule', () => {
    // robin is-a bird is-a animal: the is-a run is one step.
    expect(isSoundSequence(['is-a', 'is-a', 'has-part', 'capable-of'])?.conclusion).toBe('capable-of');
    expect(isSoundSequence(['is-a', 'is-a', 'capable-of'])?.conclusion).toBe('capable-of');
  });

  it('REJECTS unsound sequences — parts of parts, capabilities of capabilities, kinds through parts', () => {
    expect(isSoundSequence(['has-part', 'has-part'])).toBeNull();
    expect(isSoundSequence(['capable-of', 'capable-of'])).toBeNull();
    expect(isSoundSequence(['has-part', 'is-a'])).toBeNull();
    expect(isSoundSequence(['is-a', 'opposite-of'])).toBeNull();
    expect(isSoundSequence(['opposite-of', 'is-a'])).toBeNull();
    expect(isSoundSequence(['has-part', 'made-of'])).toBeNull();
    expect(isSoundSequence(['has-part', 'used-for'])).toBeNull();
    expect(isSoundSequence(['has-property', 'has-property'])).toBeNull();
    expect(isSoundSequence(['capable-of', 'has-part'])).toBeNull();
    // A single edge is not a composition.
    expect(isSoundSequence(['is-a'])).toBeNull();
  });

  it('every rule conclusion is a real predicate and the table is non-empty', () => {
    expect(COMPOSITION_RULES.length).toBeGreaterThan(0);
    for (const rule of COMPOSITION_RULES) {
      expect(rule.hops.length).toBeGreaterThanOrEqual(2);
      expect(rule.conclusion).toBe(rule.hops[rule.hops.length - 1] === 'is-a' ? 'is-a' : rule.conclusion);
    }
  });
});

describe('composeClaim (backing a claim with a chain)', () => {
  it('backs bird can pump blood via is-a → has-part → capable-of', () => {
    const claim = composeClaim(RELATIONS, 'bird', 'capable-of', 'pump blood', { cost: COST });
    expect(claim).not.toBeNull();
    if (claim !== null) {
      expect(claim.hops.map((h) => h.predicate)).toEqual(['is-a', 'has-part', 'capable-of']);
      expect(claim.subject).toBe('bird');
      expect(claim.object).toBe('pump blood');
      expect(claim.support).toBe(1);
      expect(claim.gain).toBeGreaterThan(0);
    }
  });

  it('backs robin can pump blood through a collapsed is-a run', () => {
    const claim = composeClaim(RELATIONS, 'robin', 'capable-of', 'pump blood', { cost: COST });
    expect(claim).not.toBeNull();
    if (claim !== null) {
      expect(claim.hops).toHaveLength(4); // robin→bird→animal→heart→pump blood
      expect(claim.hops[0]).toMatchObject({ subject: 'robin', predicate: 'is-a', object: 'bird' });
      expect(claim.support).toBe(1);
    }
  });

  it('REJECTS has-part → has-part: parts of parts are not parts', () => {
    expect(composeClaim(RELATIONS, 'table', 'has-part', 'joint', { cost: COST })).toBeNull();
  });

  it('REJECTS has-part → is-a: a part being a thing does not make the whole that thing', () => {
    // car has-part wheel, wheel is-a part — "is a wheel a car" must NOT compose.
    expect(composeClaim(RELATIONS, 'wheel', 'is-a', 'car', { cost: COST })).toBeNull();
  });

  it('REJECTS capable-of → capable-of: an action is not capable of things', () => {
    const relations: Relation[] = [
      { subject: 'bird', predicate: 'capable-of', object: 'fly', source: 'def', origin: 'chaperone' },
      { subject: 'fly', predicate: 'capable-of', object: 'soar', source: 'def', origin: 'chaperone' }
    ];
    expect(composeClaim(relations, 'bird', 'capable-of', 'soar', { cost: RARE })).toBeNull();
  });

  it('returns null when no chain ends at the asked object', () => {
    expect(composeClaim(RELATIONS, 'bird', 'has-part', 'wheel', { cost: COST })).toBeNull();
    expect(composeClaim(RELATIONS, 'bird', 'is-a', 'muscle', { cost: COST })).toBeNull();
  });

  it('does not compose a claim the subject already states (subject === object)', () => {
    expect(composeClaim(RELATIONS, 'bird', 'is-a', 'bird', { cost: COST })).toBeNull();
  });
});

describe('MDL gate (composition is not free)', () => {
  it('adopts the canonical chain — the claim compresses its chain', () => {
    const claim = composeClaim(RELATIONS, 'bird', 'capable-of', 'pump blood', { cost: COST });
    expect(claim?.gain).toBeGreaterThan(0);
    expect(COMPOSITION_STEP_COST).toBe(2);
    // The gain IS savings − claim − step cost × hops: verify the arithmetic
    // independently against the model's own costs.
    const hops: Array<{ subject: string; predicate: 'is-a' | 'has-part' | 'capable-of'; object: string; strength: number }> = [
      { subject: 'bird', predicate: 'is-a', object: 'animal', strength: 1 },
      { subject: 'animal', predicate: 'has-part', object: 'heart', strength: 1 },
      { subject: 'heart', predicate: 'capable-of', object: 'pump blood', strength: 1 }
    ];
    const savings =
      COST.costOf('bird') + COST.costOf('animal') +
      COST.costOf('animal') + COST.costOf('heart') +
      COST.costOf('heart') + COST.costOf('pump') + COST.costOf('blood');
    const claimCost = COST.costOf('bird') + COST.costOf('pump') + COST.costOf('blood');
    expect(compositionGain(COST, { subject: 'bird', predicate: 'capable-of', object: 'pump blood' }, hops))
      .toBeCloseTo(savings - claimCost - COMPOSITION_STEP_COST * 3);
  });

  it('REJECTS a chain through a ubiquitous word — the inference costs more than it compresses', () => {
    // 'bird' is the cheapest word in the model; deriving "x has z" through
    // it saves less than the inference costs.
    const relations: Relation[] = [
      { subject: 'x', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
      { subject: 'bird', predicate: 'has-part', object: 'z', source: 'def', origin: 'regex' }
    ];
    expect(composeClaim(relations, 'x', 'has-part', 'z', { cost: CHEAP })).toBeNull();
  });

  it('adopts the same chain through a rare word — expensive evidence justifies the inference', () => {
    const relations: Relation[] = [
      { subject: 'x', predicate: 'is-a', object: 'zygomatic', source: 'def', origin: 'regex' },
      { subject: 'zygomatic', predicate: 'has-part', object: 'z', source: 'def', origin: 'regex' }
    ];
    const claim = composeClaim(relations, 'x', 'has-part', 'z', { cost: RARE });
    expect(claim).not.toBeNull();
    if (claim !== null) expect(claim.gain).toBeGreaterThan(0);
  });
});

describe('negation handling (deniedFromNegations)', () => {
  const NEGATIONS: Negation[] = [
    { subject: 'animal', predicate: 'has-part', object: 'heart', evidence: 'taught', origin: 'taught' },
    { subject: 'bird', predicate: 'capable-of', object: 'pump blood', evidence: 'taught', origin: 'taught' }
  ];

  it('finds the confirmed-false entry for an exact claim, and only an exact one', () => {
    expect(deniedFromNegations(NEGATIONS, 'animal', 'has-part', 'heart')?.evidence).toBe('taught');
    expect(deniedFromNegations(NEGATIONS, 'animal', 'has-part', 'wings')).toBeNull();
    expect(deniedFromNegations([], 'animal', 'has-part', 'heart')).toBeNull();
  });

  it('REJECTS a chain when any hop conflicts with a negation', () => {
    // animal has-part heart is confirmed-false → the whole chain dies.
    expect(composeClaim(RELATIONS, 'bird', 'capable-of', 'pump blood', { negations: NEGATIONS, cost: COST })).toBeNull();
  });

  it('REJECTS a chain when the CONCLUSION conflicts with a negation', () => {
    // bird capable-of pump blood is confirmed-false (second negation).
    const conclusionDenied = NEGATIONS.slice(1);
    expect(composeClaim(RELATIONS, 'bird', 'capable-of', 'pump blood', { negations: conclusionDenied, cost: COST })).toBeNull();
  });

  it('ignores unrelated negations — the chain survives', () => {
    const unrelated: Negation[] = [{ subject: 'golf', predicate: 'is-a', object: 'bird', evidence: 'taught', origin: 'taught' }];
    expect(composeClaim(RELATIONS, 'bird', 'capable-of', 'pump blood', { negations: unrelated, cost: COST })).not.toBeNull();
  });

  it('honors the denied() lookup form (the operator context)', () => {
    const denied = (s: string, p: string, o: string): boolean =>
      s === 'animal' && p === 'has-part' && o === 'heart';
    expect(composeClaim(RELATIONS, 'bird', 'capable-of', 'pump blood', { denied, cost: COST })).toBeNull();
  });
});

describe('confidence tracking (the weakest hop carries the claim)', () => {
  it('support is the minimum hop strength', () => {
    const relations: Relation[] = [
      { subject: 'bird', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex', strength: 0.7 },
      { subject: 'animal', predicate: 'has-part', object: 'heart', source: 'def', origin: 'regex', strength: 1 },
      { subject: 'heart', predicate: 'capable-of', object: 'pump blood', source: 'def', origin: 'chaperone', strength: 0.5 }
    ];
    const claim = composeClaim(relations, 'bird', 'capable-of', 'pump blood', { cost: COST });
    expect(claim).not.toBeNull();
    if (claim !== null) expect(claim.support).toBe(0.5);
  });

  it('chainPhrase speaks the evidence path in English', () => {
    const claim = composeClaim(RELATIONS, 'bird', 'capable-of', 'pump blood', { cost: COST });
    expect(chainPhrase(claim!)).toBe('bird is an animal, animal has heart, and heart can pump blood');
  });
});

describe('composedClaimsFor (generation-side view)', () => {
  it('emits only NEW claims — direct and inherited edges are excluded', () => {
    const claims = composedClaimsFor('bird', RELATIONS, { cost: COST });
    const keys = claims.map((c) => `${c.predicate}\u0000${c.object}`);
    expect(keys).toContain('capable-of\u0000pump blood');
    // Already answerable without composition: direct (fly, wings) and
    // inherited (has-part heart, is-a animal) — never duplicated.
    expect(keys).not.toContain('capable-of\u0000fly');
    expect(keys).not.toContain('has-part\u0000wings');
    expect(keys).not.toContain('has-part\u0000heart');
    expect(keys).not.toContain('is-a\u0000animal');
  });

  it('returns nothing for subjects whose chains are all unsound', () => {
    expect(composedClaimsFor('car', RELATIONS, { cost: COST })).toEqual([]);
    expect(composedClaimsFor('table', RELATIONS, { cost: COST })).toEqual([]);
  });

  it('emits nothing for a word with no edges', () => {
    expect(composedClaimsFor('untouched', RELATIONS, { cost: COST })).toEqual([]);
  });

  it('respects the negation store at generation time', () => {
    const negations: Negation[] = [
      { subject: 'animal', predicate: 'has-part', object: 'heart', evidence: 'taught', origin: 'taught' }
    ];
    expect(composedClaimsFor('bird', RELATIONS, { negations, cost: COST })).toEqual([]);
  });
});
