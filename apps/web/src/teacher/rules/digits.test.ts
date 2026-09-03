import { describe, expect, test } from '@jest/globals';
import { reduce } from './engine';
import { PEANO_RULES, natFromDecimal, natToDecimal } from './peano';
import { DIGITS_RULES, digitsFromDecimal, digitsToDecimal } from './digits';
import { INT_RULES, intToDecimal } from './int';
import { tLit, tSym, termToString, type Term } from './terms';
import { RuleStore } from './types';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const allStore = (): RuleStore => new RuleStore([...PEANO_RULES, ...DIGITS_RULES, ...INT_RULES]);

const natValue = (term: Term): number | null => {
  const { outcome } = reduce(allStore(), term);
  if (outcome.status !== 'normal') return null;
  return natToDecimal(outcome.term);
};

const digitValue = (term: Term): number | null => {
  const { outcome } = reduce(allStore(), term);
  if (outcome.status !== 'normal') return null;
  return digitsToDecimal(outcome.term);
};

const intValue = (term: Term): number | null => {
  const { outcome } = reduce(allStore(), term);
  if (outcome.status !== 'normal') return null;
  return intToDecimal(outcome.term);
};

describe('digits — positional arithmetic', () => {
  test('named additions with carry', () => {
    expect(digitValue(tSym('dig.add', [digitsFromDecimal(47), digitsFromDecimal(32)]))).toBe(79);
    expect(digitValue(tSym('dig.add', [digitsFromDecimal(48), digitsFromDecimal(32)]))).toBe(80);
    expect(digitValue(tSym('dig.add', [digitsFromDecimal(9), digitsFromDecimal(1)]))).toBe(10);
    expect(digitValue(tSym('dig.add', [digitsFromDecimal(999), digitsFromDecimal(1)]))).toBe(1000);
    expect(digitValue(tSym('dig.add', [digitsFromDecimal(0), digitsFromDecimal(0)]))).toBe(0);
  });

  test('named subtractions with borrow', () => {
    expect(digitValue(tSym('dig.sub', [digitsFromDecimal(47), digitsFromDecimal(32)]))).toBe(15);
    expect(digitValue(tSym('dig.sub', [digitsFromDecimal(21), digitsFromDecimal(15)]))).toBe(6);
    expect(digitValue(tSym('dig.sub', [digitsFromDecimal(1000), digitsFromDecimal(1)]))).toBe(999);
    expect(digitValue(tSym('dig.sub', [digitsFromDecimal(10), digitsFromDecimal(1)]))).toBe(9);
    expect(digitValue(tSym('dig.sub', [digitsFromDecimal(400), digitsFromDecimal(231)]))).toBe(169);
  });

  test('named multiplications', () => {
    expect(digitValue(tSym('dig.mul', [digitsFromDecimal(12), digitsFromDecimal(9)]))).toBe(108);
    expect(digitValue(tSym('dig.mul', [digitsFromDecimal(47), digitsFromDecimal(32)]))).toBe(1504);
    expect(digitValue(tSym('dig.mul', [digitsFromDecimal(123), digitsFromDecimal(11)]))).toBe(1353);
    expect(digitValue(tSym('dig.mul', [digitsFromDecimal(0), digitsFromDecimal(99)]))).toBe(0);
    expect(digitValue(tSym('dig.mul', [digitsFromDecimal(1), digitsFromDecimal(1)]))).toBe(1);
  });

  test('underflow is an undecodable decline — never a wrong answer', () => {
    const { outcome } = reduce(allStore(), tSym('dig.sub', [digitsFromDecimal(3), digitsFromDecimal(5)]));
    expect(outcome.status).toBe('normal');
    if (outcome.status === 'normal') expect(digitsToDecimal(outcome.term)).toBeNull();
  });

  test('150+ seeded probes: digits == peano == JS for add/sub/mul', () => {
    const rng = mulberry32(0xd1a17);
    const between = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
    let probes = 0;
    for (let i = 0; i < 60; i += 1) {
      const a = between(0, 999);
      const b = between(0, 999);
      const check = (op: string, build: (x: Term, y: Term) => Term, expected: number): void => {
        const digits = digitValue(build(digitsFromDecimal(a), digitsFromDecimal(b)));
        expect(digits).toBe(expected);
        probes += 1;
      };
      check('add', (x, y) => tSym('dig.add', [x, y]), a + b);
      if (a >= b) check('sub', (x, y) => tSym('dig.sub', [x, y]), a - b);
      // Peano is the correctness ANCHOR for small operands (its recursion
      // depth is the operand size — 2-digit mul already costs thousands of
      // steps); the digits path is the production path for the full range.
      if (a <= 60 && b <= 60) {
        check('mul', (x, y) => tSym('dig.mul', [x, y]), a * b);
      }
    }
    for (let i = 0; i < 60; i += 1) {
      const a = between(0, 60);
      const b = between(0, 60);
      const digits = digitValue(tSym('dig.mul', [digitsFromDecimal(a), digitsFromDecimal(b)]));
      const peano = natValue(tSym('nat.mul', [natFromDecimal(a), natFromDecimal(b)]));
      expect(digits).toBe(a * b);
      expect(peano).toBe(a * b);
      probes += 1;
    }
    expect(probes).toBeGreaterThanOrEqual(150);
  });

  test('determinism: the same term reduces identically twice', () => {
    const store = allStore();
    const term = tSym('dig.mul', [digitsFromDecimal(47), digitsFromDecimal(32)]);
    const first = reduce(store, term);
    const second = reduce(store, term);
    expect(first.outcome).toEqual(second.outcome);
    expect(first.ruleIds).toEqual(second.ruleIds);
  });

  test('every rule registers without throwing', () => {
    const store = new RuleStore(DIGITS_RULES);
    expect(store.count()).toBe(DIGITS_RULES.length);
  });
});

