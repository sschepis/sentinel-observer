import { describe, expect, test } from '@jest/globals';
import { reduce, RULE_MAX_TRACE } from './engine';
import { tLit, tSym, tVar, termToString, type Term } from './terms';
import { RuleStore, type RewriteRule } from './types';

/** A minimal nat-like deck for engine tests. */
function natStore(): RuleStore {
  const store = new RuleStore();
  const rule = (id: string, name: string, lhsArgs: readonly Term[], rhs: Term, overrides: Partial<RewriteRule> = {}): RewriteRule => ({
    id,
    name,
    lhs: tSym(name, lhsArgs),
    rhs,
    origin: 'authored',
    strength: 1,
    sourceClasses: ['curriculum'],
    bits: 10,
    active: true,
    createdAt: 0,
    useCount: 0,
    ...overrides
  });
  const z = tSym('z');
  const s = (t: Term): Term => tSym('s', [t]);
  store.register(rule('add-z', 'add', [z, tVar('y')], tVar('y')));
  store.register(rule('add-s', 'add', [s(tVar('x')), tVar('y')], s(tSym('add', [tVar('x'), tVar('y')]))));
  store.register(rule('eq-zz', 'eq', [z, z], tLit(true)));
  store.register(rule('eq-sz', 'eq', [s(tVar('x')), z], tLit(false)));
  store.register(rule('eq-zs', 'eq', [z, s(tVar('y'))], tLit(false)));
  store.register(rule('eq-ss', 'eq', [s(tVar('x')), s(tVar('y'))], tSym('eq', [tVar('x'), tVar('y')])));
  return store;
}

const nat = (n: number): Term => (n === 0 ? tSym('z') : tSym('s', [nat(n - 1)]));
const num = (term: Term): number => {
  let count = 0;
  let node: Term = term;
  for (;;) {
    if (node.t !== 'sym') break;
    if (node.head !== 's' || node.args.length !== 1) break;
    count += 1;
    node = node.args[0];
  }
  if (node.t !== 'sym' || node.head !== 'z') throw new Error(`not a numeral: ${termToString(term)}`);
  return count;
};

describe('engine — basic reduction', () => {
  test('add(2, 3) reduces to 5', () => {
    const store = natStore();
    const { outcome, ruleIds, steps } = reduce(store, tSym('add', [nat(2), nat(3)]));
    expect(outcome.status).toBe('normal');
    if (outcome.status === 'normal') expect(num(outcome.term)).toBe(5);
    expect(steps).toBe(3);
    expect(ruleIds).toEqual(['add-s', 'add-z']);
  });

  test('a literal input is its own normal form', () => {
    const store = natStore();
    const { outcome } = reduce(store, tLit(42));
    expect(outcome.status).toBe('normal');
    if (outcome.status === 'normal') expect(outcome.term).toEqual(tLit(42));
    expect(store.count()).toBeGreaterThan(0);
  });

  test('eq(3, 3) reduces to true, eq(3, 4) to false', () => {
    const store = natStore();
    const yes = reduce(store, tSym('eq', [nat(3), nat(3)]));
    expect(yes.outcome.status).toBe('normal');
    if (yes.outcome.status === 'normal') expect(yes.outcome.term).toEqual(tLit(true));
    const no = reduce(store, tSym('eq', [nat(3), nat(4)]));
    expect(no.outcome.status).toBe('normal');
    if (no.outcome.status === 'normal') expect(no.outcome.term).toEqual(tLit(false));
  });

  test('an unknown symbol with no rules is an irreducible normal form — the decoder decides', () => {
    const store = natStore();
    const { outcome } = reduce(store, tSym('g', [tLit(1)]));
    expect(outcome.status).toBe('normal');
  });

  test('the derivation trace records each applied rule', () => {
    const store = natStore();
    const { outcome } = reduce(store, tSym('add', [nat(2), nat(0)]));
    if (outcome.status === 'normal') {
      expect(outcome.steps.map((step) => step.ruleId)).toEqual(['add-s', 'add-s', 'add-z']);
      expect(outcome.steps[0].before).toContain('add');
    }
  });
});

