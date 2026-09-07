/**
 * @jest-environment node
 *
 * NULL-MODEL ARMS FOR THE MEMORY SUBSTRATE (IMPROVEMENT_PLAN.md §2.1, Rule 1).
 *
 * Every term the recall blend scores, and the dynamics that feed it, runs
 * here against a matched null — the same computation with the interesting
 * part removed — so the paper's §3.1/§5.1 can report deltas over nulls
 * instead of raw numbers. The arms:
 *
 *   control     the production field (observer/options.ts values) at the bench's size
 *   smf-off     smfWeight 0 — recall is the prime-overlap index alone
 *   overlap-off overlapWeight 0 — recall is the SMF sketch alone
 *   coupling-0  Kuramoto coupling 0 — the oscillators never interact
 *   static      coupling 0 + per-moment sketch imprint (no EMA trajectory):
 *               an inverted index plus a static random projection of the
 *               prime bag — the matched no-dynamics baseline
 *
 * Measured per arm on the same deck slice and the same seeded probes:
 *   · identity recall     recognition cue (the word) → its own trace, top-1
 *   · semantic recall     production cue (the definition) → the word's trace
 *   · fuzz                seeded last-word distractors over the taught
 *                         conversation pairs: false positives at confidence
 *                         ≥ 0.8 over EVERY distractor asked (not only the
 *                         ones that answered), and the mean true−distractor
 *                         margin
 *   · teach cost          ms per word
 *
 * Each arm writes a JSON artifact to bench/null-arms/<arm>-w<N>.json keyed
 * by commit (Rule 5: numbers in prose trace to artifacts). Nothing here is
 * hard-gated except finiteness — the verdict is the table, and the paper
 * quotes the table.
 *
 * Run:  NULL_ARMS_WORDS=1000 NULL_ARMS_ARMS=control,smf-off NULL_ARMS_FUZZ_PAIRS=80 npm run null-arms-bench
 * (one arm at ~1k words is ≈ 1–2 minutes: every ask/respond settles the field)
 * (deliberately excluded from `npm test` — it is a measurement, not a unit).
 */
import { describe, it, expect } from '@jest/globals';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32 } from '@sschepis/sentient-core';
import type { SemanticObserverOptions } from '@sschepis/sentient-core';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { ACTIVE_DECK } from './decks';
import { ALL_CONVERSATION_PAIRS, CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE } from './primeSignature';
import { semanticVocabulary } from './semanticSignature';
import type { DeckWord } from './deck';

const WORDS = Math.max(20, Number(process.env.NULL_ARMS_WORDS ?? 300));
const SEED = Number(process.env.NULL_ARMS_SEED ?? 0x5eed);
const FUZZ_PER_PAIR = 3;
/** Conversation pairs probed by the fuzz (a seeded sample of the 728 taught
 *  pairs — every `respond` settles the field, ~30 ms at 256 primes). */
const FUZZ_PAIRS = Math.max(10, Number(process.env.NULL_ARMS_FUZZ_PAIRS ?? 80));
/** Words probed for identity/semantic recall (a seeded sample of the taught
 *  slice; every ask settles the field, so the probe count bounds the run). */
const RECALL_PROBES = Math.max(20, Number(process.env.NULL_ARMS_PROBES ?? 300));

type ArmName = 'control' | 'smf-off' | 'overlap-off' | 'coupling-0' | 'static';

const ARM_OVERRIDES: Record<ArmName, Partial<SemanticObserverOptions>> = {
  control: {},
  'smf-off': { memoryBankOptions: { smfWeight: 0 } },
  'overlap-off': { memoryBankOptions: { overlapWeight: 0 } },
  'coupling-0': { coupling: 0 },
  static: { coupling: 0, smfMomentImprint: true }
};

const requested = (process.env.NULL_ARMS_ARMS ?? 'control,smf-off,overlap-off,coupling-0,static')
  .split(',')
  .map((arm) => arm.trim())
  .filter((arm): arm is ArmName => arm in ARM_OVERRIDES);

const DECK: readonly DeckWord[] = ACTIVE_DECK.slice(0, WORDS).map((entry) => ({ ...entry }));

function commitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

