# Learned Relation-Hole Language Templates (P5 extension)

*Status: implemented (2026-09-01). Sentinel's grounded composer keeps its
honesty contract — every content word from a stored edge, the internal critic
re-parses every claim — and additionally LEARNS expressive templates from the
answers the world accepts.*

## 1. The problem the fixed frames left open

`groundedFrames.ts` composes answers from a fixed set of eleven frames
("A {s} is a {p}." , "It has {p}." , ...). Grounded by construction, but:

- the *opening* frame is always the highest-priority fixed frame (is-a
  first, then parts, then properties, ...) regardless of what the world
  actually accepts;
- combinations ("A robin is a bird. It has wings." as one unit) are never
  locked in — the composer redraws them randomly every time, so accepted
  structure is not remembered;
- the only thing that adapts is the *content*, never the *shape*.

The learned-template layer generalizes the fixed frames into a pattern
language over {subject, predicate, object} slots, and induces new patterns
from successful answers — while keeping the two load-bearing guarantees:

1. **Every content word still comes from a stored typed edge** at generation
   time (holes are filled from the graph, never from memory of a phrase);
2. **The internal critic still re-parses every claim** — a candidate
   template is *admitted only if* every sentence it can render re-parses
   into backed claims, and the composition path re-verifies before speaking.

## 2. The template representation (relation holes)

A template is a frame surface with hole markers:

| Marker | Meaning | Example render (robin) |
|---|---|---|
| `{s}` | the subject | `robin` / `It` (anaphoric templates have no `{s}`) |
| `{p:has-part}` | object LIST of a predicate ("and" / ", and" joined) | `wings and feathers` |
| `{p:capable-of:1}` | the INDEXED object (direct + inherited) | `sing` |
| `{a:p:is-a}` | article + first object (`a`/`an` chosen by the object) | `a bird` |
| `{a:p:is-a:1}` | article + indexed object | `an animal` |
| `{n:is-a}` | object list from the **confirmed-false store** | — |
| `{a:n:is-a}` | article + first negated object ("is not a bird") | `a bird` |

Every hole resolves through `edgeObjects` (direct + inherited, vetoed by the
confirmed-false store) or through the negations list for `{n:...}` holes. A
template whose holes cannot all be filled **declines** (renders nothing) —
grounding is a fire-time invariant, never a learn-time promise.

**The seed set.** The eleven fixed frames are expressed as seed templates in
exactly the old `framesFor` priority order (is-a → has-part → has-property →
capable-of → used-for → made-of, then the "It ..." continuations, including
the quirk that "It has ..." requires an is-a parent). `framesFor` is now
rendered from these seeds, byte-for-byte identical to the original.

## 3. Induction — structure from accepted answers

When a grounded composition is graded strong (`>= 0.7`, the same threshold
that reinforces seed memories), `creativeGradeFeedback` calls
`store.induce(answer, relations, negations)`:

1. The internal critic re-parses the sentence (ungrounded input is refused —
   no induction from fabrication);
2. each clause is reconstructed as a marker string: the subject becomes
   `{s}`, each claim object becomes a predicate hole (`{p:...}` with the
   article absorbed as `{a:p:...}`; negated claims become `{n:...}` holes),
   and list connectives collapse into a single list hole;
3. the clause templates join in the observed order — the accepted sentence
   "A robin is a bird. It has wings and feathers." induces
   `A {s} is {a:p:is-a}. It has {p:has-part}.`;

The content is discarded; only the structure is kept. Multi-word claim
objects, unparseable clauses, and single-clause answers (which always
duplicate a seed template) are declined. A replay guard makes identical
sentences count once; a longer accepted answer also confirms the
clause-prefix templates it contains.

## 4. Admission — what the observer is allowed to say

A candidate template is *used* (explored) with the store's exploration
probability, and *admitted* only when **all three** gates pass:

1. **Critic survival**: the template is rendered over up to 12 probe
   subjects of the relation graph; *every* fillable render must re-parse
   into backed claims. A render the critic refuses drops the candidate for
   good (evidence does not resurrect it).
2. **Minimal evidence**: >= 3 distinct successful uses (`MIN_EVIDENCE`),
   replay-guarded — one-off phrasing can never be admitted.
