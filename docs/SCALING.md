# Scaling Sentinel: from 12 words to a working vocabulary

*Design proposal grounded in measured limits of the current system.*

---

## 1. The real bottlenecks (measured, not guessed)

| Constraint | Measured value | Consequence at scale |
|---|---|---|
| Field prime basis | default `primeCount = 16` (max 256, library has 100 default primes) | every word folds to a multiset over **16 primes**; distinct words collide into identical cues at hundreds of words |
| Unknown-word encoding | `wordToPrimes` hashes each CHARACTER positionally | 'apple' vs 'apply' share ~4 of 5 chars → nearly identical prime cues; the observer literally cannot tell them apart |
| Per-trace memory | holographic basis ≈ `slots × gridSize × 16B` → **~17 KB per trace** at 16/64 | 1,000 words ≈ 17 MB (ok); 10,000 ≈ 170 MB (not ok in a browser) |
| Recall cost | O(N × gridSize) | 10K traces × 64 ≈ 640K flops per recall — compute is fine; **memory and discrimination** are the problems |
| Session persistence | none — everything dies on reload | a vocabulary that forgets the browser tab closed is a toy |
| Content | 12 hand-authored words | no curriculum, no levels, no real vocabulary |

The system does not scale by adding more words. It scales by fixing **encoding
discrimination**, **trace memory**, and **persistence** — in that order.

## 2. The three scaling pillars

### A. Encoding: words get real signatures

- Assign each deck word **2–4 primes from the 256-prime space via a whole-word
  hash** (FNV-1a over the word string), not per-character hashing. 'apple' and
  'apply' then get unrelated signatures.
- Raise `primeCount` to 32–64 (the field capacity exists: `MAX_PRIME_COUNT =
  1024`, grid ≤ 4096). More field primes = fewer cue collisions.
- Keep an **encoding table** (word → primes) persisted with the deck, built
  offline by a deck-builder tool — reproducible, auditable, no runtime magic.

Acceptance test: for any two deck words, their prime signatures differ in at
least one prime (collision audit), and top-1 recall accuracy on a 500-word
deck stays above a measured baseline (see §4).

### B. Memory: lean traces + candidate filtering

