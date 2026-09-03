/**
 * ALG — inverse-operation equations (R15).
 *
 * An equation is built from INERT constructors (eq.rel / eq.plus /
 * eq.times / eq.minus) wrapping the unknown `var.x` and numerals. The
 * constructors have no rules — under call-by-value an equation component
 * built from nat.add/nat.mul would be eagerly REDUCED (mixing the unknown
 * into computations) before alg.solve could ever see the equation's shape.
 * Inertness is what keeps the equation intact for the inverse-operation
 * rules:
 *
 *   x + c = r  ->  x = r − c        (plus, both orders)
 *   c × x = r  ->  x = r ÷ c        (times, both orders)
 *   x − c = r  ->  x = r + c        (minus)
 *
 * Shapes with no rule — x on both sides, x under an operation — are stuck:
 * decline, never a guess.
 */

import { tSym, termBits, tVar, type Term } from './terms';
import type { RewriteRule } from './types';

const X = tSym('var.x');
const c = tVar('c');
const r = tVar('r');
const rel = (lhs: Term, rhs: Term): Term => tSym('eq.rel', [lhs, rhs]);
const plus = (a: Term, b: Term): Term => tSym('eq.plus', [a, b]);
const times = (a: Term, b: Term): Term => tSym('eq.times', [a, b]);
const minus = (a: Term, b: Term): Term => tSym('eq.minus', [a, b]);
const solve = (equation: Term): Term => tSym('alg.solve', [equation]);

const rule = (id: string, lhs: Term, rhs: Term): RewriteRule => ({
  id,
  name: lhs.t === 'sym' ? lhs.head : id,
  lhs,
  rhs,
  origin: 'authored',
  strength: 1,
  sourceClasses: ['curriculum'],
  bits: termBits(lhs) + termBits(rhs),
  active: true,
  createdAt: 0,
  useCount: 0
});

export const ALG_RULES: RewriteRule[] = [
  // x + c = r  ->  x = r − c
  rule('alg.solve-plus-l', solve(rel(plus(X, c), r)), tSym('nat.sub', [r, c])),
  // c + x = r  ->  x = r − c  (the commuted form)
  rule('alg.solve-plus-r', solve(rel(plus(c, X), r)), tSym('nat.sub', [r, c])),
  // c × x = r  ->  x = r ÷ c
  rule('alg.solve-times-l', solve(rel(times(c, X), r)), tSym('nat.div', [r, c])),
  // x × c = r  ->  x = r ÷ c
  rule('alg.solve-times-r', solve(rel(times(X, c), r)), tSym('nat.div', [r, c])),
  // x − c = r  ->  x = r + c
  rule('alg.solve-minus', solve(rel(minus(X, c), r)), tSym('nat.add', [r, c]))
];

