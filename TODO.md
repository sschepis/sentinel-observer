# TODO — P5–P8 Enhancement Plan

Dependency-driven order (not the listing order): provenance first, then the
weighted-edge data model, then grounded generation, then the richest template
layer — each phase's gates are measurable before the next begins.

## Phase 6 — P7: Full answer provenance (2–3d)

Record trace ids / edges / operator id on every answer; on a bad grade,
weaken exactly those. Enables surgical repair and per-edge confidence.

- [x] **6.1 Record the producer on every answer**
  - [x] Extend `ChatAnswer` with `provenance` (mode, traceIds, edges, operatorId)
  - [x] Populate at every `chatAnswer` return site (clock/memorized/operator/learned/compiled/creative/ask)
  - [x] Forward provenance into `creativeGradeFeedback` (useChat.ts, autonomous.ts)
  - [x] Persist `authoredAnswers` in learningState + bootstrap
- [x] **6.2 Weaken exactly the producers on bad grades**
  - [x] Quiz `grade()`: a 'wrong' verdict weakens the producing trace (strength-floor gated)
  - [x] Creative path: operator-cited edges enter the weakening loop (ledger records edges; P8 consumes)
  - [x] Bounded per-answer grade ledger (`answerGrades`), persisted like `strengthHistory`
- [x] **6.3 Gates**: unit tests (provenance on every mode; wrong grade weakens producing trace; authoredAnswers export/import; belief-contradiction demote regression)

## Phase 7 — P8: Confidence-weighted edges + explicit negatives (3–4d)

- [x] **7.1 Weighted edges**: `Relation.strength` (agreement bumps, P7 grade hook, low-strength → hedged answers)
- [x] **7.2 Confirmed-false store**: `Negation {subject, predicate, object, evidence, origin}`; `storeNegation`; negative-form operator ("X is not a Y" teaches); graded-confirmed "No" enters store; absence-of-evidence rule intact
- [x] **7.3 Gates**: negation unit tests; adversarial probes; p1-relations-bench negation probe set (FP < 2%)

## Phase 8 — P5: Grounded generation + internal critic (4–5d)

- [x] **8.1 Typed frames**: `groundedFrames.ts` (framesFor/composeGrounded from edges); critic (claim parser + graph check); dispatch grounded-first, Markov labeled fallback
- [x] **8.2 Seed the PRNG**: `rng` option through `CompositionOptions` (conversation.ts:413/469/470); per-session seeded RNG in TeacherAgent; determinism gate
- [x] **8.3 Gates**: `grounded-bench` (fabrication rate → 0 for grounded answers); critic unit tests; ASK-rate + evasion regressions

## Phase 9 — P6: Relation-hole templates (3–4d)

- [x] **9.1 Extended guard**: content words beyond the slot allowed iff edge-derivable; `{isa(slot)}`-style holes resolved at fire time (decline if edge vanished); MDL hole cost
- [x] **9.2 Honesty audit**: adversarial checks against backing edges (reuse the P5 critic)
- [x] **9.3 Gates**: learn/fire/decline unit tests; adversarial suite; learning bench regression (pure echo unchanged)

## Phase 10 — Integration, regression, docs (2–3d)

- [x] Full gate sweep (unit ×2, test:bench, prime-bench, signature-bench, drill-bench, p1-relations-bench, grounded-bench, ask-audit, self-sufficiency)
- [x] Cross-feature checks (P7→P8 edge bumps, P5 critic vs evasion, P6→P5 audit, negations vs P1 graded fallback)
- [x] ASK-rate + fabrication-rate report (before/after, per layer)
- [x] Docs: observer-paper §3.4/§3.5/abstract; SCALING.md §10

## Baselines (Phase 0 of this round)

- Fabrication rate of the Markov creative path: unmeasured — `grounded-bench` must record it before P5.
- Echo learner: pure-echo only (documented, learning.ts:14-19).
- Quiz 'wrong' never weakens the producing trace (only the belief demote at TeacherAgent.ts:1269).
- `authoredAnswers` session-scoped only (TeacherAgent.ts:2995-3008).
- Edge model: boolean; no negatives; `negativeTargetsFor` (adversarial.ts:75-110) exists for probes.
- Creative PRNG: unseeded `Math.random` at conversation.ts:413/469/470.

