/**
 * DIALOGUE AND PASSAGE ADAPTERS — turning conversation corpora and prose
 * into the shapes the conversation deck and the reader accept.
 *
 * DIALOGUE. The observer memorizes whole exchanges and answers a cue from
 * memory, so the useful unit is a SHORT single turn and its reply: a cue in
 * the lowercase cue grammar (chaperone.ts CUE_RE) of at most a dozen words,
 * a reply of one or two sentences that stands on its own. Multi-turn
 * dialogue corpora (DailyDialog) are cut into consecutive (turn, reply)
 * pairs and filtered to that shape; everything else — long turns, replies
 * that only make sense with earlier context ("Yes, that one."), turns with
 * names or numbers — is dropped. What survives is a few percent of the
 * corpus, and that is the point: the deck gets material of the shape it can
 * actually answer.
 *
 * PASSAGES. The reader's claim grammar reads timeless declaratives ("A
 * robin is a bird", "Zeus is a god"); narrative yields almost nothing and
 * lists, headings and tables yield noise. Simple English Wikipedia articles
 * are cut to their LEAD (the declarative summary before the first heading),
 * TinyStories are kept whole (short, simple, present-tense), and any
 * passage with too little sentence structure is dropped. The parse-rate
 * bench (passageBenchmark) says how much each source yields; the reader
 * itself decides what it can honestly read.
 */
import { validateConversationPair } from '../teacher/chaperone';

export interface DialogueRow {
  cue: string;
  response: string;
  /** Corpus id, for the record ("dailydialog"). */
  source?: string;
}

export interface PassageRow {
  title: string;
  text: string;
  source?: string;
}

const MAX_CUE_WORDS = 12;
const MAX_RESPONSE_WORDS = 28;
const MIN_RESPONSE_WORDS = 3;
/** Turns that lean on earlier context (a pronoun standing for something
 *  said before) or carry numbers are skipped. */
const CONTEXT_BOUND = /\b(that one|this one|the one|he|she|they|him|her|them|those|these)\b|\d/;
/** A capitalized word that does not start a sentence is a name ("Say, Jim")
 *  — a deck cue never names a person. */
const PROPER_NAME = /(?<!^)(?<![.!?]\s)\b[A-Z][a-z]+\b/;
const SPEAKER_TAGS = /^\s*(?:[A-Z][a-z]*\s*:|\[[^\]]*\]|\([^)]*\))\s*/;

function normalizeTurn(turn: string): string {
  return turn
    .replace(SPEAKER_TAGS, '')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

/** A turn's lowercase cue form: the first sentence, lowercased, trailing
 *  period dropped (the cue grammar keeps "?" and "!"). Null when it does not
 *  fit the grammar or the length bound. */
export function cueFromTurn(turn: string): string | null {
  const first = normalizeTurn(turn).split(/(?<=[.!?])\s+/)[0] ?? '';
  const cue = first.toLowerCase().replace(/\.+$/, '').replace(/[^a-z0-9 ,'?!.-]/g, '').replace(/\s+/g, ' ').trim();
  if (cue.length < 2) return null;
  if (cue.split(' ').length > MAX_CUE_WORDS) return null;
  return cue;
}

/** Cut a multi-turn dialogue into (cue, response) pairs of the deck's shape. */
export function pairsFromDialogue(turns: readonly string[], source = 'dialogue'): DialogueRow[] {
  const pairs: DialogueRow[] = [];
  for (let i = 0; i + 1 < turns.length; i += 1) {
    const rawCue = normalizeTurn(turns[i]);
    const response = normalizeTurn(turns[i + 1]);
    if (CONTEXT_BOUND.test(rawCue) || CONTEXT_BOUND.test(response)) continue;
    if (PROPER_NAME.test(rawCue) || PROPER_NAME.test(response)) continue;
    // The cue must be ONE utterance (one sentence), the reply short and whole.
    if (rawCue.split(/(?<=[.!?])\s+/).length !== 1) continue;
    const words = response.split(/\s+/).length;
    if (words < MIN_RESPONSE_WORDS || words > MAX_RESPONSE_WORDS) continue;
    if (!/[.!?]$/.test(response)) continue;
    const cue = cueFromTurn(rawCue);
    if (cue === null) continue;
    const valid = validateConversationPair({ cue, response }, new Set());
    if (valid === null) continue;
    pairs.push({ cue: valid.cue, response: valid.response, source });
  }
  return pairs;
}

const MIN_PASSAGE_SENTENCES = 2;
const MAX_PASSAGE_CHARS = 1600;

/** The lead of a wiki-style article: the paragraphs before the first
 *  heading, with markup and parentheticals stripped. */
export function articleLead(text: string): string {
  const beforeHeading = text.split(/\n\s*={2,}[^=\n]+={2,}\s*\n|\n\s*#{1,6}\s/)[0] ?? '';
  return beforeHeading
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A passage the reader can work on, or null. */
export function passageFrom(title: string, text: string, source: string, options: { lead?: boolean } = {}): PassageRow | null {
  let body = options.lead === true ? articleLead(text) : text.replace(/\s+/g, ' ').trim();
  if (body.length > MAX_PASSAGE_CHARS) {
    // Cut at a sentence end inside the bound, never mid-sentence.
    const cut = body.slice(0, MAX_PASSAGE_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    body = end > 200 ? cut.slice(0, end + 1) : cut;
  }
  const sentences = body.split(/(?<=[.!?])\s+/).filter((s) => /[a-z]{2,}/i.test(s));
  if (sentences.length < MIN_PASSAGE_SENTENCES) return null;
  // Tables, lists and infobox residue read as noise: too few letters per char.
  const letters = (body.match(/[a-zA-Z]/g) ?? []).length;
  if (letters / Math.max(1, body.length) < 0.7) return null;
  return { title: title.trim(), text: body, source };
}
