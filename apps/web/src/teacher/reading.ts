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
  'able', 'sure', 'true', 'false', 'right', 'wrong', 'only', 'even', 'still', 'also', 'just', 'thing', 'things',
  // Quantifiers, placeholders and discourse words a head-final search would
  // otherwise pick up ("Zeus was the ONE who...", "...respectively").
  'one', 'ones', 'two', 'three', 'part', 'parts', 'kind', 'kinds', 'type', 'types', 'form', 'forms',
  'name', 'names', 'number', 'numbers', 'group', 'groups', 'member', 'members', 'example', 'examples',
  'respectively', 'today', 'time', 'times', 'way', 'ways', 'place', 'places', 'people', 'person'
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
export function resolveWord(
  token: string,
  vocabulary: ReadonlySet<string>,
  entities: ReadonlySet<string> = new Set()
): string | null {
  const word = token.toLowerCase().replace(/[^a-z-]/g, '');
  if (word.length === 0 || NON_HEAD.has(word) || !isContentWord(word)) return null;
  // A named entity is a first-class subject/object even though no deck
  // definition exists for it: the observer can hold "zeus is-a god" and say
  // it, while honestly having no definition of "zeus" to recite.
  if (entities.has(word)) return word;
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

// ── Named entities ──────────────────────────────────────────────────────────

/** Words that are capitalized for grammar, not because they name something. */
const SENTENCE_STARTERS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'he', 'she', 'they', 'his', 'her', 'its',
  'their', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'when', 'while', 'after', 'before', 'during',
  'some', 'many', 'most', 'other', 'there', 'here', 'today', 'later', 'then', 'but', 'and', 'however',
  'according', 'both', 'each', 'every', 'no', 'not', 'if', 'as', 'because', 'although', 'though'
]);

/**
 * The named entities a passage introduces: tokens the text capitalizes in
 * NON-initial position (so "Zeus", "Rome" and "Mount Olympus" qualify while
 * a sentence-initial "The" does not). Entities are what history, mythology
 * and literature are ABOUT — without them those subjects yield nothing.
 */
export function entitiesIn(text: string): Set<string> {
  const entities = new Set<string>();
  for (const sentence of splitSentences(text)) {
    const tokens = sentence.split(/\s+/);
    // A capitalized RUN is one name ("Ancient Rome", "Julius Caesar", "Mount
    // Olympus"); its HEAD is the last token. Registering every token would
    // make "Ancient" a subject and produce "ancient is-a civilization".
    let run: string[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      const head = run[run.length - 1].toLowerCase();
      if (!SENTENCE_STARTERS.has(head) && head.length >= 3) entities.add(head);
      run = [];
    };
    for (let i = 1; i < tokens.length; i += 1) {
      const raw = tokens[i].replace(/[^A-Za-z-]/g, '');
      const isName = raw.length >= 2 && /^[A-Z][a-z-]+$/.test(raw) && !SENTENCE_STARTERS.has(raw.toLowerCase());
      if (isName) run.push(raw);
      else flush();
      // Punctuation ends a name run ("Rome, the capital" is two phrases).
      if (/[,.;:]$/.test(tokens[i])) flush();
    }
    flush();
  }
  return entities;
}

// ── Modality gates ──────────────────────────────────────────────────────────

/** Sentences whose truth is not asserted in the present are not read. */
const HEDGED = /\b(?:might|maybe|perhaps|probably|possibly|seems?|appears?|suppose|imagine|wish|would|could|should|if|unless|whether)\b/i;
const PAST_OR_FUTURE = /\b(?:was|were|had|did|will|shall|used to|going to)\b/i;
const QUESTION = /\?\s*$/;
/** Reported speech and opinion are the speaker's, not the world's. */
const ATTRIBUTED = /\b(?:said|says|thinks?|thought|believes?|claims?|argued|wrote|asked|told)\b/i;

