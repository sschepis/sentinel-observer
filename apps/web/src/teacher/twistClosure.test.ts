/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { twistClosure } from './twistClosure';

describe('twist closure', () => {
  it('scores an exact turn as closed', () => {
    expect(twistClosure(['two', 'two'], { two: [2] }).score).toBeCloseTo(1);
  });

  it('scores a half-turn as maximally open', () => {
    expect(twistClosure(['two'], { two: [2] }).score).toBeCloseTo(0);
  });

  it('reports an empty unknown sequence honestly', () => {
    expect(twistClosure(['unknown'], {}).primeCount).toBe(0);
    expect(twistClosure(['unknown'], {}).score).toBe(0);
  });
});