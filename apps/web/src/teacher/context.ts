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
 *  context must not persist across restarts). */
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
  'today', 'tomorrow', 'yesterday', 'tonight', 'now', 'always', 'often', 'sometimes', 'never', 'again', 'already', 'still', 'soon'
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

/** Conservative plural stripping: "apples" -> "apple" (never "ss" or short words). */
export function singularize(word: string): string {
  return word.endsWith('s') && !word.endsWith('ss') && word.length > 3 ? word.slice(0, -1) : word;
}

/** A content word (not a pronoun/function word) — used to pick bench entities
 *  and to decide what is a resolvable referent. Numerals and bare symbols are
 *  never referents: "I saw 3 birds" refers to birds, not to 3. */
export function isContentWord(word: string): boolean {
  return word.length > 2 && /[a-z]/.test(word) && !PRONOUNS.has(word) && !FUNCTION_WORDS.has(word);
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
  if (!words.some((word) => PRONOUNS.has(word))) return utterance;
  const entity = lastEntity(window, isKnown);
  if (entity === null) return utterance;
  return utterance.replace(/\b(it|that|this|he|she|they|them|its|him|her)\b/gi, entity);
}

/**
 * The likely subject of an unknown utterance — the last content word NOT in
 * the known vocabulary. Used by the observer when it ASKS about something it
 * does not know (the question names the unknown).
 */
export function extractUnknownSubject(text: string, known: ReadonlySet<string>): string | null {
  const words = tokens(text);
  for (const word of [...words].reverse()) {
    if (word.length > 2 && !FUNCTION_WORDS.has(word) && !known.has(word)) {
      return word;
    }
  }
  return null;
}