# TODO — P9–P13 Enhancement Plan

Order: P9 (scheduler) → P11 (pruning/capacity) → P12 (CI gates) → P13 (semantic recall) → P10 (sleep pass) → integration.

## Phase 11 — P9: FSRS-style scheduling (4–5d)
- [x] 11.1 Per-item model: stability/difficulty/dueAt/lastIntervalDays on WordState; retention curve R(t,S) = (1 + 19/81·t/S)^−0.5; applyRetentionDecay replaces applyTimeDecay (strength = the model's prediction)
- [x] 11.2 Review update in grade() (success stretches S + lowers D; failure shrinks S + raises D; dueAt = now + interval at target retention 0.9)
- [x] 11.3 nextReview/WordReport/consolidation keyed on dueAt + stability (replace strength < 0.6); setTuning repurposed
- [x] 11.4 Persistence: WordState fields through bootstrap/learningState
- [x] 11.5 Gates: unit tests + recall-bench regression + overnight regression (SrsRetention rewritten to FSRS semantics)

## Phase 12 — P11: Utility-based pruning + capacity (2–3d)
- [x] 12.1 Utility score (accessCount/recency/importance/strength/gradeEvidence) replaces weakest-first pruning
- [x] 12.2 Capacity: bank DEFAULT raised 5000 → 50000 (the W10 thrash fix — a bare observer over the 20k deck no longer prunes 75% of what it stores); OBSERVER_OPTIONS explicit 50000; W10 kill-shot (bare observer, full 20k train, zero pruning, every word trace present)
- [x] 12.3 Gates: unit tests (utility ranking, bump hook, consolidated exemption, extra persistence) + regression (489 tests, all benches)

## Phase 13 — P12: Four CI gates (3–4d)
- [x] 13.1 Held-out relational reasoning (hiddenRelationKeys; hidden edges recover via the loose hologram — GATE PASS)
- [x] 13.2 Fabrication + false-yes rate (adversarial probes: 0 fabrications, 0 false-yes)
- [x] 13.3 Calibration error (measured 0.113 ≤ 0.15)
- [x] 13.4 ASK-rate / accuracy-when-answering frontier (measured ASK 33% · accuracy 100% ≥ 0.8/≤ 0.4)
- [x] Wired into test:bench (5 suites, 8 tests all pass)

## Phase 14 — P13: Semantic recall benchmark (2–3d)
- [x] 14.1 Definition→word + paraphrase→word cues; content-path fix for the production quiz; precision-gated semantic retrieval before ASK
- [x] 14.2 Gates: corpus paraphrase→word 85% (51/60) ≥ 0.6; chat retrieval ≥ 0.6 with zero wrong answers; recognition unchanged

## Phase 15 — P10: Replay/consolidation pass (3–4d)
- [ ] 15.1 Relation re-mining over conversation traces (origin: 'consolidated')
- [ ] 15.2 Contrastive differentiation of confused near-duplicates (±δ + belief)
- [ ] 15.3 Pattern promotion via the operator learner; idempotent + deterministic
- [ ] 15.4 Gates: unit + regression

## Phase 16 — Integration, regression, docs (2–3d)
- [ ] Full gate sweep + cross-feature checks + docs (observer-paper §3.3/3.5, SCALING.md §11)

# TODO — L-Series: The Three Laws Round (Phases 17–24)

The diagnosis of the 2026-09 review: every weakness is a place where the design
philosophy was applied as a special case instead of as a law. This round
promotes three latent patterns into universal laws and lands three structural
moves. Every phase deletes more constants than it adds.

- **L1 — Surprise-scaled plasticity**: Δ ∝ (outcome − prediction) × trust,
  everywhere (fixes W1 direction bug, W2, W11; shrinks W8).
- **L2 — One trust kernel**: trust = posterior lower bound on measured
  agreement; fusion = normalized trust (fixes W5; deletes fade constants;
  gives W14 its uncertainty; softens W7; chips W13).
- **L3 — Everything learned is a trace**: one retention law; weights are
  memories too (fixes W3, W4; shrinks W8; chips W13).
- **M4 — Drive-temperature arbitration** (fixes W6).
- **M5 — Hypothesis-tier relations** (fixes W12, W7).
- **H6 — Hebbian coupling experiment** (targets W9, W10, W15; bench-gated).

Order: 17 → 18 → 19 → 20 → 21 → 22 → 23(flagged) → 24. 21 can run any time
after 17. Schema changes (19.2, 20.4, 22.5) land under ONE learningState/
bootstrap version bump (see 19.0).

## Phase 0 (this round) — Baselines to record before any change — DONE

All baselines recorded in the 2026-09 review + pinned where executable:

- [x] FSRS lapse direction: pinned by a characterization test (easy D=1 word
  lost 98/100 stability vs hard D=10 word 80/100 — the inversion witnessed),
  then the test was rewritten as the Phase 17 direction suite
  (P0baseline.test.ts) when 17.3 deleted the bug.
- [x] Success gain ignored retrievability: TeacherAgent grade() pre-17.2.
- [x] Dual decay: applyTimeDecay (TeacherAgent.ts:523) used by
  cli/train.ts:60,833; runtime uses applyRetentionDecay.
- [x] Composition weights unbounded, no decay: conversation.ts:395–407,
  Map at TeacherAgent.ts:686, persisted at :1615/:5081, bootstrap.ts:140.
- [x] Fade constants: fade.ts:26–32; λ updated only via Spearman windows
  (cli/autonomous-classroom.ts:293–297).
- [x] chooseBehavior argmax + `curiosity*2`: drives.ts:89–131.
- [x] Relation coverage 34% (paper §5.5); regex is proposer AND gatekeeper.
- [x] Kuramoto pairwise weight is constant: PrimeOscillatorField.ts:619.
- [x] Bench numbers: recall 94.6% @20k, fuzz 0/15, honesty 44/44, calibration
  0.113, ASK 33%/acc 100%, TeacherAgent.ts = 5,824 lines; web unit suite
  91 suites / 1075 tests green at baseline.

## Phase 17 — L1a: Surprise-scaled FSRS scheduler (2–3d) — DONE

- [x] **17.1 Retrievability at review time**: helper `reviewRetrievability(state, now)`
  beside retentionProbability — R from state.stability and elapsed since
  lastAskedAt (fallback taughtAt). The anchor is snapshotted at the TOP of
  grade() (before lastAskedAt is overwritten) — the review's elapsed
  interval, not zero.
- [x] **17.2 Success update**: LANDED FORM `gain = fsrsWeight · e^(−D/8) ·
  (1 + FSRS_OVERDUE_BONUS·(1 − min(R/target, 1)))`. The planned e^κ curve was
  REJECTED during calibration: any curve that vanishes at the due date
  (R_eff = 1) starves consolidation, and any curve with the classic growth
  there cannot also vanish for cramming. At/before the due date the gain is
  exactly the pre-L1a growth (all consolidation gates keep their meaning);
  overdue recalls earn up to double (the surprising rescue). The cram signal
  lives on the LAPSE side.
- [x] **17.3 Failure update**: difficulty multiplier DELETED (W1 removed):
  `keep = clamp(1−R, 0.05, 0.5)` — crammed lapse keeps the 0.05 floor
  (harshest), on-time lapse keeps 0.1 (exactly the pre-L1a mid-difficulty
  behavior — the calibration anchor), overdue lapse keeps up to 0.5.
  Difficulty still rises (+0.4·fsrsWeight). Comment rewritten.
- [x] **17.4 Signature cleanup**: retentionProbability(S, elapsed) — unused
  difficulty param removed; applyRetentionDecay + all callers updated
  (fsrs.test, SrsRetention.test, curriculumBenchmark.test).
- [x] **17.5 Surprise-scaled quiz weakening**: weaken delta scales with the
  wrong recall's confidence (question.recall.score; fallback: producing
  trace strength). QUIZ_WEAKEN_FLOOR unchanged.
