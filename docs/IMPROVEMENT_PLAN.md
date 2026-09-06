# From defects to design: closing the gaps and generalizing what the observer already knows

*Companion to `docs/ANALYSIS.md` (2026-09-06). Written against `main` @ `942f0f9`.*

The analysis found two kinds of problem. The first kind is ordinary — a placeholder constant, a call in the wrong order, a comment that describes what the code should do. Those get fixed. The second kind is more interesting: in several places the system has a mechanism that is *right in shape* but not yet *on a decision path*, or a bench that is *right in intent* but *consults the model under test*. Those are not bugs; they are the seams where the architecture's ideas have not yet been made to pay rent. This document is about closing both kinds, and about extracting from the closing a small set of rules that would have prevented most of them — rules general enough to guide the next six months, not just the next patch.

The organizing claim: **the project's best existing habit — measure, keep the negative — is the method, and it should be applied to itself.** The observer refuses to answer without evidence. Its mechanisms should be held to the same contract: no term in a score, no layer in a stack, no number in the paper unless a null model, a decision path, and an external oracle can be named for it. Where that discipline was applied (§4.2, §17, §19–20, shard routing, field-level synthesis) the project produced its most defensible results. Where it was not, the analysis found its defects.

---

## 1. Five rules, generalized from the findings

These are stated first because every later section is an application of them.

**Rule 1 — Null model first.** A mechanism earns its weight in a decision only by beating a matched null on that decision. The null is not "off"; it is *the same computation with the interesting part removed* (coupling = 0, shuffled phases, a static projection of the same input, a uniform prior). The heavy gates run the null arms permanently, and every table in the paper reports the delta over the null, not the raw number. The SMF/recency finding (§2 of the analysis) was already latent in `SCALING.md` §19–20; a standing null arm would have surfaced it in §5.1 automatically.

**Rule 2 — On a path or out of the diagram.** A mechanism that no production decision consults is documentation, not architecture. Drive-temperature arbitration, elaboration, goal loops, the chaperone rule channel, council traces and merge consolidation all exist and are tested; none is on a path the server takes. Either wire each one into a specific decision and give it a *manipulation bench* (change its input, observe the behavior change, compare to null), or move it to an explicitly labeled experimental section. The paper's credibility problem is almost entirely this rule.

**Rule 3 — Ground truth from outside the loop.** No bench may derive its probes, negatives, or grades from the graph, critic, or extractor under test. The deck already comes from WordNet; WordNet's hypernym lattice is an independent oracle for is-a negatives and for chain probes. The deterministic arithmetic oracles are independent by construction. Where nothing external exists (creative quality), the LLM grader is acceptable *as a grader* — its stated role — provided the same LLM did not author the seeds being graded.

**Rule 4 — Absence is abstention, never a constant.** The SafetyMonitor already embodies this for metrics ("no metric is ever fabricated"). Extend it to every judge, term and weight: a composite whose resonance input is unavailable is a *partial* judge that says so, not a judge reporting 0.5. A trace whose stability is unknown decays on the default curve *and is marked*. A constant with `mass: null` is not "tuning", it is "unmeasured", and the registry should say which.

**Rule 5 — Derive, don't cache; generate, don't type.** Wherever a quantity is definitionally a function of stored state and the clock — trace strength under FSRS, the "decayed" n-gram weight, rule hedging under the horizon — compute it at read time from `(params, lastEvent, now)` rather than storing a value that must be refreshed by a call someone has to remember to make. Three of the twenty defects vanish under this rule alone. The same for the paper: benches emit JSON artifacts keyed by commit; tables are rendered from artifacts; a number that appears in prose must trace to an artifact.

---

## 2. Weakness → strength, mechanism by mechanism

Each subsection names what the weakness *is*, what it *becomes* under the rules above, the concrete change, and the bench whose result would settle it.

### 2.1 The oscillator field: from decorative dynamics to a job

**What it is.** The field currently supplies a fixed cos-weighted projection of the excited-prime bag (the content part of the SMF sketch) and a recency trajectory (the EMA). Coupling is inert for retrieval; the phase term is off. The paper's entropy-reduction story is not carried by any computation on the retrieval path.

