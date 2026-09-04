#!/usr/bin/env node
/**
 * CDE-BENCH (improvements.md §2.4 / Phase A.8) — candidate-distribution
 * entropy as a pure instrument, measured at scale.
 *
 * Logs H̃ (full-set and top-k), and the top-two / second-to-third margins on
 * the decisions the existing benches make (recall, fuzz, chain, adversarial,
 * council) WITHOUT routing on them, then measures discriminative power:
 *   · fuzz — AUC of EVERY instrument variant (top score, 1 − H̃, 1 − H̃_k for
 *     k ∈ {2,3,5,8}, m, m₂₃) on true-match / distractor pairs, with the
 *     Mann–Whitney standard error so "outside noise" is a test, not a vibe;
 *   · chain — §4.3 path-entropy-bench: corrupt one edge and measure whether
 *     path mass (Σ edge-strength products over is-a paths) predicts
 *     post-corruption correctness better than the single-path strength;
 *   · §2.3 agreement — correlation between store-time surprise (fsrs.ts
 *     `storeSurprise`) and the recall candidate entropy that preceded storage.
 *
 * The regime thresholds are additionally checked against the measured margin
 * distributions (clear vs. flat separation), and the ROUTING VERDICT line
 * records whether any variant beats the top score outside noise — the §2.4 /
 * §11 decision on whether the disambiguating-ask routing may be built.
 *
 * Usage:
 *   npx tsx src/cli/cde-bench.ts [--words N] [--cues N]
 *   CDE_BENCH_WORDS=300 CDE_BENCH_CUES=120 CDE_BENCH_AGREE_WORDS=100 (env)
 */
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation';
import { MemoryPersistenceStore } from '../persistence/store';
import {
  CDE_REGIME_DEFAULTS,
  CDE_TOP_K_KS,
  normalizedEntropy,
  readCde,
  topKEntropy,
  topTwoMargin,
  topTwoThreeMargin
} from '../teacher/cde';
import { storeSurprise } from '../teacher/fsrs';
import { isAPaths, isATypeOf } from '../teacher/chain';
import type { IsAPath } from '../teacher/chain';
import { ObserverNetwork } from '../teacher/network';
import type { Relation } from '../teacher/relations';

const WORDS = Number(process.env.CDE_BENCH_WORDS ?? 300);
const CUE_COUNT = Number(process.env.CDE_BENCH_CUES ?? 120);
const AGREE_WORDS = Number(process.env.CDE_BENCH_AGREE_WORDS ?? 100);
const BIG_K = 100_000;

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

/** Mann–Whitney standard error under the null (Hanley–McNeil, equal cost). */
function aucSe(n: number, m: number): number {
  if (n === 0 || m === 0) return Number.NaN;
  return Math.sqrt((n + m + 1) / (12 * n * m));
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

function minMax(values: readonly number[]): { min: number; max: number; mean: number } {
  if (values.length === 0) return { min: Number.NaN, max: Number.NaN, mean: Number.NaN };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }
  return { min, max, mean: sum / values.length };
}

function sampleCues(count: number): string[] {
  const seen = new Set<string>();
  const cues: string[] = [];
  for (const pair of ALL_CONVERSATION_PAIRS) {
    if (!seen.has(pair.cue)) {
      seen.add(pair.cue);
      cues.push(pair.cue);
    }
  }
  if (cues.length <= count) return cues;
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(cues[Math.floor((i * cues.length) / count)]);
  return out;
}

function summarize(label: string, scores: readonly number[]): void {
  const reading = readCde(scores);
  // eslint-disable-next-line no-console
  console.log(
    `  ${label.padEnd(12)} k=${String(reading.k).padStart(4)} H̃=${reading.entropy.toFixed(3)} ` +
      `H̃₂=${reading.topKEntropy[2].toFixed(3)} H̃₅=${reading.topKEntropy[5].toFixed(3)} ` +
      `m=${reading.topTwoMargin.toFixed(3)} m₂₃=${reading.topTwoThreeMargin.toFixed(3)} regime=${reading.regime}`
  );
}

