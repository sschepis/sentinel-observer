# Feeding the observer — the curriculum pipeline

*2026-09-08. Code: `apps/web/src/curriculum/`, `apps/web/src/cli/fetch-conceptnet.ts`, `apps/web/src/cli/fetch-hf.ts`.*

## The idea in one paragraph

The observer is only as deep as its world, and its world was a dictionary, a few hundred hand-written exchanges, and whatever a language model volunteered. Real corpora exist for every one of its input channels. The pipeline brings them in through five doors — the five shapes the observer can actually ingest — under a budget, with a held-out slice for the benches, and never touches the network from the server. A source that fits none of the five shapes is not training material for this system, however large it is.

| shape | what it is | where it goes | source in the corpus |
|---|---|---|---|
| relations | typed edge (subject, predicate, object) with a source class | the relation graph, multi-valued | ConceptNet 5 (`conceptnet.en.jsonl`) |
| definitions | word → gloss + example | the deck (`applyDefinitions`), which also admits the word | Simple English Wikipedia lead sentences, extracted from `passages.jsonl` (`definitions.jsonl`) |
| dialogue | short cue → response | the conversation deck | DailyDialog (`dialogue.jsonl`) |
| passages | declarative prose | the reader (`readFrom`) | Simple English Wikipedia, TinyStories (`passages.jsonl`) |
| problems | question + checkable answer | posed and checked, no LLM | SVAMP, ASDiv (`problems.jsonl`) |

## How to fill the corpus (run on your machine — the server never downloads)

```
cd apps/web
npm run fetch-conceptnet                  # streams the 1.2 GB dump; keeps rows with at least one deck-word end
npm run fetch-hf -- dailydialog           # short single-turn pairs in the cue grammar
npm run fetch-hf -- simplewiki --rows 20000
npm run fetch-hf -- tinystories --rows 20000
npm run fetch-hf -- svamp
npm run fetch-hf -- asdiv
npm run extract-definitions               # passages.jsonl → definitions.jsonl (no network: the glosses are already on disk)
```

Everything lands in `apps/web/corpus/`. The server picks that directory up by default (`--corpus DIR` / `OBSERVER_CORPUS` to point elsewhere) and logs `corpus …` at boot.

## How it goes in

Every 5 classroom cycles the feeder hands the observer 1,000 rows of the next source with rows left (round-robin), converts them with the shape's adapter, ingests them, and advances a cursor that is persisted in the learning state — a restart resumes, nothing is ingested twice. Every tenth row of every source is held out and never ingested; the benches read those rows. `OBSERVER_CURRICULUM_EVERY` and `OBSERVER_CURRICULUM_BUDGET` change the cadence and the slice without editing code.

**Knowledge is consumed; practice is not.** A relation, a definition or a passage teaches something the observer then holds, so those cursors only move forward. A word problem teaches nothing — it is an exercise, and what it produces is a grade against whatever the observer can derive *today*. Its cursor therefore wraps: when the last problem has been attempted the corpus starts again, at a smaller slice (50 rows a feed, since each row costs a full answer), and the classroom keeps practising. Before this, the 3,004 problems were spent once — by the story parser that got 19 of 24 wrong — and the corpus was dead to learning for good; the accuracy of the current pass is now in the training stats and the Introspect panel, because a checkable source's accuracy is the one number that says whether the arithmetic is improving.

**A corpus that is present but inert must not look like one that is teaching.** `curriculum/corpusWiring.test.ts` (bench config) walks the real corpus directory and reports, per source, what one feed changes in the observer — deck words, graph edges, exchanges, grades — and fails a source that changes nothing and grades nothing. It also names any reader with no file: that is how `definitions.jsonl` was found to have had a reader and no producer since the day it was written, while 9,039 ConceptNet-grown words sat with `definition: ''`.

The budget comes from a measurement (`ingestScaleBenchmark`, full 20k deck): a 1,000-row relation feed costs about a second, the graph rebuild 0.3 s at 30k edges and 1 s at 110k, and a relational question stays at ~150 ms throughout. A 300k-row ConceptNet file lands in a few hours at this pace.

