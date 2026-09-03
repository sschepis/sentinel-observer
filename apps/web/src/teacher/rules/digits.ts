/**
 * DIGITS — positional digit-string arithmetic as rewrite rules.
 *
 * Numbers are least-significant-first lists of nat numerals
 * (`list.cons(digit, rest)` / `list.nil`), so column arithmetic happens on
 * the symbols humans use: addition with carry, borrowing subtraction,
 * schoolbook multiplication. Single digits combine through the nat deck's
 * add/sub/ge/eq rules and the constant `nat.ten` — the engine's only
 * natives are matching, substitution, ite, and fuel, so even the carry is
 * a rule.
 *
 * Registration order is the priority order: the base and normalization
 * cases precede the recursive column rules. Sub is only defined for x >= y;
 * an underflow is simply stuck (no rule matches) — decline, never wrong.
 */

import { natFromDecimal, natToDecimal } from './peano';
import { tLit, tSym, termBits, tVar, type Term } from './terms';
import type { RewriteRule } from './types';

const z = tSym('nat.z');
const s = (t: Term): Term => tSym('nat.s', [t]);
const nil = tSym('list.nil');
const cons = (d: Term, rest: Term): Term => tSym('list.cons', [d, rest]);
const TEN = s(s(s(s(s(s(s(s(s(s(z)))))))))); // s^10(z)

const x = tVar('x');
const y = tVar('y');
const a = tVar('a');
const b = tVar('b');
const c = tVar('c');

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

const colSum = (a: Term, b: Term, c: Term): Term => tSym('nat.add', [tSym('nat.add', [a, b]), c]);
const colSumNoCarry = (a: Term, b: Term, c: Term): Term => tSym('nat.sub', [colSum(a, b, c), TEN]);

export const DIGITS_RULES: RewriteRule[] = [
  rule('dig.add', tSym('dig.add', [x, y]), tSym('dig.addc', [x, y, z])),
  // addc: (nil, nil) — done; spill a final carry as a new digit.
  rule('dig.addc-nn', tSym('dig.addc', [nil, nil, c]), tSym('ite', [tSym('nat.eq', [c, z]), nil, cons(s(z), nil)])),
  // addc: (nil, y) — normalize to (y, nil).
  rule('dig.addc-ny', tSym('dig.addc', [nil, y, c]), tSym('dig.addc', [y, nil, c])),
  // addc: (cons, nil) — the right side has no digit (treat as zero).
  rule(
    'dig.addc-cn',
    tSym('dig.addc', [cons(a, x), nil, c]),
    tSym('ite', [
      tSym('nat.ge', [colSum(a, z, c), TEN]),
      cons(colSumNoCarry(a, z, c), tSym('dig.addc', [x, nil, s(z)])),
      cons(colSum(a, z, c), tSym('dig.addc', [x, nil, z]))
    ])
  ),
  // addc: (cons, cons) — the column: a + b + carry, spill 10 as the carry.
  rule(
    'dig.addc-cc',
    tSym('dig.addc', [cons(a, x), cons(b, y), c]),
    tSym('ite', [
      tSym('nat.ge', [colSum(a, b, c), TEN]),
      cons(colSumNoCarry(a, b, c), tSym('dig.addc', [x, y, s(z)])),
      cons(colSum(a, b, c), tSym('dig.addc', [x, y, z]))
    ])
  ),
  // sub: borrow c in {z, s(z)}; an underflow (x < y) has no rule — stuck.
  rule('dig.sub', tSym('dig.sub', [x, y]), tSym('dig.subc', [x, y, z])),
  rule(
    'dig.subc-cc',
    tSym('dig.subc', [cons(a, x), cons(b, y), c]),
    tSym('ite', [
      tSym('nat.lt', [a, tSym('nat.add', [b, c])]),
      cons(
        tSym('nat.sub', [tSym('nat.sub', [tSym('nat.add', [TEN, a]), b]), c]),
        tSym('dig.subc', [x, y, s(z)])
      ),
      cons(tSym('nat.sub', [tSym('nat.sub', [a, b]), c]), tSym('dig.subc', [x, y, z]))
    ])
  ),
  rule(
    'dig.subc-cn',
    tSym('dig.subc', [cons(a, x), nil, c]),
    tSym('ite', [
      tSym('nat.lt', [a, c]),
      cons(tSym('nat.sub', [tSym('nat.add', [TEN, a]), c]), tSym('dig.subc', [x, nil, s(z)])),
      cons(tSym('nat.sub', [a, c]), tSym('dig.subc', [x, nil, z]))
    ])
  ),
  // subc(nil, nil, z) is done; a leftover borrow (the result went
  // negative) has NO rule — stuck, never a wrong answer.
  rule('dig.subc-nn', tSym('dig.subc', [nil, nil, z]), nil),
  // mul: schoolbook — x * (10y + b) = 10*(x*y) + x*b.
  rule('dig.mul-nil', tSym('dig.mul', [x, nil]), nil),
  rule(
    'dig.mul-cons',
    tSym('dig.mul', [x, cons(b, y)]),
    tSym('dig.add', [tSym('dig.shift1', [tSym('dig.mul', [x, y])]), tSym('dig.mul1', [x, b])])
  ),
  // mul1: x*b by counting the digit b down — the recursion terminates
  // because b shrinks structurally.
  rule('dig.mul1-z', tSym('dig.mul1', [x, z]), nil),
  rule('dig.mul1-s', tSym('dig.mul1', [x, s(b)]), tSym('dig.add', [x, tSym('dig.mul1', [x, b])])),
  rule('dig.shift1', tSym('dig.shift1', [x]), cons(z, x))
];

/** The digit list for a non-negative integer (least-significant first). */
export function digitsFromDecimal(n: number): Term {
  if (!Number.isInteger(n) || n < 0) throw new Error(`digitsFromDecimal: expected a non-negative integer, got ${n}`);
  if (n === 0) return cons(z, nil);
  const digits: Term[] = [];
  let value = n;
  while (value > 0) {
    digits.push(natFromDecimal(value % 10));
    value = Math.floor(value / 10);
  }
  // digits[0] is the units digit — build the least-significant-first list
  // from the tail so the first cons carries the units.
  let rest: Term = nil;
  for (let i = digits.length - 1; i >= 0; i -= 1) rest = cons(digits[i], rest);
  return rest;
}

/** The integer a digit list denotes (leading zeros allowed), or null. */
export function digitsToDecimal(term: Term): number | null {
  let value = 0;
  let place = 1;
  let node: Term = term;
  for (;;) {
    if (node.t === 'sym' && node.head === 'list.nil' && node.args.length === 0) return value;
    if (node.t !== 'sym' || node.head !== 'list.cons' || node.args.length !== 2) return null;
    const digit = natToDecimal(node.args[0]);
    if (digit === null || digit > 9) return null;
    value += digit * place;
    place *= 10;
    node = node.args[1];
  }
}
