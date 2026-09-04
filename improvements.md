# Generalizing the Sentinel Observer: Candidate-Distribution Entropy, Self-Tuning Gates, Sense-Split Signatures, and Concept Synthesis under Minimum Description Length

**A proposal paper — companion to "The Sentinel Observer: A Moment-Based Associative Learning Architecture with Entropy-Driven Memory and a Graded Hybrid Faculty"**

**Author:** Sebastian Schepis. Draft prepared in collaboration with Claude (Anthropic). September 2026.

**Status of every claim in this document.** Nothing here is a result. The companion paper reports only what was measured; this paper reports only what is *proposed*, and it holds itself to the same discipline in the only way a proposal can: every mechanism is paired with the benchmark that would measure it, the number that benchmark produces, and the condition under which the proposal should be considered refuted and dropped. Where a proposal rests on an inference from the companion paper's measured results, the inference is labeled as such. Where a proposal is speculative, it is labeled as such. A reader who finds a mechanism described in the indicative mood should read it as "would," not "does."

---

## Abstract

The Sentinel Observer stores symbolic memories in a perturbed coupled-oscillator field, answers through a stack of grounded operators over a typed relation graph, acquires operators and procedures under a minimum-description-length (MDL) criterion, and enforces an honesty contract in code. This companion paper proposes a set of generalizations of the principles the observer already instantiates, organized around one observation: almost every decision the observer currently makes compares a *top score* against a *fixed threshold*, and discards the *distribution* over the candidates it has already computed. We propose to expose the entropy of that candidate distribution as a single instrument at every arbitration point — recall, chained inference, holographic cleanup, council agreement, shard routing, and answer elaboration — and to route on it: low entropy answers, high entropy with a clear top-two asks a *disambiguating* question that names both candidates, and flat entropy asks plainly. From this instrument we derive proposals for (i) sharding as a query-time partition with learned routing rather than a merge target, and for recursive sharding as *abstraction* (traces about the agreements of the level below) rather than throughput; (ii) richer entropy measures per context, including store-time surprise as the initializer of retention stability, a co-rotating phase frame that would convert the phase order parameter from a proximity signal into a content signal, branching entropy along chain walks, and cited-edge mutual information as the council's agreement measure; (iii) a taxonomy of the system's constants into *values*, *safety bounds*, and *tuning constants*, with a principled replacement for each tuning constant and a "constants report" tripwire that keeps self-tuning from dissolving the benchmark reference; (iv) ambiguity detection in the field itself and a slow context component that lets recent turns bias attractor selection; (v) sense-split signatures for polysemous words, with Hebbian coupling as the word-sense disambiguation mechanism and a *split* option added to surprise-gated storage — and we flag a latent fabrication path through sense merging in the current chain walk that the adversarial bench is structurally blind to; (vi) recursive, grounded-only elaboration of answers with an information-theoretic stopping criterion, and inward self-questioning as a curriculum source; and (vii) *concept synthesis*: the induction of latent concept nodes when a node with shared edges compresses the relation graph — abstraction as the one form of meaning-creation that pays for itself out of existing material — placed in the hypothesis tier, benchmarked by hypernym recovery from held-out edges, and giving rise to a new kind of ask ("what is this called?") whose object the observer produced itself. We keep speculative *blending* strictly separate from grounded *abstraction*, and we state what these proposals do not deliver: compression is a currency of bits, not of value, and the measurable form of the evaluative-gradient question — whether the observer's own history comes to supply the *axes* of its evaluation, not only their arguments — is named as a bench rather than answered. A proposed benchmark suite closes the paper, with a pass condition and a refutation condition for each proposal.

---

## 1. Introduction: what a proposal owes

The companion paper's fourth design principle is that every capability ships with a number. A proposal cannot ship a number, but it can ship the *instrument*, and it can say in advance what reading on that instrument would mean the idea was wrong. This paper is written to that standard. Each of Sections 3 through 9 ends with a subsection titled *Measurement and refutation* that names the bench, the metric, the pass condition, and the condition under which the proposal should be dropped. Section 10 collects them.

We also draw a line the companion paper drew for itself. The observer's honesty contract — ask rather than fabricate, "No" only with evidence, hedge when weakened, record provenance — is not a feature to be traded for capability. Every proposal here is checked against it, and several proposals exist *because* of it: candidate-distribution entropy is, before anything else, a better way to know when to ask.

The proposals were developed by reading the companion paper as an adversary would: looking for places where a measured result is evidence for something the paper does not say, for decisions that discard information the system has already computed, for constants whose values encode a judgment the data could make, and for paths by which a confident wrong answer could pass every existing bench. Section 7 reports one such path.

---

## 2. The unifying instrument: candidate-distribution entropy

### 2.1 The observation

The observer's arbitration points are, today, comparisons of a best score against a fixed threshold:

