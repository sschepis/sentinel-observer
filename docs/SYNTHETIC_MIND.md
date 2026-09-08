# From here to a synthetic mind — gap analysis and plan

*2026-09-08. Companion to TASKS.md (the task list, §5 below is mirrored there as tasks 39–58), ANALYSIS.md, IMPROVEMENT_PLAN.md and NULL_ARMS.md.*

## 1. The target, stated so it can fail

The goal is a synthetic mind: a system that self-organizes and learns in real time, more the way a person learns than the way current AI is trained — and that can say it does not know when it does not know, with a checkable guarantee that it does not hallucinate.

The principle behind the design, restated so it applies to the observer as built rather than to the physics that inspired it:

> A connected system's internal entropy drops as a function of the mutual observational capability of its elements. Coupling lowers information entropy by opening a communication channel between elements. What an element is and what its phase represents is context dependent; the substrate does not have to be literal.

For that to be a design specification rather than a slogan, three things have to be pinned down for the observer specifically — and the observer as built already answers all three:

| Term | In the physical model | In the observer |
|---|---|---|
| **element** | an oscillator | a **concept**: a word with its definition, relations, memories and beliefs |
| **coupling / channel** | phase coupling between oscillators | a **relation edge** — the ability to observe one concept from another (`dog is-a mammal` lets what is known of mammals be read from dog); a corroborated edge is a stronger channel |
| **phase difference** | angular offset | **disagreement** between what a concept's own evidence says and what its neighbours imply — the contradiction ledger |
| **entropy** | spread of the oscillator state | the uncertainty of the observer's **own answers** about a concept: how much of what can be asked about it must be hedged, guessed or asked back, weighted by how often it comes up — summed over the network |
| **observation** | measurement collapsing the state | **answering**: every answer is a measurement of the network's state, recorded with its provenance |
| **self-organization** | synchronization | the network **choosing what to couple next** so that the total entropy drops fastest — goals, curriculum, synthesis, forgetting |

The prediction that makes this falsifiable: **the learning steps that lower this entropy the most are the ones after which the observer performs best on material it was never shown** (held-out ConceptNet rows, held-out passage questions, one-shot facts taught in conversation). Steps that add edges without lowering it should not help. If the correlation holds, the principle has been shown to operate in a substrate that is not oscillators at all. If it does not, the measure is wrong and we learn that early.

Two properties are demanded of the honesty side, and they must be kept separate because only one is provable:

- **Soundness relative to the store** (provable): every asserted claim has a derivation from stored evidence, and the derivation is recorded. This is what "does not hallucinate" means here, and it is what an LLM structurally cannot offer.
- **Truth of the store** (not provable, only managed): ConceptNet contains junk; the reader misparses; a teacher can be wrong. Corroboration across source classes, world feedback and the contradiction ledger manage this. "Hallucination-free" is not "error-free", and the paper should say so.

## 2. What exists today, mapped onto the target

The inventory (every file/function is in the codebase as of `27243dd`) against the six terms above:

**Elements.** Concepts exist as deck words with definitions, traces, relations, beliefs (`agent/base.ts storeBelief`), word states (FSRS) and — since `13278ea` — words the observer knows exist but cannot define (vocabulary growth). Induced concepts exist (`conceptSynthesis.ts induceConcepts`, MDL-positive shared-edge groups) behind the `conceptSynthesis` flag.

**Channels.** Relation edges with source classes (`curriculum | conversation | world-feedback | definition | reading | conceptnet`), corroboration (`corroboration.ts`), multi-valued edges, confirmed-false negations, is-a inheritance walks (`chain.ts inheritsEdge`), composition chains with an MDL soundness check (`composition.ts`). This is the strongest part of the system.

**Phase difference.** `contradictions.ts detectConflicts/triageConflicts` and `sweep.ts` exist and work — but the sweep is invoked only from the CLI (`/sweep`) and a bench, never from the live training loop. Disagreement is measured but does not drive learning.

