/**
 * MERGE CONSOLIDATION — the hygiene pass that makes shard-train-merge sound.
 *
 * `mergeRecords` concatenates shard exports and dedupes traces by id only.
 * That is enough for the concatenable stores (traces, word states, the prime
 * basis) but NOT for two things:
 *
 *   1. TRACES. Surprise-gated storage measures surprise against the SHARD's
 *      bank, so two shards that independently store near-identical moments
 *      (same content, same orientation) both keep their trace. The merged
 *      bank then holds near-duplicates that no single shard would ever have
 *      admitted. The fix is the same gate run ONCE over the merged set: any
 *      pair whose SMF cosine clears a near-duplicate threshold collapses to
 *      the strongest trace.
 *
 *   2. AGGREGATE STORES. The non-concatenable stores each need an explicit
 *      merge rule instead of last-wins (or, today, being dropped entirely):
 *        - evidence masses SUM        (trust-kernel buckets, behavior
 *                                      outcomes, goal history, counters);
 *        - weights AVERAGE by mass    (n-gram transition weights, drive
 *                                      arbitration weights);
 *        - decay clocks take the MAX  (last-use / last-outcome stamps);
 *        - the replay guard DEDUPS    (calibration samples; MDL
 *                                      demonstrations);
 *        - MDL gains are ADDITIVE     (bits saved sum) — see below.
 *
 * MDL gains need no merge step: the learned-operator library is a VIEW over
 * the observer's stored creative traces. On import, `rebuildLearnedOperators`
 * replays every creative trace through the learner, whose own replay guard
 * counts an identical demonstration ONCE, so the bits saved across shards
 * simply sum. The consolidation pass and the id-dedup of `mergeRecords`
 * together feed that view the same (deduplicated) creative traces it would
 * have seen in one unsharded run.
 *
 * This module operates on the SERIALIZED `BootstrapRecord` / `SerializedTrace`
 * data (traces carry `smf` arrays), so it never needs a bank instance and
 * never touches the bank classes in packages/sentient-core.
 */
import { SedenionMemoryField, stableCosineSimilarity } from '@sschepis/sentient-core';
import type { SerializedTrace } from '@sschepis/sentient-core';
import type { BootstrapRecord } from './bootstrap';
import type { ReliabilitySnapshot, PendingRegrade, ResolvedRegrade } from './reliability';
import { PENDING_REGRADE_CAP, REGRADE_HISTORY_CAP } from './reliability';
import type { CalibrationSample } from './calibration';
import type { JudgeSnapshot, TrustBucketStats } from './trust';

/**
 * The SMF cosine at or above which two traces count as near-duplicates.
 *
 * Sits ABOVE the measured "consecutive traces in one field" floor (~0.919,
 * regardless of content — see SemanticObserver) so that distinct, recall-
 * equivalent traces are never collapsed, while true re-encodings of the same
 * moment (which cluster tighter than 0.95) do collapse. This is a NEW
 * consolidation constant; it changes no bank threshold.
 */
export const NEAR_DUPLICATE_SMF_COSINE = 0.95;

/** Calibration ledger cap (mirrors `GATE_SAMPLE_CAP` in calibration.ts). */
const CALIBRATION_SAMPLE_CAP = 500;

// ────────────────────────────────────────────────────────────────────────────
// TRACE CONSOLIDATION
// ────────────────────────────────────────────────────────────────────────────

/** Dequantized SMF components of a serialized trace (null when absent/empty). */
function smfComponents(trace: SerializedTrace): number[] | null {
  if (!Array.isArray(trace.smf) || trace.smf.length === 0) return null;
  if (trace.smfEncoding === 'q8') {
    return SedenionMemoryField.fromCompact(trace.smf, trace.smfMax ?? 0);
  }
  return trace.smf;
}

