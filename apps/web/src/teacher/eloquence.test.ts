/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { tokenizeText } from './context';
import { CONVERSATION_DECK, ALL_CONVERSATION_PAIRS, CONVERSATION_CUE_TOKENS, type ConversationPair } from './conversation';
import {
  ALL_ELOQUENCE_PAIRS,
  ELOQUENCE_PACK_CONNECTIVES,
  ELOQUENCE_PACK_STRUCTURE,
  ELOQUENCE_PACK_PARALLELISM,
  ELOQUENCE_PACK_ELABORATION,
  ELOQUENCE_PACK_GRACE
} from './eloquence';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';

/**
 * Static integrity gates for the eloquence curriculum, plus the honest
 * metric the dataset exists to move: structural variety of the composition
 * pool, measured as the distinct-trigram count over tokenized responses.
 * The trigram composition model can only walk paths that exist in taught
 * responses — a duplicated cue silently overwrites an earlier pair, an
 * operator-shaped cue is intercepted before recall runs, and a flat pool
 * yields flat compositions.
 */

const PACKS: readonly (readonly ConversationPair[])[] = [
  ELOQUENCE_PACK_CONNECTIVES,
  ELOQUENCE_PACK_STRUCTURE,
  ELOQUENCE_PACK_PARALLELISM,
  ELOQUENCE_PACK_ELABORATION,
  ELOQUENCE_PACK_GRACE
];

/** Distinct response trigrams — the paths available to the composer. */
function distinctResponseTrigrams(pairs: readonly ConversationPair[]): number {
  const trigrams = new Set<string>();
  for (const pair of pairs) {
    const words = tokenizeText(pair.response);
    for (let i = 0; i < words.length - 2; i += 1) {
      trigrams.add(`${words[i]}|${words[i + 1]}|${words[i + 2]}`);
    }
  }
  return trigrams.size;
}

describe('eloquence packs (static integrity)', () => {
  it('contributes at least 120 pairs with no duplicate cues, within or across the curriculum', () => {
    expect(ALL_ELOQUENCE_PAIRS.length).toBeGreaterThanOrEqual(120);

    // No duplicates WITHIN the eloquence packs.
    const eloquenceCues = ALL_ELOQUENCE_PAIRS.map((pair) => pair.cue.trim().toLowerCase());
    expect(new Set(eloquenceCues).size).toBe(eloquenceCues.length);

    // No collisions with ANY other cue in the full curriculum: every
    // eloquence cue must appear exactly once in ALL_CONVERSATION_PAIRS.
    const counts = new Map<string, number>();
    for (const pair of ALL_CONVERSATION_PAIRS) {
      const key = pair.cue.trim().toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const collisions = eloquenceCues.filter((cue) => (counts.get(cue) ?? 0) !== 1);
    expect(collisions).toEqual([]);
  });

  it('no cue matches an operator-intercepted form', () => {
    // Mirrors of the operator leads in operators.ts — a cue matching one of
    // these would be answered by an operator, never by conversation recall:
    // "what is X" (LEAD_DEFINITION), "does X have Y" (LEAD_HAS_PART),
    // "is X a Y" (LEAD_IS_A), "can you ..." (LEAD_CAPABILITY),
    // "say ..." (LEAD_ECHO).
    const interceptedForms = [
      /^what is (?:(?:a|an|the) )?[a-z]+\??$/,
      /^does (?:(?:a|an|the) )?[a-z]+(?: [a-z]+)* have (?:(?:a|an|the) )?[a-z]+(?: [a-z]+)*\??$/,
      /^is (?:(?:a|an|the) )?[a-z]+(?: [a-z]+)* (?:a|an) [a-z]+(?: [a-z]+)*\??$/,
      /^can you /,
      /^say /
    ];
    for (const pair of ALL_ELOQUENCE_PAIRS) {
      for (const form of interceptedForms) {
        expect(pair.cue).not.toMatch(form);
      }
    }
  });

  it('every ELABORATION response is exactly two sentences', () => {
    for (const pair of ELOQUENCE_PACK_ELABORATION) {
      const enders = pair.response.match(/[.!?]/g) ?? [];
      expect(enders.length).toBe(2);
    }
  });

  it('opening words are diverse: no first word shared by more than 4 responses in a pack', () => {
    for (const pack of PACKS) {
      const counts = new Map<string, number>();
      for (const pair of pack) {
        const first = tokenizeText(pair.response)[0] ?? '';
        counts.set(first, (counts.get(first) ?? 0) + 1);
      }
      const crowded = [...counts.entries()].filter(([, count]) => count > 4).map(([first]) => first);
      expect(crowded).toEqual([]);
    }
  });

  it('each key connective appears in at least two CONNECTIVES responses', () => {
    const connectives = ['however', 'therefore', 'for example', 'in other words', 'on the other hand'];
    const underused = connectives.filter(
      (connective) =>
        ELOQUENCE_PACK_CONNECTIVES.filter((pair) => pair.response.toLowerCase().includes(connective)).length < 2
    );
    expect(underused).toEqual([]);
  });

  it('measurably widens the composition pool: distinct response trigrams gain at least 15%', () => {
    const eloquenceCues = new Set(ALL_ELOQUENCE_PAIRS.map((pair) => pair.cue));
    const withoutEloquence = ALL_CONVERSATION_PAIRS.filter((pair) => !eloquenceCues.has(pair.cue));
    const before = distinctResponseTrigrams(withoutEloquence);
    const after = distinctResponseTrigrams(ALL_CONVERSATION_PAIRS);
    const gain = (after - before) / before;
    console.log(
      `ELOQUENCE: distinct response trigrams ${before} -> ${after} (+${(gain * 100).toFixed(1)}%)`
    );
    expect(gain).toBeGreaterThanOrEqual(0.15);
  });
});

const WORD_DECK: readonly DeckWord[] = [
  { word: 'apple', definition: 'a fruit', example: 'I eat an apple.' },
  { word: 'water', definition: 'a clear liquid', example: 'I drink water.' },
  { word: 'hello', definition: 'a greeting', example: 'Hello there!' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary(
    [...WORD_DECK, ...CONVERSATION_CUE_TOKENS.map((word) => ({ word }))],
    PRIME_SPACE
  )
};

/** A deterministic ~30-pair sample spanning all five packs (every 4th pair). */
const SAMPLE: readonly ConversationPair[] = ALL_ELOQUENCE_PAIRS.filter((_, index) => index % 4 === 0);

describe('eloquence pairs in a live session (recall competency)', () => {
  it(
    'recalls at least 80% of the sampled eloquence cues exactly',
    async () => {
      const session = new ObserverSession(OPTIONS, 100);
      await session.initialize();
      const teacher = new TeacherAgent(session, WORD_DECK);

      teacher.teachConversationDeck(CONVERSATION_DECK);
      const taught = teacher.teachConversationDeck(SAMPLE);
      expect(taught).toBe(SAMPLE.length);

      let recalled = 0;
      for (const pair of SAMPLE) {
        const answer = teacher.respond(pair.cue);
        if (answer.response === pair.response) recalled += 1;
      }
      const rate = recalled / SAMPLE.length;
      console.log(`ELOQUENCE: session recall ${recalled}/${SAMPLE.length} (${(rate * 100).toFixed(1)}%)`);
      expect(rate).toBeGreaterThanOrEqual(0.8);

      session.dispose();
    },
    120000
  );
});
