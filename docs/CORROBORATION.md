# P14 — Cross-Source Knowledge Corroboration

*Sentinel cognitive engine: a claim is only spoken flatly when independent
sources agree. One source states; two sources corroborate.*

---

## 1. The problem

The relation graph is the observer's epistemic floor: no claim is emitted
unless backed by a stored edge. But *backed* is not the same as *certain* —
an edge can rest on exactly one kind of evidence:

- a regex extraction from a taught definition,
- a single LLM-chaperoned suggestion,
- one passing exchange with the user.

Stating every backed claim with the same flat voice conflates "the deck says
so" with "two independent sources say so". The honesty contract demands the
observer never fabricate; P14 adds the second half — the observer must not
OVERSTATE a claim its own provenance shows to be weakly supported.

## 2. The four source classes

A **source class** is an independent knowledge channel. Classes are
deliberately coarse so agreement is real agreement — the technical
curriculum, the everyday supplement, and the grounded-facts deck are all
`curriculum`, and agreeing with yourself is not corroboration.

| Class | Comes from | Stated by |
|---|---|---|
| `curriculum` | deck definitions (regex extraction) + authored curriculum decks | the reviewed, license-attributed deck |
| `definition` | LLM-chaperoned edges/definitions (origin `chaperone`) | the LLM chaperone — an untrusted single source until another class agrees |
| `conversation` | mined user statements ("my dog can bark" → dog capable-of bark) and past chat transcripts | the user, using the words in a sentence |
| `world-feedback` | accepted graded answers citing the edge (strong semantic grade) | the world, accepting the observer's answer |

## 3. The policy

```
corroborationConfidence(classes):
  1 class, curriculum        -> 1.0     (one stated, reviewed source — the P8 baseline)
  1 class, definition        -> 0.6     (one LLM claim — weak until corroborated)
  2 classes                  -> 1.0     (agreement removes hedging)
  3 classes                  -> 1.2     (margin above 1.0 survives small grade deltas)
  4 classes                  -> 1.4

effective strength = max(0.1, corroborationConfidence + grade/agreement overlay)

hedgeFor(classes, strength):
  strength < 1            -> "Probably"    (the P8 weakened-edge contract)
  >= 2 independent classes -> ""            (corroborated — assert flatly)
  1 class                 -> "I think"      (single-source — hedge, never fabricate)
```

Where it applies:

- **Operator answers** (question-answering): single-source curriculum edges
  keep strength 1.0 (the documented "1 = a single stated source" contract);
  single-source *chaperone* edges drop to 0.6 and answer "Probably…" until
  another class agrees. Corroboration restores and exceeds 1.0.
- **Generated output** (grounded frames, the `groundedFrames.ts` +
  `grounding.ts` path): every claim whose backing edge is single-source is
  spoken as "I think …"; every claim whose edge was weakened by grades is
  spoken as "Probably, …"; corroborated claims are spoken flatly. The hedge
  is applied AFTER the internal critic verifies the raw sentence, so it can
  never smuggle an unbacked claim past the critic.

## 4. Evidence mining (b)

- **User statements** — every `chatAnswer` turn is mined: a DECLARATIVE
  statement that expresses an existing relation ("my dog can bark", "robins
  are birds", "snow is cold") adds the `conversation` class to that edge.
  Questions and negations never mine ("is a robin a bird?" asks; "a robin is
  not a bird" contradicts). Co-mention without the predicate is not
  evidence: "the dog chased the cat" never supports dog is-a cat.
- **Past conversations** — user messages from persisted transcripts
  (conversations.ts) are mined once at construction.
- **Deck examples** — "A bird can fly." is the reviewed deck itself
  confirming bird capable-of fly; an example that expresses a chaperone edge
  adds the `curriculum` class to it.
- **Graded answers** — a strong semantic grade of an answer citing an edge
  adds `world-feedback`; a weak grade withdraws it.

## 5. Persistence (d)

Edges carry their provenance on the graph: `Relation.sourceClasses` (the
distinct supporting classes) and `Relation.strength` (corroboration base +
overlay). The accumulation lives in the TeacherAgent's per-edge store and
survives restarts (`learningState.edgeSources`) and bootstrap export/import
(`BootstrapRecord.edgeSources`), so later phases — curriculum scheduling,
the contradiction sweep, the deviation meter — can read the corroboration
state of any edge.

## 6. Files

| File | Role |
|---|---|
| `src/teacher/corroboration.ts` | policy + hedge words + evidence miner (pure) |
| `src/teacher/relations.ts` | `SourceClass`, `sourceClassForOrigin`, `Relation.sourceClasses` |
| `src/teacher/grounding.ts` | `claimHedge` (the grounding path's integration point), `stripHedges` |
| `src/teacher/groundedFrames.ts` | corroboration-aware critic (`hedged`/`hedges`), `hedgeComposition` |
| `src/teacher/TeacherAgent.ts` | edge-source store, mining, strength stamping, creative hedging, persistence |
| `src/teacher/corroboration.test.ts` | policy tests (single-source hedging, promotion, mining) |
| `src/teacher/corroborationBenchmark.test.ts` | recall-accuracy + assertiveness benchmark |

## 7. Benchmark (measured)

`npm run test:bench` (official gate set) with corroboration active:

```
BENCH: top-1 recognition accuracy 100.0% (30/30)          (floor ≥ 0.7 — unchanged)
CI-GATE calibration error: 0.113                          (≤ 0.15)
CI-GATE frontier: ASK 33% · accuracy-when-answering 100%  (≥ 0.8 / ≤ 0.4)
```

P14 corroboration benchmark (corroborationBenchmark.test.ts):

```
BENCH: single-source hedged rate 100% (3/3) · corroborated assertive rate 100% (3/3)
```

Weak-claim hedging does not reduce recall accuracy — hedging is a
presentation change on the same graph — and the moment an independent class
agrees with an edge, the same prompt is spoken assertively.

## 8. Caveats

- The hedge applies to the SPOKEN form. The deviation meter scores the
  composition with hedge markers stripped ("I think" is presentation, not
  stitched content), so hedging cannot be gamed to inflate grounding.
- Mining is conservative by design: uncommon predicates (`causes`,
  `requires`, `opposite-of`, …) have no safe surface pattern and are never
  mined — co-mention is not corroboration.
- A single-source claim is hedged, never deleted: the graph keeps the edge
  so the NEXT agreeing source can promote it. Absence of corroboration is
  not absence of truth — it is epistemic modesty, and the calibration gate
  (hedged answers must be as unreliable as they claim) is preserved.
