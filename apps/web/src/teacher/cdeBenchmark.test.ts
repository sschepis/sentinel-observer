/**
 * @jest-environment node
 *
 * CDE-BENCH (improvements.md §2.4 / Phase A.8) — candidate-distribution
 * entropy as a pure instrument.
 *
 * Logs H̃ and the top-two margin on the decisions the existing benches make
 * (recall, fuzz, chain, adversarial, council) WITHOUT routing on them, then
 * measures the instrument's discriminative power:
 *   · fuzz — AUC of H̃ vs. the top recall score on true-match / distractor
 *     pairs (does the distribution shape add anything over the top score?);
 *   · chain — path entropy over the is-a paths to a target (multi-route
 *     support vs. a single hedged route).
 *
 * The test asserts only structural invariants (readings land in [0, 1], the
 * multi-path case reads higher entropy than the single-path case); the
 * pass/refute comparison — whether H̃ separates better than the top score —
 * is REPORTED, not hard-gated here, so the experiment's own answer (which
 * §2.4 explicitly leaves open) is what the logs record.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { normalizedEntropy, readCde } from './cde';
import { isAPaths, isATypeOf } from './chain';
import { ObserverNetwork } from './network';
import { CONVERSATION_DECK, CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';
import type { Relation } from './relations';

const BIG_K = 100_000;

const DECK: readonly DeckWord[] = [
  { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
  { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' },
  { word: 'sparrow', definition: 'a small bird that lives near houses', example: 'A sparrow sings.' },
  { word: 'wings', definition: 'a part of a bird used for flying', example: 'Wings flap.' },
  { word: 'dog', definition: 'a common animal with four legs that people keep as a pet', example: 'The dog barks.' },
  { word: 'puppy', definition: 'a young dog that is small and playful', example: 'The puppy runs.' },
  { word: 'apple', definition: 'a round red or green fruit', example: 'I eat an apple.' },
  { word: 'pear', definition: 'a sweet yellow or green fruit', example: 'I like pears.' },
  { word: 'fruit', definition: 'a sweet part of a plant with seeds', example: 'I like fruit.' },
  { word: 'seeds', definition: 'a small part of a plant that can grow', example: 'Seeds grow.' },
  { word: 'water', definition: 'a clear liquid that falls as rain and is used for drinking', example: 'Water is wet.' },
  { word: 'snow', definition: 'frozen white water that falls from the sky', example: 'Snow is cold.' },
  { word: 'game', definition: 'a contest with rules that people play to win', example: 'We play a game.' },
  { word: 'rules', definition: 'a set of instructions for playing a game', example: 'Rules matter.' },
  { word: 'tennis', definition: 'a game played with a ball and a racket', example: 'Tennis needs a racket.' }
];

function options() {
  return {
    primeCount: 64,
    gridSize: 128,
    memoryMode: 'compact' as const,
    smfWidth: 128,
    vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
  };
}

/** Mann–Whitney AUC: P(a random positive scores above a random negative). */
function auc(positive: readonly number[], negative: readonly number[]): number {
  if (positive.length === 0 || negative.length === 0) return 0.5;
  let rank = 0;
  for (const p of positive) {
    for (const n of negative) {
      if (p > n) rank += 1;
      else if (p === n) rank += 0.5;
    }
  }
  return rank / (positive.length * negative.length);
}

