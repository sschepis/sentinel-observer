/**
 * @jest-environment node
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { DECK_20000 } from './decks/en-20000';
import { PRIME_SPACE, SIGNATURE_LENGTH, fnv1a, deckVocabulary } from './primeSignature';
import {
  auditSemanticDeck,
  jaccard,
  semanticAssignment,
  semanticRelatedness,
  semanticVocabulary,
  siblingClusters
} from './semanticSignature';
import type { DeckWord } from './deck';

/**
 * PHASE 1 (docs/PRIME_SEMANTICS_PLAN.md): semantic signatures must be as
 * sound as the hash scheme (unique, deterministic, in-basis) AND make
 * signature overlap track semantic relatedness (H1), without giving up
 * recall accuracy (H2 floor mirrors recallBenchmark.test.ts).
 *
 * DECK_100/DECK_1000 are word-only (definitions arrive via the Chaperone),
 * so the is-a structure — and therefore this whole experiment — lives in
 * the 20k deck. All tests run on a 20k slice.
 */
const SLICE = DECK_20000.slice(0, 5000) as readonly DeckWord[];

describe('semantic signatures — soundness audit', () => {
  it('a 5k slice of the 20k deck gets unique, deterministic, in-basis signatures', () => {
    const result = auditSemanticDeck(SLICE, PRIME_SPACE);
    expect(result.valid).toBe(true);
    expect(result.uniqueSignatures).toBe(result.words);
    // The experiment is pointless if inheritance never fires.
    expect(result.categorized).toBeGreaterThan(100);
    // eslint-disable-next-line no-console
    console.log(
      `SEMANTIC AUDIT: ${result.words} words, ${result.categorized} categorized (${((result.categorized / result.words) * 100).toFixed(1)}%)`
    );
  });

  it('every signature has exactly SIGNATURE_LENGTH distinct primes', () => {
    const vocabulary = semanticVocabulary(SLICE.slice(0, 500), PRIME_SPACE);
    for (const signature of Object.values(vocabulary)) {
      expect(new Set(signature).size).toBe(SIGNATURE_LENGTH);
    }
  });
});

describe('H1 — signature overlap tracks the is-a graph', () => {
  it('directed relatedness rewards semantic matches and ignores unknown tokens', () => {
    const vocabulary = {
      bird: [2, 3, 5, 7],
      robin: [2, 11, 13, 17],
      stone: [19, 23, 29, 31]
    };
    expect(semanticRelatedness(['unknown', 'bird'], ['bird'], vocabulary)).toBe(1);
    expect(semanticRelatedness(['robin'], ['bird'], vocabulary)).toBeGreaterThan(0);
    expect(semanticRelatedness(['stone'], ['bird'], vocabulary)).toBe(0);
    expect(semanticRelatedness(['unknown'], ['bird'], vocabulary)).toBe(0);
  });

  it('sibling pairs overlap more than unrelated pairs', () => {
    const { vocabulary, categoryPrimes, parents } = semanticAssignment(SLICE, PRIME_SPACE);

    // Sibling pairs: words sharing a categorized parent.
    const children = new Map<string, string[]>();
    for (const [word, parent] of parents) {
      if (!categoryPrimes.has(parent)) continue;
      if (vocabulary[word] === undefined) continue;
      const list = children.get(parent) ?? [];
      list.push(word);
      children.set(parent, list);
    }
    const siblingScores: number[] = [];
    for (const list of children.values()) {
      for (let i = 0; i < list.length - 1 && siblingScores.length < 500; i += 1) {
        siblingScores.push(jaccard(vocabulary[list[i]], vocabulary[list[i + 1]]));
      }
    }
    expect(siblingScores.length).toBeGreaterThan(5);

    // Unrelated pairs: deterministic hash-shuffled pairing of words with no
    // shared parent.
    const words = Object.keys(vocabulary).sort((a, b) => fnv1a(a) - fnv1a(b));
    const unrelatedScores: number[] = [];
    for (let i = 0; i + 1 < words.length && unrelatedScores.length < 500; i += 2) {
      const [a, b] = [words[i], words[i + 1]];
      if (parents.get(a) !== undefined && parents.get(a) === parents.get(b)) continue;
      unrelatedScores.push(jaccard(vocabulary[a], vocabulary[b]));
    }

    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
    const siblingMean = mean(siblingScores);
    const unrelatedMean = mean(unrelatedScores);
    // eslint-disable-next-line no-console
    console.log(
      `H1: sibling Jaccard ${siblingMean.toFixed(3)} (n=${siblingScores.length}) vs unrelated ${unrelatedMean.toFixed(3)} (n=${unrelatedScores.length})`
    );
    // Siblings share their parent's category prime by construction; the
    // margin (not just the sign) is the honest check.
    expect(siblingMean).toBeGreaterThan(unrelatedMean + 0.05);
  });
});

