/**
 * D.7 (§5.2 row 8) — goal promotion by MDL gain, behind a flag.
 *
 * The fixed 2-miss threshold is the CONTROL; with the flag on, a recurring
 * deficit is promoted to a shared goal exactly when its MDL gain as a goal
 * is positive — a goal that saves more asks than it costs (the same
 * criterion as operators). This bench pins the gain arithmetic (pure), the
 * uniform-token fallback parity with the operator learner's default, and —
 * behaviorally, on a live council — that promotion happens ONLY at positive
 * gain: a long target (costly goal) crosses zero later than a short one.
 *
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { ObserverNetwork, goalPromotionGain } from './network';
import { TokenCostModel } from './mdl';
import { DEFAULT_TOKEN_COST } from './operators/learning';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import type { DeckWord } from './deck';

const DECK: readonly DeckWord[] = [
  { word: 'water', definition: 'a clear liquid that falls as rain', example: 'Water is wet.' },
  { word: 'bird', definition: 'an animal with wings', example: 'A bird can fly.' }
];
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

const SHORT_TARGET = 'what is zzz';
// 14 tokens — the goal is more expensive to encode than the ask it avoids.
const LONG_TARGET = 'what is aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll';

let randomSpy: ReturnType<typeof jest.spyOn> | null = null;

beforeEach(() => {
  let seed = 0x2f6e2b1;
  randomSpy = jest.spyOn(Math, 'random').mockImplementation(() => {
    seed = (Math.imul(seed, 48271) % 2147483647) >>> 0;
    return seed / 2147483647;
  });
});

afterEach(() => {
  randomSpy?.mockRestore();
  randomSpy = null;
});

async function councilOf(goalPromotionMdl: boolean, goalCost: TokenCostModel | null = null): Promise<{
  network: ObserverNetwork;
  dispose: () => void;
}> {
  const sessions: ObserverSession[] = [];
  const teachers: TeacherAgent[] = [];
  for (let i = 0; i < 2; i += 1) {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK);
    for (const entry of DECK) teacher.teach(entry.word);
    sessions.push(session);
    teachers.push(teacher);
  }
  const network = new ObserverNetwork(
    [
      { name: 'one', teacher: teachers[0] },
      { name: 'two', teacher: teachers[1] }
    ],
    2,
    0.55,
    0.2,
    0.1,
    2,
    true,
    goalPromotionMdl,
    goalCost
  );
  return {
    network,
    dispose: () => {
      for (const session of sessions) session.dispose();
    }
  };
}

describe('goalPromotionGain — the MDL criterion (pure)', () => {
  it('the first abstention never pays for the goal: gain is negative at one miss', () => {
    const gain = goalPromotionGain({ target: SHORT_TARGET, misses: 1 });
    expect(gain).toBeLessThan(0);
  });

  it('uniform fallback (10 bits/token, the learner\'s default): (misses − 1) asks vs. the target', () => {
    // Canonical ask: 4 tokens; target: 3 tokens — gain(2) = 40 − 30 = 10.
    expect(goalPromotionGain({ target: SHORT_TARGET, misses: 2 })).toBeCloseTo(10, 10);
    const askTokens = 'I do not know.'.split(' ');
    expect(goalPromotionGain({ target: SHORT_TARGET, misses: 2 })).toBeCloseTo(
      (2 - 1) * askTokens.length * DEFAULT_TOKEN_COST - 3 * DEFAULT_TOKEN_COST,
      10
    );
  });

  it('a recorded ask text replaces the canonical one; a frequency model replaces the uniform cost', () => {
    const model = new TokenCostModel(['i', 'do', 'not', 'know', 'what', 'means', 'could', 'you', 'teach', 'me']);
    const goal = { target: SHORT_TARGET, misses: 3, lastAsk: 'i do not know what zzz means' };
    const expected = (3 - 1) * model.costOfText(goal.lastAsk) - model.costOfText(SHORT_TARGET);
    expect(goalPromotionGain(goal, model)).toBeCloseTo(expected, 10);
  });

  it('a long target (expensive goal) stays negative at two misses and crosses zero at three', () => {
    // Uniform: canonical ask 40 bits; LONG_TARGET = 14 tokens = 140 bits.
    expect(goalPromotionGain({ target: LONG_TARGET, misses: 2 })).toBeCloseTo(40 - 140, 10);
    expect(goalPromotionGain({ target: LONG_TARGET, misses: 3 })).toBeCloseTo(80 - 140, 10);
  });
});

describe('the council promotes only at positive gain (flag on) vs. the 2-miss control (flag off)', () => {
  it('control (flag off): a recurring unanimous abstention promotes at 2 misses', async () => {
    const { network, dispose } = await councilOf(false);
    network.respond(SHORT_TARGET);
    let goals = network.networkGoals();
    expect(goals).toHaveLength(1);
    expect(goals[0].active).toBe(false);
    network.respond(SHORT_TARGET);
    goals = network.networkGoals();
    expect(goals[0].misses).toBe(2);
    expect(goals[0].adopted).toBe(true);
    expect(goals[0].active).toBe(true);
    dispose();
  });

  it('flag on, cheap goal: the gain is positive at 2 misses and the goal promotes', async () => {
    const { network, dispose } = await councilOf(true);
    network.respond(SHORT_TARGET);
    let goals = network.networkGoals();
    expect(goals[0].adopted).toBe(false);
    expect(goalPromotionGain(goals[0])).toBeLessThan(0);
    network.respond(SHORT_TARGET);
    goals = network.networkGoals();
    expect(goalPromotionGain(goals[0])).toBeGreaterThan(0);
    expect(goals[0].adopted).toBe(true);
    dispose();
  });

  it('flag on, expensive goal: promotion happens ONLY when the gain turns positive', async () => {
    const { network, dispose } = await councilOf(true);
    // Two abstentions: the deficit recurred, but the goal costs more than
    // the one ask it saves — the control would already have promoted.
    network.respond(LONG_TARGET);
    network.respond(LONG_TARGET);
    let goals = network.networkGoals();
    expect(goals[0].misses).toBe(2);
    expect(goalPromotionGain(goals[0])).toBeLessThan(0);
    expect(goals[0].adopted).toBe(false);
    // The third abstention: the goal now saves more asks than it costs.
    network.respond(LONG_TARGET);
    goals = network.networkGoals();
    expect(goals[0].misses).toBe(3);
    expect(goalPromotionGain(goals[0])).toBeGreaterThan(0);
    expect(goals[0].adopted).toBe(true);
    expect(goals[0].active).toBe(true);
    dispose();
  });
});
