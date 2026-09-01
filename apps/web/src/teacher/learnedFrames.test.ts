/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { mulberry32 } from '@sschepis/sentient-core';
import {
  LearnedFrameStore,
  MIN_EVIDENCE,
  renderTemplate,
  fixedFrames,
  framesFor,
  listPhrase,
  type HoleTemplate
} from './learnedFrames';
import { composeGrounded, criticize } from './groundedFrames';
import { templateAcceptanceBench } from './templateAcceptance';
import type { Negation, Relation } from './relations';

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

const NEVER_DENIED = (): boolean => false;

describe('fixed seed templates (P5 generalization)', () => {
  it('renders byte-for-byte what the original fixed frames produced', () => {
    expect(framesFor('robin', RELATIONS)).toEqual([
      'A robin is a bird.',
      'It has wings and feathers.',
      'It can fly.'
    ]);
    expect(framesFor('snow', RELATIONS)).toEqual(['A snow is cold and wet.', 'It is cold and wet.']);
    expect(framesFor('hammer', RELATIONS)).toEqual(['A hammer is used for nails.', 'It is used for nails.']);
    expect(framesFor('table', RELATIONS)).toEqual(['A table is made of wood.', 'It is made of wood.']);
    expect(framesFor('untouched', RELATIONS)).toEqual([]);
  });

  it('carries stable fixed ids and the requiresParent quirk (It has ... only with a parent)', () => {
    const robin = fixedFrames('robin', RELATIONS);
    expect(robin[0].id).toBe('fixed:is-a');
    expect(robin[1].id).toBe('fixed:it-has-part');
    // snow has parts? no — has-property only; and no parent, so no it-has-part.
    const snow = fixedFrames('snow', RELATIONS);
    expect(snow.map((f) => f.id)).toEqual(['fixed:property', 'fixed:it-property']);
  });

  it('listPhrase joins 1-3 objects the way the frames always did', () => {
    expect(listPhrase(['wings'])).toBe('wings');
    expect(listPhrase(['wings', 'feathers'])).toBe('wings and feathers');
    expect(listPhrase(['wings', 'feathers', 'beak'])).toBe('wings, feathers, and beak');
    expect(listPhrase([])).toBe('');
  });
});

describe('relation-hole template rendering', () => {
  it('fills object lists, articles, indexes, and negation holes from stored edges', () => {
    const t = (text: string): { text: string } => ({ text });
    expect(renderTemplate(t('A {s} is {a:p:is-a}.'), 'robin', RELATIONS, NEVER_DENIED, [])).toBe('A robin is a bird.');
    expect(renderTemplate(t('It has {p:has-part}.'), 'robin', RELATIONS, NEVER_DENIED, [])).toBe(
      'It has wings and feathers.'
    );
    expect(renderTemplate(t('A {s} is {p:has-property}.'), 'snow', RELATIONS, NEVER_DENIED, [])).toBe(
      'A snow is cold and wet.'
    );
    // The article adapts to the object's first letter.
    expect(renderTemplate(t('A {s} is {a:p:is-a}.'), 'robin', RELATIONS, NEVER_DENIED, [])).toBe('A robin is a bird.');
    // Indexed holes read DIRECT + INHERITED objects (robin is-a bird is-a
    // creature): index 1 of the is-a list is the inherited creature.
    expect(renderTemplate(t('A {s} is {a:p:is-a:1}.'), 'robin', RELATIONS, NEVER_DENIED, [])).toBe(
      'A robin is a creature.'
    );
    const animalGraph: Relation[] = [
      ...RELATIONS,
      { subject: 'robin', predicate: 'is-a', object: 'animal', source: 'def', origin: 'chaperone' }
    ];
    // Direct edges precede inherited ones in the object list (bird, animal,
    // then inherited creature).
    expect(renderTemplate(t('A {s} is {a:p:is-a:1}.'), 'robin', animalGraph, NEVER_DENIED, [])).toBe(
      'A robin is an animal.'
    );
  });

  it('returns null when a hole is unfillable (missing edge, index past the list)', () => {
    const t = (text: string): { text: string } => ({ text });
    // No capable-of edge for snow.
    expect(renderTemplate(t('A {s} can {p:capable-of}.'), 'snow', RELATIONS, NEVER_DENIED, [])).toBeNull();
    // Index 1 of a single-object list (capable-of is only inherited from
    // bird — one object).
    expect(renderTemplate(t('A {s} can {p:capable-of:1}.'), 'robin', RELATIONS, NEVER_DENIED, [])).toBeNull();
    // Unknown predicate.
    expect(renderTemplate(t('A {s} is {p:not-a-predicate}.'), 'robin', RELATIONS, NEVER_DENIED, [])).toBeNull();
  });

  it('fills {n:...} holes from the confirmed-false store, never from positive edges', () => {
    const negations: Negation[] = [{ subject: 'penguin', predicate: 'is-a', object: 'bird', evidence: 'taught', origin: 'taught' }];
    const t = (text: string): { text: string } => ({ text });
    const rendered = renderTemplate(t('A {s} is not {a:n:is-a}.'), 'penguin', RELATIONS, NEVER_DENIED, negations);
    expect(rendered).toBe('A penguin is not a bird.');
    // Robin has positive is-a edges but no confirmed falsehood -> unfillable.
    expect(renderTemplate(t('A {s} is not {a:n:is-a}.'), 'robin', RELATIONS, NEVER_DENIED, negations)).toBeNull();
    // The rendered negation re-parses as a backed claim.
    if (rendered !== null) expect(criticize(rendered, RELATIONS, negations).grounded).toBe(true);
  });
});

