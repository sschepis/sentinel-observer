/**
 * @jest-environment node
 *
 * TASKS.md #10 — the recall floor as a calibrated gate, and the gates
 * artifact the server loads at boot (OBSERVER_GATES_FILE).
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import {
  applyCalibratedGates,
  calibratedDecisionScore,
  calibratedGateScore,
  CALIBRATED_GATE_CONSTANTS,
  CALIBRATED_GATE_FLAGS,
  CALIBRATED_GATE_SCORES,
  FLOOR_DECISION_THRESHOLD,
  resetCalibratedGates,
  type CalibrationSample
} from './calibration';
import { CONVERSATION_RECALL_FLOOR, conversationRecallFloor } from './conversation';

afterEach(() => resetCalibratedGates());

describe('the conversation recall floor is a calibrated gate', () => {
  it('reads the hand constant while the gate is off (the control)', () => {
    expect(CALIBRATED_GATE_FLAGS['conversation-recall-floor']).toBe(false);
    expect(CALIBRATED_GATE_CONSTANTS['conversation-recall-floor']).toBe(CONVERSATION_RECALL_FLOOR);
    expect(conversationRecallFloor()).toBe(CONVERSATION_RECALL_FLOOR);
  });

  it('fits at even odds: the floor is the first score whose P(correct) reaches 0.5', () => {
    // Below 0.5 every sample is a distractor; from 0.7 up they are mostly
    // exact cues — the floor should land at 0.7, not at the 0.8 acting gate.
    const samples: CalibrationSample[] = [
      ...[0.2, 0.3, 0.4, 0.45].map((score) => ({ score, positive: false })),
      { score: 0.7, positive: true },
      { score: 0.7, positive: true },
      { score: 0.7, positive: false },
      ...[0.9, 0.95, 1.0].map((score) => ({ score, positive: true }))
    ];
    expect(FLOOR_DECISION_THRESHOLD).toBe(0.5);
    const floor = calibratedDecisionScore(samples, FLOOR_DECISION_THRESHOLD);
    expect(floor.score).toBeCloseTo(0.7, 6);
    const acting = calibratedDecisionScore(samples, 0.8);
    expect(acting.score).toBeCloseTo(0.9, 6);
  });
});

describe('the gates artifact (what refit-gates writes, what the server loads)', () => {
  it('applies every listed gate and leaves the others on their constants', () => {
    const applied = applyCalibratedGates({
      arm: 'smf-off',
      gates: {
        'conversation-high-confidence': { enabled: true, score: 0.97 },
        'conversation-recall-floor': { enabled: true, score: 0.83 }
      }
    });
    expect(applied.sort()).toEqual(['conversation-high-confidence', 'conversation-recall-floor']);
    expect(calibratedGateScore('conversation-high-confidence', 0.8)).toBe(0.97);
    expect(conversationRecallFloor()).toBe(0.83);
    // Unlisted gates are untouched: the creative gates stay on their constants.
    expect(CALIBRATED_GATE_FLAGS['creative-reinforce']).toBe(false);
    expect(calibratedGateScore('creative-reinforce', 0.7)).toBe(0.7);
  });

  it('a gate with no fitted score stays on its constant even when enabled, and unknown gates are ignored', () => {
    const applied = applyCalibratedGates({
      gates: {
        'conversation-recall-floor': { enabled: true, score: null },
        ...({ 'not-a-gate': { enabled: true, score: 0.1 } } as object)
      }
    });
    expect(applied).toEqual(['conversation-recall-floor']);
    expect(CALIBRATED_GATE_SCORES['conversation-recall-floor']).toBeNull();
    expect(conversationRecallFloor()).toBe(CONVERSATION_RECALL_FLOOR);
  });

  it('resetCalibratedGates returns every gate to the control', () => {
    applyCalibratedGates({ gates: { 'conversation-recall-floor': { enabled: true, score: 0.9 } } });
    resetCalibratedGates();
    expect(conversationRecallFloor()).toBe(CONVERSATION_RECALL_FLOOR);
  });
});
