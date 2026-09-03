import { describe, expect, test } from '@jest/globals';
import { equals, freeVars, isLiteral, matchPattern, serializeBounded, size, substitute, tLit, tSym, tVar, termBits, termToString } from './terms';

describe('terms — canonical form', () => {
  test('termToString is canonical', () => {
    expect(termToString(tVar('x'))).toBe('?x');
    expect(termToString(tLit(42))).toBe('#n:42');
    expect(termToString(tLit(true))).toBe('#b:true');
    expect(termToString(tSym('add', [tLit(1), tLit(2)]))).toBe('add(#n:1,#n:2)');
    expect(termToString(tSym('z'))).toBe('z');
  });

  test('equals is structural', () => {
    expect(equals(tSym('f', [tLit(1)]), tSym('f', [tLit(1)]))).toBe(true);
    expect(equals(tSym('f', [tLit(1)]), tSym('f', [tLit(2)]))).toBe(false);
    expect(equals(tLit(1), tLit('1'))).toBe(false);
  });

  test('isLiteral and size', () => {
    expect(isLiteral(tLit(3))).toBe(true);
    expect(isLiteral(tSym('z'))).toBe(false);
    expect(size(tSym('f', [tLit(1), tSym('g', [tLit(2)])]))).toBe(4);
  });

  test('serializeBounded truncates long terms', () => {
    const long = tSym('f', Array.from({ length: 50 }, (_, i) => tLit(i)));
    expect(serializeBounded(long, 20).length).toBeLessThanOrEqual(21);
    expect(serializeBounded(long, 20).endsWith('…')).toBe(true);
  });

  test('freeVars collects every variable', () => {
    const term = tSym('f', [tVar('x'), tSym('g', [tVar('y'), tVar('x')])]);
    const vars = freeVars(term);
    expect([...vars].sort()).toEqual(['x', 'y']);
  });

  test('termBits charges vars, lits, and syms', () => {
    expect(termBits(tVar('x'))).toBe(3);
    expect(termBits(tLit(1))).toBe(10);
    expect(termBits(tSym('f', [tLit(1)]))).toBe(14);
  });
});

describe('terms — pattern matching', () => {
  test('binds variables structurally', () => {
    const pattern = tSym('add', [tVar('x'), tVar('y')]);
    const bindings = matchPattern(pattern, tSym('add', [tLit(2), tLit(3)]));
    expect(bindings).not.toBeNull();
    expect(termToString(bindings!.get('x')!)).toBe('#n:2');
    expect(termToString(bindings!.get('y')!)).toBe('#n:3');
  });

  test('a repeated variable requires equal terms', () => {
    const pattern = tSym('f', [tVar('x'), tVar('x')]);
    expect(matchPattern(pattern, tSym('f', [tLit(1), tLit(1)]))).not.toBeNull();
    expect(matchPattern(pattern, tSym('f', [tLit(1), tLit(2)]))).toBeNull();
  });

  test('arity and head mismatches fail', () => {
    const pattern = tSym('f', [tVar('x')]);
    expect(matchPattern(pattern, tSym('f', [tLit(1), tLit(2)]))).toBeNull();
    expect(matchPattern(pattern, tSym('g', [tLit(1)]))).toBeNull();
  });

  test('literals match exactly', () => {
    expect(matchPattern(tLit(7), tLit(7))).not.toBeNull();
    expect(matchPattern(tLit(7), tLit(8))).toBeNull();
    expect(matchPattern(tLit(true), tLit('true'))).toBeNull();
  });
});

describe('terms — substitution', () => {
  test('replaces every bound variable', () => {
    const bindings = new Map([['x', tLit(5)]]);
    expect(termToString(substitute(tSym('f', [tVar('x'), tVar('x')]), bindings))).toBe('f(#n:5,#n:5)');
  });

  test('throws on an unbound variable (registration prevents this)', () => {
    expect(() => substitute(tVar('nope'), new Map())).toThrow(/unbound variable/);
  });
});
