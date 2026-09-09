/**
 * THE STORY-STATE ENGINE (docs/TASKS.md #64) — word problems as a story
 * about quantities, compiled to rewrite terms.
 *
 * A word problem is read as a small STATE. Every number in the body becomes
 * a quantity with the noun it counts ("17 apples"), the premodifiers that
 * distinguish it ("5 RED peaches"), an owner ("Jason had…"), the clause it
 * came from, and a role:
 *
 *   add     something counted or gained ("had 23 crackers", "did 51
 *           push-ups", "got 6 more", "his mom gave him 34")
 *   loss    something given up ("ate 8", "3 ducks flew away", "sold 3")
 *   end     a later state or a stated whole ("now has 16", "had 8 left",
 *           "a total of 81 points", "together they weighed 37")
 *   per     an equal-groups rate ("17 apples in each basket", "6 shirts a
 *           minute"), carrying the group it is per ("basket", "minute")
 *   groups  the number of groups a rate applies to ("each of the 78 blocks")
 *
 * The question is read the same way — not by position but by matching its
 * words against the story: a word that names a quantity's noun is a noun
 * qualifier, one that names a premodifier or a time word is a tag, one that
 * names an owner is an owner qualifier. Its kind is one of:
 *
 *   total      "how many in all / altogether / does she have"
 *   residual   "how many are left / remain / still"
 *   start      "how many to start with / initially / before"
 *   change     "how many did she give / spend / cut" (against a stated end)
 *   difference "how many more … than", "how much longer", "the difference"
 *   share      "how many in each …" (a whole split into groups)
 *
 * THE CONTRACT IS THE OBSERVER'S — soundness, not coverage. Two rules make
 * it hold, and both are the reason this file declines far more often than
 * it answers:
 *
 *   1. EVERY QUANTITY IS ACCOUNTED FOR. A quantity is either used in the
 *      derivation or excluded because the question named a different noun,
 *      owner or tag. A number nobody can place means the reading is
 *      incomplete — decline.
 *   2. THE SELECTION IS UNAMBIGUOUS. Where a shape needs one quantity per
 *      side (a difference, a rate's group count) and two candidates fit,
 *      decline rather than pick.
 *
 * The arithmetic must also close in the naturals: no negative intermediate,
 * only exact division. The value is computed here to apply those guards;
 * the ANSWER is derived by the rewrite engine from the term, with its
 * trace, like every other arithmetic answer this observer gives.
 *
 * What it does not read at all (declined, never guessed): stated
 * comparisons in the body ("Tara had $4 more than Megan"), ratios,
 * periods, fractions and decimals, means and patterns, unit conversions,
 * times of day, ages with "ago", sums across kinds that need world
 * knowledge ("how many legs", "how many fowls" — TASKS #65), and any
 * clause whose verb points both ways at once ("cut 8 more roses from her
 * garden and put them in the vase" — a loss verb doing an addition's work).
 */
import { digitsFromDecimal } from './digits';
import { natFromDecimal } from './peano';
import { tSym, type Term } from './terms';

export type QuantityRole = 'add' | 'loss' | 'end' | 'per' | 'groups';
export type QuestionKind = 'total' | 'residual' | 'start' | 'change' | 'difference' | 'share';

/**
 * WHERE A DISTINGUISHING WORD SITS. A question can rule a quantity out only
 * by CONTRAST — naming a word in one slot while the ruled-out quantity has
 * a different word in the SAME slot ("pages of MATH homework" vs "pages of
 * READING homework"). A word the question happens to share with one clause
 * and no other ("had to COMPLETE 5 pages") is not a contrast and rules
 * nothing out; that distinction is what keeps the selection honest.
 *
 *   mod   between the number and its noun — "5 RED peaches"
 *   tail  right after the noun — "5 pages of MATH homework", "13 campers went ROWING"
 *   pre   before the number in the same clause — "played TAG with 7 kids"
 *   time  a day or part of a day anywhere in the clause
 */
export interface TagSlots {
  mod: string[];
  tail: string[];
  pre: string[];
  time: string[];
  /** The clause called this quantity the OTHER ones ("20 species of other
   *  insects") — a category defined by what it is not. */
  residualClass?: boolean;
}


export const TAG_SLOTS: readonly ('mod' | 'tail' | 'pre' | 'time')[] = ['mod', 'tail', 'pre', 'time'];

export interface StoryQuantity {
  value: number;
  /** Singular noun the quantity counts (null when it stands alone: "2 more"). */
  noun: string | null;
  /** Words between the number and its noun ("red" in "5 red peaches"). */
  premodifiers: string[];
  /** The per-group noun for a `per` quantity ("basket" in "17 apples in each basket"). */
  groupNoun: string | null;
  owner: string | null;
  role: QuantityRole;
  /** Every distinguishing word, for reporting. */
  tags: string[];
  /** The same words by slot — the contrast test reads these. */
  slots: TagSlots;
  clause: number;
  sentence: number;
  /** True when the clause used a possession verb (had/has/there were). */
  possession: boolean;
  /** The possessor a take-away took FROM ("picked 7 apples from her TREE") —
   *  the other party to the event, whose perspective flips the sign. */
  fromParty: string | null;
}

export interface StoryQuestion {
  kind: QuestionKind;
  /** Content words of the question that name nothing in the story — the
   *  signature of a part the story leaves out ("how many BRONZE medals"). */
  unmatched: string[];
  /** The thing the question asks for — the noun right after "how many"
   *  ("how many BIRD LEGS" → legs). Null for "how many did he have left"
   *  and for measures ("how long is his hair"). */
  stemNoun: string | null;
  /** Nouns of body quantities the question names (singular). */
  nouns: string[];
  owners: string[];
  /** Premodifiers and time words the question names. */
  tags: string[];
  /** The noun after "each"/"every" in a share question ("game" in "in each game"). */
  eachNoun: string | null;
  text: string;
}

export interface StoryReading {
  term: Term;
  /** Which rule deck the term is written in. */
  deck: 'digits' | 'peano';
  value: number;
  /** The derivation shape, for the bench and the trace. */
  shape: string;
  quantities: StoryQuantity[];
  question: StoryQuestion;
}

/** Operand ceiling: the answer is derived in unary Peano, so a term over a
 *  few thousand successors would exhaust the engine's fuel and become an
 *  honest but wasted ASK. Multi-digit arithmetic needs the digits deck to
 *  be reachable from the decoder first (TASKS #69). */
const MAX_OPERAND = 2000;

// ---------------------------------------------------------------------------
// Lexicon
// ---------------------------------------------------------------------------

const ONES: Record<string, number> = {
  zero: 0, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** Words a number never counts; a noun run stops at them. */
const RUN_STOP = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'with', 'by', 'into', 'onto', 'per', 'each', 'every', 'and', 'or', 'but',
  'that', 'which', 'who', 'than', 'then', 'now', 'so', 'if', 'when', 'while', 'after', 'before', 'during', 'as', 'about', 'over', 'out',
  'away', 'off', 'left', 'remaining', 'more', 'fewer', 'less', 'other', 'others', 'extra', 'additional', 'total', 'altogether', 'together',
  'apiece', 'later', 'ago', 'yesterday', 'today', 'tomorrow', 'last', 'this', 'these', 'those', 'there', 'here',
  'long', 'wide', 'tall', 'high', 'deep', 'heavy', 'far', 'apart', 'like', 'such', 'similar', 'same',
  'were', 'was', 'are', 'is', 'has', 'had', 'have', 'did', 'does', 'do', 'can', 'could', 'will', 'would', 'should', 'get', 'gets', 'got',
  'his', 'her', 'their', 'its', 'my', 'your', 'our', 'he', 'she', 'they', 'it', 'him', 'them', 'i', 'we', 'you', 'all', 'some', 'both',
  'already', 'only', 'just', 'still', 'also', 'too', 'very', 'much', 'many', 'how', 'what', 'not', 'no', 'up', 'down', 'been', 'being',
  'while', 'because', 'since', 'until', 'between', 'among', 'across', 'through'
]);

/** Prepositions that place the whole scene rather than describe a quantity.
 *  "10 roses IN THE VASE" and "5 birds ON THE FENCE" distinguish nothing. */
const LOCATIVE = new Set(['in', 'on', 'at', 'from', 'to', 'into', 'inside', 'near', 'by', 'with', 'for', 'under', 'over', 'around', 'behind', 'between', 'among', 'outside', 'beside', 'through', 'across', 'onto']);

/** Time, order and place words a question can use to pick a quantity out. */
const TIME_TAGS = new Set([
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'last', 'next', 'previous', 'morning', 'afternoon', 'evening', 'night',
  'yesterday', 'today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'weekend',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december'
]);

