/**
 * RAT — exact rationals as a pair of naturals, and the decimals that are
 * rationals in disguise (docs/TASKS.md #67).
 *
 * Everything above this file has been whole-number arithmetic: the word
 * problems that say "2.5 liters" or "one-fourth of a barrel" have been
 * declined, division has been refused whenever it was inexact, and percent,
 * speed and density have only ever answered the cases that happened to come
 * out even. A rational is the smallest thing that fixes all of those at
 * once, and it needs no new native: a value is `rat.q(numerator,
 * denominator)` over two nat numerals, and every operation is a rule.
 *
 * NORMALISED, ALWAYS. `rat.norm` divides both parts by their gcd after
 * every operation, so a value has ONE representation — 5/10 and 1/2 are the
 * same term, and the decoder can say "0.5" without wondering. That is what
 * makes `rat.eq` structural equality and keeps the numerals small enough for
 * unary arithmetic to stay inside its fuel.
 *
 * THE GCD IS AUTHORED HERE. `nat.gcd` was referenced by the drill parser and
 * authored nowhere — it existed only as a rule the observer might induce
 * from exercises. Euclid's algorithm is the example the engine's lazy `ite`
 * was built for (see rules/engine.ts): an eager strategy would reduce the
 * recursive branch even when the base case fires, and diverge.
 *
 * A DIVISION BY ZERO IS NOT A VALUE. `rat.div` by zero reduces to
 * `rat.undefined`, a symbol with no rules and no decoding — so it is stuck,
 * and a stuck term is an honest decline rather than a fabricated answer.
 */

import { natFromDecimal, natToDecimal } from './peano';
import { tSym, termBits, tVar, type Term } from './terms';
import type { RewriteRule } from './types';

const z = tSym('nat.z');
const x = tVar('x');
const y = tVar('y');
const a = tVar('a');
const b = tVar('b');
const c = tVar('c');
const d = tVar('d');

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

const q = (numerator: Term, denominator: Term): Term => tSym('rat.q', [numerator, denominator]);
const gcd = (left: Term, right: Term): Term => tSym('nat.gcd', [left, right]);
const add = (left: Term, right: Term): Term => tSym('nat.add', [left, right]);
const sub = (left: Term, right: Term): Term => tSym('nat.sub', [left, right]);
const mul = (left: Term, right: Term): Term => tSym('nat.mul', [left, right]);
const div = (left: Term, right: Term): Term => tSym('nat.div', [left, right]);
const eq = (left: Term, right: Term): Term => tSym('nat.eq', [left, right]);
const mod = (left: Term, right: Term): Term => tSym('nat.mod', [left, right]);
const ite = (condition: Term, then: Term, otherwise: Term): Term => tSym('ite', [condition, then, otherwise]);

/** A term nothing reduces and nothing decodes: the honest end of 1/0. */
export const RAT_UNDEFINED = tSym('rat.undefined');

export const RAT_RULES: RewriteRule[] = [
  // ── gcd (Euclid) ──────────────────────────────────────────────────────
  // gcd(a, 0) = a is the base case; the recursive case only fires when the
  // ite has already chosen it, which is why laziness is load-bearing.
  rule('nat.gcd-z', gcd(x, z), x),
  rule('nat.gcd-xy', gcd(x, y), ite(eq(y, z), x, gcd(y, mod(x, y)))),

  // ── normalisation ─────────────────────────────────────────────────────
  // A zero numerator is zero whatever the denominator says.
  rule('rat.norm-zero', tSym('rat.norm', [q(z, y)]), q(z, tSym('nat.s', [z]))),
  rule('rat.norm', tSym('rat.norm', [q(x, y)]), q(div(x, gcd(x, y)), div(y, gcd(x, y)))),

  // ── arithmetic ────────────────────────────────────────────────────────
  // a/b + c/d = (ad + cb) / bd, normalised.
  rule('rat.add', tSym('rat.add', [q(a, b), q(c, d)]), tSym('rat.norm', [q(add(mul(a, d), mul(c, b)), mul(b, d))])),
  // a/b − c/d = (ad − cb) / bd. An underflow leaves nat.sub stuck, which is
  // the decline the naturals have always given: no negative rationals here.
  rule('rat.sub', tSym('rat.sub', [q(a, b), q(c, d)]), tSym('rat.norm', [q(sub(mul(a, d), mul(c, b)), mul(b, d))])),
  rule('rat.mul', tSym('rat.mul', [q(a, b), q(c, d)]), tSym('rat.norm', [q(mul(a, c), mul(b, d))])),
  // a/b ÷ c/d = ad / bc — and division by zero is not a value.
  rule('rat.div', tSym('rat.div', [q(a, b), q(c, d)]), ite(eq(c, z), RAT_UNDEFINED, tSym('rat.norm', [q(mul(a, d), mul(b, c))]))),

  // ── comparison, for the guards that need it ───────────────────────────
  rule('rat.lt', tSym('rat.lt', [q(a, b), q(c, d)]), tSym('nat.lt', [mul(a, d), mul(c, b)])),
  rule('rat.eq', tSym('rat.eq', [q(a, b), q(c, d)]), eq(mul(a, d), mul(c, b)))
];

