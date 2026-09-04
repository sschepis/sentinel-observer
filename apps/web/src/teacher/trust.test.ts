/**
 * D.8 (§5.2 row 9) — the world-outcome weight, measured by the kernel.
 *
 * The fixed weight (world 0.25 vs. teacher 1.0) is the CONTROL; behind the
 * flag, the world channel's weight is its MEASURED agreement with ground
 * truth via the trust kernel's bucket machinery: the world is a junior judge
 * (JUDGE_WORLD) whose Wilson lower bound at prior 0 IS the weight. This bench
 * pins the measured weight bounded and evidence-responsive, the flag gating
 * (off = the 0.25 control), and the kernel contract the weight builds on.
 *
 * @jest-environment node
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import {
  TrustKernel,
  wilsonLowerBound,
  JUDGE_LLM,
  JUDGE_COMPOSITE,
  JUDGE_WORLD,
  TRUST_PRIOR,
  WORLD_FEEDBACK_CONTROL,
  measuredWorldWeight,
  worldFeedbackWeight,
  setWorldWeightMeasured,
  isWorldWeightMeasured,
  type TrustCriteria
} from './trust';
import { WORLD_FEEDBACK_WEIGHT } from './reliability';

afterEach(() => {
  setWorldWeightMeasured(false);
});

const CRITERIA: TrustCriteria = {
  answerType: 'creative',
  difficultyBand: 'mid',
  template: 'conversational',
  provider: ''
};

describe('the trust kernel (the machinery the measured weight builds on)', () => {
  it('wilsonLowerBound: 0 at no evidence, below the rate, tightening with mass', () => {
    expect(wilsonLowerBound(1, 0)).toBe(0);
    expect(wilsonLowerBound(0.9, 10)).toBeLessThan(0.9);
    expect(wilsonLowerBound(0.9, 100)).toBeGreaterThan(wilsonLowerBound(0.9, 10));
  });

  it('a newcomer judge (prior 0) earns trust from zero; an incumbent keeps its prior', () => {
    const kernel = new TrustKernel();
    expect(kernel.trustLB(JUDGE_COMPOSITE, CRITERIA, 0)).toBe(0);
    const incumbent = kernel.trustLB(JUDGE_LLM, CRITERIA, TRUST_PRIOR);
    expect(incumbent).toBeGreaterThan(0.15);
    expect(incumbent).toBeLessThan(TRUST_PRIOR);
  });

  it('the world judge is measured in the same buckets as every judge', () => {
    const kernel = new TrustKernel();
    for (let i = 0; i < 50; i += 1) kernel.record(JUDGE_WORLD, CRITERIA, true);
    const evidence = kernel.evidence(JUDGE_WORLD, CRITERIA, 0);
    expect(evidence.samples).toBe(50);
    expect(evidence.agreements).toBe(50);
    expect(evidence.agreementRate).toBe(1);
  });
});

describe('D.8 — the measured world-outcome weight', () => {
  it('parity: the control matches the hand WORLD_FEEDBACK_WEIGHT, and the gate defaults OFF', () => {
    expect(WORLD_FEEDBACK_CONTROL).toBe(WORLD_FEEDBACK_WEIGHT);
    expect(WORLD_FEEDBACK_CONTROL).toBe(0.25);
    expect(isWorldWeightMeasured()).toBe(false);
  });

  it('flag OFF: the live weight is the 0.25 control, whatever the world has done', () => {
    const kernel = new TrustKernel();
    for (let i = 0; i < 20; i += 1) kernel.record(JUDGE_WORLD, CRITERIA, true);
    expect(worldFeedbackWeight(kernel, CRITERIA)).toBe(WORLD_FEEDBACK_CONTROL);
    for (let i = 0; i < 20; i += 1) kernel.record(JUDGE_WORLD, CRITERIA, false);
    expect(worldFeedbackWeight(kernel, CRITERIA)).toBe(WORLD_FEEDBACK_CONTROL);
  });

  it('the measured weight is BOUNDED: 0 with no evidence, always inside [0, 1)', () => {
    const kernel = new TrustKernel();
    expect(measuredWorldWeight(kernel, CRITERIA)).toBe(0);
    for (let i = 0; i < 200; i += 1) kernel.record(JUDGE_WORLD, CRITERIA, true);
    const perfect = measuredWorldWeight(kernel, CRITERIA);
    expect(perfect).toBeGreaterThanOrEqual(0);
    expect(perfect).toBeLessThan(1);
  });

  it('the measured weight RESPONDS to evidence: agreements raise it, disagreements lower it', () => {
    const kernel = new TrustKernel();
    setWorldWeightMeasured(true);
    expect(worldFeedbackWeight(kernel, CRITERIA)).toBe(0);
    for (let i = 0; i < 60; i += 1) kernel.record(JUDGE_WORLD, CRITERIA, true);
    const agreed = worldFeedbackWeight(kernel, CRITERIA);
    expect(agreed).toBeGreaterThan(0.5);
    for (let i = 0; i < 60; i += 1) kernel.record(JUDGE_WORLD, CRITERIA, false);
    const contradicted = worldFeedbackWeight(kernel, CRITERIA);
    expect(contradicted).toBeLessThan(agreed);
    expect(contradicted).toBeLessThan(0.5);
  });

  it('a world channel that flatters itself diverges from ground truth and its weight collapses', () => {
    const kernel = new TrustKernel();
    setWorldWeightMeasured(true);
    for (let i = 0; i < 30; i += 1) kernel.record(JUDGE_WORLD, CRITERIA, true);
    const earned = worldFeedbackWeight(kernel, CRITERIA);
    expect(earned).toBeGreaterThan(0.5);
    // Ground truth disagrees 3:1 from here on — the measured rate falls.
    for (let i = 0; i < 60; i += 1) kernel.record(JUDGE_WORLD, CRITERIA, i % 4 !== 0);
    expect(worldFeedbackWeight(kernel, CRITERIA)).toBeLessThan(earned);
  });

  it('the weight is bucketed: evidence in one criteria tuple does not leak into another', () => {
    const kernel = new TrustKernel();
    setWorldWeightMeasured(true);
    const other: TrustCriteria = {
      answerType: 'definition',
      difficultyBand: 'high',
      template: 'operator',
      provider: 'x'
    };
    for (let i = 0; i < 50; i += 1) kernel.record(JUDGE_WORLD, CRITERIA, true);
    expect(worldFeedbackWeight(kernel, CRITERIA)).toBeGreaterThan(0.5);
    // The other bucket saw no outcomes on any consulted cell → its measured
    // weight is 0 (a blind bucket is untrusted no matter how loudly its
    // neighbor agrees).
    expect(worldFeedbackWeight(kernel, other)).toBe(0);
  });
});
