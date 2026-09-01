/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { isATypeOf, inheritsPart } from './chain';
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