- [x] **17.6 Gates**: P0baseline.test.ts rewritten as the L1a direction
  suite (difficulty independence; crammed 0.05 / on-time 0.1 / overdue 0.5;
  success: no cram bonus, overdue bonus); fsrs.test.ts shape gates; full web
  unit suite 91/91 (1075 tests); ciGates 4/4; recallBenchmark pass;
  typecheck clean. (30-day sim runs with the Phase 19 train.ts migration.)

## Phase 18 — L1b: Surprise-scaled imprint + creative deltas (1–2d) — DONE

- [x] **18.1 SMF imprint**: `coherenceWeighting: 'floor' | 'linear'` option on
  PrimeActivityOptions (default 'floor'); `smfImprintWeighting` observer
  option passed at both imprint sites; core unit tests (incoherent moment:
  floor imprints at 0.1, linear at 0). GATE (smfImprintWeighting.test.ts):
  linear = floor at gate scale (recall 100% both, exact 10/10 both, fuzz FP
  0 both) → PRODUCTION FLIPPED to 'linear' in OBSERVER_OPTIONS. Doc block
  updated. (margin-bench re-run on the shipped record: Phase 24 sweep.)
- [x] **18.2 Creative delta scaling**: exported `creativeGradeDelta(score)` —
  margin beyond the gate, floored at 0.25 of the base delta, extremes
  reproduce pre-L1b magnitudes exactly; wired at creativeGradeFeedback,
  creditReAsk (full weaken extreme), creditRetention (full reinforce
  extreme × RETENTION_FRACTION). Helper property test in Conversation.test.ts.
