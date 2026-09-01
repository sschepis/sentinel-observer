/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { mulberry32 } from '@sschepis/sentient-core';
import { TokenCostModel } from './mdl';
import {
  framesFor,
  composeGrounded,
  criticize,
  parseClaims,
  groundedSubjects,
  contentWordsOf
} from './groundedFrames';
import type { Relation, Negation } from './relations';

const RELATIONS: Relation[] = [
  { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
  { subject: 'bird', predicate: 'is-a', object: 'creature', source: 'def', origin: 'regex' },
  { subject: 'bird', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
  { subject: 'bird', predicate: 'has-part', object: 'feathers', source: 'def', origin: 'regex' },
  { subject: 'bird', predicate: 'capable-of', object: 'fly', source: 'def', origin: 'chaperone' },
  { subject: 'snow', predicate: 'has-property', object: 'cold', source: 'def', origin: 'chaperone' },
  { subject: 'snow', predicate: 'has-property', object: 'wet', source: 'def', origin: 'chaperone' },
  { subject: 'hammer', predicate: 'used-for', object: 'nails', source: 'def', origin: 'chaperone' },
  { subject: 'table', predicate: 'made-of', object: 'wood', source: 'def', origin: 'chaperone' }
];

describe('grounded frames (P5)', () => {
  it('builds frames only from stored edges', () => {
    const robin = framesFor('robin', RELATIONS);
    expect(robin[0]).toBe('A robin is a bird.');
    expect(robin).toContain('It has wings and feathers.');
    expect(robin).toContain('It can fly.');

    const snow = framesFor('snow', RELATIONS);
    expect(snow[0]).toBe('A snow is cold and wet.');
    // A word with no edges has no frames.
    expect(framesFor('untouched', RELATIONS)).toEqual([]);
  });

  it('groundedSubjects returns only words with fillable frames', () => {
    expect(groundedSubjects(['robin', 'snow', 'zzz'], RELATIONS)).toEqual(['robin', 'snow']);
  });

  it('composeGrounded produces an edge-backed sentence deterministically per seed', () => {
    const a = composeGrounded(['robin', 'snow'], RELATIONS, mulberry32(7));
    const b = composeGrounded(['robin', 'snow'], RELATIONS, mulberry32(7));
    expect(a).not.toBeNull();
    expect(a!.sentence).toBe(b!.sentence);
    expect(a!.edges.length).toBeGreaterThan(0);
    // Every edge the composition cites exists in the graph.
    for (const edge of a!.edges) {
      expect(
        RELATIONS.some((r) => r.subject === edge.subject && r.predicate === edge.predicate && r.object === edge.object)
      ).toBe(true);
    }
    // No fillable subject -> null (the labeled fallback takes over).
    expect(composeGrounded(['zzz', 'qqq'], RELATIONS, mulberry32(1))).toBeNull();
  });

  it('the critic accepts a grounded composition', () => {
    const verdict = criticize('A robin is a bird. It has wings and feathers. It can fly.', RELATIONS, []);
    expect(verdict.grounded).toBe(true);
    expect(verdict.edges.length).toBeGreaterThanOrEqual(3);
  });

  it('the critic refuses any claim not backed by a stored edge', () => {
    const verdict = criticize('A robin is a bird. It can sing opera.', RELATIONS, []);
    expect(verdict.grounded).toBe(false);
    expect(verdict.unbacked.some((u) => u.includes('sing opera'))).toBe(true);
  });

  it('the critic refuses an unparseable sentence (no resolvable subject)', () => {
    const verdict = criticize('The quick brown fox jumps.', RELATIONS, []);
    expect(verdict.grounded).toBe(false);
  });

  it('the critic accepts a negated claim only when the falsehood is confirmed', () => {
    const negations: Negation[] = [{ subject: 'robin', predicate: 'is-a', object: 'mammal', evidence: 'taught', origin: 'taught' }];
    const refused = criticize('A robin is not a mammal. It can fly.', RELATIONS, []);
    expect(refused.grounded).toBe(false);
    const accepted = criticize('A robin is not a mammal. It can fly.', RELATIONS, negations);
    expect(accepted.grounded).toBe(true);
  });

  it('inherited edges back claims (robin is-a bird, bird has-part wings)', () => {
    const verdict = criticize('A robin is a bird. It has wings.', RELATIONS, []);
    expect(verdict.grounded).toBe(true);
  });

  it('the critic parses FIRST-FRAME variants of every clause type (H-review)', () => {
    // Previously only the is-a first frame parsed: the wings claim in a
    // two-frame sentence was silently skipped (wrong grades then weakened
    // only the parseable frames) and single non-is-a frames were rejected.
    const has = criticize('A robin has wings and feathers.', RELATIONS, []);
    expect(has.grounded).toBe(true);
    expect(has.edges.length).toBe(2);

    const can = criticize('A robin can fly.', RELATIONS, []);
    expect(can.grounded).toBe(true);

    const property = criticize('A snow is cold and wet.', RELATIONS, []);
    expect(property.grounded).toBe(true);
    expect(property.edges.length).toBe(2);

    const usedFor = criticize('A hammer is used for nails.', RELATIONS, []);
    expect(usedFor.grounded).toBe(true);

    const madeOf = criticize('A table is made of wood.', RELATIONS, []);
    expect(madeOf.grounded).toBe(true);

    // The negated first frame still parses as a NEGATED is-a claim, not as
    // a property claim ("is not a mammal" must not read as property
    // "not a mammal").
    const negated = criticize('A robin is not a mammal.', RELATIONS, []);
    expect(negated.grounded).toBe(false); // refused (unconfirmed) — but parsed
  });

  it('a SINGLE non-is-a frame composes grounded (no Markov demotion)', () => {
    // The composition of exactly one property frame used to return no
    // claims → the critic declared it ungrounded → creativeReply demoted it
    // to the Markov fallback (subjects without an is-a parent never got a
    // grounded answer).
    const frames = composeGrounded(['snow'], RELATIONS, mulberry32(3), 1);
    expect(frames).not.toBeNull();
    if (frames !== null) {
      expect(frames.edges.length).toBeGreaterThan(0);
    }
  });

  it('parseClaims resolves "It" clauses to the frame subject', () => {
    const claims = parseClaims('A robin is a bird. It has wings and feathers.', 'robin');
    expect(claims).toHaveLength(3);
    expect(claims[0]).toEqual({ subject: 'robin', predicate: 'is-a', object: 'bird', negated: false });
    expect(claims[1]).toEqual({ subject: 'robin', predicate: 'has-part', object: 'wings', negated: false });
  });

  it('contentWordsOf extracts the fabrication lens', () => {
    expect(contentWordsOf('A robin is a bird. It can fly.')).toEqual(['robin', 'bird', 'fly']);
  });
});

describe('exception-aware grounded generation (negations propagate)', () => {
  const PENGUIN: Relation[] = [
    { subject: 'penguin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
    { subject: 'bird', predicate: 'capable-of', object: 'fly', source: 'def', origin: 'regex' },
    { subject: 'bird', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' }
  ];
  const NEGATIONS: Negation[] = [
    { subject: 'penguin', predicate: 'capable-of', object: 'fly', evidence: 'a penguin cannot fly', origin: 'taught' }
  ];

  it('the critic refuses a positive claim the confirmed-false store contradicts', () => {
    // Inherited via bird — grounded without the negation…
    expect(criticize('A penguin is a bird. It can fly.', PENGUIN, []).grounded).toBe(true);
    // …refused with it: a taught falsehood outranks extraction.
    const verdict = criticize('A penguin is a bird. It can fly.', PENGUIN, NEGATIONS);
    expect(verdict.grounded).toBe(false);
    expect(verdict.unbacked.some((u) => u.includes('fly'))).toBe(true);
  });

  it('composeGrounded never fills a frame with negated content', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const grounded = composeGrounded(['penguin'], PENGUIN, mulberry32(seed), 3, NEGATIONS);
      expect(grounded).not.toBeNull();
      expect(grounded!.sentence).not.toMatch(/fly/);
      expect(grounded!.edges.length).toBeGreaterThan(0);
    }
  });
});

describe('multi-predicate composed frames (P10 — is-a → has-part → capable-of)', () => {
  // The canonical chain: bird is-a animal, animal has-part heart, heart
  // capable-of pump blood ⇒ "A bird can pump blood."
  const COMPOSED_RELATIONS: Relation[] = [
    { subject: 'bird', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex' },
    { subject: 'animal', predicate: 'has-part', object: 'heart', source: 'def', origin: 'regex' },
    { subject: 'heart', predicate: 'capable-of', object: 'pump blood', source: 'def', origin: 'chaperone' },
    { subject: 'animal', predicate: 'has-part', object: 'muscle', source: 'def', origin: 'regex' }
  ];
  const COST = new TokenCostModel([
    'bird', 'animal', 'heart', 'pump', 'blood', 'muscle',
    ...COMPOSED_RELATIONS.flatMap((r) => [r.subject, r.object])
  ]);

  it('framesFor emits the composed claim no single edge states', () => {
    const frames = framesFor('bird', COMPOSED_RELATIONS, { cost: COST });
    expect(frames).toContain('A bird can pump blood.');
    // A claim a single edge already answers (animal has-part heart via
    // inheritance) is never duplicated as a composed frame.
    expect(frames.filter((f) => f === 'A bird has heart.')).toHaveLength(0);
  });

  it('composeGrounded produces the composed sentence and the critic parses it back', () => {
    const composed = composeGrounded(['bird'], COMPOSED_RELATIONS, mulberry32(5), 3, { cost: COST });
    expect(composed).not.toBeNull();
    if (composed !== null) {
      expect(composed.sentence).toContain('A bird can pump blood.');
      expect(composed.edges.length).toBeGreaterThan(0);
      // The composed claim's evidence is its STORED hops — the derived
      // (bird, capable-of, pump blood) claim is never cited as an edge.
      for (const hop of [
        { subject: 'bird', predicate: 'is-a', object: 'animal' },
        { subject: 'animal', predicate: 'has-part', object: 'heart' },
        { subject: 'heart', predicate: 'capable-of', object: 'pump blood' }
      ]) {
        expect(
          composed.edges.some((e) => e.subject === hop.subject && e.predicate === hop.predicate && e.object === hop.object)
        ).toBe(true);
      }
    }
  });

  it('the critic accepts the composed claim as grounded, citing the chain hops', () => {
    const verdict = criticize('A bird can pump blood.', COMPOSED_RELATIONS, [], { cost: COST });
    expect(verdict.grounded).toBe(true);
    expect(verdict.edges).toEqual([
      { subject: 'bird', predicate: 'is-a', object: 'animal' },
      { subject: 'animal', predicate: 'has-part', object: 'heart' },
      { subject: 'heart', predicate: 'capable-of', object: 'pump blood' }
    ]);
  });

  it('the critic refuses a composed claim whose chain conflicts with a negation', () => {
    const negations: Negation[] = [
      { subject: 'animal', predicate: 'has-part', object: 'heart', evidence: 'taught', origin: 'taught' }
    ];
    const verdict = criticize('A bird can pump blood.', COMPOSED_RELATIONS, negations, { cost: COST });
    expect(verdict.grounded).toBe(false);
    expect(verdict.unbacked.some((u) => u.includes('pump blood'))).toBe(true);
  });

  it('the critic refuses an UNSOUND composition — a part being a thing never makes the whole that thing', () => {
    // animal has-part muscle must not license "A bird is a muscle."
    const verdict = criticize('A bird is a muscle.', COMPOSED_RELATIONS, [], { cost: COST });
    expect(verdict.grounded).toBe(false);
  });

  it('parseClaims resolves the multi-word object of the composed frame', () => {
    const claims = parseClaims('A bird can pump blood.', 'bird');
    expect(claims).toEqual([
      { subject: 'bird', predicate: 'capable-of', object: 'pump blood', negated: false }
    ]);
  });

  it('composed subjects are grounded subjects even without direct frames', () => {
    // 'robin' has no edges of its own, but inherits a sound chain through
    // its is-a parent — the composed claim makes it a composable subject.
    const withRobin: Relation[] = [
      ...COMPOSED_RELATIONS,
      { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' }
    ];
    expect(groundedSubjects(['robin'], withRobin)).toContain('robin');
    const frames = framesFor('robin', withRobin, { cost: COST });
    expect(frames).toContain('A robin can pump blood.');
    const verdict = criticize('A robin can pump blood.', withRobin, [], { cost: COST });
    expect(verdict.grounded).toBe(true);
  });

  it('the critic refuses a composed claim when the MDL gate fails (composition is not free)', () => {
    // "A x has z" through the graph's CHEAPEST word compresses less than the
    // inference costs — the critic must not back it even though the chain is
    // structurally sound.
    const cheapGraph: Relation[] = [
      { subject: 'x', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
      { subject: 'bird', predicate: 'has-part', object: 'z', source: 'def', origin: 'regex' }
    ];
    const verdict = criticize('A x has z.', cheapGraph, []);
    expect(verdict.grounded).toBe(false);
  });

  it('the default graph-derived model keeps the canonical composition grounded', () => {
    const verdict = criticize('A bird can pump blood.', COMPOSED_RELATIONS, []);
    expect(verdict.grounded).toBe(true);
  });
});
