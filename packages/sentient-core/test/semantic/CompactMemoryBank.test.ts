import { describe, it, expect } from '@jest/globals';
import { CompactMemoryBank, type SerializedTraceData } from '../../src/semantic/CompactMemoryBank';
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
    // No phase data anywhere -> the phase order parameter is honestly 0.
    expect(results[0].holographicScore).toBe(0);
  });

  it('W1: holographicScore is the phase order parameter — matching moments phase-lock, mismatched ones do not', () => {
    const bank = new CompactMemoryBank();
    // Two traces on the SAME primes with different stored phase configurations.
    bank.store('lock-a', orientation(1), [3, 5], { amplitudes: [0.7, 0.7], phases: [1.0, 1.15] });
    bank.store('lock-b', orientation(2), [3, 5], { amplitudes: [0.7, 0.7], phases: [0.4, 2.9] });

    // Cue: lock-a's primes AND its phase configuration — the moments lock.
    const results = bank.recall({ smf: orientation(1), primes: [3, 5], phases: [1.0, 1.15] }, 2);
    const a = results.find((r) => r.trace.content === 'lock-a');
    const b = results.find((r) => r.trace.content === 'lock-b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.holographicScore).toBeGreaterThan(0.95);
    expect(b!.holographicScore).toBeLessThan(0.5);
    expect(a!.score).toBeGreaterThan(b!.score);

    // Same primes, a DIFFERENT phase ensemble: the lock fails.
    const anti = bank.recall({ smf: orientation(1), primes: [3, 5], phases: [3.0, 0.1] }, 2);
    const antiA = anti.find((r) => r.trace.content === 'lock-a');
    expect(antiA!.holographicScore).toBeLessThan(0.5);
    expect(antiA!.holographicScore).toBeLessThan(a!.holographicScore);
  });

  it('W1: a trace without stored phases scores 0 on the phase term — the honest absence', () => {
    const bank = new CompactMemoryBank();
    bank.store('legacy', orientation(1), [3, 5], { amplitudes: [1, 1] });
    const results = bank.recall({ smf: orientation(1), primes: [3, 5], phases: [1.0, 1.15] }, 3);
    expect(results[0].trace.content).toBe('legacy');
    expect(results[0].holographicScore).toBe(0);
  });

  it('W1: the cue side of the phase ensemble is gated by excitation like the store side', () => {
    const bank = new CompactMemoryBank();
    // lock-a stores the moment {3: phase 1.0, 5: phase 1.15} on both primes.
    bank.store('lock-a', orientation(1), [3, 5], { amplitudes: [0.7, 0.7], phases: [1.0, 1.15] });

    // Cue with prime 5 EXCITED (phase matching) and prime 3 QUIESCENT (below
    // the index threshold) with a wildly different phase. The quiescent
    // oscillator's phase is not a reading: it must be excluded, so the
    // ensemble reduces to prime 5's delta 0 and R = 1. Before the gate, the
    // stale prime-3 phase dragged the exact re-cue to ~0.29.
    const gated = bank.recall(
      { smf: orientation(1), primes: [3, 5], phases: [3.0, 1.15], amplitudes: [0, 0.7] },
      1
    )[0];
    expect(gated.holographicScore).toBeGreaterThan(0.95);

    // Same cue WITHOUT the amplitudes falls back to the legacy behavior
    // (the cue treated as excited): the stale prime-3 phase joins the
    // ensemble and drags R to ~0.54.
    const ungated = bank.recall(
      { smf: orientation(1), primes: [3, 5], phases: [3.0, 1.15] },
      1
    )[0];
    expect(ungated.holographicScore).toBeLessThan(0.6);
    expect(ungated.holographicScore).toBeLessThan(gated.holographicScore);
  });

  it('W1: the cue moment coherence gates the SMF term — an incoherent moment trusts its orientation less', () => {
    const bank = new CompactMemoryBank();
    // SMF-matched trace, but the cue only PARTIALLY overlaps its primes
    // (31 shared, 41 not) and carries no phases: the smf-vs-overlap weighting
    // is what differs between an incoherent and a coherent cue moment. The
    // gate is the documented 0.5 + 0.5·coherence on the SMF weight, so the
    // scores are PINNED to the exact blend values — a gate that decayed
    // toward 1 (leaving "deweighted toward half strength" untrue) fails here.
    bank.store('no-phase', orientation(9), [31, 37], { amplitudes: [1, 1] });
    const smf = 1; // identical orientation
    const overlap = 0.5; // 31 shared of 2×2 amplitude norm
    const expected = (coherence: number): number => {
      const gate = 0.5 + 0.5 * coherence;
      return (0.5 * gate * smf + 0.5 * overlap) / (0.5 * gate + 0.5);
    };
    const incoherent = bank.recall({ smf: orientation(9), primes: [31, 41], coherence: 0 }, 3)[0].score;
    const coherent = bank.recall({ smf: orientation(9), primes: [31, 41], coherence: 1 }, 3)[0].score;
    const mid = bank.recall({ smf: orientation(9), primes: [31, 41], coherence: 0.5 }, 3)[0].score;
    expect(incoherent).toBeCloseTo(expected(0), 10);
    expect(coherent).toBeCloseTo(expected(1), 10);
    expect(mid).toBeCloseTo(expected(0.5), 10);
    expect(coherent).toBeGreaterThan(incoherent);
  });

  it('W1: the stored phase configuration survives serialize/restore', () => {
    const bank = new CompactMemoryBank();
    const trace = bank.store('phased', orientation(3), [2, 3, 5], {
      amplitudes: [1, 1, 1],
      phases: [0.5, 1.0, 2.0]
    });
    const data = bank.serializeTrace(trace.id);
    expect(data?.phasePrimes).toEqual([2, 3, 5]);
    expect(data?.phases).toEqual([0.5, 1.0, 2.0]);

    const bank2 = new CompactMemoryBank();
    const restored = bank2.restoreTrace(data!);
    expect(restored?.phasePrimes).toEqual([2, 3, 5]);
    expect(restored?.phases).toEqual([0.5, 1.0, 2.0]);

    const results = bank2.recall({ smf: orientation(3), primes: [2, 3, 5], phases: [0.5, 1.0, 2.0] }, 3);
    expect(results[0].trace.id).toBe(trace.id);
    expect(results[0].holographicScore).toBeGreaterThan(0.95);
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
    trace.strength = 0.42;    trace.accessCount = 5;

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

  it('restores both legacy 16-dim and production 128-dim traces (P3 migration shim)', () => {
    const bank = new CompactMemoryBank();

    // Production sketch: a 128-dim trace round-trips at its own width, and the
    // serialized form is q8-compact (the footprint lever).
    const wide = bank.store(
      'wide',
      SedenionMemoryField.identity({ width: 128 }),
      BASIS.slice(0, 4),
      { amplitudes: [1, 1, 1, 1] }
    );
    const serialized = bank.serializeTrace(wide.id);
    expect(serialized).not.toBeNull();
    expect(serialized!.smf).toHaveLength(128);
    expect(serialized!.smfEncoding).toBe('q8');

    const restored = new CompactMemoryBank();
    restored.restoreTrace(serialized!);
    expect(restored.get(wide.id)?.smf.width).toBe(128);
    expect(restored.get(wide.id)?.smf.toArray()).toHaveLength(128);

    // LEGACY 16-dim float trace (no encoding marker) restores at width 16 —
    // the fromArray max-width rule keeps old persisted data readable.
    const legacy = {
      id: 'legacy',
      content: 'old word',
      smf: new Array(16).fill(0.1),
      primes: [2, 3],
      amplitudes: [1, 1],
      createdAt: 0,
      lastAccessAt: 0,
      accessCount: 1,
      strength: 0.5,
      importance: 0.5,
      consolidated: false,
      smfEntropy: 0.8,
      metadata: {}
    };
    restored.restoreTrace(legacy);
    expect(restored.get('legacy')?.smf.width).toBe(16);

    // A 128-dim query against the 16-dim legacy trace scores via the
    // min-length prefix (the fold-down compare shim) — never a crash.
    const query = SedenionMemoryField.identity({ width: 128 });
    const coherence = query.coherenceWith(restored.get('legacy')!.smf);
    expect(Number.isFinite(coherence)).toBe(true);
  });

  it('restore sanitizes non-finite amplitudes and timestamps instead of leaking NaN', () => {
    const bank = new CompactMemoryBank();
    const base = bank.serializeTrace(
      bank.store('sane', orientation(3), [2, 3, 5], { amplitudes: [1, 1, 1] }).id
    )!;
    const poisoned = {
      ...base,
      id: 'poisoned',
      amplitudes: [0.7, Number.NaN, 1],
      lastAccessAt: Number.NaN,
      createdAt: Number.NaN,
      accessCount: Number.NaN,
      strength: Number.NaN,
      importance: Number.NaN
    } as unknown as SerializedTraceData;
    const restored = bank.restoreTrace(poisoned);
    expect(restored).not.toBeNull();
    expect(restored!.amplitudes[1]).toBe(0); // sanitized, not NaN
    expect(Number.isFinite(restored!.lastAccessAt)).toBe(true);
    expect(Number.isFinite(restored!.strength)).toBe(true);
    expect(Number.isFinite(restored!.importance)).toBe(true);
    expect(restored!.accessCount).toBe(0);

    // Recall on the restored trace must never leak NaN scores.
    const results = bank.recall({ smf: orientation(3), primes: [2, 3, 5], phases: [0.1, 0.2, 0.3] }, 3);
    const hit = results.find((r) => r.trace.id === 'poisoned');
    expect(hit).toBeDefined();
    expect(Number.isFinite(hit!.overlapScore)).toBe(true);
    expect(Number.isFinite(hit!.holographicScore)).toBe(true);
    expect(Number.isFinite(hit!.score)).toBe(true);
  });

  it('clear() drops grade-evidence extras with the traces (P11 map stays bounded)', () => {
    const bank = new CompactMemoryBank();
    const trace = bank.store('x', orientation(3), [2, 3, 5], { amplitudes: [1, 1, 1] });
    bank.bumpUtility(trace.id, 3);
    bank.clear();
    expect(bank.all()).toHaveLength(0);
    // A fresh store of a new trace must not inherit any leftover extra, and
    // the extras map must be empty (observable via serializeTrace: no extra).
    const trace2 = bank.store('y', orientation(3), [2, 3, 5], { amplitudes: [1, 1, 1] });
    expect(bank.serializeTrace(trace2.id)?.utilityExtra).toBeUndefined();
  });
});

describe('utility-based pruning (P11)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('a frequently-retrieved weak trace outlives a never-retrieved strong one', () => {
    const bank = new CompactMemoryBank({ capacity: 10 });
    const retrieved = bank.store('retrieved', orientation(3), [2, 3, 5], { amplitudes: [1, 1, 1] });
    const strong = bank.store('strong', orientation(7), [7, 11, 13], { amplitudes: [1, 1, 1] });
    // 'retrieved' was hit 5 times and reinforced recently, but is weak;
    // 'strong' is strong, never retrieved, and 90 days old.
    retrieved.accessCount = 5;
    retrieved.strength = 0.5;
    retrieved.lastAccessAt = Date.now();
    strong.accessCount = 0;
    strong.strength = 1;
    strong.lastAccessAt = Date.now() - 90 * DAY;

    bank.setCapacity(1); // forces the prune
    expect(bank.get(retrieved.id)).toBeDefined();
    expect(bank.get(strong.id)).toBeUndefined();
  });

  it('grade evidence (bumpUtility) protects a trace from pruning', () => {
    const bank = new CompactMemoryBank({ capacity: 10 });
    const graded = bank.store('graded', orientation(3), [2, 3, 5]);
    const plain = bank.store('plain', orientation(7), [7, 11, 13]);
    // Identical usage, but 'graded' carries grade evidence from correct answers.
    graded.accessCount = 1;
    plain.accessCount = 1;
    bank.bumpUtility(graded.id, 5);

    bank.setCapacity(1);
    expect(bank.get(graded.id)).toBeDefined();
    expect(bank.get(plain.id)).toBeUndefined();
  });

  it('consolidated traces are exempt until every unconsolidated trace is gone', () => {
    const bank = new CompactMemoryBank({ capacity: 10 });
    const locked = bank.store('locked', orientation(3), [2, 3, 5]);
    const fresh = bank.store('fresh', orientation(7), [7, 11, 13]);
    const another = bank.store('another', orientation(9), [17, 19, 23]);
    locked.consolidated = true;
    locked.accessCount = 10;
    locked.lastAccessAt = Date.now() - 60 * DAY;
    another.lastAccessAt = Date.now() - 60 * DAY;

    bank.setCapacity(1);
    // The unconsolidated traces are pruned first; the consolidated survives.
    expect(bank.get(locked.id)).toBeDefined();
    expect(bank.size).toBe(1);

    // Only when EVERY trace is consolidated does capacity force a lock out —
    // a consolidation lock is a floor, not an immortality.
    const secondLock = bank.store('second-lock', orientation(11), [29, 31, 37]);
    secondLock.consolidated = true;
    secondLock.accessCount = 0;
    secondLock.lastAccessAt = Date.now() - 200 * DAY;
    bank.setCapacity(1);
    expect(bank.size).toBe(1);
    expect(bank.get(secondLock.id)).toBeUndefined();
    expect(bank.get(locked.id)).toBeDefined();
  });

  it('the utility extra survives serialize → restore (grade evidence persists)', () => {
    const bank = new CompactMemoryBank();
    const trace = bank.store('word', orientation(3), [2, 3, 5]);
    bank.bumpUtility(trace.id, 3);
    const serialized = bank.serializeTrace(trace.id);
    expect(serialized?.utilityExtra).toBe(3);

    const restored = new CompactMemoryBank({ capacity: 1 });
    restored.restoreTrace(serialized!);
    // The restored extra must feed pruning: two traces at capacity 1, the
    // restored one with the extra survives (the second store forces the prune).
    const second = restored.store('other', orientation(7), [7, 11, 13]);
    second.accessCount = 1;
    const first = restored.get(trace.id)!;
    first.accessCount = 1;
    expect(restored.get(trace.id)).toBeDefined();
    expect(restored.get(second.id)).toBeUndefined();
  });
});
