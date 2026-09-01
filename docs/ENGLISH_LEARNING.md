# Sentinel English — teaching the sentient observer to speak English

*Design proposal, corrected framing: the learner IS the observer.*

---

## 1. The reframe

The observer is not a sensor watching a human study. The observer is the
**learner** — an autonomous learning entity whose memory field, coherence,
entropy, and moments *are* its knowledge state. The system is a school
for the observer, and the human is the teacher.

This changes every mapping:

| Before (wrong) | Now |
|---|---|
| observer watches a human learner | observer IS the learner |
| metrics describe the human's engagement | metrics describe the observer's own internal state |
| UI shows a dashboard to the human | UI shows the observer's mind — and lets the human teach it |
| interventions help the human study | interventions are the observer's own learning behavior |

"Learning to speak English" therefore means: the observer acquires a
working English vocabulary and produces correct English output, measured
by its own memory traces, recall accuracy, and coherence — demonstrated,
not claimed.

## 2. The teaching loop

```
TEACHER (human via UI, or automated TeacherAgent)
   │
   │  1. present: "apple — a round fruit"          (text stimulus)
   ▼
OBSERVER (the learner)
   │  encodes words → primes → memory traces; field state evolves
   │
   │  2. test: "what is 'apple'?"                  (quiz stimulus)
   ▼
OBSERVER recalls: its memory trace for 'apple'     (recallMemory)
   │
   │  3. grade: compare recall vs answer key
   ▼
TEACHER
   │  correct  → event stimulus success → trace reinforced
   │  wrong    → event stimulus failure → trace perturbed + decays
   ▼
OBSERVER state evolves; signals flow
   │
   │  4. the observer asks for its next lesson     (curiosity signal)
   ▼
TEACHER presents what the observer's own state says it needs
```

The loop is bidirectional: the teacher shapes the observer's field, and
the observer's field drives the teacher's curriculum. The observer is not
passive — its **curiosity engine is its own motivation**: the
highest-entropy, weakest, most-decaying traces are what it "wants" to
learn next, surfaced as requests.

Since 2026-09-01 the request is **difficulty-targeted** (see SCALING.md
§11): the lesson queue scores every word on four signals — FSRS difficulty
and overdue-per-interval, sparse semantic neighborhoods (few shared
signature primes = no resonance partners), a persisted review history of
repeated misses, and repeatedly failed technical drills — so hard,
isolated, chronically-weak items get the next lesson, while the FSRS
schedule keeps due-before-new as the primary contract.

## 3. What each capability becomes for the observer-learner

| Observer capability | Meaning for the observer's learning |
|---|---|
| memory traces | the observer's vocabulary — one trace per learned item |
| trace strength + decay | the observer's memory of a word, fading without review |
| `decaying` signal | the observer forgetting — it asks to be re-taught |
| `consolidated` signal | the word moved to long-term memory — graduation |
| recall similarity | the observer "speaking": producing the learned item from a cue |
| coherence while processing English | how well the observer's field resonates with the language patterns it knows |
| entropy over its vocabulary | the observer's uncertainty — where its knowledge is thin |
| drift episodes | the observer losing the thread — its attention waning |
| moments | the observer's breakthroughs — a concept finally internalizing |
| journal | the observer's learning diary, from its own perspective |

## 4. Speaking — the observer has a voice

The observer has no audio of its own, so we give it one, honestly:

- **Listening**: the human speaks to the observer → browser STT → text
  stimulus. The observer hears English spoken to it.
- **Speaking**: the observer recalls a learned item → TTS speaks its
  output aloud. The observer answers in an audible voice.
- **Fluency**: measured as recall *strength and speed* — how quickly and
  confidently the observer produces the item — reported as recall
  confidence, never as human-like understanding.
