/**
 * L3 (Phase 19.2) — WEIGHTS ARE MEMORIES TOO.
 *
 * The composition transition weights (the observer's tiny language model)
 * were the last learned store exempt from forgetting: the Map only ever
 * grew, and a path practiced once in 2026 kept its weight forever. Under the
 * one retention law (retention.ts) every n-gram weight now carries a use
 * stamp and decays toward the floor when unused — fluency fades without
 * practice — and the map is BOUNDED: entries that reach the floor are
 * pruned (an absent key is the fresh prior: relearning starts clean), and a
 * hard cap evicts the weakest entries first.
 *
 * Sweep semantics: each decay sweep shrinks an entry by the retention of the
 * window since its last stamp, then re-stamps it. Repeated sweeps therefore
 * compose the curve piecewise — a bounded, monotone approximation of the
 * one-shot curve (the FSRS power law is not memoryless; exactness would
 * require storing pristine base values, which no consumer needs).
 */
import { tokenizeText } from './context';
import { decayToward, STABILITY_PRESETS } from './retention';
import { updateCompositionWeights, type TransitionWeights } from './conversation';

/** Weights at (or below) this carry no information and are pruned. */
export const NGRAM_WEIGHT_FLOOR = 0.01;
/** Hard cap on the transition map — the bound the 2026-09 review demanded. */
export const NGRAM_WEIGHT_CAP = 50_000;

/** Per-key use stamps: n-gram key → last bump/decay time (ms). */
export type WeightMeta = Map<string, number>;

/**
 * The aged WRITE path: bump the weights (the existing delta rule) and stamp
 * every touched n-gram key with `now` — the decay clock restarts on use.
 */
export function bumpAgedWeights(
  weights: TransitionWeights,
  meta: WeightMeta,
  contents: readonly string[],
  delta: number,
  now = Date.now()
): void {
  updateCompositionWeights(weights, contents, delta);
  for (const content of contents) {
    const words = tokenizeText(content);
    for (let i = 0; i < words.length - 1; i += 1) meta.set(`${words[i]}|${words[i + 1]}`, now);
    for (let i = 0; i < words.length - 2; i += 1) meta.set(`${words[i]}|${words[i + 1]}|${words[i + 2]}`, now);
  }
}

/**
 * Decay every weight toward the floor under the one law and prune entries
 * that reach it. Entries without a stamp (legacy restores) start their clock
 * at `now` — the first sweep after a legacy restore decays nothing.
 */
export function decayAgedWeights(
  weights: TransitionWeights,
  meta: WeightMeta,
  now = Date.now(),
  stabilityDays = STABILITY_PRESETS.ngramWeightDays
): { pruned: number } {
  let pruned = 0;
  for (const [key, weight] of Array.from(weights.entries())) {
    const at = meta.get(key);
    if (at === undefined) {
      meta.set(key, now);
      continue;
    }
    const elapsed = now - at;
    if (elapsed <= 0) continue;
    const next = decayToward(weight, NGRAM_WEIGHT_FLOOR, elapsed, stabilityDays);
    if (next <= NGRAM_WEIGHT_FLOOR + 1e-9) {
      weights.delete(key);
      meta.delete(key);
      pruned += 1;
    } else {
      weights.set(key, next);
      meta.set(key, now);
    }
  }
  // Orphaned stamps (their weight was deleted elsewhere) must not leak.
  for (const key of Array.from(meta.keys())) {
    if (!weights.has(key)) meta.delete(key);
  }
  return { pruned };
}

/** Hard cap: weakest-evict — lowest weight first, oldest stamp breaking ties. */
export function capAgedWeights(weights: TransitionWeights, meta: WeightMeta, cap = NGRAM_WEIGHT_CAP): number {
  if (weights.size <= cap) return 0;
  const entries = Array.from(weights.entries()).sort(
    (a, b) => a[1] - b[1] || (meta.get(a[0]) ?? 0) - (meta.get(b[0]) ?? 0)
  );
  const evict = weights.size - cap;
  for (let i = 0; i < evict; i += 1) {
    weights.delete(entries[i][0]);
    meta.delete(entries[i][0]);
  }
  return evict;
}
