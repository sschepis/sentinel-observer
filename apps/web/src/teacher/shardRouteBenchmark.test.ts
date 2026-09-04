/**
 * @jest-environment node
 */
/**
 * SHARD-ROUTE-BENCH (improvements.md §3.2 / Phase B.2) — keep the shard
 * trainer's K shards as SEPARATE banks at query time and route each cue,
 * vs. the merged single-bank baseline (94.6% at 20k, 26.4 ms ask).
 *
 * Measured per K (K ∈ {4, 8}): routing accuracy (top-1 and top-2), in-shard
 * recall, effective recall (the end-to-end routed answer, which includes the
 * runner-up fallback), and ask latency — all against the merged baseline
 * over the same probe words. The measurement engine lives in
 * `shardRouteBench.ts`; this file is the jest harness + the gates.
 *
 * The miss detector (§3.2): flat-router fuzz distractors surface as ASKs
 * when the flag is ON (0 confident wrong-shard answers), and the explicit
 * OFF path is bit-identical to the flagless bank.
 *
 * Scale: `SHARD_ROUTE_WORDS_PER_SHARD` (default 1000 words per shard for a
 * fast CI measurement; the full §3.6 measurement at 5000 words/shard runs
 * through `npm run scale-bench -- --route-bench`).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { runShardRouteBench, summarize, type ShardRouteMeasurement } from './shardRouteBench';

const WORDS_PER_SHARD = Number(process.env.SHARD_ROUTE_WORDS_PER_SHARD ?? 1000);
const KS = [4, 8];
const PROBES = Number(process.env.SHARD_ROUTE_PROBES ?? 400);

describe('shard-route-bench (§3.2): routed shards vs the merged single-bank baseline', () => {
  let results: ShardRouteMeasurement[] = [];

  beforeAll(async () => {
    results = await runShardRouteBench({
      wordsPerShard: WORDS_PER_SHARD,
      ks: KS,
      probeCount: PROBES,
      fuzz: true,
      onProgress: (message) => {
        // eslint-disable-next-line no-console
        console.log(message);
      }
    });
  }, 1200000);

  it('reports routing accuracy, in-shard recall, effective recall and latency per K', () => {
    expect(results).toHaveLength(KS.length);
    for (const measurement of results) {
      // eslint-disable-next-line no-console
      console.log(`\n${summarize(measurement).join('\n')}`);
      expect(measurement.probes).toBeGreaterThan(0);
      expect(measurement.routingTop1).toBeGreaterThanOrEqual(0);
      expect(measurement.routingTop1).toBeLessThanOrEqual(1);
      expect(measurement.routingTop2).toBeGreaterThanOrEqual(measurement.routingTop1);
      expect(measurement.routingTop1Primes).toBeGreaterThanOrEqual(0);
      expect(measurement.routingTop1Primes).toBeLessThanOrEqual(1);
      expect(measurement.inShardRecall).toBeGreaterThanOrEqual(0);
      expect(measurement.inShardRecall).toBeLessThanOrEqual(1);
      expect(measurement.effectiveRecall).toBeGreaterThanOrEqual(0);
      expect(measurement.effectiveRecall).toBeLessThanOrEqual(1);
      expect(measurement.shardedAskMs).toBeGreaterThan(0);
      expect(measurement.mergedAskMs).toBeGreaterThan(0);
      // Machinery sanity: each shard's own recall and the merged baseline
      // must work — a collapse in either is a bench defect, not a result.
      expect(measurement.inShardRecall).toBeGreaterThan(0.9);
      expect(measurement.mergedRecall).toBeGreaterThan(0.5);
    }
  });

  it('logs the §3.6 pass/refute verdict (reported, like cde-bench — the experiment records its own answer)', () => {
    // The §3.6 gate: effective recall (routing × in-shard + fallback) vs.
    // the merged single-bank baseline the proposal competes against (94.6%
    // at 20k; here, the baseline measured at the same scale). Both sides
    // are graded over the SAME probes — the words whose traces survive
    // merge consolidation (`effectiveComparableRecall` vs `mergedRecall`).
    // Following the cde-bench pattern the verdict is REPORTED, not
    // hard-gated — a refutation is a recorded scientific result, not a CI
    // failure. The absolute 94.6% comparison is the CLI's full
    // 5000-words-per-shard run.
    for (const measurement of results) {
      const verdict =
        measurement.effectiveComparableRecall >= measurement.mergedRecall - 0.02
          ? 'PASS — effective recall meets the merged baseline at comparable latency'
          : `REFUTE — routing accuracy (top-1 ${(measurement.routingTop1 * 100).toFixed(1)}%) is low enough that effective recall ` +
            `${(measurement.effectiveComparableRecall * 100).toFixed(1)}% falls below merged ${(measurement.mergedRecall * 100).toFixed(1)}% ` +
            `for K=${measurement.k}: interference is not the binding limit for the shard-trainer partition`;
      // eslint-disable-next-line no-console
      console.log(`\n§3.6 VERDICT K=${measurement.k}: ${verdict}`);
      expect(Number.isFinite(measurement.effectiveComparableRecall)).toBe(true);
      expect(measurement.comparableProbes).toBeGreaterThan(0);
    }
  });

  it('the miss detector: 0 confident wrong-shard answers on flat-router fuzz distractors, bit-identical OFF', () => {
    for (const measurement of results) {
      const fuzz = measurement.fuzz;
      expect(fuzz).not.toBeNull();
      // §3.6 pass clause: routing misses surface as asks — the ON bank never
      // answers a flat-router distractor confidently.
      expect(fuzz!.onConfident).toBe(0);
      // The distractors must actually bite the detector-free bank (the OFF
      // bank answers at least one from a wrong shard), or the 0 above is
      // vacuous.
      expect(fuzz!.offConfident).toBeGreaterThan(0);
      // Default-off contract: the explicit-OFF bank is bit-identical to the
      // no-flag bank on every probe.
      expect(fuzz!.offBitIdenticalToFlagless).toBe(true);
    }
  });
});
