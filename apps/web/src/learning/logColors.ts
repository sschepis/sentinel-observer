/**
 * READING THE TRAINING FEED AT A GLANCE (docs/TASKS.md #80).
 *
 * The learning stream is where you watch the observer learn, and it was a
 * wall of one-colour text: 80 lines of "curriculum: 1000 rows · 43 new edges
 * · 0 denied · 12 negations · 380 new words · 958 skipped · 45919 left · 612
 * ms", all the same grey. The numbers that matter — a wrong answer, a
 * denied claim, entropy going the wrong way — read exactly like the ones
 * that do not.
 *
 * Every event's text is already assembled server-side out of ` · `
 * separated parts (`describeFeed`, `describeEntropy`, `describeGraderCheck`
 * and the autonomous loop), so the parts are the natural unit to colour.
 * This module is a pure function over that text: it splits on the
 * separators and gives each part a tone by what it SAYS, using the app's
 * existing conventions — emerald for something gained, rose for something
 * wrong, amber for a warning or a rise in uncertainty, sky for progress,
 * fuchsia for the knowledge-entropy readout, slate for the incidental.
 *
 * It is deliberately a lexicon and not a parser: the server can add a part
 * tomorrow and the line stays readable, just uncoloured. Nothing here
 * changes what is logged — it is a readout of a readout.
 */

/** One coloured run of the line. */
export interface LogSegment {
  text: string;
  /** Tailwind text colour, or null for the line's base colour. */
  tone: string | null;
  /** True for the part's leading number, which is bolder than its words. */
  emphasis?: boolean;
}

/** GOOD: something the observer gained, kept or got right. */
const GAINED =
  /\b(new edges?|edges? read|agreed|negations?|defined|taught|new words?|right|correct|recalled|induced|generalized|consolidated|complete|trusted|stored|kept|learned|facts? taught|certain)\b/i;
/** BAD: something wrong, refused or lost. */
const WRONG = /\b(wrong|failed|error|untrusted|missed|denied|conflicted|dangling|unbacked|not trusted|could not|refused)\b/i;
/** WARNING: a decline, a skip, a disagreement — honest but not progress. */
const HEDGED = /\b(abstained|declined|skipped|weakened|hedged|unknown|single-source|regrade|disagreed|stalled|decaying)\b/i;
/** PROGRESS: where the corpus and the loop have got to. */
const PROGRESS = /\b(rows?|pass \d|corpus came round|left|remaining|over \d+ concepts?|concepts?|cycles?|sources?)\b/i;
/** The knowledge-entropy readout keeps its own colour across the whole UI. */
const ENTROPY = /\bbits?\b|\bmean\b|\bweighted\b|\bentropy\b/i;
/** Incidental: how long it took. */
const TIMING = /^\d+(?:\.\d+)?\s*(?:ms|s)$/i;

const TONE = {
  gained: 'text-emerald-300',
  wrong: 'text-rose-300',
  hedged: 'text-amber-300',
  progress: 'text-sky-300',
  entropy: 'text-fuchsia-300',
  timing: 'text-slate-600',
  zero: 'text-slate-600'
} as const;

/** The leading count of a part ("43 new edges" → 43), if it has one. */
function leadingCount(part: string): number | null {
  const hit = /^([+-]?\d+(?:\.\d+)?)/.exec(part.trim());
  if (hit === null) return null;
  const value = Number(hit[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * The tone for one ` · ` separated part. A count of ZERO is dimmed whatever
 * it says: "0 wrong" is the good news, and colouring it rose would make a
 * clean feed look like a failing one.
 */
export function toneForPart(part: string): string | null {
  const trimmed = part.trim();
  if (trimmed.length === 0) return null;
  if (TIMING.test(trimmed)) return TONE.timing;
  const count = leadingCount(trimmed);
  // A signed delta is about direction, not quantity: entropy falling is the
  // observer learning, entropy rising is new vocabulary or new disagreement.
  const signed = /^[+-]/.test(trimmed);
  if (signed && ENTROPY.test(trimmed)) return count !== null && count > 0 ? TONE.hedged : TONE.gained;
  if (count === 0 && !WRONG.test(trimmed)) return TONE.zero;
  if (count === 0) return TONE.zero;
  if (WRONG.test(trimmed)) return TONE.wrong;
  if (HEDGED.test(trimmed)) return TONE.hedged;
  if (GAINED.test(trimmed)) return TONE.gained;
  if (ENTROPY.test(trimmed)) return TONE.entropy;
  if (PROGRESS.test(trimmed)) return TONE.progress;
  return null;
}

/**
 * Split a log line into coloured segments. The separators are kept as their
 * own dim segments so the line reads the same as it did, and a leading
 * "<source>:" prefix keeps the base colour (the gutter label already names
 * the event).
 */
export function colorizeLogLine(text: string): LogSegment[] {
  if (text.length === 0) return [];
  const segments: LogSegment[] = [];
  const parts = text.split(' · ');
  parts.forEach((part, index) => {
    if (index > 0) segments.push({ text: ' · ', tone: 'text-slate-700' });
    const tone = toneForPart(part);
    const count = leadingCount(part);
    // Give the number itself the emphasis and leave its words in the part's
    // tone: the eye finds "43" before it reads "new edges".
    if (count !== null && tone !== null && tone !== TONE.timing) {
      const hit = /^(\s*[+-]?\d+(?:\.\d+)?%?)([\s\S]*)$/.exec(part);
      if (hit !== null) {
        segments.push({ text: hit[1], tone, emphasis: true });
        if (hit[2].length > 0) segments.push({ text: hit[2], tone });
        return;
      }
    }
    segments.push({ text: part, tone });
  });
  return segments;
}
