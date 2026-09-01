/**
 * The operator layer: deterministic answers to NOVEL questions, computed
 * from the observer's OWN memory rather than echoed from taught cues.
 *
 * Operators are pure functions of the observer's state (via OperatorContext)
 * and always HONEST: if the memory cannot fill a slot, the operator returns
 * null and the caller falls through to creative mode or a decline — never a
 * fabricated answer. This is the step from "memorized exchange" to "answer
 * novel questions from memory".
 */

import { isContentWord, tokenizeText } from './context';
import { isATypeOf, inheritsPart, inheritsEdge, edgeObjects } from './chain';
import { chainPhrase, composeClaim } from './composition';
import type { TokenCostModel } from './mdl';
import { matchLocationClause, type Relation, type RelationPredicate } from './relations';

export type OperatorResult =
  | { kind: 'definition'; word: string; answer: string }
  | { kind: 'semantic-recall'; word: string; answer: string; score: number }
  | { kind: 'yesno'; word: string; known: boolean; answer: string }
  | { kind: 'count'; what: string; count: number; answer: string }
  | { kind: 'echo'; word: string; answer: string }
  | { kind: 'clock'; what: 'time' | 'date'; answer: string }
  | { kind: 'capability'; skill: string; known: boolean; answer: string }
  | { kind: 'property'; property: string; object: string; value: string; answer: string }
  | { kind: 'where'; object: string; place: string; answer: string; score?: number }
  | { kind: 'learned'; patternId: string; slot: string; answer: string }
  | { kind: 'introspection'; subject: string; answer: string }
  | { kind: 'is-a'; subject: string; target: string; answer: string; score?: number }
  | { kind: 'has-part'; subject: string; part: string; via: string | null; answer: string; score?: number }
  | { kind: 'made-of'; subject: string; material: string; answer: string; score?: number }
  | { kind: 'has-property'; subject: string; property: string; via: string | null; answer: string; score?: number }
  | { kind: 'capable-of'; subject: string; action: string; via: string | null; answer: string; score?: number }
  | { kind: 'used-for'; subject: string; purpose: string; answer: string; score?: number }
  | { kind: 'causes'; subject: string; effect: string; answer: string; score?: number }
  | { kind: 'opposite-of'; subject: string; opposite: string; answer: string; score?: number }
  | { kind: 'requires'; subject: string; requirement: string; via: string | null; answer: string; score?: number }
  | { kind: 'composed'; subject: string; predicate: RelationPredicate; object: string; hops: Array<{ subject: string; predicate: RelationPredicate; object: string }>; support: number; answer: string }
  | { kind: 'compiled-rule'; concept: string; drill: string; answer: string }
  | { kind: 'self-knowledge'; word: string; answer: string }
  | null;

export interface OperatorContext {
  /** Whether the observer has been taught (has a trace for) this word. */
  isTaught(word: string): boolean;
  /** The taught definition of a deck word ('' when none). */
  definitionOf(word: string): string;
  /** Number of words the observer knows. */
  wordCount(): number;
  /** Number of conversation phrases the observer knows. */
  phraseCount(): number;
  // ── Introspection (optional — the observer's reportable self) ──────────
  /** How many times a content word has been heard in conversation. */
  exposureOf?(word: string): number;
  /** Trace strength of a taught word (null when not taught). */
  recallStrengthOf?(word: string): number | null;
  /** Words whose traces have consolidated. */
  consolidatedWords?(limit?: number): string[];
  /** Unanswered gaps, most-missed first. */
  gapList?(): string[];
  // ── Relational (chaining over typed edges) ───────────────────────────────
  /** Typed edges decomposed from the deck definitions. */
  relations?(): readonly Relation[];
  /** The confidence weight of one edge (P8): < 1 answers hedged. */
  edgeStrength?(subject: string, predicate: string, object: string): number;
  /** The confirmed-false entry for a claim (P8), or null — the only "No". */
  negationOf?(subject: string, predicate: string, object: string): { evidence: string } | null;
  /** The MDL frequency prior for composition gating (P10). When omitted,
   *  the composed fallback derives one from the relation graph. */
  compositionCost?: TokenCostModel;
  // ── Distributed-vector recall (P1 — graded fallback beneath the graph)
  /** The unbind+cleanup score of one object under (subject, predicate). */
  relationalScore?(subject: string, predicate: string, object: string): number;
  /** The top scored candidates under (subject, predicate), for open forms. */
  relationalRecall?(subject: string, predicate: string, topK?: number): Array<{ object: string; score: number }>;
  // ── Self-knowledge (belief traces — the observer's own states as memory)
  /** The stored belief about a subject (null when none has been committed). */
  beliefAbout?(word: string): { content: string; contradicts: boolean } | null;
  // ── Deliberation (goal traces — the observer's plans as content)
  /** Ranked active goals with their reasons (internal deliberation view). */
  activeGoals?(): Array<{ target: string; reason: string }>;
  /** How the observer's goals have fared (completed vs stalled). */
  goalHistory?(): Record<string, { completed: number; abandoned: number }>;
}

