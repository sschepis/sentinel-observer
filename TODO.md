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
