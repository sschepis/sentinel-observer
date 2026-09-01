# Observer Interfaces & Processes

*Design proposal: closing the gap between the sentient observer's raw physics
and a meaningful learning workbench. Status: proposed for review.*

---

## 1. The gap

Today the observer has exactly one input — free text — and exactly one
output — a tick of numbers. The problems:

| Symptom | Root cause |
|---|---|
| Numbers with no meaning | The physics layer emits raw metrics; nothing connects a metric change to *what the user did* |
| No clear inputs | `processInput(text)` has no semantics: everything is the same kind of poke |
| No consequences | The observer has no way to act, and the app has no way to act on it |
| Coherence 0.213 says nothing | No cause tracking, no interpretation layer, no time-series context |

The observer is a **sensor**, not a conversation. What's missing is a
**contract between the sensor and the learner**: typed stimuli in, typed
signals out, with causes attached.

---

## 2. Design principles

1. **Causality first.** Every signal carries `causeId` — the stimulus,
   session, or decay event that produced it. An unexplained metric is a bug,
   not a feature.
2. **The observer stays a pure engine.** It never decides what the user
   should do. It emits *signals*; an **interpreter** layer (app-side) turns
   signals into language and suggestions.
3. **Interpretation is honest.** Every interpretation cites the signal it
   came from. If no interpretation template exists for a signal, the
   interpreter says "uninterpreted" — it never invents meaning.
4. **Inputs are real learning events, not arbitrary pokes.** Each input type
   corresponds to something a learner actually does.
5. **Everything is a stream.** Time series of metrics, signals, and
   interpretations — so the UI can show *how we got here*, not just *where
   we are*.

---

## 3. Input interfaces (stimuli)

One typed union replaces raw `processInput` at the app boundary. Each
variant maps to real physics with documented semantics.

```ts
type Stimulus =
  | { kind: 'text';    content: string; weight?: number; sourceId?: string }
  | { kind: 'attention';
      focus: 'reading' | 'review' | 'quiz' | 'idle';
      intensity: number }                      // 0..1, from UI activity
  | { kind: 'event';
      type: 'quiz.answer' | 'review.completed' | 'note.created' | 'source.ingested';
      outcome: 'success' | 'failure';
      detail?: string }                        // e.g. the quiz question text
  | { kind: 'noise';   level: number }         // explicit resting baseline
```

**Semantics table** (what each input does and why):

| Input | Physics | Learning meaning |
|---|---|---|
| `text` | excite primes for the content | "I am reading/studying this" |
| `attention reading, 1.0` | raise coupling → field follows excitation faster | "I am focused on the content" |
| `attention idle, 0.2` | lower coupling; excitation decays | "I am away — let the field relax" |
| `event quiz.answer success` | re-excite the question's primes, raise coherence target | "this concept clicked" |
| `event quiz.answer failure` | perturb the question's primes | "this concept is unstable — revisit" |
| `event source.ingested` | strong one-shot excitation + memory store | "new material entering the mind" |
| `noise` | baseline excitation amplitude | resting state, replaces implicit priming |

**Return contract** — `observe()` answers immediately with *what happened*:

```ts
interface StimulusResult {
  stimulusId: string;
  excitedPrimes: number[];
  touchedAxes: SMFAxisName[];     // which of the 16 axes moved
  coherenceDelta: number;         // immediate effect
}
```

The UI shows: *"excited primes [2,3,5] → axis 'structure' moved +0.04"*.
Causality becomes visible at the moment of action.

**Adapters** (app layer) translate real activity into stimuli:
- reading pane → `text` chunks (paragraph-scoped, not wall-of-text)
- scroll/typing/idle timers → `attention`
- quiz interactions → `event`
- ingest pipeline → `event source.ingested`

---

## 4. Output interfaces (signals)

The observer's tick produces raw metrics; on top of that it emits a typed
signal stream. Each signal has `{ id, causeId, timestamp, physics }` plus
app-side interpretation.

```ts
type ObserverSignal =
  | { kind: 'metric';      metrics: ObserverMetrics }            // every tick
  | { kind: 'insight';     moment: InsightMoment }               // coherence crossing
  | { kind: 'drift';       axis: SMFAxisName; direction: 'down'; durationMs: number }
  | { kind: 'concept';     conceptId: string; coherence: number; entropy: number }
  | { kind: 'memory';      event: 'stored' | 'decaying' | 'consolidated';
                           traceId: string; sourceId?: string }
  | { kind: 'suggestion';  type: 'review' | 'explore';
                           target: string;                        // concept/source
                           reason: { axis: SMFAxisName; entropy: number } };
```

**Interpreter layer** (app) turns each signal into language using
templates with the physics filled in:

```
signal: drift { axis: 'coherence', durationMs: 120000 }
→ "Focus on 'coherence' has been falling for 2 minutes —
   caused by: attention idle (3 min ago)"
```

Signals the interpreter cannot template are rendered as
`uninterpreted: <kind>` — never silently dropped, never embellished.

