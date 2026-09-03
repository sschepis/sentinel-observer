# Rule Learning: the observer acquires procedures

*Status: **implemented, measured** (R0–R6 landed; 979 web + 271 core tests
green, typecheck clean, mathBench zero fabrication). This document is the
design record; the implementation findings and deviations from the plan are
recorded in §12, honestly, with the numbers.*

---

## 0. The thesis

Mathematics, logic, and the chained inference the observer already performs
are the **same capacity**: applying rules to structures, composing those
rules, and checking the result. The observer has three partial versions of
that capacity today, each bounded in the same way:

| Mechanism | File | What it learns | The bound |
|---|---|---|---|
| Language operators | `teacher/operators/learning.ts` | Surface templates (`{slot}` + relation holes) | Surface only — no procedure |
| Composition rules | `teacher/composition.ts` | Nothing — `COMPOSITION_RULES` is authored | "the table is the rule, not a free path algebra" |
| Drill programs | `teacher/technical/dsl.ts` | Selects programs from a fixed grammar | Primitives are axioms (`add`), no recursion |

All three share one deficiency: **the rules are fixed by the programmer; the
observer only searches within them.** The language learner *does* acquire
new rules (templates), but only shallow ones. The composition learner is
frozen. The DSL learner selects, never derives.

This plan makes **rewrite rules first-class memories** — the same kind of
object an edge already is: storable, recallable, gradeable, corroborated,
contradicted, decayed — and gives the observer a **recursive applicator**
that reduces a term by repeatedly applying its rules. Once that exists,
every existing mechanism collapses into one:

- an edge `robin is-a bird` is a **one-step rewrite rule**;
- an operator `what is X` is a rewrite rule with a slot;
- a composition rule `[is-a → has-part] ⇒ has-part` is a rewrite rule
  **about rules**;
- `add(a, b) → a+b` is a rewrite rule **with recursion**.

And the discipline that already governs all of these — MDL acceptance,
provenance (P7), grade-driven weakening (P8), corroboration source-classes
(P14), the contradiction sweep (§13), the internal critic (P5), held-out
validation (drill) — applies *unchanged* to the new rule type. That is the
generalization lever: **one rule object, one applicator, one honesty
contract**, and the observer grows its own rule set from graded experience.

The three missing pieces, in dependency order:

1. **Rules as memories** — a `RewriteRule` type with provenance, strength,
   corroboration classes, and a denied-derivation store.
2. **A recursive applicator** — bounded small-step term rewriting with a
   fuel budget; divergence within budget is a decline/ASK, never a wrong
   answer.
3. **A bottom bootstrap** — successor-based naturals and digit-string
   positional rules, so arithmetic is *derived by rewriting symbols*, not
   borrowed from JavaScript.

---

## 1. Current state audit (what we hook into)

Precise integration points, all verified against the source:

- **Dispatch order** (`TeacherAgent.ts` `chatAnswer`): clock/date →
  negation-teach → memorized → operators (2.4, ~line 3640) → learned
  operators (2.5, ~3658) → compiled DSL rules (2.6, ~3674) → semantic
  recall (~3686) → creative (~3740) → ask → hybrid. The new layer becomes
  **step 2.7**, after compiled rules, before semantic recall.
- **Compiled rules**: `CompiledRule` (line 54), `registerCompiledRule`
  (3202), `applyCompiledRule` (3209). Legacy DSL path stays untouched —
  the bit-identical control.
- **Provenance**: `AnswerProvenance` (line 228) carries `traceIds`,
  `edges`, `templateIds`, `operatorId`. We add `ruleIds` + `derivationSteps`.
- **Grade ledger (P7)**: `AnswerGradeEntry` (line 207), cap 200 (line 218),
  push at ~2165; the surgical weakening itself lives at ~2092
  (`QUIZ_GRADE_DELTA`, floor-gated). We add `ruleIds` so a wrong derivation
  weakens exactly the rules that derived it.
- **Edge confidence (P8)**: `edgeConfidence` map (~744), `bumpEdge`
  (±0.2-style updates). The rule store mirrors this per-rule.
- **Corroboration (P14)**: `SourceClass` in `relations.ts`,
  `edgeSources` in the bootstrap. Induced rules are single-source-class
  and therefore **hedged** until the world corroborates them.
- **Negations / sweep (§13)**: `Negation` store, `sweep.ts`, one-shot
  resolution ledger. The rule analog is `derivationDenials` +
  `ruleResolutions`.
- **MDL**: `TokenCostModel` (`mdl.ts`), `SLOT_COST`, the Zipf prior.
  Reused verbatim for rule description length.
- **Induction machinery**: `enumerateConsistent` with
  observational-equivalence pruning and per-operator library budgets
  (`dsl.ts` 387–536); `induceRule` gates (`dsl.ts:562`) — MDL + held-out
  accuracy over `memorizerBaseline` (`drill.ts:110`) + `INDUCTION_MARGIN`
  (`drill.ts:39`) + `MIN_INDUCTION_HITS` (`drill.ts:45`).