/**
 * H2: swapping the vocabulary must not sink recall below the HASH CONTROL
 * measured on the identical stress population. The quiz words are drawn
 * from SIBLING CLUSTERS — the words semantic overlap is most likely to
 * confuse — so a fixed floor would drift whenever the extractor reshapes
 * the clusters; the live control is the honest bar.
 */
describe('H2 — recall accuracy under semantic signatures (30 sibling-cluster words)', () => {
  const BENCH_WORDS = 30;
  let deck: DeckWord[];

  beforeAll(() => {
    const byWord = new Map(SLICE.map((entry) => [entry.word.toLowerCase(), entry]));
    deck = [];
    for (const cluster of siblingClusters(SLICE)) {
      for (const word of cluster.words) {
        const entry = byWord.get(word);
        if (entry !== undefined && entry.definition.trim().length > 0) deck.push(entry);
        if (deck.length >= BENCH_WORDS) break;
      }
      if (deck.length >= BENCH_WORDS) break;
    }
    expect(deck.length).toBe(BENCH_WORDS);
  });

  async function recognitionAccuracy(vocabulary: Record<string, number[]>): Promise<number> {
    const session = new ObserverSession({ primeCount: 64, gridSize: 128, vocabulary }, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, deck);
    for (const entry of deck) teacher.teach(entry.word);
    let correct = 0;
    const words = teacher.listWords().filter((w) => w.traceId !== null);
    for (const state of words) {
      const answer = teacher.ask(state.word.word, 'recognition');
      if (answer.recall !== null && answer.recall.trace.id === state.traceId) correct += 1;
    }
    session.dispose();
    return correct / words.length;
  }

  it('top-1 recognition holds the hash-control bar on the same population', async () => {
    // The assignment must be computed over the STRUCTURED slice: is-a
    // parents are usually not among the 30 bench words, and a bench-only
    // assignment would silently degrade to the hash scheme.
    const control = await recognitionAccuracy(deckVocabulary(SLICE, PRIME_SPACE));
    const semantic = await recognitionAccuracy(semanticVocabulary(SLICE, PRIME_SPACE));
    // eslint-disable-next-line no-console
    console.log(`H2: semantic ${(semantic * 100).toFixed(1)}% vs hash control ${(control * 100).toFixed(1)}%`);
    expect(semantic).toBeGreaterThanOrEqual(control - 0.1);
    // Absolute sanity floor: category overlap must never collapse recall.
    expect(semantic).toBeGreaterThanOrEqual(0.5);
  }, 120000);
});

/**
 * H3: generalization — a NEVER-TAUGHT word used as a recall cue should
 * surface a taught same-category sibling, because it shares its parent's
 * category prime with them. Hash signatures give the cue no overlap with
 * anything (bench measured 1.7–4% ≈ chance); semantic signatures measured
 * 24–32% on the bench, so the CI floor is a conservative 15%.
 */
describe('H3 — category retrieval on never-taught words', () => {
  const CLUSTERS = 20;

  it('untaught sibling cues recall their category above the hash-chance level', async () => {
    const byWord = new Map(SLICE.map((entry) => [entry.word.toLowerCase(), entry]));
    const taught: DeckWord[] = [];
    const holdouts: Array<{ word: string; parent: string }> = [];
    for (const cluster of siblingClusters(SLICE)) {
      if (holdouts.length >= CLUSTERS) break;
      const defined = cluster.words.filter((word) => {
        const entry = byWord.get(word);
        return entry !== undefined && entry.definition.trim().length > 0;
      });
      if (defined.length < 4) continue;
      for (const word of defined.slice(0, 3)) taught.push(byWord.get(word) as DeckWord);
      holdouts.push({ word: defined[3], parent: cluster.parent });
    }
    expect(holdouts.length).toBe(CLUSTERS);

    const { vocabulary, parents } = semanticAssignment(SLICE, PRIME_SPACE);
    const session = new ObserverSession(
      { primeCount: 128, gridSize: 256, memoryMode: 'compact', memoryCapacity: 5000, vocabulary },
      100
    );
    await session.initialize();
    const teacher = new TeacherAgent(session, taught);
    for (const entry of taught) teacher.teach(entry.word);

    let hits = 0;
    for (const probe of holdouts) {
      const results = session.recall(probe.word, 1);
      const top = results[0]?.trace.content.split(':')[0]?.trim().toLowerCase() ?? '';
      if (parents.get(top) === probe.parent) hits += 1;
    }
    session.dispose();

    const rate = hits / holdouts.length;
    // eslint-disable-next-line no-console
    console.log(`H3: never-taught category retrieval ${(rate * 100).toFixed(1)}% (${hits}/${holdouts.length})`);
    expect(rate).toBeGreaterThanOrEqual(0.15);
  }, 120000);
});