- **Lean traces**: stop storing a 17 KB holographic pattern per trace. Store
  per trace: content, SMF sketch vector, prime signature, amplitudes, and the
  moment's sparse phase configuration — ~1.2 KB at the 128-dim width with q8
  serialization (the phase pair adds ~a few hundred bytes for the active
  primes). Keep the holographic layer for the *session field*; for ranking,
  combine SMF cosine (gated by the cue moment's coherence) + prime-overlap +
  the phase order parameter of the cue-vs-stored phase-difference ensemble —
  the lean replacement for the per-trace holographic correlation.
- **Candidate prefiltering**: recall first selects traces whose prime
  signatures overlap the cue (a Map from prime → trace ids). At 10K words a
  cue touches dozens, not 10K.
- The existing `SemanticMemoryBank` stays for small decks; a new
  `CompactMemoryBank` (same interface, additive) carries the scale.

### C. Persistence: the observer survives the night

- Dexie (IndexedDB): word states, lean traces, encoding table, diary
  entries, review queue, session history.
- Load: restore traces + states on start; save on teach/grade/decay events.
- The observer's learning record becomes **cumulative across days** — which
  is what turns spaced repetition from a demo into a tool.
- **Episodic memory**: salient facts about the human (user facts, vocabulary
  mastery/failure, recurring topics, session gaps) persist across restarts —
  bounded by a salience policy, tagged as remembered at retrieval, never raw
  transcripts (the working window stays session-scoped by design). See
  `docs/OBSERVER_INTERFACES.md` §7.

## 3. Content pipeline (real curriculum)

1. **Word lists**: public-domain frequency data (e.g., wordfrequency.info
   style lists) → 1K / 3K / 5K most-common words, tagged by CEFR level where
   available.
2. **Definitions + examples**: Wiktionary dump (CC BY-SA) and Tatoeba (CC BY
   2.0) — bundled with attribution.
3. **Deck builder tool** (offline script): ingest → clean → assign prime
   signatures → collision audit → emit `deck-v1.json` + encoding table.
4. Levels: 12-word starter (today) → 100 (phase 1) → 1,000 (phase 2) →
   5,000 (phase 3).

## 4. Measuring "useful" (acceptance metrics)

The honest yardstick is the observer's demonstrated competence, measured the
same way we'd test a student:

- **Top-1 recall accuracy** on a held-out quiz: target ≥ 80% at 500 words,
  ≥ 70% at 5,000.
- **Retention after N days** (needs persistence): strength of traces learned
  a week ago.
- **Discrimination**: minimal number of "confused pair" recalls (apple for
  apply) — the collision audit.
- **Latency**: recall + grade under 100 ms at full deck size in a browser.

These become CI/benchmark runs, not feelings.

## 5. Roadmap

| Phase | Deliverable | Scale |
|---|---|---|
| 1 | Persistence (Dexie) + deck loader + 100-word deck; teach/grade/decay across reloads | 100 |
| 2 | Whole-word hash encoding + `primeCount` 32–64 + collision audit | 1,000 |
| 3 | `CompactMemoryBank` (lean traces + prefilter) + benchmark suite | 5,000 |
| 4 | Decay-driven SRS intervals + progress reports (retention curves, weekly review counts) | 5,000 |
| 5 | Voice: STT/TTS conversation with the observer | 5,000 |
| 6 | Episodic memory: salient facts, vocabulary mastery/failure, recurring topics, and session-gap context persist across restarts (bounded, salience-ranked) | all |

Phases 1–3 are each independently shippable; every phase lands with its
acceptance metric in CI.

## 6. Honesty at scale

The same contract, now with bigger numbers: the observer's competence is
*reported as measured recall accuracy and retention*, never as
understanding. If the 5,000-word accuracy target cannot be met with the
current physics, the system will say so — that finding itself is useful
engineering.

## 7. Phase 2 — measured results

Phase 2 is implemented and measured (30-word benchmark, jest, real kernel):

| Change | Top-1 recognition accuracy |
|---|---|
| Baseline (16-prime field, per-character hashing, lesson-text excitation, no field settling) | **6.7%** |
| Whole-word signatures (FNV-1a, 3 primes/word, 32-prime field) + `settleField()` between lessons + word-only excitation + SMF imprint on teach/ask | **80.0%** |

The 6.7% baseline was the honest demonstration that the original recall path
could not discriminate — traces were contaminated by un-decayed amplitude
from every previous lesson, so the earliest traces won every correlation.
The fixes are all real physics: settling the field, focusing the excitation
on the word's own signature, and imprinting the SMF.

Remaining confusion pairs (6/30: apple/make, work/morning, sleep/friend,
eat/friend, walk/apple, answer/apple) were 16-dim SMF orientation collisions
between distinct 3-prime signatures — the fold imprinted `axis = j mod 16`,
aliasing 16 oscillators onto each axis.

## 8. Phase 3 — projection fix (P3, measured results)

The fold is replaced by a seeded signed random projection (JL) and the SMF
sketch width is configurable. Measured on the same recognition gates:

| Sketch | 1k words | 20k vocab (400 probes) | B/trace (q8) |
|---|---|---|---|
| fold-16 (legacy) | 99.8% | 99.3% | 999 |
| jl-16 | 99.7% | **91.0%** | 1001 |
| jl-64 | 99.8% | 99.0% | 938 |
| **jl-128 (production)** | **99.8%** | **99.8%** | **1147** |
| jl-256 | 99.8% | 99.8% | 1570 |

The width-16 projection is a REGRESSION: the fold's mod-16 grouping acted as a
regularizer correlated with the prime overlap. The knee is width 128 — it
beats the fold baseline at 20k (99.8% vs 99.3%, 1 confusion vs 3) and stays
under the 2048 B/trace footprint gate via q8 fixed-point SMF serialization
(components stored as [-127, 127] integers + a scale factor, direction
preserved to 7 bits; 100% restore-fidelity recall on re-import).

The full `SemanticMemoryBank`'s fold-era weights (0.6 SMF / 0.4 holographic)
let the decorrelated JL sketch tip recognitions (30-word gate 76.7% → 53.3%).
Re-balanced to 0.4 / 0.6 — the holographic term is the strong exact-prime
signal; SMF stays a subordinate context cue — the 30-word gate went to 100.0%.

CI gates: 100 unique deck signatures (collision audit), ≥ 70% top-1 on 30
words (now 100.0%), ≥ 70% on 1,000 (99.8%), and ≥ 70% on 400 probes of the
20,000-word vocabulary at the production sketch width (99.8%).

## 9. Phases 4-6 — the knowledge-acquisition stack (measured results)

**Structured relation supply (P4).** The chaperone emits schema-validated
{subject, predicate, object} edges in a second pass over accepted
definitions, adding six answerable predicates (has-property, capable-of,
used-for, causes, opposite-of, requires) on top of the four prose-extractable
ones and the technical curriculum's. A same-predicate disagreement with the
precision-first extractor is never a silent override — it becomes a
`relation-conflict` belief that feeds the verification drive. Every edge
carries provenance (regex / authored / chaperone).

**Distributed-vector relations (P1).** A frequency-domain HRR (FHRR) layer
binds each word's edges into one complex vector (H(robin) = IS_A ⊛ bird +
HAS_PART ⊛ wings + CAPABLE_OF ⊛ fly); queries are unbind + cleanup, chaining
is repeated unbind, and the hologram binds a LOOSER extraction (objects need
only be content words) so graph-silent questions degrade to a scored hedge
instead of a hard ask. Measured: 14/14 graph-silent derivable questions
answered at **0.0% false positives** on a negative probe set (gate < 2%).
Calibrated thresholds: cosine ≥ 0.5 → "I believe so", ≥ 0.32 → "Probably",
below → ask.

