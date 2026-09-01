/**
 * EXECUTABLE RULE INDUCTION — a tiny composable DSL for the drill curriculum.
 *
 * When a drill returns `memorized`, the observer has stored the instances but
 * no rule. This module searches a SMALL program space for an expression that
 * is consistent with the taught instances, gated by the SAME minimum
 * description length criterion the rest of the curriculum uses, and validated
 * against the held-out set — so "asked for the rule" becomes "acquired the
 * rule", and the compiled program becomes a first-class operator in
 * `chatAnswer`.
 *
 * Deliberately tiny: `add/mul/mod/div/gt/lt/eq/ite` over ≤3 args plus
 * constants and text leaves covers every arithmetic/number-property family in
 * `verify.ts`. Every added primitive multiplies the search space and weakens
 * the MDL guarantee, so the set is not grown to pass one concept.
 */

// ═══════════════════════════════════════════════════════════════════════════
// TYPES & SEMANTICS
// ═══════════════════════════════════════════════════════════════════════════

export type DSLValue = number | string | boolean;

export type DSLExpr =
  | { op: 'arg'; index: number }
  | { op: 'const'; value: number }
  | { op: 'text'; value: string }
  | { op: 'add'; a: DSLExpr; b: DSLExpr }
  | { op: 'sub'; a: DSLExpr; b: DSLExpr }
  | { op: 'mul'; a: DSLExpr; b: DSLExpr }
  | { op: 'mod'; a: DSLExpr; b: DSLExpr }
  | { op: 'div'; a: DSLExpr; b: DSLExpr }
  | { op: 'gt'; a: DSLExpr; b: DSLExpr }
  | { op: 'lt'; a: DSLExpr; b: DSLExpr }
  | { op: 'eq'; a: DSLExpr; b: DSLExpr }
  | { op: 'ite'; cond: DSLExpr; then: DSLExpr; else: DSLExpr }
  | { op: 'concat'; a: DSLExpr; b: DSLExpr }
  | { op: 'lookup'; key: DSLExpr; table: Record<string, number> };