/** The instrument variants the fuzz bench scores — every reading cde.ts
 *  exposes, so the "does the distribution add anything over the top score"
 *  question is answered per variant, not once for the module. */
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

// ─── §4.3 chain-corruption graph: leaves with varied route redundancy to a
//     grandparent. Single-route leaves flip when their only edge is
//     corrupted; multi-route leaves survive (or flip when every route shares
//     the corrupted edge — the diamond case). Deterministic by construction.
function edge(subject: string, object: string, strength: number): Relation {
  return { subject, predicate: 'is-a', object, source: '', origin: 'authored', strength };
}

const CHAIN_CORRUPTION_GRAPH: readonly Relation[] = [
  // Two independent routes to 'animal' for robin (the test's GRAPH).
  edge('robin', 'bird', 1),
  edge('bird', 'animal', 1),
  edge('robin', 'animal', 0.5),
  // Sparrow: strong chain + strong direct shortcut.
  edge('sparrow', 'bird', 1),
  edge('sparrow', 'animal', 0.7),
  // Dog: chain + weak shortcut.
  edge('dog', 'mammal', 1),
  edge('mammal', 'animal', 1),
  edge('dog', 'animal', 0.3),
  // Cat: chain + near-equal shortcut.
  edge('cat', 'mammal', 1),
  edge('cat', 'animal', 0.85),
  // Horse: single route only.
  edge('horse', 'mammal', 0.9),
  // Trout: fish chain + vertebrate chain + weak direct (diamond corners).
  edge('trout', 'fish', 1),
  edge('fish', 'animal', 1),
  edge('trout', 'vertebrate', 0.9),
  edge('vertebrate', 'animal', 1),
  edge('fish', 'vertebrate', 0.8),
  edge('trout', 'animal', 0.45),
  // Salmon: two chains, no direct.
  edge('salmon', 'fish', 1),
  edge('salmon', 'vertebrate', 0.9),
  // Penguin: single chain only.
  edge('penguin', 'bird', 1),
  // Hen: strong chain + a very weak third route.
  edge('hen', 'bird', 1),
  edge('hen', 'farm', 1),
  edge('farm', 'animal', 0.2),
  // Snake: weak direct + weak chain (both hedged).
  edge('snake', 'reptile', 0.4),
  edge('reptile', 'animal', 0.5),
  edge('snake', 'animal', 0.35),
  // Lamb: diamond — two routes sharing the top edge.
  edge('lamb', 'sheep', 0.9),
  edge('sheep', 'animal', 1),
  edge('sheep', 'mammal', 1),
  edge('lamb', 'mammal', 0.1),
  // Goat: chain only, hedged at every edge.
  edge('goat', 'mammal', 0.3),
  // Frog: two independent strong routes.
  edge('frog', 'amphibian', 0.9),
  edge('amphibian', 'animal', 0.9),
  edge('frog', 'animal', 0.8)
];

const CHAIN_TRUE_PROBES: ReadonlyArray<{ subject: string; object: string }> = [
  { subject: 'robin', object: 'animal' },
  { subject: 'sparrow', object: 'animal' },
  { subject: 'dog', object: 'animal' },
  { subject: 'cat', object: 'animal' },
  { subject: 'horse', object: 'animal' },
  { subject: 'trout', object: 'animal' },
  { subject: 'salmon', object: 'animal' },
  { subject: 'penguin', object: 'animal' },
  { subject: 'hen', object: 'animal' },
  { subject: 'snake', object: 'animal' },
  { subject: 'lamb', object: 'animal' },
  { subject: 'goat', object: 'animal' },
  { subject: 'frog', object: 'animal' }
];

