/**
 * @jest-environment node
 */
/**
 * MERGE CONSOLIDATION TESTS — the hygiene guarantees of shard-train-merge:
 *   (a) near-duplicate traces (SMF cosine >= the near-duplicate threshold)
 *       collapse to zero on a synthetic multi-shard merge, keeping the
 *       strongest survivor;
 *   (b) recall-equivalent but DISTINCT traces are never collapsed;
 *   (c) the aggregate merge rules produce summed (evidence masses) and
 *       averaged (weights by mass) values.
 *
 * The consolidation pass and the aggregate merge live in `mergeConsolidation`
 * (a pure module over serialized trace/record data — no bank, no workers),
 * which is what `mergeRecords` wires into the shard-train path. Testing the
 * pass directly keeps this suite free of the worker pool and `import.meta`.
 */
import { describe, it, expect } from '@jest/globals';
import {
  consolidateTraces,
  mergeAggregateStores,
  mergeCalibrationSamples,
  averageWeightsByMass,
  NEAR_DUPLICATE_SMF_COSINE
} from './mergeConsolidation';
import { BOOTSTRAP_VERSION, BOOTSTRAP_VOCABULARY_SCHEME, type BootstrapRecord } from './bootstrap';
import type { SerializedTrace } from '@sschepis/sentient-core';
import type { ReliabilitySnapshot } from './reliability';

function makeTrace(overrides: Partial<SerializedTrace> & Pick<SerializedTrace, 'id' | 'content' | 'smf'>): SerializedTrace {
  return {
    id: overrides.id,
    content: overrides.content,
    smf: overrides.smf,
    primes: overrides.primes ?? [2, 3, 5],
    amplitudes: overrides.amplitudes ?? [1, 1, 1],
    createdAt: overrides.createdAt ?? 0,
    lastAccessAt: overrides.lastAccessAt ?? 0,
    accessCount: overrides.accessCount ?? 0,
    strength: overrides.strength ?? 0.5,
    importance: overrides.importance ?? 0.5,
    consolidated: overrides.consolidated ?? false,
    smfEntropy: overrides.smfEntropy ?? 0.5,
    metadata: overrides.metadata ?? {}
  };
}

function makeRecord(overrides: Partial<BootstrapRecord> = {}): BootstrapRecord {
  return {
    version: BOOTSTRAP_VERSION,
    vocabularyScheme: BOOTSTRAP_VOCABULARY_SCHEME,
    deck: 'test',
    generatedAt: new Date().toISOString(),
    source: { words: [], conversation: false, definitionsFilled: false },
    traces: [],
    wordStates: [],
    definitions: [],
    ...overrides
  };
}

function reliability(buckets: Record<string, { agree: number; total: number }>): ReliabilitySnapshot {
  return { buckets, byAnswerType: {}, byDifficulty: {}, byTemplate: {}, byProvider: {}, pending: [], history: [] };
}

/** The id-dedup concatenation `mergeRecords` performs before the consolidation
 *  pass, reproduced here so the pass is exercised on a real multi-shard merge. */
function concatenateShards(shards: readonly BootstrapRecord[]): SerializedTrace[] {
  const seen = new Set<string>();
  return shards
    .flatMap((r) => r.traces)
    .filter((trace) => (seen.has(trace.id) ? false : (seen.add(trace.id), true)));
}

describe('consolidation pass (surprise gate over the merged trace set)', () => {
  it('collapses cross-shard near-duplicates to zero, keeping the strongest', () => {
    // Same content ("hello"), near-identical SMF (cosine ~0.9996) across two
    // shards; a third distinct trace stays.
    const nearA = makeTrace({ id: 'a', content: 'hello', smf: [1, 0, 0, 0], strength: 0.9 });
    const nearB = makeTrace({ id: 'b', content: 'hello', smf: [1, 0.03, 0, 0], strength: 0.6 });
    const distinct = makeTrace({ id: 'c', content: 'goodbye', smf: [0, 1, 0, 0], strength: 0.8 });

    const merged = consolidateTraces(
      concatenateShards([
        makeRecord({ traces: [nearA] }),
        makeRecord({ traces: [nearB] }),
        makeRecord({ traces: [distinct] })
      ])
    );

    const ids = merged.map((t) => t.id);
    expect(ids).toContain('a'); // strongest survivor
    expect(ids).not.toContain('b'); // near-duplicate dropped
    expect(ids).toContain('c'); // distinct preserved
    expect(merged).toHaveLength(2);
  });

  it('never collapses a recall-equivalent but distinct trace', () => {
    // A NEIGHBOR trace (SMF cosine ~0.8, above the retrieval-neighbor floor
    // but below the near-duplicate threshold) must survive — only genuine
    // re-encodings collapse.
    const anchor = makeTrace({ id: 'a', content: 'hello', smf: [1, 0, 0, 0], strength: 0.9 });
    const neighbor = makeTrace({ id: 'd', content: 'world', smf: [0.8, 0.6, 0, 0], strength: 0.7 });

    const merged = consolidateTraces(
      concatenateShards([makeRecord({ traces: [anchor] }), makeRecord({ traces: [neighbor] })])
    );

    const ids = merged.map((t) => t.id);
    expect(ids).toContain('a');
    expect(ids).toContain('d');
    expect(merged).toHaveLength(2);
  });

  it('exposes the near-duplicate criterion as a stable constant above the neighbor floor', () => {
    expect(NEAR_DUPLICATE_SMF_COSINE).toBeGreaterThan(0.7);
    expect(NEAR_DUPLICATE_SMF_COSINE).toBeLessThan(1);
  });
});