## What each source means to the observer

**Definitions.** Simple English Wikipedia opens each article with a definition of its own title — "Air is the Earth's atmosphere", "Aquaculture is the farming of fish, shrimp, abalones, algae, and other seafood" — and `passages.jsonl` already holds 19,324 of them, so the missing corpus needed no download: `npm run extract-definitions` lifts the lead sentences into glosses (2,875 of them, after filters that demand a single-word title, a copular lead whose subject is that word, and prose that is a meaning rather than a list of links or a disambiguation notice). A definition row may also ADMIT its word: the deck already grows from ConceptNet with empty definitions, so a row that brings a gloss is better vocabulary than the empty slot it replaces. An authored deck gloss is never overwritten. Definitions pay for themselves twice — the gloss is what the definition-extracted relation graph is built from, so 27 glosses in one feed produced 6 new edges on their own.

**ConceptNet.** Its relations are the observer's predicates: IsA, PartOf, HasA, AtLocation, MadeOf, HasProperty, CapableOf, UsedFor, Causes, Antonym, HasPrerequisite, DefinedAs → is-a, has-part, located-in, made-of, has-property, capable-of, used-for, causes, opposite-of, requires, defined-as. Its `Not*` relations become confirmed-false claims — the first negatives the honesty benches have that come from outside the observer's own graph. Ingestion is multi-valued (a knowledge graph states many objects per predicate; only a stored denial refuses an edge, and a same-batch denial is applied first). A claim only ConceptNet states is spoken hedged ("Probably, a zebu is a mammal") until a taught definition or a read passage agrees, exactly like a chaperone edge; the ConceptNet weight adds a small confidence overlay so a heavily attested edge weathers a wrong grade. Edge origins now survive restore instead of collapsing to "chaperone".

**Vocabulary growth.** A word here is a prime signature, and the deck's 20k signatures are derived as a unit with every stored memory encoded under them — so the corpus cannot simply be appended to the deck. Instead the observer grows its vocabulary append-only: a ConceptNet row whose one end is a deck word and whose other end is an unknown single word makes the observer *learn that the word exists* — a word-only entry with its own collision-free signature and no definition (recognition quizzes only; encounter counts drive the curiosity to ask what it means, which the definitions source will answer). Grown words are persisted with their exact primes and re-added byte-identically on restore; the deck fingerprint never changes. The gate (`vocabularyGrowth.test.ts`) asserts that every pre-existing signature and every recall of a taught word is unchanged after growth. Single tokens only — `ice cream` has no token in this system yet. Rows with no deck-word end are not kept: the graph stays anchored to words the observer can define.

**Dialogue.** The observer memorizes whole exchanges, so the useful unit is one short turn and its reply. DailyDialog is cut into consecutive (turn, reply) pairs and filtered hard: a one-sentence cue of at most twelve words in the lowercase cue grammar, a whole reply, no names, numbers or context-bound pronouns. Most of the corpus is refused, on purpose.

**Passages.** The reader's claim grammar reads timeless declaratives. Wikipedia articles are cut to their lead (before the first heading), markup and parentheticals stripped; TinyStories are kept whole. `passageBenchmark` reports each source's parse rate, claims per passage and a claim sample over the held-out rows — that is what a source's reading budget is set from, and it is where narrative is expected to lose to encyclopedia prose.

**Problems.** Arithmetic word problems are posed through the observer's own stack (story parser → rewrite engine) and checked exactly. A correct answer credits the answer drive; a wrong one books the grade against the rules the derivation used and weakens them; an ask is an abstention. This is the one channel where the grader check has nothing to vouch for. bAbI-style story-state questions are deliberately not ingested yet: the observer has no engine that answers them, so a bench would only measure their absence.

## What to watch after the corpus is in

`corpus rows fed / taken` on the introspection page; the learning stream's `curriculum` events (one per feed, with new/agreed/denied counts for relations, right/wrong/abstained for problems); the deviation meter's grounded share (it should rise as more claims cite edges); and the honesty gates, which must not move — more knowledge is not a licence for more false yeses.
