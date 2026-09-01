/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { isATypeOf, inheritsPart, inheritsEdge } from './chain';
import { TokenCostModel } from './mdl';
import { DECK_100 } from './decks/en-100';
import { applyOperator, type OperatorContext } from './operators';
import type { Relation, RelationPredicate } from './relations';

const RELATIONS: Relation[] = [
  { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'a small bird', origin: 'regex' },
  { subject: 'bird', predicate: 'is-a', object: 'animal', source: 'a warm-blooded animal', origin: 'regex' },
  { subject: 'bird', predicate: 'has-part', object: 'wings', source: 'a creature with wings', origin: 'regex' },
  { subject: 'golf', predicate: 'is-a', object: 'game', source: 'a game played with a ball', origin: 'regex' },
  { subject: 'game', predicate: 'has-part', object: 'rules', source: 'a contest with rules', origin: 'regex' }
];

describe('operator chaining (reasoning as a walk over relations)', () => {
  it('isATypeOf follows transitive is-a chains', () => {
    expect(isATypeOf(RELATIONS, 'robin', 'bird')).toBe(true);
    expect(isATypeOf(RELATIONS, 'robin', 'animal')).toBe(true); // robin -> bird -> animal
    expect(isATypeOf(RELATIONS, 'robin', 'robin')).toBe(true);
    expect(isATypeOf(RELATIONS, 'robin', 'golf')).toBe(false);
  });

  it('inheritsPart finds parts through is-a ancestors', () => {
    // Direct: bird has wings.
    expect(inheritsPart(RELATIONS, 'bird', 'wings')).toBeNull(); // direct edge — no chain needed
    // Inherited: robin is-a bird, bird has wings.
    expect(inheritsPart(RELATIONS, 'robin', 'wings')).toEqual({ via: 'bird' });
    // Not present anywhere: no chain, honest null.
    expect(inheritsPart(RELATIONS, 'robin', 'rules')).toBeNull();
  });

  it('bounded depth prevents infinite loops on cyclic is-a graphs', () => {
    const cyclic: Relation[] = [
      { subject: 'a', predicate: 'is-a', object: 'b', source: '', origin: 'regex' },
      { subject: 'b', predicate: 'is-a', object: 'a', source: '', origin: 'regex' }
    ];
    expect(isATypeOf(cyclic, 'a', 'c')).toBe(false);
    expect(inheritsPart(cyclic, 'a', 'missing')).toBeNull();
  });
});

/**
 * MULTI-PREDICATE COMPOSITION BENCHMARK (P10) — an extension of the chaining
 * benchmark, measured on the SAME probe set with and without composition.
 *
 * The baseline is the PRE-CHANGE single-predicate machinery: a probe is
 * answerable iff a stored edge states it directly or an is-a inheritance
 * walk reaches it (inheritsEdge). The composed path adds sound multi-
 * predicate chains (is-a → has-part → capable-of ...) gated by the MDL
 * criterion and the negation store. The probes are fixed and hand-labeled;
 * the honesty contract is that FALSE probes must never gain an answer —
 * unsound sequences ("is a wheel a car" via car has-part wheel) must stay
 * declined under BOTH paths.
 */
