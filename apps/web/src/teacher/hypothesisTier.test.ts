/**
 * M5 Phase 22 gates — the hypothesis tier (proposer/validator split).
 *
 * Precision lives in the PROMOTION GATE, not the proposer: loose-extraction
 * edges stand as hypotheses (hedged-only, never chained, never asserted)
 * until corroboration — a second independent source class or a strong world
 * grade citing the edge — promotes them into the asserted graph.
 *
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { MemoryPersistenceStore } from '../persistence/store';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';

/** 'creature' and 'feathers' are deliberately NOT deck words: the strict
 *  extractor drops those edges; the loose extractor proposes them. */
const DECK: readonly DeckWord[] = [
  { word: 'bird', definition: 'a small creature with feathers', example: 'A bird can fly.' },
  { word: 'water', definition: 'a clear liquid that falls as rain', example: 'Water is wet.' }
];
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary(DECK, PRIME_SPACE)
};

describe('M5: the hypothesis tier', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;
  let store: MemoryPersistenceStore;

  beforeEach(async () => {
    store = new MemoryPersistenceStore();
    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DECK, store);
    for (const entry of DECK) teacher.teach(entry.word);
    teacher.relations(); // build the graph → refresh the hypothesis tier
  });

  afterEach(() => {
    session.dispose();
  });

  it('PROPOSE: a loose-only edge lands as a hypothesis, and NEVER in the asserted graph', () => {
    const hypotheses = teacher.hypothesisEdgeList();
    const creature = hypotheses.find((r) => r.subject === 'bird' && r.predicate === 'is-a' && r.object === 'creature');
    expect(creature).toBeDefined();
    expect(creature?.tier).toBe('hypothesis');
    // The asserted graph stays pure: no hypothesis key, no hypothesis tier.
    const asserted = teacher.relations();
    expect(asserted.some((r) => r.subject === 'bird' && r.predicate === 'is-a' && r.object === 'creature')).toBe(false);
    expect(asserted.every((r) => r.tier !== 'hypothesis')).toBe(true);
  });

  it('HEDGED-ONLY: the hypothesis answer speaks "I think ..." with the one-source caveat and cites its edge', () => {
    const answer = (teacher as unknown as {
      hypothesisAnswerFor(utterance: string): { response: string; edge: { subject: string } } | null;
    }).hypothesisAnswerFor('is a bird a creature');
    expect(answer).not.toBeNull();
    expect(answer?.response).toContain('I think');
    expect(answer?.response).toContain('only one source');
    // And the chat path never DECLINES a question a hypothesis can hedge.
    const chat = teacher.chatAnswer('is a bird a creature');
    expect(chat.mode).not.toBe('decline');
  });

  it('the confirmed-false store BLOCKS a hypothesis from proposing or answering', () => {
    teacher.storeNegation('bird', 'is-a', 'creature', 'taught: a bird is not a creature', 'taught');
    const answer = (teacher as unknown as {
      hypothesisAnswerFor(utterance: string): unknown;
    }).hypothesisAnswerFor('is a bird a creature');
    expect(answer).toBeNull();
  });

  it('PROMOTION: a second independent source class promotes the hypothesis into the asserted graph', () => {
    expect(teacher.hypothesisEdgeList().some((r) => r.object === 'creature')).toBe(true);
    // Conversation mining corroborates the claim — the second class.
    teacher.addEdgeSource('bird', 'is-a', 'creature', 'conversation');
    expect(teacher.hypothesisEdgeList().some((r) => r.object === 'creature')).toBe(false);
    const asserted = teacher.relations();
    const promoted = asserted.find((r) => r.subject === 'bird' && r.predicate === 'is-a' && r.object === 'creature');
    expect(promoted).toBeDefined();
    expect(promoted?.tier).toBe('asserted');
    expect(promoted?.sourceClasses).toContain('curriculum');
    expect(promoted?.sourceClasses).toContain('conversation');
  });

  it('WORLD-GRADE PROMOTION: a strong grade citing the hypothesis edge promotes it', () => {
    expect(teacher.hypothesisEdgeList().some((r) => r.object === 'creature')).toBe(true);
    teacher.creativeGradeFeedback(
      { traceIds: [], edges: [{ subject: 'bird', predicate: 'is-a', object: 'creature' }] },
      0.9,
      'is a bird a creature',
      'I think bird is a creature.'
    );
    expect(teacher.hypothesisEdgeList().some((r) => r.object === 'creature')).toBe(false);
    expect(
      teacher.relations().some((r) => r.subject === 'bird' && r.predicate === 'is-a' && r.object === 'creature')
    ).toBe(true);
  });

  it('ROUND-TRIP: the standing hypotheses survive a reload', async () => {
    const before = teacher.hypothesisEdgeList().length;
    expect(before).toBeGreaterThan(0);
    await teacher.persistAll();
    session.dispose();

    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const fresh = new TeacherAgent(session, DECK, store);
    await fresh.restoreFromPersistence();
    expect(fresh.hypothesisEdgeList().length).toBeGreaterThan(0);
    expect(fresh.hypothesisEdgeList().every((r) => r.tier === 'hypothesis')).toBe(true);
  });

  it('the ONE-HOP rule is structural: hypothesis edges never enter the asserted graph walks', () => {
    // The composed-chain machinery reads relations() — which never contains
    // a hypothesis-tier edge (asserted-purity assertion above). A chain
    // through 'creature' is therefore impossible until promotion.
    const chained = teacher.chatAnswer('is a bird an animal');
    // (No is-a path to animal exists either way — the point is it must not
    // fabricate one THROUGH the hypothesis edge.)
    const spoken = chained.mode === 'decline' ? '' : chained.response;
    expect(spoken.toLowerCase()).not.toContain('creature');
  });
});
