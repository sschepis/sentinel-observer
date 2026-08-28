import { describe, it, expect } from '@jest/globals';
import { CompactMemoryBank } from '../../src/semantic/CompactMemoryBank';
import { SedenionMemoryField } from '../../src/semantic';

/** A distinct SMF orientation per word (unit vector rotated per index). */
function orientation(index: number): SedenionMemoryField {
  const smf = SedenionMemoryField.identity();
  const a = index % 16;
  const b = (index * 7 + 3) % 16;
  if (a !== 0) smf.set(a, 0.6);
  if (b !== a && b !== 0) smf.set(b, 0.4);
  smf.normalize();
  return smf;
}

const BASIS = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53,
  59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131];

describe('CompactMemoryBank', () => {
  it('stores lean traces and recalls by prime overlap + SMF orientation', () => {
    const bank = new CompactMemoryBank();
    const trace = bank.store('apple: a fruit', orientation(1), BASIS, {
      amplitudes: BASIS.map((_, i) => (i === 1 || i === 2 ? 0.7 : 0.05))
    });
    expect(trace.pattern).toBeNull();
    expect(bank.size).toBe(1);

    const smf = orientation(1);
    const results = bank.recall({ smf, primes: [3, 5] }, 3);
    expect(results).toHaveLength(1);
    expect(results[0].trace.id).toBe(trace.id);
    expect(results[0].overlapScore).toBeGreaterThan(0.8);
    expect(results[0].holographicScore).toBe(0);
  });

  it('prefilters candidates: unrelated traces are never scored', () => {
    const bank = new CompactMemoryBank();
    // Word A excited on primes [3, 5]; word B on [11, 13].
    bank.store('apple', orientation(1), BASIS, {
      amplitudes: BASIS.map((_, i) => (i === 1 || i === 2 ? 0.7 : 0))
    });
    bank.store('water', orientation(2), BASIS, {
      amplitudes: BASIS.map((_, i) => (i === 5 || i === 6 ? 0.7 : 0))
    });

    // Cue [11, 13] must only consider water's trace (the index, not scoring).
    const results = bank.recall({ primes: [11, 13] }, 5);
    expect(results).toHaveLength(1);
    expect(results[0].trace.content).toContain('water');
  });

  it('serialize/restore round-trips lean traces with strength and identity', () => {
    const bank = new CompactMemoryBank();
    const trace = bank.store('book', orientation(3), BASIS, { amplitudes: BASIS.map(() => 0.2) });
    trace.strength = 0.42;
    trace.accessCount = 5;

    const data = bank.serializeTrace(trace.id);
    expect(data).not.toBeNull();
    expect(data!.id).toBe(trace.id);

    const bank2 = new CompactMemoryBank();
    const restored = bank2.restoreTrace(data!);
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(trace.id);
    expect(restored!.strength).toBeCloseTo(0.42, 10);
    expect(restored!.accessCount).toBe(5);

    const results = bank2.recall({ smf: orientation(3), primes: [2] }, 3);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('never overwrites a live trace on restore', () => {
    const bank = new CompactMemoryBank();
    const trace = bank.store('house', orientation(4), BASIS);
    const data = bank.serializeTrace(trace.id);
    expect(bank.restoreTrace(data!)).toBeNull();
  });

  it('consolidates after repeated reinforcement and prunes the weak', () => {
    const bank = new CompactMemoryBank({ capacity: 3 });
    const strong = bank.store('learn', orientation(5), BASIS);
    const weak = bank.store('forget', orientation(6), BASIS);
    bank.store('speak', orientation(7), BASIS);

    // Reinforce 'learn' three times -> consolidated.
    for (let i = 0; i < 3; i++) {
      bank.recall({ smf: orientation(5), primes: [2] }, 3);
    }
    expect(strong.consolidated).toBe(true);

    // 'forget' was never the target of practice: reset it to a genuinely
    // unreinforced, weak trace, then exceed capacity.
    weak.accessCount = 0;
    weak.consolidated = false;
    weak.strength = 0.1;
    bank.store('extra', orientation(8), BASIS);
    expect(bank.size).toBeLessThanOrEqual(3);
    expect(bank.get(weak.id)).toBeUndefined();
  });
});
