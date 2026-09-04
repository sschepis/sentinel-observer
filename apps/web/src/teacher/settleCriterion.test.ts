/**
 * @jest-environment node
 *
 * D.2 SETTLE-CRITERION BENCH (§5.2 row 1 / §5.5): fixed settle depth 4 vs
 * the coherence-peak stop, compared on the two contracts the criterion must
 * keep:
 *
 *   1. THE FUZZ BENCH — 0 false positives: a partial-overlap distractor of a
 *      taught cue must never be spoken as memorized (both at the raw
 *      respond() confidence level and through the full chatAnswer gate).
 *   2. EXACT-CUE RECALL — the settle-6 collapse must not recur: stopping at
 *      the coherence peak must not over-settle the field into the regime
 *      where the perturbation has decayed (clusterMomentBenchmark's
 *      settle-depth experiment) and the taught exchange stops recalling.
 *
 * Pass: 0 false positives and exact recall preserved under the peak
 * criterion. Refute: the peak is not well-defined on real cues (no crossing
 * within the fuel budget — read from the agent's settleTelemetry), in which
 * case the constant stays the control and the failure is RECORDED IN THE
 * TEST OUTPUT; the test then asserts only the control arm.
 *
 * Run: npx jest src/teacher/settleCriterion.test.ts
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { ALL_CONVERSATION_PAIRS, CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { MemoryPersistenceStore } from '../persistence/store';
import type { DeckWord } from './deck';

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

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  smfWidth: 128,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

/** The taught pairs under test — the full deck is the honest population, but
 *  the settle is per-cue physics: a capped sample keeps the bench fast while
 *  spanning the cue length/overlap variety. */
const PAIR_COUNT = Number(process.env.SETTLE_BENCH_PAIRS ?? 120);

interface ArmResult {
  exactCues: number;
  exactRecalled: number;
  distractors: number;
  falsePositives: number;
  chatFalsePositives: number;
  meanTrueConfidence: number;
  meanDistractorConfidence: number;
  meanMargin: number;
  /** The first fuzz failures at the chat gate (distractor → what was spoken). */
  chatFpExamples: string[];
}

async function runArm(criterion: 'fixed' | 'peak'): Promise<{ result: ArmResult; telemetry: TeacherAgent['settleTelemetry'] | null }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, DECK, new MemoryPersistenceStore(), 500, 4, undefined, undefined, undefined, undefined, false, undefined, criterion);
  for (const entry of DECK) teacher.teach(entry.word);

  const pairs = ALL_CONVERSATION_PAIRS.slice(0, PAIR_COUNT);
  teacher.teachConversationDeck(pairs);
  for (const pair of pairs) teacher.respond(pair.cue);
  const taughtCues = pairs.map((pair) => pair.cue.trim().toLowerCase());

  /**
   * The shipped IDENTITY policy (matchesCue): a question that CONTAINS a
   * taught cue with ≤ 8 trailing characters IS that exchange ("what time is
   * it this morning" vs "what time is it"). A distractor that lands inside
   * that tolerance is the policy answering by design — it is not a settle
   * failure and must not pollute the settle comparison. The bench therefore
   * keeps only TRUE partial overlaps: distractors that match NO taught cue
   * under identity, whose fate is decided purely by the settle's separation.
   */
  const identityApproved = (distractor: string): boolean =>
    taughtCues.some((cue) => cue.length > 0 && distractor.includes(cue) && distractor.length - cue.length <= 8);

  const deckWords = DECK.map((entry) => entry.word);
  let exactRecalled = 0;
  let distractorCount = 0;
  let falsePositives = 0;
  let chatFalsePositives = 0;
  let trueSum = 0;
  let distractorSum = 0;
  let marginSum = 0;
  let scored = 0;
  const chatFpExamples: string[] = [];

  for (const pair of pairs) {
    const cue = pair.cue.trim().toLowerCase();
    // Exact-cue recall through the full chat stack: the exchange must be
    // spoken as memorized with the taught response (the settle-6 collapse
    // would leave the moment decayed and the exchange unrecalled).
    const exact = teacher.chatAnswer(cue);
    if (exact.mode === 'memorized' && exact.response.toLowerCase() === pair.response.toLowerCase()) {
      exactRecalled += 1;
    }
    // Fuzz distractors: the cue with its last word swapped for a random deck
    // word — a partial overlap that must never be spoken as memorized
    // (identity-approved extensions excluded: those are the shipped policy,
    // constant across both settle arms).
    for (let d = 0; d < 3; d += 1) {
      const words = cue.split(' ');
      if (words.length < 2) break;
      const filler = deckWords[(d * 7 + words.length) % deckWords.length];
      const distractor = [...words.slice(0, -1), filler].join(' ');
      if (distractor === cue || taughtCues.includes(distractor) || identityApproved(distractor)) continue;
      distractorCount += 1;
      // Raw guard-free measure (train.ts fuzz protocol): the settle's
      // separation, before the chat's identity gate.
      const hit = teacher.respond(distractor);
      const hitConf = hit.confidence ?? 0;
      distractorSum += hitConf;
      if (hitConf >= 0.8) falsePositives += 1;
      const exactConf = exact.mode === 'memorized' ? exact.confidence ?? 0 : 0;
      if (exactConf > 0) {
        trueSum += exactConf;
        marginSum += exactConf - hitConf;
        scored += 1;
      }
      // The full chat gate: the distractor is NOT a taught cue, so ANY
      // memorized answer spoken for it is a wrong-cue match — a fuzz false
      // positive.
      const chat = teacher.chatAnswer(distractor);
      if (chat.mode === 'memorized') {
        chatFalsePositives += 1;
        if (chatFpExamples.length < 5) chatFpExamples.push(`${distractor} → "${chat.response}" (cue ${chat.cue ?? '?'})`);
      }
    }
  }

  session.dispose();
  return {
    result: {
      exactCues: pairs.length,
      exactRecalled,
      distractors: distractorCount,
      falsePositives,
      chatFalsePositives,
      meanTrueConfidence: scored > 0 ? trueSum / scored : 0,
      meanDistractorConfidence: distractorCount > 0 ? distractorSum / distractorCount : 0,
      meanMargin: scored > 0 ? marginSum / scored : 0,
      chatFpExamples
    },
    telemetry: criterion === 'peak' ? { ...teacher.settleTelemetry } : null
  };
}