const LEAD_DEFINITION = /^(?:what'?s|what is|what are|what about)\s+/i;
const LEAD_YESNO = /^(?:do you know|do you remember|have you learned|do you have|have i taught you|have we learned)\s+/i;
/** FIRST-PERSON SELF-KNOWLEDGE: "do I know X" answers from a stored BELIEF
 *  trace — the observer's own state as an ordinary memory, not a computed
 *  taught-check. No belief, no answer: the observer does not claim
 *  self-knowledge it has not stored. */
const LEAD_SELF_KNOWN = /^do\s+(?:i|we)\s+(?:know|remember|recall)\s+(.+)$/i;
const LEAD_NEGATION = /^(?:do you not know|dont you know|do you not remember|dont you remember|do you not have)\s+/i;
const LEAD_PREFERENCE = /^(?:do you like|do you enjoy|do you love|do you hate)\s+(.+)$/i;
const LEAD_CURIOSITY = /^what are you curious about\??$/;
const LEAD_KNOWLEDGE = /^what do you know well\??$/;
const LEAD_KNOW_ABOUT = /^(?:how much do you know about|do you know about|have you heard of)\s+(.+)$/i;
const LEAD_IS_A = /^is\s+(?:(?:the|a|an)\s+)?([a-z]+(?:\s+[a-z]+)*?)\s+(?:a|an)\s+([a-z]+(?:\s+[a-z]+)*)$/i;
const LEAD_HAS_PART = /^does\s+(?:(?:the|a|an)\s+)?([a-z]+(?:\s+[a-z]+)*?)\s+have\s+(?:(?:the|a|an)\s+)?([a-z]+(?:\s+[a-z]+)*)$/i;
const LEAD_MADE_OF = /^is\s+(?:(?:the|a|an)\s+)?([a-z]+(?:\s+[a-z]+)*)\s+made\s+of\s+([a-z]+(?:\s+[a-z]+)*)$/i;
// The expanded relational forms (P4): each maps to a typed edge the graph
// may hold. `article` is captured so answers keep the question's phrasing
// ("can a bird fly" -> "Yes, a bird can fly.").
const LEAD_USED_FOR = /^is\s+((?:(?:the|a|an)\s+)?)([a-z]+)\s+used\s+for\s+([a-z]+)\??$/i;
const LEAD_WHAT_FOR = /^what\s+is\s+((?:(?:the|a|an)\s+)?)([a-z]+)\s+(?:used\s+)?for\??$/i;
const LEAD_CAUSES = /^what\s+does\s+((?:(?:the|a|an)\s+)?)([a-z]+)\s+cause\??$/i;
const LEAD_DOES_CAUSE = /^does\s+((?:(?:the|a|an)\s+)?)([a-z]+)\s+cause\s+([a-z]+)\??$/i;
const LEAD_REQUIRES = /^what\s+does\s+((?:(?:the|a|an)\s+)?)([a-z]+)\s+(?:need|require)\??$/i;
const LEAD_DOES_REQUIRE = /^does\s+((?:(?:the|a|an)\s+)?)([a-z]+)\s+(?:need|require)\s+([a-z]+)\??$/i;
const LEAD_CAPABLE = /^can\s+((?:(?:the|a|an)\s+)?)([a-z]+)\s+([a-z]+)\??$/i;
const LEAD_PROPERTY = /^is\s+((?:(?:the|a|an)\s+)?)([a-z]+)\s+([a-z]+)\??$/i;
const LEAD_WHAT_DO = /^what\s+does\s+((?:(?:the|a|an)\s+)?)([a-z]+)\s+do\??$/i;
const LEAD_WHAT_LIKE = /^what\s+is\s+((?:(?:the|a|an)\s+)?)([a-z]+)\s+like\??$/i;
const LEAD_OPPOSITE = /^what\s+is\s+the\s+opposite\s+of\s+(.+)$/i;
// P8 NEGATION STATEMENTS — declarative falsehoods the user teaches.
const LEAD_IS_NOT_A = /^([a-z]+(?:\s+[a-z]+)*)\s+is\s+not\s+(?:a|an)\s+([a-z]+(?:\s+[a-z]+)*)$/i;
const LEAD_DOES_NOT_HAVE = /^([a-z]+(?:\s+[a-z]+)*)\s+does\s+not\s+have\s+(?:(?:a|an|the)\s+)?([a-z]+(?:\s+[a-z]+)*)$/i;
const LEAD_IS_NOT_MADE_OF = /^([a-z]+(?:\s+[a-z]+)*)\s+is\s+not\s+made\s+of\s+([a-z]+(?:\s+[a-z]+)*)$/i;

/**
 * Parse a declarative negative statement ("golf is not a bird", "a bird does
 * not have wheels") into the confirmed-false claim it teaches (P8). Null for
 * anything else — only explicit falsehoods become negations.
 */
export function parseNegationStatement(text: string): { subject: string; predicate: 'is-a' | 'has-part' | 'made-of'; object: string } | null {
  const cleaned = clean(text);
  const isNotA = cleaned.match(LEAD_IS_NOT_A);
  if (isNotA !== null) return { subject: isNotA[1], predicate: 'is-a', object: isNotA[2] };
  const doesNotHave = cleaned.match(LEAD_DOES_NOT_HAVE);
  if (doesNotHave !== null) return { subject: doesNotHave[1], predicate: 'has-part', object: doesNotHave[2] };
  const isNotMadeOf = cleaned.match(LEAD_IS_NOT_MADE_OF);
  if (isNotMadeOf !== null) return { subject: isNotMadeOf[1], predicate: 'made-of', object: isNotMadeOf[2] };
  return null;
}
const LEAD_COUNT = /^how many\s+(words|phrases|things)\s+(?:do you know|have you learned|do you remember|do you have)\s*/i;
const LEAD_ECHO = /^(?:can you say|say|how do you say)\s+/i;
const LEAD_CLOCK = /^(?:what time is it|what is the time|whats the time|what time do you have)\??$/;
/** The deterministic clock-answer format (shared with the bench and tests). */
export const CLOCK_ANSWER_RE = /\d{1,2}:\d{2} (AM|PM)\./;
const LEAD_DATE = /^(?:what day is it|what is todays date|what date is it|what day is today|what is the date|whats the date)\??$/;
const LEAD_CAPABILITY = /^(?:can you|are you able to)\s+(.+)$/i;
const LEAD_ATTRIBUTE = /^(?:what|whats)\s+(color|size|shape)\s+(?:is|are)\s+(?:the\s+|a\s+|an\s+)?(.+)$/i;
const LEAD_WHERE = /^where\s+(?:is|are)\s+(?:the\s+|a\s+|an\s+)?(.+)$/i;

export const COLOR_WORDS = ['red', 'yellow', 'green', 'blue', 'white', 'black', 'orange', 'purple', 'pink', 'brown', 'gray', 'grey', 'golden', 'silver'];
const SIZE_WORDS = ['large', 'small', 'big', 'little', 'huge', 'tiny', 'enormous', 'short', 'long', 'tall', 'wide', 'narrow'];
const SHAPE_WORDS = ['round', 'square', 'circular', 'oval', 'flat', 'curved', 'straight'];

const KNOWN_CAPABILITIES = ['count', 'read', 'write', 'learn', 'remember', 'listen', 'speak english', 'speak', 'answer questions', 'teach'];

function clean(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?!.]+$/g, '')
    .trim();
}

