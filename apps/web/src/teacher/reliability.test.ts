/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  GraderReliabilityModel,
  difficultyBandOf,
  gradeBandOf,
  ruleBandForGrounding,
  bandsAgree,
  criteriaKey,
  PRIOR_RELIABILITY,
  MIN_FEEDBACK_WEIGHT,
  WORLD_FEEDBACK_WEIGHT,
  PENDING_REGRADE_CAP
} from './reliability';
import { groundingScore } from './grounding';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { DECK_100 } from './decks/en-100';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { GradeCriteria } from './reliability';

const CRITERIA: GradeCriteria = {
  answerType: 'creative',
  difficultyBand: 'mid',
  template: 'conversational',
  provider: 'lmstudio'
};

describe('grader reliability: criteria bands', () => {
  it('difficultyBandOf splits the FSRS [1, 10] scale into low/mid/high', () => {
    expect(difficultyBandOf(1)).toBe('low');
    expect(difficultyBandOf(3.9)).toBe('low');
    expect(difficultyBandOf(4)).toBe('mid');
    expect(difficultyBandOf(7)).toBe('mid');
    expect(difficultyBandOf(7.1)).toBe('high');
    expect(difficultyBandOf(10)).toBe('high');
  });

  it('gradeBandOf mirrors the reinforce/weaken thresholds (0.7 / 0.3)', () => {
    expect(gradeBandOf(0.95)).toBe('strong');
    expect(gradeBandOf(0.7)).toBe('strong');
    expect(gradeBandOf(0.5)).toBe('mid');
    expect(gradeBandOf(0.31)).toBe('mid');
    expect(gradeBandOf(0.3)).toBe('weak');
    expect(gradeBandOf(0.05)).toBe('weak');
  });

  it('ruleBandForGrounding predicts the gold-set bands from the composition check', () => {
    // A fabrication (no grounded word) predicts weak.
    expect(ruleBandForGrounding(groundingScore('I flew to the moon on a dragon.', ['Water is wet.']))).toBe('weak');
    // An echo of its seeds predicts mid — honest, but no composition.
    expect(ruleBandForGrounding(groundingScore('Water is wet.', ['Water is wet.']))).toBe('mid');
    // A grounded, composed answer with novel stitches predicts strong.
    const composed = groundingScore(
      'Water is a clear liquid, and rain falls gently from the sky as drops.',
      ['Water is a clear liquid that falls as rain.', 'Rain is water from the sky.']
    );
    expect(composed.isEcho).toBe(false);
    expect(composed.isFabrication).toBe(false);
    expect(ruleBandForGrounding(composed)).toBe('strong');
  });

  it('bandsAgree only when the rule check has an opinion and matches', () => {
    expect(bandsAgree('strong', 'strong')).toBe(true);
    expect(bandsAgree('strong', 'weak')).toBe(false);
    expect(bandsAgree('strong', null)).toBe(true);
  });

  it('criteriaKey distinguishes every dimension', () => {
    const a: GradeCriteria = { ...CRITERIA };
    const b: GradeCriteria = { ...CRITERIA, provider: 'other' };
    const c: GradeCriteria = { ...CRITERIA, answerType: 'spelling' };
    expect(criteriaKey(a)).not.toBe(criteriaKey(b));
    expect(criteriaKey(a)).not.toBe(criteriaKey(c));
    expect(criteriaKey(a)).toBe(criteriaKey({ ...CRITERIA }));
  });
});

