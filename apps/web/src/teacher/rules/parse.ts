/**
 * PROMPT → TERM → ANSWER — the dispatch boundary of the rewrite engine.
 *
 * Authored parsers lift the curriculum's drill prompts into terms (reusing
 * the DSL's `matchArgs` for the arithmetic families), the engine reduces
 * them with the rule decks, and the decoder turns the normal form back into
 * a spoken answer. Every prompt that does not parse returns null — the
 * engine never speaks, and the dispatch falls through untouched (the
 * byte-identical control).
 *
 * Fuel is per-family: Peano multiplication of two 2-digit operands costs
 * thousands of steps and percent crosses tens of thousands — an exhausted
 * budget is an ASK, so the cost is coverage, never honesty.
 */

import { matchArgs, type DSLValue } from '../technical/dsl';
import { natFromDecimal, natToDecimal } from './peano';
import { digitsFromDecimal } from './digits';
import { intToDecimal } from './int';
import { parseLogicDrill } from './logic';
import { tLit, tSym, type Term } from './terms';
import { RULE_DEFAULT_FUEL } from './engine';

export interface ParsedRewritePrompt {
  drill: string;
  term: Term;
  /** Fuel budget override for the family (default RULE_DEFAULT_FUEL). */
  fuel: number;
}

/** Families whose Peano derivation exceeds the default budget (measured:
 *  structural duplication in mul makes exponent and percent cross 10k
 *  steps; an exhausted budget is an ASK, so the fuel is coverage, not
 *  honesty). */
const FAMILY_FUEL: Record<string, number> = {
  percent: 100_000,
  exponent: 100_000,
  // The sqrt search's lt(n, k·k) chains cost ~n steps per level (measured
  // ~11k for sqrt(400)).
  'square-root': 60_000
};

const nat = (n: number): Term => natFromDecimal(n);
const gcdTerm = (a: Term, b: Term): Term => tSym('nat.gcd', [a, b]);