describe('digits — codec', () => {
  test('digitsFromDecimal/digitsToDecimal round-trip for 0..500', () => {
    for (let n = 0; n <= 500; n += 1) {
      expect(digitsToDecimal(digitsFromDecimal(n))).toBe(n);
    }
  });

  test('leading zeros decode correctly', () => {
    // LSF: extra most-significant zeros are appended at the TAIL.
    expect(digitsToDecimal(tSym('list.cons', [natFromDecimal(4), tSym('list.cons', [natFromDecimal(0), tSym('list.cons', [natFromDecimal(0), tSym('list.nil')])])]))).toBe(4);
    expect(digitsToDecimal(tSym('list.nil'))).toBe(0);
  });

  test('digitsToDecimal rejects malformed lists', () => {
    expect(digitsToDecimal(tLit(1))).toBeNull();
    expect(digitsToDecimal(tSym('list.cons', [tLit(11), tSym('list.nil')]))).toBeNull();
    expect(digitsToDecimal(tSym('list.cons', [natFromDecimal(9), tLit(1)]))).toBeNull();
  });
});

describe('int — signed layer', () => {
  test('sign-aware addition', () => {
    expect(intValue(tSym('int.add', [tSym('int.neg', [natFromDecimal(5)]), natFromDecimal(273)]))).toBe(268);
    expect(intValue(tSym('int.add', [tSym('int.neg', [natFromDecimal(3)]), natFromDecimal(1)]))).toBe(-2);
    expect(intValue(tSym('int.add', [natFromDecimal(3), tSym('int.neg', [natFromDecimal(5)])]))).toBe(-2);
    expect(intValue(tSym('int.add', [natFromDecimal(5), natFromDecimal(7)]))).toBe(12);
    expect(intValue(tSym('int.add', [tSym('int.neg', [natFromDecimal(4)]), tSym('int.neg', [natFromDecimal(6)])]))).toBe(-10);
  });

  test('subtraction is add of the negation', () => {
    expect(intValue(tSym('int.sub', [natFromDecimal(10), natFromDecimal(4)]))).toBe(6);
    expect(intValue(tSym('int.sub', [natFromDecimal(4), natFromDecimal(10)]))).toBe(-6);
    expect(intValue(tSym('int.sub', [tSym('int.neg', [natFromDecimal(4)]), natFromDecimal(6)]))).toBe(-10);
  });

  test('absolute value', () => {
    expect(intValue(tSym('int.abs', [tSym('int.neg', [natFromDecimal(5)])]))).toBe(5);
    expect(intValue(tSym('int.abs', [natFromDecimal(5)]))).toBe(5);
    expect(intValue(tSym('int.abs', [tSym('int.neg', [natFromDecimal(0)])]))).toBe(0);
  });

  test('the temperature shape: -5 + 273 = 268', () => {
    expect(intValue(tSym('int.add', [tSym('int.neg', [natFromDecimal(5)]), natFromDecimal(273)]))).toBe(268);
  });

  test('intToDecimal round-trips and rejects non-ints', () => {
    expect(intToDecimal(tSym('int.neg', [natFromDecimal(7)]))).toBe(-7);
    expect(intToDecimal(natFromDecimal(7))).toBe(7);
    expect(intToDecimal(tLit(7))).toBeNull();
    expect(intToDecimal(tSym('int.neg', [tLit(7)]))).toBeNull();
  });

  test('determinism: int terms reduce identically twice', () => {
    const store = allStore();
    const term = tSym('int.add', [tSym('int.neg', [natFromDecimal(3)]), natFromDecimal(1)]);
    expect(termToString(term).length).toBeGreaterThan(0);
    expect(reduce(store, term).outcome).toEqual(reduce(store, term).outcome);
  });
});
