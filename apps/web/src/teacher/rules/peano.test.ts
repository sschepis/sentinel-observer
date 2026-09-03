import { describe, expect, test } from '@jest/globals';
import { reduce } from './engine';
import { PEANO_RULES, natFromDecimal, natToDecimal } from './peano';
import { tLit, tSym, type Term } from './terms';
import { RuleStore, type RewriteOutcome } from './types';

/** Deterministic PRNG — a seeded run must reproduce exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const freshStore = (): RuleStore => new RuleStore(PEANO_RULES);

const evalNum = (term: Term): number | null => {
  const { outcome } = reduce(freshStore(), term);
  if (outcome.status !== 'normal') return null;
  return natToDecimal(outcome.term);
};

const evalBool = (term: Term): boolean | null => {
  const { outcome } = reduce(freshStore(), term);
  if (outcome.status !== 'normal') return null;
  return outcome.term.t === 'lit' && typeof outcome.term.value === 'boolean' ? outcome.term.value : null;
};

describe('peano — named verdicts', () => {
  test('add(47, 32) = 79', () => {
    expect(evalNum(tSym('nat.add', [natFromDecimal(47), natFromDecimal(32)]))).toBe(79);
  });

  test('mul(12, 9) = 108', () => {
    expect(evalNum(tSym('nat.mul', [natFromDecimal(12), natFromDecimal(9)]))).toBe(108);
  });

  test('sub(47, 32) = 15', () => {
    expect(evalNum(tSym('nat.sub', [natFromDecimal(47), natFromDecimal(32)]))).toBe(15);
  });

  test('mod(17, 5) = 2', () => {
    expect(evalNum(tSym('nat.mod', [natFromDecimal(17), natFromDecimal(5)]))).toBe(2);
  });

  test('div(17, 5) = 3', () => {
    expect(evalNum(tSym('nat.div', [natFromDecimal(17), natFromDecimal(5)]))).toBe(3);
  });

  test('pow(3, 4) = 81', () => {
    expect(evalNum(tSym('nat.pow', [natFromDecimal(3), natFromDecimal(4)]))).toBe(81);
  });

  test('lt / gt / ge / eq verdicts', () => {
    const lt = (a: number, b: number) => evalBool(tSym('nat.lt', [natFromDecimal(a), natFromDecimal(b)]));
    const gt = (a: number, b: number) => evalBool(tSym('nat.gt', [natFromDecimal(a), natFromDecimal(b)]));
    const ge = (a: number, b: number) => evalBool(tSym('nat.ge', [natFromDecimal(a), natFromDecimal(b)]));
    const eq = (a: number, b: number) => evalBool(tSym('nat.eq', [natFromDecimal(a), natFromDecimal(b)]));
    expect(lt(5, 7)).toBe(true);
    expect(lt(7, 5)).toBe(false);
    expect(lt(5, 5)).toBe(false);
    expect(gt(7, 5)).toBe(true);
    expect(gt(5, 7)).toBe(false);
    expect(gt(5, 5)).toBe(false);
    expect(ge(5, 5)).toBe(true);
    expect(ge(6, 5)).toBe(true);
    expect(ge(4, 5)).toBe(false);
    expect(eq(5, 5)).toBe(true);
    expect(eq(5, 6)).toBe(false);
    expect(eq(0, 0)).toBe(true);
    expect(lt(0, 1)).toBe(true);
    expect(ge(0, 0)).toBe(true);
  });
});

describe('peano — seeded random probes', () => {
  test('200+ probes reduce to the JS value', () => {
    const rng = mulberry32(0x5eed);
    const store = freshStore();
    const between = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
    let probes = 0;
    for (let i = 0; i < 60; i += 1) {
      const a = between(0, 60);
      const b = between(0, 60);
      const check = (op: string, term: Term, expected: number): void => {
        const { outcome } = reduce(store, term);
        expect(outcome.status).toBe('normal');
        if (outcome.status === 'normal') expect(natToDecimal(outcome.term)).toBe(expected);
        probes += 1;
      };
      check('add', tSym('nat.add', [natFromDecimal(a), natFromDecimal(b)]), a + b);
      check('mul', tSym('nat.mul', [natFromDecimal(a), natFromDecimal(b)]), a * b);
      if (a >= b) check('sub', tSym('nat.sub', [natFromDecimal(a), natFromDecimal(b)]), a - b);
      if (b > 0) {
        check('div', tSym('nat.div', [natFromDecimal(a), natFromDecimal(b)]), Math.floor(a / b));
        check('mod', tSym('nat.mod', [natFromDecimal(a), natFromDecimal(b)]), a % b);
      }
    }
    expect(probes).toBeGreaterThanOrEqual(200);
  });
});

describe('peano — numeral codec', () => {
  test('natToDecimal(natFromDecimal(n)) === n for 0..200', () => {
    for (let n = 0; n <= 200; n += 1) {
      expect(natToDecimal(natFromDecimal(n))).toBe(n);
    }
  });

  test('natToDecimal returns null for a non-numeral', () => {
    expect(natToDecimal(tSym('nat.add', [tSym('nat.z'), tSym('nat.z')]))).toBeNull();
    expect(natToDecimal(tLit(true))).toBeNull();
    expect(natToDecimal(tSym('nat.s'))).toBeNull();
    expect(natToDecimal(tSym('nat.z', [tSym('nat.z')]))).toBeNull();
  });

  test('natFromDecimal rejects non-negative integers', () => {
    expect(() => natFromDecimal(-1)).toThrow();
    expect(() => natFromDecimal(1.5)).toThrow();
  });
});

describe('peano — honest decline on zero divisor', () => {
  // div/mod(x, z) diverge (fuel-burn), so a bounded budget must still
  // decline — never produce a normal-form numeral.
  const LOW_FUEL = 400;

  test.each([0, 1, 5, 17, 60])('div(%i, 0) never answers normally', (a) => {
    const { outcome } = reduce(freshStore(), tSym('nat.div', [natFromDecimal(a), natFromDecimal(0)]), { fuel: LOW_FUEL });
    expect(outcome.status).not.toBe('normal');
  });

  test.each([0, 1, 5, 17, 60])('mod(%i, 0) never answers normally', (a) => {
    const { outcome } = reduce(freshStore(), tSym('nat.mod', [natFromDecimal(a), natFromDecimal(0)]), { fuel: LOW_FUEL });
    expect(outcome.status).not.toBe('normal');
  });

  test('a fuel-burned div never produces a numeral', () => {
    const { outcome } = reduce(freshStore(), tSym('nat.div', [natFromDecimal(3), natFromDecimal(0)]), { fuel: LOW_FUEL });
    expect(outcome.status).toBe('exhausted');
  });
});

describe('peano — determinism', () => {
  test('the same term reduces identically twice', () => {
    const store = freshStore();
    const term = tSym('nat.add', [natFromDecimal(33), natFromDecimal(44)]);
    const first = reduce(store, term);
    const second = reduce(store, term);
    expect(first.outcome).toEqual(second.outcome);
    expect(first.ruleIds).toEqual(second.ruleIds);
    expect(first.steps).toBe(second.steps);
  });

  test('the same mul term reduces identically twice', () => {
    const store = freshStore();
    const term = tSym('nat.mul', [natFromDecimal(9), natFromDecimal(7)]);
    const first = reduce(store, term);
    const second = reduce(store, term);
    expect(first.outcome).toEqual(second.outcome);
    expect(first.ruleIds).toEqual(second.ruleIds);
  });

  test('a repeated reduction is deterministic across stores', () => {
    const term = tSym('nat.div', [natFromDecimal(17), natFromDecimal(5)]);
    const a = reduce(freshStore(), term);
    const b = reduce(freshStore(), term);
    expect(a.outcome).toEqual(b.outcome);
    expect(a.steps).toBe(b.steps);
  });
});

describe('peano — deck registration', () => {
  test('every rule registers into a fresh store without throwing', () => {
    let store: RuleStore | undefined;
    expect(() => {
      store = new RuleStore(PEANO_RULES);
    }).not.toThrow();
    expect(store?.count()).toBe(PEANO_RULES.length);
  });

  test('rule ids are unique and every rule reduces its named symbol', () => {
    const ids = new Set(PEANO_RULES.map((r) => r.id));
    expect(ids.size).toBe(PEANO_RULES.length);
    for (const r of PEANO_RULES) {
      if (r.lhs.t === 'sym') expect(r.name).toBe(r.lhs.head);
    }
  });

  test('every deck rule is active, authored, and curriculum-sourced', () => {
    for (const r of PEANO_RULES) {
      expect(r.origin).toBe('authored');
      expect(r.strength).toBe(1);
      expect(r.sourceClasses).toEqual(['curriculum']);
      expect(r.active).toBe(true);
      expect(r.createdAt).toBe(0);
      expect(r.useCount).toBe(0);
    }
  });

  test('rule ordering: base cases precede recursive cases per symbol', () => {
    const bySymbol = (name: string): string[] => PEANO_RULES.filter((r) => r.lhs.t === 'sym' && r.lhs.head === name).map((r) => r.id);
    expect(bySymbol('nat.add')).toEqual(['nat.add-z', 'nat.add-s']);
    expect(bySymbol('nat.mul')).toEqual(['nat.mul-z', 'nat.mul-s']);
    expect(bySymbol('nat.sub')).toEqual(['nat.sub-z', 'nat.sub-s']);
    expect(bySymbol('nat.lt')).toEqual(['nat.lt-zz', 'nat.lt-zs', 'nat.lt-sz', 'nat.lt-ss']);
    expect(bySymbol('nat.ge')).toEqual(['nat.ge-zz', 'nat.ge-sz', 'nat.ge-zs', 'nat.ge-ss']);
    expect(bySymbol('nat.eq')).toEqual(['nat.eq-zz', 'nat.eq-sz', 'nat.eq-zs', 'nat.eq-ss']);
    expect(bySymbol('nat.pow')).toEqual(['nat.pow-z', 'nat.pow-s']);
  });

  test('mod and div register after the rules they reference', () => {
    const order = PEANO_RULES.map((r) => r.id);
    const refs = ['nat.lt-zz', 'nat.sub-z', 'nat.div-xy', 'nat.mod-xy'];
    const positions = refs.map((id) => order.indexOf(id));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(order.indexOf('nat.mod-xy')).toBeGreaterThan(order.indexOf('nat.lt-zz'));
    expect(order.indexOf('nat.mod-xy')).toBeGreaterThan(order.indexOf('nat.sub-z'));
    expect(order.indexOf('nat.div-xy')).toBeGreaterThan(order.indexOf('nat.lt-zz'));
    expect(order.indexOf('nat.div-xy')).toBeGreaterThan(order.indexOf('nat.sub-z'));
  });

  test('the deck registers into the engine as a working arithmetic system', () => {
    const store = freshStore();
    const { outcome } = reduce(store, tSym('nat.add', [natFromDecimal(2), natFromDecimal(2)]));
    expect(outcome.status).toBe('normal');
    if (outcome.status === 'normal') expect(outcome.term).toEqual(natFromDecimal(4));
  });
});
