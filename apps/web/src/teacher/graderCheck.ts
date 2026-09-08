/**
 * THE GRADER CHECK — is the teacher's judge able to judge? (IMPROVEMENT_PLAN
 * Rule 1: null model first; Rule 3: ground truth from outside the loop.)
 *
 * Every creative grade the LLM returns moves memory (reinforce / weaken),
 * edge confidence, rule confidence, the compose drive weight and the gap
 * list. All of that assumes the grader can tell a good answer from a bad
 * one. The live record showed what happens when it cannot: 2,619 compose
 * losses and zero wins over the observer's whole life — a drive weight
 * pinned at its floor by a judge that may never have said "good" to anyone.
 *
 * The check is the cheapest possible null test. Take taught conversation
 * pairs — authored by a human or a curriculum, so their responses are correct
 * BY CONSTRUCTION and independent of anything the observer composed. Grade
 * each cue twice: with its own response (known good) and with another pair's
 * response (known bad). A grader that can judge separates the two; a grader
 * that cannot is not a source of feedback, whatever it returns.
 *
 * Two conditions, both required for trust:
 *   · separation — AUC(good vs bad) ≥ 0.75: it ranks good above bad;
 *   · reachability — at least half the known-good answers clear the
 *     reinforce gate: a judge that never grades a CORRECT answer as strong
 *     can never let a composition win, however well it ranks.
 * Fewer than MIN_PROBES usable probes → the check is inconclusive (null), and
 * the caller keeps its prior (a fresh observer is not blocked by a check it
 * cannot run).
 */
import type { SemanticGrader } from './chaperone';
import type { ConversationPair } from './conversation';
import { creativeReinforceScore } from './agent/support';

export interface GraderProbe {
  cue: string;
  /** The pair's own response — correct by construction. */
  good: string;
  /** Another pair's response — wrong for this cue by construction. */
  bad: string;
}

export interface GraderCheck {
  grader: string;
  at: number;
  probes: number;
  /** Scores the grader gave the known-good answers (nulls/throws dropped). */
  good: number[];
  /** Scores the grader gave the known-bad answers. */
  bad: number[];
  /** Grader calls that returned null or threw. */
  failures: number;
  auc: number | null;
  goodMean: number | null;
  badMean: number | null;
  /** Share of known-good answers at or above the reinforce gate. */
  goodPass: number | null;
  /** The reinforce gate the pass share was read against. */
  reinforceGate: number;
  /** true = can judge; false = cannot; null = inconclusive (too few probes). */
  trusted: boolean | null;
  reason: string;
}

export const GRADER_MIN_PROBES = 4;
export const GRADER_AUC_FLOOR = 0.75;
export const GRADER_GOOD_PASS_FLOOR = 0.5;

/** Build probes from taught pairs: each cue with its own response and a
 *  different pair's response. Deterministic under the given rng. */
export function graderProbesFrom(
  pairs: readonly ConversationPair[],
  count: number,
  rng: () => number = Math.random
): GraderProbe[] {
  const usable = pairs.filter((pair) => pair.cue.trim().length > 0 && pair.response.trim().length > 0);
  if (usable.length < 2) return [];
  const order = [...usable];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const probes: GraderProbe[] = [];
  for (let i = 0; i < order.length && probes.length < count; i += 1) {
    const pair = order[i];
    // The bad answer: the next pair's response, skipping any that happens to
    // match (two pairs can share a canned reply).
    let bad: string | null = null;
    for (let k = 1; k < order.length; k += 1) {
      const other = order[(i + k) % order.length];
      if (other.response.trim().toLowerCase() !== pair.response.trim().toLowerCase()) {
        bad = other.response;
        break;
      }
    }
    if (bad === null) continue;
    probes.push({ cue: pair.cue, good: pair.response, bad });
  }
  return probes;
}

/** Rank-based AUC of good over bad (ties count half). */
export function pairwiseAuc(good: readonly number[], bad: readonly number[]): number | null {
  if (good.length === 0 || bad.length === 0) return null;
  let wins = 0;
  for (const g of good) {
    for (const b of bad) {
      if (g > b) wins += 1;
      else if (g === b) wins += 0.5;
    }
  }
  return wins / (good.length * bad.length);
}

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

/** Run the check. Never throws: a grader that throws on every call is a
 *  grader with `failures === probes*2` and an inconclusive verdict. */
export async function checkGrader(
  grader: SemanticGrader,
  probes: readonly GraderProbe[],
  options: { signal?: AbortSignal } = {}
): Promise<GraderCheck> {
  const good: number[] = [];
  const bad: number[] = [];
  let failures = 0;
  const gradeOne = async (cue: string, answer: string): Promise<number | null> => {
    try {
      const outcome = await grader.grade(cue, answer, { signal: options.signal });
      return outcome === null || !Number.isFinite(outcome.score) ? null : outcome.score;
    } catch {
      return null;
    }
  };
  for (const probe of probes) {
    if (options.signal?.aborted === true) break;
    const g = await gradeOne(probe.cue, probe.good);
    if (g === null) failures += 1;
    else good.push(g);
    const b = await gradeOne(probe.cue, probe.bad);
    if (b === null) failures += 1;
    else bad.push(b);
  }
  const reinforceGate = creativeReinforceScore();
  const auc = pairwiseAuc(good, bad);
  const goodPass = good.length === 0 ? null : good.filter((score) => score >= reinforceGate).length / good.length;
  const usable = Math.min(good.length, bad.length);
  let trusted: boolean | null;
  let reason: string;
  if (usable < GRADER_MIN_PROBES || auc === null || goodPass === null) {
    trusted = null;
    reason = `inconclusive — ${usable} usable probe pairs (need ${GRADER_MIN_PROBES}), ${failures} grader failures`;
  } else if (auc < GRADER_AUC_FLOOR) {
    trusted = false;
    reason = `cannot separate good from bad answers (AUC ${auc.toFixed(2)} < ${GRADER_AUC_FLOOR})`;
  } else if (goodPass < GRADER_GOOD_PASS_FLOOR) {
    trusted = false;
    reason = `never grades a correct answer as strong (${(goodPass * 100).toFixed(0)}% of known-good answers reach the ${reinforceGate.toFixed(2)} reinforce gate; need ${(GRADER_GOOD_PASS_FLOOR * 100).toFixed(0)}%)`;
  } else {
    trusted = true;
    reason = `separates good from bad (AUC ${auc.toFixed(2)}); ${(goodPass * 100).toFixed(0)}% of known-good answers reach the reinforce gate`;
  }
  return {
    grader: grader.name,
    at: Date.now(),
    probes: probes.length,
    good,
    bad,
    failures,
    auc,
    goodMean: mean(good),
    badMean: mean(bad),
    goodPass,
    reinforceGate,
    trusted,
    reason
  };
}

/** One-line report for logs and events. */
export function describeGraderCheck(check: GraderCheck): string {
  const verdict = check.trusted === null ? 'INCONCLUSIVE' : check.trusted ? 'TRUSTED' : 'UNTRUSTED';
  const auc = check.auc === null ? '—' : check.auc.toFixed(2);
  const gm = check.goodMean === null ? '—' : check.goodMean.toFixed(2);
  const bm = check.badMean === null ? '—' : check.badMean.toFixed(2);
  return `grader "${check.grader}" ${verdict}: ${check.probes} probes, good mean ${gm} vs bad mean ${bm}, AUC ${auc}, failures ${check.failures} — ${check.reason}`;
}
