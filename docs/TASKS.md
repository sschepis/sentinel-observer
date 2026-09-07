# Sentinel Observer — task list

*Updated 2026-09-07 (evening). Companion to ANALYSIS.md (what was wrong), IMPROVEMENT_PLAN.md (what to do about it) and NULL_ARMS.md (the memory-substrate measurements).*

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

## Housekeeping

| # | Task | Who |
|---|---|---|
| 24 | Delete `_to_delete/` at the repo root (git lock files the sandbox couldn't remove) | Sebastian |
| 25 | Remaining defects from ANALYSIS.md §6: #10 (ask-layer frames count as abstentions — folds into #17), #11 (chat evidence can't promote hypotheses), #13 (story parser — folds into #22), #14 (duplicate `case` labels in `dsl.ts`), #17 (stale constants registry pointers), #18 (wall-clock assertions in unit tests), #19–20 (fuzz bench seeding/denominator — superseded by the null-arm bench) | Claude |
| 26 | Remove the dead duplicate critic `teacher/critic.ts` (no importers) | Claude |
| 27 | Make the repo runnable off-Mac: `npm ci` instead of a checked-in `node_modules` with darwin-only binaries | Sebastian (optional) |
