/**
 * @jest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { hybridAnswer } from './hybrid';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import { DECK_100 } from './decks/en-100';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import type { DeckWord } from './deck';
import { Chaperone, type ChaperoneProvider, type SemanticGrader } from './chaperone';

const DECK: readonly DeckWord[] = DECK_100.slice(0, 10);
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

/** Provider that drafts the SAME sentence for any prompt. */
function draftProvider(draft: string): ChaperoneProvider {
  return {
    name: 'draft',
    async complete() {
      return '';
    },
    async completeRaw() {
      return draft;
    }
  };
}

function grader(score: number, feedback = ''): SemanticGrader {
  return {
    name: 'grader',
    async grade() {
      return { score, feedback };
    }
  };
}

describe('hybrid voice (LLM drafts on the observer\'s memories)', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;

  beforeEach(async () => {
    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DECK);
    // Give the observer memories to be conditioned on.
    teacher.teachResponse({ cue: 'hello', response: 'Hello there.' });
    teacher.teachResponse({ cue: 'how are you', response: 'I am well, thank you.' });
  });

  afterEach(() => {
    session.dispose();
  });

  it('conditions the draft on the observer\'s own recalled memories', async () => {
    let seenPrompt = '';
    const provider: ChaperoneProvider = {
      name: 'capture',
      async complete() {
        return '';
      },
      async completeRaw(prompt) {
        seenPrompt = prompt;
        return 'The learner says: hello.';
      }
    };
    const chaperone = new Chaperone(provider);
    await hybridAnswer(teacher, chaperone, grader(0.8), 'say hello to me');
    expect(seenPrompt).toContain('Hello there.');
    expect(seenPrompt).toContain('say hello to me');
  });

  it('stores a strong draft as the observer\'s own memory', async () => {
    const chaperone = new Chaperone(draftProvider('I am doing well today.'));
    const result = await hybridAnswer(teacher, chaperone, grader(0.85, 'Good answer.'), 'how is your day');

    expect(result?.stored).toBe(true);
    expect(result?.score).toBe(0.85);
    // The draft is now a creative memory keyed by the utterance.
    const bank: any = session.observer.getMemoryBank();
    const creative = bank.all().filter((t: any) => t.metadata?.kind === 'creative');
    expect(creative.length).toBe(1);
    expect(creative[0].content).toBe('I am doing well today.');
    expect(creative[0].metadata.uttered).toBe('how is your day');
  });

  it('the stored hybrid answer is recalled from memory afterwards — no LLM needed', async () => {
    const chaperone = new Chaperone(draftProvider('I am doing well today.'));
    await hybridAnswer(teacher, chaperone, grader(0.85), 'how is your day');

    // A NEW conversation of the same utterance is answered from memory via
    // the creative-trace recall fallback in respond().
    const answer = teacher.chatAnswer('how is your day');
    expect(answer.mode).toBe('memorized');
    if (answer.mode === 'memorized') {
      expect(answer.response).toBe('I am doing well today.');
    }
  });

  it('never stores a mid-grade draft (shown but dropped)', async () => {
    const chaperone = new Chaperone(draftProvider('Maybe the weather is nice.'));
    const result = await hybridAnswer(teacher, chaperone, grader(0.5), 'do you like the weather');
    expect(result?.stored).toBe(false);
    const bank: any = session.observer.getMemoryBank();
    expect(bank.all().filter((t: any) => t.metadata?.kind === 'creative').length).toBe(0);
    // And it is not a gap either.
    expect(teacher.listGaps()).not.toContain('do you like the weather');
  });

  it('a weak draft becomes a gap (learning material)', async () => {
    const chaperone = new Chaperone(draftProvider('Blue is a color.'));
    const result = await hybridAnswer(teacher, chaperone, grader(0.2), 'what is the capital of mars');
    expect(result?.stored).toBe(false);
    expect(teacher.listGaps()).toContain('what is the capital of mars');
  });

  it('returns null when the provider cannot draft', async () => {
    const provider: ChaperoneProvider = {
      name: 'basic',
      async complete() {
        return '';
      }
    };
    const chaperone = new Chaperone(provider);
    const result = await hybridAnswer(teacher, chaperone, null, 'anything at all');
    expect(result).toBeNull();
  });
});