- **Drill loop**: `runDrill` (`drill.ts` 200) — the teach→split→grade→
  induce cycle; `generateExercises` / `verify` / `chanceLevel`
  (`technical/verify.ts` 824+) remain the deterministic oracle.
- **Persistence**: `learningState` export (~1508) / restore (~1182);
  `BootstrapRecord` (`bootstrap.ts`, `BOOTSTRAP_VERSION = 2`), import
  (~1660), export (~4505). We bump to v3 with a v2 fallback path.

### Flagship induction target

`gcf` and `lcm` are drillable concepts (`arithmetic.ts:398/413`) with
deterministic generators and oracles (`verify.ts:445–453`) but **no parser**:
`dsl.test.ts:68` asserts `matchArgs('gcf', …) === null`, so today they
honestly stay memorized — exactly the honesty gate working. The Euclidean
algorithm is *recursive by nature*:

```
gcd(a, b) -> ite(eq(b, z), a, gcd(b, mod(a, b)))
```

**Deriving `gcd` from instances — a recursive rule the observer was never
authored with — is the demonstration that closes this plan.** R4 adds the
authored prompt parsers for `gcf`/`lcm` (scaffolding, like every other
`matchArgs` family) and flips the `dsl.test.ts:68` expectation — a
deliberate, named contract change: the family becomes parseable so the
engine may try it. It is the hardest honest test of the induction
machinery, so it is scheduled late (R4) and given its own gate.

### Second target family: the logic drills

The motivation for this whole plan is that arithmetic capacity IS logical
capacity. The curriculum already contains the proof targets: `logic-and`,
`logic-or`, `logic-if` (modus ponens/tollens), `logic-not`, and `syllogism`
(Barbara) are drillable concepts with deterministic generators and oracles
(`verify.ts:632–673`) and **no parsers** — currently memorized, never
computed. A boolean rewrite deck answers all five:

```
bool.and(true, x)  -> x        bool.or(true, x)   -> true
bool.and(false, x) -> false    bool.or(false, x)  -> x
bool.not(true)     -> false    bool.not(false)    -> true
logic.mp(implies(p, q), p)     -> q                  (modus ponens)
logic.mt(implies(p, q), not(q)) -> not(p)            (modus tollens)
logic.barbara(all(m, c), isa(n, m)) -> isa(n, c)     (syllogism)
```

The syllogism rule is the same *shape* as the relation graph's is-a
transitivity — one engine, arithmetic and logic both, which is the thesis
made mechanical. Scheduled as R3c.

---

## 2. Data model

All types live in a new module `apps/web/src/teacher/rules/`. Terms are
plain JSON-serializable data (persistence rides the existing record
formats).

```ts
// rules/terms.ts
export type Term =
  | { t: 'var'; name: string }        // bound by pattern match
  | { t: 'lit'; value: string | number }
  | { t: 'sym'; head: string; args: Term[] };

// rules/types.ts
export interface RewriteRule {
  id: string;
  name: string;                 // symbol name — self-reference = recursion
  lhs: Term;                    // pure pattern; vars bind on match
  rhs: Term;                    // may contain ite(...) and other rule symbols
  origin: 'authored' | 'induced' | 'chaperone' | 'consolidated';
  strength: number;             // 1 default; grade-weakened (P8 analog)
  sourceClasses: SourceClass[]; // P14 analog — induced rules start single-class
  bits: number;                 // description length (MDL, Zipf prior)
  evidence?: number;            // distinct demonstrations (induced only)
  createdAt: number;
  lastUsedAt?: number;
  useCount: number;
}

export interface DerivationDenial {   // rule analog of Negation
  ruleId: string;
  input: Term;                  // the redex the rule was applied to
  output: Term;                 // what the rule produced
  expected?: string;            // the world's verdict / oracle value
  evidence: string;             // 'graded-wrong' | 'verified-wrong' | 'taught'
  origin: 'graded' | 'taught' | 'world';
  at: number;
}

export type RewriteOutcome =
  | { status: 'normal'; term: Term; steps: DerivationStep[] }
  | { status: 'stuck'; term: Term }       // no rule matches, not a literal
  | { status: 'exhausted'; steps: number }; // fuel out — never a wrong answer

export interface DerivationStep {
  ruleId: string;
  before: string;               // bounded serialization of the redex
  after: string;
}
```

### Design invariants

- **The only natives are matching, substitution, `ite`, and the fuel
  counter.** No arithmetic anywhere in the engine. The architectural values
  of this system (in the paper's sense, §6 Discussion) are precisely:
  pattern match, substitute, branch on a boolean, stop after N steps.
  Everything else — including all of arithmetic — must be rules.
- **Rule priority is insertion order.** Deterministic; first match wins; no
  backtracking. Same rule set + same term ⇒ same trace (a unit-tested
  gate, not a hope).
- **Totality.** The engine never throws on ill-typed terms — it reports
  `stuck`. This mirrors `evaluate`'s contract in `dsl.ts` (returns
  `undefined`, never throws).
- **Term symbols are disjoint from deck vocabulary** (namespaced:
  `nat.add`, `nat.mul`, `list.cons`, …), so the vocabulary fingerprint and
  all trained bootstrap records are untouched.