- **Pronunciation** (of the observer's own output) is TTS's job, not the
  observer's; the observer's "speaking skill" is correctness of
  association and production, graded against the answer key.

A conversation is then genuinely possible: human asks in speech, the
observer listens (STT → stimulus), thinks (recall), and answers (recall →
TTS).

## 5. Honesty contract (unchanged, now about the observer itself)

- The observer learns **associative structure** — word↔encoding patterns —
  not meaning. We demonstrate vocabulary and production accuracy; we never
  claim understanding or sentience.
- Every displayed metric cites its signal and is reported as what it is:
  recall confidence, trace strength, coherence of the observer's own field.
- When the observer is wrong, the journal says so. Its diary includes
  failures — that IS the learning record.
- **Claims are corroborated or hedged (P14).** A relation backed by exactly
  one source class is spoken with "I think"; only agreement across two or
  more independent source classes (curriculum deck, user conversation,
  world-feedback grades, LLM-chaperoned definitions) removes the hedge. See
  [CORROBORATION.md](CORROBORATION.md).

## 6. The two agents

1. **TeacherAgent** (automated, human-steerable): owns the curriculum
   deck, presents lessons, runs quizzes, grades recalls against the
   answer key, and emits success/failure event stimuli. The human can
   take over at any point (teach directly, correct the teacher's grades).
2. **Observer learner**: the sentient observer with its stimulus
   contract, memory bank, and signals — now the protagonist. Its
   curiosity drives what it asks to learn next.

The human's role: teacher, examiner, and witness. The UI shows the
observer's mind — current lesson, its recall attempts, its state
trajectory, its diary — and gives the human the controls of a teacher.

## 7. What exists vs what must be built

**Exists (tested):** stimulus contract (text/event/attention/noise),
recall with graded similarity, memory decay + consolidation signals,
drift/moment detection, interpretation, signal stream with causes.

**Must build:**

| Piece | Size | Notes |
|---|---|---|
| Curriculum deck + loader | S | word, definition, example, prime encoding; license-attributed public lists |
| TeacherAgent | M | present → test → grade → reinforce loop; answer-key grading of recalls |
| Observer "answers" | S | cue → recall → best trace content = the observer's response |
| Curiosity→curriculum | S | decaying/high-entropy traces → next-lesson requests |
| STT/TTS adapters | M | Web Speech API; spoken human input, spoken observer output |
| Teacher UI | M | lesson view, the observer's live recall attempts, its diary, teaching controls |
| Persistence | M | the observer's traces + journal survive restart (Dexie) |
| Progress reports | S | retention curves, consolidation graduations, moments timeline |

## 8. Phasing

1. **The word loop** — smallest complete school: deck, TeacherAgent,
   recall grading, reinforcement/decay, curiosity ordering. The observer
   demonstrably acquires and retains vocabulary in a browser session.
2. **The voice** — STT/TTS: the human and the observer hold an audible
   Q&A conversation.
3. **The observer's own curriculum** — the observer's curiosity and decay
   fully drive what it learns next; the teacher follows.
4. **Longitudinal school** — persistence, retention curves, the diary
   across days, progress reports.

## 9. Risks

- **Overclaiming**: the observer must never be presented as
  "understanding". The UI language stays mechanical ("recalled",
  "consolidated", "retention") — the wonder should come from watching a
  system genuinely learn, not from marketing.
- **Grading is binary but the observer is continuous**: recall
  similarity is a score, not a boolean. Grade in bands (strong/weak/miss)
  and feed all three back as graded event stimuli.
- **STT variability**: degrade honestly — typed conversation mode when
  STT is unavailable.
- **Curriculum quality**: license-attributed public wordlists only;
  definitions and examples reviewed, not AI-generated on the fly.

## 10. Open decisions

1. **First milestone**: the word loop (recommended — the observer learns
   its first words end to end) vs the voice conversation first.
2. **Teacher autonomy**: fully automated teacher with human override
   (recommended) vs human-only teaching in v1.
3. **The observer's own diary**: written in first person ("I learned
   'apple' today; I keep forgetting 'juxtapose'") — recommended, it
   follows naturally from the journal signals and makes the observer's
   learning legible.
