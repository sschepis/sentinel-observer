/**
 * Working memory: a short ring of the last conversation turns, plus LITE
 * reference resolution. The observer is stateless per turn today — this
 * gives it a few turns of context so references ("it", "that", "him") and
 * follow-ups can be resolved against what was just said.
 *
 * Resolution is deliberately minimal and HONEST: only pronouns pointing at
 * the last content word in the recent window are rewritten; anything
 * unresolvable is left untouched and flows through the normal (decline /
 * ask) paths.
 */

export interface WorkingTurn {
  role: 'user' | 'observer';
  text: string;
  at: number;
}

/** Ring buffer of recent turns (session-scoped by design — conversation
 *  context must not persist across restarts). EPISODIC memory (episodic.ts)
 *  is the deliberate, selective exception: only SALIENT facts survive — user
 *  facts, vocabulary mastery/failure, recurring topics, session gaps — and
 *  every retrieved entry is tagged as remembered. Raw transcripts never
 *  persist; episodes do. */
export class WorkingMemory {
  private readonly turns: WorkingTurn[] = [];

  constructor(private readonly capacity = 8) {}

  note(role: 'user' | 'observer', text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.turns.push({ role, text: trimmed, at: Date.now() });
    if (this.turns.length > this.capacity) this.turns.shift();
  }

  all(): WorkingTurn[] {
    return [...this.turns];
  }

  recent(n: number): WorkingTurn[] {
    return this.turns.slice(-n);
  }

  clear(): void {
    this.turns.length = 0;
  }
}

const PRONOUNS = new Set(['it', 'that', 'this', 'he', 'she', 'they', 'them', 'its', 'there', 'him', 'her']);

const FUNCTION_WORDS = new Set([
  'what', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'but',
  'do', 'does', 'did', 'you', 'i', 'we', 'my', 'your', 'our', 'their', 'how', 'where', 'when',
  'why', 'who', 'about', 'with', 'on', 'in', 'at', 'by', 'from', 'have', 'has', 'had', 'be',
  'been', 'being', 'not', 'no', 'yes', 'so', 'if', 'then', 'can', 'could', 'will', 'would',
  'should', 'may', 'might', 'must', 'really', 'very', 'just', 'only', 'also', 'too', 'there',
  'please', 'tell', 'like', 'want', 'think', 'know', 'mean', 'means', 'say', 'said', 'asked',
  // Temporal / deictic words must never be treated as the referent — "I saw
  // a new thing today" refers to the thing, not the day.
  'today', 'tomorrow', 'yesterday', 'tonight', 'now', 'always', 'often', 'sometimes', 'never', 'again', 'already', 'still', 'soon',
  // Grammatical vocabulary a referent can never be. The bench found the
  // gap: with "than" missing, "How many more push-ups … than David" left
  // "than" as the last content word of the turn, and the next question's
  // pronouns were rewritten to it — "her friend had 23 games" became "than
  // friend had 23 games", and the observer answered a sentence no reader
  // could parse (word-problems bench, 2026-09-09).
  'than', 'more', 'most', 'fewer', 'fewest', 'less', 'least', 'many', 'much', 'each', 'every', 'both', 'some', 'any', 'all', 'none',
  'other', 'others', 'another', 'same', 'different', 'total', 'altogether', 'left', 'over', 'under', 'into', 'onto', 'out', 'off',
  'up', 'down', 'after', 'before', 'while', 'because', 'during', 'between', 'among', 'them', 'these', 'those', 'this', 'that',
  'first', 'second', 'third', 'last', 'next', 'per', 'apiece', 'each'
]);

/**
 * Math notation is meaning, not punctuation: stripping it would erase the
 * whole technical curriculum ("2 + 3 = 5" would tokenize to nothing). Each
 * symbol becomes its own token; hyphens stay word-internal so compounds
 * like "well-known" survive.
 */