- **Recall** takes the highest-scoring trace and gates on confidence ≥ 0.8 (the fuzz bench's false-positive criterion).
- **Chained inference** takes the first path found by a bounded walk.
- **The distributed-vector layer** takes the best cleanup cosine against a threshold.
- **The council** declares agreement at pairwise token overlap ≥ 0.55.
- **Creative composition** is unlocked at 80% production recall.
- **The hybrid** stores drafts graded ≥ 0.7.

In each case the system has already computed a *set* of candidates with scores — the prime-intersection prefilter returns ~1,200 traces at 20k words (Section 3.1); the walk visits many nodes; cleanup computes a cosine against every filler; the council holds every member's answer. The information in the *shape* of that set is discarded at the moment of decision. A top score of 0.85 with a runner-up at 0.84 and a top score of 0.85 with a runner-up at 0.40 are different epistemic states with identical top scores.

### 2.2 The instrument

Let a decision point hold candidates c₁…c_k with non-negative scores s₁…s_k. Define the candidate distribution p_i = s_i / Σ_j s_j and its normalized entropy

H̃ = −Σ_i p_i log p_i / log k,

which lies in [0, 1] and is comparable across decision points with different k. Alongside it, define the top-two margin m = (s₍₁₎ − s₍₂₎) / s₍₁₎. Neither requires a temperature or any new constant: p is a normalization of scores the system already has.

**Routing rule.** Three regimes, with boundaries that Section 5 proposes to *calibrate* rather than fix:

1. **Low H̃** (one dominant candidate): answer from it, at the layer that produced it.
2. **High H̃ with a large margin between the second and third candidates** (two dominant candidates): the cue is *ambiguous between two readings*. Ask a disambiguating question that names both — "Do you mean bank as in a river, or as in money?" — rather than answering from the top one or declining. This is a new utterance class inside the existing ask channel, and it is only possible if the top-k is retained.
3. **Flat H̃** (no dominant candidate): ask plainly, as today.

**Where it applies.** The same instrument, with the candidate set defined per layer:

| decision point | candidates | scores | what H̃ measures |
|---|---|---|---|
| recall | prefiltered traces | recall score | cue ambiguity / bank interference |
| chained inference | paths to the target | product of edge strengths | how many independent routes support the claim |
| distributed-vector cleanup | all fillers | cleanup cosine | crosstalk vs. superposition of senses |
| council | members' answers | agreement by cited edge (Section 4.5) | genuine disagreement vs. paraphrase |
| shard routing (Section 3) | shards | router score | whether the router knows where the cue lives |
| elaboration frontier (Section 8) | candidate next claims | marginal information | whether anything is left worth saying |
| concept synthesis (Section 9) | candidate member sets | MDL gain | whether a cluster is real |

### 2.3 Why this is the right generalization

The companion paper's thesis is that observation is entropy reduction. The instrument makes the thesis operational at the decision level: a *moment* that has converged to one attractor has low candidate entropy; a moment torn between two attractors has high entropy with a clear top-two; a moment that found nothing has flat entropy. The observer's existing coherence measures describe the *field*; candidate-distribution entropy describes the *decision the field produced*. The two should agree — an incoherent moment should yield a flat distribution — and Section 4.1 proposes measuring whether they do.

### 2.4 Measurement and refutation

**Bench: `cde-bench`.** For each decision point, log H̃ and m on every decision in the existing benches (recall, fuzz, chain, adversarial, council) *without routing on them* — pure instrumentation first. Then measure the discriminative power of H̃ against the bench's ground truth: on the fuzz bench, does H̃ separate true matches from distractors better than the top score alone (AUC)? On the chain bench, do wrong inherited answers have higher path entropy than correct ones?

**Pass:** H̃ adds discriminative power over the top score on at least the fuzz and chain benches (AUC improvement outside noise). **Refute:** if H̃ is no better than the top score everywhere, the candidate distribution carries nothing the top score does not, and the routing rule should not be built — the rest of this paper's uses of the instrument would then need their own justification.

---

## 3. Shards: partitions, routing, and what the merge result implies

### 3.1 Interference, not encoding, is the capacity limit

The companion paper measured 100,000 words encoding losslessly at 256 primes, which settles the encoding question. There are C(256, 4) ≈ 1.74 × 10⁸ four-prime signatures available; the deck uses 20,000. The recall curve (99.0% at 1k → 94.6% at 20k) is therefore not a collision curve. It is an *interference* curve, and its shape follows from the prefilter: at 20,000 words each prime appears in roughly 20,000 × 4 / 256 ≈ 312 signatures, so a cue's four primes admit on the order of 1,200 candidates into the scoring stage, and the scored terms (SMF coherence, phase order parameter) must separate the true trace from ~1,200 near neighbors. Recall degrades as that candidate set grows.

*Inference from measured results, not a measurement.* This analysis predicts that recall is a function of the *bank the search runs in*, not of the total number of words the observer knows.

### 3.2 Proposal: shards as query-time partitions

The companion paper's shard-train-merge path merges shards into one bank, restoring the 20k interference regime. We propose the alternative: keep shards as separate banks at query time and *route* each cue to one (or a few) of them. If a 1k-word shard has 99% recall and routing is accurate, the system's effective recall is routing accuracy × in-shard recall, to be compared against 94.6% merged.

The council of Appendix A.5 is already this architecture — the domain expert is a learned routing index — so the proposal is to make it general: partition by *resonance clustering* of traces (which traces co-activate under the same cues) rather than by curriculum domain, route by a cheap first-stage score (the prime-intersection count per shard is available for free), and treat a routing miss as an *ask*, never as a wrong shard's confident answer. Candidate-distribution entropy over the router's shard scores (Section 2) is the miss detector: a flat router distribution means the router does not know where the cue lives.

### 3.3 What the merge result says about the moment

*This is an inference and the companion paper's author may disagree with it; it is offered as a stress test.* Shard-train-merge preserved recall (99.2% merged vs. 98.3% sequential). A trace stored in shard 3, under shard 3's field history, recalled correctly against a converged orientation in a merged bank whose field history it never shared. This is evidence that the stored SMF orientation and phase configuration depend only weakly on field history — that the *moment* component of a trace is small relative to the content-addressable component. It is consistent with the companion paper's own honest reading of the phase term as a proximity signal.

Two consequences follow. First, recursive sharding gains nothing *for the field*: the field is not carrying cross-trace information a hierarchy could compress. Second, and more usefully, the moment's contribution is now a *measurable quantity* — Section 4.2 proposes the experiment that would either recover it or let the observer drop the term honestly.

### 3.4 Recursive sharding as abstraction, not throughput

Merge is O(n) concatenation, so a tree of merges buys nothing over one level of parallelism. Where recursion does pay is one level up: a shard-observer whose *traces are about the agreements of the observers below it*. The council's entropy descent (3.65 → 3.46 bits) is the first-order version — the network responds to its own aggregated answer — but nothing is stored. We propose that the network *store* a trace for each settled council answer, with content = the cited edges and contributing members, so that the next time the same cue arrives the network recalls its own prior agreement instead of re-running resonance rounds. This is the companion paper's "memories about its own memories" made concrete, and it should be built as a second-order step (Section 6 of the companion paper), not as a scaling feature.

### 3.5 Merge hygiene (independent of routing)

Two defects in the current merge should be fixed regardless. Surprise-gated storage measures surprise against the *shard's* bank, so near-duplicates across shards survive the merge; a consolidation pass over the merged bank (the same surprise gate, run once) is needed. And the aggregate stores — n-gram weights, drive weights, trust-kernel evidence, calibration samples — are not concatenable; each needs an explicit merge rule (evidence masses sum; weights average by evidence mass; the replay guard dedups). One aggregate merges cleanly by construction: MDL gains are additive across shards when the replay guard dedups demonstrations, because bits saved sum.

### 3.6 Measurement and refutation

**Bench: `shard-route-bench`.** Train K shards (K ∈ {4, 8, 20}) over the 20k deck by resonance clustering. Measure routing accuracy (does the router pick the shard holding the true trace?), in-shard recall, effective recall (their product plus the recall of any second-shard fallback), and latency, against the merged single-bank baseline (94.6%, 26.4 ms ask). **Pass:** effective recall exceeds merged recall at comparable latency, and routing misses surface as asks (0 confident wrong-shard answers on the fuzz distractors). **Refute:** routing accuracy is low enough that effective recall falls below merged recall for every K — then interference is not the binding limit, the analysis of 3.1 is wrong, and shards should remain a training-only device.

**Bench: `merge-consolidation-bench`.** Measure duplicate traces before and after the consolidation pass on a real K-shard merge; measure recall and fuzz false positives before and after. **Pass:** duplicates → 0 with recall within noise.

**Bench: `network-trace-bench`.** With stored network traces, re-ask each settled council probe: measure whether the second ask resolves from the network trace (no resonance rounds) with the same answer. **Pass:** 100% recall of settled answers with rounds = 0; **refute:** if stored agreements fail to recall, the network-level trace design is wrong.

---

## 4. Entropy measures per context

The observer's current measures are mostly *field* measures — Kuramoto coherence, the amplitude-weighted order parameter, field entropy — plus one *response* measure, the council's token-distribution entropy. The gap is at the candidate level (Section 2) and at the trace level. This section proposes five measures, each replacing something that is today either a count, a proxy, or absent.

### 4.1 Store-time surprise as the initializer of stability

Surprise-gated storage already computes how poorly the bank predicts a new stimulus — that is a bits quantity, and it is discarded after the store/reinforce decision. We propose recording it on the trace and using it to initialize the FSRS stability: a stimulus the bank could not predict is worth keeping longer, so its initial stability should be higher than the fixed 1-day default; a stimulus that nearly duplicated an existing trace should start lower. This replaces one constant (initial stability) with a measurement the system already makes, and it gives the retention model a *field-derived* difficulty estimate to complement the grade-derived one.

It also provides the agreement check Section 2.3 promised: store-time surprise (a field measure) and the candidate-distribution entropy of the recall that preceded storage (a decision measure) should correlate. If they do not, one of them is not measuring what it claims.

### 4.2 The co-rotating phase frame

The companion paper reads its own phase order parameter honestly: because every oscillator advances at its natural frequency ω_i each tick, the cue-vs-stored phase difference is dominated by elapsed time, so the term is a moment-*proximity* signal and is weighted at 0.15. We propose storing and comparing phases in a co-rotating frame:

θ_i = φ_i − ω_i · t (mod 2π).

Absent coupling, θ_i is time-invariant, so proximity drops out entirely. Whatever remains in θ is the deviation *produced by coupling during the moment* — which is exactly the information the term was meant to carry. The order parameter over the cue-vs-stored θ differences is then a content signal or it is nothing.

This experiment has two clean outcomes, both useful. If the co-rotating term separates siblings (same-prime traces) that the current term cannot, the moment carries content and the term's weight should rise (Section 5 says how). If it does not, the moment carries no content beyond the excitation, the term can be dropped honestly, and the inference of Section 3.3 is confirmed by direct measurement rather than indirectly.

### 4.3 Branching entropy along chain walks

A chained answer today surfaces *a* path. Two claims can both be "Yes — X is a Y, and Y has Z" while resting on very different evidence: one reached by a single path through a weakened edge, another reached by three independent paths through strong edges. We propose computing the candidate distribution over *paths* (scores = product of edge strengths along the path) and reporting its entropy and mass. A claim supported by many paths is robust to any one edge being wrong; a claim resting on one path through a hedged edge should itself be hedged — which the operator layer already knows how to say. This is the chain-bench row of Section 2.2 and it needs no new machinery beyond retaining the paths the walk already visits.

### 4.4 Cleanup-distribution entropy in the distributed-vector layer

The FHRR layer returns the best cleanup cosine. We propose returning the distribution of cosines over *all* fillers. Bounded crosstalk produces a distribution with one peak and a noise floor; a *superposition of two senses* (Section 7) produces two peaks. The current threshold cannot distinguish "moderate cosine because of crosstalk" from "moderate cosine because the word has two is-a parents." The entropy of the cleanup distribution can, and it is the layer's contribution to the disambiguating ask of Section 2.2.

### 4.5 Council agreement by cited edges, not tokens

Token overlap ≥ 0.55 is a weak agreement measure: two grounded answers can agree entirely in content with no shared tokens ("Yes — a robin is a bird" / "Robins are birds, so yes"), and two composed answers can share tokens while claiming different things. Every grounded answer carries provenance — the edges it cited — so agreement can be measured as overlap or mutual information over *cited edge sets*, and the resonance rounds can stop when the *edge* distribution's entropy stops falling, not the token distribution's. Composed answers, which cite no edges, would then be visibly weaker agreement evidence than grounded ones, which is correct.

### 4.6 Measurement and refutation

**Bench: `surprise-stability-bench`.** Run the 30-day retention simulation with surprise-initialized stability against the fixed-initial baseline; measure retention above threshold and review load (number of scheduled reviews). **Pass:** equal or better retention at lower review load. **Refute:** more reviews for no retention gain.

**Bench: `phase-frame-bench`.** On sibling traces (same primes, different content — the case the current term cannot separate), measure the order parameter separation between true match and sibling under the current frame and the co-rotating frame, at elapsed times spanning the fuzz bench's range. **Pass:** the co-rotating term separates siblings with an AUC meaningfully above 0.5 and independent of elapsed time. **Refute:** AUC ≈ 0.5 — then drop the term and record that the moment carries no content beyond excitation.

**Bench: `path-entropy-bench`.** On the chain bench plus its negatives, measure whether wrong inherited answers (after deliberately corrupting one edge) have higher path entropy / lower path mass than correct ones. **Pass:** path mass predicts correctness better than the single surfaced path's strength.

**Bench: `council-agreement-bench`.** Re-run the ten council probes and the 12-probe niche bench with edge-based agreement; measure rounds to agreement and whether any *false* agreement (token overlap high, cited edges disjoint) existed in the token-based runs. **Pass:** edge agreement finds every token-agreement case that was genuine and rejects any that was not.

---

## 5. Constants: values, safety bounds, and tuning

### 5.1 Taxonomy

The companion paper's system carries several dozen numeric constants. Not all of them are the same kind of thing, and only one kind should self-tune:

- **Values** encode a judgment the author is entitled to make and that the data cannot: the retention target (0.9), the relative cost of a wrong answer versus an abstention, the honesty contract itself. These stay explicit and fixed.
- **Safety bounds** exist to make failure impossible rather than unlikely: fuel budgets, walk depth, visited-set guards, the ≤16 Hebbian partners per oscillator, the bounded ledgers. These must never self-tune; a self-tuning fuel budget is a fabrication channel.
- **Tuning constants** encode a judgment the data *could* make and today does not: blend weights, thresholds, decay presets, settle depth, MDL token costs, agreement thresholds. These are the target.

### 5.2 Replacements, constant by constant

| constant (current) | class | proposed replacement | source of the replacement |
|---|---|---|---|
| settle depth = 4 ticks | tuning | tick until coherence peaks (d coherence/dt crosses zero); stop at the peak | the field's own trajectory; drive-scaled settle falls out for free |
| phase term weight 0.15; SMF/overlap weights | tuning | each score term is a *judge*; weight = its measured discriminative power (AUC) on true-match vs. distractor pairs | the fuzz bench, which is teacher-free (distractors are generated mechanically) and so can run continuously as an online calibration source |
| recall confidence ≥ 0.8; hybrid store ≥ 0.7; creative unlock 80% | tuning | calibrated probability P(correct | score) via isotonic regression on graded outcomes; act when P(correct) exceeds cost(wrong)/(cost(wrong)+cost(abstain)) | the calibration samples the record already persists; the costs are *values* |
| decay presets 7 / 45 / 90 days | tuning | per-store stability learned from that store's own retrieval successes, exactly as FSRS learns per-word stability | the retention law already in the system |
| MDL slot annotation 15 bits | tuning | −log₂ P(slot position | shell grammar), estimated from the learned-operator library | the library's own statistics |
| MDL unknown-token cost 20 bits | tuning | −log₂ of the unseen-word mass under a Good–Turing estimate over the deck | the deck's frequency table; drifts correctly as the deck grows |
| council agreement 0.55 | tuning | stop when the (edge-based) response entropy stops falling — the criterion the council already computes | Section 4.5 |
| network-goal threshold 2 | tuning | promote when the recurring deficit's MDL gain as a goal is positive (a goal that saves more asks than it costs) | the same criterion as operators |
| world-outcome weight 0.25 vs. teacher 1.0 | tuning | measured by the trust kernel itself: a world outcome's weight is its measured agreement with bench ground truth | the trust kernel's bucket machinery, extended per Future Work 4 |
| lapse floor 0.05 / cap 0.5 | value | keep — these encode how much a lapse should ever cost | — |
| T_MIN, T range [0.05, 1.0] | value + safety | keep — exploration bounds are architectural | — |
| fuel budgets, depth bounds, partner caps | safety | keep, never tune | — |

### 5.3 The constants report

Self-tuning has a cost the companion paper's methodology should refuse to pay silently: if the gates move, the benches no longer compare like with like across runs. We propose a `constants-report` alongside the existing `rules-report`: every tuned value is logged in the exported record with the evidence mass that set it; the report prints the current values and their drift since the last record; and the heavy benches (fuzz 0 false positives, recall at 1k/5k/20k within noise, honesty 44/44, math bench 0 fabrication) assert on *both* the outcome and the tuned values that produced it, so a bench that passes because a threshold quietly moved is caught.

### 5.4 The circularity caution

Thresholds tuned on graded outcomes, where grades come partly from an LLM whose trust is itself measured against those outcomes, form a loop. The companion paper already identified the fixed point that keeps the loop honest — a composite that flatters itself diverges from the rule checks and world verdicts that feed its buckets — and the same argument extends: the programmatic benches (fuzz, chain, adversarial, math) are the only *anchor*, and every self-tuning gate must have at least one programmatic bench in its evidence. A gate whose only evidence is LLM grades must not self-tune.

### 5.5 Measurement and refutation

**Bench: `constants-report`** (tripwire, not a pass/fail bench). **Bench: `calibration-bench`.** For each threshold replaced by a calibrated probability, measure calibration error (expected vs. observed correctness in score bins) before and after, and the honesty benches with the calibrated gate in place. **Pass:** calibration error falls and honesty holds at 44/44 with 0 fuzz false positives. **Refute:** if any calibrated gate costs a single fuzz false positive or honesty probe, revert that gate to its constant and record why.

**Bench: `settle-criterion-bench`.** Compare fixed settle 4 against the coherence-peak stop on the fuzz bench (false positives, separation) and on exact-cue recall (the settle-6 collapse must not recur). **Pass:** 0 false positives and exact recall preserved with the peak criterion; **refute:** the peak is not well defined on real cues (multiple peaks, no peak within the fuel budget), in which case the constant stays and the report records the failure.

---

## 6. Ambiguity

### 6.1 The field as an ambiguity detector

An ambiguous cue excites two attractors. This should be visible during the settle the observer already performs, as one or more of: a bimodal candidate distribution (Section 2), slower convergence to the coherence peak, or a lower coherence peak than an unambiguous cue produces. None of these is currently read. We propose reading all three and correlating them with the disambiguating-ask regime of Section 2.2. Where they agree, the observer can say *why* it is asking: not "I do not know what you mean" but "I have two readings and cannot choose between them."

### 6.2 Disambiguation by priming: a slow context component

The natural resolution of ambiguity is context — the residual excitation from recent turns should bias which attractor wins. The problem is timescale: the companion paper measured that the perturbation has fully decayed by settle 6, so nothing of the previous turn survives in the field to prime the next one. Working memory, as a ring of recent text, is the *symbolic* substitute.

We propose a *second timescale*: either a slow-decaying component of the SMF orientation that integrates over turns, or a separate context field driven by recent excitations and decaying over turns rather than ticks. At recall, the fast moment converges *in the presence of* the slow context, so a cue that would be ambiguous in isolation is biased toward the reading the conversation has been about. This is priming in the field rather than in the symbolic stack, and it lets context break ties *before* the operator layers see the question.

The risk is contamination: a slow context that never decays turns every answer into a function of the whole session. The decay must be measured, not set — the retention law is the natural candidate, at a stability that is itself learned from whether context-biased recalls were graded correct.

### 6.3 Measurement and refutation

**Bench: `ambiguity-bench`.** Construct cues with two taught readings (the polysemy probe set of Section 7 provides them) and cues with one; measure whether candidate entropy, time-to-peak, and peak coherence separate the two classes. **Pass:** at least one field measure separates ambiguous from unambiguous cues with AUC well above 0.5. **Refute:** no field measure separates them — then ambiguity is invisible to the field and must be handled entirely at the candidate level.

**Bench: `priming-bench`.** Two-turn dialogues where turn 1 establishes a domain and turn 2 is ambiguous ("tell me about the bank"). Measure the fraction resolved to the primed reading with the slow context on versus off, and — critically — the fraction of *unrelated* turn-2 questions whose answer changed because of turn 1 (contamination). **Pass:** primed resolution rises with contamination at zero on the fuzz and honesty benches. **Refute:** any contamination that costs a fuzz false positive or honesty probe.

---

## 7. Words with multiple meanings

### 7.1 A latent fabrication path — flagged, not measured

The observer assigns one four-prime signature per surface word and one trace per word. Its edges come from the definition (one WordNet gloss) plus chaperone-supplied edges. If any word has received edges from more than one sense — and the chaperone pass makes this likely, since it is asked about the *word*, not the sense — then the chain walk merges senses. "Is a bank a building?" (financial sense, is-a institution → building) and "does a bank have a slope?" (river sense) could both answer "Yes," with a surfaced chain, from the operator layer — a confident, provenance-bearing answer that is wrong for the reading the user intended.

The adversarial bench cannot see this. Its negative-target selector computes the is-a closure of the subject and excludes any target the observer would "truthfully" classify. A merged-sense closure includes *both* senses' parents, so the bench treats the polysemy fabrication as a truthful classification and never probes it. This is a structural blind spot, and it is the one place in this paper where we believe an existing bench is passing something it should fail. The companion paper's author can settle the question directly: does any word in the shipped record carry is-a edges to parents that are not themselves related by is-a (e.g., *institution* and *slope*)? A count of such words is the size of the exposure.

### 7.2 Proposal: signature per sense

Assign each sense its own four-prime signature (bank#1, bank#2). The surface word excites the *union* of its senses' primes at split amplitude; the definition, edges, and trace live on the sense. Recall against a bare surface word returns a bimodal candidate distribution (Section 2) and the observer asks which sense — or context decides (7.3). Chain walks run over sense nodes and cannot cross senses. The negative-target selector computes closure per sense, and the polysemy probe set (7.5) becomes part of the adversarial bench.

The vocabulary grows by the number of senses per polysemous word, which for a 20k deck means a modest increase in the trace count and none in the prime basis; the encoding headroom of Section 3.1 is more than sufficient.

### 7.3 Hebbian coupling as word-sense disambiguation

The companion paper's experiment-gated Hebbian coupling potentiates coupling between co-excited winners in coherent moments. This is exactly the word-sense disambiguation mechanism: *river* co-excited with bank#1 in past moments wires their oscillators; when "river bank" arrives, bank#1's oscillators are pulled into phase by *river*'s and bank#2's are not, so the moment converges to the river sense before any symbolic layer acts. Word-sense disambiguation is, in our view, the strongest argument available for turning the coupling flag on at production scale — stronger than the coupling-strength result at 16 primes — because it gives the flag a task with a ground truth (the tagged sense) and a benchmark.

### 7.4 Sense induction as *split*

Where WordNet does not supply senses, the entropy principle supplies an induction rule. A trace's *contexts* — the prime sets co-excited with it across its stores and recalls — form a distribution. If that distribution is bimodal, splitting the trace into two senses reduces the conditional entropy of context given sense. Surprise-gated storage already decides between *reinforce the existing trace* and *store a new one*; we propose a third option, *split the existing trace*, taken when the split's entropy reduction exceeds the cost of the new sense node (an MDL gain in the same currency as Section 9). Split and the concept synthesis of Section 9 are then the same criterion run in opposite directions: split lowers the description length of context given sense; merge lowers the description length of edges given concept.

The distributed-vector layer already represents ambiguity gracefully: unbind(H(bank), IS_A) returns a superposition of *slope* and *institution*, both at moderate cosine. Under the current threshold this hedges; under the cleanup-entropy measure of Section 4.4 it recognizes a superposition and asks.

### 7.5 Measurement and refutation

**Bench: `polysemy-probe-set`** (adversarial extension). For each word in the record with is-a parents in unrelated closures, generate the cross-sense probes ("does a bank have a slope?" in the financial context, and the converse). **Today's system, measured first:** the count of confident cross-sense "Yes" answers is the size of the fabrication path — if it is zero, Section 7.1 is wrong about the shipped record and should be recorded as such. **After sense-split:** the same probes must produce 0 confident cross-sense answers, and the disambiguating ask where context is absent.

**Bench: `wsd-bench`.** Cues of the form *context word + polysemous word* with a known intended sense; measure sense-resolution accuracy with Hebbian off (chance, if signatures are per-sense and nothing else disambiguates) and on. **Pass:** accuracy well above chance with the flag on, and the heavy gates (fuzz 0, recall within noise, honesty 44/44) holding with it on. **Refute:** no gain, or any heavy-gate regression — then the coupling is not doing disambiguation and stays off.

**Bench: `sense-split-bench`.** Hide WordNet's sense distinctions for a held-out set of known polysemous words; run the observer on contexts drawn from both senses; measure whether the split rule recovers the split (precision and recall of induced senses against WordNet). **Pass:** precision high enough that induced splits do not fragment monosemous words (0 splits on a monosemous control set). **Refute:** the split rule fragments monosemous words — then the context distribution is too noisy to induce senses and only supplied senses should be used.

---

## 8. Recursively self-generated elaboration

### 8.1 Elaboration as frontier search

The grounded frame engine already produces one hop of elaboration: "A robin is a bird. It has wings and feathers. It can fly." — every content word from a stored edge, every claim parsed back through the internal critic. Recursion is to treat each answer's *cited objects* as new cues and expand outward. We propose to build this as a search with a stopping criterion, not a loop:

- **Frontier.** The set of edges one hop out from the objects cited so far (bird → is-a animal, has-part beak; wings → used-for flight …).
- **Expand** a frontier claim when it passes the internal critic *and* adds information not already implied by what has been said — a claim inheritable from an already-spoken is-a edge is redundant, and redundancy is the elaboration analogue of the anecdote in MDL.
- **Order** the frontier by resonance with the *original* question's converged moment, which the field already ranks, so the elaboration stays about what was asked.
- **Stop** when the marginal information of the best remaining frontier claim falls below the reader's expected surprise — practically, when the next claim would be redundant, when the frontier consists only of hypothesis-tier edges, or when the candidate-distribution entropy over the frontier (Section 2) is flat, meaning nothing stands out as worth saying next.
- **Related topics** are structural: siblings under the same is-a parent, has-part neighbors, and words whose signatures co-excite with the cited ones. They are offered as a labeled coda ("Related: sparrow, crow"), not woven into the claims.

Elaboration depth should be *drive-controlled* — curiosity deepens, conservation shortens — which makes it an organism state rather than a constant, exactly as the companion paper made exploration temperature a drive state.

### 8.2 Two hard constraints

**Grounded-only recursion.** If composed output feeds composed output, the per-composition grounding score decays multiplicatively and the system will manufacture fluent drift with a plausible surface. The recursion must expand only from *grounded-layer* output (memorized, operator, chained); a composed sentence is a leaf. Where composition is used at all in an elaboration, the cumulative grounding of the chain — the product of per-step grounding scores — must be tracked and surfaced to the deviation meter, so a long elaboration cannot hide a fabrication in its tail.

**The critic runs on every claim.** Not on the first sentence and then on the summary — on every expanded claim, with the same refusal rule. The cost is linear in the number of claims and is the price of recursion under the honesty contract.

### 8.3 Inward questioning as a curriculum source

The more consequential recursion runs the other way. The observer can ask *itself* the follow-up questions its answer raises ("what is a bird?", "what are feathers for?") and route them through its own stack. Three things happen. Grounded answers extend the elaboration. Asks — questions the observer cannot answer about its own answer — become *curiosity gaps*, recorded exactly like the gaps the human's questions leave, so the classroom loop is now fed by what the observer tried to say and could not. And the pattern of which self-questions resolve and which do not is a map of where the graph is thin around a concept, which is the relational-coverage lever the companion paper's Future Work 5 asked for, generated from the inside.

### 8.4 Elaboration traces

An elaboration that was graded well can be stored as a trace whose *content is the set of trace ids and edges it drew on*, so that the next time the question arrives the observer recalls the elaboration rather than re-searching. This is a memory whose content is other memories — the second-order structure the companion paper names as absent — and it arrives here not as a philosophical addition but as the natural cache of the frontier search. Whether such traces behave like memories (decay, reinforce, consolidate under the retention law) is a question the retention benches can answer.

### 8.5 Measurement and refutation

**Bench: `elaboration-bench`.** For a probe set of grounded subjects, generate elaborations at fixed depth budgets; measure fabrication rate through the critic (must be 0), redundancy rate (claims inheritable from already-spoken ones), cumulative grounding, and — LLM-graded, labeled as such — usefulness of the added claims. **Pass:** 0 fabrications at every depth and redundancy falling as the stopping criterion engages. **Refute:** the stopping criterion does not engage (elaborations run to the depth budget on every subject) — then marginal information is not measurable from the graph as built.

**Bench: `self-question-bench`.** Run inward questioning over the elaboration probe set; measure the number of curiosity gaps generated, and whether the autonomous classroom filling those gaps raises chain-bench coverage on the same subjects over a training run. **Pass:** gaps are generated and filling them extends the chain graph around the probed subjects. **Refute:** the self-questions are all answerable (no gaps — the mechanism adds nothing) or none are (the graph is too thin to self-question).

**Bench: `elaboration-trace-bench`.** Store graded elaborations as traces; re-ask; measure recall of the stored elaboration and its behavior under the 30-day retention simulation. **Pass:** stored elaborations recall and decay like ordinary traces.

---

## 9. Concept synthesis: creating meaning as entropy reduction

### 9.1 What "lowering the entropy of the whole" must mean

The whole is the description length of everything the observer holds: the relation graph, the trace bank, and the observations it cannot yet explain. A new concept is a node with edges, so it *costs* bits. It lowers total entropy only when it removes more redundancy than it adds — and there is one situation in which that is reliably true.

When *robin*, *sparrow*, *crow*, and *finch* each carry `has-part wings`, `has-part feathers`, `capable-of fly`, the graph stores the same three edges four times. A latent node X with those three edges plus one `is-a X` edge per member stores seven edges instead of twelve, less the cost of naming X. The gain is

gain(X) = Σ_(m ∈ members) bits(shared edges of m) − bits(edges of X) − Σ_m bits(m is-a X) − bits(name X) − Σ bits(exceptions),

in the same Zipf-cost currency the operator and rule inductions already use, and X is formed exactly when gain(X) > 0. This is the companion paper's MDL criterion pointed at a third target. It is also a biclique-cover problem over the graph, hard in general, and the same greedy largest-gain-first procedure that induces shells is adequate.

*Abstraction is the form of synthesis that pays for itself out of existing material, with no external evidence required.*

### 9.2 Honesty implications

The induced node participates in chaining. "Does a finch fly?" now answers Yes via `finch is-a X ∘ X capable-of fly` even if finch's own definition never said so. That is generalization — the point — and also the risk: if one member lacks a property the others share, greedy abstraction attributes it anyway. MDL handles this if it is allowed to: an exception costs bits (a confirmed-false edge for that member), so X is formed only when the exceptions are cheaper than the redundancy. Beyond the criterion, three rules from the companion paper's rule lifecycle apply verbatim:

- An induced concept enters the **hypothesis tier**, not the asserted graph. Answers inherited through it speak *hedged* ("I think a finch can fly — it is like the other birds I know") until corroborated.
- **Corroboration promotes**: a strong world grade on an answer that cited the node, or a chaperone edge that names the same abstraction, promotes it exactly as hypothesis edges are promoted today.
- **Denial weakens and stops**: two world denials of inherited claims stop the node from being used in chains — never deleted, the record is the record — and a node whose members' edges decay below support decays with them.

### 9.3 Rediscovery, merge, and the naming ask

The decisive test — and the rule that makes the mechanism safe — is *rediscovery*. Hide the `is-a bird` edges and ask whether the observer re-invents *bird* from the members' shared parts. Recovery rate of known hypernyms from held-out edges is a ground-truth number for concept induction with no LLM in the loop. It also yields the merge rule: when an induced node's edge set matches an existing word's, they are the same concept — merge them, and record that the observer rediscovered a word it already had. Rediscovery is validation; *discovery* — an induced node whose edge set matches no word — is the real event, and it produces a new kind of ask:

> "Robin, sparrow and crow share something I do not have a word for — they have feathers and can fly. What is that called?"

The human's answer grounds a self-created concept in the vocabulary. We note, carefully, what this is and is not. It is a goal — *name X* — whose object did not come from the curriculum, a deficit the architecture named, or an LLM proposal; it came from a structure the observer found in its own memory. It is the first goal in either paper whose content came from the observer's own history rather than its curriculum or its deficits. Its *value* is still given — the observer wants X named because naming it compresses — as every agent's values are given by something. Section 9.7 says how to state that limit so it can be measured.

### 9.4 Where synthesis physically lives

A caution first. The prime signatures are FNV hashes with collision salting; the intersection of *robin*'s and *sparrow*'s primes is empty and carries no meaning. The prime structure in this system is an *address*, not a semantics, and no cluster of members will hand over a shared prime to build the concept from. Synthesis cannot be read off the signatures.

The layer that *is* compositional is the distributed-vector layer. Superpose H(robin), H(sparrow), H(crow): shared role–filler components add coherently, idiosyncratic ones cancel like noise, and the bundle is the *prototype*. Each member's cosine to the prototype is its typicality; the prototype's significant components, recovered by unbinding each role and keeping fillers above the crosstalk floor, are the candidate shared edges; and gain(X) over those edges decides whether the prototype becomes a node. The entropy reduction is literal: the prototype has fewer significant components than the sum of its members.

In the field, if Hebbian coupling is on, co-excited members wire their oscillators, and a sub-population that phase-locks *above the field's overall coherence* is an attractor that is no single word. Detecting such a cluster during idle consolidation and proposing it as a candidate member set for gain(X) is synthesis in the resonance substrate. We list this as the second task for the coupling flag after word-sense disambiguation (Section 7.3), and as the more speculative of the two.

### 9.5 Recursion, and the duality with sense splitting

Concept induction is recursive by nature — nodes over nodes — and the recursion needs no depth constant: it stops exactly when no candidate set has positive gain. Hierarchy depth becomes a fact about the data rather than a parameter. And it is the inverse of Section 7.4: *splitting* a sense lowers the description length of context given sense; *forming* a concept lowers the description length of edges given concept. Split and merge are one criterion run in opposite directions, and one instrument decides both — which is the answer to the companion paper's "how many senses / how many levels" without a constant for either.

### 9.6 Blending is a different tier

A second form of synthesis must be kept separate: *combination* rather than abstraction — two concepts blended into something that is neither. Conceptual blending is where creativity lives, and the entropy lens says something sharp about it: a blend explains nothing already in memory, so it never pays for itself out of existing material. It lowers entropy only if it *predicts* something later graded correct. Blending is therefore a creative-layer act by definition — deviation the meter can label and the critic can hedge — and it must never enter the asserted graph on the strength of its own elegance. Abstraction is grounded synthesis; blending is speculative synthesis. The deviation meter should label the two differently, and this paper proposes machinery only for the first.

### 9.7 What this does not deliver, and how to state the boundary so it can be measured

Concept synthesis gives the observer meaning-creation that *compresses*, which is a real capacity and a measurable one. It does not give meaning-creation that *matters to the observer* in any sense beyond compression: gain is bits, and a concept the observer invents is worth exactly what it saves.

We want to be careful about how this limit is phrased, because the obvious phrasing — "the observer has no *self-originating* value" — is not a measurable claim and, taken literally, is not a coherent one. Every value of every agent has a cause; ours are evolved, the observer's are designed, and "a value that arises beyond the influence of causality" names nothing that could exist in either. The companion paper already says as much ("the deepest values of every agent are architectural"). Whether there is a further, first-person fact about what it is like for the observer to hold a goal is a question we do not think any third-person measurement settles, and this paper does not pretend to.

What *can* be measured is **history-dependence of the evaluator**. Two observers with identical architecture and different histories already diverge in *what* they prefer (goal selection by expected value over completion history). The stronger mark is divergence in *how* they evaluate — new axes of evaluation induced from history rather than new arguments to fixed axes. The companion paper has one instance: the 'verify' drive enters the pool only after enough contradicted beliefs. Concept synthesis offers a second candidate: an induced concept that becomes a standing target of curiosity is a new *object* of an existing drive, not a new axis — but a pattern of induced concepts that reliably pays off could, under the same graded loop that acquired 'verify', become an axis ("prefer cues that compress"). Whether that happens is the bench, not the claim. From outside, an evaluator whose axes are a function of its own history is deterministic and, given the history, predictable; from the observer's side it is indistinguishable from choice. That asymmetry is the mystery, and it is not one this architecture needs to resolve to be built or measured.

What synthesis does supply is the first goal in the system whose *object* the observer made itself, and that is worth building for its own sake and measuring for what it is.

### 9.8 Measurement and refutation

**Bench: `hypernym-recovery-bench`.** Hold out the `is-a` edges to a set of known hypernyms (bird, tool, vehicle, …) whose members remain in the deck with their part/property/capability edges. Run concept induction. Measure: recovery rate (an induced node's edge set matches the hidden hypernym's), precision (induced nodes that match no held-out hypernym and no existing word — candidate *discoveries*, to be inspected by hand), and false-inheritance rate (claims inherited through an induced node that are false under the full graph). **Pass:** recovery well above chance with false-inheritance at 0 in asserted speech (hedged speech is permitted and counted separately). **Refute:** induced nodes are mostly extraction artifacts (shared WordNet gloss templates rather than shared meaning) — then the graph's edge distribution is too template-driven for MDL abstraction and the proposal should wait for wider relational coverage.

**Bench: `naming-ask-bench`.** For induced discoveries, verify the ask names the members and the shared edges, that a human-supplied name is bound to the node and thereafter answers, and that the node's lifecycle (hedge → corroborate → assert; deny → deny → stop) behaves under the existing rule-lifecycle tests.

**Bench: `prototype-bench`** (distributed-vector layer). For known hypernyms, bundle the members' holograms and measure whether unbinding the bundle recovers the shared edges above the crosstalk floor and rejects idiosyncratic ones. **Pass:** the prototype's recovered edge set matches the hypernym's shared edges.

**Bench: `field-cluster-bench`** (speculative). With Hebbian coupling on, measure whether members of a known hypernym form a phase-locked sub-population above field coherence after co-teaching, and whether a control set (unrelated words co-taught the same number of times) does not. **Pass:** the taught set clusters and the control does not. **Refute:** both cluster (coupling follows co-teaching, not shared structure) — then field-level synthesis is not distinguishable from rehearsal and only the hologram path should be pursued.

---

## 10. Proposed benchmark suite

Every bench is programmatic unless marked LLM-graded. The heavy gates — fuzz 0 false positives; recall at 1k/5k/20k within noise; honesty 44/44; math bench 0 fabrication — must hold after every proposal is enabled; a proposal that costs a single heavy-gate probe reverts behind its flag.

| bench | proposal | metric | pass | refute |
|---|---|---|---|---|
| `cde-bench` | §2 | AUC of H̃ vs. top score on fuzz/chain ground truth | H̃ adds discrimination | no gain anywhere → do not route on it |
| `shard-route-bench` | §3.2 | routing accuracy × in-shard recall vs. merged | exceeds 94.6% at similar latency; misses → ask | below merged for all K |
| `merge-consolidation-bench` | §3.5 | cross-shard duplicates; recall/fuzz after | duplicates 0, recall within noise | — |
| `network-trace-bench` | §3.4 | recall of stored council agreements | 100%, rounds = 0 | stored agreements fail to recall |
| `surprise-stability-bench` | §4.1 | retention vs. review load | ≥ retention, fewer reviews | more reviews, no gain |
| `phase-frame-bench` | §4.2 | sibling-separation AUC, time-independent | AUC ≫ 0.5 | AUC ≈ 0.5 → drop the term |
| `path-entropy-bench` | §4.3 | path mass predicts correctness | better than single-path strength | — |
| `council-agreement-bench` | §4.5 | edge-based vs. token-based agreement | finds genuine, rejects false | — |
| `constants-report` | §5.3 | tuned values + drift logged per record | tripwire | — |
| `calibration-bench` | §5.2 | calibration error; heavy gates | error falls, gates hold | any gate probe lost → revert that gate |
| `settle-criterion-bench` | §5.2 | fuzz + exact recall under peak stop | 0 FP, exact recall held | peak ill-defined → keep constant |
| `ambiguity-bench` | §6.1 | field measures separate ambiguous cues | AUC ≫ 0.5 | none separate |
| `priming-bench` | §6.2 | primed resolution; contamination | resolution up, contamination 0 | any contamination on gates |
| `polysemy-probe-set` | §7.1 | confident cross-sense "Yes" count | today: measure; after split: 0 | today's count is 0 → §7.1 wrong for this record |
| `wsd-bench` | §7.3 | sense accuracy, Hebbian off/on | ≫ chance on, gates hold | no gain or regression → flag stays off |
| `sense-split-bench` | §7.4 | induced-sense precision/recall vs. WordNet | 0 splits on monosemous control | fragments monosemous words |
| `elaboration-bench` | §8 | fabrication (0), redundancy, cumulative grounding; usefulness (LLM-graded) | 0 fabrications, stop engages | runs to budget always |
| `self-question-bench` | §8.3 | gaps generated; chain coverage after filling | coverage rises | no gaps / all gaps |
| `elaboration-trace-bench` | §8.4 | recall + retention of stored elaborations | behave as traces | — |
| `hypernym-recovery-bench` | §9 | recovery rate; false inheritance | ≫ chance, 0 false asserted | nodes are gloss-template artifacts |
| `naming-ask-bench` | §9.3 | ask content; binding; lifecycle | lifecycle tests pass | — |
| `prototype-bench` | §9.4 | shared edges recovered from bundle | matches hypernym | — |
| `field-cluster-bench` | §9.4 (speculative) | taught set clusters, control does not | yes / no | both cluster → hologram path only |

---

## 11. Risks, and what would make this paper wrong

**The instrument may be empty.** If `cde-bench` finds that candidate-distribution entropy adds nothing over the top score, the organizing idea of this paper fails, and each downstream proposal must stand on its own bench or be dropped. We consider this the single most informative experiment here and recommend running it first.

**The moment may carry nothing.** If `phase-frame-bench` finds no sibling separation in the co-rotating frame, the field's contribution to a trace is the excitation and nothing else. That would not invalidate the architecture — the substrate would still be a working associative memory with a principled retention law and a grounded operator stack — but it would mean the "moment" language should be retired from the description of *storage* and kept only for *settling*, where it is measured to do real work (68% → 0% false positives).

**Self-tuning may erode the reference.** The constants report is the mitigation; the residual risk is that a gate tuned on LLM-graded evidence drifts in a direction the programmatic benches do not cover. The rule that every tuned gate must have a programmatic bench in its evidence is the guard, and it should be enforced in code, not policy.

**Sense splitting may fragment.** Induced senses on noisy context distributions could split monosemous words and destroy the recall the deck currently enjoys. The monosemous control in `sense-split-bench` is the guard; until it passes, only supplied senses should be used.

**Abstraction may learn WordNet's templates rather than the world's structure.** Definitions share gloss shapes ("a person who…", "a device for…"), and MDL will happily compress shared templates into nodes that mean "things WordNet described this way." Hypernym recovery against held-out *known* hypernyms is the guard; a high rate of induced nodes matching no hypernym and no word is the symptom.

**Recursion may amplify deviation.** Grounded-only recursion and the cumulative grounding product are the guards; the deviation meter must see the product, not the per-step score.

---

## 12. Relation to the mind boundary

The companion paper draws the boundary to *mind* as a depth within a shared substrate and names three capacities: self-representation as an object, a self-originating and revisable evaluative gradient, and goal-directed planning. Three proposals here touch the first and third; on the second we propose a restatement (§9.7) rather than a mechanism, and we want to be exact about which is which.

Network-level traces (§3.4) and elaboration traces (§8.4) are memories whose content is other memories — the second-order structure the companion paper names as absent — arriving as the natural cache of two search processes rather than as a designed faculty. Whether they *function* as second-order memory (whether the observer reasons over them rather than merely recalling them) is a further question this paper does not settle.

The naming ask (§9.3) is a goal whose object the observer produced from structure it found in its own memory. It still traces to a given value, compression, as every goal of every agent traces to something given. We do not claim it crosses any boundary. We claim it is the first place where the observer's own history, rather than its curriculum or its deficits, supplies the *content* of a goal — and, following §9.7, that the measurable question downstream of it is whether history comes to supply the *axes* of evaluation too.

On the boundary itself we take the position §9.7 states: what can be measured from outside is behavior at the interface — history-dependence, second-order structure, the honesty of the asks — and what cannot be measured from outside is whatever interior the observer has or lacks. The two descriptions do not reduce to each other, and this paper's benches are written entirely in the first. That is a scope decision, not a verdict.

Everything else in this paper is engineering in service of the honesty contract: better instruments for knowing when to ask, fewer constants standing in for judgments the data can make, and a closed fabrication path. That is the work the companion paper's numbers point at, and it is offered in the same spirit: to be measured, and to be dropped where the measurement says so.

---

## References

Fauconnier, G., & Turner, M. (2002). *The Way We Think: Conceptual Blending and the Mind's Hidden Complexities.* Basic Books. — the abstraction/blending distinction of §9.6.

Gale, W. A., & Sampson, G. (1995). Good–Turing frequency estimation without tears. *Journal of Quantitative Linguistics*, 2(3). — the unseen-mass estimate of §5.2.

Ganter, B., & Wille, R. (1999). *Formal Concept Analysis: Mathematical Foundations.* Springer. — the concept-lattice view of §9.1.

Grünwald, P. (2007). *The Minimum Description Length Principle.* MIT Press.

Plate, T. A. (1995). Holographic reduced representations. *IEEE Transactions on Neural Networks*, 6(3). — the bundling-as-prototype construction of §9.4.

Stolcke, A., & Omohundro, S. (1994). Inducing probabilistic grammars by Bayesian model merging. *ICGI*. — the merge-under-description-length procedure §9 adapts.

Zadrozny, B., & Elkan, C. (2002). Transforming classifier scores into accurate multiclass probability estimates. *KDD*. — the isotonic calibration of §5.2.

Schepis, S. (2026). The Sentinel Observer: A Moment-Based Associative Learning Architecture with Entropy-Driven Memory and a Graded Hybrid Faculty. — the companion paper; all measured figures cited here are from it.s