---

## 3. The applicator (`rules/engine.ts`)

Small-step term rewriting:

1. **Match**: find the first (priority-ordered) rule whose `lhs` pattern
   matches a redex in the current term. Pattern matching is structural
   over `Term`; `var` nodes bind; `lit` matches only exact values; `sym`
   matches by head + arity.
2. **Substitute**: instantiate the rule's `rhs` with the bindings.
3. **Reduce `ite`**: `ite(cond, a, b)` reduces to `a`/`b` only when `cond`
   normalizes to the literal `true`/`false`; otherwise the whole term is
   `stuck`. This is the one conditional, and it is the only native branch.
4. **Repeat** until the term is a literal (an answer), `stuck`, or fuel is
   exhausted.

**Recursion** falls out of named rules: a rule whose RHS contains a symbol
that is itself a rule head re-enters the rule set. No special-casing.

**Reduction strategy — call-by-value with lazy `ite` (implemented; the
original leftmost-outermost plan diverged, see §12.1).** The strategy is
part of the semantics and must be fixed for determinism: arguments
normalize left-to-right BEFORE any rule fires, so a rule never sees — or
re-nests — an unreduced computation (the property that makes recursive
procedures like Euclidean gcd terminate). `ite` is a **special form**: its
condition is reduced to `true`/`false` first while both branches stay
untouched until the condition selects one. This is not an optimization: an
eager strategy would reduce the recursive branch of
`gcd(a,b) → ite(eq(b,z), a, gcd(b, mod(a,b)))` even when `b = z`, and the
derivation would diverge on exactly the rules this plan exists to enable.
Laziness of `ite` is what makes recursive conditionals terminate.

**Termination** is a three-layer contract:

- a hard **fuel budget** (default 10,000 rewrite steps per query,
  per-family overridable) — the hard guarantee;
- a **cycle short-circuit**: a bounded memo of recent term hashes
  (last 1,024) turns `x → x`-style loops into early `exhausted`;
- `exhausted` maps to **decline/ASK**, never to a confident answer. This is
  the honesty valve: "I couldn't finish this derivation" is a legitimate
  epistemic state; "the answer is probably …" is not.

**Provenance**: every outcome carries its `DerivationStep[]` (capped at 200
retained steps, bounded serializations). The derivation trace is the
"show your work" — the numeric analog of `chainPhrase` citing its hops in
`composition.ts`.

---

## 4. The bottom bootstrap (`rules/peano.ts`, `rules/digits.ts`)

Authored rule decks (origin `authored`, source class `curriculum` — they
speak flatly, like the deck today). They are the *axioms*; everything above
them is learnable.

### Stage R3a — Peano naturals (the correctness anchor)

```
nat.add(z, y)            -> y
nat.add(s(x), y)         -> s(nat.add(x, y))
nat.mul(z, y)            -> z
nat.mul(s(x), y)         -> nat.add(y, nat.mul(x, y))
nat.sub(x, z)            -> x
nat.sub(s(x), s(y))      -> nat.sub(x, y)
nat.lt(z, z)             -> false
nat.lt(z, s(y))          -> true
nat.lt(s(x), z)          -> false
nat.lt(s(x), s(y))       -> nat.lt(x, y)
nat.eq(z, z)             -> true
nat.eq(s(x), z)          -> false
nat.eq(z, s(y))          -> false
nat.eq(s(x), s(y))       -> nat.eq(x, y)
nat.pred(s(x))           -> x
nat.mod / nat.divmod     -> via nat.sub + ite (subtraction loops)
```

Prompt parsing reuses the **existing** `matchArgs` (`dsl.ts`) to lift
arguments — authored parsers, exactly as today. Arguments are encoded to
Peano (`47` → `s^47(z)`), rewritten, and decoded back to digits. The
encode/decode pair is authored scaffolding, like a keyboard: the observer
derives the arithmetic *between* them, and the derivation trace is the
evidence.

**Domain scoping (honest limits of stage R3a).** Peano naturals represent
ℕ only. Two parsed families are excluded from R3a because their prompts
carry negatives (`NEG_INTEGER` parsers): `absolute-value` and
`temperature`. They join in R3b/R4 via an `int.*` sign-pair layer
(`int.neg(n)` wrapping a natural). Likewise `nat.sub(z, s(y))` has no rule
— a negative difference is `stuck` → decline, mirroring `evaluate`'s
`undefined` contract; and division/mod by zero is `stuck` by the same
construction (no rule matches), never an exception. R3a's verified
families are those whose generator domains stay in ℕ: addition,
subtraction (generator-checked a ≥ b at implementation time, else
excluded), multiplication, division, remainder, order-of-operations,
comparison, parity, factor, square, exponent, percent. The remaining
ℕ-domain families — rounding, square-root, the unit conversions, and the
geometry/science mul-div families (area, volume, density, speed, force) —
are same-phase stretch: all are compositions of the deck above, and each
is included exactly when its derivation fits the measured fuel budget.

### Stage R3b — digit-string positional arithmetic (the production path)