interface ArmResult {
  arm: ArmName;
  words: number;
  identity: { correct: number; n: number };
  semantic: { correct: number; n: number };
  fuzz: {
    pairs: number;
    exactRecalled: number;
    distractors: number;
    /** False positives at the production confidence gate (0.8). */
    falsePositives: number;
    meanMargin: number | null;
    /** Threshold-free separation: P(true score > distractor score) over all
     *  true×distractor pairs (ties count half) — the ROC AUC. A term that only
     *  shifts scores relative to a fixed gate leaves this unchanged; a term
     *  that separates content moves it. */
    auc: number | null;
    /** False positives at the highest gate that still recalls EVERY exact cue
     *  (the matched-calibration reading of the fixed-gate number above). */
    falsePositivesAtMatchedGate: number;
    matchedGate: number | null;
  };
  teachMsPerWord: number;
}

async function runArm(arm: ArmName): Promise<ArmResult> {
  // The production field (observer/options.ts OBSERVER_OPTIONS) restated
  // value for value — importing the module would build the 20k-word
  // production vocabulary at load, which is the one part of the production
  // configuration this bench replaces (the deck slice's vocabulary below).
  const options: SemanticObserverOptions = {
    primeCount: 256,
    gridSize: 512,
    memoryMode: 'compact',
    memoryCapacity: 50000,
    smfWidth: 128,
    smfImprintWeighting: 'linear',
    // The bench vocabulary is the deck slice plus the conversation cue
    // tokens — the same scheme production uses, at the bench's size.
    vocabulary: semanticVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((word) => ({ word }))], PRIME_SPACE),
    ...ARM_OVERRIDES[arm]
  };
  const session = new ObserverSession(options, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, DECK);

  const started = Date.now();
  for (const entry of DECK) teacher.teach(entry.word);
  const teachMsPerWord = (Date.now() - started) / DECK.length;
  teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS);

  // Identity recall: the word cues its own trace. Probed on a seeded,
  // arm-independent sample of the taught words (the same words in every arm).
  const allStates = teacher.listWords().filter((w) => w.traceId !== null);
  const probeRng = mulberry32(SEED ^ 0x9e3779b9);
  const shuffledStates = [...allStates];
  for (let i = shuffledStates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(probeRng() * (i + 1));
    [shuffledStates[i], shuffledStates[j]] = [shuffledStates[j], shuffledStates[i]];
  }
  const states = shuffledStates.slice(0, Math.min(RECALL_PROBES, shuffledStates.length));
  let identityCorrect = 0;
  for (const state of states) {
    const answer = teacher.ask(state.word.word, 'recognition');
    if (answer.recall !== null && answer.recall.trace.id === state.traceId) identityCorrect += 1;
  }

  // Semantic recall: the definition cues the word's trace.
  const defined = states.filter((w) => (w.word.definition ?? '').trim().length > 0);
  let semanticCorrect = 0;
  for (const state of defined) {
    const answer = teacher.ask(state.word.word, 'production');
    if (answer.recall !== null && answer.recall.trace.id === state.traceId) semanticCorrect += 1;
  }

  // Fuzz: seeded last-word distractors over every taught pair; every
  // distractor counts in the denominator.
  const rng = mulberry32(SEED);
  const fillers = DECK.map((entry) => entry.word);
  // The probed pairs: a seeded, arm-independent sample (same pairs, same
  // fillers in every arm — the arms differ only in the observer).
  const shuffled = [...ALL_CONVERSATION_PAIRS];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const probed = shuffled.slice(0, Math.min(FUZZ_PAIRS, shuffled.length));
  let exactRecalled = 0;
  let distractors = 0;
  let falsePositives = 0;
  const margins: number[] = [];
  const trueScores: number[] = [];
  const distractorScores: number[] = [];
  for (const pair of probed) {
    const exact = teacher.respond(pair.cue);
    const exactConf = exact.confidence ?? 0;
    if (exact.response !== null) exactRecalled += 1;
    trueScores.push(exactConf);
    const words = pair.cue.split(' ');
    let bestDistractor = 0;
    for (let d = 0; d < FUZZ_PER_PAIR; d += 1) {
      const filler = fillers[Math.floor(rng() * fillers.length)] ?? 'sky';
      const distractor = [...words.slice(0, -1), filler].join(' ');
      if (distractor === pair.cue) continue;
      distractors += 1;
      const hit = teacher.respond(distractor);
      const conf = hit.response !== null ? hit.confidence ?? 0 : 0;
      if (conf >= 0.8) falsePositives += 1;
      distractorScores.push(conf);
      bestDistractor = Math.max(bestDistractor, conf);
    }
    margins.push(exactConf - bestDistractor);
  }
  session.dispose();

  // Threshold-free separation and the matched-calibration reading.
  let auc: number | null = null;
  if (trueScores.length > 0 && distractorScores.length > 0) {
    let mass = 0;
    for (const t of trueScores) for (const d of distractorScores) mass += t > d ? 1 : t === d ? 0.5 : 0;
    auc = mass / (trueScores.length * distractorScores.length);
  }
  // The matched gate is the lowest score among the exact cues that WERE
  // recalled: a cue the arm missed outright (score 0) is counted in
  // `exactRecalled`, not allowed to drag the gate to zero.
  const recalledTrue = trueScores.filter((t) => t > 0);
  const matchedGate = recalledTrue.length > 0 ? Math.min(...recalledTrue) : null;
  const falsePositivesAtMatchedGate = matchedGate === null ? 0 : distractorScores.filter((d) => d >= matchedGate).length;

  return {
    arm,
    words: DECK.length,
    identity: { correct: identityCorrect, n: states.length },
    semantic: { correct: semanticCorrect, n: defined.length },
    fuzz: {
      pairs: probed.length,
      exactRecalled,
      distractors,
      falsePositives,
      meanMargin: margins.length > 0 ? margins.reduce((a, b) => a + b, 0) / margins.length : null,
      auc,
      falsePositivesAtMatchedGate,
      matchedGate
    },
    teachMsPerWord
  };
}

