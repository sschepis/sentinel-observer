/**
 * CONSTANTS REPORT — the tripwire that keeps self-tuning from dissolving the
 * benchmark reference (§5.3 / D.9).
 *
 * Prints every numeric constant the system carries with its class (values /
 * safety / tuning), its current value, and the file:line it lives in. For
 * tuning constants it also prints the evidence sources that set it and the
 * evidence mass. When an exported record is passed on the command line, the
 * report compares the registry's current tuning values against the last
 * exported snapshot and prints the drift — so a bench that passes because a
 * threshold quietly moved is caught.
 *
 * The report also runs the D.10 circularity guard over the registry and exits
 * non-zero if any tuning gate has no programmatic bench (fuzz/chain/
 * adversarial/math) in its evidence.
 *
 *   npm run constants-report
 *   npm run constants-report -- public/bootstrap.json
 */

import { readFileSync } from 'node:fs'
import {
  assertAllAnchored,
  constantsByClass,
  CONSTANTS,
  driftAgainst,
  readConstantsExport,
  tuningConstants
} from '../teacher/constants'

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width)
}

function printRegistry(): void {
  console.log('\n=== constants taxonomy — values / safety / tuning ===')
  console.log(
    `${pad('CLASS', 8)} ${pad('CONSTANT', 34)} ${pad('VALUE', 10)} FILE:LINE`
  )
  const order = ['values', 'safety', 'tuning'] as const
  for (const cls of order) {
    for (const entry of constantsByClass(cls)) {
      const value = Number.isInteger(entry.value) ? String(entry.value) : entry.value.toFixed(4)
      console.log(
        `${pad(cls, 8)} ${pad(entry.name, 34)} ${pad(value, 10)} ${entry.file}:${entry.line}`
      )
    }
  }
}

function printEvidence(): void {
  console.log('\n=== tuning constants — evidence (what set each value) ===')
  for (const entry of tuningConstants()) {
    const evidence = entry.evidence!
    const mass = evidence.mass === null ? 'unmeasured (hand constant)' : `mass ${evidence.mass}`
    console.log(`  ${pad(entry.name, 34)} sources [${evidence.sources.join(', ')}]  ${mass}`)
    console.log(`  ${''.padEnd(34)} ${evidence.note}`)
  }
}

function printDrift(path: string): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    console.error(`constants-report: cannot read ${path}: ${String(error)}`)
    process.exitCode = 1
    return
  }
  const record = JSON.parse(raw) as unknown
  const exported = readConstantsExport(record)
  console.log(`\n=== ${path} — drift vs last exported record ===`)
  if (exported === null) {
    console.log(
      '  no tuned-constant snapshot in this record (learningState.constantsExport) — drift unavailable'
    )
    return
  }
  console.log(`  exported at ${exported.exportedAt}, ${exported.tuned.length} tuned values recorded`)
  const drift = driftAgainst(exported)
  let moved = 0
  for (const entry of drift) {
    if (entry.delta === null) continue
    if (entry.delta !== 0) {
      moved += 1
      console.log(
        `  ${pad(entry.name, 34)} exported ${entry.exported!.toFixed(4)} -> current ${entry.current.toFixed(4)} (${entry.delta >= 0 ? '+' : ''}${entry.delta.toFixed(4)})`
      )
    }
  }
  if (moved === 0) {
    console.log('  no tuning constant has drifted since this record')
  } else {
    console.error(`constants-report: ${moved} tuning constants drifted since the last record`)
    process.exitCode = 1
  }
}

function main(): void {
  console.log(`registry: ${CONSTANTS.length} constants — ` +
    `${constantsByClass('values').length} values, ` +
    `${constantsByClass('safety').length} safety, ` +
    `${constantsByClass('tuning').length} tuning`)

  printRegistry()
  printEvidence()

  // D.10 — the circularity guard over the whole registry.
  try {
    assertAllAnchored()
  } catch (error) {
    console.error(`constants-report: ${String(error)}`)
    process.exitCode = 1
  }

  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
  for (const path of positional) {
    printDrift(path)
  }
}

main()
