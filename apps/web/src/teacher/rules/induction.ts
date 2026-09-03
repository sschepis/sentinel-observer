/**
 * RULE INDUCTION — the observer acquires procedures.
 *
 * Synthesizes RECURSIVE rewrite rules from instances, so a family the
 * observer was never authored with (the flagship: Euclidean gcd) becomes a
 * first-class rule. Two schemas, with different totality stories:
 *
 *   (a) STRUCTURAL primitive recursion — f(z, y) -> base and
 *       f(s(x), y) -> step. Totality is BY CONSTRUCTION: the recursion
 *       argument shrinks structurally every call.
 *   (b) MEASURE-decreasing general recursion — f(a, b) -> ite(cond, base,
 *       f(recA, recB)). No termination proof: totality is checked
 *       EMPIRICALLY — every instance must normalize within the fuel budget,
 *       and any divergence disqualifies the candidate. This is the one
 *       place induction trades a proof for a measurement, stated plainly.
 *
 * The gates are the DSL's, unchanged in spirit: MDL (the rule set must
 * compress the instances), exact train consistency, fuel-bounded totality,
 * and held-out validation (a separate helper the caller runs on unseen
 * instances). Bodies draw on the LIBRARY's existing rule names — knowledge
 * composes: once nat.add exists, nat.mul is cheap to describe.
 */

import { tSym, tVar, termBits, termToString, type Term } from './terms';
import { reduce } from './engine';
import { RuleStore, type RewriteRule, type RuleSchema } from './types';
import { natFromDecimal } from './peano';

export interface InductionInstance {
  args: Term[];
  answer: Term;
}

export interface InduceRuleSetOptions {
  /** MDL: the taught instances' description length in bits. */
  instanceBits: number;
  /** Held-out chance baseline (the memorizer null model). */
  baseline: number;
  /** Held-out accuracy must clear baseline + margin. */
  margin?: number;
  /** Minimum held-out hits. */
  minHits?: number;
  /** Fuel budget for the candidate simulations. */
  fuel?: number;
  schema?: 'structural' | 'measure' | 'accessor' | 'search' | 'scalar' | 'auto';
}

export const INDUCTION_FUEL = 5_000;

const z = tSym('nat.z');
const s = (t: Term): Term => tSym('nat.s', [t]);

function makeRule(name: string, index: number, lhs: Term, rhs: Term, evidence: number, schema: RuleSchema): RewriteRule {
  return {
    id: `induced-${name}-${index}`,
    // The rule's reducible symbol is its LHS HEAD — an auxiliary rule
    // (nat.sqrt.try) must carry that head as its name or the engine can
    // never look it up (the search-schema bug this line fixes).
    name: lhs.t === 'sym' ? lhs.head : name,
    lhs,
    rhs,
    origin: 'induced',
    strength: 1,
    sourceClasses: [],
    bits: termBits(lhs) + termBits(rhs),
    evidence,
    schema,
    active: true,
    createdAt: Date.now(),
    useCount: 0
  };
}

const totalBits = (rules: readonly RewriteRule[]): number => rules.reduce((sum, rule) => sum + rule.bits, 0);

/** Reduce every instance with the candidate rules over the library. */
function simulate(
  store: RuleStore,
  name: string,
  rules: readonly RewriteRule[],
  instances: readonly InductionInstance[],
  fuel: number
): boolean {
  // REVIEW FIX (Med5): exclude EVERY candidate name — a search rule's aux
  // (nat.sqrt.try) differs from the target (nat.sqrt), and a stale aux in
  // the library would answer all aux reductions and certify garbage.
  const candidateNames = new Set([name, ...rules.map((rule) => rule.name)]);
  const library = store.all().filter((rule) => !candidateNames.has(rule.name));
  const probe = new RuleStore([...library, ...rules], store.allDenials());
  for (const instance of instances) {
    const { outcome } = reduce(probe, tSym(name, instance.args), { fuel });
    if (outcome.status !== 'normal') return false;
    if (termToString(outcome.term) !== termToString(instance.answer)) return false;
  }
  return true;
}

/** Is the term a nat numeral (z or a chain of s)? */
function isNumeral(term: Term): boolean {
  let node: Term = term;
  for (;;) {
    if (node.t === 'sym' && node.head === 'nat.z' && node.args.length === 0) return true;
    if (node.t !== 'sym' || node.head !== 'nat.s' || node.args.length !== 1) return false;
    node = node.args[0];
  }
}

