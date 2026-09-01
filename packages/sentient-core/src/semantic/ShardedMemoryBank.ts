/**
 * AUTO-SHARD MEMORY — entropy-driven sharding and reorganization.
 *
 * THE PRINCIPLE. Retrieval interference is measurable as an entropy: for
 * every trace-as-cue, the candidates its primes excite are the OTHER traces
 * sharing at least one prime. The mean log2(candidate count) over traces is
 * the spread the recall identity gate experiences — a cue that sees 2^k
 * siblings has k bits of candidate competition diluting its score. A deck
 * of paraphrase-heavy conversation cues ("good morning" / "good evening" /
 * "good night" share primes with each other AND with word traces) pushes
 * this entropy up and the identity gate refuses to speak. Reduced entropy
 * is therefore the ORGANIZATION principle: partition traces into shards so
 * that cross-shard prime sharing is minimized — each shard's candidate
 * spread drops, the candidate set a cue excites shrinks, and recall
 * sharpens without changing any recall semantics.
 *
 * THE MECHANISM.
 *   - every shard is an ordinary CompactMemoryBank (same recall terms, same
 *     honesty contract — nothing about retrieval changes, only the partition);
 *   - a trace's HOME shard is the one whose prime vocabulary it overlaps
 *     most (deterministic, re-computed identically on bootstrap restore);
 *   - recall routes the cue to the best-overlap shard (falling through to
 *     the runner-up when the top shard has no candidates; an empty-prime
 *     cue scans every shard — exactly the single-bank answer);
 *   - AUTO-SPLIT: when a shard's H(T|P) exceeds the split threshold and it
 *     holds enough traces, a deterministic 2-way medoid partition is tried
 *     and accepted ONLY when it measurably reduces entropy (no churn);
 *   - MERGE: a shard starved below the merge floor is folded into its
 *     nearest neighbor when the result stays within the entropy budget;
 *   - REORGANIZE: re-partitions ALL traces across the current shard count
 *     (and its neighbors k−1 / k+1), keeping the k with the lowest total
 *     entropy that respects the budget — the landscape can move as new
 *     material arrives and old material fades.
 *
 * All decisions are deterministic (medoid seeding, bounded iterations) and
 * every entropy reading is real — the honest measurement the reorganization
 * optimizes, never an invented number.
 */

import { CompactMemoryBank, type CompactTrace, type CompactMemoryBankOptions, type MemoryBank, type RecallQuery, type RecallResultLike, type SerializedTraceData, type TraceLike } from './CompactMemoryBank';
import type { SedenionMemoryField } from './SedenionMemoryField';
import { clampRange } from './numeric';

// ── The entropy metric ──────────────────────────────────────────────────────

/** The SMF cosine at or above which two traces count as retrieval
 *  candidates of each other (the neighborhood the recall SMF term ranks
 *  by). Sits above the sketch projection's similarity floor (~0.5 between
 *  distinct axes): a 0.5 threshold would make every pair a neighbor and
 *  the metric meaningless. Prime sets cannot drive this metric: every
 *  moment the observer stores carries the FULL active basis, so prime
 *  sharing is a clique — only the sketch orientation discriminates (the
 *  compact-bank contract: "sibling discrimination rides on the SMF term
 *  alone"). */
export const SMF_NEIGHBOR_COSINE = 0.7;

/** Trace shape the entropy machinery needs: primes always, sketch when the
 *  collection is SMF-bearing (the observer's traces). */
interface EntropyTrace {
  primes: readonly number[];
  smf?: { toArray(): number[] };
}

/** The unit sketch vectors of a collection (null when a trace has none) —
 *  extracted ONCE so no similarity loop allocates. */
function sketchVectors(traces: readonly EntropyTrace[]): (Float64Array | null)[] {
  return traces.map((trace) => {
    if (trace.smf === undefined) return null;
    const vector = Float64Array.from(trace.smf.toArray());
    let norm = 0;
    for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm);
    if (norm < 1e-12) return null;
    for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
    return vector;
  });
}

/** Cosine of two UNIT vectors. */
function unitCosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i];
  return dot;
}

/** Whether two prime lists share at least one prime. */
function sharesPrime(a: readonly number[], b: ReadonlySet<number>): boolean {
  for (const prime of a) if (b.has(prime)) return true;
  return false;
}

/**
 * THE NEIGHBOR GRAPH — for every trace, the OTHER traces that compete with
 * it in recall: SMF cosine >= SMF_NEIGHBOR_COSINE when sketches exist,
 * prime sharing otherwise. Built ONCE per measurement (O(n² × width)); every
 * entropy reading and every partition decision reads it, so no similarity is
 * ever recomputed inside a decision loop.
 */
export function neighborGraph(traces: readonly EntropyTrace[]): number[][] {
  const n = traces.length;
  const adjacency: number[][] = Array.from({ length: n }, () => []);
  if (n === 0) return adjacency;
  const vectors = sketchVectors(traces);
  const primeSets = vectors[0] === null ? traces.map((trace) => new Set(trace.primes)) : null;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = vectors[i];
      const b = vectors[j];
      const linked =
        a !== null && b !== null
          ? unitCosine(a, b) >= SMF_NEIGHBOR_COSINE
          : primeSets !== null && sharesPrime(traces[i].primes, primeSets[j]);
      if (linked) {
        adjacency[i].push(j);
        adjacency[j].push(i);
      }
    }
  }
  return adjacency;
}

