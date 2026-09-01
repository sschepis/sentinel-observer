/**
 * TEMPLATE ACCEPTANCE BENCH (P5 extension) — fixed frames vs. fixed +
 * learned templates, under a deterministic world model.
 *
 * The world's acceptance is simulated by a SCRIPTED SURROGATE (no LLM — the
 * bench must be deterministic and fast): a composition is accepted when it
 * is grounded (the internal critic re-parses every claim into backed
 * edges), elaborated (2-3 sentences), and definitional (carries a part-of
 * clause). The surrogate stands in for an LLM grader that prefers
 * elaborated, part-carrying answers — the preference structure the learned
 * templates are meant to capture from accepted answers.
 *
 * Two arms run over the same probe subjects and the same rng family:
 *   - baseline: composeGrounded with no learned store (fixed frames only);
 *   - learned: composeGrounded with a LearnedFrameStore that learns from the
 *     world's verdicts (accepted -> observeUse + induce) during a warmup,
 *     then keeps learning while acceptance is measured.
 *
 * The learned arm must match or beat the baseline — the admission gate
 * enforces the same criterion per template.
 */
import { mulberry32 } from '@sschepis/sentient-core';
import { composeGrounded, criticize } from './groundedFrames';
import { LearnedFrameStore, type TemplateAudit } from './learnedFrames';
import type { Negation, Relation } from './relations';

export interface TemplateBenchOptions {
  /** Measured rounds per arm (after the learned warmup). */
  rounds: number;
  /** Learning rounds before measurement starts (learned arm only). */
  warmup: number;
  seed: number;
  probes: readonly string[];
}

export interface TemplateBenchResult {
  baselineRate: number;
  learnedRate: number;
  baselineAccepted: number;
  learnedAccepted: number;
  rounds: number;
  /** Admitted learned templates at the end of the run. */
  admitted: number;
  /** Candidate templates still in exploration at the end. */
  exploring: number;
  /** Templates dropped by the admission gate (critic probe or baseline). */
  dropped: number;
  learnedTemplates: TemplateAudit[];
  samples: { sentence: string; accepted: boolean; arm: 'baseline' | 'learned' }[];
}

/** The surrogate world: grounded + 2-3 clauses + a has-part clause. */
export function worldAcceptance(
  sentence: string,
  relations: readonly Relation[],
  negations: readonly Negation[]
): boolean {
  const verdict = criticize(sentence, relations, negations);
  if (!verdict.grounded) return false;
  const clauses = sentence.split(/[.!?]+\s*/).filter((part) => part.trim().length > 0).length;
  if (clauses < 2 || clauses > 3) return false;
  return verdict.edges.some((edge) => edge.predicate === 'has-part');
}

interface ArmResult {
  accepted: number;
  rounds: number;
  store: LearnedFrameStore | null;
}

function runArm(
  relations: readonly Relation[],
  negations: readonly Negation[],
  probes: readonly string[],
  seed: number,
  warmup: number,
  rounds: number,
  learned: boolean,
  samples: TemplateBenchResult['samples']
): ArmResult {
  const store = learned ? new LearnedFrameStore() : null;
  const rng = mulberry32(seed ^ (learned ? 0x9e3779b9 : 0));
  let accepted = 0;
  let measured = 0;
  const total = warmup + rounds;
  for (let i = 0; i < total; i += 1) {
    const subject = probes[i % probes.length];
    const composed = composeGrounded([subject], relations, rng, 3, negations, store);
    if (composed === null) {
      if (i >= warmup) measured += 1;
      continue;
    }
    const worldSays = worldAcceptance(composed.sentence, relations, negations);
    if (store !== null) {
      store.observeUse(composed.templateIds, worldSays);
      if (worldSays) store.induce(composed.sentence, relations, negations);
    }
    if (i >= warmup) {
      measured += 1;
      if (worldSays) accepted += 1;
      if (samples.length < 12) {
        samples.push({ sentence: composed.sentence, accepted: worldSays, arm: learned ? 'learned' : 'baseline' });
      }
    }
  }
  return { accepted, rounds: measured, store };
}

/** Run both arms and report the acceptance rates. */
export function templateAcceptanceBench(
  relations: readonly Relation[],
  negations: readonly Negation[],
  options: TemplateBenchOptions
): TemplateBenchResult {
  const samples: TemplateBenchResult['samples'] = [];
  const baseline = runArm(relations, negations, options.probes, options.seed, 0, options.rounds, false, samples);
  const learned = runArm(relations, negations, options.probes, options.seed, options.warmup, options.rounds, true, samples);
  const audit = learned.store?.audit().filter((entry) => entry.learned) ?? [];
  return {
    baselineRate: baseline.accepted / baseline.rounds,
    learnedRate: learned.accepted / learned.rounds,
    baselineAccepted: baseline.accepted,
    learnedAccepted: learned.accepted,
    rounds: options.rounds,
    admitted: audit.filter((entry) => entry.status === 'admitted').length,
    exploring: audit.filter((entry) => entry.status === 'candidate').length,
    dropped: audit.filter((entry) => entry.status === 'dropped').length,
    learnedTemplates: audit,
    samples
  };
}