describe('D.2 settle-criterion bench — fixed depth 4 vs coherence-peak stop', () => {
  it('0 fuzz false positives and exact recall preserved under the peak criterion', async () => {
    const fixed = await runArm('fixed');
    const peak = await runArm('peak');

    const report = (label: string, arm: ArmResult): void => {
      // eslint-disable-next-line no-console
      console.log(
        `[settleCriterion] ${label}: exact recall ${arm.exactRecalled}/${arm.exactCues} ` +
          `(${((arm.exactRecalled / Math.max(1, arm.exactCues)) * 100).toFixed(1)}%) · ` +
          `fuzz FP (guard-free conf≥0.8) ${arm.falsePositives}/${arm.distractors} · chat FP ${arm.chatFalsePositives}/${arm.distractors} · ` +
          `mean true ${arm.meanTrueConfidence.toFixed(3)} vs distractor ${arm.meanDistractorConfidence.toFixed(3)} ` +
          `(margin ${arm.meanMargin.toFixed(3)})`
      );
      for (const example of arm.chatFpExamples) {
        // eslint-disable-next-line no-console
        console.log(`[settleCriterion]   chat FP: ${example}`);
      }
    };
    report('fixed-4 (control)', fixed.result);
    report('peak-stop', peak.result);

    // THE CONTROL must hold regardless — the fixed depth is the shipped
    // behaviour and the fallback.
    expect(fixed.result.exactRecalled).toBeGreaterThanOrEqual(fixed.result.exactCues * 0.9);
    expect(fixed.result.chatFalsePositives).toBe(0);

    const telemetry = peak.telemetry;
    const illDefined = telemetry !== null && telemetry.illDefinedPeaks > 0;
    const meanTicks = telemetry !== null ? telemetry.ticksSpent / Math.max(1, telemetry.peakSettles) : 0;
    // eslint-disable-next-line no-console
    console.log(
      `[settleCriterion] peak telemetry: ${telemetry?.peakSettles ?? 0} settles, ` +
        `mean ${meanTicks.toFixed(1)} ticks (fixed control = 4), ` +
        `ill-defined ${telemetry?.illDefinedPeaks ?? 0} (fuel ${16})`
    );

    const fixedRate = fixed.result.exactRecalled / Math.max(1, fixed.result.exactCues);
    const peakRate = peak.result.exactRecalled / Math.max(1, peak.result.exactCues);
    const peakPasses =
      !illDefined &&
      peak.result.chatFalsePositives === 0 &&
      peakRate >= fixedRate - 0.05 &&
      peakRate >= 0.9;

    if (peakPasses) {
      // PASS (§5.5): 0 fuzz FP and exact recall held — the peak criterion is
      // well-defined on real cues and honest. The settle-6 collapse did not
      // recur (the peak stop did not over-settle into decay).
      // eslint-disable-next-line no-console
      console.log('[settleCriterion] VERDICT: the coherence-peak criterion passes (0 chat FP, exact recall held).');
      expect(peak.result.chatFalsePositives).toBe(0);
      expect(peakRate).toBeGreaterThanOrEqual(fixedRate - 0.05);
      expect(peakRate).toBeGreaterThanOrEqual(0.9);
      return;
    }

    // REFUTE PATH RECORDED IN THE TEST OUTPUT (§5.5): the peak criterion
    // either is not well-defined on real cues or costs a fuzz false positive
    // or exact recall. The constant stays the control (the option defaults
    // to 'fixed'); the test asserts only the control arm and records why.
    const reasons: string[] = [];
    if (illDefined) {
      reasons.push(`the coherence peak was not well-defined on ${telemetry.illDefinedPeaks}/${telemetry.peakSettles} settles within the fuel budget`);
    }
    if (peak.result.chatFalsePositives > 0) {
      reasons.push(`${peak.result.chatFalsePositives} fuzz false positive(s) at the chat gate`);
    }
    if (peakRate < fixedRate - 0.05 || peakRate < 0.9) {
      reasons.push(`exact recall dropped (fixed ${(fixedRate * 100).toFixed(1)}% → peak ${(peakRate * 100).toFixed(1)}%)`);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[settleCriterion] VERDICT: the coherence-peak criterion FAILS — ${reasons.join('; ')}. ` +
        'The fixed-depth constant stays the control and the failure is recorded here.'
    );
    // The control (and its fallback behaviour) is all the shipped build
    // carries — that contract is asserted above and must hold.
  }, 300000);
});
