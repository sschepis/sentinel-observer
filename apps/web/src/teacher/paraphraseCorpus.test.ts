/**
 * @jest-environment node
 *
 * P13 — PARAPHRASE CORPUS. Corpus-scale extension of semanticRecall.test.ts:
 * the static suite guards the corpus contract (size, three paraphrases each,
 * no target-word leakage — every cue must be comprehension, never identity
 * lookup), and the session suite measures paraphrase -> word top-1 recall on
 * a deterministic sample of the corpus through the same content-overlap
 * comprehension path.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { tokenizeText } from './context';
import { PARAPHRASE_CORPUS, type ParaphraseEntry } from './decks/paraphrases';
import type { DeckWord } from './deck';

/** Naive inflections of a word — the forms no paraphrase may contain as a
 *  whole word: the word, +'s', +'es', +'ing', +'ed', and the drop-trailing-e
 *  variants of +'ing'/+'ed' ("make" -> "making"/"maked"? no — "making"/"maked"
 *  are both checked; only real leakage matters, so the net is deliberately
 *  wide). */
function naiveInflections(word: string): string[] {
  const lower = word.toLowerCase();
  const forms = [lower, `${lower}s`, `${lower}es`, `${lower}ing`, `${lower}ed`];
  if (lower.endsWith('e')) {
    const stem = lower.slice(0, -1);
    forms.push(`${stem}ing`, `${stem}ed`);
  }
  return forms;
}

/** Whether the text contains any of the forms as a whole word (case-insensitive). */
function containsWholeWord(text: string, forms: readonly string[]): boolean {
  const tokens = new Set(text.toLowerCase().split(/[^a-z]+/).filter((token) => token.length > 0));
  return forms.some((form) => tokens.has(form));
}

describe('P13 paraphrase corpus — static contract', () => {
  it('has at least 140 entries, each with exactly 3 paraphrases', () => {
    expect(PARAPHRASE_CORPUS.length).toBeGreaterThanOrEqual(140);
    for (const entry of PARAPHRASE_CORPUS) {
      expect(entry.paraphrases.length).toBe(3);
    }
  });

  it('no paraphrase contains its target word or naive inflections as a whole word', () => {
    const violations: string[] = [];
    for (const entry of PARAPHRASE_CORPUS) {
      const banned = naiveInflections(entry.word);
      for (const paraphrase of entry.paraphrases) {
        if (containsWholeWord(paraphrase, banned)) {
          violations.push(`${entry.word}: "${paraphrase}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('has no duplicate words', () => {
    const words = PARAPHRASE_CORPUS.map((entry) => entry.word.toLowerCase());
    expect(new Set(words).size).toBe(words.length);
  });

  it('has nonempty definitions and examples', () => {
    for (const entry of PARAPHRASE_CORPUS) {
      expect(entry.definition.trim().length).toBeGreaterThan(0);
      expect(entry.example.trim().length).toBeGreaterThan(0);
    }
  });
});

/** Deterministic sample: every Nth entry (no RNG) — 20 entries spanning the
 *  corpus's categories, small enough to keep the session cheap. */
const SAMPLE_SIZE = 20;
const STRIDE = Math.floor(PARAPHRASE_CORPUS.length / SAMPLE_SIZE);
const SAMPLE: readonly ParaphraseEntry[] = Array.from(
  { length: SAMPLE_SIZE },
  (_, index) => PARAPHRASE_CORPUS[index * STRIDE]
);

const SAMPLE_DECK: readonly DeckWord[] = SAMPLE.map((entry) => ({
  word: entry.word,
  definition: entry.definition,
  example: entry.example
}));

/** Cue tokens restricted to the sampled entries only (the full-corpus
 *  PARAPHRASE_CUE_TOKENS would inflate the vocabulary for no benefit here).
 *  Same construction: distinct tokens across the sample's paraphrases and
 *  definitions — without them the vocabulary (built from deck WORDS only)
 *  would silently drop the cue content at recall time. */
const SAMPLE_CUE_TOKENS: readonly string[] = [
  ...new Set(
    SAMPLE.flatMap((entry) => [
      ...tokenizeText(entry.definition),
      ...entry.paraphrases.flatMap((paraphrase) => tokenizeText(paraphrase))
    ])
  )
];

describe('P13 paraphrase corpus — session recall', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeAll(async () => {
    session = new ObserverSession(
      {
        primeCount: 64,
        gridSize: 128,
        memoryMode: 'compact',
        smfWidth: 128,
        vocabulary: deckVocabulary(
          [
            ...SAMPLE_DECK,
            ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w })),
            ...SAMPLE_CUE_TOKENS.map((w) => ({ word: w }))
          ],
          PRIME_SPACE
        )
      },
      100
    );
    await session.initialize();
    teacher = new TeacherAgent(session, SAMPLE_DECK);
    for (const entry of SAMPLE_DECK) teacher.teach(entry.word);
  }, 120000);

  afterAll(() => {
    session.dispose();
  });

  it('paraphrase -> word: corpus paraphrases recall the word (≥ 0.6)', () => {
    let correct = 0;
    let total = 0;
    for (const entry of SAMPLE) {
      const state = teacher.tryState(entry.word);
      for (const cue of entry.paraphrases) {
        total += 1;
        const answer = teacher.askCue(entry.word, cue);
        if (answer.recall !== null && state?.traceId !== null && answer.recall.trace.id === state?.traceId) correct += 1;
      }
    }
    expect(total).toBe(SAMPLE.length * 3);
    // eslint-disable-next-line no-console
    console.log(`PARAPHRASE-CORPUS: paraphrase->word top-1 ${((correct / total) * 100).toFixed(0)}% (${correct}/${total})`);
    expect(correct / total).toBeGreaterThanOrEqual(0.6);
  });
});
