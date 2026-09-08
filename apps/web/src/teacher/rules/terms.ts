/**
 * TERMS — the object language of the rewrite engine.
 *
 * A Term is a first-order term: variables (bound by pattern match),
 * literals (numbers, strings, booleans), and symbols with argument lists.
 * Everything is plain JSON-serializable data so rules persist through the
 * existing record formats unchanged.
 *
 * The engine's natives are matching, substitution, `ite`, and the fuel
 * counter — nothing else. All arithmetic and logic lives in rules.
 */

export type Term =
  | { t: 'var'; name: string }
  | { t: 'lit'; value: string | number | boolean }
  | { t: 'sym'; head: string; args: Term[] };

export const tVar = (name: string): Term => ({ t: 'var', name });
export const tLit = (value: string | number | boolean): Term => ({ t: 'lit', value });
export const tSym = (head: string, args: readonly Term[] = []): Term => ({ t: 'sym', head, args: [...args] });

export const TRUE = tLit(true);
export const FALSE = tLit(false);

/** Canonical string form — the equality/hash/cycle-memo key. Literals carry
 *  their TYPE tag so `1`, `'1'`, and `true` never collide. ITERATIVE: a
 *  Peano numeral of 30,000 `nat.s` nodes (percent's derivation builds them)
 *  would overflow a recursive descent. */
export function termToString(term: Term): string {
  type Frame = { text?: string; close?: boolean; node?: Term };
  const parts: string[] = [];
  const stack: Frame[] = [{ node: term }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.text !== undefined) {
      parts.push(frame.text);
      continue;
    }
    if (frame.close === true) {
      parts.push(')');
      continue;
    }
    const node = frame.node!;
    switch (node.t) {
      case 'var':
        parts.push(`?${node.name}`);
        break;
      case 'lit':
        parts.push(
          typeof node.value === 'number'
            ? `#n:${String(node.value)}`
            : typeof node.value === 'string'
              ? `#s:${node.value}`
              : `#b:${String(node.value)}`
        );
        break;
      case 'sym':
        if (node.args.length === 0) {
          parts.push(node.head);
        } else {
          parts.push(node.head, '(');
          // Pop order is arg0, ',', arg1, ',', …, ')': push from the close
          // frame up, args in reverse with separators between.
          stack.push({ close: true });
          for (let i = node.args.length - 1; i >= 1; i -= 1) {
            stack.push({ node: node.args[i] });
            stack.push({ text: ',' });
          }
          stack.push({ node: node.args[0] });
        }
        break;
    }
  }
  return parts.join('');
}

export const hashTerm = termToString;

/** Bounded serialization for derivation traces — a long trace never
 *  balloons the persisted record. */
