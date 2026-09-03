/**
 * THE DRIVE MODULE — archetypal principles as resonance targets.
 *
 * Thought = coherence making, driven by a small vector of primitive drives.
 * Each drive is a scalar in [0,1] computed from observable state; drives
 * MODULATE behavior (attention, asking, composition, practice) — they never
 * replace the observer's layers, they weight the choices between them.
 *
 *   coherence        — how well the moment agreed with memory (the field
 *                      came to agreement) — the drive to resolve perturbation
 *   curiosity        — pressure from unanswered gaps and frequently-heard
 *                      undefined words — the drive to fill unknowns
 *   novelty          — how new the utterance is vs the recent context — the
 *                      drive to seek new patterns
 *   conservation     — how much of memory sits above the strength floor —
 *                      the drive to preserve the well-worn
 *   selfConsistency  — how well the recalled answer matched the question —
 *                      the drive to not contradict oneself
 */

export interface DriveSignals {
  coherence: number;
  curiosity: number;
  novelty: number;
  conservation: number;
  selfConsistency: number;
}

export type DriveState = DriveSignals;

export type BehaviorOption = 'answer' | 'ask' | 'compose' | 'practice' | 'verify';

/**
 * THE OPEN DRIVE SET.
 *
 * The four archetypal behaviors are available from construction. 'verify' is
 * an ACQUIRED axis: the observer does not know, at first, that verifying its
 * own beliefs is a thing it can do. Only when experience has contradicted
 * enough stored beliefs (evidence that beliefs can be wrong) does 'verify'
 * enter the available pool — the drive set itself grows, not just its
 * weights. Its DEFAULT weight is 0: acquisition opens the axis; the weight
 * then learns from verification outcomes like any other.
 */
export const ARCHETYPAL_BEHAVIORS: readonly BehaviorOption[] = ['answer', 'ask', 'compose', 'practice'];

export type BehaviorWeights = Partial<Record<BehaviorOption, number>>;

/** The archetypal base coefficients, when experience has not spoken yet. */
export const DEFAULT_BEHAVIOR_WEIGHTS: Required<BehaviorWeights> = {
  answer: 0.5,
  ask: 0,
  compose: 0.3,
  practice: 0.2,
  verify: 0
};

/** The floor — no drive may be starved below it by repeated failures. */
export const BEHAVIOR_WEIGHT_FLOOR = 0.05;
/** The ceiling — no drive may dominate above it. */
export const BEHAVIOR_WEIGHT_CEILING = 1.5;
/** Learning rate for a single outcome. */
export const BEHAVIOR_WEIGHT_LR = 0.1;

/** M4 (Phase 21): the temperature bounds of behavior arbitration. */
export const BEHAVIOR_TEMPERATURE_MIN = 0.05;
export const BEHAVIOR_TEMPERATURE_MAX = 1.0;

const clamp = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * M4 (Phase 21): THE DRIVES SET THE ENTROPY OF ACTION. Exploration is not a
 * bolted-on ε — it is the organism's state: high curiosity or novel terrain
 * runs HOT (the arbitration samples widely), coherent/conserving states run
 * COLD (near-argmax exploitation). T → T_MIN recovers the argmax exactly.
 */
export function behaviorTemperature(drives: DriveState): number {
  const raw = BEHAVIOR_TEMPERATURE_MIN + 0.5 * drives.curiosity + 0.5 * drives.novelty;
  return Math.max(BEHAVIOR_TEMPERATURE_MIN, Math.min(BEHAVIOR_TEMPERATURE_MAX, raw));
}

/** Normalize raw signals into drive state in [0,1]. */
export function computeDrives(signals: DriveSignals): DriveState {
  return {
    coherence: clamp(signals.coherence),
    curiosity: clamp(signals.curiosity),
    novelty: clamp(signals.novelty),
    conservation: clamp(signals.conservation),
    selfConsistency: clamp(signals.selfConsistency)
  };
}

