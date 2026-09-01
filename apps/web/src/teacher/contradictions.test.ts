/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import type { Negation, Relation } from './relations';
import {
  detectConflicts,
  triageConflicts,
  severityOf,
  resolutionFor,
  isConflictResolved,
  verificationQuestionFor,
  MIN_POSITIVE_STRENGTH,
  type SweepConflict,
  type VerificationItem
} from './contradictions';

const edge = (
  subject: string,
  predicate: string,
  object: string,
  extra: Partial<Relation> = {}
): Relation => ({
  subject,
  predicate: predicate as Relation['predicate'],
  object,
  source: `definition of ${subject}`,
  origin: 'regex',
  ...extra
});

const deny = (
  subject: string,
  predicate: string,
  object: string,
  extra: Partial<Negation> = {}
): Negation => ({
  subject,
  predicate: predicate as Negation['predicate'],
  object,
  evidence: `${subject} is not ${object}`,
  origin: 'taught',
  ...extra
});

/** Relations + negations that collide on (whale, is-a, fish) directly. */
function directConflictFixture(): { relations: Relation[]; negations: Negation[] } {
  return {
    relations: [edge('whale', 'is-a', 'fish')],
    negations: [deny('whale', 'is-a', 'fish')]
  };
}

/** robin is-a bird; bird has-part wings; robin denies having wings. */
function inheritedFixture(): { relations: Relation[]; negations: Negation[] } {
  return {
    relations: [
      edge('robin', 'is-a', 'bird'),
      edge('bird', 'has-part', 'wings')
    ],
    negations: [deny('robin', 'has-part', 'wings')]
  };
}

describe('detectConflicts — direct positive/negative', () => {
  it('reports the same triple asserted positively and negatively', () => {
    const { relations, negations } = directConflictFixture();
    const conflicts = detectConflicts(relations, negations);
    expect(conflicts).toHaveLength(1);
    const conflict = conflicts[0];
    expect(conflict.kind).toBe('direct');
    expect(conflict.direction).toBe('direct');
    expect(conflict.subject).toBe('whale');
    expect(conflict.predicate).toBe('is-a');
    expect(conflict.object).toBe('fish');
    expect(conflict.positive.holder).toBe('whale');
    expect(conflict.negative.holder).toBe('whale');
  });

  it('reports nothing when only one side exists (absence is not contradiction)', () => {
    expect(detectConflicts([edge('whale', 'is-a', 'fish')], [])).toHaveLength(0);
    expect(detectConflicts([], [deny('whale', 'is-a', 'fish')])).toHaveLength(0);
  });

  it('reports a near-conflict when the positive edge is weakened but still supported', () => {
    const conflicts = detectConflicts(
      [edge('whale', 'is-a', 'fish', { strength: 0.7 })],
      [deny('whale', 'is-a', 'fish')]
    );
    expect(conflicts).toHaveLength(1);
  });

  it('does NOT report a positive edge weakened below the support floor — it is no longer a live claim', () => {
    const conflicts = detectConflicts(
      [edge('whale', 'is-a', 'fish', { strength: 0.1 })],
      [deny('whale', 'is-a', 'fish')]
    );
    expect(conflicts).toHaveLength(0);
  });

  it('an edge exactly at the floor still reports', () => {
    const conflicts = detectConflicts(
      [edge('whale', 'is-a', 'fish', { strength: MIN_POSITIVE_STRENGTH })],
      [deny('whale', 'is-a', 'fish')]
    );
    expect(conflicts).toHaveLength(1);
  });

  it('a graded denial is a conflict too', () => {
    const conflicts = detectConflicts(
      [edge('whale', 'is-a', 'fish')],
      [deny('whale', 'is-a', 'fish', { origin: 'graded' })]
    );
    expect(conflicts).toHaveLength(1);
  });

  it('dedupes corroborating duplicate entries into one conflict', () => {
    const conflicts = detectConflicts(
      [
        edge('whale', 'is-a', 'fish'),
        edge('whale', 'is-a', 'fish', { origin: 'authored', strength: 2 })
      ],
      [deny('whale', 'is-a', 'fish')]
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].positive.strength).toBe(2);
    expect(conflicts[0].positive.corroborations).toBe(2);
  });
});