export function serializeBounded(term: Term, maxChars = 80): string {
  const text = termToString(term);
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Structural equality. */
export function equals(a: Term, b: Term): boolean {
  return termToString(a) === termToString(b);
}

/** Node count. */
export function size(term: Term): number {
  return term.t === 'sym' ? 1 + term.args.reduce((sum, arg) => sum + size(arg), 0) : 1;
}

/** True for a literal term (the engine's notion of "an answer"). */
export function isLiteral(term: Term): term is { t: 'lit'; value: string | number | boolean } {
  return term.t === 'lit';
}

/** The free variables of a term. */
export function freeVars(term: Term): Set<string> {
  const out = new Set<string>();
  const walk = (node: Term): void => {
    if (node.t === 'var') out.add(node.name);
    else if (node.t === 'sym') for (const arg of node.args) walk(arg);
  };
  walk(term);
  return out;
}

/**
 * Structural pattern match. `pattern` is the rule LHS; `term` is the
 * candidate redex. A var binds once — a repeated var requires the two
 * positions to be EQUAL terms (so `add(x, x)` never matches 2+3). Returns
 * null when the pattern does not match.
 */
export function matchPattern(pattern: Term, term: Term, bindings: Map<string, Term> = new Map()): Map<string, Term> | null {
  switch (pattern.t) {
    case 'var': {
      const existing = bindings.get(pattern.name);
      if (existing !== undefined) return equals(existing, term) ? bindings : null;
      bindings.set(pattern.name, term);
      return bindings;
    }
    case 'lit':
      return equals(pattern, term) ? bindings : null;
    case 'sym': {
      if (term.t !== 'sym' || term.head !== pattern.head || term.args.length !== pattern.args.length) return null;
      for (let i = 0; i < pattern.args.length; i += 1) {
        const next = matchPattern(pattern.args[i], term.args[i], bindings);
        if (next === null) return null;
      }
      return bindings;
    }
  }
}

/**
 * Instantiate a template with bindings. Only called with complete bindings
 * (the rule store refuses to register a rule whose RHS has free variables
 * its LHS does not bind), so an unbound variable is a programmer error and
 * fails loudly rather than emitting a hole.
 */
export function substitute(template: Term, bindings: ReadonlyMap<string, Term>): Term {
  switch (template.t) {
    case 'var': {
      const value = bindings.get(template.name);
      if (value === undefined) throw new Error(`unbound variable ?${template.name} in rule body`);
      return value;
    }
    case 'lit':
      return template;
    case 'sym':
      return template.args.length === 0 ? template : tSym(template.head, template.args.map((arg) => substitute(arg, bindings)));
  }
}

/** Description length of a term in bits — the rule MDL cost (node-based,
 *  mirroring the DSL's NODE_COST discipline). */
export function termBits(term: Term): number {
  switch (term.t) {
    case 'var':
      return 3;
    case 'lit':
      return 10;
    case 'sym':
      return 4 + term.args.reduce((sum, arg) => sum + termBits(arg), 0);
  }
}

// ── Readable form (derivation display) ──────────────────────────────────────
// `termToString` is the canonical key: exact, typed, and unreadable for a
// human ("nat.s(nat.s(nat.s(…" thirty-six deep for the numeral 36). The
// derivation trace the chat unfolds is for a person, so it is printed in the
// notation the rules stand for: Peano numerals as digits, `ite` as
// if/then/else, the arithmetic and logic heads as infix. Display only —
// never a hash, never compared.

const INFIX: Readonly<Record<string, string>> = {
  'nat.add': '+',
  'int.add': '+',
  'eq.plus': '+',
  'nat.sub': '−',
  'int.sub': '−',
  'eq.minus': '−',
  'nat.mul': '×',
  'eq.times': '×',
  'nat.div': '÷',
  'nat.mod': 'mod',
  'nat.pow': '^',
  'nat.lt': '<',
  'nat.gt': '>',
  'nat.ge': '≥',
  'nat.eq': '=',
  'eq.rel': '=',
  'bool.and': '∧',
  'bool.or': '∨'
};

/** Count a `nat.s` chain iteratively (a numeral can be tens of thousands
 *  deep). Returns the depth and the innermost non-`nat.s` term. */
function peelNumeral(term: Term): { depth: number; core: Term } {
  let depth = 0;
  let core = term;
  while (core.t === 'sym' && core.head === 'nat.s' && core.args.length === 1) {
    depth += 1;
    core = core.args[0];
  }
  return { depth, core };
}

/** Binding strength of an infix head — higher binds tighter. A child is
 *  parenthesized when it binds looser than its parent (or equally, on the
 *  right: `a − (b − c)`); comparison under arithmetic never happens, and
 *  arithmetic under a comparison needs no brackets ("x + 2 = 5"). */
const PRECEDENCE: Readonly<Record<string, number>> = {
  '=': 1, '<': 1, '>': 1, '≥': 1,
  '∨': 2,
  '∧': 3,
  '+': 4, '−': 4,
  '×': 5, '÷': 5, 'mod': 5,
  '^': 6
};

function infixPrecedence(term: Term): number | null {
  if (term.t !== 'sym' || term.args.length !== 2) return null;
  const op = INFIX[term.head];
  return op === undefined ? null : PRECEDENCE[op] ?? 4;
}

/** The readable form of a term. Bounded by `maxChars` (default 80) like
 *  the canonical trace serialization, so a pathological term still cannot
 *  balloon the record. */
export function prettyTerm(term: Term, maxChars = 80): string {
  /** A child under an operator of precedence `parent`: bracketed when it
   *  binds looser (or equally on the right), or when it is an if/then/else. */
  const wrap = (child: Term, parent: number, right = false): string => {
    const text = pretty(child);
    if (child.t === 'sym' && child.head === 'ite') return `(${text})`;
    const prec = infixPrecedence(child);
    if (prec === null) return text;
    return prec < parent || (right && prec === parent) ? `(${text})` : text;
  };
  const pretty = (node: Term): string => {
    switch (node.t) {
      case 'var':
        return `?${node.name}`;
      case 'lit':
        return typeof node.value === 'string' ? `"${node.value}"` : String(node.value);
      case 'sym': {
        if (node.head === 'nat.z' && node.args.length === 0) return '0';
        if (node.head === 'nat.s' && node.args.length === 1) {
          const { depth, core } = peelNumeral(node);
          if (core.t === 'sym' && core.head === 'nat.z' && core.args.length === 0) return String(depth);
          // A numeral wrapped around an unreduced expression: "(x − 1) + 3".
          return `${wrap(core, PRECEDENCE['+'])} + ${depth}`;
        }
        if (node.head === 'ite' && node.args.length === 3) {
          return `if ${pretty(node.args[0])} then ${pretty(node.args[1])} else ${pretty(node.args[2])}`;
        }
        if (node.head === 'int.neg' && node.args.length === 1) return `−${wrap(node.args[0], 7)}`;
        if (node.head === 'int.abs' && node.args.length === 1) return `|${pretty(node.args[0])}|`;
        if (node.head === 'bool.not' && node.args.length === 1) return `¬${wrap(node.args[0], 7)}`;
        if (node.head === 'list.nil' && node.args.length === 0) return '[]';
        if (node.head === 'list.cons' && node.args.length === 2) {
          const items: string[] = [];
          let cursor: Term = node;
          while (cursor.t === 'sym' && cursor.head === 'list.cons' && cursor.args.length === 2) {
            items.push(pretty(cursor.args[0]));
            cursor = cursor.args[1];
          }
          const tail = cursor.t === 'sym' && cursor.head === 'list.nil' ? '' : ` | ${pretty(cursor)}`;
          return `[${items.join(', ')}${tail}]`;
        }
        if (node.head.startsWith('var.') && node.args.length === 0) return node.head.slice(4);
        const infix = INFIX[node.head];
        if (infix !== undefined && node.args.length === 2) {
          const prec = PRECEDENCE[infix] ?? 4;
          return `${wrap(node.args[0], prec)} ${infix} ${wrap(node.args[1], prec, true)}`;
        }
        if (node.args.length === 0) return node.head;
        return `${node.head}(${node.args.map(pretty).join(', ')})`;
      }
    }
  };
  const text = pretty(term);
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