const MATH_SYMBOLS = /([+*/=<>^%√°])/g;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s\-+*/=<>^%√°]/g, ' ')
    .replace(MATH_SYMBOLS, ' $1 ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Public tokenizer (used for encounter tracking and bench scoring). */
export function tokenizeText(text: string): string[] {
  return tokens(text);
}

/** Cosine similarity between two amplitude distributions (a moment's
 *  resonance with a stored imprint). Shared by the observer (creative seed
 *  ranking) and the bench (type-probe clustering) so both measure the same
 *  math. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/**
 * Number words, whole or hyphenated ("twenty-three", "fifty"). A quantity is
 * never the unknown SUBJECT of an utterance, so the ask layer must not offer
 * to be taught one.
 */
const NUMBER_UNIT =
  '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)';
export const NUMBER_WORDS = new RegExp(`^${NUMBER_UNIT}(?:[-\\s]${NUMBER_UNIT})*$`);

/** Conservative plural stripping: "apples" -> "apple" (never "ss" or short words). */
export function singularize(word: string): string {
  return word.endsWith('s') && !word.endsWith('ss') && word.length > 3 ? word.slice(0, -1) : word;
}

/**
 * VERBS ARE NOT REFERENTS. "I saw a zebu" refers to the zebu, never to the
 * seeing — but a verb passes every test a noun does, so the resolver used
 * to rewrite "what about it?" into "what about saw?" whenever the noun was
 * unknown. The list is deliberately the common ones: a rare verb that slips
 * through costs one odd referent, while listing every verb would start
 * eating nouns ("a run", "a walk", "a drink").
 */
const COMMON_VERBS = new Set([
  'saw', 'see', 'sees', 'seen', 'got', 'get', 'gets', 'gotten', 'went', 'goes', 'gone', 'came', 'comes', 'made', 'makes', 'put', 'puts',
  'took', 'takes', 'taken', 'gave', 'gives', 'given', 'said', 'says', 'told', 'tells', 'thought', 'thinks', 'liked', 'likes', 'wanted',
  'wants', 'needed', 'needs', 'used', 'uses', 'ate', 'eats', 'eaten', 'drank', 'drinks', 'bought', 'buys', 'sold', 'sells', 'found',
  'finds', 'lost', 'loses', 'kept', 'keeps', 'left', 'leaves', 'knew', 'knows', 'known', 'felt', 'feels', 'looked', 'looks', 'seemed',
  'seems', 'became', 'becomes', 'brought', 'brings', 'sent', 'sends', 'walked', 'walks', 'ran', 'runs', 'played', 'plays', 'worked',
  'works', 'lived', 'lives', 'helped', 'helps', 'started', 'starts', 'stopped', 'stops', 'tried', 'tries', 'called', 'calls', 'moved',
  'moves', 'turned', 'turns', 'showed', 'shows', 'held', 'holds', 'wrote', 'writes', 'written', 'sat', 'sits', 'stood', 'stands',
  'won', 'wins', 'picked', 'picks', 'grew', 'grows', 'baked', 'bakes', 'collected', 'collects', 'counted', 'counts', 'weighed', 'weighs',
  'scored', 'scores', 'earned', 'earns', 'spent', 'spends', 'paid', 'pays', 'read', 'reads'
]);

/** A content word (not a pronoun/function word) — used to pick bench entities
 *  and to decide what is a resolvable referent. Numerals and bare symbols are
 *  never referents: "I saw 3 birds" refers to birds, not to 3. */
export function isContentWord(word: string): boolean {
  return word.length > 2 && /[a-z]/.test(word) && !PRONOUNS.has(word) && !FUNCTION_WORDS.has(word) && !COMMON_VERBS.has(word);
}

/**
 * The last entity mentioned in the window: the last content word of the most
 * recent USER turn (the human's words are the referent source — the
 * observer's own replies, especially its questions, must not hijack
 * resolution), singularized. When `isKnown` is given, words the observer
 * KNOWS are preferred over unknown ones — a referent is usually a thing it
 * has a word for ("this page is nice" -> "page", not "nice"). Falls back to
 * observer turns only when the human said nothing resolvable. Returns null
 * when nothing was said.
 */
export function lastEntity(window: readonly WorkingTurn[], isKnown?: (word: string) => boolean): string | null {
  for (const role of ['user', 'observer'] as const) {
    for (const turn of [...window].reverse()) {
      if (turn.role !== role) continue;
      const words = tokens(turn.text);
      const content = words.filter((word) => isContentWord(word)).map(singularize);
      if (content.length === 0) continue;
      if (isKnown !== undefined) {
        for (let i = content.length - 1; i >= 0; i -= 1) {
          if (isKnown(content[i])) return content[i];
        }
      }
      return content[content.length - 1];
    }
  }
  return null;
}

/**
 * Rewrite leading pronouns in the utterance to the last mentioned entity.
 * Returns the utterance unchanged when there is nothing to resolve — the
 * observer never guesses a referent.
 */
export function resolveReferences(utterance: string, window: readonly WorkingTurn[], isKnown?: (word: string) => boolean): string {
  const words = tokens(utterance);
  const firstPronoun = words.findIndex((word) => PRONOUNS.has(word));
  if (firstPronoun === -1) return utterance;
  const entity = lastEntity(window, isKnown);
  if (entity === null) return utterance;
  // NEVER REWRITE TO A WORD IT DOES NOT KNOW. Substituting an unrecognised
  // token for a pronoun does not resolve a reference, it corrupts the
  // sentence — and the observer then answers something the person never
  // asked. When the caller can say what the observer knows, an unknown
  // referent means: leave the utterance alone.
  if (isKnown !== undefined && !isKnown(entity)) return utterance;
  // AN EXPLETIVE "IT" REFERS TO NOTHING. "It is 78 miles to Grandma's
  // house" is not about a previous topic, and rewriting it produced "78
  // miles is 78 miles" — and then a wrong answer (word-problems bench,
  // 2026-09-09).
  if (/^\s*it\s+(?:is|was|will|would|takes|took|costs|cost)\b/i.test(utterance)) return utterance;
  // ONLY A PRONOUN WITH NOTHING BEFORE IT LACKS AN ANTECEDENT. "What about
  // it?" needs the previous turn; "A pet store had six kittens. If THEY got
  // another three" does not — the sentence names its own subject, and
  // reaching into memory rewrites the story into a different one. So the
  // substitution stops at the utterance's first content word.
  const firstContentWord = words.find((word) => isContentWord(word)) ?? null;
  const stopAt = firstContentWord === null ? utterance.length : utterance.toLowerCase().indexOf(firstContentWord);
  if (stopAt === 0) return utterance;
  // A POSSESSIVE IS NOT AN ANAPHOR EITHER. "her friend", "this page" and
  // "that book" already name their referent.
  const DETERMINER_USE = new Set(['its', 'his', 'her', 'their', 'this', 'that']);
  return utterance.replace(/\b(it|that|this|he|she|they|them|its|him|her)\b(\s+[a-z']+)?/gi, (match, pronoun: string, tail: string | undefined, offset: number) => {
    if (offset >= stopAt) return match;
    const follower = tail === undefined ? null : tail.trim().toLowerCase();
    if (follower !== null && DETERMINER_USE.has(pronoun.toLowerCase()) && isContentWord(follower)) return match;
    return `${entity}${tail ?? ''}`;
  });
}

/**
 * The likely subject of an unknown utterance — the last content word NOT in
 * the known vocabulary. Used by the observer when it ASKS about something it
 * does not know (the question names the unknown).
 */
export function extractUnknownSubject(text: string, known: ReadonlySet<string>): string | null {
  const words = tokens(text);
  for (const word of [...words].reverse()) {
    if (word.length <= 2 || FUNCTION_WORDS.has(word) || COMMON_VERBS.has(word) || known.has(word)) continue;
    // A NUMBER IS NOT A WORD IT COULD BE TAUGHT. "I do not know what
    // \"twenty-three\" means. Could you teach me?" was a real reply from the
    // word-problems corpus: the ask layer read the numeral as the utterance's
    // unknown referent. Digits and number words are quantities — whatever the
    // observer cannot do with them, the fix is never vocabulary.
    if (!/[a-z]/.test(word) || NUMBER_WORDS.test(word)) continue;
    return word;
  }
  return null;
}