/**
 * READING — learning from continuous text instead of taught pairs.
 *
 * THE SYMMETRY THAT MAKES THIS HONEST. The observer already owns a claim
 * grammar: the internal critic parses every sentence it wants to SPEAK back
 * into {subject, predicate, object} claims and refuses anything the relation
 * graph does not back (groundedFrames.parseClaims). Reading is that grammar
 * run in reverse — the observer ingests exactly the sentence shapes it is
 * able to say and verify, and nothing else. What it cannot parse it does not
 * pretend to understand: unparsed sentences contribute vocabulary exposure
 * and nothing more.
 *
 * WHAT PROSE ADDS over dictionary definitions (relations.extractRelations,
 * which is given the subject and parses a definition):
 *   - the SUBJECT must be found, not assumed;
 *   - anaphora: books say "it/they" constantly, so a running narrative
 *     subject resolves those pronouns (and a claim whose subject cannot be
 *     resolved is dropped, never guessed);
 *   - plurals and bare-noun generics: "Robins are birds", "Birds have
 *     feathers";
 *   - noise: narrative, dialogue, metaphor and opinion, none of which parse
 *     into the claim grammar and all of which are therefore skipped.
 *
 * WHAT KEEPS THE GRAPH CLEAN.
 *   - VOCABULARY GATE: subject and object must both be known deck words
 *     (plural/compound resolution allowed). An unknown word cannot become an
 *     edge — it is reported as an ENCOUNTER so the curriculum can schedule
 *     it and the observer can honestly ask what it means.
 *   - MODALITY GATE: hedged, negated-by-adverb, question, and non-present
 *     sentences are skipped ("birds might migrate", "did the bird fly").
 *     Explicit negations become confirmed-false statements instead of edges.
 *   - PROVENANCE: every edge carries origin 'reading' and source class
 *     'reading', so the corroboration layer treats a single book as ONE
 *     source: a read-only claim is spoken hedged until an independent
 *     channel (curriculum, conversation, world feedback) confirms it.
 */

import { isContentWord } from './context';
import type { Relation, RelationPredicate } from './relations';

/** One claim lifted from a sentence, with the sentence as its provenance. */
export interface ReadingClaim {
  subject: string;
  predicate: RelationPredicate;
  object: string;
  /** True for explicit negations ("a whale is not a fish"). */
  negated: boolean;
  /** The sentence the claim was read from. */
  sentence: string;
}

export interface ReadingResult {
  /** Edges ready for the relation graph (origin 'reading'). */
  relations: Relation[];
  /** Explicit negations, for the confirmed-false store. */
  negations: Array<{ subject: string; predicate: RelationPredicate; object: string; sentence: string }>;
  /** Content words met that are NOT in the vocabulary, with counts — the
   *  curriculum's reading list and the observer's honest questions. */
  unknownWords: Map<string, number>;
  /** Known vocabulary words met, with counts (exposure for scheduling). */
  knownWords: Map<string, number>;
  sentencesRead: number;
  /** Sentences that produced at least one claim. */
  sentencesParsed: number;
}

export interface ReadingOptions {
  /** The known vocabulary (deck words). Edges outside it are refused. */
  vocabulary: ReadonlySet<string>;
  /** Source label kept on every relation (book title, file name). */
  source?: string;
}

// ── Sentence segmentation ───────────────────────────────────────────────────

/** Abbreviations that must not end a sentence. */
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'vs', 'etc', 'e.g', 'i.e', 'fig', 'no']);

/** Split prose into sentences, keeping abbreviations and decimals intact. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let current = '';
  const chars = [...text.replace(/\s+/g, ' ')];
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    current += char;
    if (char !== '.' && char !== '!' && char !== '?') continue;
    const next = chars[i + 1];
    // A decimal point or an initial ("J. R.") does not end a sentence.
    if (char === '.' && next !== undefined && /[0-9]/.test(next)) continue;
    const trailing = current.trim().split(/\s+/).pop() ?? '';
    const word = trailing.slice(0, -1).toLowerCase();
    if (char === '.' && (ABBREVIATIONS.has(word) || word.length === 1)) continue;
    if (next !== undefined && next !== ' ') continue;
    out.push(current.trim());
    current = '';
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out.filter((sentence) => sentence.length > 0);
}

// ── Vocabulary gate ─────────────────────────────────────────────────────────

/** Adjectives and function words that are never a claim's head noun. */
const NON_HEAD = new Set([
  'very', 'many', 'some', 'most', 'more', 'much', 'such', 'other', 'same', 'own', 'good', 'bad', 'great',
  'little', 'big', 'small', 'long', 'short', 'high', 'low', 'old', 'new', 'young', 'first', 'last', 'next',
  'able', 'sure', 'true', 'false', 'right', 'wrong', 'only', 'even', 'still', 'also', 'just', 'thing', 'things'
]);

