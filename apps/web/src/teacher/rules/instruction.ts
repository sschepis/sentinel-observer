/**
 * TAUGHT RULES — English procedures become rewrite rules (R10).
 *
 * One sentence of instruction replaces twenty drilled instances — but the
 * parse is never the gate; VALIDATION is. `parseTaughtRule` turns a
 * bounded procedure statement into a candidate rule over the library's
 * vocabulary; `validateTaughtRule` simulates it against the family's
 * deterministic oracle BEFORE adoption. A taught rule starts hedged
 * (origin 'taught', no corroboration) until the world's grades confirm it.
 *
 * The grammar is deliberate and versioned — a procedure that does not
 * parse is declined, and the decline says so. What parses must still prove
 * itself on held-out instances.
 */

import { tSym, tVar, termBits, type Term } from './terms';
import { reduce } from './engine';
import { RuleStore, type RewriteRule, type RuleOrigin } from './types';
import { generateExercises } from '../technical/verify';
import { natFromDecimal } from './peano';
import { parseRewritePrompt, decodeNormalForm } from './parse';

export interface TaughtRuleSpec {
  /** The rule symbol to synthesize, e.g. 'nat.gcd'. */
  name: string;
  /** Argument labels in order, e.g. ['a', 'b']. */
  args: string[];
}

const ZERO = tSym('nat.z');

/** The English tail of a namespaced symbol — 'nat.gcd' → 'gcd' — the
 *  phrase recursion is stated with. */
function englishName(name: string): string {
  const tail = name.split('.').pop() ?? name;
  return tail.toLowerCase();
}

/** One of the rule's argument variables, or null. */
function argVar(label: string, spec: TaughtRuleSpec): Term | null {
  const name = label
    .trim()
    .replace(/^the (first|second) number$/, (_match, which: string) =>
      which === 'first' ? (spec.args[0] ?? '') : (spec.args[1] ?? '')
    );
  const index = spec.args.indexOf(name);
  return index === -1 ? null : tVar(spec.args[index]);
}

const WRAPPER = /^(?:the answer|the result|it)(?: is| equals| would be)\s+(.+)$/i;

/**
 * Parse an expression phrase into a term. The grammar v1:
 *
 *   expr   := <var> | "zero" | "the remainder of <e> divided by <e>"
 *           | "the <op> of <e> and <e>" | <e> <verb> <e>
 *   op     := gcd (recursion by the rule's own name), sum/addition/total,
 *             product/multiplication, difference
 *   verb   := plus / times / minus / divided by
 *
 * Everything else is null — declined, never guessed.
 */
function parseExpr(raw: string, spec: TaughtRuleSpec): Term | null {
  let text = raw.trim().replace(/\.$/, '').trim();
  for (;;) {
    const wrapper = text.match(WRAPPER);
    if (wrapper === null) break;
    text = (wrapper[1] ?? '').trim();
  }
  const varTerm = argVar(text, spec);
  if (varTerm !== null) return varTerm;
  if (/^zero$/i.test(text)) return ZERO;
  if (/^\d+$/.test(text)) return natFromDecimal(Number(text));
  const remainder = text.match(/^the remainder of (.+?) divided by (.+)$/i);
  if (remainder !== null) {
    const a = parseExpr(remainder[1] ?? '', spec);
    const b = parseExpr(remainder[2] ?? '', spec);
    if (a === null || b === null) return null;
    return tSym('nat.mod', [a, b]);
  }
  const of = text.match(/^the (gcd|sum|addition|total|product|multiplication|difference|remainder) of (.+?) and (.+)$/i);
  if (of !== null) {
    const op = (of[1] ?? '').toLowerCase();
    const a = parseExpr(of[2] ?? '', spec);
    const b = parseExpr(of[3] ?? '', spec);
    if (a === null || b === null) return null;
    if (op === 'gcd') return tSym(spec.name, [a, b]);
    if (op === 'sum' || op === 'addition' || op === 'total') return tSym('nat.add', [a, b]);
    if (op === 'product' || op === 'multiplication') return tSym('nat.mul', [a, b]);
    if (op === 'difference') return tSym('nat.sub', [a, b]);
    return tSym('nat.mod', [a, b]);
  }
  const infix = text.match(/^(.+?) (plus|times|minus|divided by) (.+)$/i);
  if (infix !== null) {
    const verb = (infix[2] ?? '').toLowerCase();
    const a = parseExpr(infix[1] ?? '', spec);
    const b = parseExpr(infix[3] ?? '', spec);
    if (a === null || b === null) return null;
    if (verb === 'plus') return tSym('nat.add', [a, b]);
    if (verb === 'times') return tSym('nat.mul', [a, b]);
    if (verb === 'minus') return tSym('nat.sub', [a, b]);
    return tSym('nat.div', [a, b]);
  }
  return null;
}

/** Monotonic counter so same-millisecond adoptions never share an id
 *  (review finding: Date.now() ids collide in register). */
let adoptionCounter = 0;

/** Compose the candidate rule from a parsed body term. The LHS is built
 *  from the EFFECTIVE spec — the labels the procedure head actually listed
 *  (renamed arguments must bind the body's variables; composing from the
 *  default spec crashed with an uncaught unbound-variable throw). */
