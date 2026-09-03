/**
 * THE APPLICATOR — bounded small-step term rewriting.
 *
 * Semantics:
 *  - CALL-BY-VALUE: arguments normalize left-to-right before any rule
 *    fires (first matching rule in priority order, no backtracking), so a
 *    rule never re-nests an unreduced computation — the property that
 *    makes recursive procedures like Euclidean gcd terminate.
 *  - `ite` is a NATIVE lazy special form: its condition is reduced to a
 *    literal boolean first, both branches untouched until it selects one.
 *    Laziness is not an optimization — an eager strategy would reduce the
 *    recursive branch of `gcd(a,b) -> ite(eq(b,z), a, gcd(b, mod(a,b)))`
 *    even when b = z and diverge on exactly the rules this engine exists to
 *    run.
 *  - The only natives are matching, substitution, `ite`, and the fuel
 *    counter. Everything else must be rules.
 *
 * Termination is a three-layer contract: a hard fuel budget, a cycle
 * short-circuit over recent whole-term states, and the map of `exhausted`
 * to decline/ASK — never a confident answer.
 */

import { isLiteral, matchPattern, substitute, hashTerm, serializeBounded, tSym, type Term } from './terms';
import type { DerivationStep, RewriteOutcome, RuleStore } from './types';

export const RULE_DEFAULT_FUEL = 10_000;
export const RULE_CYCLE_MEMO = 1024;
export const RULE_CYCLE_HASH_STEPS = 4096;
export const RULE_MAX_TRACE = 200;
export const ITE = 'ite';

export interface EngineOptions {
  /** Hard rewrite-step budget per query. */
  fuel?: number;
  /** How many recent whole-term states the cycle memo holds. */
  cycleMemo?: number;
  /** Derivation steps retained for provenance (the first N). */
  maxTrace?: number;
}

export interface Reduction {
  outcome: RewriteOutcome;
  /** The distinct rules applied (grade weakening targets them, never ite). */
  ruleIds: string[];
  /** Total rewrite steps consumed (native ite included). */
  steps: number;
}

type RewriteOnce =
  | { status: 'rewrote'; next: Term; ruleId?: string }
  | { status: 'stuck' }
  | { status: 'none' };

interface WalkFrame {
  node: Term;
  /** The child-index path from the root to this node. */
  path: number[];
  /** The next argument index to descend into (-1 = exhausted). */
  nextArg: number;
}

/**
 * One rewrite, CALL-BY-VALUE with lazy `ite` — the strategy that makes the
 * flagship rules terminate:
 *
 *  - Arguments normalize left-to-right BEFORE any rule fires, so a rule
 *    never sees (or re-nests) an unreduced computation. This is what keeps
 *    `gcd(a, b) -> ite(eq(b, z), a, gcd(b, mod(a, b)))` terminating: under
 *    pure leftmost-outermost the gcd rule matches ANY arguments (they are
 *    variables), fires on unreduced `mod(...)` terms, and each recursion
 *    level re-nests the mod computations — a measured divergence. With
 *    call-by-value, `mod(a, b)` normalizes once per occurrence and the
 *    recursion proceeds on numerals.
 *  - `ite` stays a lazy special form: its condition normalizes, both
 *    branches untouched until one is selected. This is not an optimization
 *    — an eager strategy would reduce the recursive branch of gcd even
 *    when b = z and diverge on exactly the rules this engine exists to run.
 *
 * The walk is ITERATIVE (an explicit stack, no recursion): percent's
 * derivation builds 30,000-deep Peano numerals, and a recursive descent
 * through them blows the call stack. Returns the WHOLE new term after one
 * rewrite. `stuck` = a conditional whose condition can never select a
 * branch. `none` = no redex anywhere (an irreducible normal form — the
 * caller's decoder decides whether it is an answer).
 */
function rewriteOnce(store: RuleStore, term: Term, normalMemo: Set<Term>): RewriteOnce {
  const stack: WalkFrame[] = [{ node: term, path: [], nextArg: 0 }];
  for (;;) {
    const frame = stack[stack.length - 1];
    const node = frame.node;
    // A subtree validated normal earlier in this reduction is skipped by
    // object identity — deep numerals are var-bound (shared objects across
    // steps), so the walk never re-descends them (the quadratic that made
    // percent's 30,000-step derivations crawl).
    if (normalMemo.has(node)) {
      stack.pop();
      if (stack.length === 0) return { status: 'none' };
      continue;
    }
    if (node.t === 'sym') {
      if (node.head === ITE && node.args.length === 3) {
        const [cond, a, b] = node.args;
        if (isLiteral(cond)) {
          if (cond.value === true) return rebuild(stack, frame, a);
          if (cond.value === false) return rebuild(stack, frame, b);
          return { status: 'stuck' };
        }
        // Lazy: only the condition may reduce; branches stay untouched.
        if (frame.nextArg === 0) {
          frame.nextArg = 1;
          stack.push({ node: cond, path: [...frame.path, 0], nextArg: 0 });
          continue;
        }
        // The condition is irreducible — the ite can never select.
        return { status: 'stuck' };
      }
      // CALL-BY-VALUE: descend into the arguments first — a rule fires only
      // once every argument is a normal form (otherwise a rule whose
      // patterns are all variables would fire on unreduced computations and
      // re-nest them, the measured gcd divergence).
      if (frame.nextArg < node.args.length) {
        const index = frame.nextArg;
        frame.nextArg += 1;
        stack.push({ node: node.args[index], path: [...frame.path, index], nextArg: 0 });
        continue;
      }
      // Every argument is a normal form — the rules may fire (first match
      // in priority order).
      for (const rule of store.bySymbol(node.head)) {
        const bindings = matchPattern(rule.lhs, node);
        if (bindings !== null) {
          return rewriteAt(stack, frame, substitute(rule.rhs, bindings), rule.id);
        }
      }
    }
    // Leaf, or all arguments normal with no rule firing: this subtree is an
    // irreducible normal form — remember it and return to the parent.
    normalMemo.add(node);
    stack.pop();
    if (stack.length === 0) return { status: 'none' };
  }
}