describe('cde-bench: candidate-distribution entropy instrumentation (Phase A)', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeAll(async () => {
    session = new ObserverSession(options(), 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DECK);
    for (const entry of DECK) teacher.teach(entry.word);
    teacher.teachConversationDeck(CONVERSATION_DECK);
    for (const pair of CONVERSATION_DECK) teacher.respond(pair.cue);
  }, 120000);

  afterAll(() => {
    session.dispose();
  });

  it('recall: logs H̃ and the top-two margin over the full scored candidate list', () => {
    const words = teacher.listWords().filter((w) => w.traceId !== null);
    const rows: string[] = [];
    let minH = 1;
    let maxH = 0;
    for (const state of words) {
      teacher.exciteAndSettle(state.word.word);
      const results = session.recall(state.word.word, BIG_K);
      const reading = readCde(results.map((r) => r.score));
      expect(reading.entropy).toBeGreaterThanOrEqual(0);
      expect(reading.entropy).toBeLessThanOrEqual(1);
      expect(reading.topTwoMargin).toBeGreaterThanOrEqual(0);
      expect(reading.topTwoMargin).toBeLessThanOrEqual(1);
      minH = Math.min(minH, reading.entropy);
      maxH = Math.max(maxH, reading.entropy);
      rows.push(
        `${state.word.word.padEnd(9)} k=${String(reading.k).padStart(3)} H̃=${reading.entropy.toFixed(3)} m=${reading.topTwoMargin.toFixed(3)}`
      );
    }
    // eslint-disable-next-line no-console
    console.log(`\nCDE recall (${rows.length} cues, full scored list):`);
    for (const row of rows) {
      // eslint-disable-next-line no-console
      console.log(`  ${row}`);
    }
    // eslint-disable-next-line no-console
    console.log(`  recall H̃ range [${minH.toFixed(3)}, ${maxH.toFixed(3)}]`);
  });

  it('fuzz: reports AUC of H̃ vs. top score on true-match / distractor pairs', () => {
    const exactTop: number[] = [];
    const exactConfidence: number[] = []; // 1 - H̃: higher = more concentrated
    const distractorTop: number[] = [];
    const distractorConfidence: number[] = [];
    for (const pair of CONVERSATION_DECK) {
      teacher.exciteAndSettle(pair.cue);
      const exact = session.recall(pair.cue, BIG_K).map((r) => r.score);
      const tokens = pair.cue.trim().split(/\s+/);
      tokens[tokens.length - 1] = 'water';
      const swapped = tokens.join(' ');
      teacher.exciteAndSettle(swapped);
      const distractor = session.recall(swapped, BIG_K).map((r) => r.score);

      exactTop.push(exact[0] ?? 0);
      exactConfidence.push(1 - normalizedEntropy(exact));
      distractorTop.push(distractor[0] ?? 0);
      distractorConfidence.push(1 - normalizedEntropy(distractor));
    }
    const aucTop = auc(exactTop, distractorTop);
    const aucEntropy = auc(exactConfidence, distractorConfidence);
    const meanExactH = exactConfidence.map((c) => 1 - c).reduce((a, b) => a + b, 0) / exactConfidence.length;
    const meanDistractorH = distractorConfidence.map((c) => 1 - c).reduce((a, b) => a + b, 0) / distractorConfidence.length;
    // eslint-disable-next-line no-console
    console.log(
      `\nCDE fuzz: ${exactTop.length} true-match / ${distractorTop.length} distractor pairs` +
        `\n  AUC(top score) = ${aucTop.toFixed(3)}` +
        `\n  AUC(1 - H̃)    = ${aucEntropy.toFixed(3)}` +
        `\n  mean H̃ true-match ${meanExactH.toFixed(3)} vs distractor ${meanDistractorH.toFixed(3)}` +
        `\n  H̃ adds discrimination over top score: ${aucEntropy > aucTop ? 'YES' : 'no'}`
    );
    expect(Number.isFinite(aucTop)).toBe(true);
    expect(Number.isFinite(aucEntropy)).toBe(true);
    expect(aucTop).toBeGreaterThanOrEqual(0);
    expect(aucTop).toBeLessThanOrEqual(1);
    expect(aucEntropy).toBeGreaterThanOrEqual(0);
    expect(aucEntropy).toBeLessThanOrEqual(1);
  });

  it('chain: path entropy over is-a paths (multi-route support vs. single route)', () => {
    const GRAPH: Relation[] = [
      { subject: 'robin', predicate: 'is-a', object: 'bird', source: '', origin: 'regex', strength: 1 },
      { subject: 'bird', predicate: 'is-a', object: 'animal', source: '', origin: 'regex', strength: 1 },
      { subject: 'robin', predicate: 'is-a', object: 'animal', source: '', origin: 'regex', strength: 0.5 }
    ];
    // Two independent routes to 'animal' (a direct weak edge + a two-hop
    // strong route); one route to 'bird'.
    const toAnimal = isAPaths(GRAPH, 'robin', 'animal');
    const toBird = isAPaths(GRAPH, 'robin', 'bird');
    expect(toAnimal).toHaveLength(2);
    expect(toBird).toHaveLength(1);
    const animalEntropy = normalizedEntropy(toAnimal.map((p) => p.strength));
    const birdEntropy = normalizedEntropy(toBird.map((p) => p.strength));
    expect(animalEntropy).toBeGreaterThan(birdEntropy);
    expect(birdEntropy).toBe(0); // a single route is fully concentrated

    // Path strengths are the products of edge strengths along the route.
    const direct = toAnimal.find((p) => p.nodes.length === 2)!;
    const viaBird = toAnimal.find((p) => p.nodes.length === 3)!;
    expect(direct.strength).toBeCloseTo(0.5);
    expect(viaBird.strength).toBeCloseTo(1);

    // Path-entropy vs. correctness over a fixed probe set (all answered
    // deterministically; the single-path decision is the ground truth).
    const probes: Array<{ subject: string; object: string; expected: boolean }> = [
      { subject: 'robin', object: 'bird', expected: true },
      { subject: 'robin', object: 'animal', expected: true },
      { subject: 'bird', object: 'animal', expected: true },
      { subject: 'robin', object: 'fish', expected: false },
      { subject: 'bird', object: 'robin', expected: false }
    ];
    const rows: string[] = [];
    for (const probe of probes) {
      const answered = isATypeOf(GRAPH, probe.subject, probe.object);
      const paths = isAPaths(GRAPH, probe.subject, probe.object);
      const entropy = normalizedEntropy(paths.map((p) => p.strength));
      const correct = answered === probe.expected;
      rows.push(
        `${probe.subject}->${probe.object} ${probe.expected ? 'T' : 'F'} answered=${answered} paths=${paths.length} H̃=${entropy.toFixed(3)} ${correct ? 'ok' : 'WRONG'}`
      );
    }
    // eslint-disable-next-line no-console
    console.log('\nCDE chain path entropy vs. correctness:');
    for (const row of rows) {
      // eslint-disable-next-line no-console
      console.log(`  ${row}`);
    }
    // eslint-disable-next-line no-console
    console.log(`  multi-route "robin->animal" H̃=${animalEntropy.toFixed(3)} vs single-route "robin->bird" H̃=${birdEntropy.toFixed(3)}`);
  });

  it('council: reports the candidate-entropy reading over member confidences', async () => {
    const NATURE: readonly DeckWord[] = [
      { word: 'water', definition: 'a clear liquid that falls as rain', example: 'Water is wet.' },
      { word: 'bird', definition: 'an animal with wings', example: 'A bird can fly.' }
    ];
    const DAILY: readonly DeckWord[] = [
      { word: 'house', definition: 'a building where people live', example: 'The house is big.' },
      { word: 'chair', definition: 'a seat with a back', example: 'Sit on the chair.' }
    ];
    const members: Array<{ teacher: TeacherAgent; session: ObserverSession }> = [];
    for (const deck of [NATURE, DAILY]) {
      const memberSession = new ObserverSession(
        { ...options(), vocabulary: deckVocabulary([...DECK, ...NATURE, ...DAILY, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE) },
        100
      );
      await memberSession.initialize();
      const memberTeacher = new TeacherAgent(memberSession, [...DECK, ...deck]);
      for (const entry of [...DECK, ...deck]) memberTeacher.teach(entry.word);
      memberTeacher.teachConversationDeck(CONVERSATION_DECK.slice(0, 20));
      for (const pair of CONVERSATION_DECK.slice(0, 20)) memberTeacher.respond(pair.cue);
      members.push({ teacher: memberTeacher, session: memberSession });
    }
    const council = new ObserverNetwork(
      [
        { name: 'nature', teacher: members[0].teacher },
        { name: 'daily', teacher: members[1].teacher }
      ],
      2,
      0.55
    );
    const probes = ['what is water', 'what is a house', 'is water a person', 'what is zzz'];
    // eslint-disable-next-line no-console
    console.log('\nCDE council candidate-entropy readings:');
    for (const probe of probes) {
      const result = council.respond(probe);
      const { cde } = result;
      expect(Number.isFinite(cde.entropy)).toBe(true);
      expect(cde.entropy).toBeGreaterThanOrEqual(0);
      expect(cde.entropy).toBeLessThanOrEqual(1);
      expect(Number.isFinite(cde.topTwoMargin)).toBe(true);
      // eslint-disable-next-line no-console
      console.log(
        `  ${probe.padEnd(20)} mode=${result.mode.padEnd(9)} H̃=${cde.entropy.toFixed(3)} m=${cde.topTwoMargin.toFixed(3)} m₂₃=${cde.topTwoThreeMargin.toFixed(3)} regime=${cde.regime}`
      );
    }
    for (const { session: memberSession } of members) memberSession.dispose();
  });
});
