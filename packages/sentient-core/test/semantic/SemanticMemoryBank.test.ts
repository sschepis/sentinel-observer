/**
 * SemanticMemoryBank tests.
 *
 * Regression coverage for two legacy defects in lib/sentient-memory.js:
 *   - the entropy lock that could never fire (entropy hardwired to 1.0 against
 *     a 0.8 threshold => getLockedMemories() always empty), and
 *   - prune() double-counting weak removals and over-deleting.
 */
import { describe, it, expect } from '@jest/globals';
import { SemanticMemoryBank, SedenionMemoryField } from '../../src/semantic';

const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19];

function makeBank(options: ConstructorParameters<typeof SemanticMemoryBank>[0] = {}) {
  return new SemanticMemoryBank({ gridSize: 32, primes: PRIMES, capacity: 8, ...options });
}

/** Local trial-division prime list (the module under test must stay ESM-free). */
function firstPrimes(count: number): number[] {
  const primes: number[] = [];
  for (let candidate = 2; primes.length < count; candidate++) {
    let isPrime = true;
    for (let d = 2; d * d <= candidate; d++) {
      if (candidate % d === 0) {
        isPrime = false;
        break;
      }
    }
    if (isPrime) primes.push(candidate);
  }
  return primes;
}

describe('SemanticMemoryBank', () => {
  it('stores traces with SMF signatures and holographic patterns', () => {
    const bank = makeBank();
    const smf = SedenionMemoryField.fromAxis(4, 1);
    smf.normalize();

    const trace = bank.store('remember this', smf, [2, 3, 5], { amplitudes: [1, 0.5, 0.25] });

    expect(trace.id).toBeTruthy();
    expect(trace.content).toBe('remember this');
    expect(trace.consolidated).toBe(false);
    expect(trace.accessCount).toBe(0);
    expect(trace.strength).toBe(1);
    expect(bank.size).toBe(1);

    // The stored SMF is a snapshot: mutating the caller's field must not
    // rewrite stored memory.
    smf.set(4, 999);
    expect(bank.get(trace.id)!.smf.get(4)).toBe(1);
  });

  it('recalls by SMF cosine similarity with the right ranking', () => {
    const bank = makeBank();

    const target = SedenionMemoryField.fromAxis(4, 1);
    target.normalize();
    const orthogonal = SedenionMemoryField.fromAxis(7, 1);
    orthogonal.normalize();

    bank.store('the target', target, [2, 3], { importance: 0.5 });
    bank.store('the decoy', orthogonal, [2, 3], { importance: 0.5 });

    const hits = bank.recall({ smf: target.clone() }, 2);
    expect(hits).toHaveLength(2);

    const [best] = hits;
    expect(best.trace.content).toBe('the target');
    expect(best.smfScore).toBeCloseTo(1, 10);
    expect(best.score).toBeGreaterThan(hits[1].score);
    expect(Number.isFinite(best.score)).toBe(true);
  });

  it('recalls by holographic correlation from prime cues', () => {
    const bank = makeBank();
    bank.store('primes a', SedenionMemoryField.identity(), [2, 3, 5], { amplitudes: [1, 0.5, 0.25] });
    bank.store('primes b', SedenionMemoryField.identity(), [11, 13], { amplitudes: [1, 1] });

    const hits = bank.recall({ primes: [2, 3, 5], amplitudes: [1, 0.5, 0.25] }, 2);
    expect(hits[0].trace.content).toBe('primes a');
    expect(hits[0].holographicScore).toBeCloseTo(1, 10);
    expect(hits[1].holographicScore).toBeCloseTo(0, 10);
  });

  it('builds each pattern with the TRACE primes as its basis (beyond the default 16)', () => {
    // No construction-time primes: the bank must build the per-trace basis
    // from the primes actually encoded, so nothing is silently dropped.
    const bank = new SemanticMemoryBank({ gridSize: 64 });
    const wide = firstPrimes(32);

    const trace = bank.store('wide trace', SedenionMemoryField.identity(), wide, {
      amplitudes: wide.map(() => 1)
    });
    expect(trace.pattern.primes).toHaveLength(32);

    const hits = bank.recall({ primes: wide, amplitudes: wide.map(() => 1) }, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].trace.id).toBe(trace.id);
    expect(hits[0].holographicScore).toBeCloseTo(1, 6);
  });

  it('combines SMF and holographic scores when both cues are given', () => {
    const bank = makeBank();
    const smfA = SedenionMemoryField.fromAxis(4, 1);
    smfA.normalize();
    bank.store('match', smfA, [2, 3], { amplitudes: [1, 1] });
    bank.store('mismatch', SedenionMemoryField.fromAxis(9, 1), [11, 13], { amplitudes: [1, 1] });

    const hits = bank.recall({ smf: smfA.clone(), primes: [2, 3], amplitudes: [1, 1] }, 2);
    expect(hits[0].trace.content).toBe('match');
    expect(hits[0].smfScore).toBeGreaterThan(0.9);
    expect(hits[0].holographicScore).toBeGreaterThan(0.9);
    expect(hits[1].score).toBeLessThan(hits[0].score);
  });

  it('rejects a query with no cue', () => {
    const bank = makeBank();
    expect(() => bank.recall({}, 5)).toThrow();
  });

  it('rejects a weight configuration that would zero every recall score', () => {
    expect(() => makeBank({ smfWeight: 0, holographicWeight: 0 })).toThrow(/weight/i);
    // A single nonzero weight is a valid configuration.
    expect(() => makeBank({ smfWeight: 1, holographicWeight: 0 })).not.toThrow();
    expect(() => makeBank({ smfWeight: 0, holographicWeight: 1 })).not.toThrow();
  });

  it('store with an empty prime list throws instead of writing a hollow trace', () => {
    const bank = makeBank();
    expect(() => bank.store('no primes', SedenionMemoryField.identity(), [])).toThrow(/prime/i);
    expect(bank.size).toBe(0);
  });

  it('registers accesses and reinforces recalled traces', () => {
    const bank = makeBank();
    const smf = SedenionMemoryField.fromAxis(2, 1);
    smf.normalize();
    const trace = bank.store('reinforced', smf, [2]);

    bank.recall({ smf: smf.clone() }, 1);
    const refreshed = bank.get(trace.id)!;
    expect(refreshed.accessCount).toBe(1);
    expect(refreshed.strength).toBeGreaterThan(1 - 1e-12);
  });

  it('consolidation fires: high access + low entropy locks a trace (legacy never locked)', () => {
    const bank = makeBank({ minAccessCount: 2, entropyLockThreshold: 0.75, minLockStrength: 0.5 });

    // A sharply-oriented SMF has normalized entropy far below the threshold.
    const focused = SedenionMemoryField.fromAxis(4, 1);
    focused.normalize();

    const trace = bank.store('sharp memory', focused, [2]);

    // First access: below minAccessCount, nothing locks yet.
    bank.recall({ smf: focused.clone() }, 1);
    expect(bank.get(trace.id)!.consolidated).toBe(false);

    // Subsequent accesses push the access count over the threshold.
    bank.recall({ smf: focused.clone() }, 1);
    bank.recall({ smf: focused.clone() }, 1);

    const locked = bank.get(trace.id)!;
    expect(locked.consolidated).toBe(true);
    expect(locked.smfEntropy).toBeLessThanOrEqual(0.75);
    expect(bank.consolidated()).toHaveLength(1);
    expect(bank.stats().consolidatedCount).toBe(1);
  });

  it('high-entropy traces do NOT consolidate', () => {
    const bank = makeBank({ minAccessCount: 1, entropyLockThreshold: 0.2 });

    // 16 equal axes: maximal entropy (~4 bits -> normalized ~1.0).
    const noisy = SedenionMemoryField.fromArray(new Array(16).fill(1));
    noisy.normalize();
    expect(noisy.normalizedEntropy()).toBeGreaterThan(0.9);

    const trace = bank.store('noisy memory', noisy, [2]);
    bank.recall({ smf: noisy.clone() }, 1);
    bank.recall({ smf: noisy.clone() }, 1);

    expect(bank.get(trace.id)!.consolidated).toBe(false);
    expect(bank.stats().consolidatedCount).toBe(0);
  });

  it('prune removes exactly the overflow and never double-counts weak traces', () => {
    // Capacity is high enough that store() never auto-prunes: the weak set is
    // fully formed (with mutated strength) before prune() runs once.
    const bank = makeBank({ capacity: 16, minStrength: 0.25, importanceFloor: 0.7 });

    for (let i = 0; i < 2; i++) {
      const weak = bank.store(`weak-${i}`, SedenionMemoryField.fromAxis(i, 1), [2], {
        importance: 0.1
      });
      weak.strength = 0.1;
    }
    for (let i = 0; i < 3; i++) {
      bank.store(`strong-${i}`, SedenionMemoryField.fromAxis(5 + i, 1), [2], {
        importance: 0.9
      });
    }

    // Narrow capacity: size 5 -> capacity 3 means exactly 2 removals,
    // both from the weak set - never a double-count.
    bank.setCapacity(3);
    expect(bank.size).toBe(3);
    expect(bank.all().every(t => t.content.startsWith('strong'))).toBe(true);
    expect(bank.stats().prunedCount).toBe(2);
  });

  it('prune protects consolidated traces and over-capacity overflow is exact', () => {
    const bank = makeBank({ capacity: 16 });
    const focused = SedenionMemoryField.fromAxis(3, 1);
    focused.normalize();

    const keep = bank.store('consolidated', focused, [2], { importance: 0.1 });
    keep.strength = 0.05; // weak by strength AND importance...
    keep.consolidated = true; // ...but consolidated: pruneproof

    for (let i = 0; i < 5; i++) {
      const trace = bank.store(`filler-${i}`, SedenionMemoryField.fromAxis(6 + i, 1), [2], {
        importance: 0.8
      });
      trace.strength = 0.5;
    }

    bank.setCapacity(4);
    expect(bank.size).toBe(4); // 6 -> 4: exactly 2 removals
    expect(bank.get(keep.id)).toBeDefined();
    expect(bank.stats().prunedCount).toBe(2);
  });

  it('decay weakens only unconsolidated traces', () => {
    const bank = makeBank();
    const focused = SedenionMemoryField.fromAxis(1, 1);
    focused.normalize();
    const locked = bank.store('locked', focused, [2]);
    locked.consolidated = true;
    locked.strength = 0.9;

    const loose = bank.store('loose', SedenionMemoryField.fromAxis(8, 1), [2]);
    loose.strength = 0.9;

    bank.decay(0.5);
    expect(bank.get(locked.id)!.strength).toBeCloseTo(0.9, 12);
    expect(bank.get(loose.id)!.strength).toBeCloseTo(0.45, 12);
  });

  it('stats are internally consistent', () => {
    const bank = makeBank();
    bank.store('a', SedenionMemoryField.identity(), [2]);
    bank.recall({ smf: SedenionMemoryField.identity() }, 1);
    const stats = bank.stats();

    expect(stats.traceCount).toBe(bank.size);
    expect(stats.storeCount).toBe(1);
    expect(stats.recallCount).toBe(1);
    expect(stats.capacity).toBe(8);
    expect(stats.averageStrength).toBeGreaterThan(0);
    expect(stats.averageImportance).toBeGreaterThan(0);
    expect(Number.isFinite(stats.averageSmfEntropy)).toBe(true);
  });

  it('clear empties the bank', () => {
    const bank = makeBank();
    bank.store('a', SedenionMemoryField.identity(), [2]);
    bank.clear();
    expect(bank.size).toBe(0);
    expect(bank.recall({ smf: SedenionMemoryField.identity() }, 5)).toEqual([]);
  });
});