describe('detectConflicts — inheritance conflicts', () => {
  it('explicit-negative vs inherited-positive: robin denies wings, bird asserts them', () => {
    const { relations, negations } = inheritedFixture();
    const conflicts = detectConflicts(relations, negations);
    expect(conflicts).toHaveLength(1);
    const conflict = conflicts[0];
    expect(conflict.kind).toBe('inheritance');
    expect(conflict.direction).toBe('explicit-negative');
    expect(conflict.subject).toBe('robin');
    expect(conflict.positive.holder).toBe('bird'); // inherited via is-a
    expect(conflict.negative.holder).toBe('robin');
  });

  it('explicit-positive vs inherited-negative: robin asserts teeth, bird denies them', () => {
    const conflicts = detectConflicts(
      [
        edge('robin', 'is-a', 'bird'),
        edge('robin', 'has-part', 'teeth'),
        edge('bird', 'has-part', 'wings')
      ],
      [deny('bird', 'has-part', 'teeth')]
    );
    expect(conflicts).toHaveLength(1);
    const conflict = conflicts[0];
    expect(conflict.direction).toBe('explicit-positive');
    expect(conflict.positive.holder).toBe('robin');
    expect(conflict.negative.holder).toBe('bird');
  });

  it('inherited vs inherited: two ancestors disagree about a part', () => {
    const conflicts = detectConflicts(
      [
        edge('robin', 'is-a', 'bird'),
        edge('robin', 'is-a', 'songbird'),
        edge('bird', 'has-part', 'teeth'),
        edge('songbird', 'has-part', 'wings')
      ],
      [deny('songbird', 'has-part', 'teeth')]
    );
    // bird asserts teeth, songbird denies teeth — robin inherits both.
    const conflict = conflicts.find((c) => c.direction === 'inherited');
    expect(conflict).toBeDefined();
    expect(conflict!.subject).toBe('robin');
    expect(conflict!.positive.holder).toBe('bird');
    expect(conflict!.negative.holder).toBe('songbird');
  });

  it('a denial on an ancestor does not conflict with an unrelated subject', () => {
    const conflicts = detectConflicts(
      [
        edge('robin', 'is-a', 'bird'),
        edge('fish', 'has-part', 'wings')
      ],
      [deny('bird', 'has-part', 'teeth')]
    );
    expect(conflicts).toHaveLength(0);
  });

  it('a subject that directly asserts what its ancestor denies reports BOTH the direct and inherited views only when they differ', () => {
    // whale is-a fish (direct), fish is-a animal, and "whale is not a fish"
    // is taught: the direct conflict is reported; there is no second
    // ancestor denial.
    const conflicts = detectConflicts(
      [
        edge('whale', 'is-a', 'fish'),
        edge('fish', 'is-a', 'animal')
      ],
      [deny('whale', 'is-a', 'fish')]
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].direction).toBe('direct');
  });

  it('walks multi-hop inheritance (robin is-a bird is-a animal)', () => {
    const conflicts = detectConflicts(
      [
        edge('robin', 'is-a', 'bird'),
        edge('bird', 'is-a', 'animal'),
        edge('animal', 'has-part', 'fur')
      ],
      [deny('robin', 'has-part', 'fur')]
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].direction).toBe('explicit-negative');
    expect(conflicts[0].positive.holder).toBe('animal');
  });

  it('transitive inherited is-a: penguin is-a bird is-a animal, penguin denies is-a animal', () => {
    const conflicts = detectConflicts(
      [
        edge('penguin', 'is-a', 'bird'),
        edge('bird', 'is-a', 'animal')
      ],
      [deny('penguin', 'is-a', 'animal')]
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].direction).toBe('explicit-negative');
    expect(conflicts[0].predicate).toBe('is-a');
  });
});