/** Replace the redex at `frame` and rebuild the term along its ancestors. */
function rebuild(stack: WalkFrame[], frame: WalkFrame, replacement: Term, ruleId?: string): RewriteOnce {
  while (stack[stack.length - 1] !== frame) stack.pop();
  let built = replacement;
  for (let depth = frame.path.length - 1; depth >= 0; depth -= 1) {
    const ancestor = stack[depth];
    // Ancestors of a redex are always symbol nodes (only syms have args).
    if (ancestor.node.t !== 'sym') continue;
    const args = [...ancestor.node.args];
    args[frame.path[depth]] = built;
    built = { t: 'sym', head: ancestor.node.head, args };
  }
  return ruleId === undefined ? { status: 'rewrote', next: built } : { status: 'rewrote', next: built, ruleId };
}

/** `rebuild` with a rule id — the one call site that needs it named. */
function rewriteAt(stack: WalkFrame[], frame: WalkFrame, replacement: Term, ruleId: string): RewriteOnce {
  return rebuild(stack, frame, replacement, ruleId);
}

/**
 * Reduce a term to its normal form — an irreducible term (a literal, or a
 * constructor tree like a Peano numeral — the CALLER's decoder decides
 * whether the normal form is an answer), an explicit `stuck` (a conditional
 * whose condition can never select a branch), or an `exhausted` (fuel out
 * or cycle). Never a throw, never a wrong answer.
 */
export function reduce(store: RuleStore, term: Term, options: EngineOptions = {}): Reduction {
  const fuel = options.fuel ?? RULE_DEFAULT_FUEL;
  const memoCap = options.cycleMemo ?? RULE_CYCLE_MEMO;
  const maxTrace = options.maxTrace ?? RULE_MAX_TRACE;

  let current = term;
  let steps = 0;
  const trace: DerivationStep[] = [];
  const ruleIds = new Set<string>();
  const seen = new Set<string>();
  const history: string[] = [];
  /** Normal-form memo — validated subtrees are skipped by object identity
   *  so deep numerals are never re-walked (see rewriteOnce). */
  const normalMemo = new Set<Term>();

  const recordSeen = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    history.push(key);
    if (history.length > memoCap) {
      const evicted = history.shift();
      if (evicted !== undefined) seen.delete(evicted);
    }
  };

  for (;;) {
    if (steps >= fuel) return { outcome: { status: 'exhausted', steps, trace: [...trace] }, ruleIds: [...ruleIds], steps };
    // CYCLE MEMO, STEP-GATED: hashing the whole term every step is
    // quadratic for long derivations (percent's 30,000-step reductions on
    // numerals tens of thousands deep). Loops are caught early — terms are
    // small in the first steps of any reduction — and beyond the gate the
    // FUEL cap is the sound backstop: a missed cycle burns fuel and returns
    // `exhausted`, which is exactly the cycle's verdict anyway. Sound,
    // deterministic, bounded.
    if (steps < RULE_CYCLE_HASH_STEPS) {
      const key = hashTerm(current);
      if (seen.has(key)) return { outcome: { status: 'exhausted', steps, trace: [...trace] }, ruleIds: [...ruleIds], steps };
      recordSeen(key);
    }

    const next = rewriteOnce(store, current, normalMemo);
    if (next.status === 'none') {
      return { outcome: { status: 'normal', term: current, steps: trace }, ruleIds: [...ruleIds], steps };
    }
    if (next.status === 'stuck') {
      return { outcome: { status: 'stuck', term: current }, ruleIds: [...ruleIds], steps };
    }
    const before = trace.length < maxTrace ? serializeBounded(current) : '';
    current = next.next;
    steps += 1;
    if (next.ruleId !== undefined) {
      ruleIds.add(next.ruleId);
      if (trace.length < maxTrace) {
        trace.push({ ruleId: next.ruleId, before, after: serializeBounded(next.next) });
      }
    } else if (trace.length < maxTrace) {
      trace.push({ ruleId: ITE, before, after: serializeBounded(next.next) });
    }
  }
}
