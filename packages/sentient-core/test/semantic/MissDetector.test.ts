/**
 * @jest-environment node
 */
/**
 * §3.2 MISS DETECTOR — a flat router distribution (small top-two margin m,
 * small m₂₃ over `routeScores`) means the router does not know where the
 * cue lives, so the observer must ASK, never answer confidently from a
 * wrong shard. Wired behind `ShardedMemoryBankOptions.missDetector`,
 * DEFAULT OFF: the disabled path must be bit-identical to the flagless
 * bank.
 */
import { describe, it, expect } from '@jest/globals';
import { ShardedMemoryBank } from '../../src/semantic/ShardedMemoryBank';
import { SedenionMemoryField } from '../../src/semantic/SedenionMemoryField';
import type { RecallQuery } from '../../src/semantic/CompactMemoryBank';

/** Three shard families on distinct SMF axes (the sketch projection puts a
 *  ~0.5 similarity floor between distinct axes; the prototypes still
 *  separate). Primes are unique per family so vocabulary-overlap routes
 *  also discriminate. */
const FAMILIES = {
  morning: { primes: [1, 2, 3], axis: 1 },
  evening: { primes: [1, 2, 4], axis: 1 },
  night: { primes: [1, 2, 5], axis: 1 },
  bird: { primes: [7, 8, 9], axis: 2 },
  robin: { primes: [7, 8, 10], axis: 2 },
  apple: { primes: [11, 12, 13], axis: 3 },
  pear: { primes: [11, 12, 14], axis: 3 }
} as const;

const SHARD_FAMILIES: ReadonlyArray<ReadonlyArray<keyof typeof FAMILIES>> = [
  ['morning', 'evening', 'night'],
  ['bird', 'robin'],
  ['apple', 'pear']
];

/** An SMF orientation on a pure axis (unit-normalized). */
function onAxis(axis: number): SedenionMemoryField {
  const smf = SedenionMemoryField.identity({ width: 16 });
  smf.set(axis, 1);
  smf.normalize();
  return smf;
}

/** A uniform mixture of the given axes (unit-normalized). */
function onAxes(axes: readonly number[]): SedenionMemoryField {
  const smf = SedenionMemoryField.identity({ width: 16 });
  for (const axis of axes) smf.set(axis, 1);
  smf.normalize();
  return smf;
}

/** Seed `SHARD_FAMILIES.length` shards and restore one family per shard
 *  (the externally partitioned bank of the §3.2 bench). */
function seededBank(missDetector?: boolean): ShardedMemoryBank {
  const bank = new ShardedMemoryBank({ missDetector });
  bank.seedShards(SHARD_FAMILIES.length);
  for (let shardIndex = 0; shardIndex < SHARD_FAMILIES.length; shardIndex += 1) {
    for (const family of SHARD_FAMILIES[shardIndex]) {
      const scratch = new ShardedMemoryBank();
      const trace = scratch.store(`family-${family}`, onAxis(FAMILIES[family].axis), FAMILIES[family].primes, {
        metadata: { kind: 'word', family }
      });
      const data = scratch.serializeTrace(trace.id);
      expect(data).not.toBeNull();
      expect(bank.restoreTrace(data!, shardIndex)).not.toBeNull();
    }
  }
  return bank;
}

