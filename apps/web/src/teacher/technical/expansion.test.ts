/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  TECHNICAL_CONCEPTS,
  GENERATORS,
  auditTechnicalCurriculum,
  generateExercises,
  verify,
  chanceLevel
} from './index';

/** Every drill this expansion introduced, across all four touched strands. */
const NEW_DRILLS: readonly string[] = [
  // geometry
  'perimeter-rectangle',
  'triangle-angle-sum',
  'complementary-angle',
  'supplementary-angle',
  'circle-diameter',
  // logic
  'logic-and',
  'logic-or',
  'logic-if',
  'syllogism',
  'logic-not',
  // grammar
  'pluralize',
  'past-tense',
  'vowel-count',
  // applied arithmetic and measurement
  'word-problem-add',
  'word-problem-mul',
  'elapsed-time',
  'money-total',
  'solve-x-add',
  'solve-x-mul',
  'sequence-next'
];

/** The new drills whose answer space is two options. */
const NEW_BINARY_DRILLS: readonly string[] = [
  'logic-and',
  'logic-or',
  'logic-if',
  'syllogism',
  'logic-not'
];

describe('the expanded curriculum stays well formed', () => {
  it('audits clean with the geometry, logic, and grammar strands included', () => {
    const audit = auditTechnicalCurriculum();
    expect(audit.missing).toEqual([]);
    expect(audit.duplicates).toEqual([]);
    expect(audit.cycle).toEqual([]);
    expect(audit.valid).toBe(true);
  });

  it('reaches useful depth in each new strand', () => {
    const byStrand = new Map<string, number>();
    for (const concept of TECHNICAL_CONCEPTS) {
      byStrand.set(concept.strand, (byStrand.get(concept.strand) ?? 0) + 1);
    }
    expect(byStrand.get('geometry') ?? 0).toBeGreaterThanOrEqual(35);
    expect(byStrand.get('logic') ?? 0).toBeGreaterThanOrEqual(20);
    expect(byStrand.get('grammar') ?? 0).toBeGreaterThanOrEqual(25);
  });

  it('attaches every new drill to exactly one declared concept', () => {
    const declared = new Map<string, string[]>();
    for (const concept of TECHNICAL_CONCEPTS) {
      if (concept.drill === undefined) continue;
      const owners = declared.get(concept.drill) ?? [];
      owners.push(concept.word);
      declared.set(concept.drill, owners);
    }
    for (const drill of NEW_DRILLS) {
      // Exactly one owner: the drill runner looks a concept up by its drill
      // key, so a NEW key shared by two concepts would be ambiguous. (Some
      // pre-existing keys are intentionally shared — convert-length drills
      // both centimeter and unit conversion — so only the new keys are held
      // to this.)
      expect(declared.get(drill) ?? []).toHaveLength(1);
    }
  });
});

describe('the new generators', () => {
  for (const drill of NEW_DRILLS) {
    it(`${drill} exists, varies, and marks its own answer correct`, () => {
      expect(GENERATORS[drill]).toBeDefined();
      const exercises = generateExercises(drill, drill, { count: 20, seed: 7 });
      // The question space must be real: at least half the request must be
      // fillable with DISTINCT prompts, or a train/test split is impossible.
      expect(exercises.length).toBeGreaterThanOrEqual(10);
      const prompts = new Set(exercises.map((e) => e.prompt));
      expect(prompts.size).toBe(exercises.length);
      for (const exercise of exercises) {
        // The canonical answer echoed verbatim must verify — for textual
        // binary answers this also proves 'true' never trips the
        // both-alternatives rule.
        expect(verify(exercise, exercise.answer).correct).toBe(true);
      }
    });
  }

  it('is deterministic for a given seed', () => {
    for (const drill of NEW_DRILLS) {
      const a = generateExercises(drill, drill, { count: 10, seed: 21 });
      const b = generateExercises(drill, drill, { count: 10, seed: 21 });
      expect(a).toEqual(b);
    }
  });
});

describe('chance levels for the new drills', () => {
  it('puts every yes/no and true/false drill at a coin flip', () => {
    for (const drill of NEW_BINARY_DRILLS) {
      expect(chanceLevel(drill)).toBe(0.5);
    }
  });

  it('keeps open-answer drills near zero', () => {
    for (const drill of NEW_DRILLS) {
      if (NEW_BINARY_DRILLS.includes(drill)) continue;
      expect(chanceLevel(drill)).toBeLessThan(0.5);
    }
  });
});
