import { describe, expect, test } from '@jest/globals';
import { tLit, tSym, tVar } from './terms';
import { RULE_DENIAL_STOP_COUNT, RULE_STRENGTH_FLOOR, RuleStore, type DerivationDenial, type RewriteRule } from './types';

function rule(id: string, name: string, lhsArgs: Parameters<typeof tSym>[1] | undefined, rhs: ReturnType<typeof tLit>, overrides: Partial<RewriteRule> = {}): RewriteRule {
  return {
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
  };
}

describe('RuleStore — registration', () => {
  test('registers valid rules in insertion order', () => {
    const store = new RuleStore();
    store.register(rule('a', 'f', [tVar('x')], tLit(1)));
    store.register(rule('b', 'f', [tVar('x')], tLit(2)));
    expect(store.bySymbol('f').map((r) => r.id)).toEqual(['a', 'b']);
  });

  test('rejects a non-symbol lhs', () => {
    const store = new RuleStore();
    expect(() => store.register({ ...rule('x', 'f', [tVar('x')], tLit(1)), lhs: tLit(1) })).toThrow(/lhs must be a symbol/);
  });

  test('rejects a rule that reduces ite (native special form)', () => {
    const store = new RuleStore();
    expect(() => store.register({ ...rule('x', 'ite', [tVar('x')], tLit(1)) })).toThrow(/ite/);
  });

  test('rejects an rhs with an unbound variable — substitution captures nothing', () => {
    const store = new RuleStore();
    expect(() => store.register(rule('x', 'f', [tVar('x')], tVar('ghost')))).toThrow(/unbound variable/);
  });

  test('re-registering an id replaces in place, keeping priority', () => {
    const store = new RuleStore();
    store.register(rule('a', 'f', [tVar('x')], tLit(1)));
    store.register(rule('b', 'f', [tVar('x')], tLit(2)));
    store.register({ ...rule('a', 'f', [tVar('x')], tLit(9)), strength: 0.5 });
    const rules = store.bySymbol('f');
    expect(rules.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rules[0].strength).toBe(0.5);
    expect(store.count()).toBe(2);
  });
});

describe('RuleStore — honesty fields', () => {
  test('strength is floored, never driven below RULE_STRENGTH_FLOOR', () => {
    const store = new RuleStore();
    store.register(rule('a', 'f', [tVar('x')], tLit(1)));
    store.adjustStrength('a', -5);
    expect(store.get('a')!.strength).toBe(RULE_STRENGTH_FLOOR);
  });

  test('source classes dedupe', () => {
    const store = new RuleStore();
    store.register(rule('a', 'f', [tVar('x')], tLit(1)));
    store.addSourceClass('a', 'world-feedback');
    store.addSourceClass('a', 'world-feedback');
    expect(store.get('a')!.sourceClasses).toEqual(['curriculum', 'world-feedback']);
  });

  test('two independent denials below the floor stop a rule without deleting it', () => {
    const store = new RuleStore();
    store.register(rule('a', 'f', [tVar('x')], tLit(1)));
    store.adjustStrength('a', -5);
    expect(store.isStopped('a')).toBe(false);
    store.recordDenial({ ruleId: 'a', input: '#1', output: '#2', evidence: 'graded-wrong', at: 1 });
    expect(store.isStopped('a')).toBe(false);
    store.recordDenial({ ruleId: 'a', input: '#3', output: '#4', evidence: 'graded-wrong', at: 2 });
    expect(store.isStopped('a')).toBe(true);
    expect(store.get('a')).toBeDefined();
    expect(store.bySymbol('f')).toHaveLength(0);
  });

  test('repeated identical denials count once (independent evidence)', () => {
    const store = new RuleStore();
    store.register(rule('a', 'f', [tVar('x')], tLit(1)));
    store.adjustStrength('a', -5);
    const denial: DerivationDenial = { ruleId: 'a', input: '#1', output: '#2', evidence: 'graded-wrong', at: 1 };
    store.recordDenial(denial);
    store.recordDenial({ ...denial, at: 2 });
    expect(store.denialsOf('a')).toHaveLength(2);
    expect(store.isStopped('a')).toBe(false);
  });

  test('an explicit world resolution stops the rule', () => {
    const store = new RuleStore();
    store.register(rule('a', 'f', [tVar('x')], tLit(1)));
    store.setActive('a', false);
    expect(store.isStopped('a')).toBe(true);
    expect(store.get('a')!.active).toBe(false);
  });

  test('use counts and timestamps are tracked', () => {
    const store = new RuleStore();
    store.register(rule('a', 'f', [tVar('x')], tLit(1)));
    store.noteUse('a');
    store.noteUse('a');
    expect(store.get('a')!.useCount).toBe(2);
    expect(store.get('a')!.lastUsedAt).toBeGreaterThan(0);
  });

  test('serialize round-trips rules and denials', () => {
    const store = new RuleStore();
    store.register(rule('a', 'f', [tVar('x')], tLit(1)));
    store.recordDenial({ ruleId: 'a', input: '#1', output: '#2', evidence: 'graded-wrong', at: 1 });
    const { rules, denials } = store.serialize();
    const restored = new RuleStore(rules, denials);
    expect(restored.count()).toBe(1);
    expect(restored.allDenials()).toHaveLength(1);
    expect(restored.get('a')!.strength).toBe(1);
    expect(restored.all()[0].lhs).toEqual(tSym('f', [tVar('x')]));
  });
});