describe('grader reliability: agreement tracking and smoothing', () => {
  it('a cold model returns the prior and full weight — no evidence, no distrust', () => {
    const model = new GraderReliabilityModel();
    expect(model.reliability(CRITERIA)).toBeCloseTo(PRIOR_RELIABILITY, 10);
    expect(model.feedbackWeight(CRITERIA)).toBe(1);
    const evidence = model.evidence(CRITERIA);
    expect(evidence.samples).toBe(0);
    expect(evidence.agreementRate).toBe(0);
    expect(evidence.weight).toBe(1);
  });

  it('agreement rises with confirming evidence and falls with disagreements', () => {
    const model = new GraderReliabilityModel();
    for (let i = 0; i < 20; i += 1) model.recordAgreement(CRITERIA, true);
    expect(model.reliability(CRITERIA)).toBeGreaterThan(0.9);
    expect(model.feedbackWeight(CRITERIA)).toBe(1);

    const noisy: GradeCriteria = { ...CRITERIA, provider: 'small-model' };
    for (let i = 0; i < 30; i += 1) model.recordAgreement(noisy, false);
    // 30 disagreements outweigh the 20 agreements of the shared dimensions.
    expect(model.reliability(noisy)).toBeLessThan(PRIOR_RELIABILITY);
    expect(model.feedbackWeight(noisy)).toBeLessThan(1);
    expect(model.feedbackWeight(noisy)).toBeGreaterThanOrEqual(MIN_FEEDBACK_WEIGHT);
  });

  it('a sparse bucket leans on its dimensions and the prior', () => {
    const model = new GraderReliabilityModel();
    // A bucket with ONE agreeing sample must not jump to ~1.0 — the
    // Bayesian smoothing keeps it modest while the dimension evidence holds.
    model.recordAgreement(CRITERIA, true);
    expect(model.reliability(CRITERIA)).toBeGreaterThan(PRIOR_RELIABILITY);
    expect(model.reliability(CRITERIA)).toBeLessThan(0.9);

    // A sibling bucket in the same template/difficulty inherits the pull.
    const sibling: GradeCriteria = { ...CRITERIA, provider: 'other-provider' };
    const shared = model.reliability(sibling);
    expect(shared).toBeGreaterThan(PRIOR_RELIABILITY);

    // A bucket in a DIFFERENT answer type is less affected.
    const other: GradeCriteria = { answerType: 'spelling', difficultyBand: 'high', template: 'quiz', provider: 'lmstudio' };
    expect(model.reliability(other)).toBeLessThan(shared);
  });

  it('feedbackWeight floors near MIN and never goes negative', () => {
    const model = new GraderReliabilityModel();
    const hopeless: GradeCriteria = { ...CRITERIA, answerType: 'spelling' };
    for (let i = 0; i < 100; i += 1) model.recordAgreement(hopeless, false);
    const weight = model.feedbackWeight(hopeless);
    // The Bayesian smoothing keeps the estimate above zero, so the weight
    // approaches — but never quite reaches — the MIN floor.
    expect(weight).toBeLessThan(MIN_FEEDBACK_WEIGHT + 0.05);
    expect(weight).toBeGreaterThan(MIN_FEEDBACK_WEIGHT * 0.9);
    expect(weight).toBeGreaterThan(0);
  });

  it('world feedback counts as weaker evidence than a rule check', () => {
    const model = new GraderReliabilityModel();
    // 10 world-feedback disagreements move the estimate less than 10 rule
    // checks: the world confirms slowly.
    for (let i = 0; i < 10; i += 1) model.recordWorldFeedback(CRITERIA, false);
    const worldReliability = model.reliability(CRITERIA);
    expect(worldReliability).toBeGreaterThan(0.3);
    expect(worldReliability).toBeLessThan(PRIOR_RELIABILITY);

    const model2 = new GraderReliabilityModel();
    for (let i = 0; i < 10; i += 1) model2.recordAgreement(CRITERIA, false);
    expect(model2.reliability(CRITERIA)).toBeLessThan(worldReliability);
  });
});