Numbers as lists of digits (`list.cons`/`list.nil`), with columnar rules:
right-aligned addition with carry, borrowing subtraction, schoolbook
multiplication, long division. More rules, more fuel, but arithmetic happens
directly on human notation and the traces are readable.

**Cross-validation** — Peano and digit paths are two *independent*
derivations of the same answer; agreeing results are a deterministic
self-check with no LLM in the loop. This becomes a bench gate (R6): for
every probe, `peano(x) == digits(x) == verify(x)`.

---

## 5. Induction — the observer acquires new rules (`rules/induction.ts`)

### 5.1 Function rules (arithmetic)

Generalize `enumerateConsistent` to synthesize **recursive rule sets**
instead of flat expressions:

- The enumerator grows candidate rule *bodies* bottom-up by term size, with
  the same observational-equivalence pruning and per-operator budgets that
  already keep `dsl.ts` tractable.
- Body construction draws from: variables, the term constructors (`s`,
  `z`, `cons`, …), `ite`, and — critically — **the symbols of rules already
  in the library** (authored or previously induced). This is the
  "incorporate rules into understanding" mechanic: once `nat.add` exists,
  `nat.mul` is *cheap to describe* because its MDL cost references `add`
  by name instead of spelling out the recursion. Knowledge composes, and
  MDL prices that composition.
- **Two recursion schemas**, with different totality stories, both
  enumerated:
  - *(a) Structural primitive recursion* — `f(z, y) -> base` and
    `f(s(x), y) -> step(x, y, f(x, y))`. Totality is **by construction**
    (the recursion argument shrinks structurally every call).
  - *(b) Measure-decreasing general recursion* —
    `f(args) -> ite(guard, base, f(g(args)))`. This is the shape of
    Euclidean `gcd` (the second argument shrinks through `mod`, not
    through `s(x)`), and it carries **no termination proof**: totality is
    checked *empirically* — every train and held-out instance must
    normalize within the fuel budget, and any divergence disqualifies the
    candidate. Schema-(b) rules are marked as such; their fuel budget is
    the safety, and an `exhausted` reduction at fire time is an ASK. This
    is stated plainly because it is the one place induction trades a proof
    for a measurement.

**The gates are unchanged in spirit** (they already work):
1. **MDL** — the induced rule set must compress the taught instances
   (`ruleBits < instanceBits`, Zipf prior via `TokenCostModel`).
2. **Held-out validation** — accuracy above `memorizerBaseline` +
   `INDUCTION_MARGIN` with `MIN_INDUCTION_HITS` (all three constants
   already live in `drill.ts`).
3. **Fuel-bounded totality** — the induced rules must reduce every train
   and held-out instance within budget; any divergence disqualifies the
   candidate.

Flagship gate (R4): **induce `gcd` (Euclidean, schema b) from instances**,
validate on held-out pairs, and answer fresh prompts with the derivation
trace. The induction presumes the Peano deck is in the library — `gcd`'s
body cites `nat.mod` and `nat.eq` by name; that dependency is the
"knowledge composes" claim being exercised, not an accident.

### 5.2 Composition rules become a learnable seed set

`COMPOSITION_RULES` (`composition.ts:69`) moves from a const array to a
store **seeded with the current table**. New predicate sequences are
adopted only through the pattern `learnedFrames.ts` already proved for
fixed frames:

- **exploration** (a candidate sequence is tried with exploration
  probability),
- **critic survival** (every claim the candidate licenses must re-parse
  against backing edges — the critic is the soundness referee),
- **minimal evidence** (≥ 3 distinct successful uses, replay-guarded),
- **acceptance baseline** (candidate acceptance must beat the seeds'
  acceptance over the same window).

Unsound sequences — parts of parts, capable-of of a capability — are
rejected by the critic *by construction*, because their derived claims
never have backing edges. The honesty guarantee is inherited, not invented.

---

## 6. Honesty wiring (`rules/honesty.ts`) — R5 lands with R4

A self-acquired rule is a fabrication surface. Five mechanisms close it,
each a reuse of an existing pattern:

1. **Provenance** — `AnswerProvenance` gains `ruleIds: string[]` and
   `derivationSteps?: number`; rewrite answers cite every rule they
   applied. `ruleIds` threads through the same callers that already thread
   `templateIds`: the creative path in `TeacherAgent.ts` (~3771),
   `autonomous.ts:243`, `cli/train.ts:1430`, `templateAcceptance.ts`, and
   `useChat.ts`.
2. **Surgical weakening** — `AnswerGradeEntry` gains `ruleIds`; a wrong
   grade weakens exactly those rules using the **edge convention** (±0.2
   per grade, floored at 0.1 — `TeacherAgent.ts:3098`), not the trace
   convention (−0.1 at `:2092`): rules, like edges, are producers whose
   confidence the grade adjusts, and a floored rule still answers hedged
   rather than vanishing. The ledger push site (~2165) records the rule
   ids alongside traces and edges.
3. **Denied derivations** — a rule whose output was graded wrong records a
   `DerivationDenial {ruleId, input, output, expected, evidence}`. Two
   independent denials and strength below floor ⇒ the rule **stops
   firing** (never silently deleted — the record is kept, like negations).