describe('miss detector (§3.2): flat router distribution -> ASK', () => {
  it('defaults OFF and is bit-identical to the flagless bank on every query', () => {
    const flagless = seededBank();
    const explicitOff = seededBank(false);
    expect(explicitOff.shardAudit().length).toBe(flagless.shardAudit().length);

    // A battery that covers every routing regime: clear (single-family
    // sketch), disambiguate (tied top two), flat (three-way tie), and the
    // prime-only overlap routes (including a three-way overlap tie). Traces
    // are per-bank objects (fresh ids), so identity compares content+score.
    const queries: RecallQuery[] = [
      { smf: onAxis(1), primes: [1, 2, 3] },
      { smf: onAxis(2), primes: [7, 8, 9] },
      { smf: onAxis(3), primes: [11, 12, 13] },
      { smf: onAxes([1, 2]), primes: [1, 7] },
      { smf: onAxes([1, 2, 3]), primes: [1, 7, 11] },
      { primes: [1, 2, 3] },
      { primes: [7, 8, 9] },
      { primes: [11, 12, 13] },
      { primes: [1, 7, 11] },
      { primes: [2, 8, 12] },
      { smf: onAxis(1), primes: [] }
    ];
    for (const query of queries) {
      const a = flagless.recall(query, 5);
      const b = explicitOff.recall(query, 5);
      expect(b.map((r) => ({ content: r.trace.content, score: r.score }))).toEqual(
        a.map((r) => ({ content: r.trace.content, score: r.score }))
      );
    }
    expect(flagless.missDetectorAsks).toBe(0);
    expect(explicitOff.missDetectorAsks).toBe(0);
  });

  it('a flat router distribution surfaces as an ASK when ON (0 confident wrong-shard answers)', () => {
    const on = seededBank(true);
    const off = seededBank(false);

    // Fuzz distractors: cues that hit every shard's vocabulary EQUALLY (the
    // router's prime-overlap route is a three-way tie — flat) or whose
    // sketch sits equidistant from all three prototypes. The true answer is
    // "none of these" — any recall result is a wrong-shard answer.
    const flatDistractors: RecallQuery[] = [
      { primes: [1, 7, 11] },
      { primes: [2, 8, 12] },
      { primes: [3, 9, 13] },
      { primes: [5, 10, 14] },
      { smf: onAxes([1, 2, 3]), primes: [1, 7, 11] }
    ];
    let offConfident = 0;
    let onConfident = 0;
    for (const distractor of flatDistractors) {
      const offAnswer = off.recall(distractor, 5);
      const onAnswer = on.recall(distractor, 5);
      if (offAnswer.length > 0) offConfident += 1;
      if (onAnswer.length > 0) onConfident += 1;
      // ON: a flat router never yields a confident answer — it asks.
      expect(onAnswer).toEqual([]);
    }
    // The distractors must actually bite the detector-free bank: without the
    // detector the guessed shard answers at least one of them.
    expect(offConfident).toBeGreaterThan(0);
    expect(onConfident).toBe(0);
    expect(on.missDetectorAsks).toBe(flatDistractors.length);
    expect(off.missDetectorAsks).toBe(0);
  });

  it('clear and disambiguate regimes still answer when ON (only flat asks)', () => {
    const on = seededBank(true);
    const asksBefore = on.missDetectorAsks;

    // Clear: the cue's sketch matches one shard's prototype decisively.
    const clear = on.recall({ smf: onAxis(2), primes: [7, 8, 9] }, 5);
    expect(clear.length).toBeGreaterThan(0);
    expect(on.missDetectorAsks).toBe(asksBefore);

    // Disambiguate: top two shards tie, both far above the third (m ~ 0,
    // m₂₃ ~ 1) — NOT flat; the top route plus runner-up fallback answer.
    const two = on.recall({ smf: onAxes([1, 2]), primes: [1, 7] }, 5);
    expect(two.length).toBeGreaterThan(0);
    expect(on.missDetectorAsks).toBe(asksBefore);

    // The single-shard bank can never be flat (nothing to route against).
    const single = new ShardedMemoryBank({ missDetector: true });
    single.store('only', onAxis(1), [1, 2, 3]);
    expect(single.recall({ smf: onAxis(1), primes: [1, 2, 3] }, 5).length).toBeGreaterThan(0);
    expect(single.missDetectorAsks).toBe(0);
  });
});

describe('seeded externally partitioned bank (§3.2 instrumentation)', () => {
  it('recallIn reads only the named shard (the in-shard recall term)', () => {
    const bank = seededBank();
    const morning = bank.recallIn(0, { primes: [1, 2, 3] }, 5);
    expect(morning.length).toBeGreaterThan(0);
    expect(morning[0].trace.content).toBe('family-morning');
    // The bird cue inside the greetings shard finds nothing there (its
    // vocabulary does not carry bird primes) — routing is the router's job.
    expect(bank.recallIn(0, { primes: [7, 8, 9] }, 5)).toEqual([]);
    // Out-of-range shard indices are an honest empty, not a throw.
    expect(bank.recallIn(-1, { primes: [1, 2, 3] })).toEqual([]);
    expect(bank.recallIn(9, { primes: [1, 2, 3] })).toEqual([]);
  });

  it('seedShards keeps the external partition: store() and maintain() never re-partition it', () => {
    const bank = seededBank();
    const sizeBefore = bank.size;
    // 48 stores would normally trigger an amortized split/merge attempt.
    for (let i = 0; i < 48; i += 1) {
      bank.store(`extra-${i}`, onAxis(3), [20 + i, 21 + i], { metadata: { kind: 'word' } });
    }
    expect(bank.maintain()).toEqual({ split: false, merged: false });
    expect(bank.size).toBe(sizeBefore + 48);
    expect(bank.shardAudit().length).toBe(SHARD_FAMILIES.length);
    const reorg = bank.reorganize();
    expect(reorg.shards).toBe(SHARD_FAMILIES.length);
    expect(reorg.entropyAfter).toBe(reorg.entropyBefore);
  });

  it('seedShards refuses a non-empty bank', () => {
    const bank = seededBank();
    expect(() => bank.seedShards(2)).toThrow(/empty bank/);
  });
});