const numeralOf = (term: Term): number | null => {
  let count = 0;
  let node: Term = term;
  for (;;) {
    if (node.t === 'sym' && node.head === 'nat.z' && node.args.length === 0) return count;
    if (node.t !== 'sym' || node.head !== 'nat.s' || node.args.length !== 1) return null;
    count += 1;
    node = node.args[0];
  }
};

/**
 * Schema (a): f(z, y) -> base, f(s(x), y) -> step. The recursion argument
 * is the first; the remaining arguments are fixed variables. Returns the
 * FIRST candidate that is train-consistent and MDL-cheap (deterministic
 * order — the templates are ordered so the natural base/step forms come
 * first).
 */
function induceStructural(
  store: RuleStore,
  name: string,
  train: readonly InductionInstance[],
  options: InduceRuleSetOptions,
  fuel: number
): RewriteRule[] | null {
  if (train.length < 2) return null;
  if (!train.every((instance) => instance.args.length >= 2 && isNumeral(instance.args[0]))) return null;
  const extra = train[0].args.length - 1;
  const vars = Array.from({ length: extra }, (_, i) => tVar(`y${i}`));
  const hasBase = train.some((instance) => numeralOf(instance.args[0]) === 0);
  const hasStep = train.some((instance) => numeralOf(instance.args[0]) !== null && numeralOf(instance.args[0]) !== 0);
  if (!hasBase || !hasStep) return null;
  const f = (t: Term): Term => tSym(name, [t, ...vars]);
  const first = vars[0];
  const baseTemplates: Term[] = [first, z, s(first)];
  const stepTemplates: Term[] = [
    s(f(tVar('x'))),
    tSym('nat.add', [first, f(tVar('x'))]),
    tSym('nat.add', [f(tVar('x')), first]),
    tSym('nat.mul', [first, f(tVar('x'))]),
    tSym('nat.mul', [f(tVar('x')), first]),
    tSym('nat.sub', [f(tVar('x')), first])
  ];
  for (const base of baseTemplates) {
    for (const step of stepTemplates) {
      const rules = [
        makeRule(name, 0, tSym(name, [z, ...vars]), base, train.length, 'structural'),
        makeRule(name, 1, tSym(name, [s(tVar('x')), ...vars]), step, train.length, 'structural')
      ];
      if (totalBits(rules) >= options.instanceBits) continue;
      if (!simulate(store, name, rules, train, fuel)) continue;
      return rules;
    }
  }
  return null;
}

/**
 * Schema (b): f(a, b) -> ite(cond(a, b), base(a, b), f(recA, recB)).
 * Candidate order is deliberate: the natural recursive form (guard on the
 * second argument, recurse into [b, mod(a, b)]) is tried first, so the
 * flagship gcd synthesis returns immediately when it is consistent.
 */
function induceMeasure(
  store: RuleStore,
  name: string,
  train: readonly InductionInstance[],
  options: InduceRuleSetOptions,
  fuel: number
): RewriteRule[] | null {
  if (train.length < 2) return null;
  if (!train.every((instance) => instance.args.length === 2 && isNumeral(instance.args[0]) && isNumeral(instance.args[1]))) {
    return null;
  }
  const a = tVar('a');
  const b = tVar('b');
  const conds: Term[] = [
    tSym('nat.eq', [b, z]),
    tSym('nat.lt', [a, b]),
    tSym('nat.lt', [b, a]),
    tSym('nat.eq', [a, b]),
    tSym('nat.ge', [a, b]),
    tSym('nat.ge', [b, a])
  ];
  const bases: Term[] = [a, b, z, s(z)];
  const recs: Array<[Term, Term]> = [
    [b, tSym('nat.mod', [a, b])],
    [tSym('nat.sub', [a, b]), b],
    [a, tSym('nat.sub', [b, a])],
    [b, tSym('nat.sub', [a, b])],
    [tSym('nat.mod', [a, b]), b],
    [a, tSym('nat.mod', [a, b])]
  ];
  for (const cond of conds) {
    for (const base of bases) {
      for (const [recA, recB] of recs) {
        const rules = [
          makeRule(name, 0, tSym(name, [a, b]), tSym('ite', [cond, base, tSym(name, [recA, recB])]), train.length, 'measure')
        ];
        if (totalBits(rules) >= options.instanceBits) continue;
        if (!simulate(store, name, rules, train, fuel)) continue;
        return rules;
      }
    }
  }
  return null;
}

