/**
 * RelationalHologram — VSA/HRR binding for typed relations (the P1 substrate).
 *
 * The symbolic relation graph answers only what was explicitly extracted or
 * authored. This module binds role–filler pairs into distributed vectors
 * (FHRR — the frequency-domain form of Plate's HRR): a word's whole
 * relational content becomes ONE complex vector
 *
 *     H(robin) = IS_A ⊛ bird + HAS_PART ⊛ wings + CAPABLE_OF ⊛ fly
 *
 * so queries become unbind + cleanup, chains become repeated unbind, and a
 * graph-silent question degrades to a SCORED guess instead of a hard ASK.
 *
 * Why this is FHRR: each symbol is a fixed unit-modulus complex vector over
 * K slots (v[k] = e^{iθ_k} with deterministic seeded phases). Unit modulus
 * makes unbinding exact-inverse (multiply by the conjugate) — element-wise
 * complex multiplication in the coefficient domain is exactly circular
 * convolution of the corresponding grid signals, so the "convolution
 * binding" claim holds by construction. `bundle` is coefficient-wise
 * summation, the same superposition semantics as the observer's field.
 *
 * Crosstalk: unbinding a bundled trace returns the desired filler plus
 * ~√(pairs)/√K of interference, so the correct object's cleanup cosine is
 * ≈ 1/√(pairs) while unrelated objects sit near √(pairs)/√K — a clean
 * separation the caller gates with a threshold. K is the fidelity knob.
 *
 * This module is pure math with no dependency on the ESM library; it does
 * not replace HolographicMemory (the observer's prime-grid field) — it is a
 * separate, cheap, relational-only association store.
 */

// ─══════════════════════════════════════════════════════════════════════════
// DETERMINISTIC PRNG + HASH
// ─══════════════════════════════════════════════════════════════════════════

