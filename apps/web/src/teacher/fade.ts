/**
 * THE FADING CONTROLLER (Phase 7c) — the calibrated handover.
 *
 * The teacher (LLM) grades every composition during scaffolding; the student
 * has a developing composite. The controller blends them per task class:
 *
 *     final_reward = λ_class × composite + (1 − λ_class) × teacher
 *
 * where λ_class grows ONLY where measured agreement (Spearman, from the 7a
 * bench) has proven the student's composite predicts the teacher's judgment
 * at or above the threshold. Below the threshold the teacher dominates;
 * above it the student takes over progressively. Two guards keep the
 * scaffold honest:
 *
 *   · UNCERTAINTY FALLBACK — on answers where the student's own composite
 *     is unsure (low fluency, or a novel token the weights have never seen),
 *     λ falls and the teacher is consulted: novel terrain keeps the teacher
 *     in the loop.
 *   · CEILING — λ never reaches 1: a rolling spot-check (the residual
 *     teacher weight) keeps the internal signal calibrated against drift.
 */
import type { TransitionWeights } from './conversation';
import { tokenizeText } from './context';

/** Agreement (Spearman) at which a class is considered handover-ready. */
export const HANDOVER_THRESHOLD = 0.7;
/** How fast λ climbs once a class crosses the threshold. */
export const FADE_RATE = 0.1;
/** λ never exceeds this — the residual teacher weight is the spot-check. */
export const FADE_CEILING = 0.9;
/** λ never falls below this — the student's signal always has a voice. */
export const FADE_FLOOR = 0.1;

export type GradeClass = 'conversational' | 'operator' | 'other';

/** The persistent per-class fade state. */
export interface FadeState {
  /** Latest measured agreement (Spearman) for the class (null = unmeasured). */
  agreement: Record<GradeClass, number | null>;
  /** Current λ for the class. */
  lambda: Record<GradeClass, number>;
}

export function emptyFadeState(): FadeState {
  return {
    agreement: { conversational: null, operator: null, other: null },
    lambda: { conversational: 0, operator: 0, other: 0 }
  };
}

/** Classify a task class from the utterance's shape. Conversational prompts
 *  ("what do you think...", "tell me...") are NOT operator questions even
 *  when they start with "what". */
export function classifyUtterance(utterance: string): GradeClass {
  const text = utterance.trim().toLowerCase();
  if (/^(?:what do you think|what do you feel|what do you want|tell me|how are you)\b/i.test(text)) return 'conversational';
  if (/^(what|which|how|where|who|when|why|do you|does|is|are|can)\b/i.test(text)) return 'operator';
  return 'conversational';
}

/**
 * Update the controller with a new measured agreement for a class (from the
 * 7a bench). λ rises toward the ceiling only when agreement ≥ threshold;
 * it drifts down when agreement falls below (the student regressed).
 */
export function updateFadeState(state: FadeState, cls: GradeClass, agreement: number): void {
  state.agreement[cls] = agreement;
  const current = state.lambda[cls];
  if (agreement >= HANDOVER_THRESHOLD) {
    state.lambda[cls] = Math.min(FADE_CEILING, current + FADE_RATE);
  } else if (current > 0) {
    state.lambda[cls] = Math.max(0, current - FADE_RATE);
  }
}

/**
 * Uncertain? The student's composite is not trustworthy when its OWN model
 * has no opinion: the ANSWER has no fluent transitions under its learned
 * weights (fluency ≈ 0). The utterance's tokens are NOT consulted — the
 * observer need never have composed a question before to grade an answer to
 * it with its own transition model; only the answer's own flow matters.
 * (Measured: checking utterance tokens flagged nearly every live utterance
 * as novel, because the transition map only holds composition-context
 * n-grams — the fallback never released.)
 */
export function isUncertain(
  utterance: string,
  answer: string,
  weights: TransitionWeights,
  fluency: number
): boolean {
  void utterance;
  void weights;
  return fluency <= 0;
}

/** The effective λ for an answer — after uncertainty fallback. */
export function effectiveLambda(state: FadeState, cls: GradeClass, uncertain: boolean): number {
  if (uncertain) return Math.min(state.lambda[cls], FADE_FLOOR); // consult the teacher
  return state.lambda[cls];
}

/**
 * Blend the teacher grade and the student composite into the reward.
 *
 * Guard: when the student's composite is 0 — an echo of its seeds (novelty
 * 0), or an answer with no reference to the question (relevance 0) — the
 * student has NO positive judgment, so it abstains and the teacher grade
 * passes through. Without this guard, the blend formula would drag a strong
 * teacher grade below the reinforce gate at any λ > 0 (λ·0 + (1−λ)·0.8 =
 * 0.64 at λ = 0.2), actively unlearning the observer's best answers — the
 * degenerate handover. A composite > 0 blends as documented.
 */
export function blendReward(teacherGrade: number, composite: number, lambda: number): number {
  if (composite <= 0) return teacherGrade;
  return lambda * composite + (1 - lambda) * teacherGrade;
}