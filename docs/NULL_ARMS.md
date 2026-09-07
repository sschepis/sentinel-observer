# Null-model arms for the memory substrate — first results

*2026-09-06/07 · bench: `apps/web/src/teacher/nullArmsBenchmark.test.ts` (`npm run null-arms-bench`) · artifacts: `bench/null-arms/*.json` · IMPROVEMENT_PLAN.md §2.1, Rule 1*

## The question

Does the oscillator field — the Kuramoto dynamics and the SMF sketch they feed — contribute anything to retrieval that a static index over the same prime signatures would not? The paper's §3.1 and §6 say the field is where "observation is entropy reduction" happens. `docs/SCALING.md` §17 and §19–20 had already found the coupling inert for retrieval and the sketch a recency trajectory. This bench puts matched nulls next to the production observer on the same deck slice with the same seeded probes and reports the deltas.

## The arms

Every arm is the production field (256 primes, 512 grid, compact bank, capacity 50,000, 128-dim sketch, linear imprint weighting, semantic-is-a vocabulary over the deck slice + conversation tokens) with one thing removed:

| arm | what is removed |
|---|---|
| `control` | nothing — the production observer |
| `smf-off` | the SMF term (`smfWeight: 0`): recall is the prime-overlap index alone |
| `overlap-off` | the overlap term (`overlapWeight: 0`): recall is the SMF sketch alone |
| `coupling-0` | Kuramoto coupling (`coupling: 0`): oscillators never interact |
| `static` | coupling **and** the EMA trajectory (`coupling: 0`, `smfMomentImprint: true`): an inverted index plus a static random projection of the prime bag — the matched no-dynamics baseline |

## What is measured