- [x] **Gates**: web unit 91/91 suites (1077 tests) under the production
  'linear' flip; core 273; ciGates + recallBenchmark + semanticRecall pass;
  typecheck clean.

## Phase 19 — L3: One retention law; weights are memories too (3–4d) — DONE

- [x] **19.0 Schema umbrella**: RESOLVED AS ADDITIVE — all three schema
  changes (weight clocks 19.2, trust snapshot 20.4, edge tier 22.5) are
  optional fields, bidirectionally compatible; no version bump needed.
  Legacy records restore with clocks starting at the first sweep.
- [x] **19.1 Delete the legacy decay**: applyTimeDecay REMOVED from
  TeacherAgent; train.ts stale import+comment migrated (the sim already ran
  applyRetention); modelSettings halfLivesFor → dueHorizonsFor (FSRS
  horizons: fresh 1d · practised 5d · consolidated 30d, × rate);
  modelSettings.test rewritten to the one law; SettingsView copy + tests.
- [x] **19.2 Aged transition weights**: agedWeights.ts (bumpAgedWeights
  stamps every touched n-gram; decayAgedWeights → floor under the law,
  prune at floor, orphan-stamp cleanup; capAgedWeights 50k weakest-evict);
  all four TeacherAgent bump sites rewired; decay runs inside
  applyRetention() — THE one-law application point; clocks persisted
  additively (learningState + bootstrap `compositionWeightMeta`).
- [x] **19.3 Drive-weight drift**: behaviorOutcomeAt stamps in
  noteBehaviorOutcome; drift toward DEFAULT_BEHAVIOR_WEIGHTS at 90d
  stability in the same decay pass; persisted additively.
- [x] **19.4 Shared law module**: retention.ts (retentionProbability,
  dueIntervalDays, decayToward, STABILITY_PRESETS: ngram 45d · drive 90d ·
  non-word trace 7d · rule corroboration 30d); TeacherAgent re-exports for
  compat; rules/maintenance.ts horizon derived from the preset (parity).
- [x] **19.5 Gates**: agedWeights.test (9: law parity, decay/prune/cap,
  legacy-clock start, orphan cleanup); persistenceRoundTrip extended (weight
  clocks survive reload); full web suite 91 suites / 1086 tests; core 273;
  ciGates 4/4; typecheck clean. **30-day retention sim: 100/100 above
  threshold, consolidated 26 → 100** — and the sim itself was FIXED: it had
  a pre-existing silent bug (`state.dueAt -= DAY` mutated listWords()
  SNAPSHOTS — no word ever came due after day 1, so it measured decay
  without reviews and reported 0%). L1a's time-sensitive scheduler forced
  the discovery; clocks now shift on live states via tryState, including
  lastAskedAt/taughtAt so due-time lapses read as on-time, not crammed.

