/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from './TeacherAgent';
import { runAutonomousCycle, selfSufficiencyClass } from './autonomous';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { DECK_100 } from './decks/en-100';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';
import { Chaperone, type ChaperoneProvider, type SemanticGrader } from './chaperone';

const DECK: readonly DeckWord[] = [...DECK_100.slice(0, 10), { word: 'tea', definition: '', example: '' }];
// The PRODUCTION observer config (the browser app, the trainer, and its
// verify workers all share it): a scaled-down field never phase-locks exact
// cues past the 0.8 speaking gate, which the competency contract requires.
const OPTIONS = {
  ...OBSERVER_OPTIONS,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

/** A provider that always proposes the same pair and answers gaps. */
function fixedProvider(proposal: { cue: string; response: string }): ChaperoneProvider {
  return {
    name: 'fixed',
    async complete() {
      return '';
    },
    async completeRaw(prompt) {
      void prompt;
      return JSON.stringify({ pairs: [proposal] });
    }
  };
}

function fixedGrader(score: number, feedback: string): SemanticGrader {
  return {
    name: 'grader',
    async grade() {
      return { score, feedback };
    }
  };
}

describe('autonomous classroom (LLM ↔ observer loop)', () => {
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

  it('teaches a proposed exchange the observer did not know', async () => {
    const chaperone = new Chaperone(fixedProvider({ cue: 'do you want tea', response: 'Yes, I would like some tea.' }));
    const cycle = await runAutonomousCycle(teacher, chaperone, null);

    expect(cycle.phrasesTaught).toBe(1);
    expect(cycle.events.some((e) => e.role === 'llm' && e.text === 'do you want tea')).toBe(true);
    expect(cycle.events.some((e) => e.meta === 'pair')).toBe(true);

    // After the cycle, the observer answers it from memory.
    const answer = teacher.chatAnswer('do you want tea');
    expect(answer.mode).toBe('memorized');
    if (answer.mode === 'memorized') expect(answer.response).toBe('Yes, I would like some tea.');
  });

  it('teaches gaps first (learning from past conversations)', async () => {
    teacher.chatAnswer('what is the capital of mars'); // recorded as a gap
    const provider: ChaperoneProvider = {
      name: 'gap-fixed',
      async complete() {
        return '';
      },
      async completeRaw() {
        return JSON.stringify({ pairs: [{ cue: 'what is the capital of mars', response: 'Mars does not have a capital.' }] });
      }
    };
    const chaperone = new Chaperone(provider);
    const cycle = await runAutonomousCycle(teacher, chaperone, null);

    expect(teacher.listGaps()).toHaveLength(0);
    expect(cycle.events.some((e) => e.meta === 'gap')).toBe(true);
    const answer = teacher.chatAnswer('what is the capital of mars');
    expect(answer.mode).toBe('memorized');
    if (answer.mode === 'memorized') expect(answer.response).toBe('Mars does not have a capital.');
  });

  it('runs creative practice once unlocked: compose + grade + reinforce', async () => {
    // Unlock creative: teach 5 cues and produce 4 of them (competency 0.8).
    const five = [
      { cue: 'hello', response: 'Hello there.' },
      { cue: 'hi', response: 'Hi there.' },
      { cue: 'thank you', response: 'You are welcome.' },
      { cue: 'goodbye', response: 'Goodbye.' },
      { cue: 'bye', response: 'Bye.' }
    ];
    for (const pair of five) teacher.teachResponse(pair);
    for (const pair of five.slice(0, 4)) teacher.respond(pair.cue);
    expect(teacher.conversationReport().creativeUnlocked).toBe(true);

    const chaperone = new Chaperone(fixedProvider({ cue: 'do you want tea', response: 'Yes, please.' }));
    const cycle = await runAutonomousCycle(teacher, chaperone, fixedGrader(0.9, 'Great answer.'));

    expect(cycle.creativeScore).toBe(0.9);
    expect(cycle.events.some((e) => e.role === 'llm' && e.meta === 'creative')).toBe(true);
    expect(cycle.events.some((e) => e.role === 'observer' && e.meta === 'creative')).toBe(true);
    expect(cycle.events.some((e) => e.meta === 'grade')).toBe(true);
  });

  it('teaches several new words per cycle when new words remain', async () => {
    const chaperone = new Chaperone(fixedProvider({ cue: 'do you want tea', response: 'Yes, please.' }));
    const before = teacher.listWords().filter((w) => w.traceId !== null).length;
    const cycle = await runAutonomousCycle(teacher, chaperone, null);
    const after = teacher.listWords().filter((w) => w.traceId !== null).length;
    expect(after).toBe(before + 3);
    expect(cycle.wordsTaught).toBe(3);
    expect(cycle.events.some((e) => e.meta === 'word')).toBe(true);
  });

  it('runs spaced-repetition reviews of due words within the cycle', async () => {
    const chaperone = new Chaperone(fixedProvider({ cue: 'do you want tea', response: 'Yes, please.' }));
    // Teach a word so a review can be due (fresh traces review on the
    // next cycle under the SRS schedule).
    teacher.teach(DECK[0].word);
    const cycle = await runAutonomousCycle(teacher, chaperone, null);
    // The cycle always reports the reviews it attempted.
    expect(cycle.wordsReviewed).toBeGreaterThanOrEqual(0);
    expect(cycle.events.filter((e) => e.meta === 'review').length).toBe(cycle.wordsReviewed);
  });

  it('asks curiosity questions when it keeps missing the same gap', async () => {
    // Miss the same gap twice in conversation -> the observer wants to learn
    // about it.
    teacher.chatAnswer('what is the capital of mars');
    teacher.chatAnswer('what is the capital of mars');
    expect(teacher.curiosityQuestion()).toMatch(/mars/);
    // The trigger is consumed once asked.
    expect(teacher.curiosityQuestion()).toBeNull();
  });

  it('the classroom asks and answers a curiosity question', async () => {
    const provider: ChaperoneProvider = {
      name: 'fixed',
      async complete() {
        return '';
      },
      async completeRaw(prompt) {
        // The gap-answering prompt names the curiosity question; answer it.
        if (prompt.includes('The learner could not answer these utterances')) {
          return JSON.stringify({ pairs: [{ cue: 'can you teach me about tea', response: 'Tea is a warm drink.' }] });
        }
        return JSON.stringify({ pairs: [{ cue: 'do you want tea', response: 'Yes, please.' }] });
      }
    };
    const chaperone = new Chaperone(provider);

    // 'tea' heard three times without a definition -> encounter curiosity.
    for (let i = 0; i < 3; i += 1) {
      teacher.chatAnswer('say tea');
    }
    const cycle = await runAutonomousCycle(teacher, chaperone, null);
    expect(cycle.events.some((e) => e.role === 'observer' && e.meta === 'curious')).toBe(true);
    expect(cycle.events.some((e) => e.role === 'llm' && e.meta === 'teach')).toBe(true);
    // The curiosity trigger is consumed — not repeated next cycle.
    expect(teacher.curiosityQuestion()).toBeNull();
  });

  it('asks to be taught a word it keeps hearing without a definition', () => {
    // 'tea' is in DECK without a definition; 'say tea' is answerable (no
    // gap), so the encounter trigger fires on its own.
    for (let i = 0; i < 3; i += 1) {
      teacher.chatAnswer('say tea');
    }
    expect(teacher.curiosityQuestion()).toMatch(/tea/);
  });
});

describe('self-sufficiency (the crutch meter)', () => {
  it('classifies modes by LLM dependence', () => {
    expect(selfSufficiencyClass('memorized')).toBe('strict');
    expect(selfSufficiencyClass('operator')).toBe('strict');
    expect(selfSufficiencyClass('creative')).toBe('graded');
    expect(selfSufficiencyClass('ask')).toBe('dependent');
    expect(selfSufficiencyClass('hybrid')).toBe('dependent');
    expect(selfSufficiencyClass('decline')).toBe('dependent');
  });

  it('counts LLM calls and self-answered turns per classroom cycle', async () => {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK);
    const provider: ChaperoneProvider = {
      name: 'fixed',
      async complete() {
        return '';
      },
      async completeRaw() {
        return JSON.stringify({ pairs: [{ cue: 'do you want tea', response: 'Yes, please.' }] });
      }
    };
    const chaperone = new Chaperone(provider);
    const grader: SemanticGrader = { name: 'g', async grade() { return { score: 0.9, feedback: 'good' }; } };

    // First cycle: the observer learns the proposed pair (one LLM proposal
    // call) and the drill unlocks creative practice within the same cycle.
    const cycle1 = await runAutonomousCycle(teacher, chaperone, grader);
    expect(cycle1.llmCalls).toBeGreaterThanOrEqual(2);

    // Second cycle: creative practice continues — the observer composes its
    // own answers (selfAnswered) with the LLM only grading.
    const cycle2 = await runAutonomousCycle(teacher, chaperone, grader);
    expect(cycle2.selfAnswered).toBeGreaterThanOrEqual(1);
    expect(cycle2.llmCalls).toBeGreaterThanOrEqual(2);

    session.dispose();
  });
});