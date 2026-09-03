/**
 * INT — signed integers as a wrapper over naturals.
 *
 * A signed value is either a nat numeral (non-negative) or `int.neg(n)`
 * wrapping a numeral. Sign-aware addition, subtraction, and absolute value
 * are rules — the sign logic is derived, not a native. Registration order
 * is the priority order: the neg-pattern rules precede the plain numeral
 * rule, so an int term always picks the sign-aware branch.
 */

import { natToDecimal } from './peano';
import { tLit, tSym, termBits, tVar, type Term } from './terms';
import type { RewriteRule } from './types';

const z = tSym('nat.z');
const s = (t: Term): Term => tSym('nat.s', [t]);
const x = tVar('x');
const y = tVar('y');

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

export const INT_RULES: RewriteRule[] = [
  // Double negation cancels — completes int.sub for negative operands
  // (−58 −(−10) previously produced a malformed wrapped normal form).
  rule('int.neg-neg', tSym('int.neg', [tSym('int.neg', [x])]), x),
  // add: same signs — keep the sign.
  rule('int.add-nn', tSym('int.add', [tSym('int.neg', [x]), tSym('int.neg', [y])]), tSym('int.neg', [tSym('nat.add', [x, y])])),
  // add: one negative — subtract the smaller from the larger, sign follows.
  rule(
    'int.add-np',
    tSym('int.add', [tSym('int.neg', [x]), y]),
    tSym('ite', [
      tSym('nat.lt', [y, x]),
      tSym('int.neg', [tSym('nat.sub', [x, y])]),
      tSym('nat.sub', [y, x])
    ])
  ),
  // add: negative on the right — commute to the rule above.
  rule('int.add-pn', tSym('int.add', [x, tSym('int.neg', [y])]), tSym('int.add', [tSym('int.neg', [y]), x])),
  // add: both non-negative — the naturals just add.
  rule('int.add-pp', tSym('int.add', [x, y]), tSym('nat.add', [x, y])),
  // sub: subtract is add of the negated second operand.
  rule('int.sub', tSym('int.sub', [x, y]), tSym('int.add', [x, tSym('int.neg', [y])])),
  // abs: the sign wrapper falls away; numerals stay.
  rule('int.abs-z', tSym('int.abs', [z]), z),
  rule('int.abs-neg', tSym('int.abs', [tSym('int.neg', [x])]), x),
  rule('int.abs-s', tSym('int.abs', [s(x)]), s(x))
];

/** The integer a term denotes (int.neg wrapping a numeral, or a numeral),
 *  or null when the term is not a signed natural. */
export function intToDecimal(term: Term): number | null {
  if (term.t !== 'sym') return null;
  if (term.head === 'int.neg' && term.args.length === 1) {
    const value = natToDecimal(term.args[0]);
    return value === null ? null : -value;
  }
  return natToDecimal(term);
}