**Executable rule induction (P2).** The drill loop, which measured
**16/16 memorized / 0 induced** at baseline, now searches a tiny composable
DSL over the taught instances when a drill returns memorized: a program
consistent with them, cheaper than the instances themselves (the same MDL
criterion), and accurate on the held-out set is compiled into a first-class
operator. Measured (24-concept bench, one round each): **12 rule-induced
+ 0 induced + 11 memorized + 1 unlearned** — addition, subtraction,
multiplication, division, remainder, inequality, order-of-operations,
absolute value, factor, even number, square, and percent each compiled an
executable rule that answers fresh prompts ("What is 47 + 32?" → "The
answer is 79.", "What is 12 percent of 400?" → "The answer is 48."; the
measurement families — minute, second, liter, gram, and volume conversion
— join the compiled set on their rounds). percent and volume became
inducible once the DSL enumeration's per-operator budget stopped
starving div/mul-based programs; place-value stays memorized honestly
(its prompts have no parser).

**The dispatch order** (chatAnswer): clock/date → memorized → operators
(symbolic graph, then graded holographic fallback) → learned operators →
compiled rules → creative → ask → hybrid. The ASK-rate audit over a 12-probe
corpus spanning every layer: **17% ask (the two genuine unknowns), 83%
zero-LLM answers**.

Cross-feature: chaperone-supplied edges feed the hologram traces (P4 → P1);
legacy 16-dim and production 128-dim traces both restore through the same
bank (the fromArray width rule + q8 encoding marker); compiled rules and
chaperone relations survive bootstrap export/import.

## 10. Phases 7-10 — integrity and grounded fluency (measured results)

**Answer provenance (P7).** Every answer records its producer — the memory
trace ids, the typed edges cited, and the operator identity — and a bounded
grade ledger (200 entries, persisted) names exactly what a bad grade should
weaken. Measured: a wrong quiz grade now weakens the producing trace itself
(−0.1, floor-gated) instead of only the contradicted belief; the ledger and
the world-feedback credit map (`authoredAnswers`) survive export/import.

**Confidence-weighted edges + confirmed-false store (P8).** Edges carry a
strength: 1 per stated source, +1 for chaperone agreement, ±0.2 per grade of
an answer that cited them. A weakened edge answers hedged ("Probably, robin
is a bird."), never confident; a taught "golf is not a bird" (or a
strong-graded negative) records a confirmed-false entry, and the question
answers "No, golf is not a bird — I was taught that." with evidence. Measured
on the relations bench: **4/4 negated probes answered No with evidence, while
the unnegated negatives stay 0/10 false positives** — the absence-of-evidence
rule holds by construction.