/** Strip leading articles/possessives so "what is the water" -> "water". */
function stripArticles(word: string): string {
  return word
    .replace(/^(?:the|a|an|my|your|our|their|his|her|of|about)\s+/i, '')
    .replace(/^'s$/g, '')
    .trim();
}

function singleWord(rest: string): string | null {
  const word = stripArticles(rest.trim());
  return /^[a-z]+$/.test(word) ? word : null;
}

function wordPhrase(rest: string): string | null {
  const phrase = stripArticles(rest.trim());
  return /^[a-z]+(?:\s+[a-z]+)*$/.test(phrase) ? phrase : null;
}

/** "a" / "a and b" / "a, b and c" — the open-relation answer list. */
function listPhrase(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')}, and ${words[words.length - 1]}`;
}

// ── P1 HOLOGRAPHIC FALLBACK ────────────────────────────────────────────────
// The symbolic graph is binary (edge present/absent). Where it is silent,
// the distributed-vector view scores the question: unbind + cleanup returns a
// cosine that gates a hedged answer instead of a hard ASK. Thresholds were
// measured against the real relation graph: a 2-6 edge subject scores its
// true filler ≈ 0.4-0.6 while unrelated objects sit < 0.2.
const HOLO_YES_STRONG = 0.5; // "I believe so — ..."
const HOLO_YES_WEAK = 0.32; // "Probably — ..." (below: silent -> ASK)
const HOLO_OPEN_FLOOR = 0.3; // open-form candidates above noise
const HOLO_PARENT_MIN = 0.3; // a parent must itself be a real recovery

/**
 * The graded closed-form fallback: score (subject, predicate, object) directly,
 * then through the subject's is-a parents (a scored sibling of inheritsPart).
 * Returns null when both are below the weak threshold — the observer falls
 * through to ASK rather than claim a low-score guess as fact.
 */
function holographicClosed(
  ctx: OperatorContext,
  subject: string,
  predicate: string,
  object: string
): { score: number; via: string | null } | null {
  if (ctx.relationalScore === undefined) return null;
  const direct = ctx.relationalScore(subject, predicate, object);
  if (direct >= HOLO_YES_WEAK) return { score: direct, via: null };
  if (ctx.relationalRecall !== undefined) {
    for (const parent of ctx.relationalRecall(subject, 'is-a', 3)) {
      if (parent.score < HOLO_PARENT_MIN) continue;
      const via = ctx.relationalScore(parent.object, predicate, object);
      if (via >= HOLO_YES_WEAK) return { score: via, via: parent.object };
    }
  }
  return null;
}

/** The hedge word for a graded answer: strong -> "I believe so", weak -> "Probably". */
function hedgePhrase(score: number): string {
  return score >= HOLO_YES_STRONG ? 'I believe so' : 'Probably';
}

/** The open-form hedge: "I believe {subject} can ..." vs "I think ...". */
function openHedge(topScore: number): string {
  return topScore >= HOLO_YES_STRONG ? 'I believe' : 'I think';
}

// ── P8 CONFIRMED-FALSE + EDGE CONFIDENCE ────────────────────────────────────
// A taught "X is not a Y" is EVIDENCE, and it outranks extraction: a negation
// for a claim answers "No, ... — I was taught that." before any positive
// path. A weakened edge (< 1, from wrong grades) still answers, but hedged —
// "Probably" instead of "Yes".

/** "Yes" when the edge is strong, "Probably" when grades weakened it. */
function yesPrefix(strength: number): string {
  return strength >= 1 ? 'Yes' : 'Probably';
}

/**
 * P8 open-form hedge: an open answer ("what does X cause") asserts a LIST of
 * objects from direct edges. When the STRONGEST cited edge is weakened
 * (< 1, by wrong grades), the assertion must not stand as flat fact — the
 * same contract the closed forms honor via `yesPrefix`. Empty prefix when
 * every cited edge is at full confidence.
 */
function openEdgeHedge(
  ctx: OperatorContext,
  subject: string,
  predicate: string,
  objects: readonly string[]
): string {
  let strongest = 1;
  for (const object of objects) {
    const strength = ctx.edgeStrength?.(subject, predicate, object) ?? 1;
    if (strength < strongest) strongest = strength;
  }
  return strongest >= 1 ? '' : 'Probably — ';
}

/** The evidence-backed "No" answer for a confirmed-false claim, or null. */
function negationAnswer(
  ctx: OperatorContext,
  subject: string,
  predicate: string,
  object: string,
  negatedPhrase: string
): string | null {
  const negation = ctx.negationOf?.(subject, predicate, object);
  if (negation === undefined || negation === null) return null;
  return `No, ${negatedPhrase} — I was taught that.`;
}

/** The graded direct-only fallback (no inheritance) — made-of, causes, is-a. */
function holographicDirect(
  ctx: OperatorContext,
  subject: string,
  predicate: string,
  object: string
): number | null {
  if (ctx.relationalScore === undefined) return null;
  const score = ctx.relationalScore(subject, predicate, object);
  return score >= HOLO_YES_WEAK ? score : null;
}

/** The graded open-form fallback: top candidates above the noise floor.
 *  Confirmed-false objects are vetoed — a negation outranks a cosine. */
function holographicOpen(
  ctx: OperatorContext,
  subject: string,
  predicate: string
): { objects: string[]; topScore: number } | null {
  if (ctx.relationalRecall === undefined) return null;
  const candidates = ctx.relationalRecall(subject, predicate, 3).filter(
    (c) => c.score >= HOLO_OPEN_FLOOR && (ctx.negationOf?.(subject, predicate, c.object) ?? null) === null
  );
  if (candidates.length === 0) return null;
  return {
    objects: candidates.map((c) => c.object),
    topScore: candidates[0].score
  };
}

/** Whether the utterance is a clock or date question ("what time is it"). */
export function isClockOrDateQuestion(text: string): boolean {
  const cleaned = clean(text);
  return LEAD_CLOCK.test(cleaned) || LEAD_DATE.test(cleaned);
}

/**
 * The deterministic clock/date answer for a matching question. Truth beats
 * any memorized content — a taught "I do not know the time yet." is stale
 * once the observer can tell time. Returns null when the question is not a
 * clock/date question.
 */
export function clockAnswer(text: string): { kind: 'clock'; what: 'time' | 'date'; answer: string } | null {
  const cleaned = clean(text);
  if (LEAD_CLOCK.test(cleaned)) {
    const now = new Date();
    let hours = now.getHours();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return { kind: 'clock', what: 'time', answer: `It is ${hours}:${minutes} ${ampm}.` };
  }
  if (LEAD_DATE.test(cleaned)) {
    const now = new Date();
    const day = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    return { kind: 'clock', what: 'date', answer: `Today is ${day}.` };
  }
  return null;
}

/**
 * The question forms that demand GROUNDED knowledge: definition ("what is
 * X") and relational ("is X a Y", "does X have Y", "is X made of Y"). The
 * creative layer is allowed to compose freely about known material, but it
 * must never answer one of these forms when the utterance contains a word
 * the observer has never heard — the ask path owns those.
 */
export interface QuestionForm {
  kind:
    | 'definition'
    | 'is-a'
    | 'has-part'
    | 'made-of'
    | 'has-property'
    | 'capable-of'
    | 'used-for'
    | 'causes'
    | 'opposite-of'
    | 'requires'
    // H4: the open factual forms — the evasion gate must recognize them too.
    | 'causes-open'
    | 'requires-open'
    | 'what-do'
    | 'what-like'
    | 'what-for'
    | 'where';
  subject: string;
  /** The relation object for relational forms ("is X a Y" -> Y). */
  object?: string;
}

export function questionFormOf(text: string): QuestionForm | null {
  const cleaned = clean(text);
  const definition = cleaned.match(LEAD_DEFINITION);
  if (definition !== null) {
    const word = wordPhrase(cleaned.slice(definition[0].length));
    if (word !== null) return { kind: 'definition', subject: word };
  }
  const isA = cleaned.match(LEAD_IS_A);
  if (isA !== null) return { kind: 'is-a', subject: isA[1], object: isA[2] };
  const hasPart = cleaned.match(LEAD_HAS_PART);
  if (hasPart !== null) return { kind: 'has-part', subject: hasPart[1], object: hasPart[2] };
  const madeOf = cleaned.match(LEAD_MADE_OF);
  if (madeOf !== null) return { kind: 'made-of', subject: madeOf[1], object: madeOf[2] };
  const usedFor = cleaned.match(LEAD_USED_FOR);
  if (usedFor !== null) return { kind: 'used-for', subject: usedFor[2], object: usedFor[3] };
  const doesCause = cleaned.match(LEAD_DOES_CAUSE);
  if (doesCause !== null) return { kind: 'causes', subject: doesCause[2], object: doesCause[3] };
  const doesRequire = cleaned.match(LEAD_DOES_REQUIRE);
  if (doesRequire !== null) return { kind: 'requires', subject: doesRequire[2], object: doesRequire[3] };
  const capable = cleaned.match(LEAD_CAPABLE);
  if (capable !== null) return { kind: 'capable-of', subject: capable[2], object: capable[3] };
  const property = cleaned.match(LEAD_PROPERTY);
  if (property !== null) return { kind: 'has-property', subject: property[2], object: property[3] };
  const opposite = cleaned.match(LEAD_OPPOSITE);
  if (opposite !== null) {
    const word = singleWord(opposite[1]);
    if (word !== null) return { kind: 'opposite-of', subject: word };
  }
  // OPEN forms (H4): "what does X cause/need", "what does X do", "what is X
  // like/for", "where is X" are factual forms exactly like their closed
  // siblings ("does X cause Y") — the evasion gate must treat them the same,
  // or creative composition answers "what does water cause" with a confident
  // sentence despite zero knowledge. Operators answer them at step 2 when an
  // edge exists; un-answered, they must route to ASK, never to composition.
  const causesOpen = cleaned.match(LEAD_CAUSES);
  if (causesOpen !== null) return { kind: 'causes-open', subject: causesOpen[2] };
  const requiresOpen = cleaned.match(LEAD_REQUIRES);
  if (requiresOpen !== null) return { kind: 'requires-open', subject: requiresOpen[2] };
  const whatDo = cleaned.match(LEAD_WHAT_DO);
  if (whatDo !== null) return { kind: 'what-do', subject: whatDo[2] };
  const whatLike = cleaned.match(LEAD_WHAT_LIKE);
  if (whatLike !== null) return { kind: 'what-like', subject: whatLike[2] };
  const whatFor = cleaned.match(LEAD_WHAT_FOR);
  if (whatFor !== null) return { kind: 'what-for', subject: whatFor[2] };
  const where = cleaned.match(LEAD_WHERE);
  if (where !== null) return { kind: 'where', subject: singleWord(where[1]) ?? where[1].trim() };
  return null;
}

/**
 * Try every operator against the utterance. Returns the first match or null
 * (no operator claims the question — the caller decides next).
 */
export function applyOperator(utterance: string, ctx: OperatorContext): OperatorResult {
  const text = clean(utterance);
  if (text.length === 0) return null;

  // The confirmed-false store as a walk veto (P8 exception propagation).
  const denied = (s: string, p: string, o: string): boolean => (ctx.negationOf?.(s, p, o) ?? null) !== null;

  // Clock and date are deterministic and must beat any taught definition of
  // "time"/"day" — the answer changes with the moment.
  const clock = clockAnswer(text);
  if (clock !== null) return clock;

  // INTROSPECTION: preference questions answer from exposure and recall
  // strength — never a fabricated preference. "do you like tea" with zero
  // exposure is honestly "I have not learned about tea yet."
  const preferenceLead = text.match(LEAD_PREFERENCE);
  if (preferenceLead) {
    const word = singleWord(preferenceLead[1]);
    if (word !== null) {
      const exposure = ctx.exposureOf?.(word) ?? 0;
      const strength = ctx.recallStrengthOf?.(word) ?? null;
      let answer: string;
      if (exposure === 0 && strength === null) {
        answer = `I have not learned about ${word} yet.`;
      } else if (strength !== null && strength >= 0.6) {
        answer = `I have heard about ${word} and I know it well.`;
      } else if (exposure === 1) {
        answer = `I have heard about ${word} once, but I do not know it well yet.`;
      } else {
        answer = `I have heard about ${word} ${exposure} times, but I do not know it well yet.`;
      }
      return { kind: 'introspection', subject: word, answer };
    }
  }

  // "what are you curious about" reads the gap list directly.
  if (LEAD_CURIOSITY.test(text)) {
    const gaps = ctx.gapList?.() ?? [];
    const answer = gaps.length > 0
      ? `I am curious about: ${gaps.slice(0, 3).join('; ')}.`
      : 'I am not curious about anything right now.';
    return { kind: 'introspection', subject: 'curiosity', answer };
  }

  // "what do you know well" reads consolidation.
  if (LEAD_KNOWLEDGE.test(text)) {
    const words = ctx.consolidatedWords?.(5) ?? [];
    const answer = words.length > 0
      ? `I know these words well: ${words.join(', ')}.`
      : 'I do not know any words well yet.';
    return { kind: 'introspection', subject: 'knowledge', answer };
  }

  // DELIBERATION — the observer reports its own plans as evaluated content:
  // "what are you trying to do" reads the active goal traces with reasons.
  if (/^what are you (?:trying to do|doing|working on)\b/i.test(text)) {
    const goals = ctx.activeGoals?.() ?? [];
    if (goals.length >= 0 && goals.length > 0) {
      const top = goals[0];
      return { kind: 'introspection', subject: 'plans', answer: `I am trying to ${top.target}, because ${top.reason}.` };
    }
    return { kind: 'introspection', subject: 'plans', answer: 'I have no active goals right now.' };
  }

  // "did you achieve your goals" reads the completed vs stalled history.
  if (/^(?:did you achieve|have you achieved|are you achieving) your goals\b/i.test(text)) {
    const history = ctx.goalHistory?.() ?? {};
    const types = Object.keys(history);
    if (types.length === 0) {
      return { kind: 'introspection', subject: 'goals', answer: 'I have not formed goals yet.' };
    }
    const parts = types.map((type) => `${type} ${history[type].completed}/${history[type].completed + history[type].abandoned}`);
    return { kind: 'introspection', subject: 'goals', answer: `My goals so far: ${parts.join(', ')}.` };
  }

  // "how much do you know about X" combines exposure and recall strength.
  const knowAboutLead = text.match(LEAD_KNOW_ABOUT);
  if (knowAboutLead) {
    const word = singleWord(knowAboutLead[1]);
    if (word !== null) {
      const exposure = ctx.exposureOf?.(word) ?? 0;
      const strength = ctx.recallStrengthOf?.(word) ?? null;
      let answer: string;
      if (exposure === 0 && strength === null) {
        answer = `I have not learned about ${word} yet.`;
      } else if (strength !== null && strength >= 0.6) {
        answer = `I have heard about ${word} ${Math.max(1, exposure)} time${Math.max(1, exposure) === 1 ? '' : 's'} and I recall it well.`;
      } else {
        answer = `I have heard about ${word} ${Math.max(1, exposure)} time${Math.max(1, exposure) === 1 ? '' : 's'}, but I do not recall it well yet.`;
      }
      return { kind: 'introspection', subject: word, answer };
    }
  }

  // RELATIONAL CHAINING: "is a robin a bird" and "does a robin have wings"
  // walk typed edges — transitivity and inheritance over memory, grounded
  // entirely in stored relations. No path -> null -> the observer honestly
  // declines (absence of evidence is never answered as absence).
  const isALead = text.match(LEAD_IS_A);
  if (isALead && ctx.relations !== undefined) {
    const relations = ctx.relations();
    // P8: a taught falsehood outranks extraction — "No" with evidence.
    const negated = negationAnswer(
      ctx, isALead[1], 'is-a', isALead[2],
      `${isALead[1]} is not ${/^[aeiou]/.test(isALead[2]) ? 'an' : 'a'} ${isALead[2]}`
    );
    if (negated !== null) {
      return {
        kind: 'is-a',
        subject: isALead[1],
        target: isALead[2],
        answer: negated
      };
    }
    if (relations.length > 0 && isATypeOf(relations, isALead[1], isALead[2], denied)) {
      // P8: a weakened edge (wrong grades) answers hedged, never "Yes".
      const strength = ctx.edgeStrength?.(isALead[1], 'is-a', isALead[2]) ?? 1;
      return {
        kind: 'is-a',
        subject: isALead[1],
        target: isALead[2],
        answer: `${yesPrefix(strength)}, ${isALead[1]} is ${/^[aeiou]/.test(isALead[2]) ? 'an' : 'a'} ${isALead[2]}.`
      };
    }
    // P1 graded fallback when the symbolic graph is silent.
    const score = holographicDirect(ctx, isALead[1], 'is-a', isALead[2]);
    if (score !== null) {
      return {
        kind: 'is-a',
        subject: isALead[1],
        target: isALead[2],
        score,
        answer: `${hedgePhrase(score)} — ${isALead[1]} is ${/^[aeiou]/.test(isALead[2]) ? 'an' : 'a'} ${isALead[2]}.`
      };
    }
  }
  const hasPartLead = text.match(LEAD_HAS_PART);
  if (hasPartLead && ctx.relations !== undefined) {
    const relations = ctx.relations();
    const negated = negationAnswer(ctx, hasPartLead[1], 'has-part', hasPartLead[2], `${hasPartLead[1]} does not have ${hasPartLead[2]}`);
    if (negated !== null) {
      return {
        kind: 'has-part',
        subject: hasPartLead[1],
        part: hasPartLead[2],
        via: null,
        answer: negated
      };
    }
    if (relations.length > 0) {
      const direct = relations.some((r) => r.subject === hasPartLead[1] && r.predicate === 'has-part' && r.object === hasPartLead[2]);
      const via = direct ? null : inheritsPart(relations, hasPartLead[1], hasPartLead[2], denied);
      if (direct || via !== null) {
        const strength = ctx.edgeStrength?.(via?.via ?? hasPartLead[1], 'has-part', hasPartLead[2]) ?? 1;
        return {
          kind: 'has-part',
          subject: hasPartLead[1],
          part: hasPartLead[2],
          via: via?.via ?? null,
          answer: via !== null
            ? `Yes — ${hasPartLead[1]} is ${/^[aeiou]/.test(via.via) ? 'an' : 'a'} ${via.via}, and ${via.via} has ${hasPartLead[2]}.`
            : `${yesPrefix(strength)}, ${hasPartLead[1]} has ${hasPartLead[2]}.`
        };
      }
    }
    const graded = holographicClosed(ctx, hasPartLead[1], 'has-part', hasPartLead[2]);
    if (graded !== null) {
      return {
        kind: 'has-part',
        subject: hasPartLead[1],
        part: hasPartLead[2],
        via: graded.via,
        score: graded.score,
        answer: graded.via !== null
          ? `${hedgePhrase(graded.score)} — ${hasPartLead[1]} is ${/^[aeiou]/.test(graded.via) ? 'an' : 'a'} ${graded.via}, and ${graded.via} has ${hasPartLead[2]}.`
          : `${hedgePhrase(graded.score)} — ${hasPartLead[1]} has ${hasPartLead[2]}.`
      };
    }
  }
  const madeOfLead = text.match(LEAD_MADE_OF);
  if (madeOfLead && ctx.relations !== undefined) {
    const relations = ctx.relations();
    const negated = negationAnswer(ctx, madeOfLead[1], 'made-of', madeOfLead[2], `${madeOfLead[1]} is not made of ${madeOfLead[2]}`);
    if (negated !== null) {
      return {
        kind: 'made-of',
        subject: madeOfLead[1],
        material: madeOfLead[2],
        answer: negated
      };
    }
    if (
      relations.length > 0 &&
      relations.some((r) => r.subject === madeOfLead[1] && r.predicate === 'made-of' && r.object === madeOfLead[2])
    ) {
      const strength = ctx.edgeStrength?.(madeOfLead[1], 'made-of', madeOfLead[2]) ?? 1;
      return {
        kind: 'made-of',
        subject: madeOfLead[1],
        material: madeOfLead[2],
        answer: `${yesPrefix(strength)}, ${madeOfLead[1]} is made of ${madeOfLead[2]}.`
      };
    }
    const score = holographicDirect(ctx, madeOfLead[1], 'made-of', madeOfLead[2]);
    if (score !== null) {
      return {
        kind: 'made-of',
        subject: madeOfLead[1],
        material: madeOfLead[2],
        score,
        answer: `${hedgePhrase(score)} — ${madeOfLead[1]} is made of ${madeOfLead[2]}.`
      };
    }
  }

  // EXPANDED RELATIONAL FORMS (P4) — each answers from a typed edge the graph
  // may hold (regex-extracted, authored, or chaperone-supplied), with the
  // same honesty invariant: no edge -> null -> the observer falls through.
  // The generic inheritsEdge walk lets has-property / capable-of / used-for /
  // requires inherit through is-a like has-part already does.
  const usedForLead = text.match(LEAD_USED_FOR);
  if (usedForLead && ctx.relations !== undefined) {
    const relations = ctx.relations();
    const negated = negationAnswer(ctx, usedForLead[2], 'used-for', usedForLead[3], `${usedForLead[2]} is not used for ${usedForLead[3]}`);
    if (negated !== null) {
      return {
        kind: 'used-for',
        subject: usedForLead[2],
        purpose: usedForLead[3],
        answer: negated
      };
    }
    const direct = relations.some(
      (r) => r.subject === usedForLead[2] && r.predicate === 'used-for' && r.object === usedForLead[3]
    );
    const via = direct ? null : inheritsEdge(relations, usedForLead[2], 'used-for', usedForLead[3], denied);
    if (direct || via !== null) {
      const strength = ctx.edgeStrength?.(via?.via ?? usedForLead[2], 'used-for', usedForLead[3]) ?? 1;
      return {
        kind: 'used-for',
        subject: usedForLead[2],
        purpose: usedForLead[3],
        answer: `${yesPrefix(strength)}, ${usedForLead[1]}${usedForLead[2]} is used for ${usedForLead[3]}.`
      };
    }
    const graded = holographicClosed(ctx, usedForLead[2], 'used-for', usedForLead[3]);
    if (graded !== null) {
      return {
        kind: 'used-for',
        subject: usedForLead[2],
        purpose: usedForLead[3],
        score: graded.score,
        answer: `${hedgePhrase(graded.score)} — ${usedForLead[1]}${usedForLead[2]} is used for ${usedForLead[3]}.`
      };
    }
  }
  const causesLead = text.match(LEAD_CAUSES);
  if (causesLead && ctx.relations !== undefined) {
    const relations = ctx.relations();
    const effects = edgeObjects(relations, causesLead[2], 'causes', denied);
    if (effects.length > 0) {
      return {
        kind: 'causes',
        subject: causesLead[2],
        effect: effects[0],
        answer: `${openEdgeHedge(ctx, causesLead[2], 'causes', effects)}${causesLead[1]}${causesLead[2]} causes ${listPhrase(effects)}.`
      };
    }
    const recalled = holographicOpen(ctx, causesLead[2], 'causes');
    if (recalled !== null) {
      return {
        kind: 'causes',
        subject: causesLead[2],
        effect: recalled.objects[0],
        score: recalled.topScore,
        answer: `${openHedge(recalled.topScore)} ${causesLead[1]}${causesLead[2]} causes ${listPhrase(recalled.objects)}.`
      };
    }
  }
  const doesCauseLead = text.match(LEAD_DOES_CAUSE);
  if (doesCauseLead && ctx.relations !== undefined) {
    const relations = ctx.relations();
    const negated = negationAnswer(ctx, doesCauseLead[2], 'causes', doesCauseLead[3], `${doesCauseLead[2]} does not cause ${doesCauseLead[3]}`);
    if (negated !== null) {
      return {
        kind: 'causes',
        subject: doesCauseLead[2],
        effect: doesCauseLead[3],
        answer: negated
      };
    }
    if (
      relations.length > 0 &&
      relations.some((r) => r.subject === doesCauseLead[2] && r.predicate === 'causes' && r.object === doesCauseLead[3])
    ) {
      const strength = ctx.edgeStrength?.(doesCauseLead[2], 'causes', doesCauseLead[3]) ?? 1;
      return {
        kind: 'causes',
        subject: doesCauseLead[2],
        effect: doesCauseLead[3],
        answer: `${yesPrefix(strength)}, ${doesCauseLead[1]}${doesCauseLead[2]} causes ${doesCauseLead[3]}.`
      };
    }
    const score = holographicDirect(ctx, doesCauseLead[2], 'causes', doesCauseLead[3]);
    if (score !== null) {
      return {
        kind: 'causes',
        subject: doesCauseLead[2],
        effect: doesCauseLead[3],
        score,
        answer: `${hedgePhrase(score)} — ${doesCauseLead[1]}${doesCauseLead[2]} causes ${doesCauseLead[3]}.`
      };
    }
  }
  const requiresLead = text.match(LEAD_REQUIRES);
  if (requiresLead && ctx.relations !== undefined) {
    const relations = ctx.relations();
    const requirements = edgeObjects(relations, requiresLead[2], 'requires', denied);
    if (requirements.length > 0) {
      return {
        kind: 'requires',
        subject: requiresLead[2],
        requirement: requirements[0],
        via: null,
        answer: `${openEdgeHedge(ctx, requiresLead[2], 'requires', requirements)}${requiresLead[1]}${requiresLead[2]} requires ${listPhrase(requirements)}.`
      };
    }
    const recalled = holographicOpen(ctx, requiresLead[2], 'requires');
    if (recalled !== null) {
      return {
        kind: 'requires',
        subject: requiresLead[2],
        requirement: recalled.objects[0],
        via: null,
        score: recalled.topScore,
        answer: `${openHedge(recalled.topScore)} ${requiresLead[1]}${requiresLead[2]} requires ${listPhrase(recalled.objects)}.`
      };
    }
  }
  const doesRequireLead = text.match(LEAD_DOES_REQUIRE);
  if (doesRequireLead && ctx.relations !== undefined) {
    const relations = ctx.relations();
    const negated = negationAnswer(ctx, doesRequireLead[2], 'requires', doesRequireLead[3], `${doesRequireLead[2]} does not require ${doesRequireLead[3]}`);
    if (negated !== null) {
      return {
        kind: 'requires',
        subject: doesRequireLead[2],
        requirement: doesRequireLead[3],
        via: null,
        answer: negated
      };
    }
    const direct = relations.some(
      (r) => r.subject === doesRequireLead[2] && r.predicate === 'requires' && r.object === doesRequireLead[3]
    );
    const via = direct ? null : inheritsEdge(relations, doesRequireLead[2], 'requires', doesRequireLead[3], denied);
    if (direct || via !== null) {
      const strength = ctx.edgeStrength?.(via?.via ?? doesRequireLead[2], 'requires', doesRequireLead[3]) ?? 1;
      return {
        kind: 'requires',
        subject: doesRequireLead[2],
        requirement: doesRequireLead[3],
        via: via?.via ?? null,
        answer: via !== null
          ? `Yes — ${doesRequireLead[1]}${doesRequireLead[2]} is ${/^[aeiou]/.test(via.via) ? 'an' : 'a'} ${via.via}, and ${via.via} requires ${doesRequireLead[3]}.`
          : `${yesPrefix(strength)}, ${doesRequireLead[1]}${doesRequireLead[2]} requires ${doesRequireLead[3]}.`
      };
    }
    const graded = holographicClosed(ctx, doesRequireLead[2], 'requires', doesRequireLead[3]);
    if (graded !== null) {
      return {
        kind: 'requires',
        subject: doesRequireLead[2],
        requirement: doesRequireLead[3],
        via: graded.via,
        score: graded.score,
        answer: graded.via !== null
          ? `${hedgePhrase(graded.score)} — ${doesRequireLead[1]}${doesRequireLead[2]} is ${/^[aeiou]/.test(graded.via) ? 'an' : 'a'} ${graded.via}, and ${graded.via} requires ${doesRequireLead[3]}.`
          : `${hedgePhrase(graded.score)} — ${doesRequireLead[1]}${doesRequireLead[2]} requires ${doesRequireLead[3]}.`
      };
    }
  }
  const capableLead = text.match(LEAD_CAPABLE);
  if (capableLead && ctx.relations !== undefined) {
    const relations = ctx.relations();
    const negated = negationAnswer(ctx, capableLead[2], 'capable-of', capableLead[3], `${capableLead[2]} cannot ${capableLead[3]}`);
    if (negated !== null) {
      return {
        kind: 'capable-of',
        subject: capableLead[2],
        action: capableLead[3],
        via: null,
        answer: negated
      };
    }
    const direct = relations.some(
      (r) => r.subject === capableLead[2] && r.predicate === 'capable-of' && r.object === capableLead[3]
    );
    const via = direct ? null : inheritsEdge(relations, capableLead[2], 'capable-of', capableLead[3], denied);
    if (direct || via !== null) {
      const strength = ctx.edgeStrength?.(via?.via ?? capableLead[2], 'capable-of', capableLead[3]) ?? 1;
      return {
        kind: 'capable-of',
        subject: capableLead[2],
        action: capableLead[3],
        via: via?.via ?? null,
        answer: via !== null
          ? `Yes — ${capableLead[1]}${capableLead[2]} is ${/^[aeiou]/.test(via.via) ? 'an' : 'a'} ${via.via}, and ${via.via} can ${capableLead[3]}.`
          : `${yesPrefix(strength)}, ${capableLead[1]}${capableLead[2]} can ${capableLead[3]}.`
      };
    }
    const graded = holographicClosed(ctx, capableLead[2], 'capable-of', capableLead[3]);
    if (graded !== null) {
      return {
        kind: 'capable-of',
        subject: capableLead[2],
        action: capableLead[3],
        via: graded.via,
        score: graded.score,
        answer: graded.via !== null
          ? `${hedgePhrase(graded.score)} — ${capableLead[1]}${capableLead[2]} is ${/^[aeiou]/.test(graded.via) ? 'an' : 'a'} ${graded.via}, and ${graded.via} can ${capableLead[3]}.`
          : `${hedgePhrase(graded.score)} — ${capableLead[1]}${capableLead[2]} can ${capableLead[3]}.`
      };
    }
  }
  const hasPropertyLead = text.match(LEAD_PROPERTY);
  if (hasPropertyLead && ctx.relations !== undefined) {
    const relations = ctx.relations();
    const negated = negationAnswer(ctx, hasPropertyLead[2], 'has-property', hasPropertyLead[3], `${hasPropertyLead[2]} is not ${hasPropertyLead[3]}`);
    if (negated !== null) {
      return {
        kind: 'has-property',
        subject: hasPropertyLead[2],
        property: hasPropertyLead[3],
        via: null,
        answer: negated
      };
    }
    const direct = relations.some(
      (r) => r.subject === hasPropertyLead[2] && r.predicate === 'has-property' && r.object === hasPropertyLead[3]
    );
    const via = direct ? null : inheritsEdge(relations, hasPropertyLead[2], 'has-property', hasPropertyLead[3], denied);
    if (direct || via !== null) {
      const strength = ctx.edgeStrength?.(via?.via ?? hasPropertyLead[2], 'has-property', hasPropertyLead[3]) ?? 1;
      return {
        kind: 'has-property',
        subject: hasPropertyLead[2],
        property: hasPropertyLead[3],
        via: via?.via ?? null,
        answer: via !== null
          ? `Yes — ${hasPropertyLead[1]}${hasPropertyLead[2]} is ${/^[aeiou]/.test(via.via) ? 'an' : 'a'} ${via.via}, and ${via.via} is ${hasPropertyLead[3]}.`
          : `${yesPrefix(strength)}, ${hasPropertyLead[1]}${hasPropertyLead[2]} is ${hasPropertyLead[3]}.`
      };
    }
    const graded = holographicClosed(ctx, hasPropertyLead[2], 'has-property', hasPropertyLead[3]);
    if (graded !== null) {
      return {
        kind: 'has-property',
        subject: hasPropertyLead[2],
        property: hasPropertyLead[3],
        via: graded.via,
        score: graded.score,
        answer: graded.via !== null
          ? `${hedgePhrase(graded.score)} — ${hasPropertyLead[1]}${hasPropertyLead[2]} is ${/^[aeiou]/.test(graded.via) ? 'an' : 'a'} ${graded.via}, and ${graded.via} is ${hasPropertyLead[3]}.`
          : `${hedgePhrase(graded.score)} — ${hasPropertyLead[1]}${hasPropertyLead[2]} is ${hasPropertyLead[3]}.`
      };
    }
  }
  const whatDoLead = text.match(LEAD_WHAT_DO);
  if (whatDoLead && ctx.relations !== undefined) {
    const relations = ctx.relations();
    const actions = edgeObjects(relations, whatDoLead[2], 'capable-of', denied);
    if (actions.length > 0) {
      return {
        kind: 'capable-of',
        subject: whatDoLead[2],
        action: actions[0],
        via: null,
        answer: `${openEdgeHedge(ctx, whatDoLead[2], 'capable-of', actions)}${whatDoLead[1]}${whatDoLead[2]} can ${listPhrase(actions)}.`
      };
    }
    const recalled = holographicOpen(ctx, whatDoLead[2], 'capable-of');
    if (recalled !== null) {
      return {
        kind: 'capable-of',
        subject: whatDoLead[2],
        action: recalled.objects[0],
        via: null,
        score: recalled.topScore,
        answer: `${openHedge(recalled.topScore)} ${whatDoLead[1]}${whatDoLead[2]} can ${listPhrase(recalled.objects)}.`
      };
    }
  }
  const whatLikeLead = text.match(LEAD_WHAT_LIKE);
  if (whatLikeLead && ctx.relations !== undefined) {
    const relations = ctx.relations();
    const properties = edgeObjects(relations, whatLikeLead[2], 'has-property', denied);
    if (properties.length > 0) {
      return {
        kind: 'has-property',
        subject: whatLikeLead[2],
        property: properties[0],
        via: null,
        answer: `${openEdgeHedge(ctx, whatLikeLead[2], 'has-property', properties)}${whatLikeLead[1]}${whatLikeLead[2]} is ${listPhrase(properties)}.`
      };
    }
    const recalled = holographicOpen(ctx, whatLikeLead[2], 'has-property');
    if (recalled !== null) {
      return {
        kind: 'has-property',
        subject: whatLikeLead[2],
        property: recalled.objects[0],
        via: null,
        score: recalled.topScore,
        answer: `${openHedge(recalled.topScore)} ${whatLikeLead[1]}${whatLikeLead[2]} is ${listPhrase(recalled.objects)}.`
      };
    }
  }
  const oppositeLead = text.match(LEAD_OPPOSITE);
  if (oppositeLead && ctx.relations !== undefined) {
    const word = singleWord(oppositeLead[1]);
    const relations = ctx.relations();
    if (word !== null && relations.length > 0) {
      const opposite = relations.find(
        (r) => r.subject === word && r.predicate === 'opposite-of'
      );
      if (opposite !== undefined) {
        return {
          kind: 'opposite-of',
          subject: word,
          opposite: opposite.object,
          answer: `${openEdgeHedge(ctx, word, 'opposite-of', [opposite.object])}The opposite of ${word} is ${opposite.object}.`
        };
      }
      const recalled = holographicOpen(ctx, word, 'opposite-of');
      if (recalled !== null) {
        return {
          kind: 'opposite-of',
          subject: word,
          opposite: recalled.objects[0],
          score: recalled.topScore,
          answer: `${openHedge(recalled.topScore)} the opposite of ${word} is ${listPhrase(recalled.objects)}.`
        };
      }
    }
  }
  const whatForLead = text.match(LEAD_WHAT_FOR);
  if (whatForLead && ctx.relations !== undefined) {
    const relations = ctx.relations();
    const purposes = edgeObjects(relations, whatForLead[2], 'used-for', denied);
    if (purposes.length > 0) {
      return {
        kind: 'used-for',
        subject: whatForLead[2],
        purpose: purposes[0],
        answer: `${openEdgeHedge(ctx, whatForLead[2], 'used-for', purposes)}${whatForLead[1]}${whatForLead[2]} is used for ${listPhrase(purposes)}.`
      };
    }
    const recalled = holographicOpen(ctx, whatForLead[2], 'used-for');
    if (recalled !== null) {
      return {
        kind: 'used-for',
        subject: whatForLead[2],
        purpose: recalled.objects[0],
        score: recalled.topScore,
        answer: `${openHedge(recalled.topScore)} ${whatForLead[1]}${whatForLead[2]} is used for ${listPhrase(recalled.objects)}.`
      };
    }
  }

  // Negation: "do you not know X" inverts the yes/no answer.
  const negationLead = text.match(LEAD_NEGATION);
  if (negationLead) {
    const word = singleWord(text.slice(negationLead[0].length));
    if (word !== null) {
      const known = ctx.isTaught(word);
      return {
        kind: 'yesno',
        word,
        known,
        answer: known ? `Yes, I do know ${word}.` : `No, I do not know ${word} yet.`
      };
    }
  }

  // Capability: fixed honest answers for KNOWN capabilities; a clear "not
  // yet" for everything else (never a claim the observer cannot back).
  const capabilityLead = text.match(LEAD_CAPABILITY);
  if (capabilityLead) {
    const skill = capabilityLead[1].trim().replace(/[?!.]+$/g, '');
    const known = KNOWN_CAPABILITIES.includes(skill);
    return {
      kind: 'capability',
      skill,
      known,
      answer: known ? `Yes, I can ${skill}.` : `No, I cannot ${skill} yet.`
    };
  }

  // Definition: "what is <word>" / "what's <word>"
  const definitionLead = text.match(LEAD_DEFINITION);
  if (definitionLead) {
    const word = wordPhrase(text.slice(definitionLead[0].length));
    if (word !== null && ctx.isTaught(word)) {
      const definition = ctx.definitionOf(word);
      const answer = definition.trim().length > 0
        ? `${word.charAt(0).toUpperCase() + word.slice(1)} is ${definition.trim().replace(/\.+$/, '')}.`
        : `${word.charAt(0).toUpperCase() + word.slice(1)} is a word I know, but I have not learned its meaning yet.`;
      return { kind: 'definition', word, answer };
    }
  }

  // FIRST-PERSON SELF-KNOWLEDGE: answered from a stored belief trace when it
  // exists; otherwise null — the observer falls through rather than claiming
  // self-knowledge it has never committed to memory.
  const selfLead = text.match(LEAD_SELF_KNOWN);
  if (selfLead) {
    const word = singleWord(selfLead[1]);
    if (word !== null && ctx.beliefAbout !== undefined) {
      const belief = ctx.beliefAbout(word);
      if (belief !== null) {
        const answer = belief.contradicts
          ? `I thought I knew ${word}, but I just failed it, so I am not sure I still do.`
          : belief.content;
        return { kind: 'self-knowledge', word, answer };
      }
    }
  }

  // Yes/no: "do you know <word>" / "do you remember <word>" etc.
  const yesNoLead = text.match(LEAD_YESNO);
  if (yesNoLead) {
    const word = singleWord(text.slice(yesNoLead[0].length));
    if (word !== null) {
      const known = ctx.isTaught(word);
      const answer = known
        ? `Yes, I know ${word}.`
        : `No, I do not know ${word} yet.`;
      return { kind: 'yesno', word, known, answer };
    }
  }

  // Count: "how many words do you know" etc.
  if (LEAD_COUNT.test(text)) {
    const what = (text.match(LEAD_COUNT))![1];
    const count = what === 'phrases' ? ctx.phraseCount() : ctx.wordCount();
    const answer =
      what === 'phrases'
        ? `I have learned ${count} phrase${count === 1 ? '' : 's'}.`
        : `I know ${count} word${count === 1 ? '' : 's'}.`;
    return { kind: 'count', what, count, answer };
  }

  // Echo: "say <word>" / "can you say <word>" — the observer speaks a word
  // it knows.
  const echoLead = text.match(LEAD_ECHO);
  if (echoLead) {
    const word = singleWord(text.slice(echoLead[0].length));
    if (word !== null && ctx.isTaught(word)) {
      return { kind: 'echo', word, answer: word };
    }
    if (word !== null) {
      return { kind: 'yesno', word, known: false, answer: `I do not know ${word} yet.` };
    }
  }

  // Property relation: "what color is X" — answered ONLY when the taught
  // definition literally names the property value (no inference).
  const propertyLead = text.match(LEAD_ATTRIBUTE);
  if (propertyLead) {
    const property = propertyLead[1];
    const object = singleWord(propertyLead[2]);
    if (object !== null && ctx.isTaught(object)) {
      const definition = ctx.definitionOf(object).toLowerCase();
      const candidates = property === 'color' ? COLOR_WORDS : property === 'size' ? SIZE_WORDS : SHAPE_WORDS;
      const value = candidates.find((word) => definition.includes(word));
      if (value !== undefined) {
        return {
          kind: 'property',
          property,
          object,
          value,
          answer: `The ${property} of ${object} is ${value}.`
        };
      }
    }
    // No literal value in memory → falls through honestly.
  }

  // Where: answered only when the taught definition contains a location
  // clause ("in the sky", "on the table", ...). The clause matcher is shared
  // with the relations extractor so the where-answer and located-in edges
  // can never disagree about a definition.
  const whereLead = text.match(LEAD_WHERE);
  if (whereLead) {
    const object = singleWord(whereLead[1]);
    if (object !== null && ctx.isTaught(object)) {
      const definition = ctx.definitionOf(object).toLowerCase();
      const location = matchLocationClause(definition);
      if (location !== null) {
        return {
          kind: 'where',
          object,
          place: location.place,
          answer: `${object.charAt(0).toUpperCase() + object.slice(1)} is ${location.preposition} ${location.article} ${location.place}.`
        };
      }
      // P1 graded fallback: the loose bindings may hold a located-in edge the
      // precision graph (and the definition's own clause) does not.
      const recalled = holographicOpen(ctx, object, 'located-in');
      if (recalled !== null) {
        return {
          kind: 'where',
          object,
          place: recalled.objects[0],
          score: recalled.topScore,
          answer: `${openHedge(recalled.topScore)} ${object} is ${recalled.objects[0]}.`
        };
      }
    }
  }

  // P10 MULTI-PREDICATE COMPOSITION: every single-predicate path above was
  // silent, yet a SOUND chain of stored edges may still back the claim —
  // "can a bird pump" via bird is-a animal, animal has-part heart, heart
  // capable-of pump. The chain must match a composition rule, clear the MDL
  // gate, and survive the confirmed-false store; otherwise the observer
  // honestly falls through (absence of evidence is never answered as
  // absence). The answer cites the full chain, hedged when any hop's edge
  // was weakened by wrong grades.
  const composed = composedClosedAnswer(text, ctx);
  if (composed !== null) return composed;

  return null;
}

/**
 * The P10 composed fallback for the closed relational forms: re-parse the
 * same question shapes the single-predicate branches handled and back them
 * with a sound multi-predicate chain. Only utterances those branches already
 * claimed are tried — composition never extends the operator grammar.
 */
function composedClosedAnswer(text: string, ctx: OperatorContext): OperatorResult {
  if (ctx.relations === undefined) return null;
  const relations = ctx.relations();
  if (relations.length === 0) return null;
  const forms: Array<{
    re: RegExp;
    predicate: RelationPredicate;
    subjectGroup: number;
    objectGroup: number;
  }> = [
    { re: LEAD_IS_A, predicate: 'is-a', subjectGroup: 1, objectGroup: 2 },
    { re: LEAD_HAS_PART, predicate: 'has-part', subjectGroup: 1, objectGroup: 2 },
    { re: LEAD_MADE_OF, predicate: 'made-of', subjectGroup: 1, objectGroup: 2 },
    { re: LEAD_USED_FOR, predicate: 'used-for', subjectGroup: 2, objectGroup: 3 },
    { re: LEAD_DOES_CAUSE, predicate: 'causes', subjectGroup: 2, objectGroup: 3 },
    { re: LEAD_DOES_REQUIRE, predicate: 'requires', subjectGroup: 2, objectGroup: 3 },
    { re: LEAD_CAPABLE, predicate: 'capable-of', subjectGroup: 2, objectGroup: 3 },
    { re: LEAD_PROPERTY, predicate: 'has-property', subjectGroup: 2, objectGroup: 3 }
  ];
  for (const form of forms) {
    const match = text.match(form.re);
    if (match === null) continue;
    const subject = match[form.subjectGroup];
    const object = match[form.objectGroup];
    if (subject === undefined || object === undefined) continue;
    const claim = composeClaim(relations, subject, form.predicate, object, {
      denied: (s, p, o) => {
        const negation = ctx.negationOf?.(s, p, o);
        return negation !== null && negation !== undefined;
      },
      cost: ctx.compositionCost ?? null
    });
    if (claim === null) continue;
    return {
      kind: 'composed',
      subject: claim.subject,
      predicate: claim.predicate,
      object: claim.object,
      hops: claim.hops.map((hop) => ({ subject: hop.subject, predicate: hop.predicate, object: hop.object })),
      support: claim.support,
      answer: `${claim.support >= 1 ? 'Yes — ' : 'Probably — '}${chainPhrase(claim)}.`
    };
  }
  return null;
}

/**
 * Cluster gaps by shared content words — the observer's ignorance becomes
 * visible as DOMAINS, not a queue. Greedy clustering: a gap joins a cluster
 * when it shares at least two content tokens with the cluster's union.
 */
export function clusterGaps(gaps: readonly string[]): Array<{ words: string[]; members: string[] }> {
  const clusters: Array<{ tokens: Map<string, number>; members: string[] }> = [];
  for (const gap of gaps) {
    const tokens = new Set(
      tokenizeText(gap).filter((token) => token.length > 2 && isContentWord(token))
    );
    if (tokens.size === 0) continue;
    let joined = clusters.find((cluster) => {
      let shared = 0;
      for (const token of tokens) {
        if (cluster.tokens.has(token)) shared += 1;
      }
      return shared >= 2;
    });
    if (joined === undefined) {
      joined = { tokens: new Map(), members: [] };
      clusters.push(joined);
    }
    for (const token of tokens) {
      joined.tokens.set(token, (joined.tokens.get(token) ?? 0) + 1);
    }
    joined.members.push(gap);
  }
  return clusters
    .filter((cluster) => cluster.members.length >= 2)
    .map((cluster) => ({
      words: [...cluster.tokens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([word]) => word),
      members: cluster.members
    }))
    .sort((a, b) => b.members.length - a.members.length);
}