**Entropy.** Many local entropies, no global one. The substrate measures the spread of its own state (`SedenionMemoryField.entropy`, `PrimeOscillatorField.entropy`, `HolographicMemory.entropy`) and uses it for exactly one decision: consolidation is locked on `smfEntropy ≤ threshold` — a criterion the null arms have since shown is about a term that does not carry recall. The teacher measures candidate-distribution entropy at recall (`cde.ts`, used to ask *which sense*), frontier entropy when elaborating (`elaboration.ts` stops when flat), council response entropy (`network.ts`), and a curriculum stall signal (`curriculum.ts goalStallSignal`). None of these is the entropy in §1: nothing measures the network's uncertainty about its own answers, nothing sums it, and nothing correlates its change with performance on unseen material.

**Observation.** Every `chatAnswer` carries `AnswerProvenance` (traces, edges, operator, rule ids, derivation steps); grades land in a bounded ledger so a wrong answer weakens what produced it; the deviation meter reads every reply as grounded / composed / abstained. For *composed* speech the critic (`groundedFrames.ts criticize`) refuses any claim without a direct edge, an inheritance path or a sound chain. For operator, rule and memorized answers correctness is structural (the operator fires only if the edge exists) and the audit is after the fact — there is no single invariant, checked in CI, that every assertion in every bench had non-empty provenance whose cited items exist and entail the claim.

**Self-organization.** Goals (`plan.ts`) form for two of four types (learn-word, fill-gap); practice and verify-belief are never formed. Goal choice is priority × success × curriculum rank at a drive temperature. Curriculum rank is a seven-term score. Concept synthesis is MDL-driven and wired. Vocabulary grows from ConceptNet rows. All of this is real self-direction — but none of it is driven by *expected entropy reduction*; each mechanism has its own local heuristic, and the corpus feeder spends its budget round-robin regardless of what a source is teaching.

