/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ALL_CONVERSATION_PAIRS } from './conversation';
import {
  ALL_PACK_PAIRS,
  CONVERSATION_PACK_CLARIFICATION,
  CONVERSATION_PACK_CORRECTION,
  CONVERSATION_PACK_EXPLAIN_BACK,
  CONVERSATION_PACK_STORYTELLING,
  CONVERSATION_PACK_FEELINGS,
  CONVERSATION_PACK_HYPOTHETICALS,
  MULTI_TURN_DIALOGUES,
  flattenDialogues
} from './conversationPacks';

/**
 * Static integrity checks for the themed conversation packs. No
 * ObserverSession is built here — these are fast shape/uniqueness gates:
 * a duplicated cue would silently overwrite an earlier taught pair, an
 * operator-shaped cue would be intercepted before recall ever ran, and an
 * empty cue or response teaches nothing.
 */

const PACKS: readonly (readonly { cue: string; response: string }[])[] = [
  CONVERSATION_PACK_CLARIFICATION,
  CONVERSATION_PACK_CORRECTION,
  CONVERSATION_PACK_EXPLAIN_BACK,
  CONVERSATION_PACK_STORYTELLING,
  CONVERSATION_PACK_FEELINGS,
  CONVERSATION_PACK_HYPOTHETICALS
];

describe('conversation packs', () => {
  it('has no duplicate cues across ALL_CONVERSATION_PAIRS', () => {
    const seen = new Map<string, number>();
    for (const pair of ALL_CONVERSATION_PAIRS) {
      const key = pair.cue.trim().toLowerCase();
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([cue]) => cue);
    expect(duplicates).toEqual([]);
  });

  it('every pack pair has a nonempty cue and response', () => {
    for (const pair of ALL_PACK_PAIRS) {
      expect(pair.cue.trim().length).toBeGreaterThan(0);
      expect(pair.response.trim().length).toBeGreaterThan(0);
    }
  });

  it('cues survive trimming (matched case-insensitively at recall time)', () => {
    for (const pair of ALL_PACK_PAIRS) {
      expect(pair.cue.trim()).not.toBe('');
      expect(pair.cue.trim().toLowerCase().length).toBeGreaterThan(0);
    }
  });

  it('every multi-turn dialogue has 3-6 turns', () => {
    expect(MULTI_TURN_DIALOGUES.length).toBe(12);
    for (const dialogue of MULTI_TURN_DIALOGUES) {
      expect(dialogue.turns.length).toBeGreaterThanOrEqual(3);
      expect(dialogue.turns.length).toBeLessThanOrEqual(6);
    }
  });

  it('flattenDialogues preserves every turn in order', () => {
    const flat = flattenDialogues(MULTI_TURN_DIALOGUES);
    const expected = MULTI_TURN_DIALOGUES.reduce((sum, dialogue) => sum + dialogue.turns.length, 0);
    expect(flat).toHaveLength(expected);
    expect(flat[0]).toEqual(MULTI_TURN_DIALOGUES[0].turns[0]);
  });

  it('the full curriculum reaches the expanded size', () => {
    expect(ALL_CONVERSATION_PAIRS.length).toBeGreaterThanOrEqual(315);
  });

  it('no pack cue matches an operator-intercepted form', () => {
    // Mirrors of the operator leads in operators.ts — a cue matching one of
    // these would be answered by an operator, never by conversation recall:
    // "what is X" (LEAD_DEFINITION), "does X have Y" (LEAD_HAS_PART),
    // "is X a Y" (LEAD_IS_A).
    const interceptedForms = [
      /^what is (?:(?:a|an|the) )?[a-z]+\??$/,
      /^does (?:(?:a|an|the) )?[a-z]+(?: [a-z]+)* have (?:(?:a|an|the) )?[a-z]+(?: [a-z]+)*\??$/,
      /^is (?:(?:a|an|the) )?[a-z]+(?: [a-z]+)* (?:a|an) [a-z]+(?: [a-z]+)*\??$/
    ];
    for (const pack of PACKS) {
      for (const pair of pack) {
        for (const form of interceptedForms) {
          expect(pair.cue).not.toMatch(form);
        }
      }
    }
    for (const dialogue of MULTI_TURN_DIALOGUES) {
      for (const pair of dialogue.turns) {
        for (const form of interceptedForms) {
          expect(pair.cue).not.toMatch(form);
        }
      }
    }
  });
});
