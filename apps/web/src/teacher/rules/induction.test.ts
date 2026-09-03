import { describe, expect, test } from '@jest/globals';
import { reduce } from './engine';
import { PEANO_RULES, natFromDecimal, natToDecimal } from './peano';
import { induceRuleSet, validateHeldOut, type InductionInstance } from './induction';
import { tSym, termBits, termToString } from './terms';
import { RuleStore, type RewriteRule } from './types';

const library = (): RuleStore => new RuleStore(PEANO_RULES);

const nat = (n: number) => natFromDecimal(n);

/** Instances (a, b) -> answer over nat numerals. */
function pairs(entries: Array<[number, number, number]>): InductionInstance[] {
  return entries.map(([a, b, answer]) => ({ args: [nat(a), nat(b)], answer: nat(answer) }));
}

const registerAll = (store: RuleStore, rules: readonly RewriteRule[]): void => {
  for (const rule of rules) store.register(rule);
};

/** Reduce a fresh term with the library plus the induced rules. */
function derive(store: RuleStore, rules: readonly RewriteRule[], name: string, args: number[]): number | null {
  const probe = new RuleStore([...store.all(), ...rules], store.allDenials());
  const { outcome } = reduce(probe, tSym(name, args.map(nat)));
  if (outcome.status !== 'normal') return null;
  return natToDecimal(outcome.term);
}

describe('induction — the flagship: Euclidean gcd (measure schema)', () => {
  const TRAIN = pairs([
    [12, 8, 4], [8, 12, 4], [12, 6, 6], [18, 12, 6], [20, 8, 4],
    [9, 6, 3], [14, 7, 7], [30, 12, 6], [25, 15, 5], [16, 12, 4]
  ]);
  const HELD_OUT = pairs([
    [21, 14, 7], [24, 18, 6], [40, 25, 5], [27, 18, 9],
    [32, 24, 8], [10, 4, 2], [35, 15, 5], [28, 21, 7]
  ]);

  test('gcd is induced from instances and generalizes to held-out pairs', () => {
    const store = library();
    const instanceBits = TRAIN.reduce((sum, instance) => sum + (instance.answer.t === 'lit' ? 10 : termBits(instance.answer)), 0);
    const induced = induceRuleSet(store, 'nat.gcd', TRAIN, {
      instanceBits,
      baseline: 0.05,
      margin: 0.2,
      minHits: 3
    });
    expect(induced).not.toBeNull();
    expect(induced!.every((rule) => rule.schema === 'measure')).toBe(true);
    expect(validateHeldOut(store, induced!, HELD_OUT, 0.05, 0.2, 3)).toBe(true);
  });

  test('the induced rule is recursive and cites the library (nat.mod, nat.eq)', () => {
    const store = library();
    const instanceBits = TRAIN.reduce((sum, instance) => sum + termBits(instance.answer), 0);
    const induced = induceRuleSet(store, 'nat.gcd', TRAIN, { instanceBits, baseline: 0.05 });
    expect(induced).not.toBeNull();
    const body = termToString(induced![0].rhs);
    expect(body).toContain('nat.gcd');
    expect(body).toContain('nat.mod');
    expect(body).toContain('nat.eq');
    expect(body).toContain('ite');
  });

  test('fresh prompts derive through the induced rule with its id in the trace', () => {
    const store = library();
    const instanceBits = TRAIN.reduce((sum, instance) => sum + termBits(instance.answer), 0);
    const induced = induceRuleSet(store, 'nat.gcd', TRAIN, { instanceBits, baseline: 0.05 });
    expect(induced).not.toBeNull();
    registerAll(store, induced!);
    const probe = new RuleStore(store.all(), store.allDenials());
    const { outcome, ruleIds } = reduce(probe, tSym('nat.gcd', [nat(48), nat(36)]));
    expect(outcome.status).toBe('normal');
    if (outcome.status === 'normal') expect(natToDecimal(outcome.term)).toBe(12);
    expect(ruleIds).toContain('induced-nat.gcd-0');
    expect(derive(store, induced!, 'nat.gcd', [0, 0])).toBe(0);
    expect(derive(store, induced!, 'nat.gcd', [17, 17])).toBe(17);
  });
});

