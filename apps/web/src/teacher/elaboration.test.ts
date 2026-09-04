/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { isATypeOf } from './chain';
import { criticize } from './groundedFrames';
import { TokenCostModel } from './mdl';
import { elaborate, MARGINAL_SCORE_FLOOR } from './elaboration';
import type { Negation, Relation } from './relations';

const ANIMALS: Relation[] = [
  { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex', strength: 1.4 },
  { subject: 'robin', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex', strength: 0.9 },
  { subject: 'robin', predicate: 'has-part', object: 'beak', source: 'def', origin: 'regex', strength: 1.2 },
  { subject: 'bird', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex', strength: 1.4 },
  { subject: 'bird', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex', strength: 1.2 },
  { subject: 'bird', predicate: 'has-part', object: 'feathers', source: 'def', origin: 'regex', strength: 1.0 },
  { subject: 'bird', predicate: 'capable-of', object: 'fly', source: 'def', origin: 'chaperone', strength: 1.1 },
  { subject: 'wings', predicate: 'used-for', object: 'flight', source: 'def', origin: 'chaperone', strength: 0.7 },
  { subject: 'feathers', predicate: 'made-of', object: 'keratin', source: 'def', origin: 'chaperone', strength: 0.8 }
];

const STOP_REASONS = ['score-floor', 'hypothesis-only', 'flat-entropy', 'frontier-empty'] as const;

describe('elaboration-bench (§8.5)', () => {
  it('0 fabrications at every depth; the §8 stop fires, not the depth budget', () => {
    for (const subject of ['robin', 'bird', 'feathers']) {
      for (const maxClaims of [8, 16, 24]) {
        const result = elaborate(subject, ANIMALS, { maxClaims });
        // The stopping criterion engages — the claim-count safety bound
        // (a §5 safety bound, never a depth budget) does not fire.
        expect(STOP_REASONS).toContain(result.stopReason);
        expect(result.claims.length).toBeLessThan(maxClaims);
        // Every spoken claim passes the critic on its own named sentence —
        // 0 fabrications at this depth.
        for (const claim of result.claims) {
          expect(criticize(claim.sentence, ANIMALS, []).grounded).toBe(true);
        }
        // Every cited edge exists in the graph.
        for (const edge of result.citedEdges) {
          expect(
            ANIMALS.some((r) => r.subject === edge.subject && r.predicate === edge.predicate && r.object === edge.object)
          ).toBe(true);
        }
      }
    }
  });

  it('redundancy falls as the stopping criterion engages (the gate refuses inheritable claims)', () => {
    // "A robin is an animal" is inheritable from the spoken "A bird is an
    // animal" through the spoken "A robin is a bird" — redundant by §8.1.
    const REDUNDANT: Relation[] = [
      { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex', strength: 1.2 },
      { subject: 'robin', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex', strength: 0.9 },
      { subject: 'bird', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex', strength: 1.4 }
    ];
    const redundancyOf = (result: { claims: Array<{ subject: string; predicate: string; object: string }> }): number => {
      let redundant = 0;
      for (let i = 0; i < result.claims.length; i += 1) {
        const claim = result.claims[i];
        for (let j = 0; j < i; j += 1) {
          const earlier = result.claims[j];
          if (claim.subject === earlier.subject) continue;
          if (claim.predicate !== earlier.predicate || claim.object !== earlier.object) continue;
          if (isATypeOf(REDUNDANT, claim.subject, earlier.subject)) {
            redundant += 1;
            break;
          }
        }
      }
      return redundant;
    };

    const withGate = elaborate('robin', REDUNDANT);
    expect(withGate.stopReason).not.toBe('safety-cap');
    expect(withGate.redundantSkipped).toContain('A robin is an animal.');
    expect(withGate.claims.some((c) => c.subject === 'robin' && c.predicate === 'is-a' && c.object === 'animal')).toBe(false);

    const withoutGate = elaborate('robin', REDUNDANT, { redundancyCheck: false });
    expect(redundancyOf(withGate)).toBe(0);
    expect(redundancyOf(withoutGate)).toBeGreaterThan(0);
    expect(redundancyOf(withGate)).toBeLessThan(redundancyOf(withoutGate));
  });

  it('the three §8.1 stops fire: score floor, hypothesis-only frontier, flat entropy', () => {
    const FLOOR: Relation[] = [
      { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex', strength: 1.0 },
      { subject: 'bird', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex', strength: 0.5 }
    ];
    const floor = elaborate('robin', FLOOR);
    expect(floor.stopReason).toBe('score-floor');
    expect(floor.bestRemainingScore).toBe(0.5);
    expect(floor.bestRemainingScore!).toBeLessThan(MARGINAL_SCORE_FLOOR);

    const HYPOTHESIS: Relation[] = [
      { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex', strength: 1.0 },
      { subject: 'bird', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex', strength: 1.0 },
      { subject: 'animal', predicate: 'is-a', object: 'creature', source: 'def', origin: 'chaperone', strength: 1.0, tier: 'hypothesis' },
      { subject: 'animal', predicate: 'has-part', object: 'heart', source: 'def', origin: 'chaperone', strength: 0.9, tier: 'hypothesis' }
    ];
    const hypothesis = elaborate('robin', HYPOTHESIS);
    expect(hypothesis.stopReason).toBe('hypothesis-only');
    expect(hypothesis.claims.some((c) => c.subject === 'animal')).toBe(false);

    const FLAT: Relation[] = [
      { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex', strength: 1.0 },
      { subject: 'bird', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex', strength: 1.0 },
      { subject: 'bird', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex', strength: 1.0 }
    ];
    const flat = elaborate('robin', FLAT);
    expect(flat.stopReason).toBe('flat-entropy');
    expect(flat.frontierEntropyAtStop).toBe(1);
  });

  it('the cumulative grounding product is surfaced for the deviation meter (§8.2)', () => {
    const WEAKENED: Relation[] = [
      { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex', strength: 1.0 },
      { subject: 'bird', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex', strength: 0.7 }
    ];
    const result = elaborate('robin', WEAKENED);
    expect(result.groundingProduct).toBeGreaterThan(0);
    expect(result.groundingProduct).toBeLessThan(1);
    // The product IS the product of the per-claim grounding scores.
    const product = result.claims.reduce((acc, claim) => acc * claim.grounding, 1);
    expect(result.groundingProduct).toBeCloseTo(product, 6);
    for (const claim of result.claims) {
      expect(claim.grounding).toBeGreaterThan(0);
      expect(claim.grounding).toBeLessThanOrEqual(1);
    }
  });

  it('grounded-only recursion: a composed claim is a LEAF, never expanded from', () => {
    const COMPOSED_RELATIONS: Relation[] = [
      { subject: 'bird', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex', strength: 1.2 },
      { subject: 'animal', predicate: 'has-part', object: 'heart', source: 'def', origin: 'regex', strength: 1.2 },
      { subject: 'heart', predicate: 'capable-of', object: 'pump blood', source: 'def', origin: 'chaperone', strength: 1.0 },
      { subject: 'animal', predicate: 'has-part', object: 'muscle', source: 'def', origin: 'regex', strength: 0.7 }
    ];
    const COST = new TokenCostModel([
      'bird', 'animal', 'heart', 'pump', 'blood', 'muscle',
      ...COMPOSED_RELATIONS.flatMap((r) => [r.subject, r.object])
    ]);
    const result = elaborate('bird', COMPOSED_RELATIONS, { cost: COST });
    const composed = result.claims.find((c) => c.backing === 'composed');
    expect(composed).toBeDefined();
    expect(composed!.subject).toBe('bird');
    expect(composed!.predicate).toBe('capable-of');
    expect(composed!.object).toBe('pump blood');
    expect(composed!.leaf).toBe(true);
    // Composed output never seeds the frontier: no claim is ever about the
    // composed claim's object.
    expect(result.claims.some((c) => c.subject === 'pump blood')).toBe(false);
    // Every claim passes the critic (0 fabrications).
    for (const claim of result.claims) {
      expect(criticize(claim.sentence, COMPOSED_RELATIONS, [], { cost: COST }).grounded).toBe(true);
    }
  });

  it('related topics are a labeled coda, never woven into the claims', () => {
    const SIBLINGS: Relation[] = [
      { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex', strength: 1.0 },
      { subject: 'sparrow', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex', strength: 1.0 },
      { subject: 'crow', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex', strength: 1.0 },
      { subject: 'bird', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex', strength: 1.0 },
      { subject: 'robin', predicate: 'has-part', object: 'beak', source: 'def', origin: 'regex', strength: 1.0 },
      { subject: 'toucan', predicate: 'has-part', object: 'beak', source: 'def', origin: 'regex', strength: 1.0 }
    ];
    const result = elaborate('robin', SIBLINGS);
    expect(result.related).toContain('sparrow');
    expect(result.related).toContain('crow');
    expect(result.related).toContain('toucan');
    expect(result.coda).toMatch(/^Related: /);
    expect(result.text.endsWith(result.coda)).toBe(true);
    for (const claim of result.claims) {
      expect(claim.sentence).not.toMatch(/sparrow|crow|toucan/);
    }
  });

  it('the confirmed-false store vetoes claims at every hop (honesty contract)', () => {
    const PENGUIN: Relation[] = [
      { subject: 'penguin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex', strength: 1.0 },
      { subject: 'bird', predicate: 'capable-of', object: 'fly', source: 'def', origin: 'regex', strength: 1.0 },
      { subject: 'bird', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex', strength: 1.0 }
    ];
    const NEGATIONS: Negation[] = [
      { subject: 'penguin', predicate: 'capable-of', object: 'fly', evidence: 'a penguin cannot fly', origin: 'taught' }
    ];
    const result = elaborate('penguin', PENGUIN, { negations: NEGATIONS });
    // The negated claim is never spoken about the penguin itself.
    expect(result.claims.some((c) => c.subject === 'penguin' && c.predicate === 'capable-of' && c.object === 'fly')).toBe(false);
    for (const claim of result.claims) {
      expect(criticize(claim.sentence, PENGUIN, NEGATIONS).grounded).toBe(true);
    }
  });
});
