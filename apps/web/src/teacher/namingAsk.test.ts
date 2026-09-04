/**
 * H.5 `naming-ask-bench` (§9.3) — induced discoveries, the naming ask, and
 * the §9.2 hypothesis-tier lifecycle, run through the EXISTING rule/
 * relation-lifecycle machinery.
 *
 * The deck carries two clusters over the asserted graph:
 *   · a MERGE cluster — cup/bowl/mug/pitcher share {made-of ceramic,
 *     has-part handle, has-part lid}, and the deck word `vessel` carries
 *     exactly those edges → §9.3 rediscovery: the node merges into vessel
 *     and the members' is-a edges enter the hypothesis tier (hedged until
 *     corroborated);
 *   · a DISCOVERY cluster — vase/jar/pot/urn (+glass via expansion) share
 *     {made-of clay, has-part spout, has-part rim}, matching NO word → the
 *     naming ask, which must name the members and the shared edges.
 *
 * Lifecycle under the existing tier: hedge → corroborate → assert;
 * deny → deny → stop (the node is never deleted).
 *
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { MemoryPersistenceStore } from '../persistence/store';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';

const DECK: readonly DeckWord[] = [
  // The merge cluster: shared edges = {made-of ceramic, has-part handle,
  // has-part lid} — identical to `vessel`'s own edge set.
  { word: 'cup', definition: 'made of ceramic with a handle and a lid in the kitchen', example: '' },
  { word: 'bowl', definition: 'made of ceramic with a handle and a lid on the shelf', example: '' },
  { word: 'mug', definition: 'made of ceramic with a handle and a lid on the counter', example: '' },
  { word: 'pitcher', definition: 'made of ceramic with a handle and a lid on the table', example: '' },
  { word: 'vessel', definition: 'made of ceramic with a handle and a lid', example: '' },
  // The discovery cluster: {made-of clay, has-part spout, has-part rim}
  // matches no word. Glass shares only 2 of the 3 edges — it joins via the
  // greedy expansion and INHERITS the rim (the hedged generalization).
  { word: 'vase', definition: 'made of clay with a spout and a rim in the hall', example: '' },
  { word: 'jar', definition: 'made of clay with a spout and a rim on the desk', example: '' },
  { word: 'pot', definition: 'made of clay with a spout and a rim on the stove', example: '' },
  { word: 'urn', definition: 'made of clay with a spout and a rim in the garden', example: '' },
  { word: 'glass', definition: 'made of clay with a spout', example: '' },
  // Object words.
  { word: 'ceramic', definition: 'a hard material', example: '' },
  { word: 'clay', definition: 'a soft material', example: '' },
  { word: 'handle', definition: 'a part you hold', example: '' },
  { word: 'lid', definition: 'a part that covers', example: '' },
  { word: 'spout', definition: 'a part for pouring', example: '' },
  { word: 'rim', definition: 'an edge of a round object', example: '' },
  { word: 'kitchen', definition: 'a room for cooking', example: '' },
  { word: 'shelf', definition: 'a board for holding things', example: '' },
  { word: 'counter', definition: 'a flat surface', example: '' },
  { word: 'table', definition: 'a piece of furniture', example: '' },
  { word: 'hall', definition: 'a passageway', example: '' },
  { word: 'desk', definition: 'a table for work', example: '' },
  { word: 'stove', definition: 'a device for cooking', example: '' },
  { word: 'garden', definition: 'an area for plants', example: '' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary(DECK, PRIME_SPACE)
};

const makeTeacher = async (conceptSynthesis: boolean): Promise<{ session: ObserverSession; teacher: TeacherAgent }> => {
  const store = new MemoryPersistenceStore();
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(
    session,
    DECK,
    store,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    conceptSynthesis
  );
  for (const entry of DECK) teacher.teach(entry.word);
  return { session, teacher };
};


/** The spoken text of a chat answer ('' for a decline — the honest ask). */
const spoken = (answer: ReturnType<TeacherAgent['chatAnswer']>): string =>
  answer.mode === 'decline' ? '' : answer.response;

