/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { PRIME_SPACE } from './primeSignature';
import { DECK_20000 } from './decks/en-20000';
import { canonicalFusionRoute, fusionRoutes, generateFusionClosure } from './primeFusion';
import { semanticAssignment } from './semanticSignature';

describe('triadic prime fusion', () => {
  it('enumerates distinct odd-prime routes to a target', () => {
    const routes = fusionRoutes(19, [3, 5, 7, 11, 13, 17]);
    expect(routes.map((route) => route.inputs)).toContainEqual([3, 5, 11]);
  });

  it('chooses the route nearest a 108-degree twist closure', () => {
    const routes = fusionRoutes(61, [3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43]);
    expect(canonicalFusionRoute(routes)?.inputs).toEqual([5, 13, 43]);
  });

  it('recursively generates in-basis primes from the seed set', () => {
    const closure = generateFusionClosure(PRIME_SPACE);
    expect(closure.get(19)?.inputs).toEqual([3, 5, 11]);
    expect(closure.has(61)).toBe(true);
    expect(closure.size).toBeGreaterThan(100);
  });

  it('assigns category primes exclusively from fusion closure', () => {
    const slice = DECK_20000.slice(0, 5000);
    const fusion = semanticAssignment(slice, PRIME_SPACE, { categoryStrategy: 'fusion' });
    const generated = generateFusionClosure(PRIME_SPACE);
    expect(fusion.categoryPrimes.size).toBeGreaterThan(100);
    for (const prime of fusion.categoryPrimes.values()) expect(generated.has(prime)).toBe(true);
  });
});