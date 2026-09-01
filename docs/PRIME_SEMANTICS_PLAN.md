# Prime-Semantics Integration Plan

Analysis of the four prime-semantics papers in the project root against the
Sentinel architecture, and the phased testing plan for adopting their
compositional ideas. Hash signatures are the **control** in every phase; no
paper idea is adopted without beating (or at least matching) that control on
the existing honest benchmarks.

## 1. Source papers

| Paper | Core idea | Verdict for us |
| --- | --- | --- |
| *Prime-Resonant Semantic Computing* (TinyAleph) | Concepts = sets of semantic primes; concept algebra via set ops; Kuramoto coherence; reasoning = entropy minimization; Semantic Sieve mints primes to resolve collisions; two-layer meaning (prime substrate vs. surface vocabulary) | Runtime substrate already exists in `sentient-core`. The new, testable part is **semantic signatures + set algebra + sieve**. |
| *Triadic Prime Fusion Semantics* | `FUSE(p,q,r) = p+q+r` when prime; a small seed basis generates all higher concept-primes additively; multiple routes = alternative semantic pathways; canonical route via twist-resonance | The "primal → composite" mechanism. Testable as a prime-minting strategy for composite concepts (Phase 3). |
| *A Model-Theoretic Semantics for Prime-Based Compositional Languages* | Typed calculus: `A(p)` (operator, smaller prime) applies to `N(q)` (noun, larger prime); fusion typing; soundness/completeness = evaluation defined iff typing derivation exists | Formal spec for a composition API — relevant only if Phases 1–3 succeed. |
| *Enochian 3×7 Matrix Language* | 21 letters ↔ (prime, mode); word validity via twist closure Σ360/p ≈ 360k; sedenion letter embedding | Skip the surface language (we use English by design). Twist closure gets one cheap falsification test (Phase 5). |

## 2. Gap analysis

`sentient-core` is already a hardened TinyAleph runtime:
`PrimeOscillatorField` (Kuramoto over 256 prime-indexed oscillators),
`SedenionMemoryField` (16 axes), real entropy/coherence/order-parameter.

The gap: our prime signatures are deliberately **non-semantic**.
`apps/web/src/teacher/primeSignature.ts` assigns 4 primes by FNV-1a hash so
near-identical words get unrelated signatures (collision-free recall, no
interference). All compositional meaning lives at the symbolic layer instead
(`relations.ts` typed edges → `chain.ts` → `operators.ts`).

The papers propose the inverse: make prime overlap *be* semantic
relatedness. The trade-off is empirical — semantic overlap may improve
generalization or may degrade recall precision through holographic-memory
interference. The benchmarks decide.

## 3. Phased testing plan

The signature module is cleanly isolated
(`primeSignature.ts` → `deckVocabulary()` → `OBSERVER_OPTIONS.vocabulary`),
so every experiment is a vocabulary swap behind the same interface. The
trained bootstrap remains bound to the hash basis: **hash stays the default;
semantic signatures live behind an explicit opt-in.**

### Phase 1 — Semantic signatures vs. hash signatures (load-bearing)

- `semanticSignature.ts`: word signatures derived from the is-a relation
  graph. Roots get seed primes; a child inherits parent primes plus a
  differentiator prime; collisions resolved by sieve-style minting.
- **H1** (sanity): signature Jaccard similarity correlates with relation-graph
  distance.
- **H2**: recall accuracy (recallBenchmark, recallCompetency) does not degrade
  vs. hash control at deck scale.
- **H3**: generalization improves — untaught is-a/has-part questions answered
  better because related words resonate in the field.
- New metric: interference on near-neighbor word pairs.

**Status: DONE — all three hypotheses confirmed (2026-08-30).**
Implementation notes: DECK_100/DECK_1000 are word-only decks; the is-a
structure lives in DECK_20000 (5,569 extractable is-a edges), so all
experiments run on 20k slices, with quiz words drawn from sibling clusters
(the interference stress case). Instruments: `semanticSignature.ts` (now
production; hash retained as the benchmark control),
`semanticSignature.test.ts` (CI gates),
`npm run signature-bench` (head-to-head CLI).

| Hypothesis | Result |
| --- | --- |
| H1 | sibling Jaccard **0.204** vs unrelated **0.012** (hash control flat at 0.012) — confirmed |
| H2 | semantic **100%** vs hash **98%** top-1 recognition on 100 sibling-cluster words; sibling confusions **0 vs 2** — no degradation, slight improvement |
| H3 | never-taught sibling cues retrieve their category: semantic **31.7%** vs hash **1.7%** (n=60 holdouts; hash ≈ chance) — confirmed, ~19× |