4. **No ping-pong** — a `ruleResolutions` one-shot ledger (mirroring
   `resolvedSweepConflicts`, cap 500) ensures the same evidence pair never
   re-queues a rule conflict.
5. **Hedging by corroboration** — induced rules are single-source-class
   (`definition`-like standing) and speak **hedged** ("I think …") until
   world-feedback corroborates them (P14 policy applied to rules, not just
   edges). Authored bootstrap rules are `curriculum` class and speak
   flatly. The observer never asserts a rule it invented for itself as
   confidently as a rule the reviewed deck gave it — until the world says
   otherwise.

**Contradiction sweep extension**: two rules deriving different outputs for
the same input is a rule conflict — a `relation-conflict`-style belief that
feeds the existing verify-belief goal machinery (`plan.ts`, `sweep.ts`).

**The critic is unchanged for language**; for numeric answers, the drill
verifier (`verify.ts`) is the deterministic oracle wherever one exists.

---

## 7. Dispatch, persistence, compatibility

### Dispatch (step 2.7)

Insert after compiled rules (~`TeacherAgent.ts:3684`), before semantic
recall:

```
const rewritten = this.applyRewriteRules(resolved);
// returns { answer, provenance: { ruleIds, derivationSteps, operatorId: 'rewrite' } } | null
```

- Only prompts that parse through an existing `matchArgs` family AND whose
  args typecheck against the term domain reach the engine. **Everything
  else returns null — byte-identical behavior on every existing probe** (the
  same control discipline as the competition/sparse experiments: default
  behavior is the shipped behavior).
- `stuck` / `exhausted` fall through to ask — the honesty valve.

### Coexistence with compiled DSL rules (the shadowing problem)

The shipped `bootstrap.json` carries `compiledRules`, and dispatch step 2.6
answers arithmetic prompts **before** step 2.7 would ever fire. Stated
plainly: on a restored production record, the rewrite engine is shadowed
for every family that already compiled a DSL rule. This is deliberate for
the control (byte-identical shipped behavior) and must be explicit for the
benches:

- The drill loop gains a mode flag (`induction: 'dsl' | 'rewrite'`,
  default `'dsl'`): in `'rewrite'` mode, a memorized drill routes to
  rewrite-rule synthesis instead of DSL compilation. The two modes are the
  A/B arms of the induction bench.
- `mathBench` and the R3 gates run on a **fresh teacher** (or
  `'rewrite'`-mode teacher) with no legacy compiled rules — otherwise the
  "inspectable trace" gate could never pass on the shipped record.
- Families the DSL never compiled (no parser today: `gcf`, `lcm`, the
  logic drills) are unshadowed — the rewrite engine is their first and
  only computing path.
- **Migration of legacy `CompiledRule`s into rewrite decks is deferred**
  (future work): the DSL path keeps working unchanged this round, and a
  retrained bootstrap is the natural point to switch the default, exactly
  like the divisive-normalization flag in §18 of SCALING.md waits for a
  retrained record.

### Persistence (bootstrap v3)

- `BootstrapRecord`: add `rewriteRules?: RewriteRule[]`,
  `derivationDenials?: DerivationDenial[]`, `ruleResolutions?: string[]`.
- `BOOTSTRAP_VERSION` bumps 2 → 3; **v2 records import with zero rules and
  identical behavior** (a v2-compat import test is a gate, mirroring
  `bootstrapCompatibility.test.ts`).
- `learningState`: `rewriteRuleStats?: Record<string, { uses: number; lastUsedAt: number }>`
  so use counts survive reloads.
- IndexedDB path: the existing persist/restore plumbing carries the new
  arrays exactly like `compiledRules` does today.

---

## 8. Phased implementation plan

Each phase lands with its gates. Estimates match the scale of prior phases
(P5 ≈ 4–5d, P9 ≈ 4–5d).

### R0 — Terms and matching (1d)
- [x] `rules/terms.ts`: `Term`, pattern matcher, substitution, bounded
  serialization, JSON round-trip.
- [x] Gates: `rules/terms.test.ts` — match/bind/arity errors, substitution
  captures nothing, serialization round-trips, no throws.

### R1 — Rules as memories + persistence (1–2d)
- [x] `rules/types.ts`: `RewriteRule`, `DerivationDenial`, `RewriteOutcome`.
- [x] Rule store: register (insertion-order priority), lookup by symbol,
  strength/sourceClasses/evidence fields.
- [x] Bootstrap v3 + v2 import path + `learningState` stats.
- [x] Gates: `rules/persistence.test.ts` — rules/denials survive
  export/import; v2 record imports with zero rules and identical behavior.

### R2 — The applicator (2–3d)
- [x] `rules/engine.ts`: small-step rewriting, `ite` reduction, fuel
  budget, cycle short-circuit, `DerivationStep[]` provenance (capped).
- [x] Gates: `rules/engine.test.ts` — determinism (same input ⇒ same
  trace), totality (no throw on ill-typed terms), fuel exhaustion ⇒
  `exhausted`, cycle ⇒ early `exhausted`, stuck ⇒ `stuck`.