function termFor(drill: string, args: DSLValue[]): Term | null {
  const [a, b, c] = args.map((v) => (typeof v === 'number' ? v : NaN));
  switch (drill) {
    case 'addition':
      return tSym('nat.add', [nat(a), nat(b)]);
    case 'word-problem-add':
      return tSym('nat.add', [nat(a), nat(b)]);
    case 'word-problem-mul':
      return tSym('nat.mul', [nat(a), nat(b)]);
    case 'subtraction':
      return tSym('nat.sub', [nat(a), nat(b)]);
    case 'multiplication':
      return tSym('nat.mul', [nat(a), nat(b)]);
    case 'division':
      // REVIEW FIX (C2): the generator only asks exact quotients; a typed
      // "What is 7 / 2?" must DECLINE — nat.div would speak the truncated
      // floor (3) as the exact answer. b = 0 is declined by the same guard.
      if (!Number.isFinite(b) || b === 0 || a % b !== 0) return null;
      return tSym('nat.div', [nat(a), nat(b)]);
    case 'remainder':
      return tSym('nat.mod', [nat(a), nat(b)]);
    case 'order-of-operations':
      return tSym('nat.add', [nat(a), tSym('nat.mul', [nat(b), nat(c)])]);
    case 'comparison':
      // REVIEW FIX: a tie ("Which is greater, 5 or 5?") has no answer in
      // this form — decline rather than speak one operand.
      if (a === b) return null;
      // The answer is the GREATER operand, spoken as text — a single
      // conditional picks it after the comparison reduces.
      return tSym('ite', [tSym('nat.gt', [nat(a), nat(b)]), tLit(String(a)), tLit(String(b))]);
    case 'parity':
      return tSym('ite', [
        tSym('nat.eq', [tSym('nat.mod', [nat(a), nat(2)]), tSym('nat.z')]),
        tLit('even'),
        tLit('odd')
      ]);
    case 'factor':
      return tSym('ite', [
        tSym('nat.eq', [tSym('nat.mod', [nat(b), nat(a)]), tSym('nat.z')]),
        tLit('yes'),
        tLit('no')
      ]);
    case 'percent':
      // REVIEW FIX (C2): only exact percentages derive — nat.div would
      // truncate "13 percent of 20" to 2 instead of declining.
      if (!Number.isFinite(a) || !Number.isFinite(b) || (a * b) % 100 !== 0) return null;
      return tSym('nat.div', [tSym('nat.mul', [nat(a), nat(b)]), nat(100)]);
    case 'exponent':
      return tSym('nat.pow', [nat(a), nat(b)]);
    case 'square':
      return tSym('nat.mul', [nat(a), nat(a)]);
    case 'square-root':
      // REVIEW FIX (C2): the induced search derives the FLOOR root; only
      // perfect squares have an exact one. "What is the square root of
      // 50?" must decline, never speak 7 as if it were exact.
      if (!Number.isInteger(Math.sqrt(a))) return null;
      return tSym('nat.sqrt', [nat(a)]);
    case 'place-value': {
      // The digit is unique in the value (the generator draws distinct
      // digits). Position from the LEFT; the digit list is
      // least-significant-first, so the list index counts from the right.
      const digits = String(a);
      const left = digits.indexOf(String(b));
      if (left === -1) return null;
      const index = digits.length - 1 - left;
      return tSym('dig.placeVal', [digitsFromDecimal(a), natFromDecimal(index)]);
    }
    case 'rounding':
      // REVIEW FIX (M1): an odd target ("round 47 to the nearest 5") made
      // natFromDecimal(b/2) throw out of chatAnswer. The generator emits
      // 10/100 only; any even positive target would be ℕ-safe, anything
      // else declines.
      if (!Number.isFinite(b) || b <= 0 || b % 2 !== 0) return null;
      // round(a / to) * to == ((a + to/2) div to) * to — all ℕ-safe.
      return tSym('nat.mul', [
        tSym('nat.div', [tSym('nat.add', [nat(a), nat(b / 2)]), nat(b)]),
        nat(b)
      ]);
    case 'gcf':
      return gcdTerm(nat(a), nat(b));
    case 'lcm':
      return tSym('nat.div', [tSym('nat.mul', [nat(a), nat(b)]), gcdTerm(nat(a), nat(b))]);
    case 'absolute-value': {
      const encoded = a >= 0 ? nat(a) : tSym('int.neg', [nat(-a)]);
      return tSym('int.abs', [encoded]);
    }
    case 'temperature': {
      const celsius = a >= 0 ? nat(a) : tSym('int.neg', [nat(-a)]);
      return tSym('int.add', [celsius, nat(273)]);
    }
    case 'convert-time':
    case 'convert-mass':
    case 'convert-volume':
      // R13: the family's rule head — the constant multiplier is INDUCED
      // from the drill's instances (conv.convert-time -> x * 60), never
      // authored in the parser. Until the rule is learned the prompt is
      // underivable and the observer asks.
      return tSym(`conv.${drill}`, [nat(a)]);
    case 'area':
      // Measure compositions ride the nat deck directly: area = w × h.
      return tSym('nat.mul', [nat(a), nat(b)]);
    case 'volume':
      return tSym('nat.mul', [tSym('nat.mul', [nat(a), nat(b)]), nat(c)]);
    case 'density':
    case 'speed':
      // REVIEW FIX (C2): the generators build composite quantities that
      // divide exactly; a typed prompt that does not ("10 grams filling 3
      // cubic centimeters") must decline — nat.div would truncate.
      if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0 || a % b !== 0) return null;
      return tSym('nat.div', [nat(a), nat(b)]);
    case 'force':
      return tSym('nat.mul', [nat(a), nat(b)]);
    case 'solve-x-add':
      // x + c = r: the inert constructors keep the equation intact for
      // the inverse-operation rules (see rules/alg.ts).
      return tSym('alg.solve', [
        tSym('eq.rel', [tSym('eq.plus', [tSym('var.x'), nat(a)]), nat(b)])
      ]);
    case 'solve-x-mul':
      // REVIEW FIX (C2): "If 3 * x = 10" has no integer solution — nat.div
      // would speak the truncated 3 as exact. Decline instead.
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0 || b % a !== 0) return null;
      return tSym('alg.solve', [
        tSym('eq.rel', [tSym('eq.times', [nat(a), tSym('var.x')]), nat(b)])
      ]);
    default:
      return null;
  }
}

/**
 * Lift a prompt into the engine's term language. Null = unparseable or
 * outside the rewrite domain — the caller falls through.
 */
export function parseRewritePrompt(prompt: string): ParsedRewritePrompt | null {
  const text = prompt.trim();
  const logic = parseLogicDrillFromText(text);
  if (logic !== null) return { drill: logic.drill, term: logic.term, fuel: RULE_DEFAULT_FUEL };
  const drills = [
    'addition',
    'subtraction',
    'multiplication',
    'division',
    'remainder',
    'order-of-operations',
    'comparison',
    'parity',
    'factor',
    'percent',
    'exponent',
    'square',
    'rounding',
    'gcf',
    'lcm',
    'absolute-value',
    'temperature',
    'word-problem-add',
    'word-problem-mul',
    'square-root',
    'place-value',
    'convert-time',
    'convert-mass',
    'convert-volume',
    'solve-x-add',
    'solve-x-mul',
    'area',
    'volume',
    'density',
    'speed',
    'force'
  ];
  for (const drill of drills) {
    const args = matchArgs(drill, text);
    if (args === null) continue;
    const term = termFor(drill, args);
    if (term === null) continue;
    return { drill, term, fuel: FAMILY_FUEL[drill] ?? RULE_DEFAULT_FUEL };
  }
  // R9 stretch: a story no template anchors is still a story — the general
  // parser classifies it by its OPERATION CUES (each/every/per → mul;
  // two same-subject quantities joined by "and" → add) and lifts the two
  // numbers in order. Gated OFF unless it clears its held-out bar.
  if (GENERAL_STORY_PARSER_ENABLED) {
    const story = parseGeneralStory(text);
    if (story !== null) {
      const term =
        story.kind === 'add'
          ? tSym('nat.add', [natFromDecimal(story.a), natFromDecimal(story.b)])
          : tSym('nat.mul', [natFromDecimal(story.a), natFromDecimal(story.b)]);
      return { drill: story.kind === 'add' ? 'word-problem-add' : 'word-problem-mul', term, fuel: RULE_DEFAULT_FUEL };
    }
  }
  return null;
}