/** Remove the strongest edge lying on the strongest path. */
function corruptStrongestEdge(relations: readonly Relation[], paths: readonly IsAPath[]): Relation[] {
  let bestPath: IsAPath | null = null;
  for (const path of paths) {
    if (bestPath === null || path.strength > bestPath.strength) bestPath = path;
  }
  if (bestPath === null) return [...relations];
  let strongestEdge: { subject: string; object: string; strength: number } | null = null;
  for (let i = 0; i + 1 < bestPath.nodes.length; i += 1) {
    let best = -Infinity;
    for (const relation of relations) {
      if (
        relation.predicate === 'is-a' &&
        relation.subject === bestPath.nodes[i] &&
        relation.object === bestPath.nodes[i + 1]
      ) {
        best = Math.max(best, relation.strength ?? 1);
      }
    }
    if (strongestEdge === null || best > strongestEdge.strength) {
      strongestEdge = { subject: bestPath.nodes[i], object: bestPath.nodes[i + 1], strength: best };
    }
  }
  if (strongestEdge === null) return [...relations];
  return relations.filter(
    (relation) =>
      !(
        relation.predicate === 'is-a' &&
        relation.subject === strongestEdge!.subject &&
        relation.object === strongestEdge!.object
      )
  );
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[cde-bench] words=${WORDS} cues=${CUE_COUNT} pairs=${ALL_CONVERSATION_PAIRS.length}`);

  const session = new ObserverSession(OBSERVER_OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 500);
  for (const entry of ACTIVE_DECK.slice(0, WORDS)) teacher.teach(entry.word);
  teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS);
  for (const pair of ALL_CONVERSATION_PAIRS) teacher.respond(pair.cue);

  // ── RECALL: H̃ / H̃_k / m over the full scored candidate list ─────────────
  // eslint-disable-next-line no-console
  console.log('\n═══ RECALL candidate distributions (full scored list) ═══');
  const sample = ACTIVE_DECK.slice(0, WORDS).filter((_, i) => i % Math.ceil(WORDS / 12) === 0);
  const recallMargins: number[] = [];
  for (const entry of sample) {
    teacher.exciteAndSettle(entry.word);
    const scores = session.recall(entry.word, BIG_K).map((r) => r.score);
    recallMargins.push(topTwoMargin(scores));
    summarize(entry.word, scores);
  }

  // ── FUZZ: AUC of every instrument variant on true-match / distractor ─────
  // eslint-disable-next-line no-console
  console.log('\n═══ FUZZ discriminative power (AUC per variant) ═══');
  const exactByVariant = new Map<string, number[]>();
  const distractorByVariant = new Map<string, number[]>();
  for (const name of Object.keys(FUZZ_VARIANTS)) {
    exactByVariant.set(name, []);
    distractorByVariant.set(name, []);
  }
  const exactMargins: number[] = [];
  const distractorMargins: number[] = [];
  for (const cue of sampleCues(CUE_COUNT)) {
    teacher.exciteAndSettle(cue);
    const exact = session.recall(cue, BIG_K).map((r) => r.score);
    const tokens = cue.trim().split(/\s+/);
    tokens[tokens.length - 1] = 'water';
    const swapped = tokens.join(' ');
    teacher.exciteAndSettle(swapped);
    const distractor = session.recall(swapped, BIG_K).map((r) => r.score);
    exactMargins.push(topTwoMargin(exact));
    distractorMargins.push(topTwoMargin(distractor));
    for (const [name, measure] of Object.entries(FUZZ_VARIANTS)) {
      exactByVariant.get(name)!.push(measure(exact));
      distractorByVariant.get(name)!.push(measure(distractor));
    }
  }
  const se = aucSe(exactMargins.length, distractorMargins.length);
  const table: Array<{ name: string; value: number }> = [];
  for (const [name] of Object.entries(FUZZ_VARIANTS)) {
    const value = auc(exactByVariant.get(name)!, distractorByVariant.get(name)!);
    table.push({ name, value });
  }
  table.sort((a, b) => b.value - a.value);
  const aucTop = table.find((row) => row.name === 'top score')!.value;
  // eslint-disable-next-line no-console
  console.log(`  ${'variant'.padEnd(22)} ${'AUC'.padStart(7)}  vs-top  verdict (|AUC−0.5| > 2σ, σ=${se.toFixed(3)})`);
  let beaten = false;
  for (const row of table) {
    const delta = row.value - aucTop;
    const outsideNoise = Math.abs(row.value - 0.5) > 2 * se;
    const beatsTop = delta > 2 * se;
    if (beatsTop) beaten = true;
    // eslint-disable-next-line no-console
    console.log(
      `  ${row.name.padEnd(22)} ${row.value.toFixed(3).padStart(7)} ${(delta >= 0 ? '+' : '') + delta.toFixed(3).padStart(7)}  ` +
        `${outsideNoise ? (beatsTop ? 'BEATS TOP' : 'signal, below top') : 'noise'}`
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    beaten
      ? '  ROUTING VERDICT: a variant beats the top score outside noise — the disambiguating-ask routing is data-justified.'
      : '  ROUTING VERDICT: REFUTED — no variant beats the top score outside noise; per §2.4/§11 the\n' +
        '    disambiguating-ask routing must NOT be built, and the candidate distribution carries\n' +
        '    nothing the top score does not (recorded as the Phase A refutation).'
  );

  // ── CHAIN: path entropy over the taught deck's is-a paths ────────────────
  // eslint-disable-next-line no-console
  console.log('\n═══ CHAIN path entropy (is-a routes to a target) ═══');
  const relations: Relation[] = teacher.relations();
  const chainProbes: Array<{ subject: string; object: string }> = [];
  for (const relation of relations.filter((r) => r.predicate === 'is-a')) {
    chainProbes.push({ subject: relation.subject, object: relation.object });
    if (chainProbes.length >= 10) break;
  }
  for (const probe of chainProbes) {
    const paths = isAPaths(relations, probe.subject, probe.object);
    const entropy = normalizedEntropy(paths.map((p) => p.strength));
    const answered = isATypeOf(relations, probe.subject, probe.object);
    // eslint-disable-next-line no-console
    console.log(
      `  ${probe.subject}->${probe.object} answered=${answered} paths=${String(paths.length).padStart(2)} H̃=${entropy.toFixed(3)}`
    );
  }

  // ── CHAIN CORRUPTION: does path mass predict correctness better than the
  //    single-path strength? (§4.3 path-entropy-bench) ──────────────────────
  // eslint-disable-next-line no-console
  console.log('\n═══ CHAIN §4.3: corrupt one edge — what predicts surviving it? ═══');
  const chainRows: Array<{
    probe: string;
    paths: number;
    single: number;
    mass: number;
    entropy: number;
    flipped: boolean;
  }> = [];
  for (const probe of CHAIN_TRUE_PROBES) {
    const paths = isAPaths([...CHAIN_CORRUPTION_GRAPH], probe.subject, probe.object);
    const strengths = paths.map((p) => p.strength);
    const single = strengths.length > 0 ? Math.max(...strengths) : 0;
    const mass = strengths.reduce((a, b) => a + b, 0);
    const entropy = normalizedEntropy(strengths);
    const corrupted = corruptStrongestEdge(CHAIN_CORRUPTION_GRAPH, paths);
    const stillCorrect = isATypeOf(corrupted, probe.subject, probe.object);
    chainRows.push({ probe: `${probe.subject}->${probe.object}`, paths: paths.length, single, mass, entropy, flipped: !stillCorrect });
  }
  for (const row of chainRows) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${row.probe.padEnd(20)} paths=${String(row.paths).padStart(2)} single=${row.single.toFixed(2)} ` +
        `mass=${row.mass.toFixed(2)} H̃=${row.entropy.toFixed(2)} -> ${row.flipped ? 'FLIPPED (wrong)' : 'survived'}`
    );
  }
  const survived = chainRows.filter((r) => !r.flipped);
  const flipped = chainRows.filter((r) => r.flipped);
  const aucMass = auc(survived.map((r) => r.mass), flipped.map((r) => r.mass));
  const aucSingle = auc(survived.map((r) => r.single), flipped.map((r) => r.single));
  const aucCount = auc(survived.map((r) => r.paths), flipped.map((r) => r.paths));
  const aucEntropy = auc(survived.map((r) => 1 - r.entropy), flipped.map((r) => 1 - r.entropy));
  // eslint-disable-next-line no-console
  console.log(
    `  AUC(path mass)            = ${aucMass.toFixed(3)}` +
      `\n  AUC(single-path strength) = ${aucSingle.toFixed(3)}` +
      `\n  AUC(path count)           = ${aucCount.toFixed(3)}` +
      `\n  AUC(1 - path H̃)           = ${aucEntropy.toFixed(3)}` +
      `\n  path mass predicts post-corruption correctness better than the single-path strength: ` +
      `${aucMass > aucSingle ? 'YES' : 'no'}`
  );

  // ── ADVERSARIAL: H̃ / m on the honesty probes ─────────────────────────────
  // eslint-disable-next-line no-console
  console.log('\n═══ ADVERSARIAL recall readings ═══');
  const adversarialMargins: number[] = [];
  for (const probe of ['is a bird a quargle', 'is snow a vehicle', 'does a bird have wheels', 'what is zzz']) {
    teacher.exciteAndSettle(probe);
    const scores = session.recall(probe, BIG_K).map((r) => r.score);
    adversarialMargins.push(topTwoMargin(scores));
    summarize(probe, scores);
  }

  // ── REGIME CALIBRATION check: do the measured margins separate the
  //    regimes, and do the recorded thresholds sit inside the gap? ──────────
  // eslint-disable-next-line no-console
  console.log('\n═══ REGIME CALIBRATION (m over the clear vs. flat class exemplars) ═══');
  const exactM = minMax(exactMargins);
  const adversarialM = minMax(adversarialMargins);
  const distractorM = minMax(distractorMargins);
  // eslint-disable-next-line no-console
  console.log(
    `  fuzz conversation cues (unlabeled mix): m ∈ [${exactM.min.toFixed(3)}, ${exactM.max.toFixed(3)}] mean ${exactM.mean.toFixed(3)}` +
      `\n  distractor cues:                       m ∈ [${distractorM.min.toFixed(3)}, ${distractorM.max.toFixed(3)}] mean ${distractorM.mean.toFixed(3)}` +
      `\n  adversarial (flat class):              m ∈ [${adversarialM.min.toFixed(3)}, ${adversarialM.max.toFixed(3)}] mean ${adversarialM.mean.toFixed(3)}`
  );
  // The clear class is bounded by the deck-word exact recalls; ambiguous
  // recalls at or below the flat ceiling belong to the flat/disambiguate
  // side (e.g. 'the') and are excluded from the clear bound.
  const flatBound = adversarialM.max;
  const clearSide = recallMargins.filter((m) => m > flatBound);
  const clearBound = clearSide.length > 0 ? Math.min(...clearSide) : Number.NaN;
  // eslint-disable-next-line no-console
  console.log(
    `  deck-word recalls (clear class):       m ∈ [${minMax(recallMargins).min.toFixed(3)}, ${minMax(recallMargins).max.toFixed(3)}]` +
      `; ambiguous below flat ceiling ${flatBound.toFixed(3)}: ${recallMargins.filter((m) => m <= flatBound).length}`
  );
  const separation = clearSide.length > 0 && clearBound > flatBound;
  const midpoint = (flatBound + clearBound) / 2;
  const threshold = CDE_REGIME_DEFAULTS.topTwoMargin;
  const inGap = threshold > flatBound && threshold < clearBound;
  // eslint-disable-next-line no-console
  console.log(
    separation
      ? `  clear/flat separation: YES — flat m ≤ ${flatBound.toFixed(3)}, clear m ≥ ${clearBound.toFixed(3)}, ` +
          `gap midpoint ${midpoint.toFixed(3)}; recorded topTwoMargin=${threshold.toFixed(3)} ${inGap ? 'sits inside the gap' : 'OUTSIDE THE GAP — recalibrate'}`
      : '  clear/flat separation: NO — the margin distributions overlap; the regime thresholds must stay placeholders'
  );
  // eslint-disable-next-line no-console
  console.log('  m₂₃ (disambiguate): no two-dominant-candidate corpus in this bench — threshold stays placeholder');

  session.dispose();

  // ── COUNCIL: candidate-entropy over member confidences ────────────────────
  // eslint-disable-next-line no-console
  console.log('\n═══ COUNCIL candidate-entropy readings ═══');
  const memberSpecs: Array<{ name: string; words: string[] }> = [
    { name: 'nature', words: ['water', 'bird', 'tree', 'sky'] },
    { name: 'daily', words: ['house', 'chair', 'table', 'clothes'] },
    { name: 'mind', words: ['thought', 'word', 'memory', 'question'] }
  ];
  const councilMembers: Array<{ teacher: TeacherAgent; session: ObserverSession }> = [];
  for (const spec of memberSpecs) {
    const memberSession = new ObserverSession(OBSERVER_OPTIONS, 100);
    await memberSession.initialize();
    const deck = ACTIVE_DECK.filter((d) => spec.words.includes(d.word));
    const memberTeacher = new TeacherAgent(memberSession, ACTIVE_DECK, new MemoryPersistenceStore(), 500);
    for (const entry of deck) memberTeacher.teach(entry.word);
    memberTeacher.teachConversationDeck(ALL_CONVERSATION_PAIRS.slice(0, 150));
    for (const pair of ALL_CONVERSATION_PAIRS.slice(0, 150)) memberTeacher.respond(pair.cue);
    councilMembers.push({ teacher: memberTeacher, session: memberSession });
  }
  const council = new ObserverNetwork(
    councilMembers.map((m, i) => ({ name: memberSpecs[i].name, teacher: m.teacher })),
    3,
    0.55
  );
  for (const probe of ['what is water', 'what is a house', 'is water a person', 'what is zzz']) {
    const result = council.respond(probe);
    // eslint-disable-next-line no-console
    console.log(
      `  ${probe.padEnd(18)} mode=${result.mode.padEnd(9)} H̃=${result.cde.entropy.toFixed(3)} ` +
        `m=${result.cde.topTwoMargin.toFixed(3)} regime=${result.cde.regime}`
    );
  }
  for (const { session: memberSession } of councilMembers) memberSession.dispose();

  // ── §2.3 AGREEMENT: store-time surprise vs. the recall candidate entropy
  //    that preceded storage ────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log(`\n═══ §2.3 AGREEMENT: surprise ↔ pre-store recall entropy (${AGREE_WORDS} words) ═══`);
  const agreeSession = new ObserverSession(OBSERVER_OPTIONS, 100);
  await agreeSession.initialize();
  const agreeTeacher = new TeacherAgent(agreeSession, ACTIVE_DECK, new MemoryPersistenceStore(), 500);
  const surpriseSamples: number[] = [];
  const entropySamples: number[] = [];
  const topKSamples = new Map<number, number[]>([[2, []], [3, []], [5, []], [8, []]]);
  for (const entry of ACTIVE_DECK.slice(0, AGREE_WORDS)) {
    // Replicate the storage gate's pre-store recall (agent/wordloop.ts teach):
    // settle, observe the word, tick once, then recall its cue against the
    // bank BEFORE storing.
    agreeSession.settleField();
    agreeSession.observeText(entry.word);
    agreeSession.observer.tick(0.02);
    const cueScores = agreeSession
      .recall(entry.word, 5)
      .filter((result) => result.trace.metadata?.kind === undefined)
      .map((result) => result.score);
    surpriseSamples.push(storeSurprise(cueScores));
    entropySamples.push(normalizedEntropy(cueScores));
    for (const k of CDE_TOP_K_KS) topKSamples.get(k)!.push(topKEntropy(cueScores, k));
    agreeTeacher.teach(entry.word);
  }
  const rFull = pearson(surpriseSamples, entropySamples);
  // eslint-disable-next-line no-console
  console.log(`  r(surprise, H̃ full-set) = ${rFull.toFixed(3)}`);
  for (const k of CDE_TOP_K_KS) {
    // eslint-disable-next-line no-console
    console.log(`  r(surprise, H̃_${k})        = ${pearson(surpriseSamples, topKSamples.get(k)!).toFixed(3)}`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `  §2.3 agreement: store-time surprise and the pre-store recall candidate entropy ` +
      `${rFull >= 0.5 ? 'CORRELATE (the two readings agree)' : rFull > 0 ? 'correlate weakly' : 'DO NOT correlate — one of them is not measuring what it claims'}`
  );
  agreeSession.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