/** Total interference bits of a collection: Σ log2(1 + neighbors). */
function interferenceBits(adjacency: readonly number[][]): number {
  let bits = 0;
  for (const neighbors of adjacency) bits += Math.log2(1 + neighbors.length);
  return bits;
}

/** Total interference bits of a PARTITION: only SAME-shard neighbors still
 *  compete, so a cut edge is a bit saved. */
function partitionBits(adjacency: readonly number[][], assignment: readonly number[]): number {
  let bits = 0;
  for (let i = 0; i < adjacency.length; i += 1) {
    let same = 0;
    for (const neighbor of adjacency[i]) if (assignment[neighbor] === assignment[i]) same += 1;
    bits += Math.log2(1 + same);
  }
  return bits;
}

/**
 * The random-split baseline: the interference bits a RANDOM partition with
 * the same shard sizes would produce (each trace keeps its neighbors in
 * proportion to its shard's share of the collection). A real partition beats
 * this exactly when it cut edges BETWEEN families; a homogeneous collection
 * can never beat it — the honest gate that stops the auto-sharder from
 * bisecting clones.
 */
function randomSplitBits(
  adjacency: readonly number[][],
  sizeOfTrace: readonly number[]
): number {
  const n = adjacency.length;
  if (n <= 1) return 0;
  let bits = 0;
  for (let i = 0; i < n; i += 1) {
    const shardSize = sizeOfTrace[i];
    if (shardSize === undefined || shardSize <= 1) continue;
    const share = (shardSize - 1) / (n - 1);
    bits += Math.log2(1 + adjacency[i].length * share);
  }
  return bits;
}

/**
 * The retrieval interference entropy of a trace collection, in bits per
 * trace — pure and deterministic. For every trace-as-cue, the candidate set
 * is the OTHER traces in its retrieval neighborhood; the reading is the mean
 * log2(1 + candidates) — the spread the recall identity gate experiences (a
 * cue seeing 2^k siblings has k bits of candidate competition diluting its
 * score). 0 = every trace is its own family.
 */
export function retrievalInterferenceEntropy(traces: readonly EntropyTrace[]): number {
  const n = traces.length;
  if (n === 0) return 0;
  return interferenceBits(neighborGraph(traces)) / n;
}

/** The total interference bits of a collection (the quantity a partition
 *  minimizes; the mean times the trace count). */
function interferenceSum(traces: readonly EntropyTrace[]): number {
  return interferenceBits(neighborGraph(traces));
}

/** Jaccard similarity of two prime sets, in [0, 1] (0 when both empty). */
export function jaccardPrimeSimilarity(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const prime of a) if (b.has(prime)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Unit-normalize a vector in place; a zero vector is returned as-is. */
function normalizeVector(vector: Float64Array): Float64Array {
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm < 1e-12) return vector;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

/** Cosine similarity of two equal-length vectors, in [-1, 1] (0 when either
 *  is zero). */
function cosineOf(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator < 1e-12 ? 0 : dot / denominator;
}

// ── Deterministic k-medoids partition ───────────────────────────────────────

export interface PartitionResult {
  /** Cluster index per trace (parallel to `traces`). */
  assignment: number[];
  /** The medoid trace index per cluster. */
  medoids: number[];
}

/**
 * Entropy-guided refinement — the reduced-entropy principle applied at
 * partition time. Every trace is considered for a move to another cluster in
 * deterministic order; the move is kept only when it strictly lowers the
 * total interference. The per-move delta touches only the mover and its
 * neighbors, and the per-cluster neighbor counts are maintained
 * incrementally, so a pass is O(edges × k) — no similarity and no cluster
 * scan inside the loop. Deterministic for identical inputs.
 */
function refineByEntropy(
  assignment: number[],
  k: number,
  adjacency: readonly number[][],
  maxPasses = 4
): void {
  const n = adjacency.length;
  if (n === 0 || k <= 1) return;
  // counts[i * k + c] = neighbors of trace i currently assigned to cluster c.
  const counts = new Int32Array(n * k);
  const sizes = new Int32Array(k);
  for (let i = 0; i < n; i += 1) {
    sizes[assignment[i]] += 1;
    for (const neighbor of adjacency[i]) counts[i * k + assignment[neighbor]] += 1;
  }
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let improved = false;
    for (let i = 0; i < n; i += 1) {
      const from = assignment[i];
      if (sizes[from] <= 1) continue; // never empty a cluster
      let bestTo = -1;
      let bestDelta = -1e-9; // strict improvement only
      for (let to = 0; to < k; to += 1) {
        if (to === from) continue;
        // The mover's own term, plus one bit-change per affected neighbor.
        let delta =
          Math.log2(1 + counts[i * k + to]) - Math.log2(1 + counts[i * k + from]);
        for (const neighbor of adjacency[i]) {
          const cluster = assignment[neighbor];
          if (cluster === from) {
            const c = counts[neighbor * k + from];
            delta += Math.log2(c) - Math.log2(1 + c);
          } else if (cluster === to) {
            const c = counts[neighbor * k + to];
            delta += Math.log2(2 + c) - Math.log2(1 + c);
          }
        }
        if (delta < bestDelta) {
          bestDelta = delta;
          bestTo = to;
        }
      }
      if (bestTo !== -1) {
        for (const neighbor of adjacency[i]) {
          counts[neighbor * k + from] -= 1;
          counts[neighbor * k + bestTo] += 1;
        }
        sizes[from] -= 1;
        sizes[bestTo] += 1;
        assignment[i] = bestTo;
        improved = true;
      }
    }
    if (!improved) break;
  }
}