describe('severity scoring', () => {
  function scoreFor(
    relations: Relation[],
    negations: Negation[],
    direction: SweepConflict['direction']
  ): number {
    const conflict = detectConflicts(relations, negations).find(
      (c) => c.direction === direction
    );
    expect(conflict).toBeDefined();
    return conflict!.severity;
  }

  it('is a bounded 0..1 score', () => {
    const { relations, negations } = directConflictFixture();
    const severity = severityOf(detectConflicts(relations, negations)[0]);
    expect(severity).toBeGreaterThan(0);
    expect(severity).toBeLessThanOrEqual(1);
  });

  it('a taught denial outweighs a graded denial', () => {
    const taught = scoreFor(
      [edge('whale', 'is-a', 'fish')],
      [deny('whale', 'is-a', 'fish')],
      'direct'
    );
    const graded = scoreFor(
      [edge('whale', 'is-a', 'fish')],
      [deny('whale', 'is-a', 'fish', { origin: 'graded' })],
      'direct'
    );
    expect(taught).toBeGreaterThan(graded);
  });

  it('a corroborated edge (higher strength) scores higher', () => {
    const single = scoreFor(
      [edge('whale', 'is-a', 'fish', { strength: 1 })],
      [deny('whale', 'is-a', 'fish')],
      'direct'
    );
    const agreed = scoreFor(
      [edge('whale', 'is-a', 'fish', { strength: 2 })],
      [deny('whale', 'is-a', 'fish')],
      'direct'
    );
    expect(agreed).toBeGreaterThan(single);
  });

  it('direct conflicts outrank inherited ones with identical evidence', () => {
    const direct = scoreFor(
      [edge('whale', 'is-a', 'fish')],
      [deny('whale', 'is-a', 'fish')],
      'direct'
    );
    const inherited = scoreFor(
      [
        edge('robin', 'is-a', 'bird'),
        edge('bird', 'has-part', 'wings')
      ],
      [deny('robin', 'has-part', 'wings')],
      'explicit-negative'
    );
    expect(direct).toBeGreaterThan(inherited);
  });

  it('regex provenance scores above chaperone provenance, all else equal', () => {
    const regex = scoreFor(
      [edge('whale', 'is-a', 'fish', { origin: 'regex' })],
      [deny('whale', 'is-a', 'fish')],
      'direct'
    );
    const chaperone = scoreFor(
      [edge('whale', 'is-a', 'fish', { origin: 'chaperone' })],
      [deny('whale', 'is-a', 'fish')],
      'direct'
    );
    expect(regex).toBeGreaterThan(chaperone);
  });
});

describe('triage — the verification queue', () => {
  it('orders by severity, highest first, deterministically', () => {
    const relations = [
      edge('whale', 'is-a', 'fish', { strength: 1 }),
      edge('robin', 'is-a', 'bird'),
      edge('bird', 'has-part', 'wings'),
      edge('whale', 'is-a', 'mammal')
    ];
    const negations = [
      deny('whale', 'is-a', 'fish'),
      deny('robin', 'has-part', 'wings'),
      deny('whale', 'is-a', 'mammal')
    ];
    const items = triageConflicts(detectConflicts(relations, negations));
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < items.length; i += 1) {
      expect(items[i - 1].severity).toBeGreaterThanOrEqual(items[i].severity);
    }
    const again = triageConflicts(detectConflicts(relations, negations));
    expect(again.map((item) => item.id)).toEqual(items.map((item) => item.id));
  });

  it('respects maxItems', () => {
    const { relations, negations } = directConflictFixture();
    const items = triageConflicts(detectConflicts(relations, negations), { maxItems: 0 });
    expect(items).toHaveLength(0);
  });

  it('phrases each probe as a natural yes/no question', () => {
    expect(verificationQuestionFor('whale', 'is-a', 'fish')).toBe('is whale a fish?');
    expect(verificationQuestionFor('snake', 'has-part', 'legs')).toBe('does snake have legs?');
    expect(verificationQuestionFor('glass', 'made-of', 'plastic')).toBe('is glass made of plastic?');
    const { relations, negations } = directConflictFixture();
    const item = triageConflicts(detectConflicts(relations, negations))[0];
    expect(item.question).toBe('is whale a fish?');
  });

  it('carries the evidence sides so resolution knows what to edit', () => {
    const { relations, negations } = directConflictFixture();
    const item: VerificationItem = triageConflicts(detectConflicts(relations, negations))[0];
    expect(item.positive.holder).toBe('whale');
    expect(item.negative.origin).toBe('taught');
  });
});