describe('engine — ite laziness', () => {
  test('the untaken branch is never reduced', () => {
    const store = natStore();
    const z = tSym('z');
    // f(x, y) -> ite(eq(y, z), x, f(y, g(x, y))) with NO rules for g: an
    // eager strategy would reduce g and get stuck; laziness must return x.
    store.register({
      id: 'f',
      name: 'f',
      lhs: tSym('f', [tVar('x'), tVar('y')]),
      rhs: tSym('ite', [tSym('eq', [tVar('y'), z]), tVar('x'), tSym('f', [tVar('y'), tSym('g', [tVar('x'), tVar('y')])])]),
      origin: 'authored',
      strength: 1,
      sourceClasses: ['curriculum'],
      bits: 20,
      active: true,
      createdAt: 0,
      useCount: 0
    });
    const { outcome } = reduce(store, tSym('f', [tLit(5), z]));
    expect(outcome.status).toBe('normal');
    if (outcome.status === 'normal') expect(outcome.term).toEqual(tLit(5));
  });

  test('a non-boolean literal condition is stuck', () => {
    const store = natStore();
    store.register({
      id: 'f',
      name: 'f',
      lhs: tSym('f', [tVar('x')]),
      rhs: tSym('ite', [tLit(42), tVar('x'), tLit(0)]),
      origin: 'authored',
      strength: 1,
      sourceClasses: ['curriculum'],
      bits: 10,
      active: true,
      createdAt: 0,
      useCount: 0
    });
    const { outcome } = reduce(store, tSym('f', [tLit(1)]));
    expect(outcome.status).toBe('stuck');
  });
});

describe('engine — termination', () => {
  test('a direct self-loop is caught by the cycle memo', () => {
    const store = new RuleStore();
    store.register({
      id: 'loop',
      name: 'loop',
      lhs: tSym('loop', [tVar('x')]),
      rhs: tSym('loop', [tVar('x')]),
      origin: 'authored',
      strength: 1,
      sourceClasses: ['curriculum'],
      bits: 10,
      active: true,
      createdAt: 0,
      useCount: 0
    });
    const { outcome } = reduce(store, tSym('loop', [tLit(1)]));
    expect(outcome.status).toBe('exhausted');
  });

  test('a term that grows forever burns the fuel budget', () => {
    const store = new RuleStore();
    store.register({
      id: 'grow',
      name: 'grow',
      lhs: tSym('grow', [tVar('x')]),
      rhs: tSym('grow', [tSym('s', [tVar('x')])]),
      origin: 'authored',
      strength: 1,
      sourceClasses: ['curriculum'],
      bits: 10,
      active: true,
      createdAt: 0,
      useCount: 0
    });
    const { outcome, steps } = reduce(store, tSym('grow', [tLit(1)]), { fuel: 137 });
    expect(outcome.status).toBe('exhausted');
    expect(steps).toBe(137);
  });
});

describe('engine — determinism and provenance caps', () => {
  test('the same term and store produce the identical trace', () => {
    const store = natStore();
    const term = tSym('add', [nat(4), nat(3)]);
    const first = reduce(store, term);
    const second = reduce(store, term);
    expect(first.outcome).toEqual(second.outcome);
    expect(first.ruleIds).toEqual(second.ruleIds);
    expect(first.steps).toBe(second.steps);
  });

  test('the retained trace is capped at maxTrace', () => {
    const store = natStore();
    const { outcome, steps } = reduce(store, tSym('add', [nat(8), nat(8)]), { maxTrace: 3 });
    if (outcome.status === 'normal') expect(outcome.steps.length).toBeLessThanOrEqual(3);
    expect(steps).toBeGreaterThan(3);
  });

  test('RULE_MAX_TRACE is the default cap', () => {
    expect(RULE_MAX_TRACE).toBe(200);
  });
});
