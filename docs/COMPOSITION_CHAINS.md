# Multi-Predicate Composition Chains (P10)

*Evidence-backed reasoning across typed edges: bird is-a animal → animal
has-part heart → heart capable-of pump ⇒ "birds can pump blood". Status:
implemented and benchmarked (2026-09-01).*

## 1. The gap

`chain.ts` already walks single-predicate paths: `inheritsEdge` (and its
is-a-specialized siblings) answers "does a robin have wings?" by following
robin is-a bird, bird has-part wings. That machinery is limited to ONE
predicate hop after the is-a taxonomy: properties, capabilities, parts, and
purposes inherit down is-a, but nothing ever composes *across* predicates.
"Can a bird pump blood?" — bird is-a animal, animal has-part heart, heart
capable-of pump blood — was unanswerable: three stored edges, no path.

`composition.ts` adds the missing layer: a **composition rule table** that
declares which predicate sequences are sound, how edge evidence propagates
along the chain, and three gates (soundness, MDL, negation) that a chain
must clear before it may speak.

## 2. The rule layer (`apps/web/src/teacher/composition.ts`)

| Predicate sequence | Conclusion | Meaning |
| --- | --- | --- |
| is-a → is-a | is-a | transitivity |
| is-a → has-part | has-part | part inheritance (robin → bird → wings) |
| is-a → capable-of | capable-of | capability inheritance |
| is-a → has-property | has-property | property inheritance |
| is-a → used-for | used-for | purpose inheritance |
| is-a → requires | requires | requirement inheritance |
| is-a → located-in | located-in | place inheritance |
| is-a → made-of | made-of | material inheritance |
| is-a → causes | causes | effect inheritance |
| **has-part → capable-of** | capable-of | a part's capability transfers to the whole (a heart can pump ⇒ a bird can pump) |
| **is-a → has-part → capable-of** | capable-of | the canonical three-hop chain |

Consecutive is-a hops collapse to one (transitivity is itself the
[is-a, is-a] rule, applied twice), so a chain through a multi-level taxonomy
(robin → bird → animal) still matches the three-hop pattern.

**Everything else is unsound by construction** — the table is the rule, not a
free path algebra. Rejected sequences include has-part → has-part (parts of
parts are not parts), capable-of → capable-of (an action is not capable of
things), has-part → is-a (a part being a thing never makes the whole that
thing: car has-part wheel ⇒ "is a wheel a car" must stay silent), and any
sequence through opposite-of.

Each hop carries its edge's confidence weight (`Relation.strength`, absent =
1); the composed claim's `support` is the **weakest hop's** strength — a
chain is only as strong as its least-confident link, and answers hedge
("Probably — ") when it drops below 1.

## 3. The MDL gate — composition is not free

The gate reuses `mdl.ts` (`TokenCostModel`, the same Zipf-frequency prior
the operator learner uses). Per chain:

```
savings  = Σ content-token costs of the spelled-out chain   (what the claim compresses)
claim    = content-token cost of the composed claim
gain     = savings − claim − COMPOSITION_STEP_COST × hops   (2 bits per inference step)
```

A chain is adopted **only when gain > 0**. Content tokens only — predicate
and function words are scaffolding and cost nothing; the gate weighs the
claim's information, not its grammar. Consequences:

- The canonical is-a → has-part → capable-of chain passes with positive
  gain on any realistic frequency model (and on small graphs).
- A chain through the graph's *cheapest* word fails: deriving "x has z"
  through a ubiquitous intermediate compresses less than the inference
  costs. This is the demonstrated "composition is not free" behavior —
  cheap chains are stated directly, rare informative chains compose.
- On the full production deck (20k words, min token cost ≈ 3.4 bits) every
  sound chain clears the bar; the gate's teeth show on small vocabularies,
  where it prevents trivial composition. The critic applies the SAME gate,
  so a sentence the composer would not emit can never be backed.

## 4. Negation handling

`deniedFromNegations` (composition.ts) checks a claim against the
confirmed-false store. A chain is **rejected when any hop OR the conclusion
conflicts** — a taught "an animal does not have a heart" kills every chain
that would derive a bird's pumping heart, and the observer asks instead of
inferring. Unrelated negations never interfere. Absence of a negation is
never evidence for a chain.

## 5. Integration points

- `groundedFrames.ts` — `framesFor` appends composed frames ("A bird can
  pump blood.") for claims no single edge answers; `criticize` (the
  internal critic) backs a claim via `composeClaim` when no direct or
  inherited edge states it, citing the chain's **stored hops** as evidence;
  `parseClaims` gained the "is located in" clause so composed located-in
  frames round-trip.
- `operators.ts` — the composed fallback (`composedClosedAnswer`) answers
  closed relational forms ("can a bird pump") after every single-predicate
  path is silent. The new `composed` operator kind cites the hops, never
  the derived claim, so P8 grade feedback strengthens/weakens real edges.
- `TeacherAgent.ts` — passes the full-deck `TokenCostModel` and the
  negation store into both paths; `operatorEdges` maps the composed kind to
  its hops.

## 6. Benchmark — composed answers vs. the single-predicate baseline

Extension of `chain.test.ts` (`multi-predicate composition benchmark`): 10
fixed, hand-labeled novel relational probes over one graph, measured with
the pre-change machinery (direct edge or is-a inheritance only) and with
composition on the identical probes. FALSE probes (unsound sequences like
"is a wheel a car") must stay declined under BOTH paths — composition may
never add a wrong answer.

| Path | Correct | Accuracy |
| --- | --- | --- |
| Single-predicate baseline (inheritsEdge) | 8/10 | **80%** |
| With composition (this change) | 10/10 | **100%** |

The delta is exactly the two composed-only probes (can a bird pump, can a
robin pump); the eight baseline-answerable and false probes are unchanged.
CI floor: composed ≥ baseline and 100% on the fixed probe set.

## 7. Caveats

- **has-part → capable-of is a transfer, not an identity.** "A bird can
  pump" is the whole acting through its part; the chain is cited in the
  answer ("bird is an animal, animal has heart, and heart can pump"), so
  the claim's provenance is visible and a wrong grade weakens the real
  edges. The phrasing deliberately never says "the bird itself pumps".
- The rule table is deliberately small. Longer predicate sequences
  (has-part → capable-of → used-for, ...) are NOT composed — each addition
  must earn its place with evidence, the same discipline the MDL gate
  enforces per chain.
- Composition produces affirmative claims only; negated conclusions are
  expressed by the negation store ("No — I was taught that."), never by
  composing absence.
- Multi-word objects (chaperone edges like "pump blood") compose and
  round-trip through the critic; the operator grammar's closed forms remain
  single-word by design.