/**
 * ENCYCLOPEDIC PAST is knowledge; NARRATIVE past is an episode.
 *
 * "Nero was a Roman emperor" and "Zeus was the king of the gods" are
 * timeless facts about named entities — the entire history and mythology
 * curriculum is written that way. "The bird was hungry" is a moment in a
 * story and must never become an edge. The honest discriminator available
 * without a parser: past tense is read ONLY when the subject is a NAMED
 * ENTITY (a proper noun the text capitalizes mid-sentence). Articles are
 * about entities; narrative episodes are usually about common nouns.
 */
function readable(sentence: string, entitySubject: boolean): boolean {
  if (QUESTION.test(sentence)) return false;
  if (HEDGED.test(sentence)) return false;
  if (ATTRIBUTED.test(sentence)) return false;
  if (PAST_OR_FUTURE.test(sentence) && !entitySubject) return false;
  return true;
}

// ── The prose claim grammar ─────────────────────────────────────────────────

/**
 * Where a noun phrase ENDS. Everything after a post-modifier belongs to a
 * different relation: "the god OF the sky, lightning and thunder IN Greek
 * religion" is one claim (god), not five. Without this boundary the reader
 * harvests every noun in a long encyclopedic sentence — measured 9%
 * precision on mythology prose before the cut, and the graph fills with
 * "zeus is-a lightning".
 */
const PHRASE_END = /\b(?:of|in|on|at|from|by|for|with|who|whom|whose|which|that|when|where|known|called|named|born|during|after|before|between|among|near|under|over|through|according|respectively)\b/i;

/** The head noun of a single noun phrase (English is head-final). */
function headNoun(phrase: string, vocabulary: ReadonlySet<string>, entities: ReadonlySet<string>): string | null {
  const cut = phrase.search(PHRASE_END);
  const head = (cut > 0 ? phrase.slice(0, cut) : phrase).trim();
  const tokens = head.split(/\s+/).filter((token) => token.length > 0);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const resolved = resolveWord(tokens[i], vocabulary, entities);
    if (resolved !== null) return resolved;
  }
  return null;
}

/**
 * Nouns that name EVENTS, STATES or abstractions. Prose says "had a war",
 * "has mixed feelings", "had a headache" — none of which are parts of
 * anything. Measured on the mythology corpus, these produced most of the
 * wrong has-part edges.
 */
/** Relational nouns whose "is" states an ASSOCIATION, not a kind: "her
 *  symbol is the owl", "his items are the crown and veil". The observer has
 *  no association predicate, so these are dropped instead of becoming
 *  false is-a edges. */
const ATTRIBUTE_NOUN = new Set([
  'symbol', 'symbols', 'sign', 'signs', 'item', 'items', 'colour', 'color', 'colours', 'colors',
  'name', 'names', 'title', 'titles', 'number', 'numbers', 'shape', 'shapes', 'size', 'sizes',
  'guess', 'result', 'results', 'reason', 'reasons', 'cause', 'causes', 'aim', 'goal', 'goals'
]);

const NOT_A_PART = new Set([
  'war', 'battle', 'fight', 'feeling', 'feelings', 'headache', 'idea', 'ideas', 'problem', 'problems',
  'power', 'powers', 'control', 'influence', 'effect', 'effects', 'reason', 'reasons', 'right', 'rights',
  'life', 'death', 'birth', 'love', 'hate', 'fear', 'luck', 'fame', 'honor', 'honour', 'meaning',
  'history', 'story', 'stories', 'version', 'versions', 'role', 'roles', 'job', 'work', 'help',
  'chance', 'choice', 'plan', 'plans', 'trouble', 'success', 'failure', 'interest', 'support',
  'relationship', 'relationships', 'child', 'children', 'son', 'daughter', 'wife', 'husband', 'mother', 'father'
]);

/**
 * The objects of a claim. A KIND claim ("X is a Y") takes exactly one head
 * noun — a conjunction there joins roles, not objects ("the king and queen
 * of the Titans"). Part/material/ability claims genuinely conjoin ("made of
 * grass, mud and sticks"), so those split — each conjunct still cut at its
 * own phrase boundary.
 */