**The metric card gets a third line** — "why": last stimulus or signal
that moved it. This is the single highest-value UI change: every number
tells its story.

---

## 5. Processes

Four end-to-end flows wire inputs → observer → signals → user action.
Each is a testable process, not an ad-hoc feature.

### A. Study session
```
open session → noise baseline
  → ingest source (text chunks, attention stream)
  → observer ticks; signals: metric*, insight?, drift?
  → close session → snapshot {fingerprint, moments, conceptStates} → persist
```

### B. Review loop (memory decay → action → reinforcement)
```
memory signal 'decaying' (trace entropy crosses threshold)
  → interpreter: suggestion 'review' for that concept
  → user answers quiz → event stimulus success/failure
  → success: trace refreshed (coherence rises — visible)
  → failure: reschedule sooner (entropy stays high — visible)
```

### C. Curiosity loop
```
after session: inspect SMF axes for lowest coverage / highest entropy
  → suggestion 'explore' with the axis as the reason
  → user ingests → new text stimulus → axes move (visible)
```

### D. Grounding loop (the contract that makes everything believable)
```
user action → stimulus (with causeId)
  → observer response (StimulusResult — immediate)
  → tick signals (delayed evolution)
  → interpretation (language + cause)
  → UI shows action → effect → explanation
```
If any link in this chain is missing for a displayed number, that number
gets no screen time.

---

## 6. Implementation phasing

| Phase | Where | Work |
|---|---|---|
| 1. Stimulus contract | sentient-core | `observe(stimulus)` + `StimulusResult`; cause tracking on excitations; attention→coupling mapping; quiz event semantics |
| 2. Signal stream | sentient-core | signal pipeline (drift detection from metric history, memory decay detection, concept tracking); bounded history ring buffer for all signals |
| 3. Interpreter | web app | template registry; `uninterpreted` passthrough; metric-card "why" line |
| 4. Adapters + processes | web app | attention/activity adapters, quiz adapter, review loop, session snapshot + persistence (Dexie, M1/M3 of the plan) |
| 5. Grounding verification | tests | property tests: every signal has a cause; every interpretation cites a signal; every stimulus yields a non-empty result when the kernel is loaded |

This lands inside milestones M1 (session/journal) and M3 (interventions)
without changing the plan's shape — it makes those milestones concrete.

---

## 7. Episodic memory: the selective journal

The working-memory window is deliberately session-scoped — raw conversation
must not survive restarts. Episodic memory is the deliberate, selective
exception, and it earns the exception by being **selective and honest**:

| Stored | Source | Example |
|---|---|---|
| `user-fact` | explicit first-person statements | "I am learning English for work" |
| `vocabulary` | demonstrated grades (the observer's own measurements) | "you have been struggling with water" |
| `topic` | content words recurring across turns **and sessions** | "you have talked about apple in 2 sessions" |
| `time` | session boundaries, gaps between sessions | "a new session began after a gap of 2 days" |

What it never stores: transcripts, observer replies, transient states
("I am tired" is weather, not a fact), anything not measured or stated.

**Salience policy (bounded, episode discipline).** One fact per episode, not
a log: repeated observations *merge* into the existing fact. Each fact
carries a persistent score — kind base (facts about the human outrank
mechanics) × recency (freshness halves weekly) × frequency (saturates at ~4
sightings) — with a boost for repeated demonstrated failure (task-relevant).
Pruning keeps the store bounded (64 facts by default): below-floor facts are
forgotten, session-gap facts fall off a 30-day TTL, and beyond the cap the
lowest-salience facts are evicted — the same one-signal-per-episode
discipline as the drift detector, applied to memory instead of coherence.

**Retrieval contract (honesty gate).** A fact is retrieved only when the
current turn touches one of its topics — no overlap, no injection. Every
retrieved entry is tagged as remembered, and the observer may *speak* a
memory only above a spoken-relevance floor ("I remember you found water hard
last time" quotes a measured grade, never a guess). The hybrid voice is
conditioned on the remembered facts with an explicit "never invent facts"
instruction; the semantic grader still arbitrates what enters memory.

**Persistence.** The journal rides the existing persistence contract
(IndexedDB v5 `episodicMemory` table, in-memory store in degraded
environments, reported honestly), restored on the same path as traces and
word states. Near-threshold topic counters persist too, so recurrence that
spans a restart still forms a fact — with both sessions on record.

## 8. Open questions for you

1. **Concept registry**: should concepts (human-readable labels for primes)
   be user-defined per session ("this article is about X") or auto-derived
   from the SMF axes? Default: user-defined, axes are the fallback labels.
2. **Suggestion authority**: may the app auto-open a review card, or should
   suggestions always wait for user consent? Default: queue, never interrupt.
3. **Retention of signals**: keep signal history per session only, or a
   persistent searchable log (journal)? Default: session-scoped ring +
   persistent journal of insight/suggestion signals only.