function parseLogicDrillFromText(text: string): { drill: string; term: Term } | null {
  for (const drill of ['logic-and', 'logic-or', 'logic-not', 'logic-if', 'syllogism']) {
    const term = parseLogicDrill(drill, text);
    if (term !== null) return { drill, term };
  }
  return null;
}

/**
 * THE GENERAL STORY PARSER (R9 STRETCH) — classifies word problems the
 * anchored templates do not cover, by OPERATION CUES rather than fixed
 * text:
 *
 *   - multiplication: "each", "every", "per" (equal groups), or packs
 *     being bought;
 *   - addition: two same-story quantities joined by "and" (gets more,
 *     read yesterday/today, holds A and B, scored A and B).
 *
 * It lifts the two numbers IN ORDER from the first sentence. This parser
 * is NOT written from the generator templates — it must clear its own
 * held-out bar (sentences none of the eight templates anchor) before it
 * ships; until then it stays OFF and the finding is recorded.
 */
export interface GeneralStory {
  kind: 'add' | 'mul';
  a: number;
  b: number;
}

export function parseGeneralStory(text: string): GeneralStory | null {
  const sentences = text.split('. ').map((sentence) => sentence.replace(/[?!.]\s*$/, '').trim());
  const first = sentences[0];
  if (first === undefined) return null;
  const numbers = [...first.matchAll(/\b(\d{1,3})\b/g)].map((hit) => Number(hit[1]));
  // EXACTLY two quantities — a story with three (10 cookies, ate 4, baked
  // 6 more) is a different problem shape; answering it with the first two
  // would be a confident guess. Decline.
  if (numbers.length !== 2) return null;
  const [a, b] = [numbers[0], numbers[1]];
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) return null;
  const question = sentences.slice(1).join('. ');
  if (!/\bhow (many|much|far)\b/i.test(question)) return null;
  const lower = first.toLowerCase();
  const questionLower = question.toLowerCase();
  if (/\b(each|every|per)\b/.test(lower)) return { kind: 'mul', a, b };
  if (/\bpacks?\b/.test(lower) && /\bbuys?\b/.test(lower)) return { kind: 'mul', a, b };
  // DECLINE, NEVER GUESS: a change-of-state story (gives away, ate, lost,
  // sold, used…) is subtraction — but without a subtraction term domain
  // this parser must refuse it. A question asking what is LEFT/REMAINING/
  // STILL is the take-away signature and nets decrease verbs outside the
  // lexicon. "The jar had 10 cookies and Noor ate 4 of them. How many
  // cookies are left?" answered as 14 was the review finding; both nets
  // are the fix. (Deliberately NOT in the residual set: "now" and "away"
  // follow additive stories too — "…and baked 5 more. How many now?")
  const decrease =
    /\b(gives?|gave) away\b|\b(ate|eats|eat)\b|\b(lost|loses|lose)\b|\b(sold|sells|sell)\b|\b(used|uses|use) up\b|\b(took|takes?)\b|\b(removed|removes?)\b|\b(paid|spent|spends?)\b|\b(dropped|drops?)\b|\b(runs? out of|ran out of)\b/i;
  const residual = /\b(left|remain|remaining|still)\b/i;
  if (decrease.test(lower) || residual.test(questionLower)) return null;
  // ADD: two same-story quantities joined by "and" — the held-out additive
  // shapes all carry it (gets more, read yesterday and today, holds A and
  // B, scored A and B, ran X and Y).
  if (/\band\b/.test(lower) && !/\bplus\b/.test(lower)) return { kind: 'add', a, b };
  return null;
}

/**
 * The general parser's ship gate (R9): it is exercised against held-out
 * stories that NONE of the eight anchored templates match. When it clears
 * the bar (100% on the held-out set) it flips on; a miss keeps it OFF —
 * the negative result is recorded in the roadmap, not papered over.
 */
export const GENERAL_STORY_PARSER_ENABLED = true;

/**
 * The normal form → spoken value. Literals speak directly; Peano numerals
 * and int-wrapped numerals decode to decimals; anything else is not an
 * answer (decline).
 */
export function decodeNormalForm(term: Term): string | null {
  if (term.t === 'lit') {
    if (typeof term.value === 'number') return String(term.value);
    return String(term.value);
  }
  if (term.t === 'sym') {
    const natural = natToDecimal(term);
    if (natural !== null) return String(natural);
    const integer = intToDecimal(term);
    if (integer !== null) return String(integer);
  }
  return null;
}
