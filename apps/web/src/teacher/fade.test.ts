/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent, CREATIVE_REINFORCE_SCORE } from './TeacherAgent';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import {
  emptyFadeState,
  updateFadeState,
  isUncertain,
  effectiveLambda,
  blendReward,
  classifyUtterance,
  HANDOVER_THRESHOLD,
  FADE_CEILING,
  FADE_FLOOR
} from './fade';
import { compositeScore } from './composite';
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

async function setup(): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, DECK);
  for (const entry of DECK) teacher.teach(entry.word);
  return { session, teacher };
}

describe('the fading controller (Phase 7c — the calibrated handover)', () => {
  it('λ climbs only after agreement crosses the threshold, and caps at the ceiling', () => {
    const state = emptyFadeState();
    expect(state.lambda.conversational).toBe(0);
    updateFadeState(state, 'conversational', 0.4); // below threshold → no climb
    expect(state.lambda.conversational).toBe(0);
    updateFadeState(state, 'conversational', 0.75); // ≥ 0.7 → climbs
    expect(state.lambda.conversational).toBeGreaterThan(0);
    for (let i = 0; i < 20; i += 1) updateFadeState(state, 'conversational', 0.9);
    expect(state.lambda.conversational).toBeLessThanOrEqual(FADE_CEILING);
  });

  it('agreement falling below the threshold drifts λ back down (regression guard)', () => {
    const state = emptyFadeState();
    updateFadeState(state, 'conversational', 0.8); // climb
    const climbed = state.lambda.conversational;
    expect(climbed).toBeGreaterThan(0);
    updateFadeState(state, 'conversational', 0.4); // regress
    expect(state.lambda.conversational).toBeLessThan(climbed);
  });

  it('uncertainty fallback consults the teacher (λ drops to the floor)', () => {
    const state = emptyFadeState();
    // Climb multiple times so λ has room above the floor.
    updateFadeState(state, 'operator', 0.9);
    updateFadeState(state, 'operator', 0.9);
    updateFadeState(state, 'operator', 0.9);
    const lambda = state.lambda.operator;
    expect(lambda).toBeGreaterThan(FADE_FLOOR);
    expect(effectiveLambda(state, 'operator', true)).toBe(FADE_FLOOR);
  });

  it('isUncertain flags low fluency only (the answer’s own flow — not utterance tokens)', () => {
    const weights = new Map<string, number>([['hello|there', 2]]);
    // Nonzero fluency → not uncertain, regardless of the utterance's tokens
    // (the transition map only holds composition-context n-grams; the
    // observer need never have composed the question to grade the answer).
    expect(isUncertain('do you like xylophone', 'hello there', weights, 0.5)).toBe(false);
    expect(isUncertain('hello there', 'hello there', weights, 0.5)).toBe(false);
    // Zero fluency → uncertain (the student has no opinion).
    expect(isUncertain('hello there', 'hello there', weights, 0)).toBe(true);
  });

  it('blendReward is the weighted ensemble', () => {
    expect(blendReward(1, 0.5, 0.8)).toBeCloseTo(0.8 * 0.5 + 0.2 * 1);
    expect(blendReward(1, 0.5, 0)).toBe(1); // teacher alone
    expect(blendReward(1, 0.5, 1)).toBe(0.5); // student alone
  });

  it('classifyUtterance separates operator-form from conversational', () => {
    expect(classifyUtterance('what is water')).toBe('operator');
    expect(classifyUtterance('do you like tea')).toBe('operator');
    expect(classifyUtterance('hello there')).toBe('conversational');
  });

  it('the teacher-level reward blends: with λ=0 no blend, with agreement → composite enters', async () => {
    const { session, teacher } = await setup();
    // No agreement yet → λ=0 → the reward is the teacher grade alone.
    // (No seeds → novelty 0 → composite 0 — but λ=0 keeps the teacher grade.)
    const noAgreement = teacher.fadeReward('tell me something about yourself', 'I like the weather.', 0.8, []);
    expect(noAgreement).toBeCloseTo(0.8);

    // Note a high agreement for conversational → λ climbs.
    teacher.noteFadeAgreement('conversational', 0.9);
    teacher.noteFadeAgreement('conversational', 0.9);
    expect(teacher.fadeLambdas().conversational).toBeGreaterThan(0);

    // An ECHO answer (verbatim seed) has composite 0: the student abstains
    // and the teacher grade passes through — the blend must never drag a
    // strong grade below the reinforce gate (the degenerate handover).
    const echo = teacher.fadeReward('tell me something about yourself', 'I like the weather.', 0.8, ['I like the weather.']);
    expect(compositeScore('I like the weather.', 'tell me something about yourself', teacher.getCompositionWeights(), ['I like the weather.']).composite).toBe(0);
    expect(echo).toBeCloseTo(0.8);

    // A genuinely composed answer (novel words AND reference to the question)
    // earns the student a voice: composite > 0, so the blend moves off the
    // teacher grade toward the composite.
    seedWeights(teacher, 'do you like tea I like tea and I like rain');
    const novel = teacher.fadeReward('do you like tea', 'I like tea and I like rain.', 0.8, ['I like tea.']);
    const novelComposite = compositeScore('I like tea and I like rain.', 'do you like tea', teacher.getCompositionWeights(), ['I like tea.']).composite;
    expect(novelComposite).toBeGreaterThan(0);
    expect(novel).toBeGreaterThan(0.8 - 1e-9);
    expect(novel).toBeLessThanOrEqual(0.8 + 1e-9);
    session.dispose();
  });

  it('the handover never unlearns: a strong grade at λ > 0 still stores — echo abstains, seeds reinforce', async () => {
    const { session, teacher } = await setup();
    teacher.teachResponse({ cue: 'how are you', response: 'I am well, thank you.' });
    const bank = session.observer.getMemoryBank();
    const seed = bank.all()[0];

    // Handover fully engaged: λ near the ceiling.
    for (let i = 0; i < 8; i += 1) teacher.noteFadeAgreement('conversational', 0.9);
    expect(teacher.fadeLambdas().conversational).toBeGreaterThan(0.5);

    // Knock the seed below cap so the reinforcement is measurable.
    seed.strength = 0.7;
    const seedStrengthBefore = seed.strength;

    // An ECHO answer at λ=0.8: the composite is 0 (no novelty), the student
    // abstains, the teacher grade 0.8 passes through → the answer is still
    // stored as a strong creative memory and its seed is REINFORCED. Before
    // the fix, the blend dragged the reward to 0.32 — the seed was weakened,
    // a gap recorded, and the answer never stored (the unlearning handover).
    const stored = teacher.creativeGradeFeedback(
      { traceIds: [seed.id], edges: [] },
      0.8,
      'how are you feeling',
      'I am well, thank you.'
    );
    expect(stored).toBe(true);
    expect(seed.strength).toBeGreaterThan(seedStrengthBefore);
    expect(
      bank.all().some((t) => t.metadata?.kind === 'creative' && t.metadata?.uttered === 'how are you feeling')
    ).toBe(true);
    session.dispose();
  });

  // ── PHASE 7d: the self-grading student (steady state) ──

/** Seed the composition weights with the prompt's own n-grams so the tiny
 *  test deck is not "novel terrain" (the uncertainty fallback would
 *  otherwise consult the teacher on everything, masking the handover). */
function seedWeights(teacher: TeacherAgent, text: string): void {
  const words = text.toLowerCase().split(' ');
  for (let i = 0; i < words.length - 1; i += 1) {
    teacher.getCompositionWeights().set(`${words[i]}|${words[i + 1]}`, 2);
    if (i < words.length - 2) teacher.getCompositionWeights().set(`${words[i]}|${words[i + 1]}|${words[i + 2]}`, 2);
  }
}

it('teacher-dependence falls as λ climbs and rises again on novel terrain', async () => {
    const { session, teacher } = await setup();
    const q = 'tell me something about yourself';
    const a = 'I like the weather here.';
    seedWeights(teacher, `${q} ${a}`);

    // Scaffolded start: no agreement → fully teacher-dependent.
    teacher.fadeReward(q, a, 0.8, []);
    expect(teacher.teacherDependenceRate()).toBe(1);

    // Handover: high agreement climbs λ — the student self-grades, so the
    // dependence rate drops below 1.
    for (let i = 0; i < 6; i += 1) teacher.noteFadeAgreement('conversational', 0.9);
    teacher.fadeReward(q, a, 0.8, []);
    teacher.fadeReward(q, a, 0.8, []);
    expect(teacher.teacherDependenceRate()).toBeLessThan(1);

    // Novel/uncertain terrain keeps the teacher: an utterance whose tokens
    // the weights never saw → uncertainty fallback → consulted (dependence
    // rises back toward the floor for the novel case).
    teacher.fadeReward('do you like xylophone quartz', a, 0.5, []);
    expect(teacher.teacherDependenceRate()).toBeGreaterThan(0);
    session.dispose();
  });

  it('teacher-dependence is monotone down as the handover progresses', async () => {
    const { session, teacher } = await setup();
    const q = 'tell me something about yourself';
    const a = 'I like the weather here.';
    seedWeights(teacher, `${q} ${a}`);
    teacher.fadeReward(q, a, 0.8, []);
    const start = teacher.teacherDependenceRate();
    expect(start).toBe(1);
    for (let i = 0; i < 8; i += 1) teacher.noteFadeAgreement('conversational', 0.9);
    for (let i = 0; i < 5; i += 1) teacher.fadeReward(q, a, 0.8, []);
    const after = teacher.teacherDependenceRate();
    expect(after).toBeLessThan(start);
    expect(after).toBeLessThan(0.5); // the student now grades most answers
    session.dispose();
  });
});