/** The greatest common divisor, for building normalised terms directly. */
export function gcdOf(left: number, right: number): number {
  let a0 = Math.abs(Math.trunc(left));
  let b0 = Math.abs(Math.trunc(right));
  while (b0 > 0) {
    const next = a0 % b0;
    a0 = b0;
    b0 = next;
  }
  return a0 === 0 ? 1 : a0;
}

/** An exact rational, always normalised, denominator ≥ 1. */
export interface Rational {
  numerator: number;
  denominator: number;
}

export function rational(numerator: number, denominator = 1): Rational {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return { numerator: 0, denominator: 1 };
  const sign = denominator < 0 ? -1 : 1;
  const n = Math.trunc(numerator) * sign;
  const d = Math.abs(Math.trunc(denominator));
  const g = gcdOf(n, d);
  return { numerator: n / g, denominator: d / g };
}

/**
 * A decimal string or number as an exact rational: "2.5" → 5/2, "0.25" →
 * 1/4. Float arithmetic never enters — the digits after the point ARE the
 * numerator's tail, which is why 0.1 + 0.2 is 3/10 here and not
 * 0.30000000000000004.
 */
export function rationalFromDecimal(value: string | number): Rational | null {
  const text = typeof value === 'number' ? String(value) : value.trim();
  const hit = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (hit === null) return null;
  const sign = hit[1] === '-' ? -1 : 1;
  const whole = hit[2];
  const fraction = hit[3] ?? '';
  const scale = 10 ** fraction.length;
  const numerator = Number(`${whole}${fraction}`);
  if (!Number.isSafeInteger(numerator)) return null;
  return rational(sign * numerator, scale);
}

/** "3/4" or "one half" style fractions the corpus writes out. */
export function rationalFromFraction(text: string): Rational | null {
  const hit = /^(-?\d+)\s*\/\s*(\d+)$/.exec(text.trim());
  if (hit !== null) {
    const denominator = Number(hit[2]);
    if (denominator === 0) return null;
    return rational(Number(hit[1]), denominator);
  }
  const named: Record<string, [number, number]> = {
    half: [1, 2],
    'a half': [1, 2],
    'one half': [1, 2],
    'one-half': [1, 2],
    third: [1, 3],
    'a third': [1, 3],
    'one third': [1, 3],
    'one-third': [1, 3],
    quarter: [1, 4],
    'a quarter': [1, 4],
    'one quarter': [1, 4],
    'one-quarter': [1, 4],
    'one fourth': [1, 4],
    'one-fourth': [1, 4],
    'three quarters': [3, 4],
    'three-quarters': [3, 4],
    'two thirds': [2, 3],
    'two-thirds': [2, 3]
  };
  const pair = named[text.trim().toLowerCase()];
  return pair === undefined ? null : rational(pair[0], pair[1]);
}

/** The engine term for a rational (non-negative only: the deck has no sign). */
export function ratTerm(value: Rational): Term | null {
  if (value.numerator < 0) return null;
  return q(natFromDecimal(value.numerator), natFromDecimal(value.denominator));
}

/**
 * How a rational is SAID. A whole number speaks as itself; a fraction whose
 * denominator divides a power of ten speaks as an exact decimal ("2.5",
 * "0.125"); anything else keeps its fraction ("1/3"), because rounding it
 * would be asserting a number the observer did not derive.
 */
export function sayRational(value: Rational): string {
  const { numerator, denominator } = rational(value.numerator, value.denominator);
  if (denominator === 1) return String(numerator);
  let d = denominator;
  let twos = 0;
  let fives = 0;
  while (d % 2 === 0) {
    d /= 2;
    twos += 1;
  }
  while (d % 5 === 0) {
    d /= 5;
    fives += 1;
  }
  if (d !== 1) return `${numerator}/${denominator}`;
  const places = Math.max(twos, fives);
  const scaled = numerator * (10 ** places / denominator);
  if (!Number.isSafeInteger(scaled)) return `${numerator}/${denominator}`;
  const negative = scaled < 0;
  const digits = String(Math.abs(scaled)).padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction.length > 0 ? `.${fraction}` : ''}`;
}

/** Read a `rat.q` normal form back out of the engine. */
export function ratToDecimal(term: Term): string | null {
  if (term.t !== 'sym' || term.head !== 'rat.q' || term.args.length !== 2) return null;
  const numerator = natToDecimal(term.args[0]);
  const denominator = natToDecimal(term.args[1]);
  if (numerator === null || denominator === null || denominator === 0) return null;
  return sayRational({ numerator, denominator });
}

// ── exact arithmetic on Rational, for the readers' own guards ───────────
export const ratAdd = (l: Rational, r: Rational): Rational => rational(l.numerator * r.denominator + r.numerator * l.denominator, l.denominator * r.denominator);
export const ratSub = (l: Rational, r: Rational): Rational => rational(l.numerator * r.denominator - r.numerator * l.denominator, l.denominator * r.denominator);
export const ratMul = (l: Rational, r: Rational): Rational => rational(l.numerator * r.numerator, l.denominator * r.denominator);
export const ratDiv = (l: Rational, r: Rational): Rational | null =>
  r.numerator === 0 ? null : rational(l.numerator * r.denominator, l.denominator * r.numerator);
export const ratIsNegative = (value: Rational): boolean => value.numerator < 0;
export const ratIsWhole = (value: Rational): boolean => rational(value.numerator, value.denominator).denominator === 1;
export const ratToNumber = (value: Rational): number => value.numerator / value.denominator;