function composeRule(spec: TaughtRuleSpec, rhs: Term, origin: RuleOrigin): RewriteRule {
  adoptionCounter += 1;
  const lhs = tSym(spec.name, spec.args.map((arg) => tVar(arg)));
  return {
    id: `${origin}-${spec.name}-${Date.now()}-${adoptionCounter}`,
    name: spec.name,
    lhs,
    rhs,
    origin,
    strength: 1,
    sourceClasses: [],
    bits: termBits(lhs) + termBits(rhs),
    evidence: 0,
    active: true,
    createdAt: Date.now(),
    useCount: 0
  };
}

/** The procedure slot a drill family accepts (R10): the rewrite target
 *  plus the argument labels the taught procedure may name. Null = the
 *  family has no taught-rule slot yet. */
export function taughtRuleSpecFor(drill: string): TaughtRuleSpec | null {
  if (drill === 'gcf') return { name: 'nat.gcd', args: ['a', 'b'] };
  return null;
}

/**
 * Parse a taught procedure into a candidate rule. Statement shapes v1:
 *
 *   "<lead-in> <english-name> of <args>: if <var> is|equals zero (the
 *     answer|it) is <expr>; otherwise (the answer|it) is <expr>"
 *
 * The flagship sentence this grammar was written for:
 *   "to find the gcd of a and b: if b is zero the answer is a; otherwise
 *     it is the gcd of b and the remainder of a divided by b."
 *
 * The head (up to the first ':') may be omitted — a bare procedure body
 * parses too. Returns null for anything outside the grammar — the caller
 * declines and explains, never adopts.
 */
export function parseTaughtRule(text: string, spec: TaughtRuleSpec, origin: RuleOrigin = 'taught'): RewriteRule | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const english = englishName(spec.name);
  // The head ("to find the gcd of a and b") ends at a colon OR a comma —
  // "to find the gcd of a and b, if b is zero…" is as natural as the
  // colon form. A bare procedure body ("if b is zero…") has no head.
  const headRe = new RegExp(
    `^((?:(?:to find|to compute|to work out|the rule for|here is how to find)\\s+)?(?:the\\s+)?${english}(?: of .+?)?)\\s*[,:]\\s+`,
    'i'
  );
  const headHit = normalized.match(headRe);
  const headLabel = headHit !== null ? (headHit[1] ?? '').trim() : null;
  const body = headHit !== null ? normalized.slice(headHit[0].length).trim() : normalized.trim();

  let args = spec.args;
  if (headLabel !== null) {
    const listedMatch = headLabel.match(new RegExp(`(?: of (.+))$`, 'i'));
    const listed = (listedMatch?.[1] ?? '').trim();
    if (listed.length > 0) {
      const parts = listed
        .split(/\s+and\s+|,/i)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      if (parts.length !== spec.args.length) return null;
      args = parts;
    }
  }
  const effective = { ...spec, args };

  const conditional = body.match(
    /^if (.+?),? (?:the answer|the result|it)(?: is| equals) (.+?)(?:;|\.)\s+(?:otherwise|if not),? (?:the answer|the result|it)(?: is| equals) (.+)$/i
  );
  if (conditional === null) return null;
  const condMatch = (conditional[1] ?? '').trim().match(/^(.+?)\s+(?:is|equals)(?: zero| 0)$/i);
  if (condMatch === null) return null;
  const varTerm = argVar(condMatch[1] ?? '', effective);
  const thenTerm = parseExpr(conditional[2] ?? '', effective);
  const elseTerm = parseExpr(conditional[3] ?? '', effective);
  if (varTerm === null || thenTerm === null || elseTerm === null) return null;
  return composeRule(effective, tSym('ite', [tSym('nat.eq', [varTerm, ZERO]), thenTerm, elseTerm]), origin);
}

/**
 * The adoption gate: a taught procedure must prove itself on the family's
 * deterministic oracle BEFORE it is registered. Returns the verdict and,
 * on failure, the counterexample the rule produced.
 */
export function validateTaughtRule(
  store: RuleStore,
  rule: RewriteRule,
  drill: string,
  options: { baseline: number; margin?: number; minHits?: number; seed?: number; count?: number; fuel?: number }
): { ok: boolean; counterexample?: string } {
  const margin = options.margin ?? 0.2;
  const minHits = options.minHits ?? 3;
  const fuel = options.fuel ?? 20_000;
  const exercises = generateExercises(drill, 'concept', { count: options.count ?? 44, seed: options.seed ?? 0x7a07 });
  // REVIEW FIX (M3): the candidate must be validated ALONE — an incumbent
  // same-name rule in the library would answer every exercise first
  // (first-match-wins), certifying a rule that was never tested.
  const library = store.all().filter((entry) => entry.name !== rule.name);
  const probe = new RuleStore([...library, rule], store.allDenials());
  let correct = 0;
  for (const exercise of exercises) {
    const parsed = parseRewritePrompt(exercise.prompt);
    if (parsed === null) {
      return { ok: false, counterexample: `I could not understand this one: ${exercise.prompt}` };
    }
    const { outcome } = reduce(probe, parsed.term, { fuel });
    if (outcome.status !== 'normal') {
      return { ok: false, counterexample: `I could not finish this one: ${exercise.prompt}` };
    }
    const spoken = decodeNormalForm(outcome.term);
    if (spoken !== String(exercise.answer)) {
      return {
        ok: false,
        counterexample: `I tried ${exercise.prompt} — the rule gives ${spoken ?? 'nothing'}, but the answer is ${exercise.answer}.`
      };
    }
    correct += 1;
  }
  const ok = correct >= minHits && correct / exercises.length > options.baseline + margin;
  return ok ? { ok: true } : { ok: false, counterexample: `the rule only got ${correct}/${exercises.length} right — I cannot trust it yet.` };
}