/** Canonical number formatting — the same trim `verify.num` applies. */
export function canonicalNumber(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Evaluate a program against argument values. TOTAL and deterministic: an
 * ill-typed or undefined computation (divide/mod by zero, wrong operand
 * types) returns `undefined` — never throws, never escapes an exception.
 */
export function evaluate(expr: DSLExpr, args: readonly DSLValue[]): DSLValue | undefined {
  switch (expr.op) {
    case 'arg': {
      return args[expr.index];
    }
    case 'const':
      return expr.value;
    case 'text':
      return expr.value;
    case 'add': {
      const a = evaluate(expr.a, args);
      const b = evaluate(expr.b, args);
      return typeof a === 'number' && typeof b === 'number' ? a + b : undefined;
    }
    case 'sub': {
      const a = evaluate(expr.a, args);
      const b = evaluate(expr.b, args);
      return typeof a === 'number' && typeof b === 'number' ? a - b : undefined;
    }
    case 'mul': {
      const a = evaluate(expr.a, args);
      const b = evaluate(expr.b, args);
      return typeof a === 'number' && typeof b === 'number' ? a * b : undefined;
    }
    case 'mod': {
      const a = evaluate(expr.a, args);
      const b = evaluate(expr.b, args);
      if (typeof a !== 'number' || typeof b !== 'number' || b === 0) return undefined;
      return a % b;
    }
    case 'div': {
      const a = evaluate(expr.a, args);
      const b = evaluate(expr.b, args);
      if (typeof a !== 'number' || typeof b !== 'number' || b === 0) return undefined;
      return a / b;
    }
    case 'gt': {
      const a = evaluate(expr.a, args);
      const b = evaluate(expr.b, args);
      return typeof a === 'number' && typeof b === 'number' ? a > b : undefined;
    }
    case 'lt': {
      const a = evaluate(expr.a, args);
      const b = evaluate(expr.b, args);
      return typeof a === 'number' && typeof b === 'number' ? a < b : undefined;
    }
    case 'eq': {
      const a = evaluate(expr.a, args);
      const b = evaluate(expr.b, args);
      if (a === undefined || b === undefined) return undefined;
      return a === b;
    }
    case 'ite': {
      const cond = evaluate(expr.cond, args);
      if (typeof cond !== 'boolean') return undefined;
      return cond ? evaluate(expr.then, args) : evaluate(expr.else, args);
    }
    case 'concat': {
      const a = evaluate(expr.a, args);
      const b = evaluate(expr.b, args);
      return typeof a === 'string' && typeof b === 'string' ? a + b : undefined;
    }
    case 'lookup': {
      const key = evaluate(expr.key, args);
      return typeof key === 'string' ? expr.table[key] : undefined;
    }
  }
}

/** Node count — the DSL's description-length driver. */
export function exprSize(expr: DSLExpr): number {
  switch (expr.op) {
    case 'arg':
    case 'const':
    case 'text':
      return 1;
    case 'ite':
      return 1 + exprSize(expr.cond) + exprSize(expr.then) + exprSize(expr.else);
    case 'lookup':
      return 1 + exprSize(expr.key);
    default:
      return 1 + exprSize(expr.a) + exprSize(expr.b);
  }
}

/** Per-node code cost (bits). Constants carry their value's range cost. */
const NODE_COST: Record<string, number> = {
  arg: 3,
  const: 10,
  text: 10,
  add: 4,
  sub: 4,
  mul: 4,
  mod: 4,
  div: 4,
  gt: 4,
  lt: 4,
  eq: 4,
  ite: 5,
  concat: 5,
  lookup: 8
};

/** The description length of a program in bits. */
export function programBits(expr: DSLExpr): number {
  let bits = NODE_COST[expr.op] ?? 4;
  switch (expr.op) {
    case 'arg':
    case 'const':
    case 'text':
      break;
    case 'ite':
      bits += programBits(expr.cond) + programBits(expr.then) + programBits(expr.else);
      break;
    case 'lookup':
      bits += programBits(expr.key);
      break;
    default:
      bits += programBits(expr.a) + programBits(expr.b);
  }
  return bits;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT PARSING (per drill family — mirrors `verify.ts` GENERATORS)
// ═══════════════════════════════════════════════════════════════════════════

const num = (value: string): number => canonicalNumber(Number(value));

const INTEGER = '(\\d+)';
const NEG_INTEGER = '(-?\\d+)';

/**
 * The structured args a drill family lifts from its prompt, or null when the
 * prompt does not match (a family without a parser is not inducible — that is
 * the honesty gate, not a search failure).
 */
/** The metric length units the convert-length family generates over. */
const METRIC_LENGTH_UNITS: ReadonlySet<string> = new Set([
  'millimeter', 'millimeters',
  'centimeter', 'centimeters',
  'meter', 'meters',
  'kilometer', 'kilometers'
]);

/** The conversion family a prompt belongs to, or null when it is not a
 *  well-formed conversion prompt ("how many <to> are in <n> <from>?"). */
export function conversionFamilyOf(prompt: string): 'convert-length' | 'convert-mass' | 'convert-volume' | 'convert-time' | null {
  const hit = /^how many ([a-z]+) are in \d+ ([a-z]+)\??$/i.exec(prompt.trim());
  if (hit === null) return null;
  const to = hit[1].toLowerCase();
  const from = hit[2].toLowerCase();
  const pair = `${to}<-${from}`;
  if (pair === 'seconds<-minutes' || pair === 'minutes<-hours') return 'convert-time';
  if (pair === 'grams<-kilograms' || pair === 'milligrams<-grams') return 'convert-mass';
  if (pair === 'milliliters<-liters') return 'convert-volume';
  if (METRIC_LENGTH_UNITS.has(to) && METRIC_LENGTH_UNITS.has(from)) return 'convert-length';
  return null;
}

/** The unit pair of a conversion prompt, or null. */
export function conversionPairOf(prompt: string): { from: string; to: string } | null {
  const hit = /^how many ([a-z]+) are in \d+ ([a-z]+)\??$/i.exec(prompt.trim());
  if (hit === null) return null;
  return { from: hit[2].toLowerCase(), to: hit[1].toLowerCase() };
}

export function matchArgs(drill: string, prompt: string): DSLValue[] | null {
  const m = (pattern: RegExp): RegExpMatchArray | null => prompt.match(pattern);
  switch (drill) {
    case 'addition': {
      const hit = m(new RegExp(`^what is ${INTEGER} \\+ ${INTEGER}\\??$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2])];
    }
    case 'subtraction': {
      const hit = m(new RegExp(`^what is ${INTEGER} - ${INTEGER}\\??$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2])];
    }
    case 'multiplication': {
      const hit = m(new RegExp(`^what is ${INTEGER} \\* ${INTEGER}\\??$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2])];
    }
    case 'division': {
      const hit = m(new RegExp(`^what is ${INTEGER} \\/ ${INTEGER}\\??$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2])];
    }
    case 'remainder': {
      const hit = m(new RegExp(`^what is the remainder when ${INTEGER} is divided by ${INTEGER}\\??$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2])];
    }
    case 'order-of-operations': {
      const hit = m(new RegExp(`^what is ${INTEGER} \\+ ${INTEGER} \\* ${INTEGER}\\??$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2]), num(hit[3])];
    }
    case 'comparison': {
      const hit = m(new RegExp(`^which is greater, ${INTEGER} or ${INTEGER}\\??$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2])];
    }
    case 'absolute-value': {
      const hit = m(new RegExp(`^what is the absolute value of ${NEG_INTEGER}\\??$`, 'i'));
      return hit === null ? null : [num(hit[1])];
    }
    case 'parity': {
      const hit = m(new RegExp(`^is ${INTEGER} even or odd\\??$`, 'i'));
      return hit === null ? null : [num(hit[1])];
    }
    case 'factor': {
      const hit = m(new RegExp(`^is ${INTEGER} a factor of ${INTEGER}\\??$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2])];
    }
    case 'percent': {
      const hit = m(new RegExp(`^what is ${INTEGER} percent of ${INTEGER}\\??$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2])];
    }
    case 'exponent': {
      const hit = m(new RegExp(`^what is ${INTEGER}\\^${INTEGER}\\??$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2])];
    }
    case 'square': {
      const hit = m(new RegExp(`^what is the square of ${INTEGER}\\??$`, 'i'));
      return hit === null ? null : [num(hit[1])];
    }
    case 'square-root': {
      const hit = m(new RegExp(`^what is the square root of ${INTEGER}\\??$`, 'i'));
      return hit === null ? null : [num(hit[1])];
    }
    case 'rounding': {
      const hit = m(new RegExp(`^round ${INTEGER} to the nearest ${INTEGER}\\.?$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2])];
    }
    case 'convert-length':
    case 'convert-mass':
    case 'convert-volume':
    case 'convert-time': {
      // Unit-aware, per-family parsers (H2): the generator's unit pairs are
      // validated EXPLICITLY, so a compiled rule can never fire on a prompt
      // of another family or direction — the old shared `\w+`-unit regex let
      // a convert-time rule answer "How many grams are in 5 kilograms?" as
      // "The answer is 300." (a confident fabrication on a fresh prompt).
      const hit = m(/^how many ([a-z]+) are in (\d+) ([a-z]+)\??$/i);
      if (hit === null) return null;
      const to = hit[1].toLowerCase();
      const from = hit[3].toLowerCase();
      const amount = num(hit[2]);
      const pair = `${to}<-${from}`;
      switch (drill) {
        case 'convert-time':
          // seconds in minutes · minutes in hours (both ×60, forward only).
          if (pair !== 'seconds<-minutes' && pair !== 'minutes<-hours') return null;
          return [amount];
        case 'convert-mass':
          // grams in kilograms · milligrams in grams (both ×1000, forward only).
          if (pair !== 'grams<-kilograms' && pair !== 'milligrams<-grams') return null;
          return [amount];
        case 'convert-volume':
          // milliliters in liters (×1000, forward only).
          if (pair !== 'milliliters<-liters') return null;
          return [amount];
        case 'convert-length': {
          // Any metric pair — the drill can only COMPILE a length rule when
          // the whole training set shares one factor, and the fire-time pair
          // check (rule.conversionFrom/To) makes even a lucky compile safe.
          if (!METRIC_LENGTH_UNITS.has(to) || !METRIC_LENGTH_UNITS.has(from)) return null;
          return [amount];
        }
        default:
          return null;
      }
    }
    case 'area': {
      const hit = m(new RegExp(`^what is the area of a rectangle ${INTEGER} meters by ${INTEGER} meters\\??$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2])];
    }
    case 'volume': {
      const hit = m(new RegExp(`^what is the volume of a box ${INTEGER} by ${INTEGER} by ${INTEGER} meters\\??$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2]), num(hit[3])];
    }
    case 'density': {
      const hit = m(new RegExp(`^what is the density of ${INTEGER} grams filling ${INTEGER} cubic centimeters\\??$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2])];
    }
    case 'speed': {
      const hit = m(new RegExp(`^what is the speed of something going ${INTEGER} meters in ${INTEGER} seconds\\??$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2])];
    }
    case 'force': {
      const hit = m(new RegExp(`^what force accelerates ${INTEGER} kilograms at ${INTEGER} meters per second squared\\??$`, 'i'));
      return hit === null ? null : [num(hit[1]), num(hit[2])];
    }
    case 'temperature': {
      const hit = m(new RegExp(`^what is ${NEG_INTEGER} degrees celsius in kelvin\\??$`, 'i'));
      return hit === null ? null : [num(hit[1])];
    }
    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// THE ENUMERATOR (bottom-up, observationally-equivalent-pruned)
// ═══════════════════════════════════════════════════════════════════════════

/** Constants the search tries (the curriculum's fixed factors, kept tight). */
const DEFAULT_CONSTANTS = [0, 1, 2, 10, 12, 60, 100, 273, 1000];

export interface TrainInstance {
  args: DSLValue[];
  answer: DSLValue;
}

export interface InduceOptions {
  /** Expression size cap (node count). */
  maxNodes?: number;
  /** Candidate cap before OE pruning. */
  maxCandidates?: number;
  /** Extra constants drawn from the training data. */
  dataConstants?: number[];
}

export interface InducedProgram {
  expr: DSLExpr;
  nodes: number;
  bits: number;
}

/**
 * Enumerate every expression consistent with ALL train instances, cheapest
 * first.
 *
 * The search is DIRECTED rather than exhaustive: leaf, numeric, and boolean
 * libraries are grown by size with observational-equivalence pruning (two
 * programs with identical output vectors on the train set are the same
 * hypothesis), and conditional programs are derived from the DATA — for each
 * boolean condition that splits the train set, the then/else branches are
 * searched against the two halves. That is what keeps the space tiny while
 * still reaching the 8-9 node parity/absolute-value programs.
 */
export function enumerateConsistent(
  train: readonly TrainInstance[],
  options: InduceOptions = {}
): InducedProgram[] {
  if (train.length === 0) return [];
  const maxNodes = options.maxNodes ?? 9;
  const maxCandidates = options.maxCandidates ?? 200000;

  const argCount = Math.max(...train.map((t) => t.args.length));
  // Data-derived constants only when the caller asked for them (default off:
  // the curriculum's fixed factors above are what the rules need, and a wide
  // constant space is what blows the enumeration up).
  const dataNumbers = new Set<number>();
  if (options.dataConstants !== undefined) {
    for (const value of options.dataConstants) dataNumbers.add(canonicalNumber(value));
  }
  const constants = [...new Set([...DEFAULT_CONSTANTS, ...dataNumbers])].slice(0, 40);
  const textLeaves = [...new Set([...train.map((t) => (typeof t.answer === 'string' ? t.answer : '')), 'yes', 'no', 'even', 'odd'].filter((t) => t.length > 0))];

  // Leaves (size 1).
  const leaves: DSLExpr[] = [];
  for (let i = 0; i < argCount; i += 1) leaves.push({ op: 'arg', index: i });
  for (const value of constants) leaves.push({ op: 'const', value });
  for (const value of textLeaves) leaves.push({ op: 'text', value });

  const consistent: Array<{ expr: DSLExpr; bits: number }> = [];
  const seenOutputs = new Set<string>();
  let evaluated = 0;

  const outputVector = (expr: DSLExpr): string | null => {
    let key = '';
    for (const instance of train) {
      const value = evaluate(expr, instance.args);
      if (value === undefined) return null;
      key += `${typeof value}:${String(value)};`;
    }
    return key;
  };

  /** Deduped by output vector on the FULL train set (OE pruning), capped. */
  const library = (exprs: readonly DSLExpr[], cap: number): DSLExpr[] => {
    const seen = new Set<string>();
    const out: DSLExpr[] = [];
    for (const expr of exprs) {
      if (out.length >= cap || evaluated >= maxCandidates) break;
      const key = outputVector(expr);
      if (key === null || seen.has(key)) continue;
      evaluated += 1;
      seen.add(key);
      out.push(expr);
    }
    return out;
  };

  const matches = (expr: DSLExpr, split: readonly TrainInstance[]): boolean => {
    for (const instance of split) {
      if (!dslValueEquals(evaluate(expr, instance.args), instance.answer)) return false;
    }
    return true;
  };

  const remember = (expr: DSLExpr): void => {
    if (exprSize(expr) > maxNodes) return;
    const key = outputVector(expr);
    if (key === null || seenOutputs.has(key)) return;
    seenOutputs.add(key);
    if (matches(expr, train)) consistent.push({ expr, bits: programBits(expr) });
  };

  const NUMERIC3 = ['add', 'sub', 'mul', 'mod', 'div'] as const;
  const BOOLEAN3 = ['gt', 'lt', 'eq'] as const;

  // size-3 numeric: ops over leaves.
  const rawN3: DSLExpr[] = [];
  for (const op of NUMERIC3) {
    for (const a of leaves) {
      for (const b of leaves) rawN3.push({ op, a, b });
    }
  }
  const n3 = library(rawN3, 900);

  // size-3 boolean: gt/lt/eq over leaves.
  const rawB3: DSLExpr[] = [];
  for (const op of BOOLEAN3) {
    for (const a of leaves) {
      for (const b of leaves) rawB3.push({ op, a, b });
    }
  }
  const b3 = library(rawB3, 400);

  // size-5 numeric: ops over (n3 × leaf) and (leaf × n3). BOTH the raw
  // budget and the library cap are PER OPERATOR: an overall cap was
  // exhausted by the first operator ('add') alone, so mul/div/mod-based
  // programs (percent's div(mul(a,b),100), volume's mul(mul(a,b),c)) were
  // never generated AND never survived the library dedup — those families
  // silently stayed uninducible despite having parsers.
  const N5_LIBRARY_PER_OP = 4200;
  const n5: DSLExpr[] = [];
  for (const op of NUMERIC3) {
    const block: DSLExpr[] = [];
    for (const a of n3) {
      for (const b of leaves) {
        block.push({ op, a, b });
        block.push({ op, a: b, b: a });
      }
    }
    n5.push(...library(block, N5_LIBRARY_PER_OP));
  }

  // size-5 boolean: gt/lt/eq over (n3 × leaf) and (leaf × n3) — the same
  // per-operator library budget so later operators (lt/eq) contribute too.
  const B5_LIBRARY_PER_OP = 1400;
  const b5: DSLExpr[] = [];
  for (const op of BOOLEAN3) {
    const block: DSLExpr[] = [];
    for (const a of n3) {
      for (const b of leaves) {
        block.push({ op, a, b });
        block.push({ op, a: b, b: a });
      }
    }
    b5.push(...library(block, B5_LIBRARY_PER_OP));
  }

  // Plain programs: every library member that matches the answers.
  for (const expr of [...leaves, ...n3, ...n5]) remember(expr);

  // Conditional programs: for each boolean condition that splits the train
  // set, derive then/else branches from the two halves.
  const branchLibrary = [...leaves, ...n3];
  for (const cond of [...b3, ...b5]) {
    const trueSplit: TrainInstance[] = [];
    const falseSplit: TrainInstance[] = [];
    for (const instance of train) {
      const verdict = evaluate(cond, instance.args);
      if (verdict === true) trueSplit.push(instance);
      else if (verdict === false) falseSplit.push(instance);
      else break;
    }
    if (trueSplit.length + falseSplit.length !== train.length) continue; // cond errored somewhere
    if (trueSplit.length === 0 || falseSplit.length === 0) continue; // no split — the condition is inert
    const thenExpr = findBranch(branchLibrary, trueSplit);
    const elseExpr = findBranch(branchLibrary, falseSplit);
    if (thenExpr === null || elseExpr === null) continue;
    remember({ op: 'ite', cond, then: thenExpr, else: elseExpr });
  }

  consistent.sort((a, b) => a.bits - b.bits || exprSize(a.expr) - exprSize(b.expr));
  return consistent.map((entry) => ({ expr: entry.expr, nodes: exprSize(entry.expr), bits: entry.bits }));
}

/** A program from the library consistent with EVERY instance in the split. */
function findBranch(library: readonly DSLExpr[], split: readonly TrainInstance[]): DSLExpr | null {
  outer: for (const expr of library) {
    for (const instance of split) {
      if (!dslValueEquals(evaluate(expr, instance.args), instance.answer)) continue outer;
    }
    return expr;
  }
  return null;
}

/** Canonical value equality (numbers trimmed to the verifier's precision). */
function dslValueEquals(a: DSLValue | undefined, b: DSLValue): boolean {
  if (a === undefined) return false;
  if (typeof a === 'number' && typeof b === 'number') return canonicalNumber(a) === canonicalNumber(b);
  return a === b;
}

/**
 * The full induction: enumerate consistent programs, gate by MDL
 * (programBits < instanceBits) and validate on the held-out set (above the
 * memorizer baseline by the induction margin, with the minimum-hit floor).
 * Returns the CHEAPEST program that clears both gates, or null.
 */
export function induceRule(
  train: readonly TrainInstance[],
  test: readonly TrainInstance[],
  options: {
    instanceBits: number;
    baseline: number;
    margin?: number;
    minHits?: number;
    induce?: InduceOptions;
  }
): InducedProgram | null {
  const margin = options.margin ?? 0.2;
  const minHits = options.minHits ?? 3;
  const candidates = enumerateConsistent(train, options.induce);
  const testTotal = Math.max(1, test.length);
  for (const candidate of candidates) {
    if (candidate.bits >= options.instanceBits) continue; // (c) compresses
    let correct = 0;
    for (const instance of test) {
      if (dslValueEquals(evaluate(candidate.expr, instance.args), instance.answer)) correct += 1;
    }
    const accuracy = correct / testTotal;
    if (correct >= minHits && accuracy > options.baseline + margin) {
      return candidate;
    }
  }
  return null;
}
