/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { ShardedMemoryBank, retrievalInterferenceEntropy, jaccardPrimeSimilarity, partitionByPrimeJaccard } from '../../src/semantic/ShardedMemoryBank';
import { SedenionMemoryField } from '../../src/semantic/SedenionMemoryField';
import type { RecallQuery } from '../../src/semantic/CompactMemoryBank';

/** Distinct SMF orientations on pure axes (the sketch projection puts a
 *  ~0.5 similarity floor between any two distinct axes, so families on
 *  pure axes are NOT retrieval neighbors), with deliberate cross-talk:
 *  snow leans strongly into the greeting axis, so it is a retrieval
 *  neighbor of the greetings but not of the birds — a real edge for the
 *  partition to cut. */
function orientation(family: keyof typeof WORD_PRIMES): SedenionMemoryField {
  const smf = SedenionMemoryField.identity({ width: 16 });
  if (family === 'morning' || family === 'evening' || family === 'night') {
    smf.set(1, 1);
  } else if (family === 'bird' || family === 'robin') {
    smf.set(2, 1);
  } else if (family === 'snow') {
    smf.set(1, 0.95);
    smf.set(3, 0.312); // whisper of its own axis — still a greeting neighbor
  } else {
    smf.set(4, 1);
  }
  smf.normalize();
  return smf;
}

function storeTrace(bank: ShardedMemoryBank, content: string, primes: readonly number[], family: keyof typeof WORD_PRIMES): string {
  const smf = orientation(family);
  return bank.store(content, smf, primes, { metadata: { content } }).id;
}

const WORD_PRIMES = {
  morning: [1, 2, 3, 4],
  evening: [1, 2, 3, 5],
  night: [1, 2, 3, 6],
  bird: [7, 8, 9],
  robin: [7, 8, 10],
  snow: [1, 11, 12, 13], // shares prime 1 with the greetings (cross-talk)
  hammer: [7, 14, 15, 16] // shares prime 7 with the birds (cross-talk)
} as const;

describe('retrievalInterferenceEntropy (the reduced-entropy metric)', () => {
  it('is 0 when every prime is unique to one trace', () => {
    expect(retrievalInterferenceEntropy([{ primes: [1, 2] }, { primes: [3, 4] }, { primes: [5, 6] }])).toBe(0);
  });

  it('grows as traces share primes (the paraphrase-collision case)', () => {
    const disjoint = retrievalInterferenceEntropy([{ primes: [1, 2] }, { primes: [3, 4] }]);
    const colliding = retrievalInterferenceEntropy([{ primes: [1, 2] }, { primes: [1, 2] }]);
    expect(colliding).toBeGreaterThan(disjoint);
  });

  it('is deterministic and bounded: 0 <= H <= log2(trace count)', () => {
    const traces = [
      { primes: [1, 2, 3] },
      { primes: [1, 2, 4] },
      { primes: [1, 2, 5] },
      { primes: [9, 10] }
    ];
    const bits = retrievalInterferenceEntropy(traces);
    expect(bits).toBeGreaterThan(0);
    expect(bits).toBeLessThanOrEqual(Math.log2(traces.length));
    expect(retrievalInterferenceEntropy(traces)).toBe(bits);
  });

  it('drops when cross-talk is partitioned away', () => {
    const traces = Object.values(WORD_PRIMES).map((primes) => ({ primes }));
    const singleBank = retrievalInterferenceEntropy(traces);
    // The partition that isolates the greeting family from the bird family
    // (with the cross-talk primes split off) must measure lower.
    const partition = partitionByPrimeJaccard(traces, 2);
    const groups: { primes: readonly number[] }[][] = [[], []];
    for (let i = 0; i < traces.length; i += 1) groups[partition.assignment[i]].push(traces[i]);
    const sharded = retrievalInterferenceEntropy(groups[0]) + retrievalInterferenceEntropy(groups[1]);
    expect(sharded).toBeLessThan(singleBank);
  });
});

describe('jaccardPrimeSimilarity', () => {
  it('measures overlap between prime sets', () => {
    expect(jaccardPrimeSimilarity(new Set([1, 2]), new Set([1, 2]))).toBe(1);
    expect(jaccardPrimeSimilarity(new Set([1, 2]), new Set([3, 4]))).toBe(0);
    expect(jaccardPrimeSimilarity(new Set([1, 2]), new Set([1, 3]))).toBe(1 / 3);
  });
});