**Learning in real time.** In chat the observer stores exchanges (`teachResponse`), negation statements, gaps, ask-outcomes and conversation evidence for corroboration (`noteConversationEvidence`). It does **not** read a declarative sentence typed at it into new edges (the reader `readFrom` runs only in training and the CLI), does not grow vocabulary from conversation, and cannot promote a hypothesis from chat evidence (ANALYSIS #11). A user's correction ("no, a zebu is a cow") is not a world-feedback grade. So the part of learning that most resembles a person — being told something once, in conversation, and using it a moment later — is the part that is only half built.

**Inference.** Inheritance along is-a exists and is labeled (`via`). The hypothesis tier reaches one hop and hedges. Composition chains hedge by the weakest edge. But a recognized factual question form that reaches the compose step is blocked and routed to ASK (the evasion rule), and an underivable computation is forced to ASK — so where a person would say "I'd guess X, because A and B — is that right?", the observer says "I do not know whether X is a Y. Could you teach me?" even when it has a path to a guess. Analogy that is not is-a inheritance (two concepts sharing most of their edges) exists only as the prototype bundle of induced concepts.

**Memory dynamics.** Decay is real (FSRS retention sweep every five minutes; n-gram and drive weights toward their floors). Pruning exists (capacity-triggered). Near-duplicate merge exists offline only (`mergeConsolidation.ts`, record merge). Consolidation is keyed to the substrate entropy (see above) rather than to anything about the concept's coupling — it should consolidate what is corroborated and used in correct answers, and let go of what never lowered anyone's uncertainty.

**The substrate.** With `OBSERVER_SMF_WEIGHT=0` recall is index-only and the gates are re-fitted; the field currently earns nothing in recall. The paper's own Future Work 3 ("deepening the moment") names the place it might earn something: not lookup but what to attend to, consolidate and learn next. That has not been tested.

**Grading.** Creative grades come from an LLM whose trust is now measured (`graderCheck.ts`) and which has never graded a composition good in 2,619 tries. Checkable sources of truth exist and grade without an LLM: arithmetic problems (`curriculum/problems.ts`), rule induction held-out validation, the critic, and — once built — held-out edge recovery and user corrections. The LLM should end as a proposer whose grades are one class among several, not the judge.

## 3. The gaps, in one table

| # | Capability the target needs | Exists | Missing | Evidence it is done |
|---|---|---|---|---|
| A | A network-level entropy over the observer's own answers | local entropies only | `networkEntropy()` over concepts; logged per learning step | the readout appears in the record and introspection; the correlation bench (B) can be run |
| B | The principle's prediction tested | held-out slice exists, no recovery bench | held-out recovery bench (TASKS #38) + entropy-drop vs held-out correlation | a JSON artifact with the correlation over ≥ 50 learning steps; sign and size reported honestly |
| C | Soundness as a checked invariant | provenance everywhere, critic on composed only | one audit over all benches' assertions; a CI gate at zero unbacked assertions; the theorem stated with its scope | `soundnessGate.test.ts` green; paper §3.7 states soundness vs truth |
| D | Learning from conversation in real time | exchanges, negations, gaps, evidence | reader on declaratives in chat; vocabulary growth from chat; corrections as world feedback; hypothesis promotion | the one-shot bench (E) passes its first three shapes |
| E | The person test | none | bench: teach a fact once in conversation → answer a question that needs it plus older knowledge → same again after a simulated delay | `oneShotLearningBenchmark.test.ts` with per-shape pass rates; this is the demonstration |
| F | Inference labeled, not gated | 1-hop hypothesis, is-a inheritance, chains | a **guess** answer mode (assertion that carries a question) where a path exists; analogy over shared edges; confirmation promotes | deviation meter shows `guessed` as its own category; evasion rule fires only when no path exists; honesty gates unchanged |
| G | Disagreement drives learning | conflict detection + sweep (CLI only) | sweep in the live loop; conflicts as a term of the entropy; verify-belief goals from the ledger | conflicts fall over training; verify goals formed and completed |
| H | Consolidation and forgetting by coupling, not by substrate entropy | FSRS decay, capacity prune, offline merge, `smfEntropy` lock | consolidation keyed to corroboration + correct use; live near-duplicate merge; prune what never reduced uncertainty | held-out recovery does not fall when the prune runs; bank size bounded |
| I | Self-direction by expected entropy drop | goals, curriculum rank, drives, synthesis — each with its own heuristic | goal value = expected entropy reduction; practice & verify-belief goals; feeder budgets by measured drop per source | goal choice explained in introspection by entropy; source budgets move |
| J | Concept synthesis as entropy reduction | MDL induction, rediscovery merge | MDL gain expressed in the same bits as A; induced concepts speakable (named or described) | an induced concept lowers A measurably and is used in an answer |
| K | The substrate's job decided | recall: no (measured) | attention/consolidation bench: does the converged field predict the best next thing to learn better than the symbolic signals? | one bench, one decision: promote to a role or park as optional module |
| L | Grades from the world, not the LLM | problems, induction held-out, critic; LLM grades gated | user corrections, held-out recovery and the soundness audit as grade sources; LLM demoted to proposer | share of grades from checkable sources > 50 % in the record |

## 4. Order, and why

Measure before changing (A, B, C, E) — all readout-only, safe for the live server, and they define what "done" means for everything after. Then make conversation a learning channel (D, F), because that is the shortest path to the demonstration in E and it is where the person-likeness lives. Then let disagreement and coupling drive dynamics (G, H). Then put entropy in charge of self-direction (I, J) — this is the principle actually running the mind, and it needs A and B to exist first or it is another heuristic. K is independent and can run any time after A. L accumulates across all of it. Task 13 (the design ledger) becomes the running record of which paper mechanism maps to which term of §1 and what its bench says.

## 5. Tasks

Numbering continues TASKS.md. "Readout" means the change adds measurement only and cannot alter the live observer's behavior. Acceptance is a test or bench that exists in the repo when the task is done.

### Phase 0 — measure (readout only)

| # | Task | Files | Acceptance |
|---|---|---|---|
| 39 | **Network entropy readout.** `networkEntropy()` on the teacher: for each known concept, the uncertainty of the observer's own answers about it — the share of the questions the operator layer can form about it (is-a, has-part, has-property, capable-of, used-for, made-of, where, definition) that would be hedged (`Probably`/`I think`), guessed, or asked back, in bits, weighted by ask frequency from the gap ledger; summed, plus per-concept and per-source-class breakdowns. Log it each curriculum step and each autonomous cycle next to the existing stats; expose under `introspection().trust.entropy`. | `teacher/networkEntropy.ts` (new), `teacher/agent/base.ts`, `server/trainingLoop.ts`, `server/ServerSession.ts`, `components/IntrospectView.tsx` | `networkEntropy.test.ts`: adding a corroborated edge lowers the concept's term; adding a contradicting edge raises it; the total is invariant under re-teaching a known word. Readout only. |
| 40 | **Held-out edge recovery bench** (TASKS #38): over the real `conceptnet.en.jsonl`, after N feeder steps, ask the held-out tenth as yes/no and open questions; report recovered / hedged / asked / wrong by relation and by hop count (direct, inherited, chained). | `curriculum/heldOutRecoveryBenchmark.test.ts` (bench config), `bench/curriculum/*.json` | Artifact written; run on the corpus before the server eats it. |
| 41 | **The prediction.** Extend 40 to record, per feeder step, Δ networkEntropy and the held-out recovery after that step; report the correlation (Spearman) and the same for "edges added" as the null predictor. | same bench + `docs/NULL_ARMS.md` §new | An artifact with the two correlations and the step series; result reported whichever sign it has. This is the test of §1. |
| 42 | **Soundness audit gate.** A checker that, given any `chatAnswer` result, verifies every assertion's provenance is non-empty, that every cited trace/edge/rule id exists in the store, and that the cited items entail the spoken claim (edge → claim, inheritance path → claim, derivation steps → result). Run it over every answer produced by the existing CI gates and benches; fail on the first unbacked assertion. | `teacher/soundness.ts` (new), `teacher/soundnessGate.test.ts`, hook in `ciGates.test.ts` | Gate green on `main`; the count of assertions audited is printed. Any failure is a real defect, fixed before the gate is merged green. |
| 43 | **One-shot learning bench — the person test.** Shapes: (1) teach a fact in conversation ("a zebu is a kind of cattle"), ask a question needing it plus older knowledge ("does a zebu have horns?"), (2) the same after a simulated retention interval (advance the FSRS clock), (3) correct a wrong answer in conversation and re-ask, (4) teach two facts and ask the composition, (5) teach a fact that contradicts a stored edge and check the observer asks to verify rather than silently overwriting. Pass rate per shape; abstentions counted honestly, never as passes. | `teacher/oneShotLearningBenchmark.test.ts` (bench config) | Runs and reports on `main`. Expected to fail shapes 1, 3, 4 today — that is the point; it defines D and F. |

### Phase 1 — conversation as a learning channel

| # | Task | Files | Acceptance |
|---|---|---|---|
| 44 | **Read declaratives in chat.** A declarative statement typed at the observer (not a question, not a cue it has a memorized reply for) goes through the reader with source class `conversation`, the same claim-grammar precision guards as `readFrom`, and grows vocabulary for an unknown subject whose predicate is known. The reply acknowledges what was stored, in the observer's words, and says what it did not understand. Chat-only edges carry the single-class hedge until corroborated. | `teacher/TeacherAgent.ts` (chatAnswer 1.6), `teacher/agent/relations.ts`, `teacher/reading.ts` | Bench 43 shape 1 passes; `readingBenchmark` precision unchanged; adversarial honesty bench unchanged (a declarative cannot smuggle a `No`). |
| 45 | **Corrections are world feedback.** "No — X" / "that's wrong" / "actually X" after an answer books a `wrong` grade against the answer's provenance (weakening exactly the producing edge/rule), stores the corrected claim with class `world-feedback`, and — closing ANALYSIS #11 — promotes a matching hypothesis-tier edge. Confirmation ("yes", "right") books `correct`. | `teacher/TeacherAgent.ts`, `teacher/agent/wordloop.ts recordAnswerGrade`, `teacher/context.ts` | Bench 43 shape 3 passes; ledger entry cites the prior answer; a false correction is hedged, not swallowed (needs corroboration to reach strength 1). |
| 46 | **The guess mode.** When a recognized question reaches step 3 and an inference path exists (inheritance, chain, analogy from 47) the observer answers in a new speech act: an assertion carrying its derivation and a question — "I'd guess a zebu has horns, because it is cattle and cattle have horns — is that right?" — instead of routing to ASK. The deviation meter gets a fourth category, `guessed`; a guess never speaks a bare `No`; a guess that is confirmed becomes a corroborated edge, one that is denied becomes a negation. The evasion rule still fires when no path exists. | `teacher/speechAct.ts`, `teacher/TeacherAgent.ts`, `teacher/pathEvidence.ts`, `components/ChatView.tsx` meter | Bench 43 shape 4 passes; honesty gates unchanged; `guessed` appears in the record's deviation meter. |
| 47 | **Analogy over shared edges.** For a subject with no direct or inherited edge for the asked predicate, find concepts that share most of its edges (Jaccard over the relation set, the prototype bundle generalized to any pair) and propose their value as a guess with the analogue named ("like a yak, which is also cattle"). Labeled as a guess (46), never asserted. | `teacher/chain.ts`, `teacher/conceptSynthesis.ts prototypeBundle`, `teacher/operators.ts` | Unit test on a synthetic graph; recovery bench 40 reports the share of held-out edges recovered by analogy separately from inheritance. |

### Phase 2 — disagreement and coupling drive the dynamics

| # | Task | Files | Acceptance |
|---|---|---|---|
| 48 | **Conflict sweep in the live loop.** Run `sweepConflicts` on a cadence (every 20 cycles, budgeted), schedule verification questions as `verify-belief` goals, apply resolutions through the existing `applyResolution`. Conflicts become a term of 39's entropy (a disagreement is uncertainty). | `server/trainingLoop.ts`, `teacher/sweep.ts`, `teacher/plan.ts`, `teacher/networkEntropy.ts` | Bench 43 shape 5 passes; the conflict count in introspection falls over a training run on the corpus; verify goals are formed and completed. |
| 49 | **Consolidation by coupling.** Replace the `smfEntropy ≤ threshold` lock as the consolidation criterion for traces of concepts with: corroborated by ≥ 2 classes **or** cited in ≥ k correct graded answers, and unweakened. Keep the substrate lock as an optional mode for the benches. | `packages/sentient-core/src/semantic/{SemanticMemoryBank,CompactMemoryBank}.ts` (criterion injectable), `teacher/agent/wordloop.ts` | Existing consolidation tests pass under both criteria; recall gates unchanged; the record reports which criterion consolidated each trace. |
| 50 | **Forgetting that is earned.** Live, budgeted near-duplicate merge (`consolidateTraces`) and pruning of traces that were never cited in any answer and whose concept's entropy term they never lowered, bounded per sweep, never touching consolidated traces. | `teacher/agent/wordloop.ts applyRetention`, `teacher/mergeConsolidation.ts` | Held-out recovery (40) does not fall after a prune; bank size stays bounded over a full corpus run. |

### Phase 3 — entropy in charge of self-direction

| # | Task | Files | Acceptance |
|---|---|---|---|
| 51 | **Goal value = expected entropy drop.** Score every candidate goal by the entropy term of the concepts it would couple (39) times the estimated success rate; form `practice` goals from concepts with grade losses and `verify-belief` goals from 48. `chooseGoal` samples over this value at the drive temperature. | `teacher/plan.ts`, `teacher/agent/goals.ts`, `teacher/curriculum.ts` | Goal-loop bench shows the chosen goals' concepts have higher entropy than the median; all four goal types are formed and completed on the corpus; introspection explains each goal in bits. |
| 52 | **Feeder budgets by measured yield.** The curriculum feeder records Δ entropy per row for each source and shifts its round-robin toward the sources that lower it most (a bandit over sources, floor 10 % each so no source starves). | `curriculum/registry.ts`, `teacher/agent/base.ts curriculumCursors` | Budget shares move over a run and are logged; held-out recovery per source is not worse than round-robin. |
| 53 | **Synthesis in the same bits.** Express `conceptSynthesis` MDL gain in the units of 39 and only admit an induced concept when it lowers the network entropy; give induced concepts a speakable description ("the group of things that are cattle and have horns") and let 46 name them in guesses. | `teacher/conceptSynthesis.ts`, `teacher/agent/relations.ts`, `teacher/networkEntropy.ts` | Test: an admitted induced concept lowers the total; a rejected one would not have; an answer uses one. |

### Phase 4 — the substrate's job

| # | Task | Files | Acceptance |
|---|---|---|---|
| 54 | **Field as attention bench.** After each cycle, rank the concepts the converged field state excites most (moment-conditioned) against the concepts with the highest entropy term (39) and against the curriculum's choice; measure which ranking, used as the next thing to learn, produces the largest held-out gain over 200 cycles on the corpus. | `teacher/fieldAttentionBenchmark.test.ts`, `observer/engine.ts` readout | One artifact, one decision recorded in `docs/NULL_ARMS.md`: the field is promoted to the attention role, or parked as an optional module with the paper's substrate section rewritten to say so. |

### Phase 5 — the honesty claim as a theorem

| # | Task | Files | Acceptance |
|---|---|---|---|
| 55 | **State soundness and its scope.** In the paper (§3.7) and in `docs/OBSERVER_INTERFACES.md`: the invariant 42 checks, stated formally (every assertion `c` spoken has a recorded derivation `D` from stored items `S` with `S ⊢ c` under the operator/inheritance/rewrite semantics), what it does **not** guarantee (truth of `S`), and how the store's truth is managed (corroboration, world feedback, the conflict ledger). Include 42's audited-assertion count from `main`. | `docs/observer-paper.md`, `docs/OBSERVER_INTERFACES.md` | Text merged; every claim in it points at a test. |
| 56 | **Design ledger** (task 13, reshaped). One table: each paper mechanism → its term in §1 → the bench that measures it → status (carries weight / labeled / parked). Maintained as tasks complete. | `docs/DESIGN_LEDGER.md` | Every mechanism in the paper appears exactly once. |

### Ongoing

| # | Task | Acceptance |
|---|---|---|
| 57 | **Grades from the world.** Track the share of grades by class (`world-feedback` from problems, corrections, held-out recovery, soundness audit vs `llm`) in the record; the LLM's grades count only when the grader check trusts it (already) and never outvote a checkable source. | Share of checkable grades reported in introspection; > 50 % over a corpus run. |
| 58 | **Retire the dead paths.** Remove `teacher/critic.ts` (#26); mark the substrate-entropy consolidation criterion and the field's recall term as optional modes in `options.ts` with a comment naming the null arm that retired them. | Build green; `docs/NULL_ARMS.md` links. |

## 6. What this does not promise

It does not promise the observer will learn as fast or as broadly as a person; the vocabulary is tens of thousands of words and the relation grammar is bounded. It promises that what it learns, it learns from being told or from reading, in real time, with a record of why it believes each thing, and that it never asserts what it cannot derive. The one-shot bench (43) and the prediction bench (41) are the two numbers that will say whether the mind is forming — and both can come out badly. That is what makes them worth running.