/**
 * Schema (c) — LIST-STRUCTURAL ACCESSOR (R12, the place-value flagship):
 * f(cons(d, rest), z) -> d, f(cons(d, rest), s(i)) -> g(d, rest, i,
 * f(rest, i)). Walks a digit list to a position while the second argument
 * counts down; the step body may scale the recursive value (place value =
 * 10 × the next place's value). Totality by construction: the list shrinks.
 */
function induceAccessor(
  store: RuleStore,
  name: string,
  train: readonly InductionInstance[],
  options: InduceRuleSetOptions,
  fuel: number
): RewriteRule[] | null {
  if (train.length < 3) return null;
  // Every instance: a cons-list first argument and a numeral second.
  const listOf = (term: Term): Term[] | null => {
    const out: Term[] = [];
    let node: Term = term;
    for (;;) {
      if (node.t === 'sym' && node.head === 'list.nil' && node.args.length === 0) return out;
      if (node.t !== 'sym' || node.head !== 'list.cons' || node.args.length !== 2) return null;
      out.push(node.args[0]);
      node = node.args[1];
    }
  };
  if (!train.every((instance) => instance.args.length === 2 && listOf(instance.args[0]) !== null && isNumeral(instance.args[1]))) {
    return null;
  }
  const d = tVar('d');
  const rest = tVar('rest');
  const i = tVar('i');
  const cons = (head: Term, tail: Term): Term => tSym('list.cons', [head, tail]);
  const mul = (a: Term, b: Term): Term => tSym('nat.mul', [a, b]);
  // Scale constants the step body may multiply the recursive call by.
  const scales: Term[] = [z, ...Array.from({ length: 15 }, (_, n) => natFromDecimal(n + 1))];
  const baseBodies: Term[] = [d];
  const stepBodies: Term[] = [
    tSym(name, [rest, i]),
    mul(natFromDecimal(10), tSym(name, [rest, i])),
    ...scales.map((scale) => mul(scale, tSym(name, [rest, i])))
  ];
  for (const base of baseBodies) {
    for (const step of stepBodies) {
      const rules = [
        makeRule(name, 0, tSym(name, [cons(d, rest), z]), base, train.length, 'accessor'),
        makeRule(name, 1, tSym(name, [cons(d, rest), s(i)]), step, train.length, 'accessor')
      ];
      if (totalBits(rules) >= options.instanceBits) continue;
      if (!simulate(store, name, rules, train, fuel)) continue;
      return rules;
    }
  }
  return null;
}

/**
 * Schema (d) — BOUNDED SEARCH (R12, square-root): f(n) delegates to an
 * accumulator `f.try(n, k)` that counts k up until k² passes n, then
 * answers k − 1. Two rules:
 *
 *   f(n)            -> f.try(n, z)
 *   f.try(n, k)     -> ite(<mul(k, k) past n>, <answer>, f.try(n, s(k)))
 *
 * The measure n − k² decreases toward the answer while k grows — no
 * termination proof, checked empirically on the train instances exactly
 * like schema (b): divergence disqualifies the candidate.
 */
function induceSearch(
  store: RuleStore,
  name: string,
  train: readonly InductionInstance[],
  options: InduceRuleSetOptions,
  fuel: number
): RewriteRule[] | null {
  // The search's lt(n, k·k) chains cost ~n steps per level — sqrt(324)
  // needs tens of thousands of rewrites, far beyond the structural
  // schemas' budget. Measured, not guessed.
  fuel = Math.max(fuel, 60_000);
  if (train.length < 2) return null;
  if (!train.every((instance) => instance.args.length === 1 && isNumeral(instance.args[0]))) return null;
  const aux = `${name}.try`;
  const n = tVar('n');
  const k = tVar('k');
  const sq = tSym('nat.mul', [k, k]);
  const conds: Term[] = [tSym('nat.gt', [sq, n]), tSym('nat.ge', [sq, n]), tSym('nat.lt', [n, sq]), tSym('nat.eq', [sq, n])];
  const answers: Term[] = [tSym('nat.pred', [k]), k];
  const entryRules = makeRule(name, 0, tSym(name, [n]), tSym(aux, [n, z]), train.length, 'search');
  for (const cond of conds) {
    for (const answer of answers) {
      const rules = [
        entryRules,
        makeRule(name, 1, tSym(aux, [n, k]), tSym('ite', [cond, answer, tSym(aux, [n, s(k)])]), train.length, 'search')
      ];
      if (totalBits(rules) >= options.instanceBits) continue;
      if (!simulate(store, name, rules, train, fuel)) continue;
      return rules;
    }
  }
  return null;
}