describe('induction from accepted answers', () => {
  it('reconstructs the observed clause order and connectives as a template', () => {
    const store = new LearnedFrameStore();
    const induced = store.induce('A robin is a bird. It has wings and feathers.', RELATIONS, []);
    expect(induced).not.toBeNull();
    expect(induced!.text).toBe('A {s} is {a:p:is-a}. It has {p:has-part}.');
    expect(induced!.learned).toBe(true);
    expect(induced!.stats.evidence).toBe(1);
  });

  it('rejects unbacked and unparseable sentences (no induction from fabrication)', () => {
    const store = new LearnedFrameStore();
    expect(store.induce('A robin is a bird. It can sing opera.', RELATIONS, [])).toBeNull();
    expect(store.induce('The quick brown fox jumps.', RELATIONS, [])).toBeNull();
  });

  it('does not learn single-clause structures (they duplicate the fixed frames)', () => {
    const store = new LearnedFrameStore();
    expect(store.induce('A robin is a bird.', RELATIONS, [])).toBeNull();
    expect(store.induce('A snow is cold and wet.', RELATIONS, [])).toBeNull();
    expect(store.candidateTemplates()).toEqual([]);
  });

  it('declines multi-word claim objects (cannot be generalized as holes)', () => {
    const multiword: Relation[] = [
      ...RELATIONS,
      { subject: 'robin', predicate: 'is-a', object: 'red bird', source: 'def', origin: 'chaperone' }
    ];
    const store = new LearnedFrameStore();
    expect(store.induce('A robin is a red bird. It can fly.', multiword, [])).toBeNull();
  });

  it('induces negation templates from accepted negated answers ({n:} holes)', () => {
    const negations: Negation[] = [{ subject: 'penguin', predicate: 'is-a', object: 'bird', evidence: 'taught', origin: 'taught' }];
    const penguinGraph: Relation[] = [
      ...RELATIONS,
      { subject: 'penguin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
      { subject: 'penguin', predicate: 'capable-of', object: 'swim', source: 'def', origin: 'regex' }
    ];
    const store = new LearnedFrameStore();
    const induced = store.induce('A penguin is not a bird. It can swim.', penguinGraph, negations);
    expect(induced).not.toBeNull();
    expect(induced!.text).toBe('A {s} is not {a:n:is-a}. It can {p:capable-of}.');
  });

  it('replay-guards evidence: the same accepted sentence confirms a template once', () => {
    const store = new LearnedFrameStore();
    const first = store.induce('A robin is a bird. It has wings and feathers.', RELATIONS, []);
    expect(first).not.toBeNull();
    store.induce('A robin is a bird. It has wings and feathers.', RELATIONS, []);
    expect(first!.stats.evidence).toBe(1);
  });

  it('a longer accepted answer confirms the clause-prefix templates it contains', () => {
    const store = new LearnedFrameStore();
    const two = store.induce('A robin is a bird. It has wings.', RELATIONS, []);
    expect(two).not.toBeNull();
    expect(two!.stats.evidence).toBe(1);
    store.induce('A robin is a bird. It has wings. It can fly.', RELATIONS, []);
    expect(two!.stats.evidence).toBe(2);
  });
});

describe('admission gates (critic survival + evidence + acceptance baseline)', () => {
  const BIRDS: Relation[] = [
    { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
    { subject: 'robin', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
    { subject: 'sparrow', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
    { subject: 'sparrow', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
    { subject: 'duck', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
    { subject: 'duck', predicate: 'has-part', object: 'bill', source: 'def', origin: 'regex' }
  ];

  it('admits a candidate only after >= MIN_EVIDENCE distinct successful uses', () => {
    const store = new LearnedFrameStore();
    const induced = store.induce('A robin is a bird. It has wings.', BIRDS, []);
    expect(induced).not.toBeNull();
    expect(induced!.admitted).toBe(false);
    expect(MIN_EVIDENCE).toBe(3);
    store.induce('A sparrow is a bird. It has wings.', BIRDS, []);
    store.induce('A duck is a bird. It has bill.', BIRDS, []);
    expect(induced!.admitted).toBe(true);
    const audit = store.audit().find((entry) => entry.id === induced!.id);
    expect(audit?.status).toBe('admitted');
    expect(audit?.evidence).toBe(3);
    expect(audit?.acceptance).toBe(1);
  });

  it('refuses admission when measured acceptance drops below the fixed baseline', () => {
    const store = new LearnedFrameStore();
    // The fixed frames' acceptance baseline: 3 strong of 5 graded uses.
    store.observeUse(['fixed:is-a', 'fixed:it-has-part'], true);
    store.observeUse(['fixed:is-a', 'fixed:it-capable-of'], false);
    store.observeUse(['fixed:it-has-part'], true);
    expect(store.baselineAcceptance()).toBeCloseTo(3 / 5);

    const candidate = store.induce('A robin is a bird. It has wings.', BIRDS, []);
    expect(candidate).not.toBeNull();
    // The world keeps rejecting the candidate when it is explored…
    store.observeUse([candidate!.id], false);
    store.observeUse([candidate!.id], false);
    store.observeUse([candidate!.id], false);
    // …yet accepted answers keep confirming it (evidence accumulates).
    store.induce('A sparrow is a bird. It has wings.', BIRDS, []);
    store.induce('A duck is a bird. It has bill.', BIRDS, []);

    const verdict = store.evaluateAdmission(candidate!, BIRDS, []);
    expect(verdict.probePassed).toBe(true);
    expect(verdict.enoughEvidence).toBe(true);
    expect(verdict.meetsBaseline).toBe(false);
    expect(verdict.admitted).toBe(false);
    expect(candidate!.admitted).toBe(false);
  });

  it('rejects a template that can render an unbacked claim (the critic gate)', () => {
    // "It is a bird." does not parse as is-a — the property grammar reads it
    // as has-property "a bird", which no edge backs. A template containing
    // that structure is refused by the admission probe, even with plenty of
    // evidence.
    const store = new LearnedFrameStore();
    const unbacked: HoleTemplate = {
      id: 'learned:test-unbacked',
      text: 'A {s} is {a:p:is-a}. It is {a:p:is-a}.',
      namesSubject: true,
      requiresParent: false,
      learned: true,
      admitted: false,
      stats: { uses: 0, accepted: 0, rejected: 0, evidence: 5 }
    };
    const verdict = store.evaluateAdmission(unbacked, BIRDS, []);
    expect(verdict.probePassed).toBe(false);
    expect(verdict.enoughEvidence).toBe(true);
    expect(verdict.admitted).toBe(false);
    // maybeAdmit drops it for good: the structure is unsafe, evidence or not.
    expect(store.maybeAdmit(unbacked, BIRDS, [])).toBe(false);
    expect(store.droppedTemplates().map((t) => t.id)).toContain(unbacked.id);
    expect(store.learnedTemplates()).toEqual([]);
  });

  it('demotes an admitted template whose live renders the critic refuses repeatedly', () => {
    const store = new LearnedFrameStore();
    const candidate = store.induce('A robin is a bird. It has wings.', BIRDS, []);
    store.induce('A sparrow is a bird. It has wings.', BIRDS, []);
    store.induce('A duck is a bird. It has bill.', BIRDS, []);
    expect(candidate!.admitted).toBe(true);
    store.observeRejection([candidate!.id]);
    store.observeRejection([candidate!.id]);
    expect(candidate!.admitted).toBe(true);
    store.observeRejection([candidate!.id]);
    expect(candidate!.admitted).toBe(false);
    expect(store.learnedTemplates()).toEqual([]);
    expect(store.audit().find((entry) => entry.id === candidate!.id)?.status).toBe('dropped');
  });

  it('caps the admitted set, evicting the weakest when the cap is hit', () => {
    const store = new LearnedFrameStore({ maxLearned: 1 });
    const birds: Relation[] = [
      ...BIRDS,
      { subject: 'robin', predicate: 'capable-of', object: 'fly', source: 'def', origin: 'regex' },
      { subject: 'sparrow', predicate: 'capable-of', object: 'sing', source: 'def', origin: 'regex' },
      { subject: 'duck', predicate: 'capable-of', object: 'swim', source: 'def', origin: 'regex' }
    ];
    const a = store.induce('A robin is a bird. It has wings.', birds, []);
    store.induce('A sparrow is a bird. It has wings.', birds, []);
    store.induce('A duck is a bird. It has bill.', birds, []);
    expect(a!.admitted).toBe(true);
    expect(store.learnedTemplates().length).toBe(1);
    const b = store.induce('A robin is a bird. It can fly.', birds, []);
    store.induce('A sparrow is a bird. It can sing.', birds, []);
    store.induce('A duck is a bird. It can swim.', birds, []);
    expect(b!.admitted).toBe(true);
    expect(a!.admitted).toBe(false); // evicted — the cap holds at one
    expect(store.learnedTemplates().length).toBe(1);
  });
});

describe('composition integration (groundedFrames + learned store)', () => {
  it('with no learning, the store composes identically to the fixed-only path', () => {
    const store = new LearnedFrameStore();
    for (let seed = 0; seed < 12; seed += 1) {
      const withStore = composeGrounded(['robin', 'snow'], RELATIONS, mulberry32(seed), 3, [], store);
      const fixed = composeGrounded(['robin', 'snow'], RELATIONS, mulberry32(seed), 3, [], null);
      expect(withStore).not.toBeNull();
      expect(withStore!.sentence).toBe(fixed!.sentence);
      expect(withStore!.templateIds).toEqual(fixed!.templateIds);
    }
  });

  it('composition is deterministic per seed even with a learning store', () => {
    const store = new LearnedFrameStore();
    const a = composeGrounded(['robin', 'snow'], RELATIONS, mulberry32(7), 3, [], store);
    const b = composeGrounded(['robin', 'snow'], RELATIONS, mulberry32(7), 3, [], store);
    expect(a!.sentence).toBe(b!.sentence);
  });

  it('an admitted learned template joins the pool and its composition passes the critic', () => {
    // minEvidence 2 for this test: two distinct accepted answers confirming
    // the same structure clear the bar.
    const store = new LearnedFrameStore({ minEvidence: 2 });
    store.induce('A robin is a bird. It has wings.', RELATIONS, []);
    store.induce('A robin is a bird. It has feathers.', RELATIONS, []);
    const frames = store.compositionFrames('robin', RELATIONS, NEVER_DENIED, []);
    expect(frames.some((f) => f.id.startsWith('learned:'))).toBe(true);
    const learned = frames.find((f) => f.id.startsWith('learned:'));
    expect(learned!.text).toBe('A robin is a bird. It has wings and feathers.');

    // Some seed draws the learned opening; whatever is composed must pass
    // the internal critic and cite only real edges.
    let drewLearned = false;
    for (let seed = 0; seed < 40; seed += 1) {
      const composed = composeGrounded(['robin'], RELATIONS, mulberry32(seed), 3, [], store);
      expect(composed).not.toBeNull();
      expect(criticize(composed!.sentence, RELATIONS, []).grounded).toBe(true);
      if (composed!.templateIds.some((id) => id.startsWith('learned:'))) drewLearned = true;
    }
    expect(drewLearned).toBe(true);
  });

  it('candidates are explored with the exploration probability, never forced', () => {
    const store = new LearnedFrameStore();
    const candidate = store.induce('A robin is a bird. It has wings.', RELATIONS, []);
    expect(candidate).not.toBeNull();
    expect(candidate!.admitted).toBe(false);
    const exploring = store.compositionFrames('robin', RELATIONS, NEVER_DENIED, [], () => 0.05);
    expect(exploring.some((f) => f.id === candidate!.id)).toBe(true);
    const notExploring = store.compositionFrames('robin', RELATIONS, NEVER_DENIED, [], () => 0.9);
    expect(notExploring.some((f) => f.id === candidate!.id)).toBe(false);
  });
});

describe('acceptance benchmark: fixed frames vs. fixed + learned templates', () => {
  const BENCH_RELATIONS: Relation[] = [
    { subject: 'robin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
    { subject: 'robin', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
    { subject: 'robin', predicate: 'capable-of', object: 'fly', source: 'def', origin: 'regex' },
    { subject: 'sparrow', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
    { subject: 'sparrow', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
    { subject: 'sparrow', predicate: 'capable-of', object: 'sing', source: 'def', origin: 'regex' },
    { subject: 'penguin', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
    { subject: 'penguin', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
    { subject: 'penguin', predicate: 'capable-of', object: 'swim', source: 'def', origin: 'regex' },
    { subject: 'duck', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
    { subject: 'duck', predicate: 'has-part', object: 'bill', source: 'def', origin: 'regex' },
    { subject: 'duck', predicate: 'capable-of', object: 'swim', source: 'def', origin: 'regex' },
    { subject: 'canary', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
    { subject: 'canary', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
    { subject: 'canary', predicate: 'capable-of', object: 'sing', source: 'def', origin: 'regex' },
    { subject: 'wren', predicate: 'is-a', object: 'bird', source: 'def', origin: 'regex' },
    { subject: 'wren', predicate: 'has-part', object: 'wings', source: 'def', origin: 'regex' },
    { subject: 'wren', predicate: 'capable-of', object: 'hop', source: 'def', origin: 'regex' }
  ];
  const PROBES = ['robin', 'sparrow', 'penguin', 'duck', 'canary', 'wren'];

  it('the learned arm matches or beats the fixed baseline (deterministic world model)', () => {
    const result = templateAcceptanceBench(BENCH_RELATIONS, [], { rounds: 200, warmup: 80, seed: 0x5eed, probes: PROBES });
    console.log(
      `TEMPLATE BENCH: fixed ${(result.baselineRate * 100).toFixed(1)}% vs fixed+learned ${(result.learnedRate * 100).toFixed(1)}% ` +
        `(${result.admitted} admitted, ${result.exploring} exploring, ${result.dropped} dropped)`
    );
    // The surrogate world rejects single-sentence compositions, so the
    // fixed arm's acceptance is bounded well below the learned arm's.
    expect(result.baselineRate).toBeLessThan(0.7);
    expect(result.learnedRate).toBeGreaterThanOrEqual(result.baselineRate);
    expect(result.learnedRate).toBeGreaterThanOrEqual(0.8);
    expect(result.admitted).toBeGreaterThan(0);
    for (const entry of result.learnedTemplates) {
      if (entry.status === 'admitted') {
        expect(entry.acceptance).toBeGreaterThanOrEqual(result.baselineRate);
      }
    }
  });
});
