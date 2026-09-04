/**
 * D.5 (§5.2 row 4) — per-store stability learned from retrieval successes.
 *
 * The decay presets (7/45/90/30) are the CONTROL; with the per-store flag on,
 * each store's stability is learned from its OWN retrieval outcomes under the
 * FSRS update law — exactly how per-word stability is learned (wordloop).
 * This bench pins:
 *   · the law-shape per store: successes stretch stability, failures shrink
 *     it, and the surprise scaling (overdue rescue stretches most, crammed
 *     lapse collapses hardest) reproduces the scheduler's curve;
 *   · parity with the FSRS update constants (the learner's law IS the
 *     wordloop's law at equal constants);
 *   · flag gating: off = the presets everywhere (the control), on = the
 *     learned values, consumed through STABILITY_PRESETS and
 *     applyRetentionDecay.
 *
 * @jest-environment node
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import {
  STABILITY_PRESETS,
  STORE_KINDS,
  STORE_STABILITY_FLAGS,
  effectiveStoreStabilityDays,
  recordStoreOutcome,
  resetStoreStability,
  resetStoreStabilityLearned,
  retentionProbability,
  setStoreStabilityLearned,
  storeStabilityDays,
  storeStabilityEvidence,
  FSRS_TARGET_RETENTION,
  type StoreKind
} from './retention';
import {
  applyRetentionDecay,
  FSRS_OVERDUE_BONUS,
  FSRS_DIFFICULTY_SCALE,
  FSRS_INITIAL_DIFFICULTY
} from './fsrs';

afterEach(() => {
  resetStoreStability();
  resetStoreStabilityLearned();
});

/** The wordloop's own update, spelled with the FSRS scheduler's constants —
 *  the reference every store update must reproduce. */
function wordloopUpdate(
  stability: number,
  difficulty: number,
  success: boolean,
  retrieval: number
): { stability: number; difficulty: number } {
  if (success) {
    const retrievalEff = Math.min(Math.max(retrieval, 0.01) / FSRS_TARGET_RETENTION, 1);
    const gain = (1 + FSRS_OVERDUE_BONUS * (1 - retrievalEff)) * Math.exp(-difficulty / FSRS_DIFFICULTY_SCALE);
    return { stability: stability * (1 + gain), difficulty: Math.max(1, difficulty - 0.1) };
  }
  const keep = Math.min(0.5, Math.max(0.05, 1 - Math.max(retrieval, 0.01)));
  return { stability: Math.max(0.01, stability * keep), difficulty: Math.min(10, difficulty + 0.4) };
}