Identity recall (the word cues its own trace, top-1) and semantic recall (the definition cues the word's trace) on a seeded sample of the taught words; a fuzz over a seeded sample of the 728 taught conversation pairs with three seeded last-word distractors each, reporting false positives at the production gate (0.8), the ROC AUC of true-cue scores against distractor scores (threshold-free separation), and false positives at the *matched gate* — the highest gate that still recalls every exact cue the arm recalled at all. Same words, same pairs, same fillers in every arm; only the observer differs.

## Results

**200 words, 40 pairs × 3 distractors (120)** — `bench/null-arms/*-w200.json`

| arm | identity | semantic | exact cues | FP @ 0.8 | FP @ matched gate | AUC | mean margin |
|---|---|---|---|---|---|---|---|
| control | 99.0% (198/200) | 90.0% | 39/40 | **1/120** | — (one exact cue scored 0) | **0.867** | 0.216 |
| smf-off | **100%** | 90.0% | 40/40 | 65/120 | **0** (gate 1.000) | **1.000** | 0.206 |
| overlap-off | **6.0%** (12/200) | 90.0% | 17/40 | 0/120 | 37 (gate 0.602) | **0.535** | 0.005 |
| coupling-0 | 99.0% | 90.0% | 39/40 | 1/120 | — | (run before AUC was added) | 0.174 |
| static | **100%** | 90.0% | 40/40 | 56/120 | **0** (gate 0.987) | **1.000** | 0.199 |

**1,000 words, 250 probes, 60 pairs × 3 distractors (180)** — `bench/null-arms/*-w1000.json`

| arm | identity | semantic | exact cues | FP @ 0.8 | FP @ matched gate | AUC | mean margin | ms/word |
|---|---|---|---|---|---|---|---|---|
| control | 99.6% (249/250) | 81.3% (200/246) | 58/60 | **0/180** | **65** (gate 0.661) | **0.912** | 0.202 | 6.3 |
| static | **100%** | 81.7% (201/246) | 60/60 | 67/180 | **0** (gate 0.991) | **1.000** | 0.218 | 6.1 |
| smf-off | **100%** | 81.3% | 60/60 | 79/180 | **0** (gate 1.000) | **1.000** | 0.226 | 6.2 |

(`coupling-0` at 1,000 words was interrupted by a dropped machine link; at 200 words it is identical to control on every count except a slightly smaller margin.)

## Reading

1. **The SMF sketch alone carries no content.** `overlap-off` — recall by the sketch only — gives 6% identity recall and AUC 0.535, chance. This is the direct, deck-scale confirmation of `SCALING.md` §19d/§20: the sketch is a recency clock, not a code.

2. **The SMF term costs identity recall.** Every arm without it recalls 100%; the two arms with it (control, coupling-0) lose 1–2 words in 200–250. The paper's 94.6% at 20k is a self-retrieval rate degraded by the term that was supposed to be helping.

3. **The paper's fuzz result is a threshold artifact.** Control's 0/180 false positives at the 0.8 gate looks like separation and is not: its AUC is 0.87–0.91, it *misses* 1–2 exact cues per 40–60, and at a gate matched to its own exact recall it produces 65 false positives. The EMA trajectory lowers every partial-match score toward the same floor, which happens to fall under 0.8 — and drags the weakest exact cues under the recall floor with it. The static and index-only arms separate **perfectly** (AUC 1.000, every exact cue recalled, zero false positives at their matched gate ≈ 0.99); their 56–79 false positives at 0.8 mean only that 0.8 is the wrong gate for a score that is not being pushed down by a clock.

4. **Coupling is inert.** `coupling-0` reproduces control on identity, semantic, exact and false-positive counts; the only difference is a smaller margin (0.174 vs 0.216 at 200 words), i.e. the dynamics slightly *increase* the recency noise. This is `SCALING.md` §17e at the retrieval path.

5. **Semantic recall does not depend on the substrate at all.** 90.0% at 200 words and 81.3–81.7% at 1,000 in every arm, including the one whose recall is at chance: the definition→word faculty is the comprehension path in `recallWithCue` (content overlap), not the field.

6. **The matched static baseline dominates the production observer on every measure.** 100% vs 99.6% identity, 60/60 vs 58/60 exact, AUC 1.000 vs 0.912, 0 vs 65 false positives at matched gates, and it is not slower.

## What this means, and what it does not

It means §3.1's account of retrieval — moment-grounded recall, the field's agreement, coherence-making — is not describing what the shipped recall path computes. Retrieval is an inverted index over collision-salted prime signatures; the field's contribution, through the EMA sketch, is a recency penalty that lowers all scores and costs a little recall. The negative is clean and reproducible (`npm run null-arms-bench`), and it should replace the §3.1/§5.1–5.2 prose rather than sit beside it.

It does **not** yet mean the static configuration should ship. Three heavy gates were not run under the null arms: the paraphrase→word semantic-recall gate (`semanticRecall.test.ts`), the polysemy sibling probe set, and the 20k identity gate. The bank's own header says sibling separation "rides on the SMF term alone"; with semantic-is-a signatures the differentiator primes appear to carry it (identity 100% at 1k without the term), but that claim needs the sibling set. And the conversation gate would need recalibrating from 0.8 to ≈ 0.99 for a score without the clock — or better, the isotonic calibration machinery (`calibration.ts`) should set it per arm.

It also does not close the question of whether the field can earn a job. Two candidates remain, both from IMPROVEMENT_PLAN §2.1: the **context sketch** as a deliberate feature (the recency signal supports context-cued recall and priming — measure it *as that*, not as identity recall), and the **resonant readout** (excite the top-K candidates and let the inhibitory sweep arbitrate) against a softmax null on the sibling set. Those are the next two benches. If neither beats its null, the field is an encoder and the paper should say so.

## The live system constraint

The observer is operational — a long-lived server with a real learning record. That rules out one of the two dominant arms as a production change and leaves the other:

- `static` changes how traces are **encoded at store time** (per-moment imprint). Flipping it would leave every existing trace encoded under the old trajectory and every new one under the new rule — mixed encodings in one bank — and the only clean path is a re-teach, which is not acceptable for a system that has learned. It stays an experimental arm.
- `smf-off` changes only the **readout** (`smfWeight: 0` in the scoring blend). Stored traces are untouched, so it can be evaluated against the live record with zero writes and, if it holds, switched without migration. The conversation gate would move with it (from 0.8 to the bench's matched gate ≈ 0.99, or better, set by the isotonic calibration machinery per arm).

The bench therefore has a **record mode**: `NULL_ARMS_RECORD=public/bootstrap.json npm run null-arms-bench` imports the observer's own exported snapshot into a fresh in-memory observer and probes it under each readout arm. It reads the file and writes only to `bench/null-arms/*-record.json`; the running server is never touched.

## Next steps (in order)

1. Record mode on the live snapshot, `control` vs `smf-off` (and `coupling-0`), then the paraphrase semantic-recall gate and the polysemy probe set under `smf-off`. If they hold, switch the readout to `smf-off` behind a flag and recalibrate the conversation gate from the record's matched gate. No re-teach, no migration.
2. Split the sketch into content and context (§2.1) and add the context-cued recall bench — the recency signal's own null-model test.
3. Prototype the resonant readout vs. softmax on siblings.
4. Rewrite paper §3.1, §5.1, §5.2 from `bench/null-arms/*.json`.
