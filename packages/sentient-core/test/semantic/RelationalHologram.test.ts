/**
 * RelationalHologram tests — the P1 binding substrate.
 *
 * FHRR (frequency-domain HRR): role–filler pairs bind by element-wise complex
 * multiply, unbind by conjugate multiply, and bundle by sum. These tests pin
 * the exact-inverse property, the crosstalk/capacity curve, chaining, and the
 * graded degradation that replaces hard ASKs.
 */
import { describe, it, expect } from '@jest/globals';
import { RelationalHologram, fnv1a } from '../../src/semantic';

function candidate(object: string, score: number) {
  return { object, score };
}

describe('RelationalHologram', () => {
  it('bind/unbind round-trips exactly (conjugate is the true inverse)', () => {
    const h = new RelationalHologram({ slots: 128 });
    const bird = h.vector('bird');
    const role = h.vector('is-a');
    const bound = RelationalHologram.bind(role, bird);
    const unbound = RelationalHologram.unbind(bound, role);
    expect(RelationalHologram.cosine(unbound, bird)).toBeCloseTo(1, 12);
  });

  it('symbol vectors are unit modulus and deterministic', () => {
    const h = new RelationalHologram({ slots: 64 });
    const a1 = h.vector('apple');
    const a2 = h.vector('apple');
    expect(Array.from(a1)).toEqual(Array.from(a2));
    // Unit modulus per slot: re² + im² = 1.
    for (let k = 0; k < 64; k += 1) {
      expect(a1[2 * k] ** 2 + a1[2 * k + 1] ** 2).toBeCloseTo(1, 10);
    }
    // Different symbols are effectively orthogonal.
    expect(RelationalHologram.cosine(a1, h.vector('water'))).toBeLessThan(0.15);
  });

  it('fnv1a is deterministic and collision-light over symbols', () => {
    const hashes = new Set(['is-a', 'has-part', 'bird', 'robin', 'wings', 'fly'].map((s) => fnv1a(s)));
    expect(hashes.size).toBe(6);
    expect(fnv1a('bird')).toBe(fnv1a('bird'));
  });

  it('cleanup recovers the right filler from a bundled trace', () => {
    const h = new RelationalHologram({ slots: 128 });
    h.setTrace('robin', [
      { predicate: 'is-a', object: 'bird' },
      { predicate: 'has-part', object: 'wings' },
      { predicate: 'capable-of', object: 'fly' }
    ]);
    const top = h.candidates('robin', 'is-a', 3, 0);
    expect(top[0]).toEqual(candidate('bird', top[0].score));
    expect(top[0].score).toBeGreaterThan(0.3);

    const wings = h.candidates('robin', 'has-part', 3, 0);
    expect(wings[0].object).toBe('wings');
    expect(wings[0].score).toBeGreaterThan(0.3);

    // A role the subject holds nothing under returns noise below any sane
    // threshold — scored, not fabricated.
    const madeOf = h.candidates('robin', 'made-of', 3, 0);
    expect(madeOf.length).toBeGreaterThan(0);
    expect(madeOf[0].score).toBeLessThan(0.3);
  });

  it('scoreOf answers the closed form and stays honest when absent', () => {
    const h = new RelationalHologram({ slots: 128 });
    h.setTrace('snow', [
      { predicate: 'has-property', object: 'cold' },
      { predicate: 'has-property', object: 'wet' }
    ]);
    expect(h.scoreOf('snow', 'has-property', 'cold')).toBeGreaterThan(0.35);
    expect(h.scoreOf('snow', 'has-property', 'green')).toBeLessThan(0.3);
    expect(h.scoreOf('untouched', 'has-property', 'cold')).toBe(0);
  });

  it('chaining: unbind the is-a role, clean up the parent, unbind its part', () => {
    const h = new RelationalHologram({ slots: 128 });
    h.setTrace('robin', [
      { predicate: 'is-a', object: 'bird' },
      { predicate: 'capable-of', object: 'sing' }
    ]);
    h.setTrace('bird', [
      { predicate: 'has-part', object: 'wings' },
      { predicate: 'capable-of', object: 'fly' }
    ]);

    // hop 1: robin is-a bird
    const parents = h.candidates('robin', 'is-a', 1, 0.3);
    expect(parents[0].object).toBe('bird');
    // hop 2: bird has-part wings
    const parts = h.candidates('bird', 'has-part', 1, 0.3);
    expect(parts[0].object).toBe('wings');
  });

  it('capacity: cleanup accuracy holds as pairs per subject grow', () => {
    // K=256 supports ~10 bundled pairs before the target dips below 0.25;
    // the correct object must remain top-1 across the range.
    const slots = 256;
    const h = new RelationalHologram({ slots });
    const pairs: Array<{ predicate: string; object: string }> = [];
    for (let i = 0; i < 10; i += 1) pairs.push({ predicate: `role${i}`, object: `obj${i}` });
    for (let n = 1; n <= pairs.length; n += 1) {
      const probe = new RelationalHologram({ slots });
      probe.setTrace('subject', pairs.slice(0, n));
      for (let i = 0; i < n; i += 1) {
        const top = probe.candidates('subject', `role${i}`, 1, 0);
        expect(top[0].object).toBe(`obj${i}`);
      }
    }
  });

  it('clear and re-set rebuild the view (the relation set is the source of truth)', () => {
    const h = new RelationalHologram({ slots: 64 });
    h.setTrace('a', [{ predicate: 'is-a', object: 'b' }]);
    expect(h.traceCount).toBe(1);
    h.clear();
    expect(h.traceCount).toBe(0);
    expect(h.candidates('a', 'is-a', 3)).toEqual([]);
  });

  it('is independent across instances (same seed => same symbol directions)', () => {
    const a = new RelationalHologram({ slots: 64, seed: 7 });
    const b = new RelationalHologram({ slots: 64, seed: 7 });
    expect(Array.from(a.vector('robin'))).toEqual(Array.from(b.vector('robin')));
    const c = new RelationalHologram({ slots: 64, seed: 8 });
    expect(Array.from(a.vector('robin'))).not.toEqual(Array.from(c.vector('robin')));
  });
});