### R3a — Peano bootstrap + dispatch (2–3d)
- [x] `rules/peano.ts`: the authored deck of §4 (add/mul/sub/lt/eq/pred/
  mod/divmod).
- [x] Encode/decode (digits ⇄ Peano), reuse `matchArgs` for prompt parsing.
- [x] `applyRewriteRules` as dispatch step 2.7.
- [x] Gates: `rules/peano.test.ts` — the ℕ-domain families of §4 (add/mul/
  sub/div/mod/comparison/parity/factor/square/exponent/percent/
  order-of-operations) agree with `verify.ts` on ≥ 200 seeded random
  probes **on a fresh teacher with no legacy compiled rules** (the
  shadowing rule of §7); negative-domain prompts (`absolute-value`,
  `temperature`) and div-by-zero are `stuck` → decline, never wrong;
  decode(encode) round-trip; every existing probe behavior unchanged
  (regression: web 823, core 271, drill bench, chain bench, ASK-rate
  audit 17% ask unchanged).

### R3b — Digit-string positional arithmetic + signed integers (2–3d)
- [x] `rules/digits.ts`: digit-list columnar rules (carry, borrow, long
  mul, long div).
- [x] `int.*` sign-pair layer (`int.neg(n)` over naturals) — brings
  `absolute-value` and `temperature` into scope.
- [x] Cross-validation gate: `peano(x) == digits(x) == verify(x)` on every
  probe — two independent derivations agree, no LLM involved.

### R3c — The logic bootstrap (1–2d)
- [x] `rules/logic.ts`: the boolean deck of §1 (`bool.and/or/not`,
  `logic.mp`, `logic.mt`, `logic.barbara`).
- [x] Authored parsers for `logic-and`, `logic-or`, `logic-if`,
  `logic-not`, `syllogism` (generators + oracles already exist,
  `verify.ts:632–673`; no parser exists today, so these families are
  unshadowed by compiled rules).
- [x] Gates: `rules/logic.test.ts` — all five drill families answered by
  derivation, verified against `verify.ts` on seeded probes; syllogism
  answers cite the rule trace ("all M are C, N is M ⇒ N is C" — the
  observer shows its logic exactly as `chainPhrase` shows its chains).

### R4 — Rule induction (3–4d)
- [x] `rules/induction.ts`: recursive rule-set synthesis (§5.1) with the
  rule library as body vocabulary; MDL + held-out + totality gates.
- [x] The drill-loop mode flag (`induction: 'dsl' | 'rewrite'`, default
  `'dsl'` — §7): `'rewrite'` routes a memorized drill to rule synthesis;
  verdicts still report through `recordDrillResult` so the curriculum's
  weak-drill signal (SCALING §11) and `drillFailures` persistence keep
  working unchanged.
- [x] Authored parsers for `gcf`/`lcm` prompts — flips the
  `dsl.test.ts:68` expectation (`matchArgs('gcf', …)` currently asserts
  null); a deliberate, named contract change.
- [x] Composition-rule seeds (§5.2): `COMPOSITION_RULES` → seeded store,
  learnedFrames-style admission.
- [x] Gates: `rules/induction.test.ts` — induce `nat.add` and `nat.mul`
  from base+step instances; **induce `gcd` from Euclidean instances**
  (flagship); an unparseable family is never induced; induced rules fire on
  fresh prompts with traces; the `'dsl'`-mode arm is bit-identical to
  today's drill behavior (the A/B control).
  `rules/compositionSeeds.test.ts` — seed table parity with the current
  const; a novel sound sequence admitted only through the gates; unsound
  sequences rejected by the critic.

### R5 — Rule-level honesty (2–3d, lands with R4)
- [x] Provenance + ledger extension (`ruleIds`, `derivationSteps`),
  threaded through every caller that threads `templateIds` today
  (`TeacherAgent.ts` ~3771, `autonomous.ts:243`, `cli/train.ts:1430`,
  `templateAcceptance.ts`, `useChat.ts`).
- [x] Surgical weakening (edge convention: ±0.2, floor 0.1),
  `DerivationDenial` store, two-denial stop-firing rule, one-shot
  `ruleResolutions`, P14 hedging for induced rules, sweep extension for
  rule conflicts.
- [x] Gates: `rules/honesty.test.ts` — wrong grade weakens exactly the
  cited rules; induced rule speaks hedged until corroborated; a
  doubly-denied rule stops firing but is never deleted; no ping-pong;
  fabrication rate 0 on adversarial rule probes.

### R6 — Integration, regression, docs (2–3d)
- [x] Full gate sweep: all existing suites + benches (web, core, drill,
  chain, p1-relations, grounded, ask-audit, margin bench) unchanged.
- [x] `rules/mathBench.test.ts`: end-to-end drill loop over the arithmetic
  AND logic families deriving through the engine (`'rewrite'`-mode
  teacher, per §7 — legacy compiled rules shadow the engine on shipped
  records); `47 + 32` answered with an inspectable trace; the DSL-mode arm
  re-run as the A/B control; ASK/fabrication/accuracy report
  before/after, per layer.