/** The similarity used for medoid seeding/assignment: sketch cosine when
 *  available (the discriminator recall ranks siblings by), prime-set
 *  Jaccard otherwise. */
function similarityFn(
  traces: readonly EntropyTrace[],
  vectors: readonly (Float64Array | null)[]
): (a: number, b: number) => number {
  const primeSets = traces.map((trace) => new Set(trace.primes));
  return (a: number, b: number): number => {
    const va = vectors[a];
    const vb = vectors[b];
    if (va !== null && vb !== null) return Math.max(0, unitCosine(va, vb));
    return jaccardPrimeSimilarity(primeSets[a], primeSets[b]);
  };
}

/** k-medoids over the retrieval similarity, then entropy-guided refinement
 *  against a PREBUILT neighbor graph. */
function partitionWithGraph(
  traces: readonly EntropyTrace[],
  k: number,
  adjacency: readonly number[][],
  seedSample: number
): PartitionResult {
  const n = traces.length;
  if (n === 0) return { assignment: [], medoids: [] };
  const kClamped = clampRange(k, 1, n);
  if (kClamped === 1) return { assignment: new Array<number>(n).fill(0), medoids: [0] };
  const vectors = sketchVectors(traces);
  const similarity = similarityFn(traces, vectors);

  // Farthest-pair seeds over the first seedSample traces (deterministic).
  const sampleEnd = Math.min(n, seedSample);
  let seedA = 0;
  let seedB = 1;
  let worst = Infinity;
  for (let i = 0; i < sampleEnd; i += 1) {
    for (let j = i + 1; j < sampleEnd; j += 1) {
      const s = similarity(i, j);
      if (s < worst) {
        worst = s;
        seedA = i;
        seedB = j;
      }
    }
  }
  let medoids: number[] = [seedA, seedB];
  while (medoids.length < kClamped) {
    let bestTrace = -1;
    let bestScore = Infinity;
    for (let i = 0; i < n; i += 1) {
      if (medoids.includes(i)) continue;
      let closest = -Infinity;
      for (const medoid of medoids) {
        const s = similarity(i, medoid);
        if (s > closest) closest = s;
      }
      if (closest < bestScore) {
        bestScore = closest;
        bestTrace = i;
      }
    }
    if (bestTrace === -1) break;
    medoids.push(bestTrace);
  }
  medoids = medoids.slice(0, kClamped);

  let assignment = new Array<number>(n).fill(0);
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      let bestMedoid = 0;
      let bestSimilarity = -Infinity;
      for (let m = 0; m < medoids.length; m += 1) {
        const s = similarity(i, medoids[m]);
        if (s > bestSimilarity) {
          bestSimilarity = s;
          bestMedoid = m;
        }
      }
      next[i] = bestMedoid;
    }
    // Recompute medoids: the member closest to its cluster (highest total
    // similarity over a bounded sample — ties keep the earlier trace).
    const clusters: number[][] = Array.from({ length: kClamped }, () => []);
    for (let i = 0; i < n; i += 1) clusters[next[i]].push(i);
    const nextMedoids: number[] = [];
    for (let c = 0; c < kClamped; c += 1) {
      const cluster = clusters[c];
      if (cluster.length === 0) {
        nextMedoids.push(medoids[c]);
        continue;
      }
      const sample = cluster.length > 64 ? cluster.filter((_, index) => index % Math.ceil(cluster.length / 64) === 0) : cluster;
      let best = cluster[0];
      let bestScore = -Infinity;
      for (const member of sample) {
        let total = 0;
        for (const other of sample) total += similarity(member, other);
        if (total > bestScore) {
          bestScore = total;
          best = member;
        }
      }
      nextMedoids.push(best);
    }
    const converged = nextMedoids.every((medoid, index) => medoid === medoids[index]);
    medoids = nextMedoids;
    assignment = next;
    if (converged) break;
  }
  refineByEntropy(assignment, kClamped, adjacency);
  return { assignment, medoids };
}

/**
 * Deterministic partition of a trace collection into `k` shards: k-medoids
 * over retrieval similarity (sketch cosine, or prime Jaccard for plain
 * data) followed by entropy-guided refinement that moves traces only when
 * the move lowers total retrieval interference.
 */