function objectList(
  rest: string,
  vocabulary: ReadonlySet<string>,
  entities: ReadonlySet<string>,
  single: boolean
): string[] {
  if (single) {
    const head = headNoun(rest, vocabulary, entities);
    return head === null ? [] : [head];
  }
  // Only conjuncts BEFORE the first post-modifier are objects of this claim.
  const cut = rest.search(PHRASE_END);
  const scope = cut > 0 ? rest.slice(0, cut) : rest;
  return scope
    .split(/\s*(?:,|\band\b)\s*/i)
    .map((chunk) => headNoun(chunk, vocabulary, entities))
    .filter((word): word is string => word !== null);
}

/** The subject phrase of a sentence: its head noun, or the running narrative
 *  subject when the sentence opens with a pronoun. */
function subjectOf(phrase: string, vocabulary: ReadonlySet<string>, entities: ReadonlySet<string>, narrative: string | null): string | null {
  const trimmed = phrase.trim().toLowerCase().replace(/\b(\w+)'s\b/g, '$1');
  // A POSSESSIVE subject ("Athena's symbol is the owl") states a fact about
  // the symbol, not about Athena — and the observer has no relation for
  // "symbol of", so the claim is dropped rather than misattributed.
  if (/'s\b/.test(phrase) || /\b(?:his|her|its|their|my|your|our)\b/i.test(phrase)) return null;
  // A CONJOINED subject has ambiguous scope: "Zeus and other gods had a war"
  // is not a fact about Zeus alone. Measured on real mythology prose, these
  // were a leading source of wrong edges.
  if (/\b(?:and|or)\b/.test(trimmed) || trimmed.split(/\s+/).length > 4) return null;
  // Only a SINGULAR pronoun may take the narrative subject. "They" after a
  // sentence about one entity refers to something else entirely — measured:
  // "They can make themselves invisible" became "zeus capable-of make".
  if (/^(?:it|he|she|this)$/.test(trimmed)) return narrative;
  if (/^(?:they|these|those|them)$/.test(trimmed)) return null;
  const tokens = trimmed.replace(/^(?:a|an|the|every|all|most|some)\s+/, '').split(/\s+/);
  // An ENTITY anywhere in the subject phrase wins over a common-noun head:
  // "the god Zeus" and "Zeus, king of the gods" are both about Zeus.
  for (const token of tokens) {
    const word = token.toLowerCase().replace(/[^a-z-]/g, '');
    if (entities.has(word)) return word;
  }
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const resolved = resolveWord(tokens[i], vocabulary, entities);
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
  { regex: /^(.+?)\s+(?:is|are|was|were)\s+not\s+(?:a|an|the)?\s*(.+)$/i, predicate: 'is-a', negated: true },
  { regex: /^(.+?)\s+(?:is|are|was|were)\s+(?:a|an)\s+(?:kind|type|sort)\s+of\s+(.+)$/i, predicate: 'is-a' },
  { regex: /^(.+?)\s+(?:is|are|was|were)\s+used\s+(?:for|to)\s+(.+)$/i, predicate: 'used-for' },
  { regex: /^(.+?)\s+(?:is|are|was|were)\s+made\s+(?:of|from)\s+(.+)$/i, predicate: 'made-of' },
  { regex: /^(.+?)\s+(?:lives?|live|lived|grows?|grow|grew|is found|are found|was found|were found)\s+(?:in|on|at|near)\s+(.+)$/i, predicate: 'located-in' },
  { regex: /^(.+?)\s+(?:is|are|was|were)\s+(?:located|situated)\s+(?:in|on|at)\s+(.+)$/i, predicate: 'located-in' },
  { regex: /^(.+?)\s+can\s+(.+)$/i, predicate: 'capable-of' },
  { regex: /^(.+?)\s+(?:has|have)\s+(?!been\b|not\b|to\b|a lot\b|many\b|no\b)(.+)$/i, predicate: 'has-part' },
  { regex: /^(.+?)\s+(?:is|are|was|were)\s+(?:a|an|the)\s+(.+)$/i, predicate: 'is-a' }
];

/** Read one sentence into claims (empty when nothing parses). */
export function readSentence(
  sentence: string,
  vocabulary: ReadonlySet<string>,
  narrative: string | null,
  entities: ReadonlySet<string> = new Set()
): ReadingClaim[] {
  const clean = sentence.replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
  if (clean.length === 0) return [];
  // A FRONTED phrase is not the subject: "In reality, the violin had not
  // been invented" is about the violin, not about reality. Strip a leading
  // adverbial or prepositional phrase before looking for the subject.
  const fronted = clean.replace(
    /^(?:in|at|on|by|during|after|before|since|from|for|with|within|throughout|according to|because of|due to|traditionally|today|later|then|however|meanwhile|eventually|finally|originally|generally|usually|often|sometimes|also|therefore|thus|hence|instead|besides|overall|nevertheless|likewise|similarly|indeed)\b[^,]{0,60},\s*/i,
    ''
  );
  // A sentence with a subordinate clause states more than one thing; only
  // the main clause is read (the observer never guesses at scope).
  const main = fronted.split(/\b(?:because|although|though|while|which|who|that|when|since|so that)\b/i)[0].trim();
  for (const pattern of PATTERNS) {
    const hit = main.match(pattern.regex);
    if (hit === null) continue;
    const subject = subjectOf(hit[1], vocabulary, entities, narrative);
    if (subject === null) continue;
    if (pattern.predicate === 'is-a' && ATTRIBUTE_NOUN.has(subject)) continue;
    // The modality gate is applied ONCE the subject is known, because the
    // encyclopedic past is only readable about a named entity.
    if (!readable(sentence, entities.has(subject))) return [];
    let objects = objectList(hit[2], vocabulary, entities, pattern.predicate === 'is-a');
    // Parts are physical constituents; events and states are not.
    if (pattern.predicate === 'has-part') {
      // Parts are constituents, not people or events: "Hera has two
      // daughters ... Hebe, Ares" is kinship, and the observer has no
      // kinship predicate, so those objects are dropped rather than
      // recorded as anatomy.
      objects = objects.filter((object) => !NOT_A_PART.has(object) && !entities.has(object));
    }
    // An ability is a VERB: "can fly", "can swim". Prose like "can make
    // themselves invisible to humans" must not yield "capable-of human", so
    // only the first token after "can" is taken and only when it is a bare
    // verb (no article or adjective in front of it).
    if (pattern.predicate === 'capable-of') {
      const first = hit[2].trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z-]/g, '') ?? '';
      const verb = resolveWord(first, vocabulary, entities);
      objects = verb === null || /^(?:a|an|the|his|her|its|their|this|that|very|more|most)$/.test(first) ? [] : [verb];
    }
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

  // The passage's named entities, derived once: history, mythology and
  // literature are ABOUT entities, and without them those subjects yield
  // nothing at all.
  const entities = entitiesIn(text);
  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    // Vocabulary exposure is counted for EVERY sentence, parsed or not —
    // reading teaches words even when it teaches no relations.
    for (const token of sentence.toLowerCase().split(/[^a-z']+/)) {
      const word = token.replace(/'/g, '');
      if (word.length < 3 || !isContentWord(word)) continue;
      const resolved = resolveWord(word, vocabulary, entities);
      if (resolved !== null) knownWords.set(resolved, (knownWords.get(resolved) ?? 0) + 1);
      // Quantifiers and placeholders are not words the observer is missing —
      // they are words no claim can be built from, so they never join the
      // reading list.
      else if (!NON_HEAD.has(word)) unknownWords.set(word, (unknownWords.get(word) ?? 0) + 1);
    }

    const claims = readSentence(sentence, vocabulary, narrative, entities);
    if (claims.length === 0) {
      // A sentence the grammar could not read breaks the referential chain:
      // "it/they" after unread prose refers to something the observer did
      // not see, so the narrative subject is dropped rather than guessed.
      narrative = null;
      continue;
    }
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
