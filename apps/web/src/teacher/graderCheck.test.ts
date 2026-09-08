/**
 * @jest-environment node
 *
 * THE GRADER CHECK (teacher/graderCheck.ts) and its gate. The live record
 * showed compose 0 wins / 2,619 losses over the observer's life — a judge
 * that may never have graded anything as good. Rule 1: before a grade can
 * move memory, the grader has to pass a null test it cannot pass by
 * accident.
 */
import { describe, it, expect } from '@jest/globals';
import { checkGrader, graderProbesFrom, pairwiseAuc, GRADER_MIN_PROBES } from './graderCheck';
import type { SemanticGrader } from './chaperone';
import type { ConversationPair } from './conversation';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { TrainingLoop } from '../server/trainingLoop';
import type { ChaperoneProvider } from './chaperone';
import type { DeckWord } from './deck';

const PAIRS: ConversationPair[] = [
  { cue: 'hello', response: 'Hello! It is nice to see you.' },
  { cue: 'how are you', response: 'I am well, thank you for asking.' },
  { cue: 'what is your name', response: 'My name is the observer.' },
  { cue: 'good night', response: 'Good night — sleep well.' },
  { cue: 'thank you', response: 'You are welcome.' },
  { cue: 'do you like music', response: 'I do like music, especially quiet songs.' }
];

/** A grader that judges: high when the answer is the cue's own response. */
function honestGrader(): SemanticGrader {
  const truth = new Map(PAIRS.map((pair) => [pair.cue, pair.response]));
  return {
    name: 'honest',
    async grade(utterance, answer) {
      return { score: truth.get(utterance) === answer ? 0.9 : 0.1, feedback: '' };
    }
  };
}

/** A grader that cannot judge: the same low score for everything — the
 *  shape the live record implies. */
function blindGrader(score = 0.1): SemanticGrader {
  return { name: 'blind', async grade() { return { score, feedback: '' }; } };
}

/** A grader that ranks correctly but never says "good": the reachability failure. */
function stingyGrader(): SemanticGrader {
  const truth = new Map(PAIRS.map((pair) => [pair.cue, pair.response]));
  return {
    name: 'stingy',
    async grade(utterance, answer) {
      return { score: truth.get(utterance) === answer ? 0.5 : 0.1, feedback: '' };
    }
  };
}

describe('graderProbesFrom', () => {
  it('pairs each cue with its own response and a different pair\'s response, deterministically', () => {
    const rng = (): number => 0.5;
    const probes = graderProbesFrom(PAIRS, 4, rng);
    expect(probes).toHaveLength(4);
    for (const probe of probes) {
      const own = PAIRS.find((pair) => pair.cue === probe.cue);
      expect(own?.response).toBe(probe.good);
      expect(probe.bad).not.toBe(probe.good);
      expect(PAIRS.some((pair) => pair.response === probe.bad)).toBe(true);
    }
    expect(graderProbesFrom(PAIRS, 4, rng)).toEqual(probes);
    expect(graderProbesFrom(PAIRS.slice(0, 1), 4)).toEqual([]);
  });
});

describe('checkGrader', () => {
  const probes = graderProbesFrom(PAIRS, 6, () => 0.3);

  it('pairwiseAuc: perfect separation 1, identical scores 0.5', () => {
    expect(pairwiseAuc([0.9, 0.8], [0.1, 0.2])).toBe(1);
    expect(pairwiseAuc([0.1, 0.1], [0.1, 0.1])).toBe(0.5);
    expect(pairwiseAuc([], [0.1])).toBeNull();
  });

  it('an honest grader is trusted', async () => {
    const check = await checkGrader(honestGrader(), probes);
    expect(check.trusted).toBe(true);
    expect(check.auc).toBe(1);
    expect(check.goodPass).toBe(1);
    expect(check.failures).toBe(0);
  });

  it('a blind grader (the same score for everything) is untrusted for lack of separation', async () => {
    const check = await checkGrader(blindGrader(), probes);
    expect(check.trusted).toBe(false);
    expect(check.auc).toBe(0.5);
    expect(check.reason).toContain('cannot separate');
  });

  it('a grader that ranks but never grades a correct answer as strong is untrusted for reachability', async () => {
    const check = await checkGrader(stingyGrader(), probes);
    expect(check.trusted).toBe(false);
    expect(check.auc).toBe(1);
    expect(check.goodPass).toBe(0);
    expect(check.reason).toContain('never grades a correct answer as strong');
  });

  it('too few usable probes, or a grader that keeps failing, is inconclusive — never a verdict by accident', async () => {
    const few = await checkGrader(honestGrader(), probes.slice(0, GRADER_MIN_PROBES - 1));
    expect(few.trusted).toBeNull();
    const failing: SemanticGrader = { name: 'down', async grade() { throw new Error('connection refused'); } };
    const down = await checkGrader(failing, probes);
    expect(down.trusted).toBeNull();
    expect(down.failures).toBe(probes.length * 2);
  });
});