export function partitionByPrimeJaccard(
  traces: readonly EntropyTrace[],
  k: number,
  seedSample = 64
): PartitionResult {
  return partitionWithGraph(traces, k, neighborGraph(traces), seedSample);
}

// ── The sharded bank ────────────────────────────────────────────────────────

export interface ShardedMemoryBankOptions {
  /** Total resident trace budget (default 50000 — same as the compact bank). */
  capacity?: number;
  /** Per-shard compact bank tuning (weights, thresholds). */
  bankOptions?: Omit<CompactMemoryBankOptions, 'capacity'>;
  /** Per-shard interference entropy (bits) above which a split is tried (default 5.0). */
  splitEntropyBits?: number;
  /** Minimum entropy reduction (bits) a split must deliver to be kept (default 0.3). */
  minSplitGainBits?: number;
  /** Minimum traces in a shard before a split is attempted (default 64). */
  splitMinTraces?: number;
  /** Traces below which a shard is merged into its nearest neighbor (default 24). */
  mergeFloor?: number;
  /** How far above the split threshold a shard's entropy may sit after
   *  reorganization (default 1.25 — the budget is soft, the split hard). */
  reorganizeBudget?: number;
}

const SHARD_DEFAULTS = {
  capacity: 50000,
  splitEntropyBits: 5.0,
  minSplitGainBits: 0.3,
  splitMinTraces: 64,
  mergeFloor: 24,
  reorganizeBudget: 1.25
};

/** The amortization interval: a split/merge attempt runs every N stores. */
const REORGANIZE_EVERY_STORES = 48;

export class ShardedMemoryBank implements MemoryBank {
  private readonly options: Required<Omit<ShardedMemoryBankOptions, 'bankOptions'>>;
  private readonly bankOptions: Omit<CompactMemoryBankOptions, 'capacity'>;
  private readonly shards: CompactMemoryBank[] = [];
  /** trace id -> owning shard index (the router's lookup; rebuilt on any
   *  partition change and on restore). */
  private readonly home = new Map<string, number>();
  private totalCapacity: number;
  private storeCount = 0;
  private recallCount = 0;
  private prunedCount = 0;

  constructor(options: ShardedMemoryBankOptions = {}) {
    this.options = {
      capacity: options.capacity ?? SHARD_DEFAULTS.capacity,
      splitEntropyBits: options.splitEntropyBits ?? SHARD_DEFAULTS.splitEntropyBits,
      minSplitGainBits: options.minSplitGainBits ?? SHARD_DEFAULTS.minSplitGainBits,
      splitMinTraces: options.splitMinTraces ?? SHARD_DEFAULTS.splitMinTraces,
      mergeFloor: options.mergeFloor ?? SHARD_DEFAULTS.mergeFloor,
      reorganizeBudget: options.reorganizeBudget ?? SHARD_DEFAULTS.reorganizeBudget
    };
    this.bankOptions = options.bankOptions ?? {};
    this.totalCapacity = this.options.capacity;
    this.shards.push(this.newShard());
  }

  private newShard(): CompactMemoryBank {
    const shard = new CompactMemoryBank({ capacity: this.perShardCapacity(), ...this.bankOptions });
    return shard;
  }

  private perShardCapacity(): number {
    return Math.max(1, Math.ceil(this.totalCapacity / Math.max(1, this.shards.length)));
  }

  private rebalanceCapacities(): void {
    const per = this.perShardCapacity();
    for (const shard of this.shards) shard.setCapacity(per);
  }

  // ── Vocabulary routing ────────────────────────────────────────────────────

  /** The union of primes a shard's traces carry (its vocabulary). */
  private shardVocabulary(shard: CompactMemoryBank): Set<number> {
    const vocabulary = new Set<number>();
    for (const trace of shard.all()) {
      for (const prime of trace.primes) vocabulary.add(prime);
    }
    return vocabulary;
  }

  /** Cached per-shard vocabularies (rebuilt on partition changes, updated
   *  incrementally on store — the router and the home decision never scan
   *  every trace). */
  private vocabCache: Set<number>[] | null = null;

  private invalidateVocabularies(): void {
    this.vocabCache = null;
    this.prototypeCache = null;
  }

  private vocabularies(): Set<number>[] {
    if (this.vocabCache === null) {
      this.vocabCache = this.shards.map((shard) => this.shardVocabulary(shard));
    }
    return this.vocabCache;
  }

  /** Cached per-shard SMF prototypes — the normalized mean sketch of each
   *  shard's traces. Routing rides the same discriminator recall ranks
   *  siblings by (the dense prime basis cannot route: every shard's
   *  vocabulary carries the shared category primes). */
  private prototypeCache: Float64Array[] | null = null;

  private prototypes(): Float64Array[] {
    if (this.prototypeCache === null) {
      this.prototypeCache = this.shards.map((shard) => {
        const mean = new Float64Array(this.smfWidth());
        const traces = shard.all();
        for (const trace of traces) {
          const vector = trace.smf.toArray();
          for (let i = 0; i < mean.length; i += 1) mean[i] += vector[i];
        }
        if (traces.length > 0) {
          for (let i = 0; i < mean.length; i += 1) mean[i] /= traces.length;
        }
        return normalizeVector(mean);
      });
    }
    return this.prototypeCache;
  }

