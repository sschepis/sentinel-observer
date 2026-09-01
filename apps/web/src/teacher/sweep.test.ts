/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import {
  sweepConflicts,
  scheduleVerification,
  runVerificationRound,
  worldVerdictFor,
  applyResolution,
  verificationExercise
} from './sweep';
import { detectConflicts } from './contradictions';
import { verify } from './technical/verify';
import { teachNegationDeck } from './decks/negations';
import type { DeckWord } from './deck';

/**
 * A small deck whose definitions EXTRACT positive edges that taught
 * negations then deny:
 *
 *   whale is-a fish        ← "whale is not a fish"              (direct)
 *   snake has-part legs    ← "snake does not have legs"         (direct)
 *   glass made-of plastic  ← "glass is not made of plastic"     (direct)
 *   robin has-part wings (authored supplement) + bird has-part wings
 *                          ← "robin does not have wings"        (direct + explicit-negative)
 *   robin has-part beak    ← "bird does not have a beak"        (explicit-positive)
 *
 * The authored supplement pool (SUPPLEMENTAL_RELATIONS, filtered to the
 * deck's words) contributes `robin is-a bird`, `robin has-part wings`, and
 * `bird has-part legs` — exactly as it would in production.
 */
const DECK: readonly DeckWord[] = [
  { word: 'whale', definition: 'a large fish that lives in the sea', example: 'The whale swam past the boat.' },
  { word: 'fish', definition: 'an animal that lives in water', example: 'The fish swam in the pond.' },
  { word: 'robin', definition: 'a small bird with a beak', example: 'The robin sang in the tree.' },
  { word: 'bird', definition: 'an animal with wings', example: 'A bird can fly.' },
  { word: 'snake', definition: 'a long animal with legs that crawls on the ground', example: 'The snake lay in the sun.' },
  { word: 'glass', definition: 'a material made of plastic', example: 'The window is made of glass.' },
  { word: 'animal', definition: 'a living creature that can move', example: 'The animal slept in the shade.' },
  { word: 'wings', definition: 'a part of a bird used for flying', example: 'The bird spread its wings.' },
  { word: 'beak', definition: 'a bird uses its beak to eat', example: 'The bird cracked the seed with its beak.' },
  { word: 'legs', definition: 'the parts of the body used for walking', example: 'The table has four legs.' },
  { word: 'plastic', definition: 'a strong material used for making things', example: 'The cup is made of plastic.' },
  { word: 'sea', definition: 'a large area of salt water', example: 'The ship sailed across the sea.' },
  { word: 'water', definition: 'a clear liquid that falls as rain', example: 'Water is wet.' },
  { word: 'material', definition: 'a substance used to make things', example: 'Wood is a building material.' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

const WHALE_DIRECT = 'direct:whale\u0000is-a\u0000fish';
const SNAKE_DIRECT = 'direct:snake\u0000has-part\u0000legs';
const GLASS_DIRECT = 'direct:glass\u0000made-of\u0000plastic';
const ROBIN_WINGS_DIRECT = 'direct:robin\u0000has-part\u0000wings';
const ROBIN_WINGS_INHERITED = 'explicit-negative:robin\u0000has-part\u0000wings\u0000bird\u0000robin';
const ROBIN_BEAK_INHERITED = 'explicit-positive:robin\u0000has-part\u0000beak\u0000robin\u0000bird';

function itemById(items: ReturnType<typeof sweepConflicts>, id: string) {
  const item = items.find((entry) => entry.id === id);
  expect(item).toBeDefined();
  return item!;
}

describe('contradiction sweep integration', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DECK);
    // Teach exactly the negations that collide with the extracted graph.
    const taught = teachNegationDeck(teacher, [
      { statement: 'whale is not a fish', subject: 'whale', predicate: 'is-a', object: 'fish' },
      { statement: 'snake does not have legs', subject: 'snake', predicate: 'has-part', object: 'legs' },
      { statement: 'glass is not made of plastic', subject: 'glass', predicate: 'made-of', object: 'plastic' },
      { statement: 'bird does not have a beak', subject: 'bird', predicate: 'has-part', object: 'beak' },
      { statement: 'robin does not have wings', subject: 'robin', predicate: 'has-part', object: 'wings' }
    ]);
    expect(taught).toBe(5);
  });

  afterEach(() => {
    session.dispose();
  });

  it('finds the direct and both inheritance directions', () => {
    const items = sweepConflicts(teacher);
    const byId = new Map(items.map((item) => [item.id, item.direction]));

    expect(byId.get(WHALE_DIRECT)).toBe('direct');
    expect(byId.get(SNAKE_DIRECT)).toBe('direct');
    expect(byId.get(GLASS_DIRECT)).toBe('direct');
    // Robin's OWN authored edge vs its denial — direct.
    expect(byId.get(ROBIN_WINGS_DIRECT)).toBe('direct');
    // Robin denies wings while its parent asserts them — inherited.
    expect(byId.get(ROBIN_WINGS_INHERITED)).toBe('explicit-negative');
    // Robin asserts a beak while its parent denies it — the other direction.
    expect(byId.get(ROBIN_BEAK_INHERITED)).toBe('explicit-positive');

    expect(items).toHaveLength(6);
    // Severity order: direct conflicts outrank the inherited ones.
    expect(items[0].severity).toBeGreaterThanOrEqual(items[items.length - 1].severity);
    expect(items[0].kind).toBe('direct');
  });

  it('the observer answers a probe from its own graph — denying what it was taught', () => {
    const answer = teacher.chatAnswer('is whale a fish?');
    expect(answer.mode).toBe('operator');
    if (answer.mode !== 'operator') return;
    expect(answer.response).toContain('No');
    expect(answer.response).toContain('I was taught that');
  });

  it('the deterministic verifier marks the world yes/no on a probe exercise', () => {
    const items = sweepConflicts(teacher);
    const exercise = verificationExercise(itemById(items, WHALE_DIRECT));
    expect(exercise.drill).toBe('verification');
    expect(exercise.prompt).toBe('is whale a fish?');
    expect(verify(exercise, 'yes').correct).toBe(true);
    expect(verify(exercise, 'Yes, I think so.').correct).toBe(true);
    expect(verify(exercise, 'no').correct).toBe(false);
  });

  it('worldVerdictFor maps yes/no answers, ignoring evasions', () => {
    const items = sweepConflicts(teacher);
    const whale = itemById(items, WHALE_DIRECT);
    expect(worldVerdictFor(whale, 'yes')).toBe('positive');
    expect(worldVerdictFor(whale, 'No.')).toBe('negative');
    expect(worldVerdictFor(whale, 'maybe')).toBeNull();
    expect(worldVerdictFor(whale, '')).toBeNull();
  });

  it('scheduleVerification feeds the planner: contradiction beliefs + verify-belief goals, idempotent', () => {
    const items = sweepConflicts(teacher);
    const scheduled = scheduleVerification(teacher, items);
    expect(scheduled).toBe(4); // whale, snake, glass, robin — one goal per subject
    const goals = teacher.goalList();
    const verifyGoals = goals.filter((g) => g.type === 'verify-belief');
    expect(verifyGoals).toHaveLength(4);
    for (const subject of ['whale', 'snake', 'glass', 'robin']) {
      expect(verifyGoals.some((g) => g.target === subject)).toBe(true);
    }
    // The belief the completion predicate reads is stored.
    expect(teacher.beliefsOf('whale').some((b) => b.contradicts)).toBe(true);
    // Idempotent: a second scheduling pass adds nothing.
    expect(scheduleVerification(teacher, items)).toBe(0);
    expect(teacher.goalList().filter((g) => g.type === 'verify-belief')).toHaveLength(4);
  });

  it('positive-wins resolution retracts the denial, reinforces the edge, and stops re-reporting', () => {
    const items = sweepConflicts(teacher);
    const whale = itemById(items, WHALE_DIRECT);
    expect(teacher.negationOf('whale', 'is-a', 'fish')).not.toBeNull();

    applyResolution(teacher, whale, 'positive');

    expect(teacher.negationOf('whale', 'is-a', 'fish')).toBeNull();
    expect(teacher.edgeStrengthOf('whale', 'is-a', 'fish')).toBeGreaterThan(1);
    expect(teacher.sweepResolutionLedger().has(whale.id)).toBe(true);
    // The grade ledger names the resolution's producer (P7 bookkeeping).
    const ledger = teacher.answerGradeLedger();
    expect(ledger.some((entry) => entry.verdict === 'strong' && entry.edges.some((e) => e.subject === 'whale' && e.predicate === 'is-a' && e.object === 'fish'))).toBe(true);

    const remaining = sweepConflicts(teacher);
    expect(remaining.some((item) => item.id === whale.id)).toBe(false);
    expect(remaining).toHaveLength(5);
  });

  it('negative-wins resolution weakens the positive below the floor; the denial stays', () => {
    const items = sweepConflicts(teacher);
    const snake = itemById(items, SNAKE_DIRECT);
    expect(teacher.edgeStrengthOf('snake', 'has-part', 'legs')).toBe(1);

    applyResolution(teacher, snake, 'negative');

    // Weakened below the sweep floor (1.0 − 0.7 = 0.3).
    expect(teacher.edgeStrengthOf('snake', 'has-part', 'legs')).toBeLessThan(0.5);
    expect(teacher.negationOf('snake', 'has-part', 'legs')).not.toBeNull(); // evidence stays
    const remaining = sweepConflicts(teacher);
    expect(remaining.some((item) => item.id === snake.id)).toBe(false);
  });

  it('inherited resolutions are surgical: they edit the ancestor side, not the subject', () => {
    const items = sweepConflicts(teacher);
    const beak = itemById(items, ROBIN_BEAK_INHERITED);
    const wingsInherited = itemById(items, ROBIN_WINGS_INHERITED);

    // The world confirms robin HAS a beak: retract the denial on BIRD — the
    // subject's own edge is untouched by the retraction.
    applyResolution(teacher, beak, 'positive');
    expect(teacher.negationOf('bird', 'has-part', 'beak')).toBeNull();
    expect(teacher.negationOf('robin', 'has-part', 'beak')).toBeNull();
    expect(teacher.edgeStrengthOf('robin', 'has-part', 'beak')).toBeGreaterThan(1);

    // The world denies robin HAS wings: weaken the edge on BIRD (the
    // ancestor robin inherits from) — the subject's own denial stays.
    applyResolution(teacher, wingsInherited, 'negative');
    expect(teacher.edgeStrengthOf('bird', 'has-part', 'wings')).toBeLessThan(0.5);
    expect(teacher.negationOf('robin', 'has-part', 'wings')).not.toBeNull();

    const remaining = sweepConflicts(teacher);
    expect(remaining.some((item) => item.id === beak.id)).toBe(false);
    expect(remaining.some((item) => item.id === wingsInherited.id)).toBe(false);
    // Robin's OWN direct wings conflict is untouched — a different disagreement.
    expect(remaining.some((item) => item.id === ROBIN_WINGS_DIRECT)).toBe(true);
    expect(remaining).toHaveLength(4);
  });

  it('runVerificationRound drives the whole loop: observer stance + world verdict + resolution', () => {
    const items = sweepConflicts(teacher);
    const results = runVerificationRound(teacher, items, (item) => (item.subject === 'whale' ? 'yes' : 'no'));

    expect(results).toHaveLength(6);
    for (const result of results) {
      expect(result.resolved).toBe(true);
      expect(result.worldVerdict).not.toBeNull();
      expect(result.observerResponse.length).toBeGreaterThan(0);
    }
    const whale = results.find((r) => r.item.id === WHALE_DIRECT)!;
    expect(whale.worldVerdict).toBe('positive');
    expect(whale.observerResponse).toContain('No'); // the observer's stance before resolution

    // Everything resolved: the second sweep reports nothing.
    expect(sweepConflicts(teacher)).toHaveLength(0);
    // And the observer's stance flipped for the whale: no denial left.
    const answer = teacher.chatAnswer('is whale a fish?');
    if (answer.mode === 'operator') expect(answer.response).toContain('Yes');
  });

  it('an evasive world answer leaves the item unresolved and re-reported', () => {
    const items = sweepConflicts(teacher);
    const results = runVerificationRound(teacher, items, () => 'I am not sure.');
    expect(results.every((r) => r.resolved === false)).toBe(true);
    expect(results.every((r) => r.worldVerdict === null)).toBe(true);
    expect(sweepConflicts(teacher)).toHaveLength(6);
  });

  it('the one-shot ledger suppresses a conflict whose edges still show both sides', () => {
    const items = sweepConflicts(teacher);
    const whale = itemById(items, WHALE_DIRECT);
    // A corroborated edge (an agreeing source): strength 2 — one negative
    // resolution cannot push it below the sweep floor.
    teacher.bumpEdge('whale', 'is-a', 'fish', +1);
    applyResolution(teacher, whale, 'negative');
    expect(teacher.edgeStrengthOf('whale', 'is-a', 'fish')).toBe(1.3); // still ≥ floor
    // Detection alone would still find the disagreement...
    expect(detectConflicts(teacher.relations(), teacher.negationsList()).some((c) => c.id === whale.id)).toBe(true);
    // ...but the ledger keeps the sweep silent (one-shot, no ping-pong).
    expect(sweepConflicts(teacher).some((item) => item.id === whale.id)).toBe(false);
  });
});