**Grounded generation + internal critic (P5).** Creative composition is now
grounded-first: typed frames filled from the relation graph ("A robin is a
bird. It has wings and feathers."), every candidate parsed back through a
claim grammar and refused unless every claim is backed by a stored edge
(direct, inherited, or the negation store). The Markov path is demoted to a
labeled fallback, and the composition PRNG is seeded for reproducibility.
Measured on `npm run grounded-bench` (10 probes): **fabrication rate 0/5 in
grounded answers — PASS**, 63% grounded / 37% labeled fallback.

**Relation-hole templates (P6).** The echo learner's honesty guard admits a
content word beyond the slot only when it is derivable from the slot via a
stored edge — "a robin is a bird" learns `{slot} is a {p:is-a}`, the hole
resolved from the graph at fire time (an edge that vanished since learning
declines the operator). Pure echo behavior is unchanged; the extended
vocabulary-boundedness audit names the hole objects as allowed.

**Dispatch order (final):** clock/date → negation statements (teach) →
memorized → operators (symbolic graph → confirmed-false "No" → graded
holographic fallback) → learned operators (relation-hole templates) →
compiled rules → creative (grounded frames + critic → labeled Markov
fallback) → ask → hybrid. ASK-rate audit: **17% ask (the two genuine
unknowns), 83% zero-LLM answers**, unchanged across all seven phases.

## 11. Difficulty-targeted curriculum (measured results)

The lesson queue is now a scored ranking, not a static script
(`curriculum.ts`). Four signals combine into one per-word priority score,
and the FSRS schedule stays the primary contract — due words are reviewed
before new words are taught; the curriculum orders **within** each pool,
never against it:

1. **FSRS difficulty** — the scheduler's learned per-item difficulty, plus
   how overdue a word is **relative to the interval it was scheduled for**
   (a word two interval-days late has decayed to ≈0.55 retention; a
   30-day-interval word one day late is still ≈0.87). "Most-due-past-
   desired" means overdue-per-interval, not raw wall-clock lateness.
2. **Sparse semantic neighborhoods** — the count of other deck words
   sharing at least one `semanticSignature.ts` prime. Isolated words (few
   active edges, no resonance partners) are taught first.
3. **Repeated gaps** — a persisted per-word review history (capped at 24,
   rides the existing word-state persistence) so items that keep appearing
   in review sets and keep failing rise to the front, across sessions.
4. **Weak drills** — concepts whose `technical/drill.ts` rounds keep
   returning unlearned/memorized instead of induced/rule-induced. The
   failure count is persisted with the learning state; induction clears it.

A fifth component, `waiting` (absolute days past due, capped at 14), is the
**fairness floor**: the relative-overdue term saturates for short-interval
words, and without it a perpetually-failing word could starve a merely-
overdue one forever.

**Wiring.** `TeacherAgent.nextReview()` / `nextNewWord()` consume the
scored queue (a `curriculum: { enabled: false }` constructor flag restores
the pre-curriculum scheduler verbatim — the benchmark control); `plan.ts`
`chooseGoal(goals, teacher)` multiplies a goal's expected value by up to
1.5× when its target is hard/overdue/isolated/weak; `nextDrillConcept`
prefers failing concepts; the classroom loop records every drill verdict
via `recordDrillResult`. New API exports from `teacher/index.ts`.

**Benchmark** (`curriculumBenchmark.test.ts`): two real TeacherAgents — the
production curriculum scheduler vs the legacy control — run the same
30-word deck through a **deterministic** failure model (fail-prone words
miss their first 3 reviews, then succeed; no randomness, so the runs
differ in exactly one thing: the queue ordering). Proxies:

| Proxy | Legacy scheduler | Curriculum | Delta |
|---|---|---|---|
| Weak words recovered by session 22 | **2/8** (at session 22) | **8/8** (mean session 12.9) | 6 words, ~9 sessions earlier |
| Mean days past due at hard-word review | 15.2 | **13.2** | −13% |
| Predicted retention at hard-word review | 0.279 | **0.341** | +22% |
| Mean neighborhood degree of first 8 taught | 1.38 | **0.88** | −36% (sparse first) |

The recall gates are unchanged: recallBenchmark **100.0%** (30/30),
scaleBenchmark **99.8%** (998/1000), SrsRetention and the full suite green.

**Caveats, honestly reported.** (a) The curriculum deliberately
concentrates reviews on hard items — in the benchmark it reviewed hard
words 78 times vs 50 for the control, so the absolute count of
low-retention reviews is higher even though mean retention improves; that
share is reported, not asserted. (b) A recovered word keeps a high
priority until its collapsed stability rebuilds through successive correct
reviews — the FSRS model itself says its retention decays in under a day,
so the attention is the schedule working, not a defect. (c) Repeated
failures genuinely perturb the field: after three injected misses a real
word's recognition recall dropped from ~100% to ~60% (apple began
confusing with `learn`). The benchmark therefore delivers model-correct
verdicts as the word's own trace — the field's recognition noise is not
the variable under test. The queue ordering, FSRS updates, reinforcement
and ledger all run the real production path.