describe('grader reliability: the re-grade loop', () => {
  it('schedules a regrade for a disagreement and exposes it as pending', () => {
    const model = new GraderReliabilityModel();
    const id = model.scheduleRegrade(CRITERIA, {
      utterance: 'tell me about water',
      answer: 'I flew to the moon.',
      llmScore: 0.9,
      llmBand: 'strong',
      ruleBand: 'weak',
      reason: 'fabrication — the answer grounds on none of its seeds'
    });
    expect(id).toMatch(/^rg-/);
    expect(model.pendingRegrades()).toHaveLength(1);
    expect(model.pendingRegrade(id)?.detail.llmBand).toBe('strong');
  });

  it('resolving a regrade records the outcome into the bucket reliability', () => {
    const model = new GraderReliabilityModel();
    const before = model.reliability(CRITERIA);
    const id = model.scheduleRegrade(CRITERIA, {
      utterance: 'tell me about water',
      answer: 'I flew to the moon.',
      llmScore: 0.9,
      llmBand: 'strong',
      ruleBand: 'weak',
      reason: 'fabrication'
    });
    // The re-check confirms the rule side: the LLM grade was WRONG.
    expect(model.resolveRegrade(id, false)).toBe(true);
    expect(model.pendingRegrades()).toHaveLength(0);
    expect(model.regradeHistory()).toHaveLength(1);
    expect(model.regradeHistory()[0].agreed).toBe(false);
    const afterFalse = model.reliability(CRITERIA);
    expect(afterFalse).toBeLessThan(before);

    // A re-check that confirms the LLM grade raises the estimate again.
    const id2 = model.scheduleRegrade(CRITERIA, {
      utterance: 'tell me about water',
      answer: 'Water is rain.',
      llmScore: 0.8,
      llmBand: 'strong',
      ruleBand: 'mid',
      reason: 'echo'
    });
    model.resolveRegrade(id2, true);
    const afterTrue = model.reliability(CRITERIA);
    expect(afterTrue).toBeGreaterThan(afterFalse);
    // One of two resolutions was against the LLM — still below the prior.
    expect(afterTrue).toBeLessThan(before);
  });

  it('dismissing a regrade defers it without touching the stats', () => {
    const model = new GraderReliabilityModel();
    const id = model.scheduleRegrade(CRITERIA, {
      utterance: 'u',
      answer: 'a',
      llmScore: 0.9,
      llmBand: 'strong',
      ruleBand: 'weak',
      reason: 'r'
    });
    const before = model.reliability(CRITERIA);
    expect(model.dismissRegrade(id)).toBe(true);
    expect(model.pendingRegrades()).toHaveLength(0);
    expect(model.regradeHistory()).toHaveLength(0);
    expect(model.reliability(CRITERIA)).toBe(before);
    expect(model.resolveRegrade(id, true)).toBe(false);
  });

  it('the pending queue is bounded and the disagreement still counts when full', () => {
    const model = new GraderReliabilityModel();
    const criteria: GradeCriteria = { ...CRITERIA, provider: 'flood' };
    let lastId = '';
    for (let i = 0; i < PENDING_REGRADE_CAP + 5; i += 1) {
      lastId = model.scheduleRegrade(criteria, {
        utterance: `u${i}`,
        answer: 'a',
        llmScore: 0.9,
        llmBand: 'strong',
        ruleBand: 'weak',
        reason: 'r'
      });
    }
    expect(model.pendingRegrades()).toHaveLength(PENDING_REGRADE_CAP);
    expect(lastId).toBe('');
  });
});

describe('grader reliability: persistence round-trip', () => {
  it('snapshot → restore reproduces the estimates and the pending queue', () => {
    const model = new GraderReliabilityModel();
    for (let i = 0; i < 12; i += 1) model.recordAgreement(CRITERIA, i % 3 !== 0);
    model.recordWorldFeedback(CRITERIA, false);
    const id = model.scheduleRegrade(CRITERIA, {
      utterance: 'tell me about water',
      answer: 'I flew to the moon.',
      llmScore: 0.9,
      llmBand: 'strong',
      ruleBand: 'weak',
      reason: 'fabrication'
    });
    model.resolveRegrade(id, false);

    const snapshot = model.snapshot();
    const fresh = new GraderReliabilityModel();
    fresh.restore(snapshot);

    expect(fresh.reliability(CRITERIA)).toBeCloseTo(model.reliability(CRITERIA), 10);
    expect(fresh.feedbackWeight(CRITERIA)).toBe(model.feedbackWeight(CRITERIA));
    expect(fresh.pendingRegrades()).toHaveLength(model.pendingRegrades().length);
    expect(fresh.regradeHistory()).toHaveLength(1);
    expect(fresh.regradeHistory()[0].agreed).toBe(false);
  });

  it('restore tolerates malformed and partial snapshots', () => {
    const model = new GraderReliabilityModel();
    model.restore(null);
    model.restore({ buckets: { bad: { agree: 'x' as unknown as number, total: -5 } } });
    model.restore({ buckets: { [criteriaKey(CRITERIA)]: { agree: 4, total: 5 } } });
    expect(model.reliability(CRITERIA)).toBeGreaterThan(PRIOR_RELIABILITY);
    expect(model.pendingRegrades()).toHaveLength(0);
  });

  it('reset clears everything', () => {
    const model = new GraderReliabilityModel();
    model.recordAgreement(CRITERIA, true);
    model.scheduleRegrade(CRITERIA, {
      utterance: 'u',
      answer: 'a',
      llmScore: 0.9,
      llmBand: 'strong',
      ruleBand: 'weak',
      reason: 'r'
    });
    model.reset();
    expect(model.reliability(CRITERIA)).toBeCloseTo(PRIOR_RELIABILITY, 10);
    expect(model.pendingRegrades()).toHaveLength(0);
    expect(model.regradeHistory()).toHaveLength(0);
  });
});

