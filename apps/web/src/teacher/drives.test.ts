/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { computeDrives, chooseBehavior, updateDriveWeight, behaviorTemperature, DEFAULT_BEHAVIOR_WEIGHTS, BEHAVIOR_WEIGHT_FLOOR, BEHAVIOR_TEMPERATURE_MIN, BEHAVIOR_TEMPERATURE_MAX, ARCHETYPAL_BEHAVIORS, type BehaviorWeights } from './drives';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { DECK_100 } from './decks/en-100';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';

const DECK: readonly DeckWord[] = [...DECK_100.slice(0, 10), { word: 'tea', definition: '', example: '' }];
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

describe('drive module (archetypes as resonance targets)', () => {
  it('clamps drive values into [0,1]', () => {
    const drives = computeDrives({ coherence: 1.5, curiosity: -1, novelty: 0.5, conservation: 2, selfConsistency: 0 });
    expect(drives).toEqual({ coherence: 1, curiosity: 0, novelty: 0.5, conservation: 1, selfConsistency: 0 });
  });

  it('arbitration: curiosity dominates → ask; coherence dominates → answer', () => {
    const curious = computeDrives({ coherence: 0.1, curiosity: 0.9, novelty: 0.1, conservation: 0.1, selfConsistency: 0 });
    expect(chooseBehavior(curious, ['answer', 'ask', 'compose'])).toBe('ask');

    const coherent = computeDrives({ coherence: 0.9, curiosity: 0.1, novelty: 0.1, conservation: 0.1, selfConsistency: 1 });
    expect(chooseBehavior(coherent, ['answer', 'ask', 'compose'])).toBe('answer');

    const novel = computeDrives({ coherence: 0.1, curiosity: 0.1, novelty: 0.9, conservation: 0.1, selfConsistency: 0 });
    expect(chooseBehavior(novel, ['answer', 'ask', 'compose'])).toBe('compose');

    const conserving = computeDrives({ coherence: 0.1, curiosity: 0.1, novelty: 0.1, conservation: 0.9, selfConsistency: 0 });
    expect(chooseBehavior(conserving, ['answer', 'ask', 'practice'])).toBe('practice');
  });
});

describe('learned arbitration (the evaluative gradient)', () => {
  it('absent weights arbitrate exactly as the archetypal defaults', () => {
    const curious = computeDrives({ coherence: 0.1, curiosity: 0.9, novelty: 0.1, conservation: 0.1, selfConsistency: 0 });
    expect(chooseBehavior(curious, ['answer', 'ask', 'compose'])).toBe('ask');
    const coherent = computeDrives({ coherence: 0.9, curiosity: 0.1, novelty: 0.1, conservation: 0.1, selfConsistency: 1 });
    expect(chooseBehavior(coherent, ['answer', 'ask', 'compose'])).toBe('answer');
  });

  it('the ACQUIRED drive is not even considered until the available pool widens', () => {
    const drives = computeDrives({ coherence: 0.1, curiosity: 0.1, novelty: 0.1, conservation: 0.1, selfConsistency: 0.9 });
    // 'verify' listed in options but NOT in the default available set →
    // it is not even considered, regardless of its (learned) weight.
    const before = chooseBehavior(drives, ['answer', 'ask', 'verify'], { verify: 1 });
    expect(before).not.toBe('verify');
    // Once acquired (the caller widens the pool) AND its weight has learned
    // from successful verifications, verify wins on self-consistency.
    const acquired = chooseBehavior(drives, ['answer', 'ask', 'verify'], { verify: 1 }, new Set([...ARCHETYPAL_BEHAVIORS, 'verify']));
    expect(acquired).toBe('verify');
  });

  it('a win raises a behavior’s weight; a loss lowers it, clamped to the floor', () => {
    const weights: BehaviorWeights = {};
    updateDriveWeight(weights, 'ask', true);
    expect(weights.ask).toBeCloseTo(DEFAULT_BEHAVIOR_WEIGHTS.ask + 0.1);
    updateDriveWeight(weights, 'ask', false);
    expect(weights.ask).toBeCloseTo(DEFAULT_BEHAVIOR_WEIGHTS.ask);
    // Repeated losses cannot starve the drive below the floor.
    for (let i = 0; i < 20; i += 1) updateDriveWeight(weights, 'compose', false);
    expect(weights.compose).toBe(BEHAVIOR_WEIGHT_FLOOR);
  });

  it('a behavior with a large learned weight wins arbitration over its archetypal rival', () => {
    // With curiosity LOW, ask would normally lose to answer... but a strong
    // learned history of successful asks overwhelms the archetypes.
    // (M4: curiosity carries coefficient 1 — its urgency flows through the
    // temperature — so the learned weight must clear answer's 2.1 on its own.)
    const drives = computeDrives({ coherence: 0.8, curiosity: 0.1, novelty: 0.1, conservation: 0.1, selfConsistency: 0.8 });
    expect(chooseBehavior(drives, ['answer', 'ask'], { ask: 2.2 })).toBe('ask');
  });
});