describe('resolution effects', () => {
  it('direct + positive retracts the denial and reinforces the edge', () => {
    const conflict = detectConflicts(
      directConflictFixture().relations,
      directConflictFixture().negations
    )[0];
    const effect = resolutionFor(conflict, 'positive');
    expect(effect.retractNegation).toEqual({ holder: 'whale', predicate: 'is-a', object: 'fish' });
    expect(effect.reinforce).toEqual({ holder: 'whale', predicate: 'is-a', object: 'fish' });
    expect(effect.weaken).toBeUndefined();
  });

  it('direct + negative weakens the positive edge (the denial stays)', () => {
    const conflict = detectConflicts(
      directConflictFixture().relations,
      directConflictFixture().negations
    )[0];
    const effect = resolutionFor(conflict, 'negative');
    expect(effect.weaken).toEqual({ holder: 'whale', predicate: 'is-a', object: 'fish' });
    expect(effect.retractNegation).toBeUndefined();
    expect(effect.reinforce).toBeUndefined();
  });

  it('explicit-positive + positive retracts the ANCESTOR denial and reinforces the subject edge', () => {
    const conflict = detectConflicts(
      [
        edge('robin', 'is-a', 'bird'),
        edge('robin', 'has-part', 'teeth'),
        edge('bird', 'has-part', 'wings')
      ],
      [deny('bird', 'has-part', 'teeth')]
    )[0];
    const effect = resolutionFor(conflict, 'positive');
    expect(effect.retractNegation?.holder).toBe('bird');
    expect(effect.reinforce?.holder).toBe('robin');
  });

  it('explicit-negative + negative weakens the ANCESTOR edge', () => {
    const conflict = detectConflicts(
      inheritedFixture().relations,
      inheritedFixture().negations
    )[0];
    const effect = resolutionFor(conflict, 'negative');
    expect(effect.weaken?.holder).toBe('bird');
  });

  it('explicit-negative + positive retracts the subject denial and reinforces the ancestor edge', () => {
    const conflict = detectConflicts(
      inheritedFixture().relations,
      inheritedFixture().negations
    )[0];
    const effect = resolutionFor(conflict, 'positive');
    expect(effect.retractNegation?.holder).toBe('robin');
    expect(effect.reinforce?.holder).toBe('bird');
  });
});

describe('resolved-conflict suppression', () => {
  it('retracting the negation removes the conflict (positive wins)', () => {
    const { relations, negations } = directConflictFixture();
    const conflict = detectConflicts(relations, negations)[0];
    const remaining = negations.filter((n) => !(n.subject === 'whale' && n.predicate === 'is-a' && n.object === 'fish'));
    expect(isConflictResolved(relations, remaining, conflict)).toBe(true);
    expect(detectConflicts(relations, remaining)).toHaveLength(0);
  });

  it('weakening the positive below the floor removes the conflict (negative wins)', () => {
    const { relations, negations } = directConflictFixture();
    const conflict = detectConflicts(relations, negations)[0];
    const weakened = [
      { ...relations[0], strength: MIN_POSITIVE_STRENGTH - 0.2 }
    ];
    expect(isConflictResolved(weakened, negations, conflict)).toBe(true);
    expect(detectConflicts(weakened, negations)).toHaveLength(0);
  });

  it('an inheritance conflict is resolved when its source edge or denial is edited', () => {
    const relations = [
      edge('robin', 'is-a', 'bird'),
      edge('bird', 'has-part', 'wings')
    ];
    const negations = [deny('robin', 'has-part', 'wings')];
    const conflict = detectConflicts(relations, negations)[0];
    // Negative wins: the ancestor edge weakens below the floor.
    const weakened = relations.map((r) =>
      r.subject === 'bird' && r.predicate === 'has-part' && r.object === 'wings'
        ? { ...r, strength: MIN_POSITIVE_STRENGTH - 0.2 }
        : r
    );
    expect(isConflictResolved(weakened, negations, conflict)).toBe(true);
    // Positive wins: the subject's denial is retracted.
    const retracted = negations.filter((n) => n.subject !== 'robin');
    expect(isConflictResolved(relations, retracted, conflict)).toBe(true);
  });
});
