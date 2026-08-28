# Sentinel — Sentient Observer Learning App

A standalone application that generalizes the sentient observer into real
learning workflows. Plan: [SENTINEL_PLAN.md](../../alephnet-node/docs/SENTINEL_PLAN.md).

## Monorepo layout

```
packages/sentient-core   @sschepis/sentient-core — the cognitive engine
                         (extracted from alephnet-node's hardened src/semantic/:
                         prime oscillators, sedenion memory field, holographic
                         memory, semantic memory bank, fail-closed safety).
                         Browser + Node compatible; tinyaleph is an OPTIONAL
                         peer loaded at runtime with a truthful degraded flag.
apps/web                 @sschepis/sentinel-web — Vite + React 18 + TS strict
                         + Tailwind. M0: live observer dashboard with explicit
                         degradation reporting.
```

## Architecture rules

1. One-way dependencies: `ui → interventions → observer → core → tinyaleph`.
2. The observer is a pure engine; side effects live in a bounded tool layer
   behind the fail-closed SafetyMonitor.
3. Explicit degradation — when the optional tinyaleph kernel cannot load, the
   UI reports degraded mode. No metric is ever fabricated.
4. Everything persisted survives reload.

## Development

```bash
npm install          # installs all workspaces
npm test             # jest across packages and apps
npm run typecheck    # tsc --noEmit everywhere
npm run build        # core (tsc) + web (vite)
npm run dev          # vite dev server (port 5173)
```

## Status

M0: skeleton — core extracted with its 121 behavior tests, live dashboard,
degraded banner, CI. Next: M1 (session lifecycle + journal + persistence).