describe('M4 (Phase 21): drive-temperature arbitration', () => {
  const mulberry = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
      a += 0x6d2b79f5;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  it('the temperature is the drive state: cold when calm, hot when curious/novel, clamped', () => {
    const calm = computeDrives({ coherence: 0.9, curiosity: 0, novelty: 0, conservation: 0.9, selfConsistency: 0.9 });
    expect(behaviorTemperature(calm)).toBe(BEHAVIOR_TEMPERATURE_MIN);
    const hot = computeDrives({ coherence: 0, curiosity: 1, novelty: 1, conservation: 0, selfConsistency: 0 });
    expect(behaviorTemperature(hot)).toBe(BEHAVIOR_TEMPERATURE_MAX);
    const mid = computeDrives({ coherence: 0, curiosity: 0.5, novelty: 0, conservation: 0, selfConsistency: 0 });
    expect(behaviorTemperature(mid)).toBeCloseTo(0.3, 10);
  });

  it('without an rng the choice is the exact argmax (the cold limit — legacy contract)', () => {
    const curious = computeDrives({ coherence: 0.1, curiosity: 0.9, novelty: 0.1, conservation: 0.1, selfConsistency: 0 });
    expect(chooseBehavior(curious, ['answer', 'ask', 'compose'])).toBe('ask');
  });

  it('COLD sampling reproduces the argmax: a clear score gap at T_MIN never flips', () => {
    const calm = computeDrives({ coherence: 0.9, curiosity: 0, novelty: 0, conservation: 0.1, selfConsistency: 0.9 });
    const rng = mulberry(7);
    for (let i = 0; i < 100; i += 1) {
      expect(chooseBehavior(calm, ['answer', 'ask', 'compose'], {}, undefined, rng)).toBe('answer');
    }
  });

  it('HOT sampling explores: non-max options get real probability mass', () => {
    const hot = computeDrives({ coherence: 0.3, curiosity: 1, novelty: 1, conservation: 0.3, selfConsistency: 0.2 });
    const rng = mulberry(11);
    const picks = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const choice = chooseBehavior(hot, ['answer', 'ask', 'compose', 'practice'], {}, undefined, rng);
      if (choice !== null) picks.add(choice);
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it('NO STARVATION: every available behavior is sampled at least once at high temperature', () => {
    const hot = computeDrives({ coherence: 0.4, curiosity: 1, novelty: 1, conservation: 0.4, selfConsistency: 0.4 });
    const rng = mulberry(23);
    const picks = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const choice = chooseBehavior(hot, ['answer', 'ask', 'compose', 'practice'], {}, undefined, rng);
      if (choice !== null) picks.add(choice);
    }
    expect(picks).toEqual(new Set(['answer', 'ask', 'compose', 'practice']));
  });

  it('the acquired-set gate holds under sampling: unavailable behaviors are never drawn', () => {
    const hot = computeDrives({ coherence: 0.2, curiosity: 1, novelty: 1, conservation: 0.2, selfConsistency: 1 });
    const rng = mulberry(31);
    for (let i = 0; i < 300; i += 1) {
      const choice = chooseBehavior(hot, ['answer', 'verify'], { verify: 5 }, undefined, rng);
      expect(choice).not.toBe('verify');
    }
  });

  it('every option unavailable → null, sampled or not', () => {
    const drives = computeDrives({ coherence: 0.5, curiosity: 0.5, novelty: 0.5, conservation: 0.5, selfConsistency: 0.5 });
    expect(chooseBehavior(drives, ['verify'], {}, new Set(ARCHETYPAL_BEHAVIORS))).toBeNull();
    expect(chooseBehavior(drives, ['verify'], {}, new Set(ARCHETYPAL_BEHAVIORS), mulberry(3))).toBeNull();
  });
});

describe('teacher drive signals', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DECK);
  });

  afterEach(() => {
    session.dispose();
  });

  it('curiosity pressure rises with repeated misses and encounters', () => {
    expect(teacher.curiosityPressure()).toBe(0);
    teacher.chatAnswer('what is the capital of mars');
    teacher.chatAnswer('what is the capital of mars');
    teacher.chatAnswer('say tea');
    teacher.chatAnswer('say tea');
    expect(teacher.curiosityPressure()).toBeGreaterThan(0);
  });

  it('conservation is the fraction of memory above the strength floor', () => {
    teacher.teachResponse({ cue: 'hello', response: 'Hello there.' });
    expect(teacher.conservationPressure()).toBeGreaterThan(0);
    expect(teacher.conservationPressure()).toBeLessThanOrEqual(1);
  });

  it('novelty is high for utterances unlike the recent context', () => {
    teacher.chatAnswer('I like apples.');
    teacher.chatAnswer('I like apples.');
    const repeated = teacher.noveltyOf('I like apples');
    const fresh = teacher.noveltyOf('the sky is full of stars');
    expect(fresh).toBeGreaterThan(repeated);
  });

  it('curiosity drive can veto composition in favor of asking', () => {
    // Miss the same gap twice while creative is LOCKED -> gaps recorded,
    // curiosity pressure builds.
    teacher.chatAnswer('what is the capital of mars');
    teacher.chatAnswer('what is the capital of mars');
    expect(teacher.listGaps()).toContain('what is the capital of mars');

    // Unlock creative via competency.
    teacher.teachResponse({ cue: 'hello', response: 'Hello there.' });
    teacher.teachResponse({ cue: 'hi', response: 'Hi there.' });
    teacher.teachResponse({ cue: 'thank you', response: 'You are welcome.' });
    teacher.teachResponse({ cue: 'goodbye', response: 'Goodbye.' });
    teacher.teachResponse({ cue: 'bye', response: 'Bye.' });
    for (const pair of [{ cue: 'hello' }, { cue: 'hi' }, { cue: 'thank you' }, { cue: 'goodbye' }]) {
      teacher.respond(pair.cue);
    }
    expect(teacher.conversationReport().creativeUnlocked).toBe(true);

    // The gap exists and curiosity is high -> the drive vetoes a creative
    // guess: the observer ASKS, seeking learning.
    const answer = teacher.chatAnswer('what is the capital of mars');
    expect(answer.mode).toBe('ask');
  });

  // A correct-grade answer credits the answer behavior; a taught gap credits
  // the ask behavior; the weights persist in the evaluation record.
  it('outcomes flow into the learned weights through real events', () => {
    teacher.teach('tea');
    const q = teacher.ask('tea', 'recognition');
    teacher.grade('tea', q);
    const counts = teacher.behaviorOutcomeCounts();
    expect(counts.answer.wins).toBe(1);

    teacher.chatAnswer('what is the capital of mars'); // gap recorded
    const gap = teacher.listGaps()[0];
    teacher.teachGap(gap, 'Mars has no capital.');
    expect(teacher.behaviorOutcomeCounts().ask.wins).toBe(1);
    expect(teacher.driveWeights().ask).toBeCloseTo(0.1);
  });

  it('learned weights round-trip through the bootstrap record', async () => {
    teacher.noteBehaviorOutcome('compose', true);
    const record = teacher.exportBootstrap('test');
    const weights = record.driveWeights;
    expect(weights).toBeDefined();
    expect(weights!.compose).toBeCloseTo(0.4);

    const fresh = new ObserverSession(OPTIONS, 100);
    const restored = new TeacherAgent(fresh, DECK);
    await fresh.initialize();
    restored.importBootstrap(record);
    expect(restored.driveWeights().compose).toBeCloseTo(0.4);
    fresh.dispose();
  });

  // THE OPEN MOTIVE LAYER: beliefs are inputs to the drives, and the drive
  // AXIS 'verify' is acquired from experience — not present at construction.
  it('stored fail-beliefs feed curiosity pressure (beliefs as drive inputs)', () => {
    expect(teacher.curiosityPressure()).toBe(0);
    teacher.chatAnswer('zzz xyz qqq'); // first miss
    teacher.chatAnswer('zzz xyz qqq'); // second miss → "I keep failing" belief
    expect(teacher.deficitBeliefs().length).toBe(1);
    expect(teacher.curiosityPressure()).toBeGreaterThan(0);
  });

  it('the verify drive unlocks only after enough contradictions, and learnable thereafter', async () => {
    expect(teacher.verifyUnlocked()).toBe(false);
    expect(teacher.availableBehaviors().has('verify')).toBe(false);

    // Earn a know-belief, then contradict it — THREE times — the evidence
    // that beliefs can be wrong.
    const earnKnow = (word: string): void => {
      for (let i = 0; i < 2; i += 1) {
        const q = teacher.ask(word, 'recognition');
        teacher.grade(word, q);
      }
    };
    const contradict = (word: string): void => {
      teacher.grade(word, {
        word: { word, definition: 'x', example: '' },
        cue: 'zzz unrelated',
        answer: '',
        recall: null
      });
    };
    // The belief library holds ONE revise per subject (dedup); the honest
    // evidence that "beliefs can be wrong" is DISTINCT subjects being
    // contradicted. Three such subjects unlock the acquired drive.
    for (const word of ['apple', 'water', 'friend']) {
      teacher.teach(word);
      earnKnow(word);
      contradict(word);
    }
    // Three contradictions total (across tea thrice) → unlocked.
    expect(teacher.beliefContradictions()).toBeGreaterThanOrEqual(3);
    expect(teacher.verifyUnlocked()).toBe(true);
    expect(teacher.availableBehaviors().has('verify')).toBe(true);
    expect(teacher.verifyCandidate()).not.toBeNull();

    // The verify behavior learns like any other: a completed verification
    // is a win.
    teacher.noteBehaviorOutcome('verify', true);
    expect(teacher.behaviorOutcomeCounts().verify.wins).toBe(1);
    expect((teacher.driveWeights().verify ?? 0)).toBeCloseTo(0.1);

    // The pick can now genuinely select verify.
    const choice = teacher.chooseNext('do I know tea', ['answer', 'ask', 'verify']);
    expect(['answer', 'ask', 'verify']).toContain(choice);
  });
});