## Phase 20 — L2: The trust kernel and the emergent handover (4–6d) — DONE

- [x] **20.1 `trust.ts` — TrustKernel**: per-judge bucket+dimension evidence
  (the reliability model's structure, judge-parameterized); `trustLB` =
  Wilson lower bound over the blended posterior at the judge's effective
  evidence mass (mean over consulted cells — a sum would overcount the
  multi-cell bump). The PRIOR is a parameter: the LLM is the INCUMBENT
  (prior 0.65 counts as pseudo-evidence: an unmeasured teacher is trusted
  at ≈ 0.23); the composite is the NEWCOMER (prior 0: earns from zero).
  `fusionLambda` = T_c/(T_c + max(T_llm, 0.05)).
- [x] **20.2 Façade compatibility**: GraderReliabilityModel delegates every
  bucket to the kernel (judge 'llm'); zero call-site churn; snapshot keeps
  the legacy FLAT shape for the LLM + additive `judges` field for the rest;
  restore accepts old records byte-for-byte. All 26 reliability tests pass
  UNCHANGED. New surface: recordJudgeAgreement, lambdaFor, judgeTrust.
- [x] **20.3 The composite is a measured judge**: fadeReward checks the
  composite's band against the rule grounding band on every graded answer
  (only when it HAS an opinion: composite > 0 ∧ seeds exist — abstention
  earns no evidence); authored answers carry `compositeBand`, and the world
  channels measure it — re-ask contradicts a strong composite, retention
  confirms it (weight 0.25), under the same criteria as the LLM.
- [x] **20.4 λ = T_composite/(T_composite+T_llm) per bucket**: fade.ts
  REWRITTEN — HANDOVER_THRESHOLD, FADE_RATE, FADE_CEILING, FADE_FLOOR,
  FadeState, updateFadeState, effectiveLambda DELETED. isUncertain DELETED
  (subsumed: the composite is multiplicative, fluency 0 ⇒ composite 0 ⇒
  blendReward's pass-through guard — which is KEPT). λ derives from the
  kernel per fadeCriteria(cls). MIGRATION: legacy persisted fadeState.lambda
  seeds 20 samples of kernel evidence at the stored rate per class
  (restoreFromPersistence + importBootstrap) — earned handover survives the
  upgrade; new records carry no fadeState.
- [x] **20.5 Evidence plumbing**: noteFadeAgreement(cls, ρ) → kernel
  evidence (agree = ρ ≥ GRADE_STRONG_THRESHOLD) + raw-ρ telemetry
  (fadeAgreements()); teacherDependenceRate = 1 − traffic-weighted mean λ
  (a composite with no opinion counts as full consultation); classroom
  report card now prints λ · dep · ρ.
- [x] **20.6 Gates**: fade.test.ts rewritten (16 tests): Wilson mass↑ ⇒
  LB→rate; blind bucket λ = 0; incumbent prior ≈ 0.23 unmeasured; λ climbs
  monotonically under sustained agreement; EMERGENT CEILING (perfect
  agreement at finite mass < 0.95; equally-proven judges settle ≈ 0.5);
  REGRESSION (trust −0.2, λ below majority); HACK-RESISTANCE (world
  disagreements at 0.25 collapse trust despite self-flattery); blendReward
  guard; end-to-end TeacherAgent wiring. graderReliabilityBenchmark
  unchanged (2/2); ciGates 4/4; autonomous smoke pass; full teacher suites
  1022 green; typecheck clean.
- [ ] **20.7 Out of scope (follow-up)**: edge/rule corroboration + council
  member trust onto the same kernel.

## Phase 21 — M4: Drive-temperature arbitration (0.5–1d) — DONE

- [x] **21.1 Softmax selection**: Boltzmann sampling over the existing
  scores at `T = clamp(T_MIN + 0.5·curiosity + 0.5·novelty, 0.05, 1.0)`
  (behaviorTemperature). The hand-tuned `curiosity*2` is DELETED — every
  drive term carries coefficient 1; curiosity's urgency flows through the
  temperature. Sampling only WITH an rng: without one the choice is the
  exact argmax (the cold limit — legacy callers and tests unchanged).
- [x] **21.2 Wire-up**: TeacherAgent.chooseNext samples on a session-seeded
  mulberry32 stream (arbitrationRng) — production explores, reproducibly.
- [x] **21.3 Gates**: drives.test.ts 21 tests — temperature bounds
  (cold-calm → T_MIN, hot-curious/novel → T_MAX); argmax-compat without rng;
  COLD sampling never flips a clear gap (100 draws); HOT sampling explores
  (non-max mass); NO STARVATION (all four archetypes drawn in 500 hot
  draws); the acquired-set gate holds under sampling; all-unavailable →
  null. Full web suite 1099 green.

## Phase 22 — M5: Hypothesis-tier relations — proposer/validator split (3–4d) — DONE

- [x] **22.1 Data**: `Relation.tier?: 'asserted' | 'hypothesis'` (absent =
  asserted — every legacy edge).
- [x] **22.2 Proposers**: (a) the loose extraction feeds a standing
  HYPOTHESIS store (refreshHypothesisEdges on every relations rebuild):
  loose-only keys not asserted/negated/known, bounded FIFO (cap 2000 —
  MEASURED: 1083 loose-only edges over 1053 subjects at the full deck).
  (b/c) chaperone second-pass + co-occurrence proposers: deferred (the
  chaperone already adopts validated edges; its drop path is inside the
  schema validator).
- [x] **22.3 Query semantics**: hypothesis edges answer ONLY hedged ("I
  think ... but I have only one source for that"), one edge deep, blocked by
  the confirmed-false store, consulted only after operators + learned
  operators decline (chatAnswer step 2.55, provenance operatorId
  'hypothesis'). The one-hypothesis-hop rule is STRUCTURAL: hypotheses never
  enter relations(), so walks cannot cross them at all.
- [x] **22.4 Promotion**: addEdgeSource is the promotion gate — the second
  independent source class (conversation mining, chaperone agreement,
  world-feedback from a strong grade citing the edge) promotes the
  hypothesis into the asserted graph (chaperoneRelations, tier 'asserted',
  merged sourceClasses). Weak grades keep weakening via the existing
  bumpEdge path.
- [x] **22.5 Persistence**: `learningState.hypothesisEdges` (additive;
  legacy records re-propose from the loose extraction on next rebuild).
- [x] **22.6 Gates**: hypothesisTier.test.ts (7): propose (loose-only edge →
  hypothesis, asserted graph stays PURE), hedged-only answer with caveat,
  negation blocks, promotion on second class, world-grade promotion,
  round-trip, structural one-hop. COVERAGE MEASURED at the full deck:
  strict 57.7% of defined words carry an edge (the paper's 34% had drifted
  — extraction has improved since); +hypotheses = 60.4% (+1083 standing
  edges). adversarial 6/6 (0 false-yes); relations/chain/corroboration/
  Operators suites green; full web suite 1106; typecheck clean.

## Phase 23 — H6: Hebbian coupling experiment (4–6d, flag-gated) — DONE

- [x] **23.1 Core `HebbianCouplingStore`** (sentient-core): sparse symmetric
  learned coupling; potentiation at MOMENT time for co-excited winners
  `ΔK_ij = η·a_i·a_j·coherence·(1 − K_ij/kMax)` (saturating, symmetric);
  retention-law decay in sim time (piecewise, floor-pruned); ≤ neighbors
  per oscillator, weakest-evict. Applied in the phase sweep as
  `w_ij = 1 + K_ij`, row-mean renormalized. FAST PATH: Jacobi mean-field —
  the uniform part collapses to the Kuramoto identity in O(N), the learned
  part iterates the sparse rows (O(N + N·k̄) vs the control's O(N²));
  the dense sweep only for the rare inhibition×hebbian combination.
  Observer hook: a firing moment calls field.potentiateHebbian(coherence).
- [x] **23.2 Flag + serialization**: `hebbian {enabled, eta, kMax, neighbors,
  stabilityTime}` on field + observer options, default OFF — at off the
  store is never allocated and the tick path is untouched (bit-identity
  ASSERTED by test). hebbianSnapshot/restoreHebbian (compact triplets).
- [x] **23.3 Benches** (HebbianCoupling.test.ts, 8 gates): flag-off
  bit-identity (50-tick trajectory equality); saturating symmetric
  potentiation; retention decay shape + floor prune; neighbor caps;
  snapshot round-trip; SEMANTIC-RELATEDNESS separation — pair coupling
  0.983 vs never-co-excited stranger 0.000, probe lock-gap learned 0.634 <
  control 0.686 (the W9 claim, measured); observer integration (moments
  potentiate, metrics finite); tick latency +0.7% (budget +15%). Core 281 ·
  web 1106 green after dist rebuild.
- [ ] **23.4 Default-on discussion** (OPEN — the flag ships OFF): requires
  the heavy gates first — fuzz 0 FP, recall@1k/5k/20k within −0.3pt,
  honesty 44/44 with the flag on; then paper §3.1 + Appendix A tables.

## Phase 24 — Integration, calibration ledger, god-class extraction, docs (2–3d) — DONE

- [x] **24.1 Full sweep**: web unit suites green (1106 + new suites — calibration
  4, hypothesisTier 7, drives 21, agedWeights 9, fade 16, smfImprintWeighting,
  P0baseline); core 281 green; ciGates 4/4; recallBenchmark + semanticRecall
  pass; moderate benches 7/7 (scale/clusterMoment/competition/falsifier/
  fullDeckPruning); 30-day retention sim 100/100 after the sim fix;
  typechecks clean in both workspaces. (scale20k + serverParity remain
  special-run gates, unchanged by this round.)
- [x] **24.2 W13 chips landed**: fsrs.ts extracted (scheduler constants +
  reviewRetrievability + RetentionParams + applyRetentionDecay) alongside
  the earlier retention.ts / trust.ts / agedWeights.ts — 566 lines moved out
  of TeacherAgent into owned modules. TeacherAgent nonetheless measures
  6,149 lines (net +325: the L-series added trust wiring, aged-weight
  plumbing, legacy migration paths, and the hypothesis tier faster than
  extractions removed). The rest of the decomposition — relations, grade
  feedback, plans — is honest FOLLOW-UP; see the 2026-09 review's W13.
- [x] **24.3 Calibration ledger (W8, read-only)**: calibration.ts — bounded
  (500/gate) (score, outcome) samples with quantiles + a class SEPARATOR
  report (the measured quantity a hand threshold claims to approximate);
  wired at the quiz-recall gate (score vs verdict) and the creative-grade
  gate (score vs rule-band agreement); persisted additively; exposed via
  calibrationReport/gates. Gates switch to measured quantiles only in a
  follow-up after drift reports confirm the need.
- [x] **24.4 Docs**: observer-paper §3.1 (Hebbian experiment + measured
  separation), §3.3 (L1a surprise-scaled updates + the one-law decay of
  weights), §3.4 (drive temperature), §3.5 (hypothesis tier + corrected
  stale 34% → 57.7% coverage), §5.10 (sim fix + 100% result),
  §8.4 (the emergent handover LANDED paragraph). TODO baselines refreshed.
- [x] **24.5 W13 decomposition DONE**: TeacherAgent split per
  `docs/refactors/teacher-agent-split.md` — one commit per step, each gated
  by `tsc --noEmit` + the full web suite (95 suites / 1110 tests); the sweep
  adds ciGates 4/4. Zero logic change, zero renames, frozen public module
  surface (re-exports intact; plan.ts repointed to `agent/support` so the
  goal/rules mixins add no new runtime cycle). Final lines
  (`wc -l src/teacher/TeacherAgent.ts src/teacher/agent/*.ts`):
  TeacherAgent.ts 776; autoloop 183, base 464, conversation 338,
  creative 691, curriculum 169, goals 261, motivation 374, operators 48,
  persistence 1198, relations 665, rules 489, support 558, wordloop 771.
  persistence.ts exceeds the ~900 soft budget because restore/import/export
  are inherently the largest bodies; every other faculty file is ≤ ~775.
