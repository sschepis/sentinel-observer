/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { CONFUSABLE_PAIRS, confusableDeck } from './confusables';
import { NARRATIVE_CORPUS, storyText } from './narratives';
import { CREATIVE_GOLD, goldAgreement } from '../calibration/creativeGold';

describe('confusable-pair deck (P10 contrastive substrate)', () => {
  it('has a substantial pair count', () => {
    expect(CONFUSABLE_PAIRS.length).toBeGreaterThanOrEqual(35);
  });

  it('every pair is two distinct words with a nonempty contrast', () => {
    for (const pair of CONFUSABLE_PAIRS) {
      expect(pair.a.word).not.toBe(pair.b.word);
      expect(pair.contrast.trim().length).toBeGreaterThan(0);
    }
  });

  it('definitions differ within each pair — the contrast must be real', () => {
    for (const pair of CONFUSABLE_PAIRS) {
      expect(pair.a.definition).not.toBe(pair.b.definition);
      expect(pair.a.definition.trim().length).toBeGreaterThan(0);
      expect(pair.b.definition.trim().length).toBeGreaterThan(0);
    }
  });

  it('confusableDeck() has no duplicate words', () => {
    const deck = confusableDeck();
    const words = deck.map((entry) => entry.word);
    expect(new Set(words).size).toBe(words.length);
    expect(deck.length).toBeGreaterThan(0);
  });
});

describe('narrative corpus (temporal ordering / multi-trace binding)', () => {
  it('carries exactly 15 stories', () => {
    expect(NARRATIVE_CORPUS).toHaveLength(15);
  });

  it('every story has 3–5 sentences', () => {
    for (const story of NARRATIVE_CORPUS) {
      expect(story.sentences.length).toBeGreaterThanOrEqual(3);
      expect(story.sentences.length).toBeLessThanOrEqual(5);
    }
  });

  it('every answer appears verbatim in its story text (exact-match gradable)', () => {
    for (const story of NARRATIVE_CORPUS) {
      const text = storyText(story).toLowerCase();
      expect(story.questions.length).toBeGreaterThanOrEqual(3);
      expect(story.questions.length).toBeLessThanOrEqual(4);
      for (const { question, answer } of story.questions) {
        expect(question.trim().length).toBeGreaterThan(0);
        // The whole grading contract: the answer is a literal substring of
        // the story, so a recall grade never needs inference.
        expect(text).toContain(answer.toLowerCase());
      }
    }
  });
});

describe('creative gold set (critic calibration)', () => {
  it('has a substantial entry count', () => {
    expect(CREATIVE_GOLD.length).toBeGreaterThanOrEqual(35);
  });

  it('all scores are within [0, 1] and rationales are nonempty', () => {
    for (const entry of CREATIVE_GOLD) {
      expect(entry.score).toBeGreaterThanOrEqual(0);
      expect(entry.score).toBeLessThanOrEqual(1);
      expect(entry.rationale.trim().length).toBeGreaterThan(0);
      expect(entry.prompt.trim().length).toBeGreaterThan(0);
      expect(entry.response.trim().length).toBeGreaterThan(0);
    }
  });

  it('spans the grading bands: fabrications low, grounded/honest high', () => {
    const low = CREATIVE_GOLD.filter((entry) => entry.score <= 0.3);
    const high = CREATIVE_GOLD.filter((entry) => entry.score >= 0.7);
    expect(low.length).toBeGreaterThanOrEqual(5);
    expect(high.length).toBeGreaterThanOrEqual(10);
  });

  it('goldAgreement computes mae and within-band fraction for a stub grader', () => {
    const { mae, within } = goldAgreement((_, __) => 0.5);
    expect(mae).toBeGreaterThan(0);
    expect(mae).toBeLessThan(1);
    expect(Number.isFinite(within)).toBe(true);
    expect(within).toBeGreaterThanOrEqual(0);
    expect(within).toBeLessThanOrEqual(1);
  });
});
