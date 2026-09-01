/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { isATypeOf, inheritsPart, inheritsEdge, edgeObjects, deniedFromNegations } from './chain';
import type { Relation } from './relations';

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

describe('exception-aware inheritance (negations propagate into walks)', () => {
  const PENGUIN: Relation[] = [
    { subject: 'penguin', predicate: 'is-a', object: 'bird', source: 'a flightless bird', origin: 'regex' },
    { subject: 'bird', predicate: 'is-a', object: 'animal', source: '', origin: 'regex' },
    { subject: 'bird', predicate: 'capable-of', object: 'fly', source: '', origin: 'regex' },
    { subject: 'bird', predicate: 'has-part', object: 'wings', source: '', origin: 'regex' }
  ];
  const cannotFly = deniedFromNegations([
    { subject: 'penguin', predicate: 'capable-of', object: 'fly' }
  ]);

  it('a subject-level negation overrides an inherited positive', () => {
    // Without the veto the walk inherits fly from bird.
    expect(inheritsEdge(PENGUIN, 'penguin', 'capable-of', 'fly')).toEqual({ via: 'bird' });
    // With it, the exception wins — honest null.
    expect(inheritsEdge(PENGUIN, 'penguin', 'capable-of', 'fly', cannotFly)).toBeNull();
    // Unrelated inheritance is untouched.
    expect(inheritsPart(PENGUIN, 'penguin', 'wings', cannotFly)).toEqual({ via: 'bird' });
  });

  it('edgeObjects filters negated objects from open answers', () => {
    expect(edgeObjects(PENGUIN, 'penguin', 'capable-of')).toEqual(['fly']);
    expect(edgeObjects(PENGUIN, 'penguin', 'capable-of', cannotFly)).toEqual([]);
    // The parent itself still lists its own capability.
    expect(edgeObjects(PENGUIN, 'bird', 'capable-of', cannotFly)).toEqual(['fly']);
  });

  it('a negated is-a edge is never walked, and blocks transitive conclusions', () => {
    const notABird = deniedFromNegations([{ subject: 'penguin', predicate: 'is-a', object: 'bird' }]);
    expect(isATypeOf(PENGUIN, 'penguin', 'bird', notABird)).toBe(false);
    // Everything reached only through the negated edge is unreachable too.
    expect(isATypeOf(PENGUIN, 'penguin', 'animal', notABird)).toBe(false);
    expect(inheritsPart(PENGUIN, 'penguin', 'wings', notABird)).toBeNull();
    expect(edgeObjects(PENGUIN, 'penguin', 'capable-of', notABird)).toEqual([]);
  });

  it('a transitive is-a conclusion is vetoed by a direct negation on it', () => {
    const notAnAnimal = deniedFromNegations([{ subject: 'penguin', predicate: 'is-a', object: 'animal' }]);
    expect(isATypeOf(PENGUIN, 'penguin', 'animal', notAnAnimal)).toBe(false);
    expect(isATypeOf(PENGUIN, 'penguin', 'bird', notAnAnimal)).toBe(true);
  });

  it('an ancestor-level negation blocks inheriting that ancestor\u2019s edge', () => {
    const birdEdgeFalse = deniedFromNegations([{ subject: 'bird', predicate: 'capable-of', object: 'fly' }]);
    expect(inheritsEdge(PENGUIN, 'penguin', 'capable-of', 'fly', birdEdgeFalse)).toBeNull();
    expect(edgeObjects(PENGUIN, 'penguin', 'capable-of', birdEdgeFalse)).toEqual([]);
  });
});