  private smfWidth(): number {
    // The sketch width is read from the first stored trace (all traces of a
    // session share the observer's SMF width).
    for (const shard of this.shards) {
      const first = shard.all()[0];
      if (first !== undefined) return first.smf.toArray().length;
    }
    return 16;
  }

  private updatePrototype(shardIndex: number, vector: Float64Array): void {
    if (this.prototypeCache === null) return;
    const prototype = this.prototypeCache[shardIndex];
    const count = this.shards[shardIndex].size;
    for (let i = 0; i < prototype.length; i += 1) {
      prototype[i] = (prototype[i] * (count - 1) + vector[i]) / count;
    }
    const normalized = normalizeVector(prototype);
    for (let i = 0; i < prototype.length; i += 1) prototype[i] = normalized[i];
  }

  /** The shard whose recall best answers a cue: the SMF prototype cosine
   *  when the query carries a sketch, prime-vocabulary overlap otherwise
   *  (ties break toward the higher-trace-count shard — its candidates
   *  dominate the single-bank answer). */
  private routeFor(query: RecallQuery): number {
    const smf = query.smf;
    if (smf !== undefined) {
      const cue = smf.toArray();
      const prototypes = this.prototypes();
      let best = 0;
      let bestCosine = -Infinity;
      for (let i = 0; i < prototypes.length; i += 1) {
        const cosine = cosineOf(cue, Array.from(prototypes[i]));
        if (cosine > bestCosine) {
          bestCosine = cosine;
          best = i;
        }
      }
      return best;
    }
    const primes = query.primes ?? [];
    if (primes.length === 0) return -1; // empty cue: scan every shard
    const primeSet = new Set(primes);
    const vocabularies = this.vocabularies();
    let best = 0;
    let bestOverlap = -1;
    for (let i = 0; i < vocabularies.length; i += 1) {
      let overlap = 0;
      for (const prime of primeSet) if (vocabularies[i].has(prime)) overlap += 1;
      if (
        overlap > bestOverlap ||
        (overlap === bestOverlap && this.shards[i].size > this.shards[best].size)
      ) {
        bestOverlap = overlap;
        best = i;
      }
    }
    return best;
  }

  /** The best home shard for a trace's prime list: the shard whose
   *  vocabulary it overlaps most (ties → the smaller shard, then the lower
   *  index — deterministic). An empty prime list homes to the smallest
   *  shard. */
  private homeFor(primes: readonly number[], vocabularies: Set<number>[]): number {    const primeSet = new Set(primes);
    let best = 0;
    let bestOverlap = -1;
    for (let i = 0; i < vocabularies.length; i += 1) {
      const vocabulary = vocabularies[i];
      let overlap = 0;
      for (const prime of primeSet) if (vocabulary.has(prime)) overlap += 1;
      if (overlap === 0 && primeSet.size === 0) {
        // Empty-prime traces: prefer the smallest shard for balance.
        if (this.shards[i].size < this.shards[best].size || (this.shards[i].size === this.shards[best].size && i < best)) {
          best = i;
        }
        continue;
      }
      if (overlap > bestOverlap || (overlap === bestOverlap && this.shards[i].size < this.shards[best].size)) {
        bestOverlap = overlap;
        best = i;
      }
    }
    return best;
  }

  /** The runner-up shard for a cue (prototype cosine when available): the
   *  second-most-likely home, used when the top route's recall is empty or
   *  nearly tied. Returns -1 when there is only one shard. */
  private runnerUpFor(query: RecallQuery, best: number): number {
    if (this.shards.length <= 1) return -1;
    const smf = query.smf;
    if (smf !== undefined) {
      const cue = smf.toArray();
      const prototypes = this.prototypes();
      let runner = -1;
      let runnerCosine = -Infinity;
      for (let i = 0; i < prototypes.length; i += 1) {
        if (i === best) continue;
        const cosine = cosineOf(cue, Array.from(prototypes[i]));
        if (cosine > runnerCosine) {
          runnerCosine = cosine;
          runner = i;
        }
      }
      return runner;
    }
    const primes = query.primes ?? [];
    if (primes.length === 0) return -1;
    const primeSet = new Set(primes);
    const vocabularies = this.vocabularies();
    let runner = -1;
    let runnerOverlap = -1;
    for (let i = 0; i < vocabularies.length; i += 1) {
      if (i === best) continue;
      let overlap = 0;
      for (const prime of primeSet) if (vocabularies[i].has(prime)) overlap += 1;
      if (overlap > runnerOverlap) {
        runnerOverlap = overlap;
        runner = i;
      }
    }
    return runner;
  }

  // ── Entropy readings ──────────────────────────────────────────────────────

  /** The interference entropy of one shard (bits). */
  shardEntropy(shardIndex: number): number {
    return retrievalInterferenceEntropy(this.shards[shardIndex].all());
  }

