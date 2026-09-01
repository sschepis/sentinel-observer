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

## 11. The contradiction sweep (measured results)

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
