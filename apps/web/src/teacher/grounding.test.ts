/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { groundingScore, groundingAttribution } from './grounding';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { ALL_CONVERSATION_PAIRS, CONVERSATION_CUE_TOKENS } from './conversation';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
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
  teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS);
  for (const pair of ALL_CONVERSATION_PAIRS) teacher.respond(pair.cue);
  return { session, teacher };
}

describe('composition grounding (the deviation meter’s per-composition verdict)', () => {
  it('echoes of the seeds are grounded; novel stitches deviate', () => {
    const seeds = ['I am well thank you for asking', 'My name is observer'];
    const echo = groundingScore('I am well thank you', seeds);
    expect(echo.isEcho).toBe(true);
    expect(echo.grounding).toBeGreaterThanOrEqual(0.8);
    const stitched = groundingScore('I am happy today in the garden', seeds);
    expect(stitched.isEcho).toBe(false);
    expect(stitched.grounding).toBeLessThan(0.8);
    expect(stitched.novelWords.length).toBeGreaterThan(0);
  });

  it('a fully ungrounded answer is flagged as fabrication risk', () => {
    const result = groundingScore('xylophone quartz nebula flux', ['I am well thank you']);
    expect(result.grounding).toBe(0);
    expect(result.isFabrication).toBe(true);
    expect(result.isEcho).toBe(false);
  });

  it('an empty answer is neutral, not an echo (no content to deviate or echo)', () => {
    const result = groundingScore('', ['I am well']);
    expect(result.grounding).toBe(1);
    // A phatic answer has NO content — it is not a grounded echo of its
    // seeds (counting it as an echo inflated the deviation meter's grounded
    // share with answers that simply had nothing to say).
    expect(result.isEcho).toBe(false);
    expect(result.isFabrication).toBe(false);
  });

  it('groundingAttribution splits the composed share into grounded vs deviated exposure', () => {
    expect(groundingAttribution(1)).toEqual({ grounded: 1, deviated: 0 });
    expect(groundingAttribution(0)).toEqual({ grounded: 0, deviated: 1 });
    expect(groundingAttribution(0.5).grounded).toBeCloseTo(0.5);
    expect(groundingAttribution(0.5).deviated).toBeCloseTo(0.5);
  });

  it('the meter aggregates grounding across live composed answers', async () => {
    const { session, teacher } = await setup();
    // A few composed answers accumulate the meter's attribution. The prompt
    // must mention KNOWN material — pure unknowns now route to ASK.
    for (let i = 0; i < 4; i += 1) teacher.chatAnswer('tell me about water and bird');
    const attribution = teacher.groundingAttribution();
    expect(attribution.answers).toBeGreaterThan(0);
    expect(attribution.groundedShare).toBeGreaterThanOrEqual(0);
    expect(attribution.deviatedShare).toBeGreaterThanOrEqual(0);
    expect(attribution.groundedShare + attribution.deviatedShare).toBeCloseTo(1, 1);
    session.dispose();
  });
});