const DECK: readonly DeckWord[] = [
  { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
  { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' },
  { word: 'water', definition: 'a clear liquid that falls as rain and is used for drinking', example: 'Water is wet.' },
  { word: 'rain', definition: 'water that falls from clouds', example: 'Rain is wet.' }
];
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  smfWidth: 128,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

describe('the gate: an untrusted grader\'s grade is recorded but moves nothing', () => {
  it('compose outcomes, memory strength and gaps are untouched; a trusted grader\'s identical grade moves them', async () => {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK, null, 500, 4, 7);
    for (const entry of DECK) teacher.teach(entry.word);
    const bank = teacher.getMemoryBank();
    const seed = bank.all().find((trace) => trace.content.includes('wings'));
    if (seed === undefined) throw new Error('no taught trace to seed from');
    const strengthBefore = bank.get(seed.id)?.strength ?? 0;
    const outcomesBefore = teacher.behaviorOutcomeCounts().compose;

    // The untrusted grader: a weak grade on a composition seeded by 'bird'.
    teacher.recordGraderCheck({
      grader: 'blind', at: Date.now(), probes: 6, good: [], bad: [], failures: 0,
      auc: 0.5, goodMean: 0.1, badMean: 0.1, goodPass: 0, reinforceGate: 0.7,
      trusted: false, reason: 'cannot separate'
    });
    expect(teacher.graderTrusted('blind')).toBe(false);
    const gated = teacher.gradeCreativeWithReliability({ traceIds: [seed.id], edges: [] }, 0.05, 'tell me about a bird', 'A bird sings the red water.', 'blind');
    expect(gated.untrusted).toBe(true);
    expect(gated.weight).toBe(0);
    expect(bank.get(seed.id)?.strength).toBe(strengthBefore);
    expect(teacher.behaviorOutcomeCounts().compose).toEqual(outcomesBefore);
    expect(teacher.listGaps()).not.toContain('tell me about a bird');
    // The ledger still names the producers — the grade is recorded, not applied.
    expect(teacher.answerGradeLedger().some((entry) => entry.utterance === 'tell me about a bird' && entry.verdict === 'neutral')).toBe(true);

    // The same grade from a trusted (unmeasured) grader applies as before.
    const applied = teacher.gradeCreativeWithReliability({ traceIds: [seed.id], edges: [] }, 0.05, 'tell me about a bird', 'A bird sings the red water.', 'unmeasured');
    expect(applied.untrusted).toBeUndefined();
    expect(teacher.behaviorOutcomeCounts().compose.losses).toBe(outcomesBefore.losses + 1);
    expect(teacher.listGaps()).toContain('tell me about a bird');

    // A later passing check restores trust.
    teacher.recordGraderCheck({
      grader: 'blind', at: Date.now(), probes: 6, good: [0.9], bad: [0.1], failures: 0,
      auc: 1, goodMean: 0.9, badMean: 0.1, goodPass: 1, reinforceGate: 0.7,
      trusted: true, reason: 'separates'
    });
    expect(teacher.graderTrusted('blind')).toBe(true);
    // The verdicts ride the record.
    const record = teacher.exportBootstrap('test');
    expect((record.learningState as { graderTrust?: Record<string, { trusted: boolean }> }).graderTrust?.blind.trusted).toBe(true);
    session.dispose();
  }, 60000);
});

describe('the training loop runs the check before its first cycle and skips grading under an untrusted grader', () => {
  it('records the verdict on the teacher and in the stats; the creative step asks for no grade', async () => {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK, null, 500, 4, 7);
    for (const entry of DECK) teacher.teach(entry.word);
    teacher.teachConversationDeck(PAIRS);
    let gradeCalls = 0;
    const provider: ChaperoneProvider = {
      name: 'blind-model',
      async complete() { throw new Error('stub'); },
      async completeRaw(prompt: string) {
        if (prompt.startsWith('Utterance:')) {
          gradeCalls += 1;
          return '{"score": 0.1, "feedback": "no"}';
        }
        throw new Error('stub');
      }
    };
    const events: string[] = [];
    const loop = new TrainingLoop(teacher, {
      settings: { endpoint: 'stub', apiKey: '', model: 'blind-model' },
      providerFactory: () => provider,
      cadenceMs: 0,
      wordsPerCycle: 0,
      reviewsPerCycle: 0,
      pursueGoals: false,
      graderCheckProbes: 5,
      onEvents: (next) => events.push(...next.map((event) => `${event.label}: ${event.text}`))
    });
    loop.start();
    const started = Date.now();
    while (loop.statistics().cycles < 3 && Date.now() - started < 20000) await new Promise((resolve) => setTimeout(resolve, 20));
    loop.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stats = loop.statistics();
    expect(stats.graderChecks).toBe(1);
    expect(stats.graderTrusted).toBe(false);
    expect(teacher.graderTrusted('blind-model')).toBe(false);
    expect(events.some((text) => text.startsWith('grader: grader "blind-model" UNTRUSTED'))).toBe(true);
    // The check itself made 2 calls per probe; no cycle asked for a creative grade afterwards.
    expect(gradeCalls).toBe(10);
    session.dispose();
  }, 60000);
});