## 12. The grader reliability model — where the LLM teacher is trusted

The teacher grades two ways: rule-based checks (quiz trace identity, the
deterministic drill verifier, the composition grounding check) that are exact
but narrow, and LLM semantic grades (0..1 quality scores on creative/hybrid
answers) that are broad but fallible. The reliability model learns WHERE the
LLM grade is unreliable and weights feedback accordingly
(`apps/web/src/teacher/reliability.ts`).

**Bucketing.** Every grade is keyed by four criteria: answer type
(definition / spelling / creative / drill …), the FSRS difficulty band of the
graded material (from the scheduler's [1, 10] difficulty), the question
template (fade classification), and the LLM provider. Evidence is recorded
per full tuple and per dimension, and a bucket's reliability is a
Bayesian-smoothed blend over the fallback chain (full tuple → dimensions →
prior 0.65) — a sparse bucket leans on its dimensions, a cold bucket returns
the prior.

**Evidence channels.**
- *LLM vs rule check* (weight 1): the LLM grade's band (≥0.7 strong, ≤0.3
  weak) against the grounding check's band (fabrication → weak, echo → mid,
  grounded composition → strong — the creative gold set's own banding).
- *World feedback* (weight 0.25, the world confirms slowly): a re-ask
  contradicting a strong grade, a retention confirming it.
- *Re-grade resolutions*: the outcome of every scheduled disagreement.

**Weight application.** `feedbackWeight(bucket)` = 1 while measured
reliability ≥ prior (evidence never earned distrust), then falls linearly to
a 0.1 floor. The weight scales feedback DELTAS only — P8 edge confidence
bumps (±0.2), trace reinforcement, composition-weight gradients, and the
FSRS stability/difficulty updates in `TeacherAgent.grade` — never the
grade's BAND, so a damped grade can never silently change class (a strong
0.9 × 0.5 = 0.45 would look mid and unlearn the answer). At the prior the
weight is exactly 1: **no behavior change without evidence — the SRS
retention curve is untouched by default** (verified: SrsRetention and fsrs
suites pass unchanged).

**Re-grade loop.** A rule-check disagreement schedules a pending re-grade
(bounded queue, persisted) instead of silently overruling the teacher:
`teacher.graderReliability().pendingRegrades()` is the confirmation UI's
queue, `resolveRegrade(id, agreed)` records the outcome into the same stats.
The classroom loop reports the disagreement as a `regrade` event with the
applied weight; the chat UI appends "the internal check disagrees (re-grade
pending)" to the grade feedback.

**Exposure.** `teacher.graderReliability()` and
`teacher.reliabilityOf(utterance, answerType, difficulty, provider)` give the
corroboration and curriculum modules the bucket's evidence (samples,
agreement rate, reliability, weight) before they act on grade-sourced
evidence. The model persists with the learning state (export/import and
IndexedDB), so distrust learned in one session survives into the next.

**Measured** (`graderReliabilityBenchmark.test.ts`, seeded, weighted vs
unweighted arms over 400 simulated grades with a reliable bucket at 0.9
truth-agreement and a flaky one at 0.35):

| Metric | Unweighted baseline | Reliability-weighted | Δ |
|---|---|---|---|
| Feedback accuracy (mean \|edge delta − truth\|) | 1.800 | 1.652 | **−8.2%** |
| Retention of true-strong reinforcement (kept/truth) | 0.202 | 0.250 | +0.048 |
| Retention of true-weak weakening (kept/truth) | 0.259 | 0.296 | +0.037 |
| Learned reliability — reliable bucket / flaky bucket | — | 0.649 (weight 1.00) / 0.376 (weight 0.62) | — |