describe('D.5 per-store stability — the FSRS law-shape, per store', () => {
  it('flags default OFF: every store reads its preset (the control) even after outcomes', () => {
    for (const kind of STORE_KINDS) {
      expect(STORE_STABILITY_FLAGS[kind]).toBe(false);
      recordStoreOutcome(kind, true, FSRS_TARGET_RETENTION);
      recordStoreOutcome(kind, true, FSRS_TARGET_RETENTION);
      expect(effectiveStoreStabilityDays(kind)).toBe(
        kind === 'ngramWeight' ? 45 : kind === 'driveWeight' ? 90 : kind === 'nonWordTrace' ? 7 : 30
      );
    }
  });

  it('a success STRETCHES stability above the preset and successive successes grow it monotonically', () => {
    for (const kind of STORE_KINDS) {
      resetStoreStability();
      const preset = effectiveStoreStabilityDays(kind);
      const first = recordStoreOutcome(kind, true, FSRS_TARGET_RETENTION);
      expect(first).toBeGreaterThan(preset);
      const second = recordStoreOutcome(kind, true, FSRS_TARGET_RETENTION);
      expect(second).toBeGreaterThan(first);
    }
  });

  it('a failure SHRINKS stability, keeping clamp(1 − R, 0.05, 0.5) of it', () => {
    for (const kind of STORE_KINDS) {
      resetStoreStability();
      const preset = effectiveStoreStabilityDays(kind);
      // An on-time failure (R = target) keeps exactly 0.1 of the stability —
      // the scheduler's calibration anchor.
      const onTime = recordStoreOutcome(kind, false, FSRS_TARGET_RETENTION);
      expect(onTime).toBeCloseTo(preset * 0.1, 10);
      // A crammed failure (R = 1) collapses to the 0.05 floor; an overdue
      // failure (R = 0.4) keeps the 0.5 cap — the forgetting already happened.
      const afterCrammed = recordStoreOutcome(kind, false, 1);
      expect(afterCrammed).toBeCloseTo(onTime * 0.05, 10);
      expect(recordStoreOutcome(kind, false, 0.4)).toBeCloseTo(afterCrammed * 0.5, 10);
    }
  });

  it('the overdue rescue stretches more than the on-time success (surprise scaling)', () => {
    for (const kind of STORE_KINDS) {
      resetStoreStability();
      const onTime = recordStoreOutcome(kind, true, FSRS_TARGET_RETENTION);
      resetStoreStability();
      const overdue = recordStoreOutcome(kind, true, 0.45);
      expect(overdue).toBeGreaterThan(onTime);
    }
  });

  it('a harder store (difficulty up from failures) gains less per success', () => {
    const kind: StoreKind = 'nonWordTrace';
    resetStoreStability();
    const preset = effectiveStoreStabilityDays(kind);
    const fresh = recordStoreOutcome(kind, true, FSRS_TARGET_RETENTION);
    const freshGain = fresh / preset;
    for (let i = 0; i < 3; i += 1) recordStoreOutcome(kind, false, 1);
    const before = storeStabilityDays(kind)!;
    const harder = recordStoreOutcome(kind, true, FSRS_TARGET_RETENTION);
    const harderGain = harder / before;
    const evidence = storeStabilityEvidence(kind);
    expect(evidence).not.toBeNull();
    expect(evidence!.difficulty).toBeGreaterThan(FSRS_INITIAL_DIFFICULTY);
    expect(harderGain).toBeLessThan(freshGain); // e^(−D/8): the harder store gains less
  });

  it('PARITY: a store update reproduces the wordloop update exactly at equal constants', () => {
    const kind: StoreKind = 'driveWeight';
    resetStoreStability();
    // Drive the store through a mixed schedule and replay the same schedule
    // through the wordloop formula seeded at the same preset + difficulty.
    const schedule: Array<{ ok: boolean; r: number }> = [
      { ok: true, r: FSRS_TARGET_RETENTION },
      { ok: true, r: 0.5 },
      { ok: false, r: 1 },
      { ok: false, r: 0.9 },
      { ok: true, r: 0.3 }
    ];
    let learned = 90;
    let difficulty = FSRS_INITIAL_DIFFICULTY;
    for (const { ok, r } of schedule) {
      recordStoreOutcome(kind, ok, r);
      ({ stability: learned, difficulty } = wordloopUpdate(learned, difficulty, ok, r));
    }
    expect(storeStabilityDays(kind)).not.toBeNull();
    expect(storeStabilityDays(kind)!).toBeCloseTo(learned, 10);
    expect(storeStabilityEvidence(kind)!.difficulty).toBeCloseTo(difficulty, 10);
  });
});

describe('D.5 flag gating — the control vs. the learned stability', () => {
  it('with the flag ON, the store and its consumers read the learned stability', () => {
    resetStoreStability();
    recordStoreOutcome('nonWordTrace', true, 0.3); // overdue rescue — a big stretch
    const learned = storeStabilityDays('nonWordTrace');
    expect(learned).not.toBeNull();
    expect(learned!).toBeGreaterThan(7);

    setStoreStabilityLearned('nonWordTrace', true);
    expect(effectiveStoreStabilityDays('nonWordTrace')).toBe(learned);
    expect(STABILITY_PRESETS.nonWordTraceDays).toBe(learned);

    // The other stores are untouched by this store's flag.
    expect(STABILITY_PRESETS.ngramWeightDays).toBe(45);
    expect(STABILITY_PRESETS.driveWeightDays).toBe(90);
    expect(STABILITY_PRESETS.ruleCorroborationDays).toBe(30);

    // Turning the flag back off restores the preset control.
    setStoreStabilityLearned('nonWordTrace', false);
    expect(STABILITY_PRESETS.nonWordTraceDays).toBe(7);
  });

  it('applyRetentionDecay reads the live non-word stability (flag off = preset, on = learned)', () => {
    const now = Date.now();
    resetStoreStability();
    recordStoreOutcome('nonWordTrace', true, 0.3);
    const learned = storeStabilityDays('nonWordTrace')!;

    const controlTrace = { id: 'c', lastAccessAt: now - 2 * 86400000, strength: 1 };
    applyRetentionDecay([controlTrace], () => null, now);
    expect(controlTrace.strength).toBeCloseTo(retentionProbability(7, 2), 5);

    setStoreStabilityLearned('nonWordTrace', true);
    const learnedTrace = { id: 'l', lastAccessAt: now - 2 * 86400000, strength: 1 };
    applyRetentionDecay([learnedTrace], () => null, now);
    expect(learnedTrace.strength).toBeCloseTo(retentionProbability(learned, 2), 5);
    expect(learnedTrace.strength).toBeGreaterThan(controlTrace.strength);
  });
});