describe('H.5 naming ask: induced discoveries, binding, and the hypothesis lifecycle', () => {
  let session: ObserverSession | null = null;

  afterEach(() => {
    session?.dispose();
    session = null;
  });

  it('§9.3 rediscovery: a node whose edge set matches an existing word merges into it, hedged', async () => {
    ({ session } = await makeTeacher(true));
    const teacher = (await makeTeacher(true)).teacher;
    const nodes = teacher.inducedConceptNodes();
    const vesselNode = nodes.find((n) => n.mergedWord === 'vessel');
    expect(vesselNode).toBeDefined();
    // The merge is recorded (validation, not fabrication).
    expect(teacher.conceptRediscoveries().some((r) => r.word === 'vessel')).toBe(true);
    // The recovered is-a edges speak HEDGED through the existing hypothesis tier.
    const hedged = teacher.chatAnswer('is a cup a vessel');
    expect(hedged.mode).not.toBe('decline');
    const hedgedResponse = hedged.mode === 'decline' ? '' : hedged.response;
    expect(hedgedResponse.toLowerCase()).toContain('i think');
    expect(hedgedResponse.toLowerCase()).toContain('only one source');
    // Never asserted on its own strength.
    const asserted = teacher.relations();
    expect(asserted.some((r) => r.subject === 'cup' && r.predicate === 'is-a' && r.object === 'vessel')).toBe(false);
  });

  it('the naming ask names the members and the shared edges, and binding makes the node answerable', async () => {
    const made = await makeTeacher(true);
    session = made.session;
    const teacher = made.teacher;
    const asks = teacher.conceptNamingAsks();
    expect(asks.length).toBeGreaterThanOrEqual(1);
    const clayAsk = asks.find((q) => q.ask.includes('clay'));
    expect(clayAsk).toBeDefined();
    const ask = clayAsk!.ask;
    // Members are named.
    for (const member of ['vase', 'jar', 'pot', 'urn']) expect(ask.toLowerCase()).toContain(member);
    // The shared edges are named ("they have … and are made of …").
    expect(ask.toLowerCase()).toContain('spout');
    expect(ask.toLowerCase()).toContain('rim');
    expect(ask.toLowerCase()).toContain('clay');
    expect(ask.toLowerCase()).toContain('what is that called');

    // Binding a human-supplied name makes the node answerable — hedged,
    // through the hypothesis tier.
    const bound = teacher.bindConceptName(clayAsk!.nodeId, 'container');
    expect(bound).toBe('bound');
    expect(teacher.conceptNamingAsks().some((q) => q.nodeId === clayAsk!.nodeId)).toBe(false);
    const isA = teacher.chatAnswer('is a glass a container');
    expect(spoken(isA).toLowerCase()).toContain('i think');
    const nodeEdge = teacher.chatAnswer('does a container have a rim');
    expect(spoken(nodeEdge).toLowerCase()).toContain('i think');
  });

  it('lifecycle: hedge → corroborate → assert (through the existing promotion gate)', async () => {
    const made = await makeTeacher(true);
    session = made.session;
    const teacher = made.teacher;
    const ask = teacher.conceptNamingAsks().find((q) => q.ask.includes('clay'))!;
    teacher.bindConceptName(ask.nodeId, 'container');

    // HEDGE: glass lacks the rim edge; the claim is inherited through the
    // induced node and speaks hedged with the §9.2 likeness clause.
    const hedged = teacher.chatAnswer('does a glass have a rim');
    expect(hedged.mode).toBe('operator');
    expect(spoken(hedged).toLowerCase()).toContain('i think');
    expect(spoken(hedged)).toContain('it is like the other');
    expect(hedged.provenance.operatorId).toBe('concept-synthesis');

    // CORROBORATE: a strong world grade on the inherited answer promotes
    // both cited edges into the asserted graph.
    teacher.creativeGradeFeedback(hedged.provenance, 0.9, 'does a glass have a rim', spoken(hedged));
    const asserted = teacher.relations();
    expect(asserted.some((r) => r.subject === 'glass' && r.predicate === 'is-a' && r.object === 'container')).toBe(true);
    expect(asserted.some((r) => r.subject === 'container' && r.predicate === 'has-part' && r.object === 'rim')).toBe(true);

    // ASSERT: the same claim now answers through the ordinary chain —
    // flatly, no hedge. (The identical question would recall the memorized
    // hedged phrasing; a rephrasing is the honest asserted-speech probe.)
    const rephrased = teacher.chatAnswer('does the glass have a rim');
    expect(spoken(rephrased).toLowerCase()).not.toContain('i think');
    expect(spoken(rephrased).toLowerCase()).toContain('container');
  });

  it('lifecycle: deny → deny → stop — the node stops chaining and is NEVER deleted', async () => {
    const made = await makeTeacher(true);
    session = made.session;
    const teacher = made.teacher;
    const ask = teacher.conceptNamingAsks().find((q) => q.ask.includes('clay'))!;
    teacher.bindConceptName(ask.nodeId, 'container');

    const before = teacher.chatAnswer('does a glass have a rim');
    expect(spoken(before).toLowerCase()).toContain('i think');
    const node = () => teacher.inducedConceptNodes().find((n) => n.id === ask.nodeId);

    // Denial 1: a weak world grade citing the node's edge.
    teacher.creativeGradeFeedback(
      { traceIds: [], edges: [{ subject: 'container', predicate: 'has-part', object: 'rim' }] },
      0.1,
      'does a container have a rim',
      'I think container has a rim.'
    );
    expect(node()?.denials).toBe(1);
    expect(node()?.stopped).toBe(false);
    // One denial weakens, does not stop — the hedged claim still answers.
    expect(spoken(teacher.chatAnswer('does a glass have a rim')).toLowerCase()).toContain('i think');

    // Denial 2 stops the node.
    teacher.creativeGradeFeedback(
      { traceIds: [], edges: [{ subject: 'container', predicate: 'has-part', object: 'rim' }] },
      0.1,
      'does a container have a rim',
      'I think container has a rim.'
    );
    expect(node()?.denials).toBe(2);
    expect(node()?.stopped).toBe(true);

    // The node is never deleted — the record is the record.
    expect(teacher.inducedConceptNodes().some((n) => n.id === ask.nodeId)).toBe(true);
    // It no longer chains: the inherited claim is not answered through it.
    const stoppedAnswer = teacher.chatAnswer('does a glass have a rim');
    expect(spoken(stoppedAnswer)).not.toContain('it is like the other');
  });

  it('FLAG-GATED: with concept synthesis OFF every existing behavior is unchanged', async () => {
    const made = await makeTeacher(false);
    session = made.session;
    const teacher = made.teacher;
    expect(teacher.inducedConceptNodes().length).toBe(0);
    expect(teacher.conceptNamingAsks().length).toBe(0);
    expect(teacher.conceptRediscoveries().length).toBe(0);
    // The inherited claim declines honestly — no induced generalization.
    const answer = teacher.chatAnswer('does a glass have a rim');
    expect(spoken(answer)).not.toContain('it is like the other');
  });
});