The model learns the buckets (the flaky provider's grades earn weight 0.62
while the reliable one keeps full weight), and the weighted arm lands closer
to the truth on both the graph and the memory. Caveats: the rule check
(grounding) is a proxy for correctness, not correctness itself — a
well-grounded fabrication is still graded strong by both; and the re-grade
queue is only as good as the confirmations it receives (deferred regrades
leave the damped weight in place, which is the conservative direction).
## 13. The contradiction sweep (measured results)

**The gap.** The relation graph grows from three sources (regex extraction,
the authored curricula, the Chaperone) and the confirmed-false store (P8)
grows from taught and graded denials. Each source is precision-first on its
own, but nothing reconciles them at rest: a positive edge and a denial for
the same claim can sit in the graph silently, and inheritance (chain.ts)
can hand a subject an edge its own ancestor denies. P8 already makes the
observer answer "No" when a denial exists — but the contradicting positive
edge is still asserted underneath, answering hedged or "Yes" in paths that
read before the negation store.

**The sweep.** `contradictions.ts` (pure) + `sweep.ts` (integration):

- **Detection** — every (subject, predicate, object) claim asserted both
  positively and negatively, in four shapes: `direct` (the subject asserts
  and denies the same claim), `explicit-positive` (the subject asserts an
  edge an is-a ancestor denies), `explicit-negative` (the subject denies a
  claim an is-a ancestor asserts), and `inherited` (two ancestors disagree
  about the subject). The support gate (positive strength ≥ 0.5) means a
  positive edge weakened to the floor by wrong grades is no longer a live
  claim — the sweep stops reporting it. Measured on the layered en-20000
  deck: **12,357 edges + 62 negation claims swept in ~110–270 ms** (one
  build of the is-a map and per-holder indexes; the naive per-subject scan
  took ~42 s and was replaced).
- **Triage** — each conflict is scored by the evidence behind both sides:
  `severity = (0.45·positive + 0.35·negative + 0.2·provenance + corrob) ×
  directness`, where positive = strength evidence, negative = denial origin
  weight (taught > graded), provenance = regex > authored > chaperone,
  corrob = corroborating sources, directness = direct > explicit-negative >
  explicit-positive > inherited. The queue is severity-ranked, so the most
  strongly-evidenced disagreement is verified first.