/**
 * ARBITRATION: when several next behaviors are possible, the drive-weighted
 * choice picks one. Each option earns its (learned) base weight plus the
 * drives that archetypally favor it — the observer behaves according to its
 * internal priorities, not rule dispatch. Absent weights = archetypal
 * defaults, so a system with no experience arbitrates exactly as before.
 *
 * `available` is the ACQUIRED-SET gate: behaviors not in the pool are never
 * selected, no matter their weight — an axis the observer has not yet
 * acquired is one it does not even consider. Defaults to the archetypal
 * four; the caller widens the set when acquisition evidence accumulates.
 *
 * M4 (Phase 21): with an `rng`, the choice is BOLTZMANN-SAMPLED at the
 * drive temperature — the exploration policy the argmax never had. Every
 * drive term carries coefficient 1 (the hand-tuned `curiosity × 2` is gone:
 * curiosity's extra push now flows through the TEMPERATURE, where it
 * belongs). Without an rng the choice is the exact argmax (the cold limit) —
 * deterministic callers and tests are unchanged.
 */
export function chooseBehavior(
  drives: DriveState,
  options: readonly BehaviorOption[],
  weights: BehaviorWeights = {},
  available: ReadonlySet<BehaviorOption> = new Set(ARCHETYPAL_BEHAVIORS),
  rng?: (() => number) | null
): BehaviorOption | null {
  const scores: Array<[BehaviorOption, number]> = options.map((option) => {
    if (!available.has(option)) return [option, -Infinity];
    switch (option) {
      case 'answer':
        // Resolve the perturbation: answer when the moment agrees with
        // memory and the answer is consistent.
        return [option, (weights.answer ?? DEFAULT_BEHAVIOR_WEIGHTS.answer) + drives.coherence + drives.selfConsistency];
      case 'ask':
        // Curiosity seeks what the observer does not know (coefficient 1 —
        // its urgency flows through the temperature, not a multiplier).
        return [option, (weights.ask ?? DEFAULT_BEHAVIOR_WEIGHTS.ask) + drives.curiosity];
      case 'compose':
        // Novelty drives invention: compose new combinations from memory.
        return [option, (weights.compose ?? DEFAULT_BEHAVIOR_WEIGHTS.compose) + drives.novelty];
      case 'practice':
        // Conservation drives rehearsal: keep the well-worn well-worn.
        return [option, (weights.practice ?? DEFAULT_BEHAVIOR_WEIGHTS.practice) + drives.conservation];
      case 'verify':
        // ACQUIRED: test what it thinks it knows. Weighted by learned
        // verification outcomes; unlocked only after contradictions.
        return [option, (weights.verify ?? DEFAULT_BEHAVIOR_WEIGHTS.verify) + drives.selfConsistency];
      default:
        return [option, 0];
    }
  });

  // Boltzmann sampling at the drive temperature (M4) — only with an rng.
  if (rng !== undefined && rng !== null) {
    const viable = scores.filter(([, score]) => Number.isFinite(score));
    if (viable.length === 0) return null;
    const temperature = behaviorTemperature(drives);
    const maxScore = Math.max(...viable.map(([, score]) => score));
    let total = 0;
    const masses = viable.map(([, score]) => {
      const mass = Math.exp((score - maxScore) / temperature);
      total += mass;
      return mass;
    });
    let draw = rng() * total;
    for (let i = 0; i < viable.length; i += 1) {
      draw -= masses[i];
      if (draw <= 0) return viable[i][0];
    }
    return viable[viable.length - 1][0];
  }

  let best: BehaviorOption | null = null;
  let bestScore = -Infinity;
  for (const [option, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      best = option;
    }
  }
  // When EVERY option is unavailable (-Infinity — the acquired-set gate
  // excludes all of them), returning options[0] silently bypassed the gate.
  // Null is the honest refusal; the caller falls back to a sane default.
  return best;
}

/**
 * Update a behavior's learned base weight from an outcome. The stored value
 * is anchored on the archetypal default: a win moves it ABOVE the archetype,
 * a loss below — clamped so no drive can starve (floor) or dominate
 * (ceiling). Experience adjusts the gradient's shape, never its meaning.
 */
export function updateDriveWeight(
  weights: BehaviorWeights,
  option: BehaviorOption,
  win: boolean,
  lr = BEHAVIOR_WEIGHT_LR
): number {
  const current = weights[option] ?? DEFAULT_BEHAVIOR_WEIGHTS[option];
  const next = current + (win ? lr : -lr);
  // The floor is relative to the archetype — a behavior whose default is 0
  // cannot be pushed to a stored value ABOVE default by repeated losses.
  const floor = Math.min(BEHAVIOR_WEIGHT_FLOOR, DEFAULT_BEHAVIOR_WEIGHTS[option]);
  const clamped = Math.max(floor, Math.min(BEHAVIOR_WEIGHT_CEILING, next));
  weights[option] = clamped;
  return clamped;
}