/**
 * Resolve a token to a vocabulary word, ALWAYS preferring the singular.
 *
 * The deck carries both forms for many nouns ("feather" and "feathers"), so
 * accepting whichever form the text used would fragment the graph: "robin
 * has-part feathers" and "bird has-part feather" would be different edges
 * about the same fact, and inheritance would never connect them. Reading
 * therefore normalizes to the singular whenever the singular is known.
 */
export function resolveWord(token: string, vocabulary: ReadonlySet<string>): string | null {
  const word = token.toLowerCase().replace(/[^a-z-]/g, '');
  if (word.length === 0 || NON_HEAD.has(word) || !isContentWord(word)) return null;
  // Singular candidates, most specific first ("bodies" -> body, "boxes" ->
  // box, "wings" -> wing).
  const candidates: string[] = [];
  if (word.endsWith('ies') && word.length > 4) candidates.push(`${word.slice(0, -3)}y`);
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('ches') || word.endsWith('shes')) {
    candidates.push(word.slice(0, -2));
  }
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) candidates.push(word.slice(0, -1));
  for (const candidate of candidates) {
    if (vocabulary.has(candidate)) return candidate;
  }
  if (vocabulary.has(word)) return word;
  return null;
}

// ── Modality gates ──────────────────────────────────────────────────────────

/** Sentences whose truth is not asserted in the present are not read. */
const HEDGED = /\b(?:might|maybe|perhaps|probably|possibly|seems?|appears?|suppose|imagine|wish|would|could|should|if|unless|whether)\b/i;
const PAST_OR_FUTURE = /\b(?:was|were|had|did|will|shall|used to|going to)\b/i;
const QUESTION = /\?\s*$/;
/** Reported speech and opinion are the speaker's, not the world's. */
const ATTRIBUTED = /\b(?:said|says|thinks?|thought|believes?|claims?|argued|wrote|asked|told)\b/i;

function readable(sentence: string): boolean {
  if (QUESTION.test(sentence)) return false;
  if (HEDGED.test(sentence)) return false;
  if (PAST_OR_FUTURE.test(sentence)) return false;
  if (ATTRIBUTED.test(sentence)) return false;
  return true;
}

// ── The prose claim grammar ─────────────────────────────────────────────────

/** Split a conjoined object list ("wings and feathers", "wings, tails"). */
function objectList(rest: string, vocabulary: ReadonlySet<string>): string[] {
  return rest
    .split(/\s*(?:,|\band\b)\s*/i)
    .map((chunk) => {
      // The head noun of a chunk is its LAST resolvable token (English noun
      // phrases are head-final: "long grey feathers" -> feathers).
      const tokens = chunk.trim().split(/\s+/);
      for (let i = tokens.length - 1; i >= 0; i -= 1) {
        const resolved = resolveWord(tokens[i], vocabulary);
        if (resolved !== null) return resolved;
      }
      return null;
    })
    .filter((word): word is string => word !== null);
}

/** The subject phrase of a sentence: its head noun, or the running narrative
 *  subject when the sentence opens with a pronoun. */
function subjectOf(phrase: string, vocabulary: ReadonlySet<string>, narrative: string | null): string | null {
  const trimmed = phrase.trim().toLowerCase();
  if (/^(?:it|they|he|she|these|those|this|that)$/.test(trimmed)) return narrative;
  const tokens = trimmed.replace(/^(?:a|an|the|every|all|most|some)\s+/, '').split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const resolved = resolveWord(tokens[i], vocabulary);
    if (resolved !== null) return resolved;
  }
  return null;
}

interface Pattern {
  regex: RegExp;
  predicate: RelationPredicate;
  negated?: boolean;
}

/**
 * The sentence shapes the observer can both READ and SAY. Each mirrors a
 * clause of the critic's claim grammar; nothing outside this set is ingested.
 */