describe('grader reliability: evidence for corroboration/curriculum modules', () => {
  it('evidence reports samples, agreements, rate, reliability and weight', () => {
    const model = new GraderReliabilityModel();
    for (let i = 0; i < 10; i += 1) model.recordAgreement(CRITERIA, i < 8);
    const evidence = model.evidence(CRITERIA);
    expect(evidence.samples).toBe(10);
    expect(evidence.agreements).toBe(8);
    expect(evidence.agreementRate).toBeCloseTo(0.8, 10);
    expect(evidence.reliability).toBeCloseTo(model.reliability(CRITERIA), 10);
    expect(evidence.weight).toBeCloseTo(model.feedbackWeight(CRITERIA), 10);
    expect(evidence.weight).toBe(1); // 0.8 agreement keeps full weight
  });

  it('world feedback weight constant is the model contract', () => {
    expect(WORLD_FEEDBACK_WEIGHT).toBe(0.25);
    expect(bandsAgree(gradeBandOf(0.71), ruleBandForGrounding(groundingScore('Water is wet.', ['Water is wet.'])))).toBe(false);
  });
});

describe('grader reliability: TeacherAgent integration (end to end)', () => {
  // The P8 deck: robin is-a bird is extracted from the definitions, so the
  // edge-strength path is exercised the same way TeacherAgent.test.ts does.
  const DECK = [
    { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
    { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' },
    { word: 'golf', definition: 'a game played with a ball', example: 'Golf uses a club.' }
  ];
  const OPTIONS = {
    primeCount: 64,
    gridSize: 128,
    memoryMode: 'compact' as const,
    vocabulary: deckVocabulary(DECK, PRIME_SPACE)
  };

  async function makeTeacher(): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK);
    for (const entry of DECK) teacher.teach(entry.word);
    return { session, teacher };
  }

  it('default grading is unchanged: full edge bump and exact FSRS update at the prior', async () => {
    const { session, teacher } = await makeTeacher();
    expect(teacher.edgeStrengthOf('robin', 'is-a', 'bird')).toBe(1);

    // P8 default: a weak grade citing the edge weakens it by exactly 0.2.
    teacher.creativeGradeFeedback(
      { traceIds: [], edges: [{ subject: 'robin', predicate: 'is-a', object: 'bird' }] },
      0.2,
      'is robin a bird',
      'probably not'
    );
    expect(teacher.edgeStrengthOf('robin', 'is-a', 'bird')).toBeCloseTo(0.8, 10);

    // FSRS default: one correct recognition grade moves stability exactly as
    // the classic update (weight 1 at the prior).
    const answer = teacher.ask('bird', 'recognition');
    teacher.grade('bird', answer);
    const state = teacher.tryState('bird')!;
    expect(state.stability).toBeCloseTo(1 + Math.exp(-5 / 8), 10);
    expect(state.difficulty).toBeCloseTo(4.9, 10);
    session.dispose();
  });

  it('a distrusted quiz bucket damps the FSRS state update', async () => {
    const { session, teacher } = await makeTeacher();
    // Seed distrust in the quiz bucket: answer type definition, mid band
    // (fresh words start at difficulty 5), template 'quiz', provider 'rule'.
    const criteria: GradeCriteria = {
      answerType: 'definition',
      difficultyBand: 'mid',
      template: 'quiz',
      provider: 'rule'
    };
    for (let i = 0; i < 30; i += 1) teacher.graderReliability().recordAgreement(criteria, false);
    const weight = teacher.graderReliability().feedbackWeight(criteria);
    expect(weight).toBeLessThan(1);

    const answer = teacher.ask('bird', 'recognition');
    teacher.grade('bird', answer);
    const state = teacher.tryState('bird')!;
    const classic = 1 + Math.exp(-5 / 8);
    expect(state.stability).toBeLessThan(classic);
    expect(state.stability).toBeGreaterThan(1);
    expect(state.stability).toBeCloseTo(1 + weight * Math.exp(-5 / 8), 10);
    // Difficulty eases by the damped amount too.
    expect(state.difficulty).toBeCloseTo(5 - 0.1 * weight, 10);
    session.dispose();
  });

  it('the LLM grading path buckets, cross-checks, weights, and schedules re-grades', async () => {
    const { session, teacher } = await makeTeacher();
    const seedTraceId = teacher.tryState('robin')!.traceId!;

    // Seed distrust in the creative/operator bucket for the flaky provider.
    const criteria: GradeCriteria = {
      answerType: 'creative',
      difficultyBand: 'mid',
      template: 'operator',
      provider: 'flaky-provider'
    };
    for (let i = 0; i < 30; i += 1) teacher.graderReliability().recordAgreement(criteria, false);

    // A STRONG LLM grade of a FABRICATION: the grounding rule check says
    // weak — disagreement. The feedback is applied DAMPED, and a re-grade
    // is scheduled.
    const before = teacher.edgeStrengthOf('robin', 'is-a', 'bird');
    const graded = teacher.gradeCreativeWithReliability(
      { traceIds: [seedTraceId], edges: [{ subject: 'robin', predicate: 'is-a', object: 'bird' }] },
      0.9,
      'is robin a bird',
      'I flew to the moon on a dragon.',
      'flaky-provider'
    );
    expect(graded.disagreement).toBe(true);
    expect(graded.regradeId).not.toBeNull();
    expect(graded.weight).toBeLessThan(1);
    // Damped: the edge rose less than the full +0.2.
    expect(teacher.edgeStrengthOf('robin', 'is-a', 'bird')).toBeCloseTo(before + 0.2 * graded.weight, 10);
    expect(teacher.edgeStrengthOf('robin', 'is-a', 'bird')).toBeLessThan(before + 0.2);

    // The pending queue exposes the disagreement for the confirmation UI.
    const pending = teacher.graderReliability().pendingRegrades();
    expect(pending).toHaveLength(1);
    expect(pending[0].detail.ruleBand).toBe('weak');
    expect(pending[0].detail.llmBand).toBe('strong');

    // Resolving the re-grade against the LLM feeds the model (distrust grows).
    const reliabilityBefore = teacher.graderReliability().reliability(criteria);
    expect(teacher.graderReliability().resolveRegrade(graded.regradeId!, false)).toBe(true);
    expect(teacher.graderReliability().reliability(criteria)).toBeLessThan(reliabilityBefore);
    session.dispose();
  });

  it('an agreeing grade records evidence and applies full weight for a trusted provider', async () => {
    const { session, teacher } = await makeTeacher();
    const seedTraceId = teacher.tryState('robin')!.traceId!;
    // A grounded, composed answer (rule check: strong) graded strong.
    const graded = teacher.gradeCreativeWithReliability(
      { traceIds: [seedTraceId], edges: [{ subject: 'robin', predicate: 'is-a', object: 'bird' }] },
      0.9,
      'is robin a bird',
      'A robin is a bird with wings.',
      'trusted-provider'
    );
    expect(graded.disagreement).toBe(false);
    expect(graded.regradeId).toBeNull();
    expect(graded.weight).toBe(1);
    const evidence = teacher.reliabilityOf({
      answerType: 'creative',
      difficultyBand: 'mid',
      template: 'operator',
      provider: 'trusted-provider'
    });
    expect(evidence.samples).toBe(1);
    expect(evidence.agreements).toBe(1);
    session.dispose();
  });

  it('the reliability model survives export → import', async () => {
    const { session, teacher } = await makeTeacher();
    const criteria: GradeCriteria = {
      answerType: 'creative',
      difficultyBand: 'low',
      template: 'conversational',
      provider: 'persisted-provider'
    };
    for (let i = 0; i < 10; i += 1) teacher.graderReliability().recordAgreement(criteria, true);
    for (let i = 0; i < 6; i += 1) teacher.graderReliability().recordAgreement(criteria, false);
    const record = teacher.exportBootstrap('test');
    expect(record.learningState?.graderReliability).toBeDefined();
    session.dispose();

    const freshSession = new ObserverSession(OPTIONS, 100);
    await freshSession.initialize();
    const fresh = new TeacherAgent(freshSession, DECK);
    fresh.importBootstrap(record);
    const before = teacher.graderReliability().evidence(criteria);
    const after = fresh.graderReliability().evidence(criteria);
    expect(after.samples).toBe(before.samples);
    expect(after.agreements).toBe(before.agreements);
    expect(after.reliability).toBeCloseTo(before.reliability, 10);
    expect(after.weight).toBe(before.weight);
    freshSession.dispose();
  });
});
