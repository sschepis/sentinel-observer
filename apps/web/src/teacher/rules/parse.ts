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
 * It lifts the two numbers IN ORDER from the body. This parser is NOT
 * written from the generator templates — it must clear its own held-out
 * bar (sentences none of the eight templates anchor) before it ships.
 *
 * ITS CONTRACT IS HONESTY, NOT COVERAGE: whatever it answers is exact, and
 * every shape it does not fully understand is declined — three or more
 * quantities, a number in the question, decimals, comparisons ("how many
 * more than"), shares ("each" in the question), periods and ratios ("every
 * 12 days", "7 eggs for every 2 cups"), take-aways, and a sum asked about
 * one of two kinds. The word-problem bench (curriculum/problemsBenchmark)
 * measures both rates against the SVAMP/ASDiv corpus.
 */
export interface GeneralStory {
  kind: 'add' | 'mul';
  a: number;
  b: number;
}

/** The word a quantity counts: the first token after the number that is not
 *  a continuation ("more", "other") or a preposition. `null` when the number
 *  stands alone ("borrows 2 more"). Singularised by stripping a plural s. */
const NOT_A_NOUN = /^(more|other|extra|new|additional|of|the|a|an|in|on|at|per|each|every|with|for|to|from|and|into|about|than)$/;
function quantityNoun(body: string, index: number): string | null {
  const tail = body.slice(index).replace(/^\d+(?:\.\d+)?\s*/, '');
  const words = tail.toLowerCase().match(/^[a-z]+(?:\s+[a-z]+){0,2}/)?.[0].split(/\s+/) ?? [];
  const noun = words.find((word) => !NOT_A_NOUN.test(word));
  return noun === undefined ? null : noun.replace(/s$/, '');
}

/** What the question counts: the word after "how many/much", singularised. */
function askedNoun(question: string): string | null {
  return question.match(/\bhow (?:many|much)\s+([a-z]+)/)?.[1]?.replace(/s$/, '') ?? null;
}

export function parseGeneralStory(text: string): GeneralStory | null {
  // The question is the last "how many/much/far" clause; the body is
  // everything before it. Splitting on sentence punctuation is not enough —
  // corpus problems run "If there are 19 houses on a block How many…".
  const questionAt = text.search(/\bhow (many|much|far)\b(?![^]*\bhow (many|much|far)\b)/i);
  if (questionAt < 0) return null;
  const body = text.slice(0, questionAt);
  const question = text.slice(questionAt);
  // EXACTLY two quantities IN THE WHOLE BODY — a story with three (10
  // cookies, ate 4, baked 6 more; 56 aquariums and 10 aquariums, 39 in
  // each) is a different problem shape; answering it with any two would be
  // a confident guess. The 2026-09-09 bench found 19 of 24 answers wrong for
  // exactly that reason, so the count covers every sentence of the body and
  // a number in the question ("already has 16 square feet") declines too.
  // Decimals and fractions are not in the naturals engine: decline.
  const numbers = [...body.matchAll(/\d+(?:\.\d+)?/g)];
  if (numbers.length !== 2 || /\d/.test(question) || numbers.some((hit) => hit[0].includes('.')) || /\d\s*\/\s*\d/.test(text)) return null;
  const [a, b] = [Number(numbers[0][0]), Number(numbers[1][0])];
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) return null;
  const lower = body.toLowerCase();
  const questionLower = question.toLowerCase();
  const asked = askedNoun(questionLower);
  // COMPARISON questions ("how many more … than", "how much longer", "the
  // difference", "how much additional") ask for a difference, which this
  // parser cannot form; "each/every/per" IN THE QUESTION asks for a share
  // (division). Decline both — the bench's wrong answers were sums and
  // products given to exactly these.
  if (/\b(more|fewer|less|additional|longer|shorter|taller|heavier|older|younger|bigger|smaller|farther|further|difference)\b/.test(questionLower)) return null;
  if (/\b(each|every|per|apiece)\b/.test(questionLower)) return null;
  // "how many students will NOT be on a team" is a remainder: decline.
  if (/\b(not|without|n't)\b/.test(questionLower)) return null;
  // AN UNKNOWN START OR CHANGE: "Tommy had some balloons … then had 60. How
  // many to start with?", "after some more arrived he had 8. How many new
  // customers?" — the two stated numbers are a change and an end state; the
  // unknown is the third quantity the story leaves out. Decline.
  if (/\bsome (more|of the|[a-z]+s)\b/.test(lower) || /\b(to start with|to begin with|at first|originally|initially|new)\b/.test(questionLower)) return null;
  // The BODY can also give the shape away: "every 12 days" and "7 eggs for
  // every 2 cups" are periods and ratios, not equal groups (an equal-groups
  // cue never precedes a number); "Tara had $4 more than Megan" states a
  // difference; "together their strawberries weighed 37" / "a total of 36
  // points" states the WHOLE, so the unknown is a part or a share.
  if (/\b(each|every|per)\s+\d/.test(lower) || /\b(every|each) (other|few|several|second|third)\b/.test(lower)) return null;
  if (/\b(more|fewer|less)\b[^.?]*\bthan\b/.test(lower)) return null;
  if (/\b(total|in all|altogether|all together|together|combined)\b/.test(lower)) return null;
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
  const nounA = quantityNoun(body, numbers[0].index ?? 0);
  const nounB = quantityNoun(body, numbers[1].index ?? 0);
  // EQUAL GROUPS: N groups × M in each = the items. The answer counts the
  // ITEMS — "17 apples in each basket … how many apples". A question that
  // counts the GROUPS ("each bucket holds 9 apples … how many buckets",
  // "each van holds 9 students … how many vans") is a division, and a
  // question counting something neither quantity counts is a shape this
  // parser does not understand. Both decline.
  const groups = lower.match(/\b(?:each|every|per)\s+(?:[a-z]+\s+)?([a-z]+)/)?.[1]?.replace(/s$/, '') ?? null;
  if (/\b(each|every|per)\b/.test(lower) || (/\bpacks?\b/.test(lower) && /\bbuys?\b/.test(lower))) {
    if (asked !== null) {
      if (asked === groups) return null;
      if (asked !== nounA && asked !== nounB) return null;
    }
    return { kind: 'mul', a, b };
  }
  // ADD: two same-story quantities JOINED — "A and B", "A … then B more",
  // "A … If B more got on" — the held-out additive shapes all carry a join
  // between the two numbers. "Allan and Jake brought 3 balloons. If Allan
  // brought 2 …" has no join between the numbers: it is a part of a whole,
  // and the sum would be wrong. Then "4 birds and 46 storks … How many
  // birds?" asks about ONE of two kinds: when the quantities count
  // different things and the question names one of them, decline. A
  // question naming neither (girls and boys → pupils; geese and ducks →
  // birds) or carrying a total cue is the sum.
  if (/\bplus\b/.test(lower)) return null;
  const secondAt = numbers[1].index ?? 0;
  const between = lower.slice((numbers[0].index ?? 0) + numbers[0][0].length, secondAt);
  const secondTail = lower.slice(secondAt + numbers[1][0].length).trimStart();
  if (!/\b(and|then|more|also|another)\b/.test(between) && !/^(more|other|additional|extra)\b/.test(secondTail)) return null;
  if (nounA !== null && nounB !== null && nounA !== nounB) {
    const totalCue = /\b(in all|altogether|all together|in total|total|combined|together)\b/.test(questionLower);
    if (!totalCue && asked !== null && (asked === nounA || asked === nounB)) return null;
    // A THIRD noun without a total cue: "girls and boys → how many pupils"
    // is the sum, but "35 elephants and 48 tigers → how many legs" and "22
    // bicycles and 3 cars → how many wheels" are not — they need the world
    // (legs per elephant), which this parser does not have. The honest
    // reading needs the relation store (is "pupil" a kind both quantities
    // fall under?) — until the parser can ask it, decline.
    if (!totalCue && asked !== null && asked !== nounA && asked !== nounB) return null;
  }
  return { kind: 'add', a, b };
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
