# Improvements Implementation & Test Plan

Task list for `improvements.md` ("Candidate-Distribution Entropy, Self-Tuning
Gates, Sense-Split Signatures, and Concept Synthesis under MDL"). Every task
names the proposal section, the implementation target, and the bench/gate that
measures it. The paper's discipline is followed: **measure first, implement
behind a flag, drop on refutation**. The heavy gates — fuzz 0 FP, recall
1k/5k/20k within noise, honesty 44/44, math 0 fabrication — must hold after
every proposal; a proposal that costs a single heavy-gate probe reverts behind
its flag.

Codebase map (where each proposal lands):

| concern | location |
|---|---|
| observer / field / memory | `packages/sentient-core/src/semantic/` (SemanticObserver, CompactMemoryBank, ShardedMemoryBank, SemanticMemoryBank, PrimeOscillatorField, SedenionMemoryField, HebbianCoupling, RelationalHologram, HolographicMemory) |
| recall + answer stack | `apps/web/src/teacher/agent/*.ts`, `TeacherAgent.ts` (`chatAnswer` :347), `agent/conversation.ts` (`respond`, `recallExactExchange`) |
| chained inference | `apps/web/src/teacher/chain.ts` (MAX_DEPTH 4) |
| council | `apps/web/src/teacher/network.ts` (agreementThreshold 0.6, token entropy) |
| relation graph / hologram | `apps/web/src/teacher/relations.ts`, `agent/relations.ts` (`rebuildRelationalHologram` :511) |
| elaboration / critic | `apps/web/src/teacher/groundedFrames.ts` (`framesFor`, `criticize`) |
| hybrid voice | `apps/web/src/teacher/hybrid.ts` (store ≥ 0.7) |
| scheduler / retention | `apps/web/src/teacher/fsrs.ts`, `retention.ts` |
| calibration ledger | `apps/web/src/teacher/calibration.ts` |
| shard train/merge | `apps/web/src/teacher/shardTrainer.ts` (`mergeRecords`) |
| constants | `conversation.ts` :303–316, `agent/support.ts` :270/277/363/379/441, `reliability.ts` :75–76, `network.ts`, `chain.ts` |

---

## Phase A — §2 Candidate-distribution entropy (the unifying instrument) — RUN FIRST

§11 names `cde-bench` the single most informative experiment; if H̃ adds
nothing over the top score, every downstream use of the instrument needs its
own justification. Do this before any routing change.

- [ ] **A.1 `cde.ts`**: pure module computing normalized candidate entropy
      `H̃ = −Σ p_i log p_i / log k` and top-two margin `m = (s₁−s₂)/s₁` from any
      non-negative score list. No new constants. Unit-test the [0,1] range, the
      k-normalization, and the three regimes (low H̃ / high H̃ + large m₂₃ /
      flat H̃). New file `apps/web/src/teacher/cde.ts` (+ `cde.test.ts`).
- [ ] **A.2 Instrument recall** — `CompactMemoryBank.recall` already scores
      every prefiltered candidate before slicing top-K; expose the full scored
      candidate list (not just `topK`) so H̃/m can be computed over it.
      Optionally log the prefilter candidate count (the §3.1 ~1,200 figure).
- [ ] **A.3 Instrument chained inference** — `chain.ts` walks one path and
      discards the rest; add a path-retaining variant that returns all paths to
      a target with edge-strength products (feeds §4.3 branching entropy too).
- [ ] **A.4 Instrument cleanup** — `RelationalHologram.candidates` already
      returns a ranked cosine list; that *is* the distribution. Confirm no
      truncation below the interesting regime (the floor param) for CDE.
- [ ] **A.5 Instrument council** — `network.ts` already computes token
      `entropy` and pairwise `agreement`; add H̃ over member answers as a second
      reading (kept separate from §4.5's edge-based agreement).
- [ ] **A.6 Instrument shard routing** — `ShardedMemoryBank.routeFor` /
      `runnerUpFor` compute per-shard cosine/overlap scores; expose them so a
      flat router distribution is readable.
- [ ] **A.7 Instrument elaboration frontier** — `groundedFrames.framesFor` and
      the composed-claim pool are the candidate set; compute H̃ over candidate
      next-claims (feeds §8's stopping criterion).
- [ ] **A.8 `cde-bench`** — a programmatic bench that logs H̃ and m on every
      decision in the existing benches (recall, fuzz, chain, adversarial,
      council) *without routing on them*, then measures discriminative power:
      AUC of H̃ vs. top-score on fuzz true-match/distractor, and path-entropy
      vs. correctness on the chain bench. **Pass:** AUC improvement outside
      noise. **Refute:** no gain → do not build the routing rule; record it.
      New `apps/web/src/teacher/cdeBenchmark.test.ts` + `src/cli/cde-bench.ts`.

---

## Phase B — §3 Shards: query-time partitions, merge hygiene, network traces

- [ ] **B.1 `merge-consolidation-bench`** (§3.5) — surprise-gated storage
      measures surprise against the *shard* bank, so cross-shard near-duplicates
      survive `mergeRecords` (`shardTrainer.ts` :65). Add a consolidation pass
      over the merged bank (same surprise gate, run once) and explicit merge
      rules for the non-concatenable aggregate stores (n-gram weights, drive
      weights, trust-kernel evidence, calibration samples): evidence masses sum;
      weights average by mass; replay guard dedups; MDL gains are additive.
      **Pass:** duplicates → 0 with recall within noise.
- [ ] **B.2 `shard-route-bench`** (§3.2) — keep shards as separate banks at
      query time and route each cue by a cheap first-stage score (prime
      intersection is free); candidate entropy over router shard scores (§A.6)
      is the miss detector → ask, never a wrong shard's confident answer.
      Compare routing-accuracy × in-shard recall vs. 94.6% merged at similar
      latency, K ∈ {4,8,20}. **Pass:** effective recall exceeds merged; misses
      surface as asks (0 confident wrong-shard answers on fuzz).
- [ ] **B.3 `network-trace-bench`** (§3.4) — store a trace per settled council
      answer (content = cited edges + contributing members) so the second ask
      resolves from the stored agreement with no resonance rounds. **Pass:**
      100% recall of settled answers with rounds = 0.

---

## Phase C — §4 Entropy measures per context

- [ ] **C.1 Store-time surprise → FSRS stability initializer** (§4.1) —
      surprise-gated storage already computes how poorly the bank predicts the
      stimulus, then discards it. Record it on the trace and use it to set the
      initial FSRS stability in `fsrs.ts` (higher surprise ⇒ longer initial
      stability) instead of the fixed 1-day default. Also assert the §2.3
      agreement: store-time surprise should correlate with the recall
      candidate entropy that preceded storage.
      **Bench `surprise-stability-bench`:** 30-day sim vs. fixed-initial
      baseline; retention ≥ baseline at lower review load (else revert).
- [x] **C.2 Co-rotating phase frame** (§4.2) — store/compare phases as
      `θ_i = φ_i − ω_i·t (mod 2π)` so elapsed-time proximity drops out and only
      coupling-produced deviation remains. Touch `CompactMemoryBank.phaseOrderParameter`
      and the stored-phase capture in `SemanticObserver.storeMemory`. Weight the
      term by §5's judge-AUC rather than the hard 0.15 (`phaseWeight`).
      **Bench `phase-frame-bench`:** sibling (same-prime, different-content)
      separation AUC vs. elapsed time; AUC ≈ 0.5 → drop the term honestly.
      **MEASURED (commit on `improve-phase-frame`):** frame implemented behind
      `coRotatingPhases` (default off, bit-identical control asserted). Sibling
      separation AUC vs. elapsed time: settled pipeline AUC = 0.500 exactly in
      BOTH frames (same-prime siblings store identical phases; R_true = R_sibling
      = 0.991 raw / 0.993 co — the co-rotating frame removes the settle-depth
      offset but nothing content-like remains); free-run pipeline co-rotating
      AUC 0.510 vs raw 0.512 across τ ∈ [0, 200] s (spread 0.078) — no
      separation, not independent of elapsed. **REFUTED: the moment carries no
      content beyond excitation. RECOMMENDATION: drop the phase term (set
      `phaseWeight` → 0 / remove from the blend). The term and the frame option
      are kept in code; this finding is the record.**
- [ ] **C.3 Branching entropy along chain walks** (§4.3) — report path-count,
      path-mass, and path-entropy over the paths §A.3 retains; a claim resting
      on one hedged path is itself hedged.
      **Bench `path-entropy-bench`:** corrupt one edge; path mass must predict
      correctness better than single-path strength.
- [ ] **C.4 Cleanup-distribution entropy** (§4.4) — return the full cosine
      distribution over fillers from `RelationalHologram.candidates`; one peak
      = crosstalk, two peaks = superposition of senses (feeds §7's
      disambiguating ask). Reuse §A.1.
- [ ] **C.5 Council agreement by cited edges** (§4.5) — `network.ts` agreement
      (token overlap 0.6) → overlap/mutual-information over the *cited edge
      sets* of grounded answers; stop resonance when the edge distribution's
      entropy stops falling, not the token distribution's. Composed answers
      cite no edges ⇒ visibly weaker evidence.
      **Bench `council-agreement-bench`:** re-run the 10 council probes + the
      12-probe niche bench; edge agreement must find every genuine token
      agreement and reject any false one (token overlap high, cited edges
      disjoint).

---

## Phase D — §5 Constants: values, safety bounds, tuning + the constants report

- [ ] **D.1 Taxonomy module** — classify every numeric constant into
      `values` / `safety` / `tuning`; document the classification (comments +
      a `constants.ts` registry). Values and safety bounds are never self-tuned;
      safety bounds (fuel budgets, depth, visited-set, ≤16 Hebbian partners)
      are enforced in code as today.
- [ ] **D.2 Settle criterion** (§5.2 row 1) — replace fixed settle depth 4
      (`agent/support.ts` RECALL_SETTLE_STEPS, `settleSteps`) with "tick until
      coherence peaks (d coherence/dt crosses zero)". **Bench
      `settle-criterion-bench`:** 0 fuzz FP and exact-cue recall preserved;
      multiple/no peak within fuel budget → keep the constant, log it.
- [ ] **D.3 Score-term weights as judges** (§5.2 row 2) — weight of each score
      term (phase/SMF/overlap) = its measured AUC on true-match vs. distractor
      pairs from the teacher-free fuzz bench, replacing `smfWeight` /
      `overlapWeight` / `phaseWeight` defaults in `CompactMemoryBank`.
- [ ] **D.4 Calibrated thresholds** (§5.2 rows 3) — replace `CONVERSATION_HIGH_CONFIDENCE`
      (0.8), `CREATIVE_REINFORCE_SCORE` (0.7), `CREATIVE_UNLOCK_THRESHOLD` (0.8)
      with isotonic-calibrated P(correct|score) from the existing calibration
      samples; act when P(correct) exceeds cost(wrong)/(cost(wrong)+cost(abstain)).
      **Bench `calibration-bench`:** calibration error falls; honesty 44/44 and
      0 fuzz FP hold — a single lost probe reverts that gate.
- [ ] **D.5 Decay presets → per-store stability** (§5.2 row 4) — derive
      7/45/90-day decay presets from each store's own retrieval successes
      exactly as FSRS learns per-word stability.
- [ ] **D.6 MDL costs** (§5.2 rows 5–6) — slot annotation 15 bits →
      `−log₂ P(slot|shell grammar)` from the operator library; unknown-token
      20 bits → Good–Turing unseen-mass over the deck frequency table.
- [ ] **D.7 Council + goal thresholds** (§5.2 rows 7–8) — council stop uses
      §C.5's edge-entropy; `goalMissThreshold` (network.ts default 2) → promote
      when the recurring deficit's MDL gain as a goal is positive.
- [ ] **D.8 World-outcome weight** (§5.2 row 9) — 0.25 vs. teacher 1.0 →
      measured agreement of world outcomes with bench ground truth via the
      trust kernel's bucket machinery.
- [ ] **D.9 `constants-report`** (§5.3) — alongside `rules-report`
      (`src/cli/rules-report.ts`): log every tuned value + its evidence mass in
      the exported record, print current values + drift since last record, and
      make heavy benches assert on *both* outcome and the tuned values that
      produced it.
- [ ] **D.10 Circularity guard** (§5.4) — enforce in code: a self-tuning gate
      must have ≥1 programmatic bench (fuzz/chain/adversarial/math) in its
      evidence; a gate whose only evidence is LLM grades must not self-tune.
      Add this check to the calibration/constants machinery.

---

## Phase E — §6 Ambiguity

- [ ] **E.1 Field ambiguity detection** (§6.1) — read bimodal candidate
      distribution (§A), time-to-coherence-peak, and peak coherence during
      settle; correlate with the §2 disambiguating-ask regime. New utterance
      class in the ask channel that names both top candidates.
      **Bench `ambiguity-bench`:** polysemy probes vs. unambiguous cues; ≥1
      field measure separates them with AUC ≫ 0.5 (else ambiguity is invisible
      to the field, handle at candidate level only).
- [x] **E.2 Slow context component / priming** (§6.2) — a slow-decaying
      component of SMF orientation (or a separate context field) decaying over
      *turns* not ticks, so recent turns bias attractor selection before the
      operator layers. Decay measured by the retention law, not set.
      **Bench `priming-bench`:** primed resolution rises with contamination 0
      on fuzz/honesty (any contamination that costs a probe → off).

---

## Phase F — §7 Words with multiple meanings

- [ ] **F.1 `polysemy-probe-set`** (§7.1/7.5) — **measure first**: count
      confident cross-sense "Yes" answers for words whose is-a parents are in
      unrelated closures. This is the latent fabrication path the adversarial
      bench cannot see (its negative selector computes the merged closure).
      Zero → §7.1 wrong for this record; non-zero → size the exposure.
- [ ] **F.2 Signature per sense** (§7.2) — assign each sense its own four-prime
      signature (bank#1, bank#2); surface word excites the union at split
      amplitude; definitions/edges/traces live on the sense; chain walks run
      over sense nodes and cannot cross senses; negative-target selector
      computes closure per sense. Then the probes must produce 0 confident
      cross-sense answers + a disambiguating ask where context is absent.
- [ ] **F.3 `wsd-bench`** (§7.3) — context-word + polysemous-word cues with a
      known intended sense; Hebbian coupling (`HebbianCoupling.ts`, flag off) is
      the disambiguator. **Pass:** accuracy ≫ chance with the flag on and heavy
      gates holding (else the flag stays off — §23.4's open question).
- [ ] **F.4 `sense-split-bench`** (§7.4) — sense induction as *split*: a trace
      whose context-prime distribution is bimodal splits when the split's
      entropy reduction exceeds the new node's cost (MDL gain, same currency as
      §9). **Pass:** recovers WordNet splits with 0 splits on a monosemous
      control (else only supplied senses are used).

---

## Phase G — §8 Recursively self-generated elaboration

- [ ] **G.1 Elaboration as frontier search** (§8.1) — `groundedFrames.ts`:
      frontier = edges one hop from cited objects; expand a claim that passes
      the critic *and* adds information not implied by what was said; order by
      resonance with the original question's converged moment; stop when
      marginal information falls below expected surprise (redundancy /
      hypothesis-only frontier / flat candidate entropy §A.7). Elaboration
      depth drive-controlled (curiosity deepens, conservation shortens).
      **Bench `elaboration-bench`:** 0 fabrications at every depth; redundancy
      falls as the stop engages; cumulative grounding product surfaced to the
      deviation meter. (Refute: stop never engages → marginal info not
      measurable from the graph as built.)
- [ ] **G.2 Grounded-only recursion + per-claim critic** (§8.2) — expand only
      from grounded-layer output (memorized/operator/chained); composed sentence
      is a leaf; track the product of per-step grounding scores to the deviation
      meter; run the critic on every expanded claim.
- [ ] **G.3 Inward self-questioning** (§8.3) — the observer asks itself its
      own follow-up questions; grounded answers extend elaboration, unanswerable
      ones become curiosity gaps (feeding the classroom loop), and the
      resolve/fail pattern maps graph thinness (relational-coverage lever).
      **Bench `self-question-bench`:** gaps generated and filling them extends
      chain coverage (else no gaps / all gaps).
- [ ] **G.4 Elaboration traces** (§8.4) — store graded elaborations as traces
      whose content = trace-ids + edges drawn on; re-ask resolves from the
      stored elaboration.
      **Bench `elaboration-trace-bench`:** stored elaborations recall and decay
      like ordinary traces under the 30-day sim.

---

## Phase H — §9 Concept synthesis (MDL abstraction)

- [x] **H.1 MDL gain over shared edges** (§9.1) — implement
      `gain(X) = Σ bits(shared edges of members) − bits(edges of X) − Σ bits(m
      is-a X) − bits(name X) − Σ bits(exceptions)` in the existing Zipf-cost
      currency (`mdl.ts`); greedy largest-gain-first (the shell-induction
      procedure). Form X exactly when gain > 0. **Caution §9.4:** the prime
      signatures are addresses, not semantics — synthesis cannot be read off
      them; it lives in the distributed-vector layer (below).
- [x] **H.2 Hypothesis-tier lifecycle for induced nodes** (§9.2) — induced
      concepts enter the hypothesis tier, answer hedged, promote on
      corroboration, stop on two world denials (never deleted). Reuses the
      existing rule/relation lifecycle (Phase 22 M5).
- [x] **H.3 `hypernym-recovery-bench`** (§9.8) — hide known hypernym `is-a`
      edges (bird, tool, vehicle…); measure recovery rate, precision (candidate
      discoveries for hand inspection), and false-inheritance rate (0 in
      asserted speech). **Refute:** nodes are gloss-template artifacts → the
      edge distribution is too template-driven.
- [x] **H.4 `prototype-bench`** (§9.4 distributed-vector layer) — bundle
      H(robin)+H(sparrow)+H(crow); unbind each role; shared edges recovered
      above the crosstalk floor, idiosyncratic ones rejected. **Pass:** the
      prototype's recovered edge set matches the hypernym's shared edges.
      (Reuses `RelationalHologram` bundle/unbind.)
- [x] **H.5 Naming ask + rediscovery/merge** (§9.3) — when an induced node's
      edge set matches no word, emit the naming ask ("…share something I do not
      have a word for…"); bind a human-supplied name; merge an induced node
      whose edge set matches an existing word (record the rediscovery).
      **Bench `naming-ask-bench`:** ask names members + shared edges; binding +
      lifecycle behave under existing rule-lifecycle tests.
- [x] **H.6 `field-cluster-bench`** (§9.4, speculative) — with Hebbian coupling
      on, members of a known hypernym phase-lock above field coherence after
      co-teaching; a control (unrelated words, same co-teaching count) does not.
      **Pass:** taught set clusters, control does not. **Refute:** both cluster
      → coupling follows co-teaching, not structure; pursue only the hologram
      path.


**Outcomes (this branch):**
- H.3: recovery 1.00 vs shuffle-chance 0.00 (bird/tool/vehicle all re-invented);
  1 candidate discovery (the container cluster — real, inspected);
  false-inheritance 0 in asserted speech, 1 hedged (the ostrich-fly
  generalization), exceptions blocked penguin/kiwi fly.
- H.4: PASS — prototype recovers exactly the hypernyms' shared edges above
  the crosstalk floor (shared ≥ 0.43 vs idiosyncratic ≤ 0.25) and rejects
  the idiosyncratic ones; a no-shared-structure control recovers nothing.
- H.5: ask names members + shared edges; binding makes the node answerable
  (hedged); hedge → corroborate → assert and deny → deny → stop behave
  under the existing tier; rediscovery merges into the matching word.
- H.6: REFUTED — taught and control arms are indistinguishable (ΔR ≈ 0.008)
  and neither sub-population phase-locks above field coherence; the
  potentiation gate barely opens at this teaching scale. Field-level
  synthesis is not distinguishable from rehearsal → hologram path only
  (§9.8).
---

## §10 Cross-cutting / integration

- [ ] **I.1 Heavy-gate sweep** — after every proposal: fuzz 0 FP, recall
      1k/5k/20k within noise, honesty 44/44, math 0 fabrication (the existing
      `test:bench` + `ciGates` + `recallBenchmark` + `semanticRecall` +
      `p1-relations-bench` + `grounded-bench`). A proposal behind its flag
      reverts on a single lost probe.
- [ ] **I.2 §11 risk checklist** — record in `TODO.md` / bench outputs the
      outcome of each refutation condition: CDE empty (A.8), moment empty (C.2),
      self-tuning erodes reference (D.9/D.10), sense-split fragments (F.4),
      abstraction learns templates (H.3), recursion amplifies deviation (G.2).
- [ ] **I.3 Docs** — mirror the companion-paper workflow: update
      `docs/observer-paper.md` and `docs/SCALING.md` for each landed proposal,
      and record each refused/dropped proposal with the number that refuted it.

---

## Ordering (dependency-driven)

1. **A** (CDE instrument + `cde-bench`) — gates whether the instrument is used.
2. **B.1 + B.2 + B.3** (shards) — independent of A, but B.2's router miss
   detector *uses* A.6.
3. **C** (entropy per context) — C.3 depends on A.3; C.4 on A.1.
4. **D** (constants) — D.3 depends on A.2; D.4 on the calibration ledger
   (exists); D.2 is the settle-criterion experiment.
5. **E** (ambiguity) — E.1 uses A; E.2 depends on the field's slow component.
6. **F** (senses) — F.1 first (measure the exposure), then F.2→F.3→F.4.
7. **G** (elaboration) — G.1 uses A.7; G.4 mirrors B.3.
8. **H** (concept synthesis) — H.4 uses the existing `RelationalHologram`;
   H.6 is speculative and last.
9. **I** runs continuously after each landed/refuted proposal.