  /** The interference entropy of every shard, in shard order (bits). */
  shardEntropies(): number[] {
    return this.shards.map((shard) => retrievalInterferenceEntropy(shard.all()));
  }

  /** Total interference entropy across shards (bits, summed over traces) —
   *  the quantity reorganization minimizes, comparable to the single-bank
   *  interference sum of the same traces. */
  retrievalEntropy(): number {
    return this.shards.reduce((sum, shard) => sum + interferenceSum(shard.all()), 0);
  }

  /** The per-shard entropy budget for reorganization (bits). */
  private entropyBudget(): number {
    return this.options.splitEntropyBits * this.options.reorganizeBudget;
  }

  // ── Partition maintenance ─────────────────────────────────────────────────

  /**
   * Try a 2-way split of the highest-entropy shard. The candidate partition
   * is applied ONLY when it reduces total interference entropy by at least
   * minSplitGainBits — the reduced-entropy principle: no churn without a
   * measurable win.
   */
  private maybeSplit(): boolean {
    if (this.shards.length >= 8) return false;
    // ONE graph build per attempt: the candidate shard is the largest one
    // over the trace floor (its entropy reading comes from the same graph).
    let worst = -1;
    let worstTraces = 0;
    for (let i = 0; i < this.shards.length; i += 1) {
      if (this.shards[i].size > worstTraces) {
        worstTraces = this.shards[i].size;
        worst = i;
      }
    }
    if (worst === -1) return false;
    const traces = this.shards[worst].all();
    if (traces.length < this.options.splitMinTraces) return false;

    const adjacency = neighborGraph(traces);
    const before = interferenceBits(adjacency);
    if (before / traces.length < this.options.splitEntropyBits) return false;

    const partition = partitionWithGraph(traces, 2, adjacency, 64);
    const left: TraceLike[] = [];
    const right: TraceLike[] = [];
    for (let i = 0; i < traces.length; i += 1) {
      (partition.assignment[i] === 0 ? left : right).push(traces[i]);
    }
    if (left.length === 0 || right.length === 0) return false;
    const after = partitionBits(adjacency, partition.assignment);
    // The reduced-entropy gate, honestly: the partition must beat BOTH the
    // current collection AND a random split of the same sizes (a
    // homogeneous shard always halves its candidates — that "reduction" is
    // chance, not organization).
    const sizeOfTrace = partition.assignment.map((cluster) => (cluster === 0 ? left.length : right.length));
    const randomBaseline = randomSplitBits(adjacency, sizeOfTrace);
    if (after > before - this.options.minSplitGainBits) return false;
    if (after > randomBaseline - this.options.minSplitGainBits) return false;

    this.applyPartition([left, right]);
    return true;
  }

