# Sentinel Observer — task list

*Updated 2026-09-09. Companion to ANALYSIS.md (what was wrong), IMPROVEMENT_PLAN.md (what to do about it), NULL_ARMS.md (the memory-substrate measurements) and SYNTHETIC_MIND.md (the gap analysis from here to the stated goal; its tasks 39–58 are listed below).*

## Where things stand, in plain terms

The code was audited against the paper. Eleven real bugs were fixed and merged to `main` with tests. Three mechanisms the paper describes but the code never ran — the drives, the deviation meter as a reading of speech, and the goal loop — are now wired in, each with a bench that shows the mechanism moving something. A benchmark was built that compares the observer's memory against simpler versions of itself, and it was run both on fresh vocabulary and on the live observer's own learned record. The result: the oscillator-field similarity term in memory scoring ("the SMF term") does not help recall — a plain index over the prime signatures recalls at least as well and separates real cues from near-miss distractors better. The field's coupling does nothing for recall either. Switching to index-only scoring is a one-line configuration change that does **not** require retraining the live observer, but every confidence threshold in the system was tuned on the old score scale and must be re-fitted first. One existing test already fails for exactly that reason (a threshold, not a behavior).

Nothing done so far has touched the running server or its learned record. Everything below lands on the live observer the next time the server restarts (decision #14: all at once).

Two terms used below: **SMF term** = the oscillator-field similarity term in the memory score. **Index-only** = scoring memories by prime-signature overlap alone (`OBSERVER_SMF_WEIGHT=0`).

---

## Done

| # | Task | Where |
|---|---|---|
| 1 | Audit the code against the paper | `docs/ANALYSIS.md` |
| 2 | Turn the findings into a plan with general rules | `docs/IMPROVEMENT_PLAN.md` |
| 3 | Fix the day-one defects (11 of 20) with regression tests; merge to `main` | commit `835b745` |
| 4 | Build the null-model benchmark for the memory substrate; run on 200/1,000 fresh words | `nullArmsBenchmark.test.ts`, `bench/null-arms/*-w*.json` |
| 5 | Run the benchmark read-only against the live observer's record | `bench/null-arms/*-record.json` |
| 6 | Add the `OBSERVER_SMF_WEIGHT` / `OBSERVER_COUPLING` switch (applies to server, trainer and all gates; never re-encodes stored memories) | `observer/engine.ts` |
| 7 | Run the heavy gates with the SMF term off: semantic recall and CI gates unchanged, polysemy honesty holds, one sense-split threshold fails | `docs/NULL_ARMS.md` |
| 9 | Sense-disambiguation threshold made scale-free (runner-up overlap ÷ winner overlap ≥ 0.5, instead of a fixed 0.17 margin) | `teacher/cde.ts`, commit `ead9c57` |
| 10 | Recall floor made a calibrated gate; `refit-gates` fits floor and high-confidence gate from the live record with a held-out split; server loads the fitted values from `OBSERVER_GATES_FILE` and refuses an artifact fitted under a different arm | `teacher/calibration.ts`, `cli/refit-gates.ts`, commits `ead9c57` `8bcd711` — control fitted: high-confidence 0.794 (hand 0.8), floor 0.749 (hand 0.6). Index-only re-run still pending (see #10 below). |
| 14 | Decided: take all the day-one fixes at once on the next restart | — |
| 16 | Drives now own one real decision: when a reply could be a composition about known material or a question about it, the drives choose (sampled at the drive temperature). Bench: ask share rises from 5.6% to 44.4% as curiosity goes 0→1; the same drive state on a fresh teacher reproduces the same shares exactly. | `teacher/agent/motivation.ts`, `driveArbitration.test.ts`, commit `8e35fca` |
| 17 | Deviation meter now reads what was *said*: a question or "I cannot tell" is an abstention; a claim that cites memory (traces, edges, an operator, rules) is grounded; a claim that cites nothing is composed — whichever layer produced it. A read-about fact spoken at the ask layer ("Zeus is a god") now counts as grounded speech and carries the edges it came from. Shown on the introspection page and as a chat badge only where it disagrees with the routing label. | `teacher/speechAct.ts`, `speechAct.test.ts`, commit `58968e7` |
| 28 | **The grader check.** Found while reading the live record after the restart: the observer has had 2,619 compositions graded and *zero* graded good, ever — its compose drive weight was pinned at the floor by a judge that may never have said "good". The training loop now grades known-good and known-bad answers (taught pairs' own responses vs. other pairs') before its first cycle and every 100 cycles; a grader that cannot separate them, or never grades a correct answer as strong, is *untrusted*: its grades are recorded but move nothing (no reinforcement, weakening, drive outcome or gap), and creative practice stops asking it. Verdict on the introspection page and in the chat feedback. `npm run grader-check` prints the distributions for the configured model. | `teacher/graderCheck.ts`, `graderCheck.test.ts`, `cli/grader-check.ts`, commit `82137b7` |
| 29 | Goal stalls and completions were booked twice (seen live: 6 abandoned for 3 stalls). One transition, one entry. | commit `661822c` |
| 18 | Goal loop runs in the server: every classroom cycle discovers goals from the observer's own measures (words it keeps missing → learn-word; "I keep failing X" → fill-gap), takes one plan step on a goal chosen at the drive temperature, and a goal that stalls raises its target in the lesson queue and makes it the next research topic. Bench: a stalled goal on the last-ranked word puts it first; without the stall the order is unchanged. | `teacher/agent/goals.ts`, `teacher/plan.ts`, `server/trainingLoop.ts`, `goalLoop.test.ts`, commit `7ed83f5` |

---

## Next: switch memory scoring to index-only, safely

Do these in order. Nothing is flipped on the live server until step 12.

| # | Task | Who | What it involves |
|---|---|---|---|
| 8 | Measure the new score margins | Sebastian | `cd apps/web && OBSERVER_SMF_WEIGHT=0 npm run cde-bench` — prints the margin bands for exact cues vs distractors under index-only scoring; paste the output back. |
| 10 | Re-run the gate fit under index-only scoring | Sebastian | `cd apps/web && OBSERVER_SMF_WEIGHT=0 npm run refit-gates` — the first run fitted both gates at 1.000 (a knife edge: every non-exact cue scored below every exact one). The fit now includes legitimate variants of taught cues as positives, so the gates land where variants still pass. Paste the output. Writes `bench/calibration/conversation-gates-smf-off.json`. |
| 11 | Re-run everything under index-only scoring | Sebastian | `npm test`, the three heavy gates, and the null-arm bench in record mode. All green = go. |
| 12 | Flip the live server | Sebastian | Add `OBSERVER_SMF_WEIGHT=0 OBSERVER_GATES_FILE=../../bench/calibration/conversation-gates-smf-off.json` to the server's environment and restart at a quiet moment. No retraining. Watch the report card (λ, ask share, deviation meter, goal steps/stalled on the introspection page) for a day. |
| 13 | Rewrite the paper's memory sections from the bench artifacts | Claude | §3.1, §5.1, §5.2: what recall actually computes, with the null-arm tables and their n. |

---

## Before the next server restart (independent of the switch)

The merged fixes change behavior the first time the server restarts. Decide these before that happens.

| # | Task | Who | Note |
|---|---|---|---|
| 14 | ~~Decide: take all day-one fixes at once, or stage them~~ Decided: all at once. | Sebastian | What changes on the first restart: learned n-gram and drive weights decay for the first time (a one-time step down, then steady); the composite is re-scaled so λ starts moving off zero; negations need an explicit known subject; the drives start choosing between composing and asking about known material; the classroom loop starts forming and pursuing goals (new "goal" events in the learning stream; "goal steps / completed / stalled" on the introspection page). |
| 15 | Audit the live confirmed-false store for junk | Claude | Read-only, from the snapshot: list every stored "X is not a Y" that the new negation guard would have refused (idioms, pronoun subjects). You decide what to prune. |

---

## Then: the other three tracks you chose

| # | Track | Task | Note |
|---|---|---|---|
| 16–18 | Dormant mechanisms | Done — see the Done table. Left open in this track: practice and verify-belief goals are not formed automatically (their plans quiz a deck word but their completion reads a conversation phrase or a belief, so they would stall on construction — a fake curriculum signal); fixing those plan shapes is a small follow-up. | |
| 19 | Field | Split the memory sketch into a content sketch and a context sketch; bench context-cued recall ("what did we cover around X?") against a null | Turns the recency signal from a confound into a feature. |
| 20 | Field | Prototype the resonant readout (excite the top candidates, let inhibition pick) against a softmax null on the polysemy sibling set | The last remaining way the field could earn a job in recall. If it loses, the paper says "encoder". |
| 21 | Procedures | Replace the drill-name→template lookup with a signature-selected enumerator over a small term language; instruction and chaperone proposals become front-ends into the same candidate space; honest MDL cost for numerals | Turns "one gcd example" into "k of 36 families induced". |
| 22 | Procedures | Fix the story parser's misreads and the logic prompt grammar; add adversarial instruction tests | Listed in ANALYSIS.md §5.3. |
| 23 | Benches | Every bench writes a JSON artifact; paper tables are generated from them; honesty-bench negatives come from WordNet instead of the model's own graph; seed the fuzz bench | Rule 3 and Rule 5 from the plan. |

---

## After the grader check (new, in order)

| # | Task | Who | Note |
|---|---|---|---|
| 30 | Run `cd apps/web && npm run grader-check` against the current teacher model and paste the output | Sebastian | The model in the ledger is `dirty-muse-writer-v01-uncensored-erotica-nsfw-i1` — a fiction-writing model, not an instruct model tuned for JSON grading. The check will say whether it can judge at all. |
| 31 | If untrusted: point `OBSERVER_CHAPERONE_MODEL` at an instruction-tuned model that returns the grade schema; re-run the check; restart | Sebastian | The same model also answers gaps and proposes exchanges — the stalled fill-gap goals on creative-practice prompts are probably the same failure. |
| 32 | Restart the server once more to pick up #28/#29 | Sebastian | Until then the running process still books stalls twice and applies every grade. |
| 33 | Watch `compose` in behaviorWeights drift back toward 0.3 once no fresh compose outcomes land (driveWeightDays) | — | If the grader is repaired instead, wins will move it directly. |

## Training material (new — docs/CURRICULUM.md)

| # | Task | Who | Note |
|---|---|---|---|
| 34 | Curriculum pipeline: registry, budgeted feeder with persisted cursors, held-out slice; ConceptNet → relations (+ its Not* claims as confirmed-false), DailyDialog → pairs, Simple Wikipedia / TinyStories → passages, SVAMP / ASDiv → checkable problems | Claude — done | commits `87a526e` `8abe75b` `aba0c70`. Scale bench: 1,000-row feed ≈ 1 s; question latency unchanged to 110k edges. |
| 35 | Fill the corpus: `npm run fetch-conceptnet`, then `npm run fetch-hf -- dailydialog / simplewiki / tinystories / svamp / asdiv` | Sebastian | Run on the Mac; the server never downloads. Paste the per-relation counts from ConceptNet and the `kept` counts from the others. |
| 36 | Run the source benches before the server eats a corpus: `npx jest -c jest.bench.config.cjs --testPathPatterns passageBenchmark` (parse rate + claim sample per prose source) | Sebastian, then Claude reads | Decides the passage budget; narrative is expected to lose to encyclopedia prose. |
| 37 | Definitions source (Wiktionary glosses for deck words without one) and a story-state engine for bAbI-style questions | Claude | The two shapes without a fetcher / answering path yet. |
| 38 | Held-out edge recovery bench over the real ConceptNet file | — | Folded into #40 below. |

## The synthetic mind (new — docs/SYNTHETIC_MIND.md)

The goal, stated so it can fail: a system that self-organizes and learns in real time, more like a person than like current AI training, that says it does not know when it does not know, and never asserts what it cannot derive from what it has stored. The principle — coupling lowers entropy by opening a channel between elements — is pinned to the observer as built: elements are concepts, channels are corroborated edges, phase difference is the contradiction ledger, entropy is the uncertainty of the observer's own answers, and self-organization is choosing what to couple next. The prediction that tests it: the learning steps that lower that entropy most are the ones after which the observer does best on material it never saw. The one-shot bench (43) and the prediction bench (41) are the two numbers that decide whether the mind is forming. Full analysis and acceptance criteria in SYNTHETIC_MIND.md §5; order in §4.

**Phase 0 — measure (readout only; safe for the live server)**

| # | Task | Who | Acceptance |
|---|---|---|---|
| 39 | Network entropy readout: `networkEntropy()` over the observer's own answers per concept, logged per learning step, in introspection | Claude — **done** | `teacher/networkEntropy.ts` + test (6 green). Training loop reads it every 5 cycles (`entropy` / `entropyDelta` in stats, an `entropy:` line in the stream); `introspection().trust.entropy`; Introspect view shows total, per-concept mean, slot states and the most uncertain concepts. Slot ladder: certain 0.29 bits · single-source 0.81 · inherited 0.88 · weakened 0.93 · conflicted / unknown 1.00. |
| 40 | Held-out ConceptNet edge-recovery bench (was #38), by relation and by path (direct / inherited / graded layer) | Claude — built, first run pending | `curriculum/heldOutRecoveryBenchmark.test.ts` (bench config; `RECOVERY_STEPS/BUDGET/PROBES/TAUGHT` env). Writes `bench/curriculum/held-out-recovery-<date>.json`. |
| 41 | The prediction: Δ entropy per feeder step vs held-out recovery, with "edges added" as the null predictor | Claude — in #40's artifact | Reports Spearman ρ(Δentropy, Δrecovery) (expect < 0) beside ρ(edges added, Δrecovery). |
| 42 | Soundness audit gate: every assertion in every bench has provenance that exists and entails the claim; CI fails on the first that does not | Claude — **done, green** | `teacher/soundness.ts` (the invariant, per layer; the graded layer counts when the answer is hedged and the distributed-vector score re-checks above the operators' floor) + `soundnessGate.test.ts`: 476 answers audited · 80 derived · 12 structural · 384 abstained · 0 dangling · 0 unbacked. **Its first run found a real defect**: a Markov fallback sentence spoken as a flat assertion ("tell me about the farm" → "Tell me about the farm."). Fixed: an ungrounded composition is now spoken inside a decline that names it as word-play (`speakUngrounded`, speechAct.ts); the `grounded: false` flag and the grounding score are unchanged. |
| 43 | One-shot learning bench — the person test | Claude — **done; 1/6 today** | `teacher/oneShotLearningBenchmark.test.ts` (bench config), writes `bench/one-shot/latest.json`. First run: shape 1 fails (a declarative typed in chat is not read into an edge → task 44); shapes 2, 4, 5 blocked by 1; **shape 3 fails as WRONG** — "no, a cow does not have a tail" is not parsed by the negation grammar (it wants the bare "X does not have Y"), so the correction is asked back and the old answer stands → task 45; control (no unearned Yes) passes. |

**Phase 1 — conversation as a learning channel**

| # | Task | Who | Acceptance |
|---|---|---|---|
| 44 | Read declaratives typed in chat into edges (class `conversation`, reader precision guards, vocabulary growth for an unknown subject) | Claude | bench 43 shape 1; reading precision and adversarial honesty unchanged |
| 45 | Corrections and confirmations in chat are world-feedback grades against the answer's provenance; promote matching hypotheses (closes ANALYSIS #11) | Claude | bench 43 shape 3 |
| 46 | The guess mode: an assertion carrying its derivation and a question, where an inference path exists; fourth meter category `guessed`; confirmation → corroborated edge, denial → negation | Claude | bench 43 shape 4; honesty gates unchanged |
| 47 | Analogy over shared edges (generalized prototype bundle), always labeled as a guess | Claude | recovery bench reports analogy separately |

**Phase 2 — disagreement and coupling drive the dynamics**

| # | Task | Who | Acceptance |
|---|---|---|---|
| 48 | Conflict sweep in the live loop; verification as `verify-belief` goals; conflicts as a term of the entropy | Claude | bench 43 shape 5; conflicts fall over a corpus run |
| 49 | Consolidation by coupling (corroborated or cited in correct answers, unweakened) instead of the substrate-entropy lock; old criterion kept as a mode | Claude | consolidation tests pass under both; recall gates unchanged |
| 50 | Earned forgetting: live budgeted near-duplicate merge and pruning of never-cited traces, never consolidated ones | Claude | held-out recovery does not fall after a prune |

**Phase 3 — entropy in charge of self-direction**

| # | Task | Who | Acceptance |
|---|---|---|---|
| 51 | Goal value = expected entropy drop × success; practice and verify-belief goals formed; introspection explains goals in bits | Claude | all four goal types complete on the corpus |
| 52 | Feeder budgets by measured entropy yield per source (bandit, 10 % floor) | Claude | shares move; recovery per source not worse |
| 53 | Concept synthesis admitted only when it lowers the network entropy; induced concepts speakable | Claude | an answer uses one |

**Phase 4 — the substrate's job**

| # | Task | Who | Acceptance |
|---|---|---|---|
| 54 | Field-as-attention bench: converged-field excitation vs entropy ranking vs curriculum as the choice of what to learn next, over 200 cycles | Claude | one artifact, one decision in NULL_ARMS.md |

**Phase 5 — the honesty claim as a theorem**

| # | Task | Who | Acceptance |
|---|---|---|---|
| 55 | State soundness-relative-to-the-store formally in the paper (§3.7) with its scope and 42's audited count; say plainly that hallucination-free is not error-free | Claude drafts, Sebastian approves | text merged |
| 56 | Design ledger (task 13 reshaped): paper mechanism → term of the principle → bench → status | Claude | every mechanism appears once |

**Ongoing**

| # | Task | Who |
|---|---|---|
| 57 | Share of grades from checkable sources tracked in the record; LLM grades never outvote a checkable source | Claude |
| 58 | Retire the dead paths: `teacher/critic.ts`, substrate-entropy consolidation and field recall term as optional modes | Claude |

## Housekeeping

| # | Task | Who |
|---|---|---|
| 24 | Delete `_to_delete/` at the repo root (git lock files the sandbox couldn't remove) | Sebastian |
| 25 | Remaining defects from ANALYSIS.md §6: #10 (ask-layer frames count as abstentions — folds into #17), #11 (chat evidence can't promote hypotheses), #13 (story parser — folds into #22), #14 (duplicate `case` labels in `dsl.ts`), #17 (stale constants registry pointers), #18 (wall-clock assertions in unit tests), #19–20 (fuzz bench seeding/denominator — superseded by the null-arm bench) | Claude |
| 26 | Remove the dead duplicate critic `teacher/critic.ts` (no importers) | Claude |
| 27 | Make the repo runnable off-Mac: `npm ci` instead of a checked-in `node_modules` with darwin-only binaries | Sebastian (optional) |
