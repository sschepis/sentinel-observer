# Rules, phase two: from induction to instruction

*Detailed design + phased plan (R7–R16), continuing `RULE_LEARNING.md`
(R0–R6, implemented and measured). Status: **R7–R10 implemented and
measured**; R11 onward proposed, awaiting review.*

---

## 0. Where we are

R0–R6 landed: rewrite rules are first-class memories, a call-by-value
engine with lazy `ite` derives arithmetic and logic through authored decks,
and the drill loop *induces* recursive procedures (Euclidean gcd, never
authored, hedged until corroborated, weakened and stopped by the world).
Measured: 16/16 engine-owned families derive with zero fabrication; 979 web
- 271 core tests green.

Phase A (this record's first milestone) made the engine the shipped
behavior and made its work visible:

- **R7 — Consolidation (done):** the app (App.tsx, ServerSession.ts) now
  constructs in rules mode; `--rules` flags train.ts and the autonomous
  classroom; the drill loop FALLS BACK to the DSL path for families the
  engine cannot induce (convert-time etc. still compile); a
  `cli/rules-report.ts` measures every engine-owned family against the
  oracle on any record (npm run rules-report). Measured on the shipped
  record AND a fresh `--rules` retrain: every family derives, gcf/lcm
  honestly ask (no induced rule on a plain record), **fabrication 0** on
  both.
- **R7 findings (recorded, not papered over):**
  1. The R0–R6 version bump (2 → 3) REJECTED the shipped v2 record — the
     app could not have loaded its own bootstrap. Fixed: versions 2–3
     import (the v3 fields are optional); v1 and v4+ still refused loudly.
     Pinned by a new compatibility test.
  2. A fabrication channel: prompts that PARSE into the engine's domain
     but cannot derive (gcf before induction) fell through to the CREATIVE
     layer on a fresh record — memory-composed answers to computation
     requests. Fixed: parsed-but-underivable prompts are grounded
     computation questions and route to ASK, never creative. The report
     now treats every non-decline answer that disagrees with the oracle as
     fabrication.
  3. Engine hardening the report surfaced: percent's 30,000-deep Peano
     numerals overflowed the recursive redex walk and termToString
     (now iterative), the per-step walk was quadratic (object-identity
     normal-form memo), and the per-step cycle hash was quadratic
     (step-gated: loops are caught early; the fuel cap is the sound
     backstop beyond).
- **R8 — Show the work (done):** rewrite answers carry their derivation
  trace; ChatView unfolds it ("show the work (N rewrites)" — the rule
  chain behind "The answer is 12."); the new Rules view lists the rule
  store read-only (learned rules first — origin, strength, corroboration,
  bits, uses, hedged/stopped state — decks collapsed below). The shipped
  v2 record stays in place (it imports and reports identically to the v3
  retrain; swapping records is a product call, not a code one).

- **R9 — The word-problem bridge (done):** the language→term problem,
  smallest end first. All 8 generated story shapes now parse through
  template-anchored `matchArgs` cases and derive via the engine
  (mathBench: 18 families, zero fabrication; the drill loop reports
  generalization on fresh teachers). The STRETCH general parser —
  operation-cue classification ("each/every/per" → mul, same-story
  quantities joined by "and" → add), deliberately NOT written from the
  templates — cleared its held-out bar (7 authored sentences no template
  anchors, 100% parse + oracle agreement) and ships ON. Its honesty rule:
  exactly two quantities, or decline — the three-quantity subtraction
  story is refused, never guessed.

---

## 0a. Where we are (design record)

R0–R6 landed: rewrite rules are first-class memories, a call-by-value
engine with lazy `ite` derives arithmetic and logic through authored decks,
and the drill loop *induces* recursive procedures (Euclidean gcd, never
authored, hedged until corroborated, weakened and stopped by the world).
Measured: 16/16 engine-owned families derive with zero fabrication; 979 web
- 271 core tests green.

What the observer still cannot do:

1. **Use an answer to its own rule questions.** It asks "what is the rule
   for place value?" — and cannot consume a reply. Procedures arrive only
   through drills (~20 instances + search); never through instruction.
2. **Read a story.** The `word-problem-add` / `word-problem-mul` drills
   (curriculum: "word problem", "product word problem") have no parsers —
   the engine owns the arithmetic but not the language in front of it.
3. **Solve for an unknown.** The curriculum already names the concepts
   ("unknown number" / `solve-x-add`, "unknown factor" / `solve-x-mul`) —
   no parser, no equation rules.
4. **Show its work to a person.** Derivation traces exist in provenance and
   are invisible in the UI.
5. **Run as the shipped default.** The engine answers fresh teachers; the
   shipped bootstrap still routes arithmetic through legacy compiled rules.

The arc of this plan: **consolidate → instruct → widen → new domain**, with
the same three gates every capability carries — MDL/validation before
adoption, hedging before corroboration, denial/stop after contradiction.

---

## Phase A — Consolidation (R7–R8, ~4d)

### R7 — Retrain, flip the default, migrate (1–2d)

The engine becomes the shipped behavior, in the order the control
discipline requires:

- [ ] `cli/train.ts`: add `--rules` (constructs the trainer's TeacherAgent
  with `rewriteInduction: true`); produce a candidate
  `public/bootstrap.json` alongside the current one.
- [ ] Before/after report (extend `cli/drill-bench.ts` or a small
  `rules-report.ts`): per-family accuracy, ask-rate, fabrication count,
  verdict distribution (`induced` / `rule-induced` / `memorized`), rule
  store contents (origins, bits, use counts) — the two records side by
  side.
- [ ] Flip the app construction sites to rules mode once the report is
  green: `App.tsx:144` and `server/ServerSession.ts:129` pass
  `rewriteInduction: true`; `cli/autonomous-classroom.ts:139` follows. The
  constructor default stays `false` (tests keep their stable baseline).
- [ ] Migration policy stated in code comments: legacy `CompiledRule`s in
  the retrained record are NOT re-created for engine-owned families (the
  engine answers first on fresh teachers); the DSL path remains the
  computing path for conversions/geometry/science until R13.
- [ ] Gate: the retrained record imports cleanly (v3), every existing bench
  is green against it, and the report shows **no family regressed** vs the
  shipped record. Fabrication stays 0.

### R8 — Show the work (2d)

The inspectable trace is the whole thesis made visible.

- [ ] Thread the derivation into the chat message: `useChat.ts`
  `pushExchange` gains `derivation?: { ruleId: string; before: string;
  after: string }[]` + `ruleIds?: string[]`, filled from
  `answer.provenance` when `operator.kind === 'rewrite'`.
- [ ] `ChatView.tsx`: the existing `operator → "computed"` badge becomes
  expandable — a collapsed "show work (N steps)" row that unrolls the
  bounded trace, hedged answers visibly marked (the `I think` prefix
  already carries it).
- [ ] `Dashboard.tsx`: a rule-store panel beside the existing audit views —
  every rule with origin, strength, sourceClasses, bits, useCount, denials,
  stopped state; induced/taught rules sorted first. Read-only (the world
  grades rules; the UI never edits them).
- [ ] `TrainingView.tsx`: surface the rules-mode toggle + the drill verdict
  labels ("rewrite rule induced — N bits, held-out M%").
- [ ] Gate: component tests for the trace expander and the panel (mirror
  `ChatView.test.tsx` style); no behavior change to grading paths.

---

## Phase B — Instruction (R9–R11, ~8–9d) — the flagship

### R9 — The word-problem bridge (2d)

The smallest language→term problem, with generators and oracles already in
the repo (`verify.ts:695,700` — 4 addition + 4 multiplication story
templates).

- [x] `matchArgs` cases `word-problem-add` / `word-problem-mul`
  (`technical/dsl.ts`): template-anchored regexes for the 8 story shapes
  (numbers lifted, everything else fixed text). A story that matches no
  template returns null — decline, never guess.
- [x] `rules/parse.ts` `termFor`: the two families → `nat.add` / `nat.mul`.
- [x] mathBench families += 2 (zero-fabrication gate extends to stories).
- [x] STRETCH (measured, allowed to fail honestly): a generalized story
  parser — number-word lexicon + operation cues ("gets/reads/buys … more",
  "in all" → add; "each/every … groups" → mul) validated against HELD-OUT
  templates the parser was not written from. If precision < 100% on the
  held-out set, the general parser ships OFF and the finding is recorded
  (the negative-result discipline).
- [x] Gate: both drill families derive via the engine on fresh teachers;
  `dsl.test.ts` parser tests; the drill loop reports `induced` for
  stories.

### R10 — Taught rules: English procedure → rewrite rule (4–5d)

The core new capability. One sentence of instruction replaces twenty
drilled instances — but **the parse is never the gate; validation is.**

- [x] Schema: add `'taught'` to `RuleOrigin` (`rules/types.ts`), accepted
  by both restore paths (`TeacherAgent.ts` learningState + bootstrap
  import). Taught rules start `sourceClasses: []` → **hedged** until
  world-corroborated, exactly like induced ones.
- [x] `rules/instruction.ts` — `parseTaughtRule(text, name): RewriteRule[]
  | null`. A deliberate, bounded grammar over procedure statements — not
  free NL. Grammar v1 (each maps to term constructors):
  - conditionals: "if X is zero, the answer is Y" / "otherwise Z" → `ite`
  - operations: "the remainder of X divided by Y" → `nat.mod`; "X times Y"
    → `nat.mul`; "X minus Y" → `nat.sub`; "X plus Y" → `nat.add`
  - recursion by name: "the gcd of B and R" (the rule's own name) → the
    recursive call
  - arguments: "the first/second number", or named letters (a, b, x)
  - the flagship sentence must parse: *"to find the gcd of a and b: if b
    is zero the answer is a; otherwise it is the gcd of b and the
    remainder of a divided by b."*
- [x] Empirical validation before adoption (`rules/instruction.ts`):
  - when the concept maps to a checkable drill family: generate instances
    via `generateExercises`, simulate the candidate over the library
    (reuse `validateHeldOut`), require the same bar induction clears
    (accuracy > chance + margin, min hits, fuel-bounded totality);
  - when no oracle exists: adopt hedged with `evidence: 0` and let the
    world's grades be the only validator (the denial/stop machinery is
    already in place).
- [x] Adoption: register via `registerInducedRules` (rename to
  `registerLearnedRules`), origin `'taught'`, persisted like induced ones.
- [x] Gates (`rules/instruction.test.ts`): the flagship sentence parses,
  validates against the gcf oracle, and derives `gcd(48, 36) = 12` hedged;
  a WRONG taught procedure ("…the gcd of b and a minus b" where it fails
  held-out) is **rejected at validation, never registered**; a subtly
  wrong one that passes small validation is later denied out by grades
  (adversarial test); garbage text returns null; determinism.

### R11 — Close the ask → told → own loop (DONE)

The rule question finally has a consumer. The drill loop registers its
"what is the rule for X?" as an OPEN question (concept → drill) on the
teacher; a user reply that parses as the family's procedure goes through
the R10 pipeline — adoption answers with the observer's own summary and
closes both the pending entry and the gap; validation failure answers with
the counterexample ("the rule gives 13, but the answer is 4"); a reply
that does not parse falls through to the normal chat, never a guessed
adoption. Wired into the chat send path (local teacher; the server's
teach-reply surface is a follow-on). Measured end to end: gcf drill →
memorized + question pending → wrong procedure rejected with the
counterexample (question stays open) → the Euclidean sentence adopted →
fresh prompts derive hedged, fabrication 0.
### R11 — Close the ask → told → own loop (2d)

The rule question finally has a consumer.

- [x] Track pending rule questions: `recordGap` entries whose text matches
  `what is the rule for X?` map to their concept + drill family
  (`TeacherAgent` keeps `pendingRuleQuestions: Map<concept, drill>`,
  populated by the drill loop's existing `ruleQuestionFor` path).
- [x] Chat wiring (`useChat.ts` + a `TeacherAgent.teachRule(text)` entry):
  when a user reply parses as a procedure for a pending rule question →
  R10 pipeline → on adoption, the observer answers with its own summary
  ("Learned — the rule for gcf now derives fresh instances; I'll say 'I
  think' until it's confirmed.") and the gap is forgotten; on validation
  failure, the observer says what failed ("that rule gives 6 for gcd(12,
  8); the answer is 4") — the counterexample IS the reply.
- [x] Classroom: the autonomous loop offers pending rule questions to the
  chaperone channel only as QUESTIONS (the LLM-supplied answers route
  through R14's path when it lands; until then, user-taught only).
- [x] Gate: an end-to-end test — drill place-value (still memorized), see
  the rule question, teach a correct procedure in English, watch fresh
  place-value prompts derive hedged; teach a wrong one first and watch the
  counterexample reply. Fabrication 0 throughout.

---

## Phase C — Wider induction (R12–R14, ~7–9d)

### R12 — place-value and square-root schemas (DONE)

The paper's own "stays memorized honestly" example fell. The
place-value generator now draws DISTINCT digits (a prompt naming a digit
value must name it unambiguously — 707's "the digit 7" was unanswerable
by any parser), and the drill INDUCES the list-structural accessor
(schema c — `dig.placeVal`, never authored) that walks the
least-significant-first digit list to the positional index, scaling each
level by ten. Square-root fell to the bounded-search schema (d): a
two-rule accumulator `nat.sqrt(n) -> nat.sqrt.try(n, z)`,
`nat.sqrt.try(n, k) -> ite(gt(k·k, n), pred(k), nat.sqrt.try(n, s(k)))`.
Both were found on the second attempt, honestly: the first makeRule
stamped the aux rule with the ENTRY name, so the engine could never look
up `nat.sqrt.try` (simulation rejected every candidate) — the rule's
reducible symbol is its LHS head, and that one-line fix is what the
search schema needed. Fuel is measured, not guessed: the search's
`lt(n, k·k)` chains cost ~n steps per level (sqrt(324) ≈ 5.4k steps,
sqrt(400) ≈ 11k — 60k budget for the family). Gates: both drills reach
'rule-induced'; held-out answers are correct from memory or derivation,
never fabricated.
### R12 — place-value and square-root schemas (3–4d)

- [x] **place-value** (the paper's own "stays memorized honestly" example —
  closing it is the full-circle result):
  - `matchArgs` case for the place-value prompts; `termFor` builds
    `dig.at(digitsFromDecimal(n), place)` over the R3b digit lists.
  - induction schema (c) — LIST-structural recursion in
    `rules/induction.ts`: `f(cons(d, rest), z) → base(d)`;
    `f(cons(d, rest), s(i)) → f(rest, i)`. Totality by construction (the
    list shrinks).
  - Gate: the drill INDUCES the accessor from instances (never authored —
    this is the second flagship); held-out validated; derives with traces.
- [x] **square-root** via a bounded-search schema (d): candidates of the
  shape `f(n) → try(n, z)`; `try(n, k) → ite(gt(mul(k, k), n), pred(k),
  try(n, s(k)))` — measure-decreasing in `n − k²`, fuel-checked
  empirically like schema (b). Gate: induced from the square-root drill,
  held-out validated (perfect squares only, per the generator).
- [x] Both join `FAMILY_FUEL` with measured budgets; mathBench += 2.

### R13 — Conversions and measurement migrate to rules (DONE)

The integer-ratio conversion families learned their multipliers: a new
schema (e) — CONSTANT MULTIPLIER — infers f(x) → x·C from the instances'
own ratios (the ratio is in the data; a consistent C across every taught
pair is the rule). The drill for convert-time induces `conv.convert-time`
(×60 — both directions share it), convert-mass/volume induce ×1000;
fresh prompts derive through the learned rule, hedged until
corroborated. The measure families (area, volume, density, speed, force)
compose DIRECTLY from the nat deck — area = w×h, volume = a×(b×c),
density = mass÷volume, speed = distance÷time, force = m×a — no rules to
learn, and mathBench now covers them (24 families, zero fabrication).
H2's discipline survives the migration because the PARSER is per-family:
after inducing the time rule, the grams prompt still asks — the ×60 rule
can never see a mass term. convert-length deliberately stays on the DSL
path (measured: its metric pairs carry decimal factors that need a
rational layer — neither the rewrite arm NOR the DSL can compile it
today, and the drill honestly memorizes and asks for the rule instead of
fabricating a compile).
### R13 — Conversions and measurement migrate to rules (2–3d)

- [x] A constant-multiplier induction family: `f(x) → nat.mul(x, C)` with
  `C` enumerated from the taught instances (the ratio is in the data; the
  candidate set is tiny). Same MDL/held-out gates. One induced rule per
  unit family and direction — H2's unit-blindness lesson is inherited
  because the PARSER stays per-family (`conversionPairOf` unchanged).
- [x] `termFor` cases for `convert-*` + area/volume/density/speed/force
  (mul/div compositions of the nat deck).
- [x] Gate: cross-oracle equality on every family; the compiled-DSL path
  retired for migrated families on fresh teachers (drill tests updated the
  same honest way R6 updated addition); H2 adversarial probes stay
  declined (grams prompt never answered by the time rule).

### R14 — Chaperone rule supply (DONE)

The hybrid contract extended to procedures. `Chaperone.proposeRule`
demands the answer IN the bounded taught-rule grammar (the prompt carries
the family's instances and the grammar itself; the LLM is a proposer, not
a programmer — its text is parsed, never evaluated). The proposal then
runs the SAME pipeline as a human's: parseTaughtRule → validateTaughtRule
against the family's oracle → adopt with origin `'chaperone'`, hedged, or
reject with the counterexample. Measured with a scripted provider: a
correct proposal is adopted hedged and derives fresh prompts; a wrong one
is rejected at validation with a named counterexample and never
registered; a cheating constant proposal is caught by the held-out bar;
garbage is declined; chaperone rules persist through export → import with
their origin.
### R14 — Chaperone rule supply (2–3d)

The hybrid contract extended to procedures: the LLM proposes, the observer
verifies and owns. Mirrors `reconcileRelations`' provenance discipline.

- [x] Prompt shape (chaperone channel): the stuck family's instances + the
  procedure grammar of R10 — the LLM must answer IN the grammar (it is a
  proposer, not a programmer; its text goes through `parseTaughtRule`,
  never through any eval).
- [x] Pipeline: parse → empirical validation against the family's oracle →
  adopt with origin `'chaperone'`, hedged; rejection is recorded with the
  counterexample (the same reply shape as R11).
- [x] Gate (scripted chaperone, like the learnedFrames bench): a correct
  proposal is adopted hedged and derives; an incorrect one is rejected at
  validation with a named counterexample; a subtly-wrong survivor is
  denied out by world grades. The LLM never bypasses validation — tested
  by feeding a malicious "rule" that parses but cheats (constant answer):
  held-out rejects it.

---

## Phase D — New domain + hygiene (R15–R16, ~6–8d)

### R15 — Equations: solve for the unknown (DONE)

The curriculum's algebra lineage ("unknown number" / solve-x-add,
"unknown factor" / solve-x-mul — already named, never computable) got its
engine. The equation is built from INERT constructors (eq.rel/eq.plus/
eq.times/eq.minus wrapping `var.x`) — under call-by-value an equation
component built from nat.add/nat.mul would be eagerly REDUCED, mixing the
unknown into computations before alg.solve ever saw the shape; inertness
is what keeps the equation intact. The authored `alg.*` deck maps each
form to its inverse: x + c = r → x = r − c (both orders), c × x = r →
x = r ÷ c (both orders), x − c = r → x = r + c. Shapes with no rule —
x on both sides — are stuck: decline. MathBench now covers 26 families,
zero fabrication; the visible work cites the inverse-operation rule
(alg.solve-plus-l → nat.sub-s → …). The R10 "undo phrasing" stretch
(teaching inverse rules in English) is deferred with this note.
### R15 — Equations: solve for the unknown (4–5d)

The curriculum already names it: "unknown number" (`solve-x-add`) and
"unknown factor" (`solve-x-mul`), with `equation`, `variable`, and
`inverse operation` as prerequisites — the algebra lineage is waiting for
rules.

- [x] Term language: the unknown is `sym('var.x')`; an equation is
  `eq.rel(lhs, rhs)`.
- [x] The `alg.*` deck — inverse-operation rules, each one the mechanical
  form of "undo what was done":
  - `alg.solve(eq.rel(nat.add(var.x, C), R)) → nat.sub(R, C)` (+ the
    commuted form)
  - `alg.solve(eq.rel(nat.mul(C, var.x), R)) → nat.div(R, C)` (+ commuted)
  - `alg.solve(eq.rel(nat.sub(var.x, C), R)) → nat.add(R, C)`
  - unmatched shapes have no rule — `x` on both sides is STUCK → decline.
- [x] Parsers: `matchArgs` for the solve-x prompt shapes; `termFor` builds
  the equation terms.
- [x] Gate: both drill families derive with traces ("x + 4 = 9 → x = 9 −
  4 → 5" is the visible work); out-of-scope equations decline; mathBench
  += 2; zero fabrication.
- [x] STRETCH: the R10 grammar gains "undo" phrasing so inverse-operation
  rules can be TAUGHT ("to find x when x plus c is r, subtract c from r").

### R16 — Decay policy + consolidation (DONE)

Decay is weaken-toward-hedged, NEVER forget: a learned rule unused past
the horizon (30 wall-clock days, configurable) loses its world credit —
it keeps working but speaks hedged again until re-corroborated; authored
decks never decay; nothing is ever deleted, and only the denial
machinery stops a rule. Consolidation is the idle maintenance pass (on
the classroom's checkpoint cadence, and available as a method): identical
learned rules collapse to the cheapest record with use counts and world
credit transferred (the redundant records deactivate — never delete);
drill-backed families re-induct over fresh instances and a strictly
cheaper rule set that clears the same held-out bar replaces the original
under the origin `'consolidated'` — the reserved value is real; the
denial ledger compacts structurally identical denied DERIVATIONS while
grade-driven denials stay untouched (compaction must never let a wrongly
graded rule stop being stoppable — the two-denial stop counts each world
rejection). Gates: byte-identical answers across the family pool before
and after consolidation; decay flips exactly the hedge; authored decks
untouched.
### R16 — Decay policy + consolidation (2–3d)

- [x] **Decay = weaken-toward-hedged, never forget.** A sweep (piggybacked
  on the existing contradiction sweep cadence) strips `world-feedback`
  from induced/taught/chaperone rules unused past a horizon (default 30
  wall-clock days, configurable): the rule keeps working but speaks
  hedged again until re-corroborated. Authored decks never decay
  (architectural values). Never deletes, never stops — only the denial
  machinery stops.
- [x] **Consolidation** (the P15 hook, idle-slot only):
  - dedupe observationally-equivalent learned rules (same outputs over a
    seeded probe set) — keep the cheaper, transfer use counts, record the
    merge as an event;
  - MDL re-simplification: re-run induction on a learned rule's own
    input/output pairs; adopt a strictly-cheaper body only if it passes
    the same held-out gate (origin `'consolidated'` — the reserved value
    becomes real);
  - denial-ledger compaction (identical denials merge, counts preserved).
- [x] Gate: consolidation never touches authored decks or active
  derivation behavior (byte-identical answers before/after on the bench);
  decay flips exactly the hedge and nothing else; both run only in idle.

---

## Gates summary

| Phase | The one-line gate |
|---|---|
| R7 | Retrained record: no family regressed, fabrication 0, benches green |
| R8 | Traces visible; grading paths untouched |
| R9 | Stories derive; unmatched stories decline; held-out template honesty |
| R10 | The flagship sentence → validated gcd rule; wrong procedures rejected with counterexamples |
| R11 | ask → told → verify → own, end to end, on place-value |
| R12 | place-value INDUCED (flagship 2); sqrt induced via search schema |
| R13 | Conversions derive; H2 probes still declined; DSL retired per family |
| R14 | LLM proposals validated-or-rejected; never trusted, never eval'd |
| R15 | solve-x derives with visible inverse-operation work; off-scope declines |
| R16 | Decay = hedge only; consolidation idle-only and behavior-preserving |

## Risks, stated now

- **The story/procedure grammars will overfit their templates.** The
  held-out-template gate (R9) and the counterexample replies (R10/R11) are
  the guard; a general parser that misses the bar ships OFF with the
  finding recorded.
- **Taught rules are the largest new fabrication surface so far.**
  Validation-before-adoption is the only real gate; the R10 adversarial
  tests (cheating constant rules, subtly-wrong recursions) must land WITH
  the parser, not after — the R4/R5 lesson.
- **Chaperone supply tempts trust.** The LLM's text is parsed by the same
  bounded grammar as a human's and validated the same way — any shortcut
  here breaks the paper's hybrid contract.
- **Equation scope creep.** R15 is single-unknown, single-operation, ℕ
  only. Everything else declines. Rationals and multi-step algebra are a
  phase-three conversation.
- **Consolidation can silently change behavior.** The byte-identical bench
  before/after is the gate; any diff is a bug, not a simplification.

## Non-goals

- No free-form natural-language procedure understanding — the grammar is
  bounded and versioned; what does not parse is declined, and the decline
  says so.
- No LLM anywhere in validation or adoption decisions.
- No self-modification of the engine; the applicator stays fixed.
- No decay-by-deletion for any rule, ever; the record is the record.

## Sequencing and estimates

R7 (1–2d) → R8 (2d) → R9 (2d) → R10 (4–5d) → R11 (2d) → R12 (3–4d) →
R13 (2–3d) → R14 (2–3d) → R15 (4–5d) → R16 (2–3d). Total ≈ 5–6 weeks.

Dependencies: R10 blocks R11 and R14 (both consume the parser+validation
pipeline). R12's list schema blocks nothing. R13 and R15 are independent
after R7. R16 last (it compacts what the rest produced).

The through-line, as before, in one sentence: drills taught the observer to
**induce** procedures; this plan teaches it to **receive** them — through
stories, through instruction, from people and from its chaperone — with the
same store, the same hedging, and the same world-grading for every rule,
no matter who wrote it.
