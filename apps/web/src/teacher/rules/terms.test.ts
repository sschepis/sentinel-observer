import { describe, expect, test } from '@jest/globals';
import { equals, freeVars, isLiteral, matchPattern, prettyTerm, serializeBounded, size, substitute, tLit, tSym, tVar, termBits, termToString } from './terms';

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

describe('prettyTerm — the readable derivation form', () => {
  const nat = (n: number) => {
    let term = tSym('nat.z');
    for (let i = 0; i < n; i += 1) term = tSym('nat.s', [term]);
    return term;
  };
  test('Peano numerals print as digits, iteratively (a 30k-deep numeral does not overflow)', () => {
    expect(prettyTerm(nat(0))).toBe('0');
    expect(prettyTerm(nat(36))).toBe('36');
    expect(prettyTerm(nat(30000))).toBe('30000');
  });
  test('arithmetic and comparison heads print infix; ite prints if/then/else; literals lose their type tags', () => {
    expect(prettyTerm(tSym('nat.div', [nat(36), nat(6)]))).toBe('36 ÷ 6');
    expect(prettyTerm(tSym('nat.lt', [nat(36), nat(6)]))).toBe('36 < 6');
    expect(prettyTerm(tSym('ite', [tLit(false), tSym('nat.z'), tSym('nat.s', [tSym('nat.div', [tSym('nat.sub', [nat(36), nat(6)]), nat(6)])])]))).toBe(
      'if false then 0 else (36 − 6) ÷ 6 + 1'
    );
    expect(prettyTerm(tSym('int.neg', [nat(3)]))).toBe('−3');
    expect(prettyTerm(tSym('int.add', [tSym('int.neg', [nat(3)]), nat(5)]))).toBe('−3 + 5');
    expect(prettyTerm(tSym('bool.not', [tSym('bool.and', [tLit(true), tVar('p')])]))).toBe('¬(true ∧ ?p)');
    expect(prettyTerm(tSym('list.cons', [nat(1), tSym('list.cons', [nat(2), tSym('list.nil')])]))).toBe('[1, 2]');
    expect(prettyTerm(tSym('eq.rel', [tSym('eq.plus', [tSym('var.x'), nat(2)]), nat(5)]))).toBe('x + 2 = 5');
    expect(prettyTerm(tSym('nat.gcd', [nat(12), nat(8)]))).toBe('nat.gcd(12, 8)');
    // Precedence: looser children are bracketed, tighter ones are not; the right operand of − brackets an equal.
    expect(prettyTerm(tSym('nat.mul', [tSym('nat.add', [nat(1), nat(2)]), nat(3)]))).toBe('(1 + 2) × 3');
    expect(prettyTerm(tSym('nat.add', [nat(1), tSym('nat.mul', [nat(2), nat(3)])]))).toBe('1 + 2 × 3');
    expect(prettyTerm(tSym('nat.sub', [nat(5), tSym('nat.sub', [nat(3), nat(1)])]))).toBe('5 − (3 − 1)');
  });
  test('a numeral around an unreduced core prints as the core plus its offset; output stays bounded', () => {
    expect(prettyTerm(tSym('nat.s', [tSym('nat.s', [tSym('nat.sub', [tVar('x'), nat(1)])])]))).toBe('?x − 1 + 2');
    const wide = tSym('nat.gcd', Array.from({ length: 40 }, (_, i) => nat(i)));
    expect(prettyTerm(wide, 40).length).toBeLessThanOrEqual(41);
    expect(prettyTerm(wide, 40).endsWith('…')).toBe(true);
  });
});