- [x] Docs: this file's status flipped to *implemented, measured*; honest
  limits section updated with the actual numbers.

---

## 9. What success measurably means

1. **Derivation, not selection**: `47 + 32 → 79` produced by rewriting
   symbols, with an inspectable trace — zero `Number()` on the arithmetic
   path.
2. **Logic through the same engine**: the five logic drill families
   (`logic-and/or/if/not`, `syllogism`) answered by rule application with
   cited traces — arithmetic capacity and logical capacity demonstrably one
   mechanism.
3. **Generalization**: `gcd` (recursive, never authored) induced from
   instances and validated on held-out pairs.
4. **Disciplined acquisition**: the induced `gcd` is spoken hedged until
   the world corroborates it; a corrupted induced rule is weakened and
   eventually stops firing — fabrication stays 0.
5. **No regression of the honesty contract**: ASK-rate frontier (33% / 100%)
   and calibration error (0.113) unchanged; every existing benchmark green.

---

## 10. Honest risks (recorded now, measured later)

- **Enumeration explosion** — recursion multiplies the search space. The
  OE-pruning + per-operator budgets in `dsl.ts:483` are the model for
  taming it, but this is the likeliest wall. Negative results here are
  findings, not failures; they get documented like §17/§19.
- **Self-acquired rules are a fabrication surface** — a wrong rule that
  survives induction is more dangerous than a wrong edge. R5 must land
  *with* R4, never after.
- **Fuel tuning** — Peano multiplication of two 2-digit operands costs
  thousands of steps. Budgets are per-family and measured; an exhausted
  budget is an ASK, so the cost is coverage, not honesty.
- **Rule priority order is a hidden semantic** — insertion order is
  deterministic but a reordering changes results. Persisted order is part
  of the record; the determinism gate pins it.
- **The bootstrap is still authored** — successor and digit primitives are
  given, not learned. That is the paper's own thesis: the deepest values of
  every agent are architectural. What is learned is everything above the
  primitives. State it, don't hide it.

## 13. Review fixes (the six-reviewer pass)

A full code review (six parallel reviewers over the R0–R16 surface) found
two critical honesty holes and several lifecycle defects; all are fixed and
pinned by reviewFixes.test.ts + extended gates:

- **Take-away stories never guessed**: the general story parser now
  declines change-of-state stories (a decrease lexicon: gives away, ate,
  lost, sold, used up…) and any question asking what is LEFT/REMAINING/
  STILL — "Sam has 10 apples and gives away 3" previously answered 13.
- **Exactness guards at the parser boundary**: division, percent,
  density/speed, solve-x-mul and square-root prompts whose operands are
  not generator-exact DECLINE (nat.div truncation previously spoke 3 for
  7/2; sqrt(50) spoke 5); rounding rejects odd targets (previously threw
  out of chatAnswer); comparison ties decline.
- **Taught-rule lifecycle**: renamed-argument procedures compose from the
  listed labels (previously crashed with an uncaught unbound-variable
  throw); validation probes exclude same-name incumbents (a cheating rule
  is now rejected even when a correct rule exists); register() replaces
  the WHOLE record on id collision (fresh body, fresh world record) and
  refuses heads that would break canonical-string equality; consolidation
  mints fresh `consolidated-` ids (the reserved origin now lands in the
  mainline) and inherits corroboration/usage; drills never re-register a
  stopped symbol.
- **P14 symmetry**: a weak grade withdraws a rule's world-feedback credit
  exactly as it does an edge's — the hedge returns.
- **Restore fidelity**: all five schemas and lastUsedAt survive export →
  import; decay no longer strips corroboration from actively-used rules
  after --resume.
- **Threading**: admitted composition rules reach the creative composer
  AND its critic; the remote grade wire forwards ruleIds; ask-audit
  classifies the rewrite kind; rules-report probes all 36 engine-owned
  families with pool-based totals.
- **Reply UX**: tryTeachReply answers every open question (a slot-less
  pending no longer starves gcf) and explains parse failures instead of
  silently falling into chat.
- Search held-out validation runs on the search schema's own 60k budget;
  probe libraries exclude aux rule names; chanceLevel knows the new
  families; int double-negation completes signed subtraction.

Controls: web 1064/1064 (90 suites), core 271/271, typecheck clean.

## 11. Explicit non-goals

- No performance goals for arithmetic (the drill verifier remains the
  oracle and the benchmark reference).
- No self-modification of the engine: **rules are data; the applicator is
  fixed** — the architectural-value line, drawn in code.
- No LLM anywhere in the induction path; grades of derived answers come
  from `verify.ts` where possible and the existing graded-answer machinery
  otherwise.
- No change to the shipped DSL/compiled-rule path, the vocabulary
  fingerprint, or any trained bootstrap record. Migration of legacy
  `CompiledRule`s into rewrite decks is future work, gated on a retrained
  bootstrap (§7).
- The `'chaperone'` and `'consolidated'` rule origins are **reserved, not
  implemented**: chaperone-supplied rules and the P15 replay/consolidation
  pass are follow-on phases; the schema carries the values now so the
  record format does not churn later.