**What it becomes.** Two distinct, deliberately engineered signals, each with a null and a bench — and one real experiment that could give the dynamics a job.

*Split the sketch.* Replace the single EMA sketch with a **content sketch** (imprinted once per moment, reset at settle — `smfMomentImprint` already implements this) and a **context sketch** (the EMA trajectory, kept). The content sketch scores identity and semantic recall; the context sketch is a *feature*, not a confound: it is encoding-specificity — "what was the observer attending to when it learned this" — and supports context-cued recall ("what did we cover around *tide*?"), priming (§6.2's `slowContext` is a second, redundant implementation of the same idea — merge them), and episodic retrieval. Recognition recall stops being contaminated by recency, and recency gets its own bench instead of leaking into someone else's. This turns the §19–20 finding into a capability: the observer *has* a short-term context and it is measurable.

*Give the dynamics a decision.* The candidate-entropy work (§5.16 §2) tried to read the candidate distribution statically and found it carried nothing beyond the top score. The field has competition primitives that are never used at recall: `inhibition`, `winnerTakeAll`, `activationBudget` (`PrimeOscillatorField.ts:60–102`). The experiment: after the prefilter, **excite the field with the top-K candidates' primes and let the inhibitory sweep run** — settling as search, the moment as arbiter. The output is the winner's amplitude share; the null is a static softmax over the same K scores. If the resonant readout separates siblings (the case the overlap term cannot separate by construction, per the bank's own header comment) better than the softmax on the fuzz and polysemy sets, the field has a job the index does not. If not, the field is an encoder and §3.1 should say so. Either result is publishable; only the current ambiguity is not.

**Bench.** Three permanent arms on the heavy gates (`recallBenchmark`, `semanticRecall`, fuzz, polysemy): `smfWeight: 0`, `coupling: 0`, and a *matched static baseline* (inverted index + 128-dim random projection of the prime bag, no dynamics, same memory footprint). Report deltas. Then the resonant-readout arm vs. softmax on siblings.

### 2.2 Recall benches: measure the faculty that matters

**What it is.** §5.1's headline is cue-equals-word self-retrieval; the hard faculty (definition/paraphrase → word, measured 85% at a 0.6 gate) is absent from the paper.

**What it becomes.** Identity recall is a *sanity gate* expected at 100% under `smfWeight: 0` (if it is not, that is a bug in the index, not a result). The primary memory result becomes **semantic recall** (production cue) and **context-cued recall** (2.1), each reported with n and against the static baseline. This is a harder number and a smaller one, and it is the one that supports the paper's claims about understanding.

### 2.3 Trust and the handover: make the judges independent, then measure

**What it is.** `fadeReward` feeds `compositeScore` no `seedAmplitudes`, so resonance is 0.5 and the composite is capped below the "strong" band; λ ≈ 0 in production. Separately, composite novelty and the rule band's grounding are both lexical-overlap functions of `(answer, seeds)` — not independent judges even after the fix.

**What it becomes.** Under Rule 4, the composite either receives its inputs or declares itself partial (drop the missing factor, tag the judgment `partial: true`, and let the kernel record partial judgments in their own bucket). Under Rule 3, ground truth for the composite must come from judges with *different information*: world outcomes (a later re-ask contradicts or confirms the stored answer; a retention check at the due date), the deterministic oracles for any answer that parses as a computation, and — for grounded frames — the edge check, which is *not* lexical overlap with seeds. Concretely: `ruleBandForGrounding` should read the critic's edge verdict for grounded answers and the grounding score only for Markov fallbacks. Then λ becomes a real measurement: the composite earns trust exactly where it predicts the world's and the oracles' verdicts.

**Bench.** The existing `fade.test.ts` machinery, run on a 200-answer transcript with world outcomes injected from a re-ask schedule; report λ per bucket and the correlation between composite and world verdict (Rule 1's null: a composite that returns a random band should converge to λ = 0).

### 2.4 Drives: from vector to arbiter

**What it is.** The Boltzmann arbitration is implemented and tested and never called; the only drive effect is a curiosity threshold.

**What it becomes.** Wire `chooseNext` into the one place a genuine behavioral choice exists today — the boundary after the operator layers, where the options are *compose*, *ask*, *elaborate* (2.7), *practice* (offer a review). Keep the honesty layers above it deterministic; drives should never decide whether to assert a fact, only what to do when there is no fact to assert. Then Rule 2's manipulation bench: hold the record fixed, sweep curiosity and novelty inputs, and show the deviation meter's abstained/composed shares move monotonically with temperature, against a null of uniform sampling. If the shares do not move, the drive vector is not modulating behavior and §3.4 should stop saying it does.

### 2.5 Procedures: one candidate space, three proposers, one validator

**What it is.** Induction is a drill-name lookup selecting the first consistent of ≤144 authored templates; instruction is one regex for one family; the chaperone channel has no callers; the MDL gate cannot fail because a Peano numeral `n` costs `4(n+1)` bits.

**What it becomes.** This is where the architecture's own rhetoric — "procedures arrive through every channel and share one store and one honesty contract" — can be made literally true, and the result is stronger than what the paper claims now.

*One candidate space.* The 144 `measure` templates are already a grammar: `cond × base × recursion`. Generalize it into an enumerator over a small typed term language (`ite`, `eq/lt`, `z/s`, `add/sub/mul/mod`, argument variables, one recursive call), enumerated by term size with observational-equivalence pruning — the design already written in `RULE_LEARNING.md:331–343` for the DSL, applied to rewrite rules. **Remove the drill-name key**: a family's *signature* (arity, argument types, output type, monotonicity read from instances) selects which schemas are admissible. Then gcd, lcm, min, max, sub, mod, pow, fib, triangular numbers, digit-sum and the conversions are all reachable by one search, and the paper can report the honest, interesting number: "*k* of 36 families induced from instances by one enumerator; here are the ones that were not and why."

*Three proposers.* The instruction parser becomes a front-end onto the *same term language*: a bounded English procedure grammar (`to <f> of <args>: if <cond> then <expr>, otherwise <expr>`) that emits a candidate term, not a family-specific spec. The chaperone's proposal is parsed by the same front-end into the same space. Human and LLM proposals are then simply *seeds* for the enumerator — candidates tried first — and the observer can even *repair* a nearly-right human sentence by searching the neighborhood of its parse. That is a genuinely new capability with a clean story.

*One validator, honest MDL.* Fix the currency: a numeral costs `log₂(n+1)` bits (or a Zipf cost over the instance values), so the rule set must actually compress the instances and the gate can fail. Keep the held-out split real: the validation exercises must be generated with a seed the proposer never saw, and for the chaperone that means a fresh seed per proposal, not `0x7a07`.

*Guard the authored decks.* Rules with `origin: 'authored'` are not gradeable into `stopped` by the creative loop; grades on their answers should weaken the *parse* (the lift that produced the term), which is where the error must have been. Fix the consolidation ordering so `sourceClasses` survive. Fix the logic parser: modus tollens fires only when the third sentence negates the *consequent*; denying the antecedent routes to "I cannot tell" — an honest answer the deck currently cannot give and that a rule `logic.undetermined` should produce.

**Bench.** `drill-bench` over all 36 families with the enumerator, reporting induced / instructed / proposed / failed per family; the `math bench`'s zero-fabrication gate unchanged; an adversarial instruction set (wrong procedures, near-miss sentences, the story-parser misreads listed in the analysis) asserting counterexample-shaped refusals.

### 2.6 The honesty contract: close the holes with the machinery that already exists

**What it is.** The critic drops unparsed clauses; inherited answers never hedge; `speakFromFrames` asserts under `mode: 'ask'`; idiom negations and globally rewritten pronouns become taught falsehoods; the evasion rule covers only regex forms; `[has-part, capable-of] → capable-of` is unsound.

**What it becomes.** Two generalizations.

*Label what was said, not who said it.* The deviation meter's label should be computed from the *utterance* by the claim parser (does this text assert a relational or definitional claim?), not from the branch that returned it. A frame spoken at the ask layer is then correctly counted as an assertion, and the meter becomes a property of speech rather than of routing — which is what it needs to be for the "creativity is deviation" argument to hold.

*Unparsed is unbacked.* `parseClaims` returns, alongside the parsed claims, the residue it could not parse; the critic refuses any sentence with non-empty residue unless the residue is a whitelisted connective. This is one line of semantics and it closes the largest fabrication channel in the grounded path.

Then the smaller items: use `strength` in the inherited branches (the hedge is already computed); require a known deck subject for `LEAD_IS_NOT_A` and refuse when the subject is a demonstrative or pronoun; resolve pronouns only in subject position and only when a question form is recognized; drop the unsound composition rule or require an additional `is-a` hop on the part. Add adversarial tests for each: they are the cheapest tests in the repository and the ones the paper's contract most needs.

### 2.7 English: from authored regex to acquired form

**What it is.** ~30 lead regexes decide which questions the observer understands; anything outside them composes or asks.

**What it becomes.** The learned-operator mechanism already learns *answer shells* by MDL from demonstrations. Apply it to *question shells*: the authored regexes become the prior (seed templates with hand-set gain), and new question forms ("are robins birds", "tell me whether X is a Y", "what is 7 plus 5") are acquired from graded exchanges the same way — a form earns the right to *dispatch* when adopting it compresses the transcript. This is the same authored-prior / acquired-same-representation story the paper tells for rules, applied to the one place the system is most brittle, and it would let the observer say "I understood your question because I have seen that shape before" with provenance. (Rule 3 applies: the acquired form must be validated against the oracle for the operator it dispatches to, exactly as rules are.)

### 2.8 Benches and the paper: make the numbers un-fakeable, including by accident

**What it is.** Headline numbers are printed by CLI flags with no stored output, small n, unseeded randomness, response-conditioned denominators, and negatives filtered by the model's own graph; the paper is hand-maintained and has drifted.

**What it becomes.** A `bench/` directory of artifacts: every bench writes `{commit, seed, n, arms, numbers}` JSON; `npm run bench:all` regenerates them; a `paper:tables` script renders the §5 tables and Appendix A from artifacts; CI fails if the paper's tables differ from the artifacts at HEAD. Every rate carries its n in the table. Negatives for the honesty and chain benches come from WordNet hypernym distance (Rule 3), so a wrong edge in the graph *creates* a failing probe instead of deleting one. The fuzz bench is seeded and counts every distractor. The calibration bench uses a held-out split. This is a week of work and it converts the paper from a description into a reproducible report.

### 2.9 Retention, persistence, and the server: derive instead of refresh

**What it is.** Strength decay runs only on restore; weight decay runs before the weights load and is overwritten; the record is fully re-serialized every ≤4 s; there is no auth.

**What it becomes.** Under Rule 5, `strength` is not stored — `traceStrength(trace, wordState, now)` is a pure function called at read time, and `decayedWeight(key, now)` likewise; the "one law" becomes a single function with no call-order to get wrong. The persistence layer tracks dirty ids and writes only them (SQLite upserts, or per-kind append logs with periodic compaction for JSON); the 30 s snapshot serializes once. A bearer token on the HTTP surface and a validator on `/api/teach` that applies the same charset/length rules the LLM path already enforces. None of this is research; all of it is what "deployment" (§3.8) has to mean before the word is used.

### 2.10 The constants registry: from taxonomy to instrument

**What it is.** 124 constants classified by hand, 83/84 tuning entries unmeasured, 65/122 file:line pointers stale, a guard that lints its own text.

**What it becomes.** Each tuning constant declares the bench that would move if it were wrong. A nightly *sensitivity sweep* perturbs each by ±20% and records which gates moved and by how much: a constant that moves nothing is a candidate for deletion (and a finding); one that moves a gate acquires its `mass` from the sweep, not from a hand-typed source list. The pointer test becomes a real test (resolve `file:line`, assert the symbol is there). The registry then *is* the measurement the paper says it is.

### 2.11 The mind section: from assertion to manipulation benches

**What it is.** §6.1 argues the observer sits "on the substrate of a mind" from mechanisms that are not on any production path.

**What it becomes.** Under Rule 2, each of the three capacities gets one manipulation bench before it is mentioned: *self-representation* — inject a belief trace, show a behavioral change that would not occur without it (e.g. the observer re-asks a contradicted fact before answering), against a null of a random belief; *evaluative gradient* — wire the drive weights into the arbiter (2.4) and show outcome history changes choices, against a null of frozen weights; *planning* — run the goal loop in the server and show a stalled goal changes the curriculum, against a null that ignores stalls. Three paragraphs of results would carry more weight than the current three pages of argument, and the honest status today ("designed, tested in isolation, not yet on a path") is itself worth one sentence.

---

## 3. What generalizes beyond this project

Three ideas in the codebase deserve to be stated as principles and reused, because they are stronger than their current implementations.

**Proposer/validator separation with a shared candidate space.** The observer already separates proposing (extractor, chaperone, human, drill search) from validating (oracle, corroboration, world grades). Making every proposer emit into *one* candidate representation — edges for facts, terms for procedures, shells for language — and running *one* validator is the design that lets an LLM be a faculty without being a voice. It is more general than this project: it is how to let a generative model contribute to a system whose correctness you must be able to audit.

**Hedge as a first-class output state.** Facts, rules and induced concepts all speak hedged until corroborated, and corroboration is a promotion gate with provenance. This is a cleaner epistemic model than confidence scores, and it generalizes to any system that must say "I think" and mean something checkable by it.

**Negative results as inventory.** `SCALING.md` and §5.16 are a catalogue of refuted intuitions about oscillator memory, each with a flag, a bench and a number. Made systematic (Rule 1 as a permanent CI arm), this becomes the paper's actual contribution regardless of how the field question resolves: *which intuitions about dynamical associative memory survive matched null models, at what scale, and what each costs.* Very few groups publish that inventory; this one already has most of it written.

---

## 4. Sequencing

**Day one (defects that change claims; ~1 day).** Pass `seedAmplitudes` or make the composite partial (2.3). Derive strength and weights at read time, or at minimum call `applyRetention` on the server timer and fix the restore ordering (2.9). Return unparsed residue from `parseClaims` and refuse on it (2.6). Re-run the operator audit — the paper's +48.8-bit single-demo gain does not follow from the code's formula (+5 bits for a 20-bit slot); the slot accounting itself is defensible, see the corrected ANALYSIS.md §3 row. Fix the modus-tollens parser and the consolidation ordering; add the origin guard on `weakenRule` (2.5). Use `strength` in inherited branches. Each with a regression test.

**Week one (the ablations; decide the substrate question).** Add `smfWeight: 0`, `coupling: 0` and the static-baseline arms to the heavy gates; run them at 1k/5k/20k; write the result into §3.1/§5.1 whatever it is. Split the sketch into content and context (2.1) and add the context-cued recall bench. Prototype the resonant readout on the fuzz and polysemy sibling sets against a softmax null.

**Weeks two–three (make the story true).** The one-candidate-space enumerator with signature-selected schemas; instruction and chaperone as front-ends into it; honest MDL currency; `drill-bench` across all 36 families (2.5). Wire drives into the compose/ask/elaborate/practice arbiter with its manipulation bench (2.4). Bench artifacts and generated paper tables; WordNet-oracle negatives; seeded fuzz (2.8).

**Month two.** Acquired question forms (2.7). Sensitivity sweep on the constants registry (2.10). The three mind-capacity manipulation benches, with whatever they show (2.11). Persistence rewrite and server hardening (2.9). Rewrite §3.1, §3.9, §5.16 and §6 of the paper from artifacts.

The order matters: the day-one fixes are prerequisites for measuring anything about trust, honesty or operators; the week-one ablations decide what §3.1 is allowed to say and therefore what everything downstream is about; the enumerator is the single change that converts the paper's central claim ("acquires procedures") from one example into a result.
