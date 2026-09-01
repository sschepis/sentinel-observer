/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  ALL_PACK_PAIRS,
  CONVERSATION_PACK_CLARIFICATION,
  CONVERSATION_PACK_CORRECTION,
  CONVERSATION_PACK_EXPLAIN_BACK,
  CONVERSATION_PACK_STORYTELLING,
  CONVERSATION_PACK_FEELINGS,
  CONVERSATION_PACK_HYPOTHETICALS,
  CONVERSATION_PACK_SMALL_TALK,
  CONVERSATION_PACK_DAILY_LIFE,
  CONVERSATION_PACK_PREFERENCES,
  CONVERSATION_PACK_ENCOURAGEMENT,
  CONVERSATION_PACK_REFLECTION,
  MULTI_TURN_DIALOGUES,
  flattenDialogues
} from './conversationPacks';
import { ALL_CONVERSATION_PAIRS } from './conversation';

const ALL_PACKS: readonly (readonly { cue: string; response: string }[])[] = [
  CONVERSATION_PACK_CLARIFICATION,
  CONVERSATION_PACK_CORRECTION,
  CONVERSATION_PACK_EXPLAIN_BACK,
  CONVERSATION_PACK_STORYTELLING,
  CONVERSATION_PACK_FEELINGS,
  CONVERSATION_PACK_HYPOTHETICALS,
  CONVERSATION_PACK_SMALL_TALK,
  CONVERSATION_PACK_DAILY_LIFE,
  CONVERSATION_PACK_PREFERENCES,
  CONVERSATION_PACK_ENCOURAGEMENT,
  CONVERSATION_PACK_REFLECTION
];

describe('conversation packs (static conventions)', () => {
  it('every pack is substantial (>= 20 pairs) and non-empty', () => {
    for (const pack of ALL_PACKS) {
      expect(pack.length).toBeGreaterThanOrEqual(20);
    }
    expect(ALL_PACK_PAIRS.length).toBeGreaterThanOrEqual(400);
  });

  it('cues are lowercase, trimmed, punctuation-free conversation openers', () => {
    for (const pair of ALL_PACK_PAIRS) {
      expect(pair.cue).toBe(pair.cue.trim());
      expect(pair.cue).toBe(pair.cue.toLowerCase());
      expect(pair.cue.length).toBeGreaterThan(0);
      // Conversation cues are written without terminal punctuation — the
      // taught-cue identity match expects the raw phrasing.
      expect(pair.cue).not.toMatch(/[.!?]$/);
    }
  });

  it('responses are non-empty sentences with terminal punctuation', () => {
    for (const pair of ALL_PACK_PAIRS) {
      expect(pair.response.length).toBeGreaterThan(10);
      expect(pair.response).toMatch(/[.!?]$/);
    }
  });

  it('cues are unique across the whole conversation curriculum', () => {
    const cues = ALL_CONVERSATION_PAIRS.map((pair) => pair.cue);
    expect(new Set(cues).size).toBe(cues.length);
  });

  it('responses are varied: short answers, questions back, and longer turns all exist', () => {
    const lengths = ALL_PACK_PAIRS.map((pair) => pair.response.length);
    const short = lengths.filter((length) => length < 40).length;
    const questionsBack = ALL_PACK_PAIRS.filter((pair) => pair.response.endsWith('?')).length;
    expect(short).toBeGreaterThan(ALL_PACK_PAIRS.length / 6);
    expect(questionsBack).toBeGreaterThan(15);
    // Natural chat is mostly short turns — a tiny minority of long ones is
    // the honest distribution, and it still exists.
    expect(lengths.some((length) => length > 80)).toBe(true);
  });

  it('responses are honest to the observer identity (no invented senses or facts)', () => {
    for (const pair of ALL_PACK_PAIRS) {
      // The observer never claims senses, emotions it cannot have, or
      // knowledge outside its stored words.
      expect(pair.response).not.toMatch(/i (can see|can hear|feel|taste|smell) (?!no)/i);
      expect(pair.response).not.toMatch(/i know (everything|all)/i);
    }
  });

  it('multi-turn dialogues flatten to unique cues in order', () => {
    const flattened = flattenDialogues(MULTI_TURN_DIALOGUES);
    const cues = flattened.map((pair) => pair.cue);
    expect(new Set(cues).size).toBe(cues.length);
    expect(flattened.length).toBeGreaterThanOrEqual(50);
    // Every dialogue turn is also part of the pack pairs (taught together).
    for (const pair of flattened) {
      expect(ALL_PACK_PAIRS.some((p) => p.cue === pair.cue && p.response === pair.response)).toBe(true);
    }
  });

  it('paraphrase variants of base greetings exist in the curriculum', () => {
    const cues = new Set(ALL_CONVERSATION_PAIRS.map((pair) => pair.cue));
    for (const variant of ['how is it going', 'how are you doing', 'whats up', 'good morning', 'good night', 'see you later', 'take care']) {
      expect(cues.has(variant)).toBe(true);
    }
  });
});
