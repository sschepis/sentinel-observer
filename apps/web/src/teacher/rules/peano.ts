/**
 * PEANO — the authored natural-number rule deck.
 *
 * Constructors are `nat.z` (nullary) and `nat.s` (unary); the functions
 * `nat.add`, `nat.mul`, `nat.sub`, `nat.lt`, `nat.gt`, `nat.ge`, `nat.eq`,
 * `nat.pred`, `nat.mod`, `nat.div`, and `nat.pow` reduce to constructor
 * trees or booleans. `ite` is the engine's native conditional — `nat.mod`
 * and `nat.div` use it to decline when the divisor is zero (they loop and
 * burn the fuel budget rather than ever answer wrong).
 *
 * Priority is insertion order: base cases precede recursive cases, and the
 * recursive functions are registered after the rules they call, so the
 * leftmost-outermost engine sees each rule in the order listed below.
 */

import { tLit, tSym, tVar, termBits, type Term } from './terms';
import type { RewriteRule } from './types';

const z = tSym('nat.z')
const s = (t: Term): Term => tSym('nat.s', [t])

const x = tVar('x')
const y = tVar('y')

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
})

export const PEANO_RULES: RewriteRule[] = [
  rule('nat.add-z', tSym('nat.add', [z, y]), y),
  rule('nat.add-s', tSym('nat.add', [s(x), y]), s(tSym('nat.add', [x, y]))),
  rule('nat.mul-z', tSym('nat.mul', [z, y]), z),
  rule('nat.mul-s', tSym('nat.mul', [s(x), y]), tSym('nat.add', [y, tSym('nat.mul', [x, y])])),
  rule('nat.sub-z', tSym('nat.sub', [x, z]), x),
  rule('nat.sub-s', tSym('nat.sub', [s(x), s(y)]), tSym('nat.sub', [x, y])),
  rule('nat.lt-zz', tSym('nat.lt', [z, z]), tLit(false)),
  rule('nat.lt-zs', tSym('nat.lt', [z, s(y)]), tLit(true)),
  rule('nat.lt-sz', tSym('nat.lt', [s(x), z]), tLit(false)),
  rule('nat.lt-ss', tSym('nat.lt', [s(x), s(y)]), tSym('nat.lt', [x, y])),
  rule('nat.gt-xy', tSym('nat.gt', [x, y]), tSym('nat.lt', [y, x])),
  rule('nat.ge-zz', tSym('nat.ge', [z, z]), tLit(true)),
  rule('nat.ge-sz', tSym('nat.ge', [s(x), z]), tLit(true)),
  rule('nat.ge-zs', tSym('nat.ge', [z, s(y)]), tLit(false)),
  rule('nat.ge-ss', tSym('nat.ge', [s(x), s(y)]), tSym('nat.ge', [x, y])),
  rule('nat.eq-zz', tSym('nat.eq', [z, z]), tLit(true)),
  rule('nat.eq-sz', tSym('nat.eq', [s(x), z]), tLit(false)),
  rule('nat.eq-zs', tSym('nat.eq', [z, s(y)]), tLit(false)),
  rule('nat.eq-ss', tSym('nat.eq', [s(x), s(y)]), tSym('nat.eq', [x, y])),
  rule('nat.pred-s', tSym('nat.pred', [s(x)]), x),
  rule('nat.mod-xy', tSym('nat.mod', [x, y]), tSym('ite', [tSym('nat.lt', [x, y]), x, tSym('nat.mod', [tSym('nat.sub', [x, y]), y])])),
  rule('nat.div-xy', tSym('nat.div', [x, y]), tSym('ite', [tSym('nat.lt', [x, y]), z, s(tSym('nat.div', [tSym('nat.sub', [x, y]), y]))])),
  rule('nat.pow-z', tSym('nat.pow', [x, z]), s(z)),
  rule('nat.pow-s', tSym('nat.pow', [x, s(y)]), tSym('nat.mul', [x, tSym('nat.pow', [x, y])]))
]

/** The Peano numeral for a non-negative integer: s^n(z). */
export function natFromDecimal(n: number): Term {
  if (!Number.isInteger(n) || n < 0) throw new Error(`natFromDecimal: expected a non-negative integer, got ${n}`)
  let term: Term = z
  for (let i = 0; i < n; i += 1) term = s(term)
  return term
}

/** The integer a pure Peano numeral denotes, or null when the term is not
 *  a chain of `nat.s` ending in `nat.z`. */
export function natToDecimal(term: Term): number | null {
  let count = 0
  let node: Term = term
  for (;;) {
    if (node.t === 'sym' && node.head === 'nat.z' && node.args.length === 0) return count
    if (node.t !== 'sym' || node.head !== 'nat.s' || node.args.length !== 1) return null
    count += 1
    node = node.args[0]
  }
}