const LOSS_VERBS =
  /\b(gave away|gives away|give away|ate|eats|eat|eaten|lost|loses|lose|sold|sells|sell|spent|spends|spend|used|uses|use|took|takes|take|taken|removed|removes|remove|paid|pays|pay|dropped|drops|drop|broke|breaks|break|threw|throws|throw|donated|donates|donate|deleted|deletes|delete|flew away|leaked|died|dies|die|melted|withered|burned|burnt|popped|lent|lends|lend|drank|drinks|drink|wasted|destroyed|blew away|snapped|stole|stolen|consumed|defeated|escaped|ran away|gave|gives|give|handed|hands|sent|sends|shared with|distributed|giving|selling|eating|losing|spending|using|taking|donating|deleting|removing|drinking|paying|breaking|throwing|dropping|leaking|dying|melting|burning|popping|lending|wasting|destroying|consuming|picked \d+|picks \d+|pick \d+|cut off|cuts off|chopped off|trimmed|picking|got off|gets off|get off|stepped off|jumped off|flew off|walked off|checked out|shipped away|sent away|taken away|given away|moved away|flew away|swam away|driven away|thrown away|carried away|died|dies|die|are broken|is broken|were broken|was broken|broken|cut down|were cut|was cut|are cut|damaged|withered|returned|returns|return|gave back|gives back|sent back|took back|got rid of|gets rid of|get rid of|rid of|handed back|put back|threw out|thrown out)\b/;

/** Letting something go is a take-away: "he let 11 go", "released 4". */
const RELEASED = /\blet\s+[a-z0-9-]+\s+go\b|\breleased\b|\bset\s+[a-z0-9-]+\s+free\b|\bfreed\b/;

/** Taking something OFF a measured whole is a take-away whatever the verb:
 *  "cut 13 inches off", "sharpens two inches off". */
const TAKEN_OFF = /\b(?:cut|cuts|chop|chops|chopped|sharpen|sharpens|sharpened|trim|trims|trimmed|shave|shaves|shaved|snap|snaps|snapped|tear|tears|tore|took|take|takes|broke|break|breaks)\b[^.?!]*\boff\b/;

/** Additive markers: a clause carrying one is not a take-away even if a
 *  loss verb appears in it ("cut 8 MORE roses … and PUT them in the vase"). */
const ADDITIVE_MARKERS = /\b(more|another|additional|extra|joined|added|adds|add|put them|puts them|received|receives|receive|collected|collects|earned|earns|earn|found|finds|find|bought|buys|buy|grew|grows|grow|baked|bakes|bake|made|makes|make|brought|brings|bring|won|wins|win|gathered|gathers|saved|saves)\b/;

const POSSESSION_VERBS = /\b(had|has|have|there (?:are|were|is|was)|are|were|is|was|owns|owned|holds|held|contains|contained|keeps|kept|weighs|weighed|costs|cost|measures|measured|includes|included|seats|seat)\b/;

const END_CUES = /\b(now|then|after|afterwards|later|in the end|at the end|finally|ended up with|when (?:he|she|they) left|leaving|leaves|currently|by the end|at present)\b/;
const WHOLE_CUES = /\b(total|in total|in all|altogether|all together|together|combined|between them|overall|across \d+)\b/;
const LEFT_CUES = /\b(left|remaining|remain|remains|still)\b/;
const RATE_CUES = /\b(each|every|per|apiece)\b/;
/** An unstated quantity in the story: only a change/start question can be
 *  answered when the story itself hides a number. */
const UNKNOWN_CUES = /\b(some|several|a few|a number of|the rest|the remaining|others|other \w+ suggested|an unknown)\b/;

/** A comparison STATED IN THE BODY ("Tara had $4 more than Megan") is a
 *  relation between quantities, not a quantity — and this engine reads only
 *  quantities. In the QUESTION the same words are the comparison it is
 *  being asked for, which it reads as a difference, so this test must never
 *  run against the question. */
const STATED_COMPARISON = /\b(more|fewer|less|longer|shorter|taller|heavier|younger|older|farther|further|bigger|smaller|larger|faster|slower|higher|lower|wider|deeper)\b[^.?!]*\bthan\b/;

/** Arithmetic outside the engine's story shapes, wherever it appears. */
const UNREADABLE =
  /\btwice\b|\bthrice\b|\bhalf\b|\bdoubles?\b|\bdoubled\b|\btriples?\b|\btripled\b|\bhalves\b|\bhalved\b|\bthird of\b|\bquarter\b|\bratio\b|\b\d+\s*:\s*\d+|\d\.\d|\d\s*\/\s*\d|\b\d+\s*%|\bpercent\b|\baverage\b|\bmean\b|\bpattern\b|\bcontinues\b|\bago\b|\b(?:a\.m\.|p\.m\.)|\bdozen\b|\bpairs? of\b|\bequal(?:ly)?\b|\bsame (?:amount|number|as)\b|\bevery \d|\beach \d|\bfor every\b|\bper \d|\bas many\b|\bas much\b|\bas old\b|\btimes as\b|\btimes\b|\bcombined with\b|\bsplit\b|\bdivide|\bshared? equally\b|\bgroups of\b|\bin groups\b/;

const QUESTION_STEM = /\bhow (?:many|much|far|long|old|heavy|tall)\b/;

const PRONOUNS = new Set(['he', 'she', 'they', 'it', 'his', 'her', 'their', 'him', 'them', 'i', 'we', 'you', 'my', 'our', 'your', 'himself', 'herself', 'themselves']);

/** Capitalised words that are not names. */
const NAME_STOP = new Set([
  'there', 'the', 'a', 'an', 'if', 'after', 'then', 'now', 'in', 'on', 'at', 'for', 'how', 'when', 'while', 'during', 'last', 'this', 'that',
  'these', 'those', 'each', 'every', 'mrs', 'mr', 'ms', 'dr', 'miss', 'since', 'before', 'first', 'next', 'so', 'but', 'and', 'of', 'with',
  'some', 'all', 'both', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'what', 'which', 'who', 'where',
  'why', 'find', 'about', 'to', 'from', 'by', 'as', 'later', 'today', 'yesterday', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday',
  'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'including', 'together', 'altogether', 'also', 'once', 'twice', 'finally', 'meanwhile', 'however', 'because',
  'although', 'though', 'out', 'over', 'up', 'down', 'not', 'no', 'yes', 'here', 'thereafter', 'afterwards', 'because', 'stray', 'summer',
  'winter', 'spring', 'autumn', 'fall', 'it', 'he', 'she', 'they', 'i', 'we', 'you', 'his', 'her', 'their', 'them', 'him'
]);

const MONEY_NOUNS = new Set(['dollar', 'cent', 'buck', 'penny', 'euro', 'money']);

const IRREGULAR: Record<string, string> = {
  shelves: 'shelf', leaves: 'leaf', wolves: 'wolf', knives: 'knife', lives: 'life', halves: 'half', loaves: 'loaf',
  people: 'person', children: 'child', men: 'man', women: 'woman', feet: 'foot', teeth: 'tooth', geese: 'goose',
  mice: 'mouse', pennies: 'penny', candies: 'candy'
};

const singular = (word: string): string => {
  if (word in IRREGULAR) return IRREGULAR[word];
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ches') || word.endsWith('shes') || word.endsWith('xes') || word.endsWith('sses')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && word.length > 3) return word.slice(0, -1);
  return word;
};

const sameNoun = (a: string | null, b: string | null): boolean => {
  if (a === null || b === null) return false;
  if (a === b) return true;
  return MONEY_NOUNS.has(a) && MONEY_NOUNS.has(b);
};

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Number words → digits ("two hundred sixty-six" → 266, "fifty-nine" → 59).
 *  "one" stays a word — it is a pronoun as often as a number. */