describe('aggregate merge rules', () => {
  it('averages weights by evidence mass and sums evidence masses', () => {
    const merged = mergeAggregateStores([
      makeRecord({
        driveWeights: { answer: 0.5, ask: 0.2 },
        goalHistory: { know: { completed: 1, abandoned: 0 } },
        learningState: {
          compositionWeights: { a: 0.4, b: 0.9 },
          compositionWeightMeta: { a: 1000, b: 2000 },
          behaviorOutcomes: { answer: { wins: 2, losses: 0 }, ask: { wins: 1, losses: 1 } },
          behaviorOutcomeAt: { answer: 5000 },
          exposureCounts: { x: 3 },
          graderReliability: reliability({ k: { agree: 2, total: 4 } })
        }
      }),
      makeRecord({
        driveWeights: { answer: 0.9 },
        goalHistory: { know: { completed: 2, abandoned: 1 } },
        learningState: {
          compositionWeights: { a: 0.8 },
          compositionWeightMeta: { a: 3000 },
          behaviorOutcomes: { answer: { wins: 7, losses: 1 } },
          behaviorOutcomeAt: { answer: 9000 },
          exposureCounts: { x: 5 },
          graderReliability: reliability({ k: { agree: 3, total: 5 } })
        }
      })
    ]);

    // Drive weight averages by its evidence mass (wins + losses).
    //   answer: (0.5·2 + 0.9·8) / (2 + 8) = 0.82
    expect(merged.driveWeights?.answer).toBeCloseTo(0.82, 5);
    //   ask appears in one shard only: mass 2, weight 0.2 -> 0.2.
    expect(merged.driveWeights?.ask).toBeCloseTo(0.2, 5);

    // Behavior outcomes (evidence masses) SUM.
    expect(merged.learningState?.behaviorOutcomes?.answer).toEqual({ wins: 9, losses: 1 });

    // Goal history (evidence masses) SUM.
    expect(merged.goalHistory?.know).toEqual({ completed: 3, abandoned: 1 });

    // N-gram weights average by evidence mass (equal shard mass — the record
    // carries decay clocks, not observation counts): (0.4 + 0.8) / 2 = 0.6,
    // and the single-shard key b survives unchanged.
    expect(merged.learningState?.compositionWeights?.a).toBeCloseTo(0.6, 5);
    expect(merged.learningState?.compositionWeights?.b).toBeCloseTo(0.9, 5);

    // Decay clocks take the MAX (most recent stamp).
    expect(merged.learningState?.compositionWeightMeta?.a).toBe(3000);
    expect(merged.learningState?.behaviorOutcomeAt?.answer).toBe(9000);

    // Counters sum.
    expect(merged.learningState?.exposureCounts?.x).toBe(8);

    // Trust-kernel evidence masses sum.
    expect(merged.learningState?.graderReliability?.buckets.k).toEqual({ agree: 5, total: 9 });
  });

  it('dedups identical calibration samples (replay guard) across shards', () => {
    const merged = mergeCalibrationSamples([
      { gate1: [{ score: 0.9, positive: true }, { score: 0.5, positive: false }] },
      { gate1: [{ score: 0.9, positive: true }, { score: 0.8, positive: true }] }
    ]);
    // The identical (0.9, true) sample is counted once.
    expect(merged.gate1).toHaveLength(3);
    expect(merged.gate1.filter((s) => s.score === 0.9 && s.positive).length).toBe(1);
  });

  it('averages a weight map by explicit evidence masses', () => {
    const out = averageWeightsByMass(
      [{ k: 0.2 }, { k: 0.9 }, undefined],
      [{ k: 2 }, { k: 8 }, undefined],
      1
    );
    expect(out?.k).toBeCloseTo((0.2 * 2 + 0.9 * 8) / (2 + 8), 6);
  });
});
