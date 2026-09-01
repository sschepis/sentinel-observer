/**
 * @jest-environment node
 *
 * W10 KILL-SHOT — the capacity-thrash fix.
 *
 * The compact bank's DEFAULT capacity used to be 5,000 against a 20,000-word
 * vocabulary: a bare observer (no explicit memoryCapacity) pruned 75% of
 * everything it stored, weakest-first, on every teach. The default is now
 * deck-scale (50,000) so no consumer — OBSERVER_OPTIONS or a bare observer —
 * thrashes.
 *
 * This test trains the FULL deck through the DEFAULT-capacity path (a bare
 * ObserverSession, exactly the configuration that used to thrash) and
 * asserts: every word trace is present, nothing was pruned. Sibling
 * discrimination is irrelevant here by design — the semantic signature
 * scheme shares primes among siblings (the H1 win / H4 cost), so the overlap
 * term cannot separate them; the SMF term carries that. Pruning must never
 * force that tradeoff by dropping whole categories of traces.
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { ACTIVE_DECK } from './decks';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';

describe('W10: default capacity matches the deck — no word trace pruned in a full train', () => {
  it('a BARE observer (default capacity) trains the full deck with zero pruning', async () => {
    const session = new ObserverSession(
      {
        primeCount: 64,
        gridSize: 128,
        memoryMode: 'compact',
        // NO memoryCapacity: the bank's deck-scale default must hold the deck.
        vocabulary: deckVocabulary(ACTIVE_DECK, PRIME_SPACE)
      },
      100
    );
    await session.initialize();
    const teacher = new TeacherAgent(session, ACTIVE_DECK);
    for (const entry of ACTIVE_DECK) teacher.teach(entry.word);

    const bank = session.observer.getMemoryBank();
    const missing = teacher.listWords().filter((w) => w.traceId === null).length;
    expect(bank.capacity).toBeGreaterThanOrEqual(ACTIVE_DECK.length);
    expect(missing).toBe(0);
    expect(bank.size).toBeGreaterThanOrEqual(ACTIVE_DECK.length);
    expect(bank.stats().prunedCount).toBe(0);

    session.dispose();
  }, 900000);
});