- No signed-integer coverage in R3a (ℕ only); `int.*` lands in R3b. No
  rationals, reals, or algebra this round — naturals, integers, and the
  boolean/propositional layer are the whole scope.

## 12. Implementation findings and deviations (recorded, not papered over)

1. **The reduction strategy is CALL-BY-VALUE with lazy `ite` — not
   leftmost-outermost as §3 planned.** The plan's own test bed found the
   flaw: leftmost-outermost makes `gcd(a, b) -> ite(eq(b, z), a,
   gcd(b, mod(a, b)))` DIVERGE, because the gcd rule matches ANY arguments
   (they are variables) and fires on unreduced `mod(...)` terms — each
   recursion level re-nests the mod computations and the step count
   explodes (measured: gcd(59, 21) exhausted 20,000 fuel under
   leftmost-outermost). Call-by-value normalizes arguments before any rule
   fires (mod normalizes once per occurrence — gcd(59, 21) now completes in
   ~700 steps) while `ite` stays the lazy special form §3 insisted on (an
   eager strategy would still diverge on the untaken branch). The honesty
   contract is unchanged: a rule never sees an unreduced computation, and
   `exhausted` remains ASK.
2. **Per-family fuel is real and measured.** Peano multiplication of two
   2-digit operands costs ~3,700 steps (66s under the first engine, 1.1s
   after the single-pass rewrite, ~0.3s under CBV); exponent and percent
   cross 10,000 steps through structural duplication in `mul-s`, so
   `FAMILY_FUEL` raises them to 100,000. An exhausted budget is an ASK —
   the cost is coverage, never honesty.
3. **The compiled-rule (P2) path is shadowed on FRESH teachers for the
   engine's families.** On a fresh teacher the engine answers addition at
   dispatch 2.7, so the drill loop reports generalization (`induced`) and
   never reaches the DSL-compile step. On SHIPPED records the behavior is
   byte-identical (compiled rules answer at 2.6 first). The P2 path remains
   the computing path for families the engine does not own (convert-time,
   geometry, science families) and for restored records. Tests updated to
   the new reality, with the old expectations preserved as comments.
4. **The two-denial stop triggers at the strength FLOOR (≤ 0.1), not below
   it** — the floor is unreachable by design (adjustStrength clamps), so
   "below the floor" in §6 meant "driven to the floor." A grade-driven
   denial without input/output term information counts each distinct world
   rejection independently (the dedupe key falls back to the denial's
   timestamp).
5. **`exhausted` outcomes carry their derivation trace** — without it, an
   honest decline could not explain itself.
6. **Agent-found parser corrections** (recorded, all oracle-verified):
   syllogism classification compares the asked object against the CATEGORY
   (not the members as the draft said — the draft inverted both families);
   logic-if classifies on the premise sentence, not the question. The
   logic-and/or parser needed the 'a and b' / 'a or b' suffix anchored —
   otherwise an "A or B" prompt parsed as logic-and (caught by the mathBench
   zero-fabrication gate, 9/20 wrong before the fix).
7. **The digits deck does not own division/modulo** — long division is
   deliberately out of R3b's positional scope; those families ride the
   Peano path (the cross-validation gate checks add/sub/mul on both paths
   against the oracle).
8. **First-pass performance was unacceptable and fixed**: the path-based
   redex walk was O(n²) per step (mul(60,60): 66s); the single-pass rewrite
   walk with lazy symbol indexing brought it to ~1.1s, CBV to ~0.3s.

### What the numbers say (R6 mathBench)

- 16/16 engine-owned families: every generated exercise derives with
  **zero fabrication** (all derivations agree with the deterministic
  oracle).
- The flagship: gcf drills → the Euclidean rule is INDUCED (never
  authored), hedged until corroborated, and generalizes to held-out pairs;
  lcm then composes from it (a·b / gcd(a, b)) — two procedures, one
  derivation.
- The observer derives, per family, with an inspectable trace — "The answer
  is 79." is a derivation, not a recollection; the P7 ledger names the
  rules that derived it.

- No performance goals for arithmetic (the drill verifier remains the
  oracle and the benchmark reference).
- No self-modification of the engine: **rules are data; the applicator is
  fixed** — the architectural-value line, drawn in code.
- No LLM anywhere in the induction path; grades of derived answers come
  from `verify.ts` where possible and the existing graded-answer machinery
  otherwise.
- No change to the shipped DSL/compiled-rule path, the vocabulary
  fingerprint, or any trained bootstrap record. Migration of legacy
  `CompiledRule`s into rewrite decks is future work, gated on a retrained
  bootstrap (§7).
- The `'chaperone'` and `'consolidated'` rule origins are **reserved, not
  implemented**: chaperone-supplied rules and the P15 replay/consolidation
  pass are follow-on phases; the schema carries the values now so the
  record format does not churn later.
- No signed-integer coverage in R3a (ℕ only); `int.*` lands in R3b. No
  rationals, reals, or algebra this round — naturals, integers, and the
  boolean/propositional layer are the whole scope.