/** Unit-normalized sketch vector (null for a zero/degenerate sketch). */
function unitVector(values: readonly number[]): Float64Array | null {
  const vector = new Float64Array(values.length);
  let norm = 0;
  for (let i = 0; i < values.length; i += 1) {
    const component = Number.isFinite(values[i]) ? values[i] : 0;
    vector[i] = component;
    norm += component * component;
  }
  norm = Math.sqrt(norm);
  if (!(norm > 1e-12)) return null;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

/**
 * Whether `cos(a, b) >= threshold`, with an exact Cauchy-Schwarz early exit:
 * for UNIT vectors, a·b <= dot_partial + sqrt((1 - |a_partial|²)(1 - |b_partial|²)),
 * so once that upper bound drops below the threshold the answer is `false`
 * and the remaining components need never be read. This keeps the worst-case
 * O(n² × width) consolidation from re-scanning every component of every pair.
 */
function cosineAtLeast(a: Float64Array, b: Float64Array, threshold: number): boolean {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
    const bound = dot + Math.sqrt(Math.max(0, 1 - normA) * Math.max(0, 1 - normB));
    if (bound < threshold) return false;
  }
  return dot >= threshold;
}

/** SMF cosine between two serialized traces, in [-1, 1]; 0 when either
 *  lacks a sketch. Uses the same stable cosine the bank's recall uses. */
export function smfCosine(a: SerializedTrace, b: SerializedTrace): number {
  const va = smfComponents(a);
  const vb = smfComponents(b);
  if (va === null || vb === null) return 0;
  return stableCosineSimilarity(va, vb);
}

/**
 * The consolidation pass: the surprise gate run ONCE over the merged trace
 * set. Traces whose SMF cosine is at/above `threshold` are near-duplicates;
 * each such group collapses to its STRONGEST trace (strength, then access
 * count, then importance, then id for determinism). Distinct, recall-
 * equivalent traces are never collapsed.
 *
 * O(n²) in the worst case — the same cost profile as the store-time gate,
 * which compares each new moment against the whole bank. The early-exit
 * cosine makes the common (mostly-distinct) case cheap.
 */
