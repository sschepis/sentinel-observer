# Sentinel — Sentient Observer Learning App

A standalone application that generalizes the sentient observer into real
learning workflows: a cognitive engine with associative memory, coupled
oscillators, and a graded hybrid faculty, packaged as a teaching/chatting
observer that learns decks of words and procedures with measurable honesty.

Design and results: [docs/observer-paper.md](docs/observer-paper.md) — the
implementation's architecture, benches, and measured claims. Per-round
change logs: [TODO.md](TODO.md). Scaling notes: [docs/SCALING.md](docs/SCALING.md).

## Monorepo layout

```
packages/sentient-core   @sschepis/sentient-core — the cognitive engine
                         (prime oscillator field, sedenion memory field,
                         holographic memory, semantic memory banks, fail-closed
                         safety). Browser + Node compatible; tinyaleph is an
                         OPTIONAL kernel loaded at runtime with a truthful
                         degraded flag.
apps/web                 @sschepis/sentinel-web — the learning application:
                         the TeacherAgent (teach → ask → grade → reinforce
                         loop with FSRS scheduling), conversation stack
                         (memorized exchanges → operators → learned rules →
                         grounded composition → ask), relation graph + graded
                         hologram, MDL operator induction, rule/rewrite engine,
                         drive module, the trust kernel (emergent teacher→
                         student handover), and a persistent observer server
                         with a thin Vite + React 18 + TS-strict client.
```

## Architecture principles

1. One-way dependencies: `ui → observer/teacher → core → tinyaleph`.
2. The observer is a pure engine; side effects live behind the fail-closed
   SafetyMonitor. Every answer carries provenance — the traces, edges, and
   operators that produced it — so a bad grade weakens exactly those.
3. Explicit degradation: when the optional tinyaleph kernel cannot load, the
   UI reports degraded mode. No metric is ever fabricated.
4. Honesty is enforced in code, not prose: operators decline rather than
   guess, the internal critic refuses claims without a stored edge, and
   fabrication / honesty / calibration gates run in CI.
5. One retention law: everything learned is a trace under the FSRS retention
   curve (weights are memories too), and trust is measured agreement — the
   handover λ is normalized trust, never a stored constant.
6. Everything persisted survives reload (IndexedDB, file record, bootstrap
   export/import, disk-checkpointed server).

## Development

```bash
npm install          # installs all workspaces
npm test             # jest across core + web
npm run typecheck    # tsc --noEmit everywhere
npm run build        # core (tsc) + web (vite)

# in apps/web
npm run dev          # vite dev server (port 5173)
npm run server       # observer server (persistent, disk-checkpointed)
npm run train        # batch-train a deck into the shipped record
                     #   (--words N, --retention-sim DAYS, --shards K)
npm run classroom    # autonomous classroom: self-training + deploy
npm run chat         # CLI chat against a trained observer
```

## Benches

```bash
npm run test:bench         # recall/scale/ciGates/semanticRecall/parity gates
npm run margin-bench       # recognition margin + top-1 (the core memory gate)
npm run falsifier-bench    # centered-sketches falsifier
npm run grounded-bench     # grounded-composition fabrication gate
npm run p1-relations-bench # relational answerability/accuracy
npm run ask-audit          # evasion/honesty audit over the deck
npm run council-bench      # multi-observer resonance
```

Unit gates run in `npm test`; the heavy suites (20k-trace recall, server
parity) run under the named bench scripts.

## Status

The observer learns 20k-word decks and conversational exchanges, answers
grounded questions by chained relational reasoning, acquires operators and
procedures under an MDL criterion, composes from its own memories with a
graded hybrid faculty (LLM teacher fading into the student's measured
composite via the trust kernel), and runs as a persistent server. Measured
highlights (docs/observer-paper.md §5): recognition recall 99.0% at 1k traces
and 94.6% at 20k, 0/15 fuzz false positives, 44/44 adversarial honesty,
100% correctness on verifiable operators, and 100% of memory above the
review threshold in the 30-day scheduled-review simulation.