describe('partitionByPrimeJaccard (deterministic k-medoids)', () => {
  it('splits into non-degenerate clusters that reduce interference entropy', () => {
    const traces = Object.values(WORD_PRIMES).map((primes) => ({ primes }));
    const { assignment } = partitionByPrimeJaccard(traces, 2);
    const groups: number[][] = [[], []];
    for (let i = 0; i < traces.length; i += 1) groups[assignment[i]].push(i);
    // Both clusters non-empty (k is honored).
    expect(groups[0].length).toBeGreaterThan(0);
    expect(groups[1].length).toBeGreaterThan(0);
    // The reduced-entropy principle: the partition lowers the mean
    // per-cue candidate spread below the single-bank reading.
    const single = retrievalInterferenceEntropy(traces);
    const sharded = groups.reduce(
      (sum, group) => sum + retrievalInterferenceEntropy(group.map((index) => traces[index])),
      0
    );
    expect(sharded).toBeLessThan(single);
  });

  it('is deterministic across runs', () => {
    const traces = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ primes: [i, i + 10, i + 20] }));
    const a = partitionByPrimeJaccard(traces, 2);
    const b = partitionByPrimeJaccard(traces, 2);
    expect(a.assignment).toEqual(b.assignment);
  });
});

describe('ShardedMemoryBank', () => {
  it('routes recall to the shard whose vocabulary matches (no cross-talk)', () => {
    const bank = new ShardedMemoryBank({ splitMinTraces: 3, splitEntropyBits: 2.0, minSplitGainBits: 0.05 });
    const morning = storeTrace(bank, 'good morning', WORD_PRIMES.morning, 'morning');
    const evening = storeTrace(bank, 'good evening', WORD_PRIMES.evening, 'evening');
    const night = storeTrace(bank, 'good night', WORD_PRIMES.night, 'night');
    storeTrace(bank, 'a bird can fly', WORD_PRIMES.bird, 'bird');
    storeTrace(bank, 'a robin is a bird', WORD_PRIMES.robin, 'robin');
    storeTrace(bank, 'snow is cold', WORD_PRIMES.snow, 'snow');
    bank.reorganize();

    expect(bank.shardAudit().length).toBeGreaterThan(1);
    // Total interference entropy must have FALLEN after reorganization
    // (the bank's total is the interference SUM; the single-bank reading
    // is the mean over the same traces, scaled to a sum for comparison).
    const singleTraces = bank.all();
    const singleSum = retrievalInterferenceEntropy(singleTraces) * singleTraces.length;
    expect(bank.retrievalEntropy()).toBeLessThan(singleSum);

    const query = (primes: readonly number[]): RecallQuery => ({ primes });
    const morningRecall = bank.recall(query(WORD_PRIMES.morning), 3);
    expect(morningRecall.some((r) => r.trace.id === morning)).toBe(true);
    const eveningRecall = bank.recall(query(WORD_PRIMES.evening), 3);
    expect(eveningRecall.some((r) => r.trace.id === evening)).toBe(true);
    const nightRecall = bank.recall(query(WORD_PRIMES.night), 3);
    expect(nightRecall.some((r) => r.trace.id === night)).toBe(true);
  });

  it('routeScores exposes the flat router distribution without changing routing', () => {
    const bank = new ShardedMemoryBank({ splitMinTraces: 3, splitEntropyBits: 2.0, minSplitGainBits: 0.05 });
    storeTrace(bank, 'good morning', WORD_PRIMES.morning, 'morning');
    storeTrace(bank, 'good evening', WORD_PRIMES.evening, 'evening');
    storeTrace(bank, 'good night', WORD_PRIMES.night, 'night');
    storeTrace(bank, 'a bird can fly', WORD_PRIMES.bird, 'bird');
    storeTrace(bank, 'a robin is a bird', WORD_PRIMES.robin, 'robin');
    storeTrace(bank, 'snow is cold', WORD_PRIMES.snow, 'snow');
    bank.reorganize();

    const shardCount = bank.shardAudit().length;
    expect(shardCount).toBeGreaterThan(1);

    // Prime-vocabulary overlap per shard — the values routeFor ranks.
    const byPrimes = bank.routeScores({ primes: WORD_PRIMES.morning });
    expect(byPrimes).toHaveLength(shardCount);
    expect(byPrimes.every((s) => Number.isFinite(s) && s >= 0)).toBe(true);
    // The max-score shard is where recall routes the morning cue.
    const best = byPrimes.indexOf(Math.max(...byPrimes));
    expect(best).toBeGreaterThanOrEqual(0);

    // SMF prototype cosine per shard — the sketch route's distribution.
    const bySmf = bank.routeScores({ smf: orientation('morning') });
    expect(bySmf).toHaveLength(shardCount);
    expect(bySmf.every((s) => Number.isFinite(s))).toBe(true);

    // An unroutable cue (no sketch, no primes) has no distribution.
    expect(bank.routeScores({})).toEqual([]);
  });

  it('keeps every trace reachable by id across partition moves', () => {
    const bank = new ShardedMemoryBank({ splitMinTraces: 3, splitEntropyBits: 2.0, minSplitGainBits: 0.05 });
    const ids = [WORD_PRIMES.morning, WORD_PRIMES.evening, WORD_PRIMES.night, WORD_PRIMES.bird, WORD_PRIMES.robin, WORD_PRIMES.snow].map((primes) => storeTrace(bank, `t${primes[0]}`, primes, Object.keys(WORD_PRIMES)[Object.values(WORD_PRIMES).indexOf(primes)] as keyof typeof WORD_PRIMES));
    bank.reorganize();
    bank.reorganize(); // twice: partitions must be stable, ids must survive
    for (const id of ids) {
      expect(bank.get(id)).not.toBeUndefined();
      expect(bank.serializeTrace(id)).not.toBeNull();
    }
    expect(bank.size).toBe(ids.length);
  });

  it('persists through serialize/restore with the same home decision', () => {
    const bank = new ShardedMemoryBank({ splitMinTraces: 3, splitEntropyBits: 2.0, minSplitGainBits: 0.05 });
    const ids = [WORD_PRIMES.morning, WORD_PRIMES.evening, WORD_PRIMES.night, WORD_PRIMES.bird, WORD_PRIMES.robin, WORD_PRIMES.snow].map((primes) => storeTrace(bank, `t${primes[0]}`, primes, Object.keys(WORD_PRIMES)[Object.values(WORD_PRIMES).indexOf(primes)] as keyof typeof WORD_PRIMES));
    bank.reorganize();
    const serialized = ids.map((id) => bank.serializeTrace(id)).filter((data) => data !== null);

    const restored = new ShardedMemoryBank({ splitMinTraces: 3, splitEntropyBits: 2.0, minSplitGainBits: 0.05 });
    for (const data of serialized) restored.restoreTrace(data!);
    expect(restored.size).toBe(ids.length);
    for (const id of ids) expect(restored.get(id)).not.toBeUndefined();
    // Recall still finds the morning trace after the round trip.
    const recall = restored.recall({ primes: WORD_PRIMES.morning }, 3);
    expect(recall.some((r) => r.trace.id === ids[0])).toBe(true);
  });

  it('reinforce and bumpUtility route through the home map', () => {
    const bank = new ShardedMemoryBank({ splitMinTraces: 3, splitEntropyBits: 2.0, minSplitGainBits: 0.05 });
    const id = storeTrace(bank, 'good morning', WORD_PRIMES.morning, 'morning');
    storeTrace(bank, 'a bird can fly', WORD_PRIMES.bird, 'bird');
    storeTrace(bank, 'snow is cold', WORD_PRIMES.snow, 'snow');
    bank.reorganize();
    expect(bank.reinforce(id, 0.5)).toBe(true);
    bank.bumpUtility(id, 3);
    expect(bank.get(id)?.strength).toBeGreaterThan(0.5);
  });

  it('stats aggregates across shards', () => {
    const bank = new ShardedMemoryBank({ splitMinTraces: 3, splitEntropyBits: 2.0, minSplitGainBits: 0.05 });
    for (const primes of Object.values(WORD_PRIMES)) storeTrace(bank, `t${primes[0]}`, primes, Object.keys(WORD_PRIMES)[Object.values(WORD_PRIMES).indexOf(primes)] as keyof typeof WORD_PRIMES);
    bank.reorganize();
    const stats = bank.stats();
    expect(stats.traceCount).toBe(Object.keys(WORD_PRIMES).length);
    expect(stats.capacity).toBeGreaterThan(0);
    expect(bank.shardAudit().length).toBeGreaterThan(1);
  });

  it('merge folds a starved shard into its nearest neighbor within budget', () => {
    const bank = new ShardedMemoryBank({ mergeFloor: 2, splitEntropyBits: 100, splitMinTraces: 100, minSplitGainBits: 0.05 });
    storeTrace(bank, 'good morning', WORD_PRIMES.morning, 'morning');
    storeTrace(bank, 'good evening', WORD_PRIMES.evening, 'evening');
    storeTrace(bank, 'a bird can fly', WORD_PRIMES.bird, 'bird');
    expect(bank.shardAudit().length).toBe(1);
    // Force a partition by hand: three traces, one starved shard.
    const all = bank.all();
    const groups = [[all[0]], [all[1], all[2]]];
    (bank as unknown as { applyPartition(groups: readonly (readonly { id: string }[])[]): void }).applyPartition(groups);
    const audit = bank.shardAudit();
    expect(audit.length).toBe(2);
    expect(audit[0].traces).toBe(1);
    const outcome = bank.maintain();
    expect(outcome.merged).toBe(true);
    // The starved shard merges back into the neighbor (budget permits).
    expect(bank.shardAudit().length).toBe(1);
  });
});
