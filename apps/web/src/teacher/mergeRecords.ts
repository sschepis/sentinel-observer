/**
 * MERGE RECORDS — concatenate shard-trainer records into one bootstrap
 * record with the merge-hygiene passes applied (B.1).
 *
 * Extracted from shardTrainer.ts so the shard-route bench (and any jest
 * suite) can import the merge WITHOUT parsing the worker-pool machinery
 * (`import.meta`, esbuild bundles) — the same rule mergeConsolidation.test.ts
 * documents. shardTrainer.ts re-exports this for its existing callers.
 */
import {
  BOOTSTRAP_VERSION,
  BOOTSTRAP_VOCABULARY_SCHEME,
  type BootstrapRecord
} from './bootstrap';
import { consolidateTraces, mergeAggregateStores } from './mergeConsolidation';

/**
 * Concatenate shard records into a single bootstrap record, then run the
 * merge-hygiene passes:
 *   - traces are deduplicated by id, then CONSOLIDATED — the surprise gate
 *     run once over the merged set collapses cross-shard near-duplicates
 *     (SMF cosine at/above NEAR_DUPLICATE_SMF_COSINE) to the strongest trace;
 *   - the non-concatenable aggregate stores are merged with explicit rules
 *     (masses sum, weights average by mass, clocks take the max) instead of
 *     being dropped.
 * The prime basis is taken from the first record that carries one (all shards
 * share the same observer options).
 */
export function mergeRecords(records: readonly BootstrapRecord[]): BootstrapRecord {
  const seen = new Set<string>();
  const concatenated = records
    .flatMap((r) => r.traces)
    .filter((trace) => (seen.has(trace.id) ? false : (seen.add(trace.id), true)));
  const traces = consolidateTraces(concatenated);
  // A word whose trace collapsed into a near-duplicate is covered by the
  // survivor; drop its word state so the import never binds a dangling id.
  const survivingIds = new Set(traces.map((t) => t.id));
  const wordStates = records
    .flatMap((r) => r.wordStates)
    .filter((state) => state.traceId !== null && survivingIds.has(state.traceId));
  const aggregates = mergeAggregateStores(records);
  const basis = records.find((r) => r.primeBasis !== undefined && r.primeBasis.length > 0)?.primeBasis;
  return {
    version: BOOTSTRAP_VERSION,
    vocabularyScheme: BOOTSTRAP_VOCABULARY_SCHEME,
    deck: 'scale-merged',
    generatedAt: new Date().toISOString(),
    encoding: 'q16' as const,
    primeBasis: basis,
    source: {
      words: records.flatMap((r) => r.source.words),
      conversation: false,
      definitionsFilled: false
    },
    traces,
    wordStates,
    definitions: records.flatMap((r) => r.definitions),
    ...(aggregates.driveWeights !== undefined ? { driveWeights: aggregates.driveWeights } : {}),
    ...(aggregates.goalHistory !== undefined ? { goalHistory: aggregates.goalHistory } : {}),
    ...(aggregates.learningState !== undefined ? { learningState: aggregates.learningState } : {})
  };
}