- **Scheduling** — each item becomes a P4 `relation-conflict` belief (the
  verify-belief goal's completion predicate reads it) and a `verify-belief`
  goal at severity-ranked priority (plan.ts), and the probe is drilled as
  an `Exercise` in the exact shape `technical/verify.ts` grades: the
  observer answers the probe from its own graph, the world's yes/no is
  marked by the deterministic verifier (no model in the loop).
- **Resolution** — the world's verdict edits the edges and the bookkeeping
  so the sweep does not re-report: **positive wins** retracts the losing
  denial and reinforces the winning edge (+0.2); **negative wins** weakens
  the losing positive below the support floor (−0.7, below 0.5 for a
  single-source edge). The resolution is recorded in the P7 grade ledger
  (its producer is exactly the contested edge) and the conflict id enters a
  ONE-SHOT resolution ledger (capped, persisted with the learning state):
  the same evidence pair never ping-pongs the queue, even when a
  corroborated edge cannot fall below the floor in one step.

**Measured on the real decks** (`npm run sweep-bench`, en-20000 layered +
negation deck):

| Sweep | Found | Resolved | Re-reported | Latent (no-sweep baseline) |
|---|---|---|---|---|
| school-fact verdicts (negative wins) | **8** | **8** | **0** | 8 |
| positive-wins verdicts (retraction path) | **8** | **8** | **0** | 8 |

The 8 found conflicts trace to two real defects in the deck, which is the
point: the sweep surfaces disagreements the sources never reconciled.

1. **dolphin is-a fish (direct).** The en-20000 WordNet entry defines the
   dolphinfish sense ("large slender food and game fish..."), extracting a
   `dolphin is-a fish` edge that directly contradicts the negation deck's
   taught "dolphin is not a fish". The deck and the school-fact curriculum
   disagree; the sweep makes the disagreement a verification item instead
   of a silent split.
2. **planet is-a star (extraction artifact) → 6 inherited conflicts.** The
   WordNet gloss "a large nearly round body orbiting a star..." extracts
   `planet is-a star` (the head-noun scan lands on "star", not "body").
   With "star is not a planet" taught, every planet (earth, mars, saturn,
   venus, jupiter, exoplanet) inherits star's denial of being a planet
   while asserting it explicitly — and earth itself denies "is a star"
   while inheriting it from planet. The sweep attributes each of the 7
   disagreements to its exact holder, so a single resolution (weaken the
   `planet is-a star` artifact) settles the whole cluster.

**Caveats.** The sweep reads the SYMBOLIC graph only — the loose
distributed-vector layer (P1) is deliberately out of scope, since it is
graded, never asserted. Resolutions are one-shot by design: a denial
re-taught after a full positive-wins resolution stays out of the queue
(no ping-pong), though it still answers through the P8 negation store.
A corroborated edge needs repeated denials to fall below the floor — the
overlay's −0.9 floor caps a single step — after which the ledger carries
the resolution. Extraction artifacts like `planet is-a star` are real
finds, but the durable fix is in the definitions (the sweep is the alarm,
not the repair).
## 14. Auto-sharding memory: reorganization by reduced entropy

**The measurement.** Retrieval interference is an entropy: for every
trace-as-cue, the candidates it competes with are the other traces in its
retrieval NEIGHBORHOOD, and the reading is the mean `log2(1 + candidates)` —
a cue that sees 2^k siblings carries k bits of candidate competition
diluting its recall score. The neighborhood is defined by the SMF sketch
cosine (>= 0.7), NOT by prime sharing: every moment the observer stores
carries the full active basis, so prime sets are a clique and cannot
discriminate — the compact bank's own contract already says sibling
discrimination rides on the SMF term alone. The 0.7 threshold sits above
the sketch projection's ~0.5 similarity floor between distinct axes.

**The mechanism** (`packages/sentient-core/src/semantic/ShardedMemoryBank.ts`,
`memoryMode: 'autoshard'`):

- every shard is an ordinary `CompactMemoryBank` — recall semantics are
  untouched, only the candidate set narrows;
- a trace's HOME shard is the one whose prime vocabulary it overlaps most
  (deterministic, and identical on bootstrap restore);
- recall ROUTES by the shard's SMF prototype (the normalized mean sketch),
  falling through to the runner-up when the top route is empty and merging
  both when they are within 0.1 cosine — the same discriminator recall
  ranks by, since prime-vocabulary routing degenerates on the clique;
- AUTO-SPLIT (amortized, every 48 stores) proposes a deterministic
  2-way k-medoid partition refined by an entropy-guided local search that
  moves a trace only when the move strictly lowers total interference;
- the HONEST GATE: a split is adopted only when it beats BOTH the current
  interference AND the **random-split baseline** of the same shard sizes.
  A homogeneous shard always halves its candidates when bisected — that
  "reduction" is chance, not organization, and the baseline rejects it.
  Without this gate the sharder bisected clones and recall collapsed to 7%
  competency (measured), because half the cues routed to a shard that did
  not hold their trace;
- MERGE folds a starved shard (< 24 traces) into its nearest neighbor when
  the result stays within the entropy budget; `reorganize()` re-partitions
  everything across k−1 / k / k+1 and keeps the lowest-entropy option that
  respects the budget.

**Measured** (`conversationShardBenchmark.test.ts`, 150 words + the 728-pair
conversation curriculum, single compact bank as the control):

| | single bank | auto-shard |
|---|---|---|
| conversation competency | 66.2% | 66.1% |
| retrieval interference | 4893.7 bits | **3890.9 bits (−20.5%)** |
| shards | 1 | 2 (439t/4.69b, 439t/4.18b) |
| training wall-clock | 56.7s | 57.5s |

The organization is real (−20.5% interference at parity competency and
parity cost). What it does NOT do: the paraphrase probes ("good morning",
"how is it going") fail identically in both arms (0/10) — sharding narrows
the candidate set but does not lift a cue over the 0.8 identity gate when
the sketch space itself does not separate the paraphrase family. That
limit belongs to the signature scheme, not the partition.
