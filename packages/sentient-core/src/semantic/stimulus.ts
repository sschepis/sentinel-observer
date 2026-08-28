/**
 * Stimulus contract — the observer's typed input interface.
 *
 * One typed union replaces raw `processInput` at the app boundary. Every
 * stimulus corresponds to a real learning event with documented physics
 * semantics (see docs/OBSERVER_INTERFACES.md), and every observation returns
 * an immediate `StimulusResult` so causality is visible at the moment of
 * action.
 */

/** Where the learner's attention is. */
export type AttentionFocus = 'reading' | 'review' | 'quiz' | 'idle';

/** Discrete learning events. */
export type LearningEventType =
  | 'quiz.answer'
  | 'review.completed'
  | 'note.created'
  | 'source.ingested';

/** A typed stimulus accepted by `SemanticObserver.observe`. */
export type Stimulus =
  | { kind: 'text'; content: string; weight?: number }
  | { kind: 'attention'; focus: AttentionFocus; intensity: number }
  | { kind: 'event'; type: LearningEventType; outcome: 'success' | 'failure'; detail?: string }
  | { kind: 'noise'; level: number };

/** Provenance attached to a stimulus. */
export interface StimulusContext {
  sourceId?: string;
  causeId?: string;
}

/**
 * Immediate, honest feedback for a single stimulus.
 *
 * `coherenceDelta` is the coherence change attributable to the excitation
 * itself (measured before vs after), not a prediction of the next tick.
 * `touchedAxes` is a PROJECTION: the same SMF imprint the next tick would
 * apply, computed on a clone so observation is side-effect free for the SMF.
 */
export interface StimulusResult {
  /** Unique id of the stimulus; carried by subsequent signals as cause. */
  stimulusId: string;
  kind: Stimulus['kind'];
  /** Primes actually excited (post-folding, empty when nothing matched). */
  excitedPrimes: number[];
  /** SMF axes whose projected imprint exceeds a detectable delta. */
  touchedAxes: string[];
  /** Coherence delta from the excitation itself. */
  coherenceDelta: number;
  /** Active primes after the excitation. */
  activePrimeCount: number;
  /** Extra detail the stimulus produced (e.g. a stored memory trace id). */
  note?: string;
}
