/**
 * @jest-environment node
 *
 * THE TRAINING FEED'S COLOURS (docs/TASKS.md #80). The lines here are real
 * ones from the stream, and what is being tested is the JUDGMENT, not the
 * palette: a zero is never alarming, a wrong answer always is, and entropy
 * rising reads differently from entropy falling.
 */
import { describe, it, expect } from '@jest/globals';
import { colorizeLogLine, toneForPart } from './logColors';

/** The tone the line gives one of its ` · ` parts, by that part's own text. */
const toneOf = (line: string, part: string): string | null => {
  const segments = colorizeLogLine(line);
  const wanted = part.trim();
  // A part may be split into its number and its words; the number carries
  // the same tone, so either segment answers the question.
  for (const segment of segments) {
    const text = segment.text.trim();
    if (text.length === 0) continue;
    if (text === wanted || wanted.startsWith(text) || text.startsWith(wanted)) return segment.tone;
  }
  return null;
};

describe('training-feed colours', () => {
  it('a count of zero is never alarming — "0 wrong" is the good news', () => {
    expect(toneForPart('0 wrong')).toBe('text-slate-600');
    expect(toneForPart('0 denied')).toBe('text-slate-600');
    expect(toneForPart('0 abstained')).toBe('text-slate-600');
    // …while a real one is.
    expect(toneForPart('3 wrong')).toBe('text-rose-300');
    expect(toneForPart('12 denied')).toBe('text-rose-300');
  });

  it('gains read as gains and declines as hedges', () => {
    expect(toneForPart('43 new edges')).toBe('text-emerald-300');
    expect(toneForPart('27 defined')).toBe('text-emerald-300');
    expect(toneForPart('380 new words')).toBe('text-emerald-300');
    expect(toneForPart('53 right')).toBe('text-emerald-300');
    expect(toneForPart('247 abstained')).toBe('text-amber-300');
    expect(toneForPart('958 skipped')).toBe('text-amber-300');
    // A confirmed-false claim ingested is a gain: it is the first negative
    // evidence the honesty benches have that comes from outside the
    // observer's own graph.
    expect(toneForPart('8 negations')).toBe('text-emerald-300');
  });

  it('entropy keeps its colour, and a signed delta is about direction', () => {
    expect(toneForPart('9.424 bits over 2000 concepts')).toBe('text-fuchsia-300');
    // Falling entropy is the observer learning; rising is new vocabulary or
    // new disagreement — the two must not look the same.
    expect(toneForPart('-0.072 bits')).toBe('text-emerald-300');
    expect(toneForPart('+0.019 bits')).toBe('text-amber-300');
  });

  it('timings stay out of the way', () => {
    expect(toneForPart('612 ms')).toBe('text-slate-600');
    expect(toneForPart('45919 left')).toBe('text-sky-300');
  });

  it('colours a real curriculum line part by part, and keeps every character', () => {
    const line = 'conceptnet: 1000 rows · 43 new edges · 0 agreed · 12 denied · 8 negations · 380 new words · 958 skipped · 45919 left · 612 ms';
    const segments = colorizeLogLine(line);
    expect(segments.map((segment) => segment.text).join('')).toBe(line);
    expect(toneOf(line, '43 new edges')).toBe('text-emerald-300');
    expect(toneOf(line, '12 denied')).toBe('text-rose-300');
    expect(toneOf(line, '0 agreed')).toBe('text-slate-600');
    // The number carries the emphasis and its words carry the tone — for
    // every part that BEGINS with a number. "conceptnet: 1000 rows" begins
    // with the source name, so it keeps its tone without the bolding; the
    // gutter label already says which source this is.
    const numbers = segments.filter((segment) => segment.emphasis === true);
    expect(numbers.map((segment) => segment.text.trim())).toEqual(['43', '12', '8', '380', '958', '45919']);
  });

  it('colours the problems line, where right and wrong are the whole point', () => {
    const line = 'problems: 50 rows · pass 2 (corpus came round) · 14 right · 0 wrong · 36 abstained · accuracy when answering 100% · 8213 ms';
    const segments = colorizeLogLine(line);
    expect(segments.map((segment) => segment.text).join('')).toBe(line);
    expect(toneOf(line, '14 right')).toBe('text-emerald-300');
    expect(toneOf(line, '0 wrong')).toBe('text-slate-600');
    expect(toneOf(line, '36 abstained')).toBe('text-amber-300');
    expect(toneOf(line, 'pass 2')).toBe('text-sky-300');
  });

  it('leaves a line it does not recognise alone rather than guessing', () => {
    const line = 'learned about volcanoes: "what is lava" → "hot melted rock"';
    const segments = colorizeLogLine(line);
    expect(segments.map((segment) => segment.text).join('')).toBe(line);
    expect(segments.every((segment) => segment.tone === null || segment.tone.startsWith('text-'))).toBe(true);
  });

  it('an empty line makes no segments', () => {
    expect(colorizeLogLine('')).toEqual([]);
  });
});