CI floors: H2 ≥ 70% (mirrors hash bench floor), H3 ≥ 15% (conservative vs
24–32% observed).

**Production adoption (2026-08-30):** `OBSERVER_OPTIONS` now uses
`semanticVocabulary()` over the complete active deck and conversation cue
set. The resulting production vocabulary contains 20,067 unique words and
20,067 unique signatures. Bootstrap records are version 2 and carry the
required `semantic-is-a-v1` scheme marker; legacy v1/hash bootstraps are
rejected with a regeneration instruction. Existing unmarked IndexedDB traces
are treated as stale and their words reset for relearning, preventing silent
cross-encoding recall corruption. The deployed 10,000-word classroom
bootstrap was regenerated under semantic-v2 (10,195 traces, conversation
deck included).

### Phase 2 — Concept set algebra

- Union/intersection/difference + Jaccard similarity over signatures.
- **H4**: signature similarity predicts teacher (LLM) grades better than the
  current resonance component alone (grade-correlation CLI). If it holds, it
  becomes a fifth component of the student composite.

**Status: DONE — H4 not confirmed (2026-08-30).** Across two independent runs
of 50 live, LLM-graded creative answers, Spearman agreement was semantic
signature similarity **ρ=0.20–0.31**, hash-signature similarity
**ρ=0.33–0.42**, and current resonance **ρ=0.00**. Semantic similarity beats
the non-functional resonance signal but consistently does not beat the hash
control, so it is **not** added to production scoring.

The experiment exposed and fixed an independent correctness defect:
`spearman()` assigned sequential ranks to ties, causing a constant resonance
series (`0.5` for every answer) to report false positive correlations as high
as 0.71 and falsely declare classes handover-ready. It now uses average ranks;
constant series correctly report zero. Regression tests cover constants,
ties, positive correlation, and negative correlation.

### Phase 3 — Triadic fusion for composite concepts

- Multi-parent concepts get their prime minted via `FUSE` over constituent
  primes (sieve fallback when the sum is not prime).
- **H5**: fusion-derived assignment beats a random-mint control with the same
  overlap structure on category-membership / clustering purity. If it only
  matches the control, keep the set structure, drop the fusion arithmetic.

**Status: DONE — H5 falsified (2026-08-30).** `primeFusion.ts` implements
distinct odd-prime triads, recursive closure from `{3,5,7,11,13,17}`, and the
paper's canonical 108° twist scoring (including the published
`61 → 5+13+43` example). The controlled retrieval experiment held inherited
set structure, category ranking, words, and holdouts constant; only category
prime minting differed. Hash-minted and fusion-minted assignments both scored
**31.7% (19/60)** on never-taught category retrieval: delta **0.0 points**.

Decision: retain semantic set inheritance; do not adopt triadic arithmetic as
a production minting rule. The pure fusion module and tests remain as an
auditable experimental result and a base for future tests with genuinely
multi-parent concepts, but the current evidence gives it no operational role.

### Phase 4 — Entropy-minimization reasoning

- Instrument answer generation with entropy trajectories.
- **H6**: entropy drop between question and answer correlates with
  teacher-graded correctness → an honest confidence signal for the
  calibrated handover.

**Status: DONE — H6 falsified (2026-08-30).** The existing `--reward-probe`
already performs the required controlled experiment: it measures field
entropy after the answer and after a word-order-scrambled control, then
correlates the difference with the LLM grade. Across 30 graded answers,
grades ranged from 0.0 to 0.5 but every entropy reduction was **0.0000**
(variance **0.00e+0**). Single-perturbation field entropy measures excitation
mass, not content or order, and cannot serve as a correctness/confidence
signal. No production change.

### Phase 5 — Twist closure (expect falsification)

- Twist closure over generated answers' prime sequences vs. teacher grades.
- **H7**: no correlation expected. Cheap to run; a null result scopes what we
  adopt from the papers.

**Status: DONE — semantic twist closure falsified (2026-08-30).** On 50 live,
LLM-graded creative answers, closeness to the nearest full 360° turn had
Spearman **ρ=-0.42** under semantic signatures, while the hash-signature
control produced **ρ=0.30**. The semantic criterion fails both requirements
(positive `ρ≥0.3` and beating hash). Twist closure is not adopted as a
validity, quality, or confidence signal. `twistClosure.ts` remains as a small,
tested measurement primitive documenting the experiment.

## 4. Ordering rationale

Phase 1 is prerequisite to everything. Phases 2–5 are mutually independent
and can run in any order once Phase 1 lands. The model-theoretic calculus is
adopted as an API spec only after Phases 1–3 produce positive results.
