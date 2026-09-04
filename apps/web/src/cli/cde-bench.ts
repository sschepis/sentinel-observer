#!/usr/bin/env node
/**
 * CDE-BENCH (improvements.md §2.4 / Phase A.8) — candidate-distribution
 * entropy as a pure instrument, measured at scale.
 *
 * Logs H̃ and the top-two margin on the decisions the existing benches make
 * (recall, fuzz, chain, adversarial, council) WITHOUT routing on them, then
 * measures discriminative power:
 *   · fuzz — AUC of H̃ vs. the top recall score on true-match / distractor
 *     pairs;
 *   · chain — path entropy over the is-a paths to a target.
 *
 * Usage:
 *   npx tsx src/cli/cde-bench.ts [--words N] [--cues N]
 *   CDE_BENCH_WORDS=300 CDE_BENCH_CUES=200 (env overrides)
 */
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation';
import { MemoryPersistenceStore } from '../persistence/store';
import { normalizedEntropy, readCde } from '../teacher/cde';
import { isAPaths, isATypeOf } from '../teacher/chain';
import { ObserverNetwork } from '../teacher/network';
import type { Relation } from '../teacher/relations';

const WORDS = Number(process.env.CDE_BENCH_WORDS ?? 300);
const CUE_COUNT = Number(process.env.CDE_BENCH_CUES ?? 120);
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
      `m=${reading.topTwoMargin.toFixed(3)} m₂₃=${reading.topTwoThreeMargin.toFixed(3)} regime=${reading.regime}`
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

  // ── RECALL: H̃ / m over the full scored candidate list ────────────────────
  // eslint-disable-next-line no-console
  console.log('\n═══ RECALL candidate distributions (full scored list) ═══');
  const sample = ACTIVE_DECK.slice(0, WORDS).filter((_, i) => i % Math.ceil(WORDS / 12) === 0);
  for (const entry of sample) {
    teacher.exciteAndSettle(entry.word);
    summarize(entry.word, session.recall(entry.word, BIG_K).map((r) => r.score));
  }

  // ── FUZZ: AUC of H̃ vs. top score on true-match / distractor pairs ───────
  // eslint-disable-next-line no-console
  console.log('\n═══ FUZZ discriminative power (AUC) ═══');
  const exactTop: number[] = [];
  const exactConfidence: number[] = [];
  const distractorTop: number[] = [];
  const distractorConfidence: number[] = [];
  for (const cue of sampleCues(CUE_COUNT)) {
    teacher.exciteAndSettle(cue);
    const exact = session.recall(cue, BIG_K).map((r) => r.score);
    const tokens = cue.trim().split(/\s+/);
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
  // eslint-disable-next-line no-console
  console.log(`  AUC(top score) = ${aucTop.toFixed(3)}`);
  // eslint-disable-next-line no-console
  console.log(`  AUC(1 - H̃)    = ${aucEntropy.toFixed(3)}`);
  // eslint-disable-next-line no-console
  console.log(`  H̃ adds discrimination over top score: ${aucEntropy > aucTop ? 'YES' : 'no'}`);

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

  // ── ADVERSARIAL: H̃ / m on the honesty probes ─────────────────────────────
  // eslint-disable-next-line no-console
  console.log('\n═══ ADVERSARIAL recall readings ═══');
  for (const probe of ['is a bird a quargle', 'is snow a vehicle', 'does a bird have wheels', 'what is zzz']) {
    teacher.exciteAndSettle(probe);
    summarize(probe, session.recall(probe, BIG_K).map((r) => r.score));
  }

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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