/** mulberry32 — deterministic symbol phases make every run reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit over code points — seeds each symbol's phases. */
export function fnv1a(word: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < word.length; i += 1) {
    hash ^= word.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ─══════════════════════════════════════════════════════════════════════════
// TYPES
// ─══════════════════════════════════════════════════════════════════════════

export interface RelationalHologramOptions {
  /** Complex slot count (default 128). More slots = lower crosstalk. */
  slots?: number;
  /** Determinism seed mixed into every symbol's phases (default 0x5eed). */
  seed?: number;
}

/** One role–filler edge contributing to a subject's trace. */
export interface RoleFillerPair {
  predicate: string;
  object: string;
}

/** A cleanup candidate: the bound filler and its cosine score. */
export interface HologramCandidate {
  object: string;
  score: number;
}

const DEFAULT_SLOTS = 128;
const DEFAULT_SEED = 0x5eed;

// ─══════════════════════════════════════════════════════════════════════════
// VECTOR OPS (interleaved re/im Float64Array)
// ─══════════════════════════════════════════════════════════════════════════

export class RelationalHologram {
  private readonly slots: number;
  private readonly seed: number;
  private readonly symbols = new Map<string, Float64Array>();
  private readonly traces = new Map<string, Float64Array>();
  private readonly objects = new Set<string>();

  constructor(options: RelationalHologramOptions = {}) {
    this.slots = Math.max(16, Math.floor(options.slots ?? DEFAULT_SLOTS));
    this.seed = options.seed ?? DEFAULT_SEED;
  }

  /** The complex slot count (2× this = the vector length). */
  get slotCount(): number {
    return this.slots;
  }

  /** The number of subjects with stored traces. */
  get traceCount(): number {
    return this.traces.size;
  }

  /** The number of distinct candidate objects in the cleanup set. */
  get objectCount(): number {
    return this.objects.size;
  }

  /**
   * The unit complex vector for a symbol, cached and deterministic. Every
   * symbol (word or role) gets its own pseudo-random unit-modulus phases, so
   * no symbol is ever a scalar multiple of another.
   */
  vector(symbol: string): Float64Array {
    let vector = this.symbols.get(symbol);
    if (vector === undefined) {
      vector = new Float64Array(2 * this.slots);
      const rng = mulberry32((fnv1a(symbol) ^ this.seed) >>> 0);
      for (let k = 0; k < this.slots; k += 1) {
        const theta = rng() * 2 * Math.PI;
        vector[2 * k] = Math.cos(theta);
        vector[2 * k + 1] = Math.sin(theta);
      }
      this.symbols.set(symbol, vector);
    }
    return vector;
  }

  /** bind(a, b): element-wise complex multiply (circular convolution). */
  static bind(a: Float64Array, b: Float64Array): Float64Array {
    const n = Math.min(a.length, b.length);
    const out = new Float64Array(n);
    for (let k = 0; k < n; k += 2) {
      out[k] = a[k] * b[k] - a[k + 1] * b[k + 1];
      out[k + 1] = a[k] * b[k + 1] + a[k + 1] * b[k];
    }
    return out;
  }

  /** unbind(h, role): multiply by the conjugate of role (exact inverse). */
  static unbind(h: Float64Array, role: Float64Array): Float64Array {
    const n = Math.min(h.length, role.length);
    const out = new Float64Array(n);
    for (let k = 0; k < n; k += 2) {
      out[k] = h[k] * role[k] + h[k + 1] * role[k + 1];
      out[k + 1] = h[k + 1] * role[k] - h[k] * role[k + 1];
    }
    return out;
  }

  /** bundle(...): coefficient-wise sum (superposition). */
  static bundle(vectors: readonly Float64Array[]): Float64Array {
    const out = new Float64Array(vectors[0]?.length ?? 0);
    for (const vector of vectors) {
      for (let k = 0; k < out.length; k += 1) out[k] += vector[k];
    }
    return out;
  }

  /**
   * Cosine of complex vectors: the real part of the normalized Hermitian
   * inner product, in [-1, 1]. A zero vector scores 0 (never NaN).
   */
  static cosine(a: Float64Array, b: Float64Array): number {
    const n = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let k = 0; k < n; k += 2) {
      dot += a[k] * b[k] + a[k + 1] * b[k + 1];
      normA += a[k] * a[k] + a[k + 1] * a[k + 1];
      normB += b[k] * b[k] + b[k + 1] * b[k + 1];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // ── Trace population ─────────────────────────────────────────────────────

  /**
   * Set a subject's bundled trace: H(subject) = Σ bind(role, object) over its
   * edges. Empty pairs remove the subject. The trace is a VIEW of the caller's
   * relation set — rebuilt, never persisted.
   */
  setTrace(subject: string, pairs: readonly RoleFillerPair[]): void {
    if (pairs.length === 0) {
      this.traces.delete(subject);
      return;
    }
    const components = pairs.map((pair) => RelationalHologram.bind(this.vector(pair.predicate), this.vector(pair.object)));
    this.traces.set(subject, RelationalHologram.bundle(components));
    for (const pair of pairs) this.objects.add(pair.object);
  }

  /** Drop every trace and the cleanup set (rebuild on relation change). */
  clear(): void {
    this.traces.clear();
    this.objects.clear();
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /**
   * Unbind H(subject) by a role and rank the known objects by cosine.
   * Returns the top-K above the cleanup floor. An empty result is the honest
   * "the subject holds nothing under this role".
   */
  candidates(subject: string, predicate: string, topK = 3, floor = 0): HologramCandidate[] {
    const trace = this.traces.get(subject);
    if (trace === undefined) return [];
    const query = RelationalHologram.unbind(trace, this.vector(predicate));
    const scored: HologramCandidate[] = [];
    for (const object of this.objects) {
      const score = RelationalHologram.cosine(query, this.vector(object));
      if (score >= floor) scored.push({ object, score });
    }
    scored.sort((a, b) => b.score - a.score || a.object.localeCompare(b.object));
    return scored.slice(0, topK);
  }

  /**
   * The cleanup score of one specific object under (subject, predicate) — the
   * closed-form check ("is a robin a bird?"). 0 when the subject has no trace.
   */
  scoreOf(subject: string, predicate: string, object: string): number {
    const trace = this.traces.get(subject);
    if (trace === undefined) return 0;
    const query = RelationalHologram.unbind(trace, this.vector(predicate));
    return RelationalHologram.cosine(query, this.vector(object));
  }
}