describe('induction — structural primitive recursion', () => {
  test('nat.add is induced from base+step instances', () => {
    const store = library();
    const train: InductionInstance[] = [];
    for (let a = 0; a <= 8; a += 1) {
      for (let b = 0; b <= 8; b += 1) train.push({ args: [nat(a), nat(b)], answer: nat(a + b) });
    }
    const heldOut = pairs([
      [0, 9, 9], [3, 11, 14], [12, 5, 17], [9, 9, 18], [10, 10, 20], [7, 13, 20], [1, 19, 20], [14, 8, 22]
    ]);
    const instanceBits = train.reduce((sum, instance) => sum + termBits(instance.answer), 0);
    const induced = induceRuleSet(store, 'nat.add', train, {
      instanceBits,
      baseline: 0.05,
      schema: 'structural'
    });
    expect(induced).not.toBeNull();
    expect(induced!.length).toBe(2);
    expect(induced!.every((rule) => rule.schema === 'structural')).toBe(true);
    expect(validateHeldOut(store, induced!, heldOut, 0.05, 0.2, 3)).toBe(true);
  });

  test('nat.mul is induced using nat.add from the library — knowledge composes', () => {
    const store = library();
    const train: InductionInstance[] = [];
    for (let a = 0; a <= 6; a += 1) {
      for (let b = 0; b <= 6; b += 1) train.push({ args: [nat(a), nat(b)], answer: nat(a * b) });
    }
    const heldOut = pairs([
      [7, 7, 49], [3, 9, 27], [12, 2, 24], [9, 8, 72], [5, 11, 55], [6, 10, 60], [2, 14, 28], [11, 5, 55]
    ]);
    const instanceBits = train.reduce((sum, instance) => sum + termBits(instance.answer), 0);
    const induced = induceRuleSet(store, 'nat.mul', train, {
      instanceBits,
      baseline: 0.05,
      schema: 'structural'
    });
    expect(induced).not.toBeNull();
    expect(termToString(induced![1].rhs)).toContain('nat.add');
    expect(validateHeldOut(store, induced!, heldOut, 0.05, 0.2, 3)).toBe(true);
  });
});

describe('induction — honesty gates', () => {
  test('an inexpressible mapping is never induced (or fails held-out)', () => {
    const store = library();
    // (a*b + 7) % 11 — not expressible in the candidate schemas over the
    // library vocabulary; the pipeline must reject it at one of the gates.
    const train: InductionInstance[] = [];
    for (let a = 0; a <= 5; a += 1) {
      for (let b = 0; b <= 5; b += 1) {
        train.push({ args: [nat(a), nat(b)], answer: nat((a * b + 7) % 11) });
      }
    }
    const heldOut = pairs([[6, 6, 10], [7, 3, 6], [2, 9, 3], [8, 8, 5]]);
    const instanceBits = train.reduce((sum, instance) => sum + termBits(instance.answer), 0);
    const induced = induceRuleSet(store, 'nat.f', train, { instanceBits, baseline: 0.05 });
    if (induced !== null) {
      expect(validateHeldOut(store, induced, heldOut, 0.05, 0.2, 3)).toBe(false);
    }
  });

  test('an empty train is never induced', () => {
    expect(induceRuleSet(library(), 'nat.f', [], { instanceBits: 100, baseline: 0.05 })).toBeNull();
  });

  test('a single instance (an anecdote) is never induced', () => {
    const single = pairs([[12, 8, 4]]);
    expect(induceRuleSet(library(), 'nat.gcd', single, { instanceBits: 100, baseline: 0.05 })).toBeNull();
  });

  test('induction is deterministic — identical calls return identical rules', () => {
    const store = library();
    const instanceBits = 200;
    const train = pairs([[12, 8, 4], [8, 12, 4], [12, 6, 6], [18, 12, 6], [20, 8, 4]]);
    const first = induceRuleSet(store, 'nat.gcd', train, { instanceBits, baseline: 0.05 });
    const second = induceRuleSet(store, 'nat.gcd', train, { instanceBits, baseline: 0.05 });
    expect(first).not.toBeNull();
    expect(termToString(first![0].lhs)).toBe(termToString(second![0].lhs));
    expect(termToString(first![0].rhs)).toBe(termToString(second![0].rhs));
  });
});
