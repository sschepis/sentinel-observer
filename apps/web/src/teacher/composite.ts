/**
 * THE STUDENT'S COMPOSITE — the observer's own developing judgment.
 *
 * The teacher (LLM) grades every composition during scaffolding. This
 * module computes the STUDENT's parallel signal, deliberately built from
 * the observer's own machine, so the correlation bench can measure how well
 * the student's judgment predicts the teacher's — the data that decides the
 * calibrated handover (Phase 7c).
 *
 * The composite deliberately reuses ONLY the observer's own machinery:
 *   fluency     — how well the answer flows under its OWN learned transition
 *                 weights (its tiny language model)
 *   novelty     — how unlike any stored memory it is (echo distance)
 *   relevance   — how much it answers the question (utterance overlap)
 *   resonance   — how grounded it is in the converged moment (seed cosine)
 */
import { tokenizeText, cosineSimilarity } from './context';
import type { TransitionWeights } from './conversation';

export interface CompositeParts {
  fluency: number;
  novelty: number;
  relevance: number;
  resonance: number;
}

export interface CompositeScore {
  parts: CompositeParts;
  /** The combined signal — the student's grade, to compare with the
   *  teacher's. */
  composite: number;
}

/** Average learned transition weight over the answer's n-grams — fluency. */
export function fluencyOf(answer: string, weights: TransitionWeights): number {
  const words = tokenizeText(answer);
  if (words.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < words.length - 1; i += 1) {
    sum += weights.get(`${words[i]}|${words[i + 1]}`) ?? 0;
    count += 1;
  }
  for (let i = 0; i < words.length - 2; i += 1) {
    sum += weights.get(`${words[i]}|${words[i + 1]}|${words[i + 2]}`) ?? 0;
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

/** Echo distance: how much of the answer is novel relative to its seeds. */
export function noveltyOf(answer: string, seeds: readonly string[] | undefined): number {
  const words = new Set(tokenizeText(answer));
  if (words.size === 0) return 0;
  const seedTokens = new Set((seeds ?? []).flatMap((seed) => tokenizeText(seed)));
  let novel = 0;
  for (const word of words) if (!seedTokens.has(word)) novel += 1;
  return novel / words.size;
}

/** Relevance: overlap between the answer and the question. */
export function relevanceOf(answer: string, utterance: string): number {
  const answerTokens = new Set(tokenizeText(answer));
  const utteranceTokens = new Set(tokenizeText(utterance));
  if (utteranceTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of utteranceTokens) if (answerTokens.has(token)) overlap += 1;
  return overlap / utteranceTokens.size;
}

/**
 * Resonance: cosine between the answer's moment and its seed imprints.
 *
 * Convention: `seedAmplitudes[0]` is the ANSWER's own moment, the rest are
 * the producing seeds' moments — the answer must resonate with its SEEDS,
 * not with itself (cosine-to-self is trivially 1.0 and makes the parameter
 * meaningless).
 */
export function resonanceOf(answer: string, seedAmplitudes: readonly number[][]): number {
  const answerAmplitudes = seedAmplitudes[0];
  if (answerAmplitudes === undefined || seedAmplitudes.length < 2) return 0;
  // The strength of agreement between the answer and its own seeds.
  let best = 0;
  for (let i = 1; i < seedAmplitudes.length; i += 1) {
    best = Math.max(best, cosineSimilarity(answerAmplitudes, seedAmplitudes[i]));
  }
  return best;
}

/** The full composite — the student's grade (0..1-ish scale, normalized). */
export function compositeScore(
  answer: string,
  utterance: string,
  weights: TransitionWeights,
  seeds: readonly string[] | undefined,
  seedAmplitudes?: readonly number[][]
): CompositeScore {
  const fluency = Math.max(0, Math.min(1, fluencyOf(answer, weights) / 4)); // weights ~1-5 → normalize
  const novelty = noveltyOf(answer, seeds);
  const relevance = Math.max(0, Math.min(1, relevanceOf(answer, utterance)));
  const resonance = seedAmplitudes !== undefined && seedAmplitudes.length > 0 ? resonanceOf(answer, seedAmplitudes) : 0.5;

  const composite = Math.max(0, Math.min(1, fluency * novelty * relevance * resonance));
  return { parts: { fluency, novelty, relevance, resonance }, composite };
}

/** Spearman rank correlation between two paired series. */
export function spearman(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length < 2) return 0;
  const rank = (values: readonly number[]): number[] => {
    const indexed = values.map((value, i) => ({ value, i })).sort((x, y) => x.value - y.value);
    const ranks = new Array<number>(values.length);
    let start = 0;
    while (start < indexed.length) {
      let end = start + 1;
      while (end < indexed.length && indexed[end].value === indexed[start].value) end += 1;
      const averageRank = (start + 1 + end) / 2;
      for (let i = start; i < end; i += 1) ranks[indexed[i].i] = averageRank;
      start = end;
    }
    return ranks;
  };
  const rankA = rank(a);
  const rankB = rank(b);
  const n = a.length;
  const meanA = rankA.reduce((s, v) => s + v, 0) / n;
  const meanB = rankB.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    cov += (rankA[i] - meanA) * (rankB[i] - meanB);
    varA += (rankA[i] - meanA) ** 2;
    varB += (rankB[i] - meanB) ** 2;
  }
  if (varA === 0 || varB === 0) return 0;
  return cov / Math.sqrt(varA * varB);
}