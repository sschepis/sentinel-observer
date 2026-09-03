/**
 * THE EMERGENT HANDOVER (L2, Phase 20 — replaces the Phase 7c fading
 * controller).
 *
 * The teacher (LLM) grades every composition during scaffolding; the student
 * has a developing composite. The blend per graded answer is
 *
 *     final_reward = λ × composite + (1 − λ) × teacher
 *
 * — but λ is no longer a stored state machine driven by four constants
 * (threshold, rate, ceiling, floor: all DELETED). λ is NORMALIZED TRUST,
 * computed per bucket from the trust kernel (trust.ts):
 *
 *     λ = T_composite / (T_composite + T_llm)
 *
 * where each T is the Wilson lower bound on the judge's measured agreement
 * with ground truth (rule-based grounding checks, world outcomes, bench
 * windows). Every property the old controller hard-coded is now a theorem:
 *   · the FLOOR: a blind bucket has T_composite = 0 → λ = 0 — the teacher
 *     is the authority on novel terrain;
 *   · the CEILING: the teacher's prior + measured mass keep T_llm > 0 →
 *     λ < 1 always; two equally-proven judges settle at λ* = 0.5 — the
 *     teacher is never dismissed, it is out-measured;
 *   · the RATE: λ climbs exactly as fast as evidence tightens the bound;
 *   · REGRESSION/HACK-RESISTANCE: a composite that stops agreeing with the
 *     rule checks and world verdicts loses measured rate and λ falls.
 *
 * The uncertainty fallback is subsumed: the composite is multiplicative
 * (fluency × novelty × relevance × resonance), so "no opinion" — fluency 0,
 * an echo (novelty 0), or no reference to the question (relevance 0) — makes
 * composite = 0 and blendReward's guard passes the teacher grade through
 * untouched (the old isUncertain checked exactly the fluency≤0 case).
 */
import type { GradeCriteria } from './reliability';

export type GradeClass = 'conversational' | 'operator' | 'other';

/** Classify a task class from the utterance's shape. Conversational prompts
 *  ("what do you think...", "tell me...") are NOT operator questions even
 *  when they start with "what". */
export function classifyUtterance(utterance: string): GradeClass {
  const text = utterance.trim().toLowerCase();
  if (/^(?:what do you think|what do you feel|what do you want|tell me|how are you)\b/i.test(text)) return 'conversational';
  if (/^(what|which|how|where|who|when|why|do you|does|is|are|can)\b/i.test(text)) return 'operator';
  return 'conversational';
}

/** The trust-kernel bucket of a grade class — the composite judge's evidence
 *  and the λ probe must address the SAME criteria tuple. */
export function fadeCriteria(cls: GradeClass): GradeCriteria {
  return { answerType: 'creative', difficultyBand: 'mid', template: cls, provider: '' };
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
