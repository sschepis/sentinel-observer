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
import { CDE_TOP_K_KS, normalizedEntropy, readCde, topKEntropy, topTwoMargin, topTwoThreeMargin } from './cde';
import { storeSurprise } from './fsrs';
import { isAPaths, isATypeOf } from './chain';
import type { IsAPath } from './chain';
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

/** Pearson correlation over paired samples. */
function pearson(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return Number.NaN;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const denom = Math.sqrt(sxx * syy);
  return denom === 0 ? 0 : sxy / denom;
}

/** Every instrument variant the fuzz bench scores. */
const FUZZ_VARIANTS: Readonly<Record<string, (scores: readonly number[]) => number>> = {
  'top score': (scores) => scores[0] ?? 0,
  '1 - H̃ (full)': (scores) => 1 - normalizedEntropy(scores),
  '1 - H̃₂': (scores) => 1 - topKEntropy(scores, 2),
  '1 - H̃₃': (scores) => 1 - topKEntropy(scores, 3),
  '1 - H̃₅': (scores) => 1 - topKEntropy(scores, 5),
  '1 - H̃₈': (scores) => 1 - topKEntropy(scores, 8),
  'm (top-two margin)': topTwoMargin,
  'm₂₃ (second-third)': topTwoThreeMargin
};

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

  it('fuzz: reports AUC of every instrument variant vs. the top score', () => {
    const exactByVariant = new Map<string, number[]>();
    const distractorByVariant = new Map<string, number[]>();
    for (const name of Object.keys(FUZZ_VARIANTS)) {
      exactByVariant.set(name, []);
      distractorByVariant.set(name, []);
    }
    for (const pair of CONVERSATION_DECK) {
      teacher.exciteAndSettle(pair.cue);
      const exact = session.recall(pair.cue, BIG_K).map((r) => r.score);
      const tokens = pair.cue.trim().split(/\s+/);
      tokens[tokens.length - 1] = 'water';
      const swapped = tokens.join(' ');
      teacher.exciteAndSettle(swapped);
      const distractor = session.recall(swapped, BIG_K).map((r) => r.score);
      for (const [name, measure] of Object.entries(FUZZ_VARIANTS)) {
        exactByVariant.get(name)!.push(measure(exact));
        distractorByVariant.get(name)!.push(measure(distractor));
      }
    }
    const table: Array<{ name: string; value: number }> = [];
    for (const [name] of Object.entries(FUZZ_VARIANTS)) {
      const value = auc(exactByVariant.get(name)!, distractorByVariant.get(name)!);
      table.push({ name, value });
    }
    table.sort((a, b) => b.value - a.value);
    const aucTop = table.find((row) => row.name === 'top score')!.value;
    // eslint-disable-next-line no-console
    console.log('\nCDE fuzz AUC per variant (true-match vs. distractor):');
    for (const row of table) {
      // eslint-disable-next-line no-console
      console.log(`  ${row.name.padEnd(22)} AUC=${row.value.toFixed(3)}${row.name === 'top score' ? ' (reference)' : ''}`);
    }
    // eslint-disable-next-line no-console
    console.log(`  any variant beats the top score: ${table.some((row) => row.value > aucTop) ? 'YES' : 'no'}`);
    for (const row of table) {
      expect(Number.isFinite(row.value)).toBe(true);
      expect(row.value).toBeGreaterThanOrEqual(0);
      expect(row.value).toBeLessThanOrEqual(1);
    }
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

  it('chain: §4.3 corruption — path mass vs. single-path strength at predicting correctness', () => {
    // Deterministic graph: leaves with varied route redundancy to 'animal'.
    const e = (subject: string, object: string, strength: number): Relation => ({
      subject,
      predicate: 'is-a',
      object,
      source: '',
      origin: 'authored',
      strength
    });
    const GRAPH: Relation[] = [
      e('robin', 'bird', 1), e('bird', 'animal', 1), e('robin', 'animal', 0.5),
      e('sparrow', 'bird', 1), e('sparrow', 'animal', 0.7),
      e('dog', 'mammal', 1), e('mammal', 'animal', 1), e('dog', 'animal', 0.3),
      e('cat', 'mammal', 1), e('cat', 'animal', 0.85),
      e('horse', 'mammal', 0.9),
      e('trout', 'fish', 1), e('fish', 'animal', 1), e('trout', 'vertebrate', 0.9),
      e('vertebrate', 'animal', 1), e('fish', 'vertebrate', 0.8), e('trout', 'animal', 0.45),
      e('salmon', 'fish', 1), e('salmon', 'vertebrate', 0.9),
      e('penguin', 'bird', 1),
      e('hen', 'bird', 1), e('hen', 'farm', 1), e('farm', 'animal', 0.2),
      e('snake', 'reptile', 0.4), e('reptile', 'animal', 0.5), e('snake', 'animal', 0.35),
      e('lamb', 'sheep', 0.9), e('sheep', 'animal', 1), e('sheep', 'mammal', 1), e('lamb', 'mammal', 0.1),
      e('goat', 'mammal', 0.3),
      e('frog', 'amphibian', 0.9), e('amphibian', 'animal', 0.9), e('frog', 'animal', 0.8)
    ];
    const probes = [
      'robin', 'sparrow', 'dog', 'cat', 'horse', 'trout', 'salmon', 'penguin',
      'hen', 'snake', 'lamb', 'goat', 'frog'
    ];
    const corruptStrongestEdge = (paths: readonly IsAPath[]): Relation[] => {
      let bestPath: IsAPath | null = null;
      for (const path of paths) {
        if (bestPath === null || path.strength > bestPath.strength) bestPath = path;
      }
      if (bestPath === null) return [...GRAPH];
      let strongest: { subject: string; object: string; strength: number } | null = null;
      for (let i = 0; i + 1 < bestPath.nodes.length; i += 1) {
        let best = -Infinity;
        for (const relation of GRAPH) {
          if (relation.subject === bestPath.nodes[i] && relation.object === bestPath.nodes[i + 1]) {
            best = Math.max(best, relation.strength ?? 1);
          }
        }
        if (strongest === null || best > strongest.strength) {
          strongest = { subject: bestPath.nodes[i], object: bestPath.nodes[i + 1], strength: best };
        }
      }
      if (strongest === null) return [...GRAPH];
      return GRAPH.filter(
        (relation) => !(relation.subject === strongest!.subject && relation.object === strongest!.object)
      );
    };
    const rows: Array<{ probe: string; single: number; mass: number; entropy: number; flipped: boolean }> = [];
    for (const subject of probes) {
      const paths = isAPaths(GRAPH, subject, 'animal');
      const strengths = paths.map((p) => p.strength);
      const single = strengths.length > 0 ? Math.max(...strengths) : 0;
      const mass = strengths.reduce((a, b) => a + b, 0);
      const entropy = normalizedEntropy(strengths);
      const corrupted = corruptStrongestEdge(paths);
      const stillCorrect = isATypeOf(corrupted, subject, 'animal');
      rows.push({ probe: `${subject}->animal`, single, mass, entropy, flipped: !stillCorrect });
    }
    // eslint-disable-next-line no-console
    console.log('\nCDE chain §4.3 corruption (strongest edge removed):');
    for (const row of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${row.probe.padEnd(16)} single=${row.single.toFixed(2)} mass=${row.mass.toFixed(2)} H̃=${row.entropy.toFixed(2)} -> ${row.flipped ? 'FLIPPED' : 'survived'}`
      );
    }
    const survived = rows.filter((r) => !r.flipped);
    const flipped = rows.filter((r) => r.flipped);
    expect(survived.length).toBeGreaterThan(0);
    expect(flipped.length).toBeGreaterThan(0);
    const aucMass = auc(survived.map((r) => r.mass), flipped.map((r) => r.mass));
    const aucSingle = auc(survived.map((r) => r.single), flipped.map((r) => r.single));
    // eslint-disable-next-line no-console
    console.log(
      `  AUC(path mass) = ${aucMass.toFixed(3)} vs AUC(single-path strength) = ${aucSingle.toFixed(3)}` +
        `\n  path mass predicts post-corruption correctness better: ${aucMass > aucSingle ? 'YES' : 'no'}`
    );
    expect(Number.isFinite(aucMass)).toBe(true);
    expect(Number.isFinite(aucSingle)).toBe(true);
    // On this designed graph the single-path strength cannot distinguish a
    // lone strong route from one backed by a second route — the mass can.
    expect(aucMass).toBeGreaterThan(aucSingle);
  });

  it('§2.3 agreement: store-time surprise correlates with the pre-store recall candidate entropy', async () => {
    const agreeSession = new ObserverSession(options(), 100);
    await agreeSession.initialize();
    const agreeTeacher = new TeacherAgent(agreeSession, DECK);
    const surprises: number[] = [];
    const entropies: number[] = [];
    const topKSamples = new Map<number, number[]>([[2, []], [3, []], [5, []], [8, []]]);
    for (const entry of DECK) {
      // The storage gate's own pre-store recall (agent/wordloop.ts teach):
      // settle, observe the word, tick once, then recall the cue BEFORE storing.
      agreeSession.settleField();
      agreeSession.observeText(entry.word);
      agreeSession.observer.tick(0.02);
      const cueScores = agreeSession
        .recall(entry.word, 5)
        .filter((result) => result.trace.metadata?.kind === undefined)
        .map((result) => result.score);
      surprises.push(storeSurprise(cueScores));
      entropies.push(normalizedEntropy(cueScores));
      for (const k of CDE_TOP_K_KS) topKSamples.get(k)!.push(topKEntropy(cueScores, k));
      agreeTeacher.teach(entry.word);
    }
    agreeSession.dispose();
    const r = pearson(surprises, entropies);
    // eslint-disable-next-line no-console
    console.log(`\nCDE §2.3 agreement (${surprises.length} stores): r(surprise, H̃) = ${r.toFixed(3)}`);
    for (const k of CDE_TOP_K_KS) {
      // eslint-disable-next-line no-console
      console.log(`  r(surprise, H̃_${k}) = ${pearson(surprises, topKSamples.get(k)!).toFixed(3)}`);
    }
    expect(Number.isFinite(r)).toBe(true);
    // The agreement check §2.3 promises: a field measure (store-time surprise)
    // and the decision measure (candidate entropy) must track each other.
    expect(r).toBeGreaterThanOrEqual(0.3);
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