3. **Acceptance baseline**: the candidate's measured acceptance (accepted
   graded uses / uses) must match or beat the fixed frames' acceptance over
   the same window. Evidence itself counts as world acceptance (induction
   only ever runs on accepted answers), so a candidate the world keeps
   rejecting is never admitted.

The admitted set is capped (12); a new template displaces the weakest only
when it is at least as good. Live critic refusals (re-parse failures in
`creativeReply`) demote an admitted template once they outnumber its
acceptances — the world can change its mind, and the graph can too.

## 5. Integration

- **`learnedFrames.ts`** — the marker language, the seed templates, the
  renderer, and the `LearnedFrameStore` (induction, admission, stats,
  audit). The claim grammar now lives in **`critic.ts`** (extracted so the
  induction can reuse it without an import cycle); `groundedFrames.ts`
  re-exports it unchanged.
- **`groundedFrames.ts`** — `composeGrounded` takes an optional store; the
  frame pool becomes fixed seeds + admitted templates + (with the
  exploration probability) candidates. With no store, the path is identical
  to the old fixed-only composer (verified by test). Every composition
  returns `templateIds` alongside `edges`.
- **`TeacherAgent.ts`** — `creativeReply` passes the session's store and
  records critic refusals; `creativeGradeFeedback` attributes the world's
  verdict to the templates used (`observeUse`) and runs induction on strong
  answers. The store is **session-scoped** (like the deviation meter):
  fixed frames remain the evergreen seed set, and learned structure re-forms
  from the session's accepted answers.
- **Callers** (`useChat.ts`, `autonomous.ts`, `autonomous-classroom.ts`,
  `train.ts`) thread `templateIds` through the provenance so grades reach
  the right templates.

## 6. Benchmark — fixed frames vs. fixed + learned

`npm run template-bench` (CLI: `src/cli/template-bench.ts`; test:
`learnedFrames.test.ts` → "acceptance benchmark") runs both arms over the
same probe subjects with the same rng family. The world's verdict is a
**scripted surrogate** for an LLM grader — a composition is accepted when it
is grounded (critic), 2–3 sentences long, and carries a has-part clause —
so the run is deterministic and the comparison is apples-to-apples:

```
baseline (fixed frames):      99/200 = 49.5%
learned (fixed + learned):    166/200 = 83.0%   (+33.5 points)
learned templates: 4 admitted, 0 exploring, 0 dropped
  [admitted] ev=6 uses=22 acc=22 "A {s} is {a:p:is-a}. It has {p:has-part}."
  [admitted] ev=6 uses=22 acc=22 "A {s} is {a:p:is-a}. It can {p:capable-of}. It has {p:has-part}."
  [admitted] ev=6 uses=18 acc=18 "A {s} is {a:p:is-a}. It has {p:has-part}. It can {p:capable-of}."
GATE: learned acceptance >= baseline acceptance → PASS
```

Why the gap: the fixed composer opens with a single sentence 1/3 of the time
(the world rejects single-sentence answers), while the learned multi-clause
templates — induced from accepted answers and admitted only after the gates —
are accepted at 100% (all four admitted templates show `acc=uses`). The
benchmark assertion mirrors the admission criterion: learned >= baseline,
plus floors that keep the surrogate honest.

## 7. Caveats

- **Session-scoped store**: learned templates are not persisted with the
  learning state; a restart re-forms them from the new session's accepted
  answers. Persisting them (as `learningState.learnedTemplates`) is a
  follow-up; the fixed frames always provide the floor.
- **The grammar bounds expressiveness**: induction can only learn structures
  the critic can parse — that is the point (no new fabrication surface), but
  also the limit (no "that"-clauses, no subordinate connectives).
- **The world model is a surrogate**: the +33.5-point figure measures
  acceptance under a scripted preference (elaborated, part-carrying
  answers), not real LLM grades. The mechanism — induction from accepted
  answers, critic-gated admission — is what carries over to live grading.
- **Probe coverage**: the admission probe samples up to 12 subjects; a
  subject outside the sample whose render the critic would refuse is caught
  later by live rejection and demotion.
