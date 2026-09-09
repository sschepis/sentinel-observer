/**
 * @jest-environment node
 *
 * TASKS.md #17 — the deviation meter reads what was SAID, not which routing
 * layer said it. Two levels: the pure reader over answer shapes, and the
 * teacher's session meter fed by real chat answers — including the case
 * that motivated the task: a read-about entity spoken at the ask layer.
 */
import { describe, it, expect } from '@jest/globals';
import { readSpeech, speechActOf, speakUngrounded, UNGROUNDED_LEAD } from './speechAct';
import type { ChatAnswer } from './agent/support';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import type { DeckWord } from './deck';

const NONE = { traceIds: [], edges: [] };

describe('speechActOf — the shape of an utterance', () => {
  it('questions: a trailing question mark or a teach-me request, wherever it sits', () => {
    expect(speechActOf('What is a robin?')).toBe('question');
    expect(speechActOf('I do not know what "quargle" means. Could you teach me?')).toBe('question');
    expect(speechActOf('Do you mean the bird or the fruit?')).toBe('question');
  });

  it('declines: the observer says it has not learned / cannot tell', () => {
    expect(speechActOf('I cannot tell — the premises do not settle it.')).toBe('decline');
    expect(speechActOf('I have not learned that yet.')).toBe('decline');
    expect(speechActOf('')).toBe('decline');
  });

  it('assertions: anything else spoken', () => {
    expect(speechActOf('A robin is a bird.')).toBe('assertion');
    expect(speechActOf('Zeus is a god. I think he lives on a mountain.')).toBe('assertion');
    expect(speechActOf('The word is robin.')).toBe('assertion');
  });
});

describe('readSpeech — speech act × backing', () => {
  it('a question at the ask layer is an abstention', () => {
    const answer: ChatAnswer = { mode: 'ask', response: 'I do not know that yet. Could you teach me?', provenance: NONE };
    expect(readSpeech(answer)).toEqual({ act: 'question', meter: 'abstained', unbacked: false });
  });

  it('a decline is an abstention whatever it says', () => {
    expect(readSpeech({ mode: 'decline', provenance: NONE }).meter).toBe('abstained');
  });

  it('memorized and operator answers are grounded by construction', () => {
    const memorized: ChatAnswer = { mode: 'memorized', response: 'Hello.', confidence: 0.9, cue: 'hello', provenance: NONE };
    expect(readSpeech(memorized)).toEqual({ act: 'assertion', meter: 'grounded', unbacked: false });
    const operator: ChatAnswer = {
      mode: 'operator',
      response: '14',
      operator: { kind: 'arithmetic', expression: '7 * 2', value: 14, answer: '14' } as never,
      provenance: { traceIds: [], edges: [], operatorId: 'arithmetic' }
    };
    expect(readSpeech(operator).meter).toBe('grounded');
  });

  it('an assertion at the ask layer that cites edges is GROUNDED, not abstained — the motivating case', () => {
    const spokenFrames: ChatAnswer = {
      mode: 'ask',
      response: 'Zeus is a god. I think he lives on a mountain.',
      provenance: { traceIds: [], edges: [{ subject: 'zeus', predicate: 'is-a', object: 'god' }] }
    };
    expect(readSpeech(spokenFrames)).toEqual({ act: 'assertion', meter: 'grounded', unbacked: false });
  });

  it('a composed sentence with cited edges is grounded; one that cites nothing is composed (unbacked)', () => {
    const base = { mode: 'creative' as const, confidence: 0.5, seedTraceIds: [], seedCount: 2, grounded: true, hedged: false, templateIds: [] };
    const cited: ChatAnswer = {
      ...base,
      response: 'A robin is a bird.',
      provenance: { traceIds: ['t1'], edges: [{ subject: 'robin', predicate: 'is-a', object: 'bird' }], templateIds: ['fixed:is-a'] }
    };
    expect(readSpeech(cited)).toEqual({ act: 'assertion', meter: 'grounded', unbacked: false });
    const markov: ChatAnswer = { ...base, grounded: false, response: 'A robin flies the sky red.', provenance: NONE };
    expect(readSpeech(markov)).toEqual({ act: 'assertion', meter: 'composed', unbacked: true });
    // Task 42: the fallback as chatAnswer now SPEAKS it — inside a decline that
    // names it as word-play. Nothing ungrounded is asserted.
    const labeled: ChatAnswer = { ...markov, response: speakUngrounded('A robin flies the sky red.') };
    expect(labeled.response.startsWith(UNGROUNDED_LEAD)).toBe(true);
    expect(labeled.response).toContain('“A robin flies the sky red.”');
    expect(readSpeech(labeled)).toEqual({ act: 'decline', meter: 'abstained', unbacked: false });
  });
});

const DECK: readonly DeckWord[] = [
  { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
  { word: 'god', definition: 'a being worshipped as having power over nature', example: 'A god is worshipped.' },
  { word: 'mountain', definition: 'a very high hill of rock', example: 'The mountain is tall.' },
  { word: 'thunder', definition: 'the loud sound that follows lightning in a storm', example: 'Thunder booms.' },
  { word: 'sky', definition: 'the space above the earth where clouds are', example: 'The sky is blue.' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  smfWidth: 128,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

describe('the session deviation meter on real chat answers', () => {
  it('counts a read-about entity spoken at the ask layer as a grounded assertion, and a real ask as abstained', async () => {
    const session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, DECK, null, 500, 4, 7);
    for (const entry of DECK) teacher.teach(entry.word);
    // Reading gives the observer edges about a name no deck defines.
    // The reader recognizes a name from a non-initial capital ("the god
    // Zeus"), then reads timeless facts about it.
    const read = teacher.readFrom('The Greeks worshipped the god Zeus. Zeus is a god. Zeus has thunder.', 'mythology');
    expect(read.accepted).toBeGreaterThan(0);

    const before = teacher.deviationMeter();
    expect(before.answers).toBe(0);

    const spoken = teacher.chatAnswer('what is zeus');
    // The ask layer speaks the frames — an assertion about the world.
    expect(spoken.mode).toBe('ask');
    const said = spoken.mode === 'ask' ? spoken.response : '';
    expect(said.toLowerCase()).toContain('zeus');
    expect(said.endsWith('?')).toBe(false);
    expect(spoken.provenance.edges.length).toBeGreaterThan(0);
    expect(spoken.speech?.act).toBe('assertion');
    expect(spoken.speech?.meter).toBe('grounded');

    const unknown = teacher.chatAnswer('what is a quargle');
    expect(unknown.mode).toBe('ask');
    expect(unknown.speech?.meter).toBe('abstained');

    const meter = teacher.deviationMeter();
    expect(meter.answers).toBe(2);
    expect(meter.grounded).toBe(1);
    expect(meter.abstained).toBe(1);
    expect(meter.composed).toBe(0);
    // The routing-layer count would have called both of these abstentions.
    expect(teacher.answerModeCounts().ask).toBe(2);
    session.dispose();
  }, 60000);
});
