import { ACTIVE_DECK } from '../teacher/decks';
import { CONVERSATION_CUE_TOKENS } from '../teacher/conversation';
import { PRIME_SPACE } from '../teacher/primeSignature';
import { semanticVocabulary } from '../teacher/semanticSignature';
import type { SlowContextOptions } from '@sschepis/sentient-core';

/**
 * E.2 (§6.2) SLOW CONTEXT / PRIMING — the second timescale.
 *
 * The observer's fast field fully decays within one settle, so nothing of
 * the previous turn survives to prime the next. The slow context integrates
 * the converged excitation ONCE PER TURN (per settle) and decays over turns
 * under the one retention law at `stabilityTurns` (the per-turn decay factor
 * is R(1; stabilityTurns) — a measured rate, not a fixed half-life). At
 * recall the context is blended into the SMF cue as a small, bounded
 * direction tilt (`blendWeight`), so an ambiguous cue is biased toward the
 * reading the conversation has been about.
 *
 * DEFAULT OFF (the honest control): with `enabled: false` every consumer
 * builds the observer bit-identically to the unprimed engine. The
 * priming-bench (§6.3) decides whether the flag ever turns on: primed
 * resolution must rise with contamination 0 on the fuzz/honesty probes —
 * any contamination that costs a probe keeps the flag off.
 *
 * `stabilityTurns` and `blendWeight` are tuning constants, registered in
 * `apps/web/src/teacher/constants.ts` (class 'tuning').
 */
export const SLOW_CONTEXT = {
  enabled: false as const,
  /** Retention stability in TURNS for the one retention law. */
  stabilityTurns: 2,
  /** Bounded weight of the context in the recall-cue blend (core clamps to [0, 0.5]). */
  blendWeight: 0.15,
  /** EMA rate at which a turn's converged excitation integrates. */
  learningRate: 0.5
};

/**
 * THE observer configuration — one definition, three consumers.
 *
 * The browser app, the batch trainer, and the trainer's verify workers all
 * build the observer's field from these exact values. They MUST stay
 * identical: a bootstrap record is trained and exported under this prime
 * basis and restored against it — a single retuned copy would decode traces
 * against a mismatched basis with no error. Never inline these numbers.
 */
export const OBSERVER_OPTIONS = {
  primeCount: 256,
  gridSize: 512,
  memoryMode: 'compact' as const,
  // The bank must hold the whole 20k deck PLUS conversations, creative
  // answers, gaps, and beliefs without pruning a single word trace — the
  // P11 W10 requirement (capacity raised to match the deck).
  memoryCapacity: 50000,
  // SMF sketch width: 128 (P3 projection fix). The seeded signed random
  // projection replaces the `j mod 16` fold; 128 is the accuracy knee —
  // 99.8% top-1 at 20k vs the fold's 99.3%, at ~1.1 KB/trace with q8
  // compact serialization (docs/SCALING.md §7).
  smfWidth: 128,
  // L1b (Phase 18.1): the imprint rate is linear in coherence
  // (alpha = lr·coherence) — an incoherent moment barely imprints, matching
  // the architecture's own claim. The legacy 'floor' curve imprinted junk
  // perturbations at half rate. Gate (smfImprintWeighting.test.ts): recall
  // 100% = floor, exact 10/10 = floor, fuzz FP 0 = floor.
  smfImprintWeighting: 'linear' as const,
  // E.2 (§6.2): the slow context flag — OFF is the honest control (see the
  // SLOW_CONTEXT block above). Turning `enabled` on keeps every other value
  // identical; storage is untouched, only the recall cue is blended.
  slowContext: (SLOW_CONTEXT.enabled
    ? {
        stabilityTurns: SLOW_CONTEXT.stabilityTurns,
        blendWeight: SLOW_CONTEXT.blendWeight,
        learningRate: SLOW_CONTEXT.learningRate
      }
    : false) as false | SlowContextOptions,
  vocabulary: semanticVocabulary(
    [...ACTIVE_DECK, ...CONVERSATION_CUE_TOKENS.map((word) => ({ word }))],
    PRIME_SPACE
  )
};
