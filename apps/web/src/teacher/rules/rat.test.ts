/**
 * THE RATIONALS DECK (docs/TASKS.md #67).
 *
 * Everything above this file was whole numbers: a story that said "2.5
 * liters" was declined, and a division that did not come out even was
 * refused. What is being tested here is that the deck is EXACT — not that
 * it is close. 0.1 + 0.2 is three tenths, not 0.30000000000000004, because
 * the tenths never become floats; a value has one normalised form, so 5/10
 * and 1/2 are the same term; and 1 ÷ 0 is a stuck term, which is how the
 * engine declines rather than inventing a number.
 */
import { describe, expect, test } from '@jest/globals';
import { reduce } from './engine';
import { PEANO_RULES, natFromDecimal, natToDecimal } from './peano';
import { DIGITS_RULES } from './digits';
import {
  RAT_RULES,
  gcdOf,
  ratAdd,
  ratDiv,
  ratIsWhole,
  ratSub,
  ratTerm,
  ratToDecimal,
  rational,
  rationalFromDecimal,
  rationalFromFraction,
  sayRational
} from './rat';
import { tSym, type Term } from './terms';
import { RuleStore } from './types';

const store = (): RuleStore => new RuleStore([...PEANO_RULES, ...DIGITS_RULES, ...RAT_RULES]);

/** The value the engine derives, said as the observer would say it. */
const derived = (term: Term, fuel = 200_000): string | null => {
  const { outcome } = reduce(store(), term, { fuel });
  return outcome.status === 'normal' ? ratToDecimal(outcome.term) : null;
};

const q = (numerator: number, denominator: number): Term => ratTerm(rational(numerator, denominator)) as Term;
const op = (head: string, a: Term, b: Term): Term => tSym(head, [a, b]);

describe('rationals — exact, and normalised after every step', () => {
  test('a tenth plus two tenths is three tenths, not a float', () => {
    // The reason the deck exists. In doubles 0.1 + 0.2 is
    // 0.30000000000000004; here the tenths are a pair of naturals and the
    // answer is the pair 3/10, which SAYS "0.3".
    expect(derived(op('rat.add', q(1, 10), q(2, 10)))).toBe('0.3');
    expect(ratAdd(rational(1, 10), rational(2, 10))).toEqual({ numerator: 3, denominator: 10 });
  });

  test('the decimals the corpus writes', () => {
    expect(derived(op('rat.add', q(5, 2), q(3, 1)))).toBe('5.5');
    expect(derived(op('rat.sub', q(7, 1), q(5, 2)))).toBe('4.5');
    expect(derived(op('rat.mul', q(5, 2), q(4, 1)))).toBe('10');
    expect(derived(op('rat.div', q(7, 1), q(2, 1)))).toBe('3.5');
  });

  test('a fraction with no exact decimal keeps its fraction', () => {
    // Saying "0.83" would be asserting a number the observer did not
    // derive. Five sixths is the answer, so five sixths is what it says.
    expect(derived(op('rat.add', q(1, 2), q(1, 3)))).toBe('5/6');
    expect(sayRational(rational(1, 3))).toBe('1/3');
    expect(sayRational(rational(1, 8))).toBe('0.125');
    expect(sayRational(rational(4, 2))).toBe('2');
  });

  test('one representation per value: 5/10 and 1/2 are the same term', () => {
    // `ratTerm` normalises on the way in, and `rat.norm` normalises on the
    // way out, so a value has one form and equality can be decided.
    expect(derived(tSym('rat.norm', [tSym('rat.q', [natFromDecimal(5), natFromDecimal(10)])]))).toBe('0.5');
    const { outcome } = reduce(store(), op('rat.eq', q(5, 10), q(1, 2)), { fuel: 200_000 });
    expect(outcome.status === 'normal' && outcome.term.t === 'lit' ? outcome.term.value : null).toBe(true);
  });

  test('division by zero is not a value — the term is stuck', () => {
    expect(ratDiv(rational(5, 1), rational(0, 1))).toBe(null);
    const { outcome } = reduce(store(), op('rat.div', q(5, 1), q(0, 1)), { fuel: 200_000 });
    // It reduces to `rat.undefined`, which nothing decodes: an honest
    // decline instead of a fabricated answer.
    expect(ratToDecimal(outcome.status === 'normal' ? outcome.term : q(0, 1))).toBe(null);
  });

  test('no negatives: a subtraction below zero stays stuck', () => {
    expect(derived(op('rat.sub', q(5, 2), q(7, 1)))).toBe(null);
    expect(ratSub(rational(5, 2), rational(7, 1)).numerator).toBeLessThan(0);
    expect(ratTerm(rational(-1, 2))).toBe(null);
  });

  test('the rationals have their own gcd, and it is Euclid', () => {
    expect(gcdOf(105, 2)).toBe(1);
    expect(gcdOf(48, 18)).toBe(6);
    // It is `rat.gcd`, deliberately NOT `nat.gcd`: that symbol is the
    // greatest-common-factor family the observer is supposed to INDUCE from
    // graded exercises, and authoring it deletes the capability claim (see
    // the header of rat.ts). The recursive case only terminates because
    // `ite` is lazy (see rules/engine.ts).
    const { outcome } = reduce(store(), tSym('rat.gcd', [natFromDecimal(48), natFromDecimal(18)]), { fuel: 200_000 });
    expect(outcome.status === 'normal' ? natToDecimal(outcome.term) : null).toBe(6);
  });

  test('and it does NOT author nat.gcd — the induction target is left alone', () => {
    // The regression this pins: for one day the rationals deck authored
    // `nat.gcd`, so "what is the greatest common factor of 48 and 36"
    // derived through the deck. Seven tests across honesty, the math bench,
    // the chaperone supply and the analysis-defect suite depend on that
    // family being learnable rather than given.
    expect(RAT_RULES.some((rule) => rule.lhs.t === 'sym' && rule.lhs.head === 'nat.gcd')).toBe(false);
    const { outcome } = reduce(store(), tSym('nat.gcd', [natFromDecimal(48), natFromDecimal(36)]), { fuel: 10_000 });
    // Nothing reduces it: the term is stuck until the observer induces a rule.
    expect(outcome.status === 'normal' && outcome.term.t === 'sym' ? outcome.term.head : null).toBe('nat.gcd');
  });

  test('reading decimals and fractions out of the corpus text', () => {
    expect(rationalFromDecimal('2.5')).toEqual({ numerator: 5, denominator: 2 });
    expect(rationalFromDecimal('0.25')).toEqual({ numerator: 1, denominator: 4 });
    expect(rationalFromDecimal('12')).toEqual({ numerator: 12, denominator: 1 });
    expect(rationalFromDecimal('a lot')).toBe(null);
    expect(rationalFromFraction('3/4')).toEqual({ numerator: 3, denominator: 4 });
    expect(rationalFromFraction('two thirds')).toEqual({ numerator: 2, denominator: 3 });
    expect(rationalFromFraction('3/0')).toBe(null);
  });

  test('wholeness is a property of the value, not of how it was written', () => {
    expect(ratIsWhole(rational(4, 2))).toBe(true);
    expect(ratIsWhole(rational(5, 2))).toBe(false);
  });
});
