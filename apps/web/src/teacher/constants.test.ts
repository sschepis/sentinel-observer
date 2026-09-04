import { describe, test, expect } from '@jest/globals';
import {
  assertAllAnchored,
  assertProgrammaticAnchor,
  CONSTANTS,
  constantsByClass,
  PROGRAMMATIC_BENCHES,
  tuningConstants,
  exportTunedConstants,
  readConstantsExport,
  driftAgainst,
  type ConstantClass
} from './constants';

const VALID_CLASSES: readonly ConstantClass[] = ['values', 'safety', 'tuning'];

describe('constants taxonomy registry', () => {
  test('the registry is non-empty', () => {
    expect(CONSTANTS.length).toBeGreaterThan(0);
  });

  test('every entry has a valid class and a finite value', () => {
    for (const entry of CONSTANTS) {
      expect(VALID_CLASSES).toContain(entry.class);
      expect(Number.isFinite(entry.value)).toBe(true);
      expect(entry.name.length).toBeGreaterThan(0);
    }
  });

  test('every entry is unique by name', () => {
    const names = CONSTANTS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('values and safety constants are never marked tunable', () => {
    for (const entry of constantsByClass('values').concat(constantsByClass('safety'))) {
      expect(entry.evidence).toBeUndefined();
    }
  });

  test('every tuning constant carries evidence and passes the programmatic anchor guard', () => {
    expect(tuningConstants().length).toBeGreaterThan(0);
    for (const entry of tuningConstants()) {
      expect(entry.evidence).toBeDefined();
      expect(entry.evidence!.sources.length).toBeGreaterThan(0);
      expect(() => assertProgrammaticAnchor(entry.evidence!)).not.toThrow();
    }
    expect(() => assertAllAnchored()).not.toThrow();
  });

  test('PROGRAMMATIC_BENCHES are exactly the four §5.4 anchors', () => {
    expect([...PROGRAMMATIC_BENCHES].sort()).toEqual(['adversarial', 'chain', 'fuzz', 'math']);
  });
});

describe('D.10 circularity guard', () => {
  test('a gate whose only evidence is LLM grades is refused', () => {
    expect(() =>
      assertProgrammaticAnchor({ sources: ['llm-grade'], mass: 100, note: 'graded only' })
    ).toThrow(/programmatic bench/);
  });

  test('a gate whose evidence is LLM grades plus calibration is still refused', () => {
    expect(() =>
      assertProgrammaticAnchor({ sources: ['llm-grade', 'calibration'], mass: 100, note: 'no anchor' })
    ).toThrow(/programmatic bench/);
  });

  test('a gate with no evidence is refused', () => {
    expect(() => assertProgrammaticAnchor({ sources: [], mass: 0, note: 'empty' })).toThrow(
      /programmatic bench/
    );
  });

  test('a gate with a programmatic bench passes', () => {
    expect(() => assertProgrammaticAnchor({ sources: ['fuzz'], mass: 100, note: 'anchored' })).not.toThrow();
    expect(() =>
      assertProgrammaticAnchor({ sources: ['llm-grade', 'math'], mass: 100, note: 'anchored' })
    ).not.toThrow();
  });
});

describe('export and drift', () => {
  test('exportTunedConstants snapshots every tuning constant', () => {
    const snapshot = exportTunedConstants(new Date('2026-01-01T00:00:00Z'));
    expect(snapshot.version).toBe(1);
    expect(snapshot.tuned).toHaveLength(tuningConstants().length);
    for (const entry of tuningConstants()) {
      expect(snapshot.tuned.find((t) => t.name === entry.name)).toBeDefined();
    }
  });

  test('readConstantsExport tolerates bare and bootstrap-record shapes', () => {
    const snapshot = exportTunedConstants(new Date('2026-01-01T00:00:00Z'));
    expect(readConstantsExport({ constantsExport: snapshot })).toEqual(snapshot);
    expect(readConstantsExport({ learningState: { constantsExport: snapshot } })).toEqual(snapshot);
    expect(readConstantsExport({ learningState: {} })).toBeNull();
    expect(readConstantsExport(null)).toBeNull();
  });

  test('driftAgainst reports null drift for constants absent from the snapshot', () => {
    const empty = exportTunedConstants(new Date('2026-01-01T00:00:00Z'));
    empty.tuned = [];
    const drift = driftAgainst(empty);
    expect(drift).toHaveLength(tuningConstants().length);
    for (const entry of drift) {
      expect(entry.exported).toBeNull();
      expect(entry.delta).toBeNull();
    }
  });
});