describe('multi-predicate composition benchmark (is-a → has-part → capable-of)', () => {
  const GRAPH: Relation[] = [
    { subject: 'bird', predicate: 'is-a', object: 'animal', source: 'def', origin: 'regex' },
    { subject: 'animal', predicate: 'has-part', object: 'heart', source: 'def', origin: 'regex' },
    { subject: 'heart', predicate: 'capable-of', object: 'pump', source: 'def', origin: 'chaperone' },
    { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
    { subject: 'bird', predicate: 'capable-of', object: 'fly', source: 'def', origin: 'chaperone' },
    { subject: 'bird', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
    { subject: 'car', predicate: 'has-part', object: 'wheel', source: 'def', origin: 'regex' },
    { subject: 'wheel', predicate: 'made-of', object: 'rubber', source: 'def', origin: 'regex' },
    { subject: 'wheel', predicate: 'is-a', object: 'part', source: 'def', origin: 'regex' }
  ];
  const MODEL = new TokenCostModel([
    ...GRAPH.flatMap((r) => [r.subject, r.object]),
    ...DECK_100.map((entry) => entry.word)
  ]);

  interface Probe {
    ask: string;
    subject: string;
    predicate: RelationPredicate;
    object: string;
    expected: boolean;
    /** The answer requires composition — the baseline is silent on it. */
    composedOnly: boolean;
  }
  const PROBES: Probe[] = [
    { ask: 'can a bird pump', subject: 'bird', predicate: 'capable-of', object: 'pump', expected: true, composedOnly: true },
    { ask: 'can a robin pump', subject: 'robin', predicate: 'capable-of', object: 'pump', expected: true, composedOnly: true },
    { ask: 'can a robin fly', subject: 'robin', predicate: 'capable-of', object: 'fly', expected: true, composedOnly: false },
    { ask: 'does a robin have a heart', subject: 'robin', predicate: 'has-part', object: 'heart', expected: true, composedOnly: false },
    { ask: 'does a bird have wings', subject: 'bird', predicate: 'has-part', object: 'wings', expected: true, composedOnly: false },
    { ask: 'is a bird an animal', subject: 'bird', predicate: 'is-a', object: 'animal', expected: true, composedOnly: false },
    { ask: 'is a bird a muscle', subject: 'bird', predicate: 'is-a', object: 'muscle', expected: false, composedOnly: false },
    { ask: 'does a bird have a wheel', subject: 'bird', predicate: 'has-part', object: 'wheel', expected: false, composedOnly: false },
    // Unsound-direction probes: car has-part wheel must never license
    // "is a wheel a car", and wheel made-of rubber never "does a car have
    // rubber" — the composed path must stay as silent as the baseline.
    { ask: 'is a wheel a car', subject: 'wheel', predicate: 'is-a', object: 'car', expected: false, composedOnly: false },
    { ask: 'does a car have a rubber', subject: 'car', predicate: 'has-part', object: 'rubber', expected: false, composedOnly: false }
  ];

  const ctx: OperatorContext = {
    isTaught: () => true,
    definitionOf: () => '',
    wordCount: () => GRAPH.length,
    phraseCount: () => 0,
    relations: () => GRAPH,
    compositionCost: MODEL
  };

  /** The PRE-CHANGE baseline: direct edge or is-a inheritance only. */
  function baselineAnswerable(probe: Probe): boolean {
    return (
      GRAPH.some(
        (r) => r.subject === probe.subject && r.predicate === probe.predicate && r.object === probe.object
      ) || inheritsEdge(GRAPH, probe.subject, probe.predicate, probe.object) !== null
    );
  }

  it('answers the composed probes and declines the unsound ones', () => {
    const birdPump = applyOperator('can a bird pump', ctx);
    expect(birdPump).not.toBeNull();
    if (birdPump?.kind === 'composed') {
      expect(birdPump.hops.map((h) => h.predicate)).toEqual(['is-a', 'has-part', 'capable-of']);
      expect(birdPump.answer).toBe('Yes — bird is an animal, animal has heart, and heart can pump.');
    }
    expect(applyOperator('is a wheel a car', ctx)).toBeNull();
    expect(applyOperator('does a car have a rubber', ctx)).toBeNull();
    expect(applyOperator('is a bird a muscle', ctx)).toBeNull();
    expect(applyOperator('does a bird have a wheel', ctx)).toBeNull();
  });

  it('BENCH: composed-answer correctness beats the single-predicate baseline on the same probes', () => {
    let baselineCorrect = 0;
    let composedCorrect = 0;
    const baselineMisses: string[] = [];
    const composedMisses: string[] = [];
    for (const probe of PROBES) {
      const baseline = baselineAnswerable(probe);
      if (baseline === probe.expected) baselineCorrect += 1;
      else baselineMisses.push(probe.ask);
      const answered = applyOperator(probe.ask, ctx) !== null;
      if (answered === probe.expected) composedCorrect += 1;
      else composedMisses.push(probe.ask);
    }
    const baselineAccuracy = baselineCorrect / PROBES.length;
    const composedAccuracy = composedCorrect / PROBES.length;
    // eslint-disable-next-line no-console
    console.log(
      `\nBENCH composition: baseline ${(baselineAccuracy * 100).toFixed(0)}% (${baselineCorrect}/${PROBES.length}) vs composed ${(composedAccuracy * 100).toFixed(0)}% (${composedCorrect}/${PROBES.length}) on ${PROBES.length} novel relational probes`
    );
    // eslint-disable-next-line no-console
    console.log(`BENCH composition: baseline misses ${baselineMisses.join(', ') || 'none'}`);
    // eslint-disable-next-line no-console
    console.log(`BENCH composition: composed misses ${composedMisses.join(', ') || 'none'}`);

    // The composed path never answers LESS than the baseline, and the
    // composed-only probes (the new inferences) are the whole delta.
    expect(composedCorrect).toBeGreaterThanOrEqual(baselineCorrect);
    expect(baselineMisses).toEqual(['can a bird pump', 'can a robin pump']);
    // CI floor: full correctness on the fixed probe set, including the
    // requirement that unsound sequences stay declined.
    expect(composedAccuracy).toBe(1);
  });
});