export function digitsForNumberWords(text: string): string {
  const words = text.split(/(\s+|[^\w'-]+)/);
  const out: string[] = [];
  // "one" is a pronoun as often as a number ("one of her trees"), so it
  // counts only inside a compound ("forty-one") or as "one more".
  const isNumberWord = (w: string): boolean => w in ONES || w in TENS || w === 'hundred' || w === 'thousand';
  const compound = (token: string): boolean => token.includes('-') && token.split('-').every((part) => isNumberWord(part) || part === 'one');
  let i = 0;
  while (i < words.length) {
    const lower = words[i].toLowerCase();
    const oneMore = lower === 'one' && /^\s*more\b/.test(words.slice(i + 1).join(''));
    if (lower !== '' && (lower.split('-').every(isNumberWord) || compound(lower) || oneMore)) {
      let value = 0;
      let current = 0;
      let j = i;
      let consumed = false;
      const feed = (w: string): boolean => {
        if (w === 'one') { current += 1; return true; }
        if (w in ONES) { current += ONES[w]; return true; }
        if (w in TENS) { current += TENS[w]; return true; }
        if (w === 'hundred') { if (current === 0) return false; current *= 100; return true; }
        if (w === 'thousand') { if (current === 0) return false; value += current * 1000; current = 0; return true; }
        return false;
      };
      // `lastNumberEnd` is where the run's last NUMBER word ended: the
      // separators after it must be re-emitted, or "eleven go" becomes
      // "11go" and the story loses both the verb and the quantity's noun.
      let lastNumberEnd = i;
      while (j < words.length) {
        const w = words[j].toLowerCase();
        if (/^\s+$/.test(w) || w === '') { j += 1; continue; }
        const parts = w.split('-');
        if (!parts.every((part) => isNumberWord(part) || (part === 'one' && (w.includes('-') || j === i)))) break;
        if (!parts.every(feed)) break;
        consumed = true;
        j += 1;
        lastNumberEnd = j;
      }
      if (consumed) {
        out.push(String(value + current));
        i = lastNumberEnd;
        continue;
      }
    }
    out.push(words[i]);
    i += 1;
  }
  return out.join('');
}

function normalise(text: string): string {
  let t = digitsForNumberWords(text);
  t = t.replace(/(\d),(\d{3})\b/g, '$1$2');
  t = t.replace(/\$\s*(\d+(?:\.\d+)?)/g, '$1 dollars');
  t = t.replace(/\b(\d+)\s*(?:st|nd|rd|th)\b/g, 'ORDINAL');
  return t.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Reading the body
// ---------------------------------------------------------------------------

interface Clause {
  text: string;
  lower: string;
  sentence: number;
  /** The whole sentence, lowercased — cues like "now" belong to it. */
  sentenceLower: string;
}

function clausesOf(body: string): Clause[] {
  const sentences = body.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
  const clauses: Clause[] = [];
  sentences.forEach((sentence, index) => {
    const sentenceLower = sentence.toLowerCase();
    // Split on a conjunction only when both sides carry a number — then each
    // side can have its own owner and verb ("Zachary did 51 … and David did 44").
    const parts = sentence.split(/,\s*(?:and\s+)?|\s+(?:and|but|while|whereas)\s+|;\s+/).map((part) => part.trim()).filter((part) => part.length > 0);
    if (parts.length > 1 && parts.every((p) => /\d/.test(p))) {
      for (const part of parts) clauses.push({ text: part, lower: part.toLowerCase(), sentence: index, sentenceLower });
    } else {
      clauses.push({ text: sentence, lower: sentenceLower, sentence: index, sentenceLower });
    }
  });
  return clauses;
}

/** "Allan and Jake brought 3 balloons": the quantity belongs to two people
 *  at once — a part-of-a-whole shape this engine does not model. */
function sharedOwners(clause: string): boolean {
  const names = clause
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => /^[A-Z][a-z]+$/.test(w.replace(/'s$/, '')) && !NAME_STOP.has(w.replace(/'s$/, '').toLowerCase()));
  return new Set(names.map((n) => n.toLowerCase())).size > 1;
}

function ownerOf(clause: string, lastOwner: string | null, sentenceOwner: string | null): string | null {
  const words = clause.replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter((w) => w.length > 0);
  for (const word of words) {
    const raw = word.replace(/'s$/, '');
    const lower = raw.toLowerCase();
    if (PRONOUNS.has(lower)) return lastOwner;
    if (/^[A-Z][a-z]+$/.test(raw) && !NAME_STOP.has(lower)) return lower;
  }
  return sentenceOwner;
}

/** Tokens of a clause tail, with digits and punctuation as hard stops. */
function tailWords(lower: string, after: number): string[] {
  const tail = lower.slice(after);
  const words: string[] = [];
  for (const token of tail.split(/\s+/)) {
    if (token === '') continue;
    // Punctuation ends the run: "5 red peaches, 14 yellow" must not read on.
    const cleaned = token.replace(/^[^a-z0-9'-]+/, '');
    const word = cleaned.match(/^[a-z'-]+/)?.[0] ?? '';
    if (word === '') break;
    words.push(word);
    if (/[.;:!?]$/.test(token)) break;
    if (words.length === 4) break;
  }
  return words;
}

interface Mention {
  value: number;
  noun: string | null;
  premodifiers: string[];
  index: number;
  end: number;
  slots: TagSlots;
}

/** Irregular verbs a noun run must stop at — a participle test misses them
 *  ("13 campers WENT rowing" counts campers, not "went"). */
const VERB_STOP = new Set([
  'went', 'goes', 'go', 'came', 'come', 'ran', 'run', 'runs', 'ate', 'eat', 'eats', 'gave', 'give', 'gives', 'took', 'take', 'takes',
  'made', 'make', 'makes', 'got', 'get', 'gets', 'saw', 'see', 'sees', 'sat', 'sit', 'sits', 'put', 'puts', 'read', 'reads', 'sold',
  'sell', 'sells', 'lost', 'lose', 'loses', 'won', 'win', 'wins', 'left', 'leave', 'leaves', 'fell', 'fall', 'falls', 'flew', 'fly',
  'grew', 'grow', 'grows', 'threw', 'throw', 'brought', 'bring', 'bought', 'buy', 'buys', 'paid', 'pay', 'pays', 'spent', 'spend',
  'drank', 'drink', 'broke', 'break', 'cut', 'cost', 'kept', 'keep', 'held', 'hold', 'holds', 'needs', 'need', 'wants', 'want'
]);

/** A participle is a verb, never the thing counted: "87 bird families
 *  LIVING near a mountain" counts families. */
const PARTICIPLE = /(?:ing|ed)$/;
const NOT_PARTICIPLE = /^(bed|shed|sled|seed|weed|red|thing|things|ring|king|wing|string|swing|building|buildings|ceiling|morning|evening|hundred|shield|field|fields|bird|birds|kid|kids|salad|thread|bread|friend|friends|second|seconds|pound|pounds|round|hand|hands|band|sand|end|ends|wedding|weddings|pudding|sibling|siblings|dumpling|dumplings|earring|earrings|painting|paintings|drawing|drawings|reading|readings|serving|servings|topping|toppings|clothing|offspring)$/;
/** Anaphors: "150 new ONES" counts something the number does not name, so
 *  the quantity has no noun — and a quantity with no noun can never be
 *  ruled out by the question. */
const ANAPHOR = /^(one|ones|other|others|more)$/;

/** Content words of a fragment, in order: no stop words, verbs, numbers —
 *  and no NAMES. Who did something is tracked as the owner; a name in a
 *  slot would make "ROBIN cut off 13 inches" look like a contrast against
 *  "his HAIR was 14 inches", and rule the first quantity out. */
function contentWords(fragment: string, limit: number, names: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const word of fragment.split(/[^a-z'-]+/)) {
    const raw = word.replace(/'s$/, '').replace(/'$/, '');
    if (LOCATIVE.has(raw)) break;
    if (raw.length < 3 || names.has(raw)) continue;
    if (RUN_STOP.has(raw) || VERB_STOP.has(raw)) continue;
    if (POSSESSION_VERBS.test(raw) || LOSS_VERBS.test(raw) || ADDITIVE_MARKERS.test(raw)) continue;
    if (LOCATIVE.has(raw)) break; // the rest of the phrase is a place, not a kind
    if (raw.endsWith('ly') && raw.length > 4) continue;
    if (PARTICIPLE.test(raw) && !NOT_PARTICIPLE.test(raw) && !/^(rowing|hiking|swimming|running|walking|jogging|reading|writing|drawing|painting|baking|cooking|skating|biking|climbing|fishing|camping|bowling|dancing|singing|shopping)$/.test(raw)) continue;
    out.push(singular(raw));
    if (out.length === limit) break;
  }
  return out;
}

function mentionsOf(clause: Clause, names: ReadonlySet<string>): Mention[] | null {
  const mentions: Mention[] = [];
  let previousEnd = 0;
  for (const hit of clause.lower.matchAll(/\d+(?:\.\d+)?/g)) {
    if (hit[0].includes('.')) return null;
    const index = hit.index ?? 0;
    const end = index + hit[0].length;
    const words = tailWords(clause.lower, end);
    const run: string[] = [];
    // The cursor tracks the real text position, so the tail below starts
    // exactly where the run stopped (skipped and dropped words included).
    let cursor = end;
    for (const word of words) {
      const at = clause.lower.indexOf(word, cursor);
      // "4 MORE birds" counts birds: a continuation word is skipped, not a stop.
      if (/^(more|other|additional|extra)$/.test(word) && run.length === 0) {
        cursor = at + word.length;
        continue;
      }
      if (RUN_STOP.has(word) || VERB_STOP.has(word) || LOCATIVE.has(word) || (word.endsWith('ly') && word.length > 4)) break;
      run.push(word);
      cursor = at + word.length;
      if (run.length === 4) break;
    }
    // Drop trailing participles ("bird families living" → bird families).
    while (run.length > 1 && PARTICIPLE.test(run[run.length - 1]) && !NOT_PARTICIPLE.test(run[run.length - 1])) run.pop();
    let noun = run.length === 0 ? null : singular(run[run.length - 1]);
    if (noun !== null && (ANAPHOR.test(noun) || (PARTICIPLE.test(noun) && !NOT_PARTICIPLE.test(noun)))) noun = null;
    // The tail says WHAT KIND, and only two joiners give a kind: "of"
    // ("5 pages OF math homework") and bare adjacency ("13 campers went
    // ROWING"). A locative — "10 roses IN THE VASE", "5 birds ON THE
    // FENCE" — says where the whole story happens, so it distinguishes
    // nothing and must not rule any quantity out.
    const afterRun = clause.lower.slice(cursor, cursor + 40);
    const locative = /^\s*(?:in|on|at|from|to|into|inside|near|by|with|for|under|over|around|behind|between|among)\b/.test(afterRun);
    const tailFragment = locative ? '' : afterRun;
    const preFragment = clause.lower.slice(previousEnd, index);
    const slots: TagSlots = {
      mod: run.slice(0, -1).map(singular),
      tail: contentWords(tailFragment, 3, names),
      pre: contentWords(preFragment, 3, names),
      time: [...new Set(clause.lower.split(/[^a-z-]+/).filter((w) => TIME_TAGS.has(w)))],
      // "20 species of OTHER insects": a residual category the engine cannot
      // relate to the ones beside it.
      residualClass: /\b(other|others|remaining|rest)\b/.test(clause.lower)
    };
    previousEnd = end;
    mentions.push({ value: Number(hit[0]), noun, premodifiers: run.slice(0, -1), index, end, slots });
  }
  return mentions;
}

function groupNounOf(lower: string): string | null {
  const hit = lower.match(/\b(?:each|every|per)\s+(?:of\s+(?:the\s+)?)?(?:\d+\s+)?([a-z]+)(?:\s+([a-z]+))?/);
  if (hit === null) {
    const rate = lower.match(/\d+\s+[a-z-]+\s+(?:a|an)\s+(minute|hour|day|week|month|year|second|game|trip|lap|page|box|bag|row)\b/);
    return rate === null ? null : singular(rate[1]);
  }
  const first = hit[1];
  const second = hit[2];
  if (RUN_STOP.has(first)) return null;
  const ADJECTIVE = /^(small|large|big|little|red|blue|green|white|black|school|new|old|first|second|third|other|tiny|wooden|plastic|metal|paper|glass|full|empty)$/;
  if (second !== undefined && ADJECTIVE.test(first) && !RUN_STOP.has(second)) return singular(second);
  if (/(?:ed|ing)$/.test(first) && !/^(bed|shed|sled|seed|weed|red|thing|ring|king|wing|string|swing|building|ceiling|morning|evening)$/.test(first)) return null;
  return singular(first);
}

function readBody(body: string): { quantities: StoryQuantity[]; unknowns: number } | null {
  const clauses = clausesOf(body);
  const names = new Set(
    body
      .replace(/[^\w\s'-]/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/'s$/, ''))
      .filter((w) => /^[A-Z][a-z]+$/.test(w) && !NAME_STOP.has(w.toLowerCase()))
      .map((w) => w.toLowerCase())
  );
  const quantities: StoryQuantity[] = [];
  let lastOwner: string | null = null;
  let sentenceOwner: string | null = null;
  let lastSentence = -1;
  let unknowns = 0;
  let inheritedLoss = false;
  let inheritedAdditive = false;
  let inheritedRate = false;
  let inheritedGroupNoun: string | null = null;
  for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
    const clause = clauses[clauseIndex];
    if (clause.sentence !== lastSentence) {
      sentenceOwner = null;
      lastSentence = clause.sentence;
    }
    const previousOwner: string | null = lastOwner;
    let owner: string | null = ownerOf(clause.text, lastOwner, sentenceOwner);
    if (owner !== null) {
      lastOwner = owner;
      sentenceOwner = owner;
    }
    if (UNKNOWN_CUES.test(clause.lower)) unknowns += 1;
    if (/\d/.test(clause.text) && sharedOwners(clause.text)) return null;
    const mentions = mentionsOf(clause, names);
    if (mentions === null) return null; // a decimal: not this engine's domain
    if (mentions.length === 0) continue;

    let lossVerb = LOSS_VERBS.test(clause.lower) || TAKEN_OFF.test(clause.lower) || RELEASED.test(clause.lower) || /\b\d+\s+[a-z]+s?\s+(?:left|departed|went home|walked out|drove off)\b/.test(clause.lower);
    let additive = ADDITIVE_MARKERS.test(clause.lower);
    // A clause with no verb of its own continues the previous one: "uses 14
    // blocks to build a tower AND 11 blocks to build a house" — both are
    // uses. Inheritance stops at a sentence boundary.
    if (!lossVerb && !additive && !POSSESSION_VERBS.test(clause.lower) && clauseIndex > 0 && clauses[clauseIndex - 1].sentence === clause.sentence) {
      lossVerb = inheritedLoss;
      additive = inheritedAdditive;
    }
    inheritedLoss = lossVerb;
    inheritedAdditive = additive;
    // A clause pointing both ways ("cut 8 MORE roses … and put them in the
    // vase") cannot be read as either — decline the whole story.
    if (lossVerb && additive) return null;
    let rate = RATE_CUES.test(clause.lower) || /\d+\s+[a-z-]+\s+(?:a|an)\s+(?:minute|hour|day|week|month|year|second)\b/.test(clause.lower);
    let groupNoun = rate ? groupNounOf(clause.lower) : null;
    // "Each basket has 10 red peaches and 2 green peaches": the second half
    // of the sentence is per-basket too.
    if (!rate && inheritedRate && clauseIndex > 0 && clauses[clauseIndex - 1].sentence === clause.sentence && !POSSESSION_VERBS.test(clause.lower)) {
      rate = true;
      groupNoun = inheritedGroupNoun;
    }
    inheritedRate = rate;
    inheritedGroupNoun = groupNoun;
    const possession = POSSESSION_VERBS.test(clause.lower) && !lossVerb && !/\b(?:had|has|have|needed|need|wanted|want)\s+to\b/.test(clause.lower);
    // "now"/"then" belong to the sentence, not the clause half.
    const endCue = END_CUES.test(clause.sentenceLower) || WHOLE_CUES.test(clause.lower);
    const isEnd =
      (endCue && POSSESSION_VERBS.test(clause.lower)) ||
      (LEFT_CUES.test(clause.lower) && /\b(had|has|have|there (?:are|were|is|was)|are|were|is|was)\b/.test(clause.lower)) ||
      /\b(?:leaving|leaves)\s+\d/.test(clause.lower) ||
      WHOLE_CUES.test(clause.lower);
    // "Jack GAVE HIM 20 marbles": the quantity ends up with the receiver, so
    // the clause's named giver is not its owner — the story's subject is.
    const receives = /\b(?:gave|gives|give|handed|hands|sent|sends|brought|brings|lent)\s+(?:him|her|them|me|us)\s+\d/.test(clause.lower);
    const receivedBy: string | null = receives ? previousOwner : null;
    const loss = !receives && lossVerb && !isEnd;

    if (receivedBy !== null) {
      owner = receivedBy;
      lastOwner = receivedBy;
      sentenceOwner = receivedBy;
    }
    for (const mention of mentions) {
      let role: QuantityRole = 'add';
      let thisGroupNoun: string | null = null;
      const partitive = clause.lower.slice(mention.end, mention.end + 24).match(/^\s*of (?:her|his|the|their|these|those|them)\b\s*([a-z]+)?/);
      if (partitive !== null && mention.noun === null) {
        // The number counts members of a group the story names elsewhere;
        // reading it as a quantity of the story's kind would double-count.
        quantities.push({
          value: mention.value,
          noun: partitive[1] === undefined ? null : singular(partitive[1]),
          premodifiers: [],
          groupNoun: null,
          owner,
          role: 'groups',
          tags: [],
          slots: { mod: [], tail: [], pre: [], time: [] },
          clause: clauseIndex,
          sentence: clause.sentence,
          possession: false,
          fromParty: null
        });
        continue;
      }
      if (rate) {
        const before = clause.lower.slice(Math.max(0, mention.index - 20), mention.index);
        if (/\b(?:each|every)\s+(?:of\s+)?(?:the\s+|his\s+|her\s+|their\s+)?$/.test(before)) role = 'groups';
        else {
          role = 'per';
          thisGroupNoun = groupNoun;
        }
      } else if (isEnd) role = 'end';
      else if (loss) role = 'loss';
      quantities.push({
        value: mention.value,
        noun: mention.noun,
        premodifiers: mention.premodifiers,
        groupNoun: thisGroupNoun,
        owner,
        role,
        tags: [...new Set([...mention.slots.mod, ...mention.slots.tail, ...mention.slots.pre, ...mention.slots.time])],
        slots: mention.slots,
        clause: clauseIndex,
        sentence: clause.sentence,
        possession,
        fromParty: loss ? (clause.lower.match(/\bfrom (?:her|his|their|the|its)\s+([a-z]+)/)?.[1] ?? null) : null
      });
    }
  }
  // "played TAG with 7 kids on monday and 13 kids on tuesday": the second
  // half of the sentence is still about tag. A pre slot that says nothing
  // continues the previous clause's, within the sentence only.
  for (let i = 1; i < quantities.length; i += 1) {
    const q = quantities[i];
    const previous = quantities[i - 1];
    if (q.slots.pre.length === 0 && q.sentence === previous.sentence && q.clause !== previous.clause) {
      q.slots.pre = previous.slots.pre;
      q.tags = [...new Set([...q.tags, ...previous.slots.pre])];
    }
  }
  return { quantities, unknowns };
}

// ---------------------------------------------------------------------------
// Reading the question — by matching the story, not by position
// ---------------------------------------------------------------------------

const QUESTION_SKIP = new Set([
  'how', 'many', 'much', 'far', 'long', 'old', 'heavy', 'tall', 'more', 'fewer', 'less', 'longer', 'shorter', 'farther', 'further', 'total',
  'altogether', 'all', 'in', 'of', 'the', 'a', 'an', 'and', 'or', 'than', 'did', 'does', 'do', 'will', 'would', 'should', 'can', 'could',
  'are', 'were', 'is', 'was', 'have', 'has', 'had', 'left', 'still', 'now', 'there', 'they', 'he', 'she', 'it', 'them', 'his', 'her',
  'their', 'to', 'with', 'at', 'on', 'for', 'from', 'be', 'been', 'that', 'this', 'each', 'every', 'per', 'get', 'gets'
]);

function readQuestion(
  questionText: string,
  body: { nouns: Set<string>; premods: Set<string>; owners: Set<string> }
): StoryQuestion | null {
  const lower = questionText.toLowerCase().replace(/[?.!,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!QUESTION_STEM.test(lower)) return null;
  const words = lower
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z'-]/g, '').replace(/'s$/, '').replace(/'$/, ''))
    .filter((w) => w.length > 0);
  const nouns: string[] = [];
  const tags: string[] = [];
  const owners: string[] = [];
  const unmatched: string[] = [];
  for (const word of words) {
    const base = singular(word);
    if (body.owners.has(word)) {
      if (!owners.includes(word)) owners.push(word);
      continue;
    }
    if (QUESTION_SKIP.has(word)) continue;
    if (body.nouns.has(base) || (MONEY_NOUNS.has(base) && [...body.nouns].some((n) => MONEY_NOUNS.has(n)))) {
      if (!nouns.includes(base)) nouns.push(base);
      continue;
    }
    if (!body.nouns.has(base) && !body.premods.has(word) && !body.premods.has(base) && !TIME_TAGS.has(word) && word.length > 2 && !/^(how|many|much|does|did|do|will|would|should|are|were|was|is|have|has|had|there|the|and|for|with|from|that|this|been|being|they|them|their|his|her|its|our|your|you|she|he|it|we|us|him|all|any|out|off|now|then|than|left|still|total|altogether|combined|start|begin|beginning|first|last|end|ends|ended)$/.test(word) && !/(?:ed|ing|ly)$/.test(word)) {
      if (!unmatched.includes(base)) unmatched.push(base);
    }
    if (body.premods.has(word) || body.premods.has(base) || TIME_TAGS.has(word)) {
      // "at the end OF THE week", "DURING THE week" name the story's whole
      // span, not one of its parts — they select nothing.
      if (new RegExp(`\\b(?:of|during|by|within|over) the ${word}\\b`).test(lower)) continue;
      // Slots hold singular words, so the question's must be singular too —
      // "friends" has to match the tag "friend" or it selects nothing.
      if (!tags.includes(base)) tags.push(base);
    }
  }
  // WHAT IS BEING ASKED FOR. The words between "how many/much" and the
  // question's verb name it: "how many bird LEGS", "how many PAGES are in
  // the first chapter", "how many DAYS would the bottles last". The last
  // content word of that run is the thing asked for — and if the story
  // counts no such thing (legs of a bird, days of a rate, pencils bought
  // with cents), the answer needs knowledge or a shape this engine does
  // not have. Decline rather than answer about something else.
  const stemRun = lower.match(/\bhow (?:many|much)\s+((?:[a-z'-]+\s*){0,3})/);
  const stemWords: string[] = [];
  for (const word of (stemRun?.[1] ?? '').trim().split(/\s+/)) {
    if (word.length === 0) continue;
    // "how many PACKS of balloons": the of-phrase names the material, the
    // stem is the pack — and the story counts no packs, so it declines.
    if (word === 'of' || /^(do|does|did|are|is|was|were|will|would|can|could|should|have|has|had|until|left|remain|remains|still|there|other)$/.test(word)) break;
    if (QUESTION_SKIP.has(word) || body.owners.has(word) || PRONOUNS.has(word)) continue;
    stemWords.push(word);
  }
  const stemNoun = stemWords.length === 0 ? null : singular(stemWords[stemWords.length - 1]);

  const difference =
    /\bhow (?:many|much) (?:more|fewer|less|longer|shorter|taller|heavier|older|younger|farther|further|bigger|smaller)\b/.test(lower) ||
    /\b(?:more|fewer|less|longer|shorter|taller|heavier|older|younger|farther|further)\b[^.]*\bthan\b/.test(lower) ||
    /\bdifference\b/.test(lower) ||
    // A malformed comparison is still a comparison: the corpus has "how much
    // money did he spend to buy X than he did to buy Y".
    /\bthan\b/.test(lower) ||
    // "how many repetitions did she fall BEHIND", "how many SHORT"
    /\b(behind|short|shy)\b/.test(lower);
  const eachHit = lower.match(/\b(?:each|every|per)\s+(?:of\s+)?(?:the\s+|his\s+|her\s+|their\s+)?([a-z]+)/);
  const eachNoun = eachHit === null ? null : singular(eachHit[1]);
  let kind: QuestionKind;
  if (difference) kind = 'difference';
  else if (/\b(to start with|to begin with|at first|initially|originally|in the beginning|at the start|start with|begin with|before (?:he|she|they|it|start|going)\b|before (?:[a-z]+ing)\b|to begin\b)/.test(lower)) kind = 'start';
  else if (RATE_CUES.test(lower)) kind = 'share';
  else if (LEFT_CUES.test(lower) || /\b(not|without)\b/.test(lower)) kind = 'residual';
  else if (
    /\b(spend|spent|give|gave|eat|ate|earn|earned|cut|delete|deleted|sell|sold|lose|lost|buy|bought|add|added|receive|received|use|used|take|took|win|won|arrive|arrived|join|joined|pick|picked|collect|collected|remove|removed|donate|donated|pay|paid|score|scored|catch|caught|bake|baked|plant|planted|save|saved|drink|drank|break|broke|wash|washed|borrow|borrowed|make|made|swim|swam|jump|jumped|walk|walked|write|wrote|climb|climbed|drive|drove|ride|rode|throw|threw|see|saw|watch|watched|hike|hiked|row|rowed|practice|practiced|disappear|disappeared|vanish|vanished|melt|melted|escape|escaped|die|died|fly|flew|leak|leaked|break|broke|remain)\b/.test(lower) &&
    !/\b(?:does|do|did) (?:[a-z]+ )?have\b/.test(lower)
  )
    kind = 'change';
  else kind = 'total';
  return { kind, stemNoun, unmatched, nouns, owners, tags, eachNoun, text: questionText.trim() };
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

/**
 * THE ARITHMETIC, DECK-INDEPENDENT. A reading builds an operation tree and
 * carries its value for the naturals guards (no negative intermediate, only
 * exact division); the tree is emitted as engine terms at the end.
 *
 * WHICH DECK. Peano numerals are unary, so "544 pots × 32 flowers" costs
 * tens of thousands of rewrite steps — an honest ASK after half a minute of
 * work. The digits deck does the same arithmetic column by column, in the
 * tens of steps, so every add, subtract and multiply is emitted there. It
 * has no division rule, so a reading that divides is emitted in Peano
 * (measured: exact quotients of corpus size stay well inside the budget).
 */
type Op =
  | { k: 'lit'; v: number }
  | { k: 'add' | 'sub' | 'mul' | 'div'; a: Op; b: Op };

interface Amount {
  op: Op;
  value: number;
}

const amount = (value: number): Amount => ({ op: { k: 'lit', v: value }, value });
const addA = (a: Amount, b: Amount): Amount => ({ op: { k: 'add', a: a.op, b: b.op }, value: a.value + b.value });
const subA = (a: Amount, b: Amount): Amount | null => (a.value < b.value ? null : { op: { k: 'sub', a: a.op, b: b.op }, value: a.value - b.value });
const mulA = (a: Amount, b: Amount): Amount => ({ op: { k: 'mul', a: a.op, b: b.op }, value: a.value * b.value });
const divA = (a: Amount, b: Amount): Amount | null =>
  b.value === 0 || a.value % b.value !== 0 ? null : { op: { k: 'div', a: a.op, b: b.op }, value: a.value / b.value };
const absDiff = (a: Amount, b: Amount): Amount => (a.value >= b.value ? (subA(a, b) as Amount) : (subA(b, a) as Amount));

function sumOf(values: number[]): Amount | null {
  if (values.length === 0) return null;
  let acc = amount(values[0]);
  for (const v of values.slice(1)) acc = addA(acc, amount(v));
  return acc;
}

function divides(op: Op): boolean {
  if (op.k === 'lit') return false;
  return op.k === 'div' || divides(op.a) || divides(op.b);
}

const DIGIT_HEADS: Record<'add' | 'sub' | 'mul', string> = { add: 'dig.add', sub: 'dig.sub', mul: 'dig.mul' };
const PEANO_HEADS: Record<'add' | 'sub' | 'mul' | 'div', string> = { add: 'nat.add', sub: 'nat.sub', mul: 'nat.mul', div: 'nat.div' };

/** The operation tree as engine terms, in the deck the tree needs. */
export function emitTerm(op: Op, deck: 'digits' | 'peano'): Term {
  if (op.k === 'lit') return deck === 'digits' ? digitsFromDecimal(op.v) : natFromDecimal(op.v);
  const head = deck === 'digits' && op.k !== 'div' ? DIGIT_HEADS[op.k] : PEANO_HEADS[op.k];
  return tSym(head, [emitTerm(op.a, deck), emitTerm(op.b, deck)]);
}

/** Every total reachable by adding some of these values (capped: the check
 *  below only needs small stories). */
function subsetSums(values: number[]): Set<number> {
  let sums = new Set<number>([0]);
  for (const value of values.slice(0, 8)) {
    const next = new Set<number>(sums);
    for (const sum of sums) next.add(sum + value);
    sums = next;
  }
  sums.delete(0);
  return sums;
}

// ---------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------

export function parseStory(prompt: string): StoryReading | null {
  const text = normalise(prompt);
  const questionAt = text.search(/\b[Hh]ow (?:many|much|far|long|old|heavy|tall)\b(?![^]*\b[Hh]ow (?:many|much|far|long|old|heavy|tall)\b)/);
  if (questionAt < 0) return null;
  const body = text.slice(0, questionAt);
  const questionText = text.slice(questionAt);
  if (/\d/.test(questionText)) return null;
  const bodyLower = body.toLowerCase();
  if (UNREADABLE.test(bodyLower) || UNREADABLE.test(questionText.toLowerCase()) || STATED_COMPARISON.test(bodyLower)) return null;
  // A geometry, rate or age question wears a story's clothes but asks for a
  // product, a quotient or a scaling this engine has no story shape for.
  if (/\b(square|cubic|area|volume|perimeter|cover|covers|surface|times as|as old|per hour|per minute|miles per|speed|average|again|same time|side by side|at once)\b/.test(questionText.toLowerCase())) return null;
  if (/\b(rectangle|rectangular|triangle|triangular|circle|circular|perimeter|dimensions|shadow|scale read|digits|reversed|proportion)\b/.test(bodyLower)) return null;
  // "on the 13TH step": normalisation drops an ordinal, so a story that
  // leans on one is missing a quantity the answer needs.
  if (/ORDINAL/.test(text)) return null;
  // "played 2 games with EVERY OTHER player": a combinatorial count.
  if (/\b(every other|each other|one another)\b/.test(bodyLower)) return null;
  // "Alexa and Katerina stood on a scale TOGETHER. The scale read 95": one
  // number covers two parties, so no quantity is anyone's alone.
  const namedPeople = new Set(
    body.replace(/[^\w\s'-]/g, ' ').split(/\s+/).map((w) => w.replace(/'s$/, '')).filter((w) => /^[A-Z][a-z]+$/.test(w) && !NAME_STOP.has(w.toLowerCase())).map((w) => w.toLowerCase())
  );
  if (namedPeople.size > 1 && /\b(together|both of them|between them|combined)\b/.test(bodyLower)) return null;

  const read = readBody(body);
  if (read === null) return null;
  const { quantities, unknowns } = read;
  if (quantities.length === 0) return null;
  if (quantities.some((q) => !Number.isFinite(q.value) || q.value > MAX_OPERAND)) return null;

  const question = readQuestion(questionText, {
    nouns: new Set([
      ...quantities.map((q) => q.noun).filter((n): n is string => n !== null),
      ...quantities.map((q) => q.groupNoun).filter((n): n is string => n !== null)
    ]),
    premods: new Set(quantities.flatMap((q) => q.tags)),
    owners: new Set(quantities.map((q) => q.owner).filter((o): o is string => o !== null))
  });
  if (question === null) return null;
  // The thing asked for must be something the story counts.
  const countable = new Set([
    ...quantities.map((q) => q.noun).filter((n): n is string => n !== null),
    ...quantities.map((q) => q.groupNoun).filter((n): n is string => n !== null)
  ]);
  if (question.stemNoun !== null && !countable.has(question.stemNoun) && ![...countable].some((n) => sameNoun(n, question.stemNoun))) return null;
  // "How many bags did she find AFTER MONDAY", "besides the red ones",
  // "other than the first" — a question that names a qualifier in order to
  // leave it OUT is a selection this engine cannot express. Decline.
  if (/\b(after|besides|other than|except|excluding|apart from|without|aside from|not counting)\b/.test(questionText.toLowerCase()) && quantities.some((q) => q.tags.length > 0)) return null;
  // "How TALL is the tree" over a fence post, its shadow and the tree's
  // shadow: a measure question naming nothing, with more quantities than a
  // single narrative can hold, is a proportion or a geometry problem.
  if (question.stemNoun === null && quantities.length > 2) return null;
  // A story that hides a number can only be read as a change or a start.
  if (unknowns > 0 && question.kind !== 'change' && question.kind !== 'start') return null;

  // ---- account for every quantity -----------------------------------------
  // A quantity is EXCLUDED only when the question ruled it out by naming a
  // different TAG (a premodifier, an of-phrase, a day) or a different
  // OWNER. Never by its noun: "61 parents and 177 pupils … how many
  // PEOPLE" would drop both quantities and answer with the third, and
  // deciding that people covers parents needs the relation store (#65).
  // A noun the question does not name is handled by the shapes below —
  // most of them decline outright when two kinds are in play.
  const tagsOf = (q: StoryQuantity): string[] => q.tags;
  // THE CONTRAST TEST. A word rules a quantity out only if it DISCRIMINATES
  // — it is not shared by every quantity ("pages of MATH homework" against
  // "of READING homework"; "homework" itself separates nothing) — and only
  // when the question is asking for a named kind AND every quantity carries
  // some discriminating word of its own, so the question's word is choosing
  // among alternatives rather than merely sitting next to one of them.
  // "How long will her PENCIL be" names no kind: it selects nothing, and
  // the whole story is read.
  const discriminating = (q: StoryQuantity): string[] => q.tags.filter((word) => !quantities.every((other) => other.tags.includes(word)));
  const namesADiscriminator =
    question.stemNoun !== null && question.tags.length > 0 && quantities.length > 1 && quantities.some((q) => discriminating(q).some((t) => question.tags.includes(t)));
  // A COHERENT SELECTION. The question named a distinguishing word; for the
  // selection to mean anything, every quantity it does NOT name must carry
  // its own distinguishing word in the SAME SLOT — "of MATH homework"
  // against "of READING homework", "RED peaches" against "GREEN peaches".
  // A story where the named word merely sits next to one quantity ("she
  // earned 4 GOLD stars … today she earned 3 more") offers no such
  // alternative: naming it selects nothing.
  const wordsIn = (q: StoryQuantity, slot: keyof TagSlots): string[] => {
    const value = q.slots[slot];
    return Array.isArray(value) ? value : [];
  };
  const namedSlots = TAG_SLOTS.filter((slot) => quantities.some((q) => wordsIn(q, slot).some((t) => question.tags.includes(t) && discriminating(q).includes(t))));
  const coherent =
    namesADiscriminator &&
    quantities.every(
      (q) => discriminating(q).some((t) => question.tags.includes(t)) || namedSlots.some((slot) => wordsIn(q, slot).some((t) => discriminating(q).includes(t)))
    );
  // A TOTAL ASKS FOR EVERYTHING. "15 pieces of pepperoni, 10 of salami and
  // 30 of bacon — how many pieces of MEAT in total": naming one part's word
  // does not narrow a question that says "in total".
  const totalCue = /\b(in all|in total|altogether|all together|combined|overall)\b/.test(question.text.toLowerCase());
  // A residual category ("species of OTHER insects") cannot be related to
  // the categories beside it without the store (#65).
  const residualNamed = quantities.some((q) => q.slots.residualClass === true && discriminating(q).some((t) => question.tags.includes(t)));
  if (residualNamed) return null;

  // THE MISSING PART. "67 medals are displayed. There are 19 gold and 32
  // silver. How many BRONZE?" — the question names a part the story never
  // states, one quantity is the whole (it carries no distinguishing word of
  // its own, or its words cover every part's), and the rest are the stated
  // parts. The answer is the whole less the parts.
  // The question names a part the story never states: "19 gold and 32
  // silver of 67 medals — how many BRONZE?", "ten bedrooms total, the
  // second floor had two — how many on the FIRST?". Only a TOTAL question
  // reads this way (a change question asks about the events instead), and
  // only when one quantity is the whole: it carries no distinguishing word
  // of its own, or the story stated it as the whole.
  // Its signature is an unstated KIND sitting right in front of the thing
  // asked for — "how many BRONZE medals" where the story stated gold and
  // silver ones and a total. Every stated part must carry its own kind word
  // in the same position, the whole must carry none, and the parts must fit
  // inside it. Anything looser reads "13 ducks and 20 more ducks" as a
  // subtraction.
  const adjacent = question.text.toLowerCase().match(/\bhow (?:many|much)\s+([a-z'-]+)\s+([a-z'-]+)/);
  const unstatedKind =
    adjacent !== null && question.stemNoun !== null && sameNoun(singular(adjacent[2]), question.stemNoun) && !quantities.some((q) => q.tags.includes(singular(adjacent[1])))
      ? singular(adjacent[1])
      : null;
  if (unstatedKind !== null && question.kind === 'total' && quantities.length >= 2) {
    const sameKind = quantities.filter((q) => sameNoun(q.noun, question.stemNoun) && q.role !== 'per' && q.role !== 'groups');
    if (sameKind.length === quantities.length) {
      const wholes = sameKind.filter((q) => q.slots.mod.length === 0 && q.role !== 'loss');
      const parts = sameKind.filter((q) => !wholes.includes(q));
      const partsSum = parts.reduce((total, q) => total + q.value, 0);
      if (wholes.length === 1 && parts.length >= 1 && parts.every((q) => q.role === 'add' && q.slots.mod.length > 0) && partsSum < wholes[0].value) {
        let acc: Amount = amount(wholes[0].value);
        for (const part of parts) {
          const next = subA(acc, amount(part.value));
          if (next === null) return null;
          acc = next;
        }
        const partsDeck = divides(acc.op) ? 'peano' : 'digits';
        return { term: emitTerm(acc.op, partsDeck), deck: partsDeck, value: acc.value, shape: 'whole − stated parts', quantities, question };
      }
    }
    return null;
  }

  // Named a discriminator but cannot act on it: DECLINE. Answering would be
  // answering a question the observer did not understand.
  // A total that names ONE quantity's word is naming what they all are
  // ("30 pieces of BACON as MEAT ingredients … how many pieces of meat IN
  // TOTAL"); a total that names a word two of them share is narrowing
  // ("played TAG with 7 … and 13 … played cards with 20 … how many kids did
  // she play tag with altogether").
  const namedCount = quantities.filter((q) => discriminating(q).some((t) => question.tags.includes(t))).length;
  const totalOverridesSelection = totalCue && namedCount <= 1;
  if (namesADiscriminator && !coherent && !totalOverridesSelection) return null;
  const canSelectByTag = coherent && !totalOverridesSelection;
  const excluded: StoryQuantity[] = [];
  const selected: StoryQuantity[] = [];
  const questionTags = question.tags;
  for (const q of quantities) {
    if (question.owners.length > 0 && q.owner !== null && !question.owners.includes(q.owner)) {
      excluded.push(q);
      continue;
    }
    if (canSelectByTag && q.role !== 'end' && !discriminating(q).some((t) => questionTags.includes(t))) {
      excluded.push(q);
      continue;
    }
    selected.push(q);
  }
  if (selected.length === 0) return null;
  // Every quantity with NO distinguishing feature must be selected — an
  // unplaceable number means the reading is incomplete.
  if (excluded.some((q) => q.noun === null && tagsOf(q).length === 0 && q.owner === null)) return null;
  // ONE OWNER PER NARRATIVE. Two named people in the selected set means the
  // story moves quantities between them ("Nell had 528, Jeff had 11, she
  // gave some to Jeff and now has 252") — a transfer this engine does not
  // model. Comparisons between two owners are read by their own shape.
  const owners = new Set(selected.map((q) => q.owner).filter((o): o is string => o !== null));
  if (owners.size > 1 && question.kind !== 'difference') return null;

  const rates = selected.filter((q) => q.role === 'per');
  const groupCounts = selected.filter((q) => q.role === 'groups');
  const plain = selected.filter((q) => q.role !== 'per' && q.role !== 'groups');

  const built = build(question, rates, groupCounts, plain, unknowns);
  if (built === null) return null;
  const { amount: result, shape } = built;
  if (!Number.isFinite(result.value) || result.value < 0) return null;
  const deck = divides(result.op) ? 'peano' : 'digits';
  return { term: emitTerm(result.op, deck), deck, value: result.value, shape, quantities, question };
}

function build(
  question: StoryQuestion,
  rates: StoryQuantity[],
  groupCounts: StoryQuantity[],
  plain: StoryQuantity[],
  unknowns: number
): { amount: Amount; shape: string } | null {
  // -------- equal groups --------
  if (rates.length > 0 || groupCounts.length > 0) {
    if (rates.length !== 1) return null;
    if (question.kind !== 'total' && question.kind !== 'change') return null;
    const rate = rates[0];
    const perNoun = rate.noun;
    const groupNoun = rate.groupNoun;
    const asksPer = question.nouns.some((n) => sameNoun(n, perNoun));
    const asksGroups = groupNoun !== null && question.nouns.some((n) => sameNoun(n, groupNoun));
    if (asksGroups && !asksPer) {
      // whole ÷ per → the number of groups. The whole is everything else,
      // and it must all count the per-noun.
      if (groupCounts.length > 0 || plain.length === 0) return null;
      if (!plain.every((q) => sameNoun(q.noun, perNoun) || q.noun === null)) return null;
      const whole = narrative(plain, 'total', unknowns, question.text);
      if (whole === null) return null;
      const shared = divA(whole, amount(rate.value));
      return shared === null ? null : { amount: shared, shape: 'groups = whole ÷ per' };
    }
    if (!asksPer && question.nouns.length > 0) return null;
    // per × groups. The group count is the explicit "each of the N" or the
    // one remaining quantity counting the group noun.
    const counts = groupCounts.length > 0 ? groupCounts : plain.filter((q) => groupNoun !== null && sameNoun(q.noun, groupNoun));
    if (counts.length !== 1) return null;
    const others = plain.filter((q) => q !== counts[0]);
    if (others.length > 0) return null; // a third quantity: not this shape
    return { amount: mulA(amount(counts[0].value), amount(rate.value)), shape: 'per × groups' };
  }
  // -------- a share with no stated rate: whole ÷ groups --------
  if (question.kind === 'share') {
    if (question.eachNoun === null) return null;
    const counts = plain.filter((q) => sameNoun(q.noun, question.eachNoun));
    if (counts.length !== 1) return null;
    let rest = plain.filter((q) => q !== counts[0]);
    if (question.stemNoun !== null) {
      const asked = rest.filter((q) => sameNoun(q.noun, question.stemNoun));
      if (asked.length > 0) rest = asked;
    }
    if (rest.length === 0) return null;
    const whole = narrative(rest, 'total', unknowns, question.text);
    if (whole === null) return null;
    const shared = divA(whole, amount(counts[0].value));
    return shared === null ? null : { amount: shared, shape: 'share = whole ÷ groups' };
  }
  // -------- difference --------
  if (question.kind === 'difference') {
    if (unknowns > 0) return null;
    // TWO SIBLINGS, NOT A WHOLE AND A PART. "Together their strawberries
    // weighed 26 pounds. Marco's weighed 10. How much MORE did his dad's
    // weigh than his?" — the comparison is between his dad's share (26 −
    // 10) and his, which is a second derivation this shape does not carry;
    // subtracting the part from the whole answers a different question. The
    // same holds when one side is a take-away ("7 flew away — how many more
    // STAYED than flew away").
    if (!plain.every((q) => q.role === 'add')) return null;
    if (question.nouns.length === 2) {
      const a = pickOne(plain.filter((q) => sameNoun(q.noun, question.nouns[0])), question);
      const b = pickOne(plain.filter((q) => sameNoun(q.noun, question.nouns[1])), question);
      if (a === null || b === null) return null;
      if (plain.length !== 2) return null;
      return { amount: absDiff(amount(a.value), amount(b.value)), shape: 'difference of two kinds' };
    }
    if (question.owners.length === 2) {
      const a = pickOne(plain.filter((q) => q.owner === question.owners[0]), question);
      const b = pickOne(plain.filter((q) => q.owner === question.owners[1]), question);
      if (a === null || b === null || plain.length !== 2) return null;
      return { amount: absDiff(amount(a.value), amount(b.value)), shape: 'difference by owner' };
    }
    if (plain.length !== 2) return null;
    // The two must be comparable: same kind, or one kind and one unnamed.
    if (plain[0].noun !== null && plain[1].noun !== null && !sameNoun(plain[0].noun, plain[1].noun)) return null;
    return { amount: absDiff(amount(plain[0].value), amount(plain[1].value)), shape: 'difference' };
  }
  // -------- narrative over one kind --------
  const nouns = new Set(plain.map((q) => (q.noun === null ? null : MONEY_NOUNS.has(q.noun) ? 'money' : q.noun)).filter((n): n is string => n !== null));
  if (nouns.size > 1) return null; // a sum across kinds needs the store (#65)
  // The question must be about the kind the story counts. A question naming
  // a noun no quantity counts ("how many DAYS would the bottles last") is
  // asking something the story states only as a rate.
  if (nouns.size === 1 && question.nouns.length > 0 && !question.nouns.some((n) => sameNoun(n, [...nouns][0]))) return null;
  const result = narrative(plain, question.kind, unknowns, question.text);
  return result === null ? null : { amount: result, shape: question.kind };
}

function pickOne(candidates: StoryQuantity[], question: StoryQuestion): StoryQuantity | null {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return null;
  const tagged = candidates.filter((q) => q.tags.some((t) => question.tags.includes(t)));
  return tagged.length === 1 ? tagged[0] : null;
}

/**
 * The narrative over one kind: adds, losses and at most one stated end.
 *
 *   total / residual  Σadd − Σloss           (needs no end and no unknown)
 *   start             end − Σadd + Σloss     (the start is the unknown)
 *   change            |end − (Σadd − Σloss)| (the change is the unknown)
 */
function narrative(pool: StoryQuantity[], kind: QuestionKind, unknowns: number, questionText: string): Amount | null {
  const ends = pool.filter((q) => q.role === 'end');
  const adds = pool.filter((q) => q.role === 'add');
  const losses = pool.filter((q) => q.role === 'loss');
  if (ends.length > 1) return null;
  const end = ends[0];

  if (kind === 'total' || kind === 'residual') {
    if (end !== undefined || unknowns > 0 || adds.length === 0) return null;
    if (kind === 'residual' && losses.length === 0) {
      // "95 pages in the book; read 18, then 58 — how many left": one
      // possession state, and the activities that consume it.
      const possessions = adds.filter((q) => q.possession);
      const activities = adds.filter((q) => !q.possession);
      if (possessions.length !== 1 || activities.length === 0) return null;
      let acc = amount(possessions[0].value);
      for (const a of activities) {
        const next = subA(acc, amount(a.value));
        if (next === null) return null;
        acc = next;
      }
      return acc;
    }
    // A TOTAL OVER A STORY THAT LOSES SOMETHING is only a sum-minus-losses
    // if the question asks for the state that results ("how many are there
    // NOW", "how many does he HAVE"). "How many DAYS would the water
    // bottles last" is a rate question wearing a total's clothes: the same
    // numbers, a different derivation. Decline it.
    if (losses.length > 0 && !/\b(have|has|there (?:are|is|were|was)|now|left|remain|remains|end up|does \w+ own)\b/i.test(questionText)) return null;
    // Two possession states of one owner and nothing else is a change, not
    // a total ("had $15 … when she left she had $11").
    if (adds.length === 2 && losses.length === 0 && adds.every((q) => q.possession) && adds[0].owner === adds[1].owner && adds[0].clause !== adds[1].clause) return null;
    // THE PARTITION CHECK. "45 questions on the test. 17 are word problems.
    // 28 are addition problems. Steve answered 38" — one quantity is the
    // sum of others, so the story stated a whole AND its parts and adding
    // them all double-counts. Decline rather than answer 128.
    for (const candidate of adds) {
      const others = adds.filter((q) => q !== candidate).map((q) => q.value);
      if (others.length >= 2 && subsetSums(others).has(candidate.value)) return null;
    }
    const sum = sumOf(adds.map((q) => q.value));
    if (sum === null) return null;
    let acc = sum;
    for (const l of losses) {
      const next = subA(acc, amount(l.value));
      if (next === null) return null;
      acc = next;
    }
    return acc;
  }

  if (kind === 'start') {
    if (end === undefined) return null;
    // "Rachel PICKED 7 apples FROM HER TREE … how many did THE TREE have to
    // begin with": the same event is a gain for her and a loss for the
    // tree, and which one the question means decides the sign — so a start
    // question that names the OTHER party declines. "Evan GAVE 14 books
    // away … how many did HE have at first" names no other party: it adds
    // the losses back.
    if (losses.length > 0 && losses.some((q) => q.fromParty !== null && (questionText.toLowerCase().includes(q.fromParty) || false))) return null;
    let acc: Amount = amount(end.value);
    for (const a of adds) {
      const next = subA(acc, amount(a.value));
      if (next === null) return null;
      acc = next;
    }
    for (const l of losses) acc = addA(acc, amount(l.value));
    return acc;
  }

  // change
  if (end === undefined) {
    // "Fred HAD 33 dollars … earning 16 and 74. How much did Fred EARN?"
    // A change question asks about the events, not the state they started
    // from: when the pool holds both, the possession is the starting point
    // and the activities are the change.
    const activities = pool.filter((q) => q.role === 'add' && !q.possession);
    const states = pool.filter((q) => q.role === 'add' && q.possession);
    if (activities.length > 0 && states.length > 0 && losses.length === 0 && unknowns === 0) {
      return sumOf(activities.map((q) => q.value));
    }
    // No stated end: two possession states of one owner ARE the change.
    if (adds.length === 2 && losses.length === 0 && adds.every((q) => q.possession) && adds[0].owner === adds[1].owner && adds[0].clause !== adds[1].clause && unknowns === 0) {
      return absDiff(amount(adds[0].value), amount(adds[1].value));
    }
    if (unknowns > 0) return null;
    // "how many push-ups did Zachary do" over stated parts: the parts sum.
    if (losses.length > 0) return null;
    return sumOf(adds.map((q) => q.value));
  }
  if (adds.length === 0 && losses.length === 0) return null;
  const known = sumOf(adds.map((q) => q.value)) ?? amount(0);
  let net = known;
  for (const l of losses) {
    const next = subA(net, amount(l.value));
    if (next === null) return null;
    net = next;
  }
  return absDiff(amount(end.value), net);
}