const PATTERNS: readonly Pattern[] = [
  { regex: /^(.+?)\s+(?:is|are)\s+not\s+(?:a|an|the)?\s*(.+)$/i, predicate: 'is-a', negated: true },
  { regex: /^(.+?)\s+(?:is|are)\s+(?:a|an)\s+(?:kind|type|sort)\s+of\s+(.+)$/i, predicate: 'is-a' },
  { regex: /^(.+?)\s+(?:is|are)\s+used\s+(?:for|to)\s+(.+)$/i, predicate: 'used-for' },
  { regex: /^(.+?)\s+(?:is|are)\s+made\s+(?:of|from)\s+(.+)$/i, predicate: 'made-of' },
  { regex: /^(.+?)\s+(?:lives?|live|grows?|grow|is found|are found)\s+(?:in|on|at|near)\s+(.+)$/i, predicate: 'located-in' },
  { regex: /^(.+?)\s+(?:is|are)\s+(?:located|situated)\s+(?:in|on|at)\s+(.+)$/i, predicate: 'located-in' },
  { regex: /^(.+?)\s+(?:can|cannot)\s+(.+)$/i, predicate: 'capable-of' },
  { regex: /^(.+?)\s+(?:has|have)\s+(.+)$/i, predicate: 'has-part' },
  { regex: /^(.+?)\s+(?:is|are)\s+(?:a|an)\s+(.+)$/i, predicate: 'is-a' }
];

/** Read one sentence into claims (empty when nothing parses). */
export function readSentence(
  sentence: string,
  vocabulary: ReadonlySet<string>,
  narrative: string | null
): ReadingClaim[] {
  const clean = sentence.replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
  if (clean.length === 0 || !readable(sentence)) return [];
  // A sentence with a subordinate clause states more than one thing; only
  // the main clause is read (the observer never guesses at scope).
  const main = clean.split(/\b(?:because|although|though|while|which|who|that|when|since|so that)\b/i)[0].trim();
  for (const pattern of PATTERNS) {
    const hit = main.match(pattern.regex);
    if (hit === null) continue;
    const subject = subjectOf(hit[1], vocabulary, narrative);
    if (subject === null) continue;
    const objects = objectList(hit[2], vocabulary);
    const claims = objects
      .filter((object) => object !== subject)
      .map((object) => ({ subject, predicate: pattern.predicate, object, negated: pattern.negated === true, sentence: clean }));
    if (claims.length > 0) return claims;
  }
  return [];
}

// ── Reading a passage ───────────────────────────────────────────────────────

/**
 * Read continuous text: every sentence is segmented, gated for modality,
 * and parsed by the claim grammar. Claims become relations with reading
 * provenance; explicit negations become confirmed-false statements; every
 * content word is counted as known (schedulable) or unknown (askable).
 */
export function readText(text: string, options: ReadingOptions): ReadingResult {
  const { vocabulary } = options;
  const source = options.source ?? 'reading';
  const relations: Relation[] = [];
  const negations: ReadingResult['negations'] = [];
  const unknownWords = new Map<string, number>();
  const knownWords = new Map<string, number>();
  const seen = new Set<string>();
  let narrative: string | null = null;
  let sentencesParsed = 0;

  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    // Vocabulary exposure is counted for EVERY sentence, parsed or not —
    // reading teaches words even when it teaches no relations.
    for (const token of sentence.toLowerCase().split(/[^a-z']+/)) {
      const word = token.replace(/'/g, '');
      if (word.length < 3 || !isContentWord(word)) continue;
      const resolved = resolveWord(word, vocabulary);
      if (resolved !== null) knownWords.set(resolved, (knownWords.get(resolved) ?? 0) + 1);
      else unknownWords.set(word, (unknownWords.get(word) ?? 0) + 1);
    }

    const claims = readSentence(sentence, vocabulary, narrative);
    if (claims.length === 0) continue;
    sentencesParsed += 1;
    // The narrative subject advances only on a NAMED subject, so a run of
    // pronoun sentences all resolve to the same thing the text introduced.
    narrative = claims[0].subject;
    for (const claim of claims) {
      const key = `${claim.subject}\u0000${claim.predicate}\u0000${claim.object}\u0000${claim.negated}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (claim.negated) {
        negations.push({ subject: claim.subject, predicate: claim.predicate, object: claim.object, sentence: claim.sentence });
      } else {
        relations.push({
          subject: claim.subject,
          predicate: claim.predicate,
          object: claim.object,
          source: `${source}: ${claim.sentence}`,
          origin: 'reading',
          sourceClasses: ['reading']
        });
      }
    }
  }

  return { relations, negations, unknownWords, knownWords, sentencesRead: sentences.length, sentencesParsed };
}