  /**
   * Fold shards below the merge floor into their nearest neighbor (best
   * vocabulary overlap) when the merged shard stays within the entropy
   * budget. Small DISTINCT shards are honest — they merge only when the
   * result does not reintroduce the interference the shards were avoiding.
   */
  private maybeMerge(): boolean {
    let merged = false;
    for (let i = 0; i < this.shards.length; i += 1) {
      if (this.shards.length <= 1) break;
      const traces = this.shards[i].all();
      if (traces.length >= this.options.mergeFloor) continue;
      // Nearest neighbor by vocabulary overlap.
      const vocabularies = this.vocabularies();
      const mine = new Set<number>();
      for (const trace of traces) for (const prime of trace.primes) mine.add(prime);
      let neighbor = -1;
      let bestOverlap = -1;
      for (let j = 0; j < this.shards.length; j += 1) {
        if (j === i) continue;
        let overlap = 0;
        for (const prime of mine) if (vocabularies[j].has(prime)) overlap += 1;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          neighbor = j;
        }
      }
      if (neighbor === -1) continue;
      const mergedTraces = [...this.shards[neighbor].all(), ...traces];
      if (retrievalInterferenceEntropy(mergedTraces) > this.entropyBudget()) continue;
      // Rebuild EVERY shard: the starved shard folds into its neighbor, all
      // others move untouched (partition moves, not deletions).
      const groups: TraceLike[][] = this.shards.map((shard) => [...shard.all()]);
      groups[neighbor] = [...groups[neighbor], ...groups[i]];
      groups.splice(i, 1);
      this.applyPartition(groups);
      merged = true;
      break;
    }
    return merged;
  }

  /** Apply a partition: rebuild the shards by MOVING the grouped traces
   *  through their full serialized form (content, sketch, phases, strength
   *  and utility all survive — nothing about a trace changes, only its
   *  home). */
  private applyPartition(groups: readonly (readonly TraceLike[])[]): void {
    const next: CompactMemoryBank[] = groups.map(() => this.newShard());
    const home = new Map<string, number>();
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      for (const trace of groups[groupIndex]) {
        const data = this.serializeTrace(trace.id);
        if (data === null) continue;
        const restored = next[groupIndex].restoreTrace(data);
        if (restored !== null) home.set(restored.id, groupIndex);
      }
    }
    this.shards.length = 0;
    this.shards.push(...next);
    this.home.clear();
    for (const [id, shardIndex] of home) this.home.set(id, shardIndex);
    this.invalidateVocabularies();
    this.rebalanceCapacities();
  }

  /** Run one maintenance pass (split first, merge when the split did not
   *  fire) — public so callers can trigger it on demand (e.g., after a
   *  bootstrap restore) and tests can drive it deterministically. */
  maintain(): { split: boolean; merged: boolean } {
    const split = this.maybeSplit();
    const merged = split ? false : this.maybeMerge();
    return { split, merged };
  }

  /**
   * REORGANIZE — re-partition every trace along the entropy gradient.
   * Evaluates the current shard count k and its neighbors (k−1, k+1) with
   * deterministic medoid partitions, and applies the partition with the
   * LOWEST total interference entropy that keeps every shard within the
   * budget. When nothing beats the current partition, nothing changes —
   * reorganization is only ever a measurable reduction.
   */
  reorganize(): { shards: number; entropyBefore: number; entropyAfter: number } {
    const all = this.all();
    if (all.length === 0) {
      return { shards: this.shards.length, entropyBefore: 0, entropyAfter: 0 };
    }
    // ONE graph build for the whole decision: every candidate k is scored
    // against the same neighbor structure.
    const adjacency = neighborGraph(all);
    const entropyBefore = interferenceBits(adjacency);
    const k = this.shards.length;

    let best: { assignment: number[]; entropy: number } | null = null;
    for (const candidate of [Math.max(1, k - 1), k, Math.min(8, k + 1)]) {
      const partition = partitionWithGraph(all, candidate, adjacency, 64);
      const entropy = partitionBits(adjacency, partition.assignment);
      if (best === null || entropy < best.entropy) {
        best = { assignment: partition.assignment, entropy };
      }
    }
    if (best === null) return { shards: this.shards.length, entropyBefore, entropyAfter: entropyBefore };
    const assignment = best.assignment;

    const groupCount = Math.max(...assignment) + 1;
    const groups: TraceLike[][] = Array.from({ length: groupCount }, () => []);
    const groupBits = new Array<number>(groupCount).fill(0);
    for (let i = 0; i < all.length; i += 1) {
      groups[assignment[i]].push(all[i]);
      let same = 0;
      for (const neighbor of adjacency[i]) if (assignment[neighbor] === assignment[i]) same += 1;
      groupBits[assignment[i]] += Math.log2(1 + same);
    }
    const sizeOfTrace = assignment.map((cluster) => groups[cluster].length);
    const entropyAfter = best.entropy;
    const randomBaseline = randomSplitBits(adjacency, sizeOfTrace);
    // Within-budget check per shard (mean bits per trace); a shard over the
    // budget is the signal that k+1 was the honest answer.
    const withinBudget = groups.every(
      (group, index) => group.length === 0 || groupBits[index] / group.length <= this.entropyBudget()
    );
    // The honest gate: the reorganization must beat the current partition
    // AND a random split of the same sizes (clones never reorganize).
    if (!withinBudget || entropyAfter >= entropyBefore || entropyAfter > randomBaseline - this.options.minSplitGainBits) {
      return { shards: this.shards.length, entropyBefore, entropyAfter: entropyBefore };
    }
    this.applyPartition(groups);
    return { shards: this.shards.length, entropyBefore, entropyAfter };
  }

  // ── MemoryBank ────────────────────────────────────────────────────────────

  get size(): number {
    return this.shards.reduce((sum, shard) => sum + shard.size, 0);
  }

  get capacity(): number {
    return this.totalCapacity;
  }

  store(
    content: string,
    smf: SedenionMemoryField,
    primes: readonly number[],
    options?: { amplitudes?: readonly number[]; phases?: readonly number[]; importance?: number; metadata?: Record<string, unknown> }
  ): TraceLike {
    this.storeCount += 1;
    const vocabularies = this.vocabularies();
    const homeIndex = this.homeFor(primes, vocabularies);
    const trace = this.shards[homeIndex].store(content, smf, primes, options);
    this.home.set(trace.id, homeIndex);
    // The new trace extends its shard's vocabulary incrementally (no full
    // rebuild — the next home/route decision sees it immediately).
    for (const prime of new Set(primes)) vocabularies[homeIndex].add(prime);
    this.updatePrototype(homeIndex, Float64Array.from(trace.smf.toArray()));
    // Amortized partition maintenance: a split/merge attempt every N stores
    // keeps the bookkeeping O(1) amortized while the landscape drifts.
    if (this.storeCount % REORGANIZE_EVERY_STORES === 0) {
      const split = this.maybeSplit();
      if (!split) this.maybeMerge();
    }
    return trace;
  }

  recall(query: RecallQuery, topK?: number): RecallResultLike[] {
    this.recallCount += 1;
    const primes = query.primes ?? [];
    if (primes.length === 0) {
      // Empty cue: the single-bank answer is the scan over everything —
      // route to every shard and merge, preserving the honest global result.
      const results: RecallResultLike[] = [];
      for (const shard of this.shards) results.push(...shard.recall(query, topK));
      results.sort((a, b) => b.score - a.score);
      return topK === undefined ? results : results.slice(0, topK);
    }
    const best = this.routeFor(query);
    const results = this.shards[best].recall(query, topK);
    if (this.shards.length === 1) return results;
    if (results.length === 0) {
      // The top route has no candidates — the cue's true home moved.
      const runnerUp = this.runnerUpFor(query, best);
      if (runnerUp !== -1) {
        const fallback = this.shards[runnerUp].recall(query, topK);
        if (fallback.length > 0) return fallback;
      }
      return results;
    }
    // When the runner-up is nearly as relevant as the top route, merge both
    // — the candidate sets compete exactly as the single bank ranked them.
    const runnerUp = this.runnerUpFor(query, best);
    if (runnerUp !== -1 && this.shards[runnerUp].size > 0) {
      const smf = query.smf;
      if (smf !== undefined) {
        const cue = smf.toArray();
        const prototypes = this.prototypes();
        if (cosineOf(cue, Array.from(prototypes[runnerUp])) >= cosineOf(cue, Array.from(prototypes[best])) - 0.1) {
          const merged = [...results, ...this.shards[runnerUp].recall(query, topK)];
          merged.sort((a, b) => b.score - a.score);
          return topK === undefined ? merged : merged.slice(0, topK);
        }
      }
    }
    return results;
  }

  get(id: string): TraceLike | undefined {
    const shardIndex = this.home.get(id);
    if (shardIndex !== undefined) {
      const trace = this.shards[shardIndex].get(id);
      if (trace !== undefined) return trace;
    }
    for (const shard of this.shards) {
      const trace = shard.get(id);
      if (trace !== undefined) return trace;
    }
    return undefined;
  }

  all(): readonly TraceLike[] {
    return this.shards.flatMap((shard) => shard.all());
  }

  serializeTrace(traceId: string): SerializedTraceData | null {
    const shardIndex = this.home.get(traceId);
    if (shardIndex !== undefined) {
      const data = this.shards[shardIndex].serializeTrace(traceId);
      if (data !== null) return data;
    }
    for (const shard of this.shards) {
      const data = shard.serializeTrace(traceId);
      if (data !== null) return data;
    }
    return null;
  }

  restoreTrace(data: SerializedTraceData): TraceLike | null {
    // Home by vocabulary overlap — deterministic, and identical to the
    // store-time home decision, so a restored record reorganizes the same
    // way a freshly stored one would.
    const vocabularies = this.vocabularies();
    const homeIndex = this.homeFor(data.primes, vocabularies);
    const trace = this.shards[homeIndex].restoreTrace(data);
    if (trace !== null) {
      this.home.set(trace.id, homeIndex);
      for (const prime of new Set(trace.primes)) vocabularies[homeIndex].add(prime);
    }
    return trace;
  }

  reinforce(traceId: string, amount?: number): boolean {
    const shardIndex = this.home.get(traceId);
    if (shardIndex !== undefined && this.shards[shardIndex].reinforce(traceId, amount)) return true;
    for (const shard of this.shards) {
      if (shard.reinforce(traceId, amount)) return true;
    }
    return false;
  }

  bumpUtility(traceId: string, amount: number): void {
    const shardIndex = this.home.get(traceId);
    if (shardIndex !== undefined) this.shards[shardIndex].bumpUtility(traceId, amount);
  }

  clear(): void {
    this.shards.length = 0;
    this.shards.push(this.newShard());
    this.home.clear();
    this.invalidateVocabularies();
    this.prunedCount = 0;
  }

  setCapacity(capacity: number): void {
    this.totalCapacity = Math.max(1, Math.floor(capacity));
    this.rebalanceCapacities();
  }

  stats(): { traceCount: number; capacity: number; consolidatedCount: number; storeCount: number; recallCount: number; prunedCount: number } {
    const aggregate = this.shards.reduce(
      (acc, shard) => {
        const stats = shard.stats();
        return {
          traceCount: acc.traceCount + stats.traceCount,
          consolidatedCount: acc.consolidatedCount + stats.consolidatedCount,
          storeCount: acc.storeCount + stats.storeCount,
          recallCount: acc.recallCount + stats.recallCount,
          prunedCount: acc.prunedCount + stats.prunedCount
        };
      },
      { traceCount: 0, consolidatedCount: 0, storeCount: 0, recallCount: 0, prunedCount: 0 }
    );
    return { ...aggregate, capacity: this.totalCapacity, storeCount: this.storeCount, recallCount: this.recallCount, prunedCount: this.prunedCount + aggregate.prunedCount };
  }

  /** Shard-level audit: trace counts, entropy bits, vocabulary sizes. */
  shardAudit(): { index: number; traces: number; entropyBits: number; vocabulary: number }[] {
    const vocabularies = this.vocabularies();
    return this.shards.map((shard, index) => ({
      index,
      traces: shard.size,
      entropyBits: this.shardEntropy(index),
      vocabulary: vocabularies[index].size
    }));
  }
}
