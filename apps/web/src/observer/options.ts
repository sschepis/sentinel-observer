import { ACTIVE_DECK } from '../teacher/decks';
import { CONVERSATION_CUE_TOKENS } from '../teacher/conversation';
import { PRIME_SPACE } from '../teacher/primeSignature';
import { semanticVocabulary } from '../teacher/semanticSignature';

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
  vocabulary: semanticVocabulary(
    [...ACTIVE_DECK, ...CONVERSATION_CUE_TOKENS.map((word) => ({ word }))],
    PRIME_SPACE
  )
};