export function consolidateTraces(
  traces: readonly SerializedTrace[],
  threshold = NEAR_DUPLICATE_SMF_COSINE
): SerializedTrace[] {
  const ordered = [...traces].sort((a, b) => {
    const byStrength = (b.strength ?? 0) - (a.strength ?? 0);
    if (byStrength !== 0) return byStrength;
    const byAccess = (b.accessCount ?? 0) - (a.accessCount ?? 0);
    if (byAccess !== 0) return byAccess;
    const byImportance = (b.importance ?? 0) - (a.importance ?? 0);
    if (byImportance !== 0) return byImportance;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const vectors = ordered.map((trace) => unitVector(smfComponents(trace) ?? []));
  const kept: SerializedTrace[] = [];
  const keptVectors: Float64Array[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const vector = vectors[i];
    let nearDuplicate = false;
    if (vector !== null) {
      for (const existing of keptVectors) {
        if (cosineAtLeast(vector, existing, threshold)) {
          nearDuplicate = true;
          break;
        }
      }
    }
    if (!nearDuplicate) {
      kept.push(ordered[i]);
      if (vector !== null) keptVectors.push(vector);
    }
  }
  return kept;
}

// ────────────────────────────────────────────────────────────────────────────
// AGGREGATE MERGE RULES
// ────────────────────────────────────────────────────────────────────────────

/** Sum numeric maps key-wise (evidence masses, counters). */
export function sumNumericMaps(
  maps: ReadonlyArray<Record<string, number> | undefined>
): Record<string, number> | undefined {
  const out = new Map<string, number>();
  for (const map of maps) {
    if (map === undefined) continue;
    for (const [key, value] of Object.entries(map)) {
      if (Number.isFinite(value)) out.set(key, (out.get(key) ?? 0) + value);
    }
  }
  return out.size === 0 ? undefined : Object.fromEntries(out);
}

/** Max numeric maps key-wise (decay clocks: last-use / last-outcome stamps). */
export function maxNumericMaps(
  maps: ReadonlyArray<Record<string, number> | undefined>
): Record<string, number> | undefined {
  const out = new Map<string, number>();
  for (const map of maps) {
    if (map === undefined) continue;
    for (const [key, value] of Object.entries(map)) {
      if (Number.isFinite(value)) out.set(key, Math.max(out.get(key) ?? -Infinity, value));
    }
  }
  return out.size === 0 ? undefined : Object.fromEntries(out);
}

/**
 * Average weight maps by evidence mass: for each key,
 * `merged = Σ(weight_i × mass_i) / Σ(mass_i)`. When no mass is supplied (or
 * a key's mass is absent/zero) each contributing record counts with the
 * `defaultMass` — i.e. an equal-mass average over the shards that observed
 * the key. This is the rule for n-gram and drive weights.
 */
export function averageWeightsByMass(
  weights: ReadonlyArray<Record<string, number> | undefined>,
  masses: ReadonlyArray<Record<string, number> | undefined> = [],
  defaultMass = 1
): Record<string, number> | undefined {
  const acc = new Map<string, { sum: number; mass: number }>();
  for (let i = 0; i < weights.length; i += 1) {
    const map = weights[i];
    if (map === undefined) continue;
    const massMap = masses[i];
    for (const [key, value] of Object.entries(map)) {
      if (!Number.isFinite(value)) continue;
      const raw = massMap?.[key];
      const mass = raw !== undefined && Number.isFinite(raw) && raw > 0 ? raw : defaultMass;
      const entry = acc.get(key) ?? { sum: 0, mass: 0 };
      entry.sum += value * mass;
      entry.mass += mass;
      acc.set(key, entry);
    }
  }
  if (acc.size === 0) return undefined;
  const out: Record<string, number> = {};
  for (const [key, { sum, mass }] of acc) out[key] = mass > 0 ? sum / mass : sum;
  return out;
}

/** Sum `{ field: number, ... }` records key-wise (behavior outcomes, goal
 *  history — each pair's fields are evidence masses that sum). */
function sumPairRecords(
  maps: ReadonlyArray<Record<string, Record<string, number>> | undefined>
): Record<string, Record<string, number>> | undefined {
  const out = new Map<string, Record<string, number>>();
  for (const map of maps) {
    if (map === undefined) continue;
    for (const [key, pair] of Object.entries(map)) {
      const acc = out.get(key) ?? {};
      for (const [field, value] of Object.entries(pair)) {
        const n = Number(value);
        if (Number.isFinite(n)) acc[field] = (acc[field] ?? 0) + n;
      }
      out.set(key, acc);
    }
  }
  return out.size === 0 ? undefined : Object.fromEntries(out);
}

/** Union of string lists, order-preserving and deduplicated (the replay
 *  guard for the produced-cue ledger). */
function unionStrings(lists: ReadonlyArray<string[] | undefined>): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    if (list === undefined) continue;
    for (const item of list) {
      if (!seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out.length === 0 ? undefined : out;
}

const JUDGE_MAP_FIELDS = ['buckets', 'byAnswerType', 'byDifficulty', 'byTemplate', 'byProvider'] as const;

/** Sum trust-kernel bucket stats key-wise — the "evidence masses sum" rule
 *  (`agree` and `total` are both masses). */
function mergeBucketStats(
  maps: ReadonlyArray<Record<string, TrustBucketStats> | undefined>
): Record<string, TrustBucketStats> {
  const out = new Map<string, TrustBucketStats>();
  for (const map of maps) {
    if (map === undefined) continue;
    for (const [key, stats] of Object.entries(map)) {
      const agree = Number(stats?.agree);
      const total = Number(stats?.total);
      if (!Number.isFinite(agree) || !Number.isFinite(total)) continue;
      const acc = out.get(key) ?? { agree: 0, total: 0 };
      acc.agree += agree;
      acc.total += total;
      out.set(key, acc);
    }
  }
  return Object.fromEntries(out);
}

function mergeJudgeSnapshot(
  snapshots: ReadonlyArray<JudgeSnapshot | undefined>
): JudgeSnapshot | undefined {
  const present = snapshots.filter((s): s is JudgeSnapshot => s !== undefined);
  if (present.length === 0) return undefined;
  const merged: Partial<JudgeSnapshot> = {};
  for (const field of JUDGE_MAP_FIELDS) {
    const stats = mergeBucketStats(present.map((s) => s[field]));
    if (Object.keys(stats).length > 0) merged[field] = stats;
  }
  return merged as JudgeSnapshot;
}

function dedupById<T extends { id: string; at: number }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** Merge the trust-kernel evidence (grader-reliability snapshots): bucket
 *  masses sum; the pending/history ledgers dedup by id (replay guard) and are
 *  re-capped to the model's own bounds. */
export function mergeReliabilitySnapshots(
  snapshots: ReadonlyArray<ReliabilitySnapshot | undefined>
): ReliabilitySnapshot | undefined {
  const present = snapshots.filter((s): s is ReliabilitySnapshot => s !== undefined);
  if (present.length === 0) return undefined;

  const llm: Partial<ReliabilitySnapshot> = {};
  for (const field of JUDGE_MAP_FIELDS) {
    const stats = mergeBucketStats(present.map((s) => s[field]));
    if (Object.keys(stats).length > 0) llm[field] = stats;
  }

  const judgeIds = new Set<string>();
  for (const snapshot of present) {
    if (snapshot.judges !== undefined) {
      for (const id of Object.keys(snapshot.judges)) judgeIds.add(id);
    }
  }
  const judges: Record<string, JudgeSnapshot> = {};
  for (const id of judgeIds) {
    const merged = mergeJudgeSnapshot(present.map((s) => s.judges?.[id]));
    if (merged !== undefined) judges[id] = merged;
  }

  const pending = dedupById<PendingRegrade>(present.flatMap((s) => s.pending ?? []))
    .sort((a, b) => a.at - b.at)
    .slice(-PENDING_REGRADE_CAP);
  const history = dedupById<ResolvedRegrade>(present.flatMap((s) => s.history ?? []))
    .sort((a, b) => a.at - b.at)
    .slice(-REGRADE_HISTORY_CAP);

  return {
    ...llm,
    ...(Object.keys(judges).length > 0 ? { judges } : {}),
    pending,
    history
  } as ReliabilitySnapshot;
}

/** Merge calibration samples: concatenate per-gate samples and let the replay
 *  guard dedup identical (score, positive) samples (a re-exported ledger
 *  replaying its own samples counts each once), re-capped to the ledger bound.
 *  Exported for direct use — calibration samples do not yet ride the
 *  BootstrapRecord, so `mergeAggregateStores` has nothing to merge for them
 *  today. */
export function mergeCalibrationSamples(
  stores: ReadonlyArray<Record<string, CalibrationSample[]> | undefined>,
  cap = CALIBRATION_SAMPLE_CAP
): Record<string, CalibrationSample[]> {
  const merged = new Map<string, CalibrationSample[]>();
  for (const store of stores) {
    if (store === undefined) continue;
    for (const [gate, samples] of Object.entries(store)) {
      if (!Array.isArray(samples)) continue;
      const list = merged.get(gate) ?? [];
      const seen = new Set(list.map((s) => `${s.score}\u0000${s.positive}`));
      for (const sample of samples) {
        const score = Number(sample?.score);
        if (!Number.isFinite(score)) continue;
        const positive = sample?.positive === true;
        const key = `${score}\u0000${positive}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ score, positive });
      }
      merged.set(gate, list);
    }
  }
  const out: Record<string, CalibrationSample[]> = {};
  for (const [gate, list] of merged) out[gate] = list.slice(-cap);
  return out;
}

export interface MergedAggregates {
  driveWeights?: Record<string, number>;
  goalHistory?: Record<string, { completed: number; abandoned: number }>;
  learningState?: NonNullable<BootstrapRecord['learningState']>;
}

/** Merge every non-concatenable aggregate store across shard records with the
 *  explicit rule each one needs (sum / average-by-mass / max / dedup). */
export function mergeAggregateStores(records: readonly BootstrapRecord[]): MergedAggregates {
  const learningStates = records.map((r) => r.learningState);

  // Drive weights average by their evidence mass: each behavior's outcome
  // cascade (wins + losses) is the credit history behind its weight.
  const driveMasses = learningStates.map((ls) => {
    if (ls?.behaviorOutcomes === undefined) return undefined;
    const masses: Record<string, number> = {};
    for (const [option, { wins, losses }] of Object.entries(ls.behaviorOutcomes)) {
      masses[option] = (Number.isFinite(wins) ? wins : 0) + (Number.isFinite(losses) ? losses : 0);
    }
    return masses;
  });
  const driveWeights = averageWeightsByMass(
    records.map((r) => r.driveWeights),
    driveMasses
  );

  const behaviorOutcomes = sumPairRecords(
    learningStates.map((ls) => ls?.behaviorOutcomes)
  ) as Record<string, { wins: number; losses: number }> | undefined;

  const goalHistory = sumPairRecords(
    records.map((r) => r.goalHistory)
  ) as Record<string, { completed: number; abandoned: number }> | undefined;

  // N-gram transition weights average by evidence mass. The record carries
  // the n-gram DECAY CLOCK (`compositionWeightMeta`, a last-use timestamp) but
  // not a per-n-gram observation count, so shards that observed an n-gram
  // contribute equal mass (an equal-mass average over contributing shards).
  const compositionWeights = averageWeightsByMass(
    learningStates.map((ls) => ls?.compositionWeights),
    [],
    1
  );

  const compositionWeightMeta = maxNumericMaps(learningStates.map((ls) => ls?.compositionWeightMeta));
  const behaviorOutcomeAt = maxNumericMaps(learningStates.map((ls) => ls?.behaviorOutcomeAt));
  const exposureCounts = sumNumericMaps(learningStates.map((ls) => ls?.exposureCounts));
  const encounterCounts = sumNumericMaps(learningStates.map((ls) => ls?.encounterCounts));
  const drillFailures = sumNumericMaps(learningStates.map((ls) => ls?.drillFailures));
  const producedCues = unionStrings(learningStates.map((ls) => ls?.producedCues));
  const cueConfidence = averageWeightsByMass(
    learningStates.map((ls) => ls?.cueConfidence),
    [],
    1
  );
  const graderReliability = mergeReliabilitySnapshots(
    learningStates.map((ls) => ls?.graderReliability)
  );

  const learningState: NonNullable<BootstrapRecord['learningState']> = {};
  if (compositionWeights !== undefined) learningState.compositionWeights = compositionWeights;
  if (compositionWeightMeta !== undefined) learningState.compositionWeightMeta = compositionWeightMeta;
  if (behaviorOutcomeAt !== undefined) learningState.behaviorOutcomeAt = behaviorOutcomeAt;
  if (behaviorOutcomes !== undefined) learningState.behaviorOutcomes = behaviorOutcomes;
  if (exposureCounts !== undefined) learningState.exposureCounts = exposureCounts;
  if (encounterCounts !== undefined) learningState.encounterCounts = encounterCounts;
  if (drillFailures !== undefined) learningState.drillFailures = drillFailures;
  if (producedCues !== undefined) learningState.producedCues = producedCues;
  if (cueConfidence !== undefined) learningState.cueConfidence = cueConfidence;
  if (graderReliability !== undefined) learningState.graderReliability = graderReliability;

  return {
    ...(driveWeights !== undefined ? { driveWeights } : {}),
    ...(goalHistory !== undefined ? { goalHistory } : {}),
    ...(Object.keys(learningState).length > 0 ? { learningState } : {})
  };
}