/**
 * Schema (e) — CONSTANT MULTIPLIER (R13, the conversion families):
 * f(x) -> nat.mul(x, C). The ratio is IN THE DATA: every instance fixes
 * C = answer / x, so the candidate set is the instances' own ratios — a
 * consistent C across all of them is the rule. No recursion, no search;
 * the MDL and held-out gates still apply.
 */
function induceScalar(
  store: RuleStore,
  name: string,
  train: readonly InductionInstance[],
  options: InduceRuleSetOptions,
  fuel: number
): RewriteRule[] | null {
  if (train.length < 3) return null;
  if (!train.every((instance) => instance.args.length === 1 && isNumeral(instance.args[0]) && isNumeral(instance.answer))) {
    return null;
  }
  const x = tVar('x');
  // C = answer / x for every instance — the first ratio must hold for all.
  const firstX = numeralOf(train[0].args[0]);
  const firstAnswer = numeralOf(train[0].answer);
  if (firstX === null || firstAnswer === null || firstX === 0 || firstAnswer % firstX !== 0) return null;
  const scale = firstAnswer / firstX;
  if (!train.every((instance) => {
    const arg = numeralOf(instance.args[0]);
    const answer = numeralOf(instance.answer);
    return arg !== null && answer !== null && answer === arg * scale;
  })) {
    return null;
  }
  const rules = [makeRule(name, 0, tSym(name, [x]), tSym('nat.mul', [x, natFromDecimal(scale)]), train.length, 'scalar')];
  if (totalBits(rules) >= options.instanceBits) return null;
  if (!simulate(store, name, rules, train, fuel)) return null;
  return rules;
}

/**
 * Induce a recursive rule set for `name` from the train instances. Returns
 * the first candidate clearing the MDL and train-consistency gates, or
 * null when nothing generalizes (an anecdote, an inexpressible mapping, or
 * a family whose arguments are not numerals).
 */
export function induceRuleSet(
  store: RuleStore,
  name: string,
  train: readonly InductionInstance[],
  options: InduceRuleSetOptions
): RewriteRule[] | null {
  if (train.length === 0) return null;
  const fuel = options.fuel ?? INDUCTION_FUEL;
  const schema = options.schema ?? 'auto';
  if (schema === 'structural' || schema === 'auto') {
    const structural = induceStructural(store, name, train, options, fuel);
    if (structural !== null && schema === 'structural') return structural;
    if (structural !== null && schema === 'auto') return structural;
  }
  if (schema === 'accessor' || schema === 'auto') {
    const accessor = induceAccessor(store, name, train, options, fuel);
    if (accessor !== null && schema === 'accessor') return accessor;
    if (accessor !== null && schema === 'auto') return accessor;
  }
  if (schema === 'measure' || schema === 'auto') {
    const measure = induceMeasure(store, name, train, options, fuel);
    if (measure !== null && (schema === 'measure' || schema === 'auto')) return measure;
  }
  if (schema === 'search' || schema === 'auto') {
    const search = induceSearch(store, name, train, options, fuel);
    if (search !== null && (schema === 'search' || schema === 'auto')) return search;
  }
  if (schema === 'scalar' || schema === 'auto') {
    const scalar = induceScalar(store, name, train, options, fuel);
    if (scalar !== null && (schema === 'scalar' || schema === 'auto')) return scalar;
  }
  return null;
}

/**
 * The held-out gate: with the candidate rules registered over the library,
 * every test instance must reduce to its answer, and the accuracy must
 * clear baseline + margin with at least minHits correct.
 */
export function validateHeldOut(
  store: RuleStore,
  rules: readonly RewriteRule[],
  test: readonly InductionInstance[],
  baseline: number,
  margin = 0.2,
  minHits = 3,
  fuel = INDUCTION_FUEL
): boolean {
  if (test.length === 0 || rules.length === 0) return false;
  const targetName = rules[0].name;
  const candidateNames = new Set(rules.map((rule) => rule.name));
  const library = store.all().filter((rule) => !candidateNames.has(rule.name));
  const probe = new RuleStore([...library, ...rules], store.allDenials());
  let correct = 0;
  for (const instance of test) {
    const { outcome } = reduce(probe, tSym(targetName, instance.args), { fuel });
    if (outcome.status === 'normal' && termToString(outcome.term) === termToString(instance.answer)) {
      correct += 1;
    }
  }
  return correct >= minHits && correct / test.length > baseline + margin;
}
