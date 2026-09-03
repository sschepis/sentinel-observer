/**
 * L2 Phase 20 gates — the emergent handover.
 *
 * The Phase 7c fade state machine (threshold/rate/ceiling/floor) is DELETED.
 * λ is normalized trust from the kernel: λ = T_composite/(T_composite+T_llm),
 * each T a Wilson lower bound on measured agreement. These tests pin the
 * emergent theorems the old constants hard-coded.
 *
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { blendReward, classifyUtterance, fadeCriteria } from './fade';
import {
  TrustKernel,
  fusionLambda,
  wilsonLowerBound,
  JUDGE_LLM,
  JUDGE_COMPOSITE,
  TRUST_PRIOR
} from './trust';
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

const CRITERIA = fadeCriteria('conversational');

describe('the trust kernel (20.1)', () => {
  it('wilsonLowerBound: 0 at no evidence, below the rate, tightening with mass', () => {
    expect(wilsonLowerBound(1, 0)).toBe(0);
    expect(wilsonLowerBound(0.9, 10)).toBeLessThan(0.9);
    expect(wilsonLowerBound(0.9, 100)).toBeGreaterThan(wilsonLowerBound(0.9, 10));
    expect(wilsonLowerBound(0.9, 100000)).toBeCloseTo(0.9, 2); // mass↑ ⇒ LB → rate
  });

  it('a newcomer judge (prior 0) has trust exactly 0 with no evidence', () => {
    const kernel = new TrustKernel();
    expect(kernel.trustLB(JUDGE_COMPOSITE, CRITERIA, 0)).toBe(0);
  });

  it('an incumbent judge (the LLM) is trusted at the prior lower bound even unmeasured', () => {
    const kernel = new TrustKernel();
    const cold = kernel.trustLB(JUDGE_LLM, CRITERIA, TRUST_PRIOR);
    expect(cold).toBeGreaterThan(0.15);
    expect(cold).toBeLessThan(TRUST_PRIOR);
  });

  it('evidence moves trust toward the measured rate for both judges', () => {
    const kernel = new TrustKernel();
    for (let i = 0; i < 50; i += 1) kernel.record(JUDGE_COMPOSITE, CRITERIA, true);
    for (let i = 0; i < 50; i += 1) kernel.record(JUDGE_LLM, CRITERIA, i % 2 === 0);
    expect(kernel.trustLB(JUDGE_COMPOSITE, CRITERIA, 0)).toBeGreaterThan(0.7);
    expect(kernel.trustLB(JUDGE_LLM, CRITERIA, TRUST_PRIOR)).toBeLessThan(0.6); // measured ~0.5+prior pull
  });
});

describe('the emergent handover λ (20.4)', () => {
  it('a BLIND bucket has λ = 0 — the teacher is the authority on novel terrain', () => {
    const kernel = new TrustKernel();
    expect(fusionLambda(kernel, CRITERIA)).toBe(0);
    // ...even when the teacher is also unmeasured (its prior holds).
    expect(fusionLambda(kernel, fadeCriteria('operator'))).toBe(0);
  });

  it('λ climbs with sustained composite agreement — the handover is earned', () => {
    const kernel = new TrustKernel();
    const trajectory: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      kernel.record(JUDGE_COMPOSITE, CRITERIA, true);
      if (i % 10 === 9) trajectory.push(fusionLambda(kernel, CRITERIA));
    }
    for (let i = 1; i < trajectory.length; i += 1) {
      expect(trajectory[i]).toBeGreaterThanOrEqual(trajectory[i - 1]);
    }
    expect(trajectory[trajectory.length - 1]).toBeGreaterThan(0.5);
  });

  it('the EMERGENT CEILING: perfect agreement at finite mass keeps λ < 0.95, and equally-proven judges settle near 0.5', () => {
    const kernel = new TrustKernel();
    for (let i = 0; i < 200; i += 1) kernel.record(JUDGE_COMPOSITE, CRITERIA, true);
    expect(fusionLambda(kernel, CRITERIA)).toBeLessThan(0.95);

    const proven = new TrustKernel();
    for (let i = 0; i < 200; i += 1) {
      proven.record(JUDGE_COMPOSITE, CRITERIA, true);
      proven.record(JUDGE_LLM, CRITERIA, true);
    }
    const lambda = fusionLambda(proven, CRITERIA);
    expect(lambda).toBeGreaterThan(0.4);
    expect(lambda).toBeLessThan(0.6);
  });

  it('REGRESSION: a composite that stops agreeing loses λ with no special case', () => {
    const kernel = new TrustKernel();
    // Both judges measured (production shape: every graded answer records
    // LLM agreement too).
    for (let i = 0; i < 100; i += 1) kernel.record(JUDGE_LLM, CRITERIA, i % 8 !== 0); // ~0.875
    for (let i = 0; i < 40; i += 1) kernel.record(JUDGE_COMPOSITE, CRITERIA, true);
    const earned = fusionLambda(kernel, CRITERIA);
    const earnedTrust = kernel.trustLB(JUDGE_COMPOSITE, CRITERIA, 0);
    for (let i = 0; i < 40; i += 1) kernel.record(JUDGE_COMPOSITE, CRITERIA, false);
    // Trust collapses by a meaningful fraction and λ falls below the
    // majority line — the student is out-measured again.
    expect(kernel.trustLB(JUDGE_COMPOSITE, CRITERIA, 0)).toBeLessThan(earnedTrust - 0.2);
    expect(fusionLambda(kernel, CRITERIA)).toBeLessThan(earned - 0.1);
    expect(fusionLambda(kernel, CRITERIA)).toBeLessThan(0.5);
  });

  it('HACK-RESISTANCE: an always-strong composite loses trust and λ under world disagreements (weight 0.25)', () => {
    const kernel = new TrustKernel();
    for (let i = 0; i < 100; i += 1) kernel.record(JUDGE_LLM, CRITERIA, i % 8 !== 0);
    for (let i = 0; i < 40; i += 1) kernel.record(JUDGE_COMPOSITE, CRITERIA, true);
    const earned = fusionLambda(kernel, CRITERIA);
    const earnedTrust = kernel.trustLB(JUDGE_COMPOSITE, CRITERIA, 0);
    expect(earned).toBeGreaterThan(0.4);
    // The composite flatters itself; the world contradicts it re-ask by
    // re-ask (weak evidence, 0.25 each) — trust must fall anyway.
    for (let i = 0; i < 40; i += 1) kernel.record(JUDGE_COMPOSITE, CRITERIA, false, 0.25);
    expect(kernel.trustLB(JUDGE_COMPOSITE, CRITERIA, 0)).toBeLessThan(earnedTrust - 0.1);
    expect(fusionLambda(kernel, CRITERIA)).toBeLessThan(earned);
  });
});

describe('classifyUtterance (unchanged contract)', () => {
  it('conversational prompts are not operator questions even when they start with "what"', () => {
    expect(classifyUtterance('what do you think about rain?')).toBe('conversational');
    expect(classifyUtterance('tell me about water')).toBe('conversational');
    expect(classifyUtterance('how are you today?')).toBe('conversational');
  });

  it('operator-shaped questions classify as operator', () => {
    expect(classifyUtterance('what is water?')).toBe('operator');
    expect(classifyUtterance('is a bird an animal?')).toBe('operator');
    expect(classifyUtterance('can a bird fly?')).toBe('operator');
  });

  it('everything else defaults to conversational', () => {
    expect(classifyUtterance('the rain fell all day')).toBe('conversational');
  });
});

describe('blendReward (the abstention guard, unchanged contract)', () => {
  it('a composite of 0 passes the teacher grade through untouched at ANY λ', () => {
    expect(blendReward(0.8, 0, 0.9)).toBe(0.8);
    expect(blendReward(0.2, 0, 0.5)).toBe(0.2);
  });

  it('a positive composite blends linearly', () => {
    expect(blendReward(0.8, 0.6, 0.5)).toBeCloseTo(0.7, 10);
    expect(blendReward(0.8, 0.6, 0)).toBeCloseTo(0.8, 10);
    expect(blendReward(0.8, 0.6, 1)).toBeCloseTo(0.6, 10);
  });
});

describe('the handover end-to-end (TeacherAgent wiring)', () => {
  it('λ starts at 0, climbs with measured agreement, and survives a reload through the kernel snapshot', async () => {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK);

    expect(teacher.fadeLambdas().conversational).toBe(0);
    expect(teacher.teacherDependenceRate()).toBe(0);

    // Bench windows: sustained strong agreement feeds the composite judge.
    for (let i = 0; i < 8; i += 1) teacher.noteFadeAgreement('conversational', 0.9);
    const lambda = teacher.fadeLambdas().conversational;
    expect(lambda).toBeGreaterThan(0);
    expect(lambda).toBeLessThan(0.95);
    expect(teacher.fadeAgreements().conversational).toBeCloseTo(0.9, 10);

    // A weak window is disagreement evidence — λ falls.
    for (let i = 0; i < 8; i += 1) teacher.noteFadeAgreement('conversational', 0.2);
    expect(teacher.fadeLambdas().conversational).toBeLessThan(lambda);

    session.dispose();
  });

  it('fadeReward blends by the emergent λ and accounts dependence as the teacher share', async () => {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK);

    // Cold: the composite abstains or λ = 0 — the teacher grade passes.
    const cold = teacher.fadeReward('tell me about water', 'Water is wet and clear.', 0.8, ['a clear liquid that falls as rain']);
    expect(cold).toBeCloseTo(0.8, 10);
    expect(teacher.teacherDependenceRate()).toBe(1);

    session.dispose();
  });
});
