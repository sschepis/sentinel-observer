/**
 * H6 (Phase 23) — HEBBIAN COUPLING: what agrees together, wires together.
 *
 * The Kuramoto pairwise weight has always been a CONSTANT (+1 within an
 * activity group, `1 − 2·inhibition` across). The field could MEASURE
 * agreement (coherence) but never LEARN it: two primes that co-excite in a
 * thousand coherent moments were coupled no more tightly than two strangers.
 * This store is the missing half of "coherence is agreement": a sparse,
 * bounded, decaying pairwise potentiation
 *
 *     ΔK_ij = η · a_i · a_j · coherence · (1 − K_ij / K_MAX)
 *
 * applied to the co-excited winners at MOMENT time (the observer's
 * coherence-crossing events — not every tick), so semantically related
 * primes develop real phase-locking beyond temporal proximity. The learned
 * coupling then scales the pairwise weight in the phase sweep,
 * row-normalized so the field's energy scaling stays stable.
 *
 * Bounded like every learned store: K is clamped to [0, kMax], each
 * oscillator keeps at most `neighbors` learned partners (weakest-evict),
 * and the whole store DECAYS under the retention-law shape in simulation
 * time — an unused pairing fades. EXPERIMENT-GATED: the flag defaults OFF,
 * and at OFF the field is bit-identical to the control.
 */
import { clampRange } from './numeric';

export interface HebbianOptions {
  /** Master switch — default false (the control). */
  enabled?: boolean;
  /** Potentiation rate η (default 0.05). */
  eta?: number;
  /** Per-pair coupling ceiling (default 1). */
  kMax?: number;
  /** Max learned partners per oscillator, weakest-evict (default 16). */
  neighbors?: number;
  /** Retention-law stability in SIMULATION seconds (default 600): a pairing
   *  unused for one stability keeps ~90% of its coupling. */
  stabilityTime?: number;
}

export interface HebbianConfig {
  enabled: boolean;
  eta: number;
  kMax: number;
  neighbors: number;
  stabilityTime: number;
}

/** Serialized form: symmetric triplets (i < j). */
export interface HebbianSnapshot {
  version: 1;
  pairs: Array<[number, number, number]>;
}

const FORGETTING_FACTOR = 19 / 81;

export function normalizeHebbianOptions(options: HebbianOptions | undefined): HebbianConfig {
  return {
    enabled: options?.enabled === true,
    eta: clampRange(options?.eta ?? 0.05, 0, 1),
    kMax: Math.max(0.01, options?.kMax ?? 1),
    neighbors: Math.max(1, Math.floor(options?.neighbors ?? 16)),
    stabilityTime: Math.max(1, options?.stabilityTime ?? 600)
  };
}

export class HebbianCouplingStore {
  /** Sparse symmetric store: row i → (j → K_ij), kept for BOTH directions so
   *  the tick sweep reads a row in O(neighbors). */
  private readonly rows = new Map<number, Map<number, number>>();
  private readonly config: HebbianConfig;
  /** Simulation clock of the last decay sweep. */
  private lastDecayAt = 0;

  constructor(config: HebbianConfig) {
    this.config = config;
  }

  /** The learned coupling of a pair (0 when unlearned). */
  get(i: number, j: number): number {
    return this.rows.get(i)?.get(j) ?? 0;
  }

  /** The learned row of an oscillator (readonly view; may be undefined). */
  row(i: number): ReadonlyMap<number, number> | undefined {
    return this.rows.get(i);
  }

  /** Total learned pairs (i < j). */
  pairCount(): number {
    let count = 0;
    for (const [i, row] of this.rows) {
      for (const j of row.keys()) if (j > i) count += 1;
    }
    return count;
  }

  private set(i: number, j: number, value: number): void {
    let row = this.rows.get(i);
    if (row === undefined) {
      row = new Map();
      this.rows.set(i, row);
    }
    row.set(j, value);
  }

  private deletePair(i: number, j: number): void {
    this.rows.get(i)?.delete(j);
    this.rows.get(j)?.delete(i);
    if (this.rows.get(i)?.size === 0) this.rows.delete(i);
    if (this.rows.get(j)?.size === 0) this.rows.delete(j);
  }

  /** Enforce the per-oscillator neighbor cap (weakest-evict). */
  private capRow(i: number): void {
    const row = this.rows.get(i);
    if (row === undefined || row.size <= this.config.neighbors) return;
    const entries = [...row.entries()].sort((a, b) => a[1] - b[1]);
    const evict = row.size - this.config.neighbors;
    for (let k = 0; k < evict; k += 1) this.deletePair(i, entries[k][0]);
  }

  /**
   * Potentiate the co-excited winners of a coherent moment. `winners` are
   * (index, amplitude) pairs — the caller passes the top active oscillators.
   * Saturating: ΔK → 0 as K → kMax.
   */
  potentiate(winners: ReadonlyArray<{ index: number; amplitude: number }>, coherence: number, now: number): void {
    if (!this.config.enabled || winners.length < 2) return;
    this.decay(now);
    const c = clampRange(coherence, 0, 1);
    if (c <= 0) return;
    for (let a = 0; a < winners.length; a += 1) {
      for (let b = a + 1; b < winners.length; b += 1) {
        const wi = winners[a];
        const wj = winners[b];
        const current = this.get(wi.index, wj.index);
        const delta = this.config.eta * wi.amplitude * wj.amplitude * c * (1 - current / this.config.kMax);
        if (delta <= 0) continue;
        const next = clampRange(current + delta, 0, this.config.kMax);
        this.set(wi.index, wj.index, next);
        this.set(wj.index, wi.index, next);
      }
    }
    for (const winner of winners) this.capRow(winner.index);
  }

  /**
   * Retention-law decay in simulation time: every pairing shrinks by the
   * retention of the window since the last sweep (piecewise composition of
   * the curve, like the aged weights — bounded, monotone). Pairs below the
   * floor are pruned: the map is bounded by forgetting AND by the caps.
   */
  decay(now: number, floor = 1e-3): void {
    const elapsed = now - this.lastDecayAt;
    this.lastDecayAt = now;
    if (!(elapsed > 0)) return;
    const retention = Math.pow(1 + FORGETTING_FACTOR * (elapsed / this.config.stabilityTime), -0.5);
    if (retention >= 1) return;
    for (const [i, row] of [...this.rows.entries()]) {
      for (const [j, value] of [...row.entries()]) {
        if (j < i) continue; // visit each pair once
        const next = value * retention;
        if (next <= floor) this.deletePair(i, j);
        else {
          this.set(i, j, next);
          this.set(j, i, next);
        }
      }
    }
  }

  snapshot(): HebbianSnapshot {
    const pairs: Array<[number, number, number]> = [];
    for (const [i, row] of this.rows) {
      for (const [j, value] of row) if (j > i) pairs.push([i, j, value]);
    }
    return { version: 1, pairs };
  }

  restore(snapshot: HebbianSnapshot | null | undefined): void {
    if (snapshot === null || snapshot === undefined || !Array.isArray(snapshot.pairs)) return;
    this.rows.clear();
    for (const [i, j, value] of snapshot.pairs) {
      if (!Number.isInteger(i) || !Number.isInteger(j) || !Number.isFinite(value) || i === j) continue;
      const clamped = clampRange(value, 0, this.config.kMax);
      if (clamped <= 0) continue;
      this.set(i, j, clamped);
      this.set(j, i, clamped);
    }
    for (const i of [...this.rows.keys()]) this.capRow(i);
  }

  reset(): void {
    this.rows.clear();
    this.lastDecayAt = 0;
  }
}
