/**
 * P12 COMPETITION METRICS — the six measurements the competition experiment
 * is judged on.
 *
 * Every reading here is a DIAGNOSTIC of the field's code, not a gate: the
 * point of the experiment is to find out whether competition decorrelates a
 * globally-locked oscillator field, and a decorrelation that costs retrieval
 * is a negative result that must be reported, not tuned away.
 *
 * Determinism: every sample is drawn by a fixed stride or a seeded LCG, so
 * two runs of the same arm produce byte-identical numbers.
 */
import type { TraceLike } from '@sschepis/sentient-core';

/** Deterministic 32-bit LCG (Numerical Recipes constants). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function norm(vector: readonly number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** The corpus mean sketch over the given traces. */
export function corpusMeanSketch(traces: readonly TraceLike[]): number[] {
  if (traces.length === 0) return [];
  const width = traces[0].smf.toArray().length;
  const mean = new Array<number>(width).fill(0);
  for (const trace of traces) {
    const vector = trace.smf.toArray();
    for (let i = 0; i < width && i < vector.length; i += 1) mean[i] += vector[i];
  }
  for (let i = 0; i < width; i += 1) mean[i] /= traces.length;
  return mean;
}

/**
 * MEASUREMENT 1 — the sketch DC ratio: `‖corpus mean‖ / mean ‖sketch‖`.
 *
 * How much of a typical trace's sketch magnitude is the component every
 * trace shares. 1.0 means the corpus is a single point; 0 means the sketches
 * cancel completely. The measured control is 0.747: three quarters of every
 * sketch is the same vector, and only the residual quarter discriminates.
 */
export function sketchDcRatio(traces: readonly TraceLike[]): number {
  if (traces.length === 0) return 0;
  const mean = corpusMeanSketch(traces);
  let magnitudeSum = 0;
  for (const trace of traces) magnitudeSum += norm(trace.smf.toArray());
  const meanMagnitude = magnitudeSum / traces.length;
  return meanMagnitude <= 0 ? 0 : norm(mean) / meanMagnitude;
}

export interface PairwiseCosineReading {
  /** Mean cosine between unrelated traces, as recall actually scores them. */
  raw: number;
  /** The same pairs after subtracting the corpus mean from both sides. */
  centered: number;
  pairs: number;
}

/**
 * MEASUREMENT 2 — mean pairwise cosine between UNRELATED traces, raw and
 * mean-centered.
 *
 * "Unrelated" is every sampled pair of distinct traces: the corpus is a
 * vocabulary plus a conversation deck, so an arbitrary pair shares no
 * content. A high raw cosine with a low centered cosine is the signature of
 * a shared DC mode carrying the magnitude while the residual carries the
 * signal.
 */
export function unrelatedPairwiseCosine(
  traces: readonly TraceLike[],
  samplePairs = 4000,
  seed = 0x5eed
): PairwiseCosineReading {
  if (traces.length < 2) return { raw: 0, centered: 0, pairs: 0 };
  const mean = corpusMeanSketch(traces);
  const vectors = traces.map((trace) => trace.smf.toArray());
  const centered = vectors.map((vector) => vector.map((value, i) => value - (mean[i] ?? 0)));

  const random = lcg(seed);
  let rawSum = 0;
  let centeredSum = 0;
  let pairs = 0;
  for (let attempt = 0; attempt < samplePairs; attempt += 1) {
    const i = Math.floor(random() * traces.length);
    const j = Math.floor(random() * traces.length);
    if (i === j) continue;
    if (traces[i].content === traces[j].content) continue; // the same lesson twice is not an unrelated pair
    rawSum += cosine(vectors[i], vectors[j]);
    centeredSum += cosine(centered[i], centered[j]);
    pairs += 1;
  }
  if (pairs === 0) return { raw: 0, centered: 0, pairs: 0 };
  return { raw: rawSum / pairs, centered: centeredSum / pairs, pairs };
}

export interface PrimeSetReading {
  /** Jaccard over `trace.primes` — the array the trace literally stores. */
  structural: number;
  /** Jaccard over the primes whose amplitude clears the index threshold. */
  effective: number;
  /** Mean size of the effective (indexed) prime set. */
  meanEffectiveSize: number;
  /** Oscillator count, for scale. */
  basisSize: number;
  pairs: number;
}

/**
 * MEASUREMENT 3 — mean prime-set Jaccard between unrelated traces.
 *
 * TWO readings, because they answer different questions:
 *   - STRUCTURAL: `trace.primes` is written as the whole field basis by
 *     `SemanticObserver.storeMemory`, so it is a clique (1.0) by
 *     construction and no change to the physics can move it.
 *   - EFFECTIVE: the primes whose stored amplitude clears the bank's index
 *     threshold. This is the set that actually drives candidate filtering
 *     and the amplitude-overlap term, so it is the reading the competition
 *     experiment can move.
 */