const pct = (part: number, whole: number): string => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : 'n/a');

describe(`null-model arms for the memory substrate (${WORDS} words, seed ${SEED})`, () => {
  const results: ArmResult[] = [];
  const outDir = join(process.cwd(), '..', '..', 'bench', 'null-arms');

  for (const arm of requested) {
    it(`arm: ${arm}`, async () => {
      const result = await runArm(arm);
      results.push(result);
      expect(Number.isFinite(result.identity.correct)).toBe(true);
      expect(Number.isFinite(result.teachMsPerWord)).toBe(true);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, `${arm}-w${WORDS}.json`),
        JSON.stringify({ commit: commitHash(), generatedAt: new Date().toISOString(), seed: SEED, overrides: ARM_OVERRIDES[arm], ...result }, null, 2)
      );
      // eslint-disable-next-line no-console
      console.log(
        `[null-arms] ${arm.padEnd(12)} identity ${pct(result.identity.correct, result.identity.n)} (${result.identity.correct}/${result.identity.n})` +
          ` · semantic ${pct(result.semantic.correct, result.semantic.n)} (${result.semantic.correct}/${result.semantic.n})` +
          ` · fuzz FP@0.8 ${result.fuzz.falsePositives}/${result.fuzz.distractors} FP@matched ${result.fuzz.falsePositivesAtMatchedGate} (gate ${result.fuzz.matchedGate?.toFixed(3) ?? 'n/a'}) AUC ${result.fuzz.auc?.toFixed(3) ?? 'n/a'} exact ${result.fuzz.exactRecalled}/${result.fuzz.pairs} margin ${result.fuzz.meanMargin?.toFixed(3) ?? 'n/a'}` +
          ` · ${result.teachMsPerWord.toFixed(1)} ms/word`
      );
    }, 600000);
  }

  it('reports the table', () => {
    if (results.length === 0) return;
    const control = results.find((r) => r.arm === 'control');
    const lines = results.map((r) => {
      const dIdentity = control ? ((r.identity.correct / r.identity.n - control.identity.correct / control.identity.n) * 100).toFixed(1) : '—';
      const dSemantic = control ? ((r.semantic.correct / r.semantic.n - control.semantic.correct / control.semantic.n) * 100).toFixed(1) : '—';
      return `| ${r.arm} | ${pct(r.identity.correct, r.identity.n)} (Δ${dIdentity}) | ${pct(r.semantic.correct, r.semantic.n)} (Δ${dSemantic}) | ${r.fuzz.falsePositives}/${r.fuzz.distractors} | ${r.fuzz.falsePositivesAtMatchedGate} | ${r.fuzz.auc?.toFixed(3) ?? 'n/a'} | ${r.fuzz.meanMargin?.toFixed(3) ?? 'n/a'} | ${r.teachMsPerWord.toFixed(1)} |`;
    });
    // eslint-disable-next-line no-console
    console.log(
      `\n| arm | identity recall | semantic recall | fuzz FP@0.8 | FP@matched gate | AUC | margin | ms/word |\n|---|---|---|---|---|---|---|---|\n${lines.join('\n')}\n`
    );
  });
});
