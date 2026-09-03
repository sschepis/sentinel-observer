import { describe, expect, test } from '@jest/globals';
import { COMPOSITION_RULES } from '../composition';
import type { RelationPredicate } from '../relations';
import { CompositionRuleStore, COMPOSITION_ADMISSION_CAP } from './compositionSeeds';

const seq = (...hops: RelationPredicate[]): RelationPredicate[] => hops;

describe('composition seeds — the table stays the evergreen floor', () => {
  test('rules() is the seed table before any observation', () => {
    const store = new CompositionRuleStore();
    expect(store.rules().length).toBe(COMPOSITION_RULES.length);
    expect(store.admitted().length).toBe(0);
    for (const rule of store.rules()) {
      expect(COMPOSITION_RULES.some((seed) => seed.hops.join('>') === rule.hops.join('>'))).toBe(true);
    }
  });

  test('seed observations feed the acceptance baseline, never admission', () => {
    const store = new CompositionRuleStore();
    store.observe(seq('is-a', 'has-part'), true);
    store.observe(seq('is-a', 'has-part'), true);
    expect(store.acceptanceBaseline()).toBe(1);
    expect(store.admitted().length).toBe(0);
  });
});

describe('composition seeds — admission gates', () => {
  test('a sequence the world accepts is admitted after minimal evidence', () => {
    const store = new CompositionRuleStore();
    const sequence = seq('has-part', 'made-of');
    for (let i = 0; i < 5; i += 1) store.observe(sequence, true);
    const admitted = store.admitted();
    expect(admitted.length).toBe(1);
    expect(admitted[0].hops).toEqual(sequence);
    expect(admitted[0].conclusion).toBe('made-of');
    expect(store.rules().length).toBe(COMPOSITION_RULES.length + 1);
  });

  test('a sequence the world keeps rejecting is never admitted', () => {
    const store = new CompositionRuleStore();
    const sequence = seq('capable-of', 'has-part');
    for (let i = 0; i < 6; i += 1) store.observe(sequence, false);
    expect(store.admitted().length).toBe(0);
  });

  test('evidence below the floor is never enough, even when accepted', () => {
    const store = new CompositionRuleStore();
    store.observe(seq('made-of', 'is-a'), true);
    store.observe(seq('made-of', 'is-a'), true);
    expect(store.admitted().length).toBe(0);
  });

  test('repeated identical observations are counted per graded answer (distinct uses)', () => {
    const store = new CompositionRuleStore();
    const sequence = seq('located-in', 'is-a');
    for (let i = 0; i < 12; i += 1) {
      store.observe(sequence, true);
    }
    const audit = store.audit().find((entry) => entry.hops.join('>') === sequence.join('>'));
    expect(audit?.uses).toBe(12);
  });

  test('admission is capped; a strictly better rule displaces the weakest', () => {
    const store = new CompositionRuleStore();
    // Fill the cap with weakly-accepted sequences (2/3 = 0.67 rate).
    for (let i = 0; i < COMPOSITION_ADMISSION_CAP + 2; i += 1) {
      const sequence = seq(`p${i}` as RelationPredicate, 'is-a') as [RelationPredicate, RelationPredicate];
      store.observe(sequence, true);
      store.observe(sequence, true);
      store.observe(sequence, false);
    }
    expect(store.admitted().length).toBeLessThanOrEqual(COMPOSITION_ADMISSION_CAP);
    // A perfectly accepted sequence (rate 1.0) displaces a weak one.
    const better = seq('is-a', 'located-in', 'is-a');
    for (let i = 0; i < 6; i += 1) {
      store.observe(better, true);
    }
    expect(store.admitted().length).toBeLessThanOrEqual(COMPOSITION_ADMISSION_CAP);
    const betterEntry = store.audit().find((entry) => entry.hops.join('>') === better.join('>'));
    expect(betterEntry?.admitted).toBe(true);
  });

  test('single-hop sequences are never candidates', () => {
    const store = new CompositionRuleStore();
    store.observe(seq('is-a'), true);
    expect(store.audit().length).toBe(0);
  });

  test('audit reports uses, acceptance, and admission', () => {
    const store = new CompositionRuleStore();
    store.observe(seq('capable-of', 'used-for'), true);
    store.observe(seq('capable-of', 'used-for'), false);
    const entry = store.audit()[0];
    expect(entry.uses).toBe(2);
    expect(entry.accepted).toBe(1);
    expect(entry.admitted).toBe(false);
  });
});
