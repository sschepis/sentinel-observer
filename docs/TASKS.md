# Sentinel Observer — task list

*Updated 2026-09-07. Companion to ANALYSIS.md (what was wrong), IMPROVEMENT_PLAN.md (what to do about it) and NULL_ARMS.md (the memory-substrate measurements).*

## Where things stand, in plain terms

The code was audited against the paper. Eleven real bugs were fixed and merged to `main` with tests. A benchmark was built that compares the observer's memory against simpler versions of itself, and it was run both on fresh vocabulary and on the live observer's own learned record. The result: the oscillator-field similarity term in memory scoring ("the SMF term") does not help recall — a plain index over the prime signatures recalls at least as well and separates real cues from near-miss distractors better. The field's coupling does nothing for recall either. Switching to index-only scoring is a one-line configuration change that does **not** require retraining the live observer, but every confidence threshold in the system was tuned on the old score scale and must be re-fitted first. One existing test already fails for exactly that reason (a threshold, not a behavior).

Nothing done so far has touched the running server or its learned record.

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

---

## Next: switch memory scoring to index-only, safely

Do these in order. Nothing is flipped on the live server until step 12.

| # | Task | Who | What it involves |
|---|---|---|---|
| 8 | Measure the new score margins | Sebastian | `cd apps/web && OBSERVER_SMF_WEIGHT=0 npm run cde-bench` — prints the margin bands for exact cues vs distractors under index-only scoring; paste the output back. |
| 9 | Make the sense-disambiguation threshold scale-free | Claude | The "is this word ambiguous?" check currently uses a fixed margin (0.17) tuned on the old score scale. Change it to compare each sense's overlap with the cue's own primes, so it reads the same under any scoring. Fixes the failing polysemy test properly. |
| 10 | Re-fit the conversation confidence gates on the new scale | Claude, then Sebastian runs it | Use the existing calibration code (`calibration.ts`) with a held-out split to set the recall floor, the "high confidence" gate and the margin from data instead of the hand constants 0.6 / 0.8 / 0.05. |
| 11 | Re-run everything under index-only scoring | Sebastian | `npm test`, the three heavy gates, and the null-arm bench in record mode. All green = go. |
| 12 | Flip the live server | Sebastian | Add `OBSERVER_SMF_WEIGHT=0` to the server's environment and restart at a quiet moment. No retraining. Watch the report card (λ, ask share, fabrication rate) for a day. |
| 13 | Rewrite the paper's memory sections from the bench artifacts | Claude | §3.1, §5.1, §5.2: what recall actually computes, with the null-arm tables and their n. |

---

## Before the next server restart (independent of the switch)

The merged fixes change behavior the first time the server restarts. Decide these before that happens.

| # | Task | Who | Note |
|---|---|---|---|
| 14 | Decide: take all day-one fixes at once, or stage them | Sebastian | On restart: learned n-gram and drive weights decay for the first time (a one-time step down, then steady); the composite is re-scaled so λ starts moving off zero; negations now need an explicit known subject. The branch `fix/day-one-defects` still exists if you want them split. |
| 15 | Audit the live confirmed-false store for junk | Claude | Read-only, from the snapshot: list every stored "X is not a Y" that the new negation guard would have refused (idioms, pronoun subjects). You decide what to prune. |

---

## Then: the other three tracks you chose

| # | Track | Task | Note |
|---|---|---|---|
| 16 | Dormant mechanisms | Put drive-temperature arbitration on the compose / ask / practice decision, with a bench that varies curiosity and checks the ask share moves | Today the drives influence nothing. |
| 17 | Dormant mechanisms | Label the deviation meter by what was *said* (does the text assert a claim?) instead of which layer produced it | Frames spoken at the ask layer currently count as "abstained". |
| 18 | Dormant mechanisms | Run the goal loop in the server, with a bench showing a stalled goal changes the curriculum | `startGoalLoop` has no production caller. |
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