export function unrelatedPrimeJaccard(
  traces: readonly TraceLike[],
  indexThreshold = 1e-4,
  samplePairs = 4000,
  seed = 0x5eed
): PrimeSetReading {
  if (traces.length < 2) {
    return { structural: 0, effective: 0, meanEffectiveSize: 0, basisSize: 0, pairs: 0 };
  }
  const structuralSets = traces.map((trace) => new Set(trace.primes));
  const effectiveSets = traces.map((trace) => {
    const set = new Set<number>();
    for (let i = 0; i < trace.primes.length; i += 1) {
      if ((trace.amplitudes[i] ?? 0) >= indexThreshold) set.add(trace.primes[i]);
    }
    return set;
  });

  const jaccard = (a: Set<number>, b: Set<number>): number => {
    if (a.size === 0 && b.size === 0) return 1;
    let shared = 0;
    for (const value of a) if (b.has(value)) shared += 1;
    const union = a.size + b.size - shared;
    return union === 0 ? 0 : shared / union;
  };

  const random = lcg(seed);
  let structuralSum = 0;
  let effectiveSum = 0;
  let pairs = 0;
  for (let attempt = 0; attempt < samplePairs; attempt += 1) {
    const i = Math.floor(random() * traces.length);
    const j = Math.floor(random() * traces.length);
    if (i === j) continue;
    if (traces[i].content === traces[j].content) continue;
    structuralSum += jaccard(structuralSets[i], structuralSets[j]);
    effectiveSum += jaccard(effectiveSets[i], effectiveSets[j]);
    pairs += 1;
  }

  let sizeSum = 0;
  for (const set of effectiveSets) sizeSum += set.size;

  return {
    structural: pairs === 0 ? 0 : structuralSum / pairs,
    effective: pairs === 0 ? 0 : effectiveSum / pairs,
    meanEffectiveSize: sizeSum / traces.length,
    basisSize: traces[0].primes.length,
    pairs
  };
}

/**
 * Split a trace population by the metadata tag the teacher stamps on it.
 *
 * §15's 0.297 figure was read off ONE population; a mixed corpus (word
 * lessons + tagged conversation/creative/gap traces) reads differently
 * because the tagged kinds are stored from different excitation. Reporting
 * the split is the difference between reproducing a number and asserting it.
 */
export function tracesByKind(traces: readonly TraceLike[]): Map<string, TraceLike[]> {
  const groups = new Map<string, TraceLike[]>();
  for (const trace of traces) {
    const kind = typeof trace.metadata?.kind === 'string' ? trace.metadata.kind : 'word';
    const bucket = groups.get(kind);
    if (bucket) bucket.push(trace);
    else groups.set(kind, [trace]);
  }
  return groups;
}

export interface RetrievalMarginReading {
  cues: number;
  /** Cues whose true trace appeared anywhere in the top-5. */
  presentInTopK: number;
  /** Cues whose true trace ranked FIRST. */
  rankedFirst: number;
  top1Rate: number;
  meanTrueScore: number;
  meanDistractorScore: number;
  meanMargin: number;
}

/** One cue and the id of the trace that is the correct answer for it. */
export interface MarginProbe {
  cue: string;
  traceId: string;
}

/**
 * MEASUREMENT 4 — the retrieval margin distribution over taught cues.
 *
 * This is the §15 measurement that showed ranking was never the bottleneck:
 * top-1 rank rate, the true trace's mean score, the best competitor's mean
 * score, and the margin between them. `excite` must reproduce the teacher's
 * own cue path (settle, observe, tick) so the reading describes the system
 * as it actually answers.
 */
export function retrievalMargin(
  probes: readonly MarginProbe[],
  excite: (cue: string) => void,
  recall: (cue: string, topK: number) => readonly { trace: { id: string }; score: number }[],
  topK = 5
): RetrievalMarginReading {
  let presentInTopK = 0;
  let rankedFirst = 0;
  let trueSum = 0;
  let distractorSum = 0;
  let marginSum = 0;
  let scored = 0;

  for (const probe of probes) {
    excite(probe.cue);
    const results = recall(probe.cue, topK);
    if (results.length === 0) continue;
    const trueIndex = results.findIndex((result) => result.trace.id === probe.traceId);
    if (trueIndex >= 0) presentInTopK += 1;
    if (trueIndex === 0) rankedFirst += 1;
    if (trueIndex < 0) continue;

    const trueScore = results[trueIndex].score;
    // The best COMPETITOR: the highest-scoring result that is not the true
    // trace. A cue with no competitor at all contributes no margin reading
    // rather than a fabricated one.
    let best: number | null = null;
    for (let i = 0; i < results.length; i += 1) {
      if (i === trueIndex) continue;
      if (best === null || results[i].score > best) best = results[i].score;
    }
    if (best === null) continue;
    trueSum += trueScore;
    distractorSum += best;
    marginSum += trueScore - best;
    scored += 1;
  }

  return {
    cues: probes.length,
    presentInTopK,
    rankedFirst,
    top1Rate: probes.length === 0 ? 0 : rankedFirst / probes.length,
    meanTrueScore: scored === 0 ? 0 : trueSum / scored,
    meanDistractorScore: scored === 0 ? 0 : distractorSum / scored,
    meanMargin: scored === 0 ? 0 : marginSum / scored
  };
}
