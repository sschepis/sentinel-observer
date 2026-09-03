/**
 * RULES REPORT — the before/after evidence for rules mode (R7).
 *
 * Loads one or more bootstrap records and probes every family the rewrite
 * engine owns with seeded exercises, classifying each answer by its
 * producer: rewrite-operator (the engine), compiled-operator (a DSL rule),
 * memorized, creative, or decline. Fabrication = an engine-derived answer
 * that disagrees with the deterministic oracle — the report exits non-zero
 * on any. Run it on the shipped record (before) and on any candidate
 * record (after) and compare the tables.
 *
 *   npm run rules-report
 *   npm run rules-report -- public/bootstrap.json /tmp/candidate.json
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ObserverSession } from '../observer/engine'
import { OBSERVER_OPTIONS } from '../observer/options'
import { ACTIVE_DECK } from '../teacher/decks'
import { TeacherAgent } from '../teacher/TeacherAgent'
import { generateExercises, verify } from '../teacher/technical/verify'
import type { BootstrapRecord } from '../teacher/bootstrap'

/**
 * The engine-owned families (parse.ts owns exactly these). REVIEW FIX
 * (M7): every family in parseRewritePrompt's domain is probed — the
 * learned-rule families (square-root, place-value, conversions, solve-x,
 * stories) can hold induced/chaperone rules whose wrong corners the
 * reports must catch. gcf/lcm/convert, square-root and place-value decline on
 * plain records (no rule yet) — a decline is honest; a FABRICATION is
 * not, and the tripwire exits non-zero on any.
 */
const ENGINE_FAMILIES = [
  'addition',
  'subtraction',
  'multiplication',
  'division',
  'remainder',
  'order-of-operations',
  'comparison',
  'parity',
  'factor',
  'percent',
  'exponent',
  'square',
  'rounding',
  'gcf',
  'lcm',
  'absolute-value',
  'temperature',
  'word-problem-add',
  'word-problem-mul',
  'square-root',
  'place-value',
  'convert-time',
  'convert-mass',
  'convert-volume',
  'area',
  'volume',
  'density',
  'speed',
  'force',
  'solve-x-add',
  'solve-x-mul',
  'logic-and',
  'logic-or',
  'logic-not',
  'logic-if',
  'syllogism'
] as const

const PROBES = 20
const SEED = 0x52711

interface FamilyCounts {
  rewrite: number
  compiled: number
  memorized: number
  creative: number
  decline: number
  fabricated: number
}

function counts(): FamilyCounts {
  return { rewrite: 0, compiled: 0, memorized: 0, creative: 0, decline: 0, fabricated: 0 }
}

async function probeRecord(path: string): Promise<void> {
  const record = JSON.parse(readFileSync(path, 'utf8')) as BootstrapRecord
  const session = new ObserverSession(OBSERVER_OPTIONS, 100)
  await session.initialize()
  const teacher = new TeacherAgent(session, ACTIVE_DECK, null, 1, 0, 7)
  const imported = teacher.importBootstrap(record)
  console.log(`\n=== ${path} — ${imported.restored} traces restored, ${imported.definitions} definitions ===`)
  console.log(`rule store: ${teacher.rewriteRuleStore().count()} rules (${teacher.rewriteRuleStore().all().filter((r) => r.origin !== 'authored').length} learned), ${teacher.compiledRuleCount()} compiled DSL rules`)

  const totals = counts()
  let probed = 0
  for (const drill of ENGINE_FAMILIES) {
    const c = counts()
    const exercises = generateExercises(drill, 'concept', { count: PROBES, seed: SEED })
    probed += exercises.length
    for (const exercise of exercises) {
      const answer = teacher.chatAnswer(exercise.prompt)
      if (answer.mode === 'operator' && answer.operator !== null && answer.operator.kind === 'rewrite') {
        c.rewrite += 1
        if (!verify(exercise, answer.response).correct) c.fabricated += 1
      } else if (answer.mode === 'operator' && answer.operator !== null && answer.operator.kind === 'compiled-rule') {
        c.compiled += 1
        if (!verify(exercise, answer.response).correct) c.fabricated += 1
      } else if (answer.mode === 'memorized') {
        c.memorized += 1
        if (!verify(exercise, answer.response).correct) c.fabricated += 1
      } else if (answer.mode === 'creative') {
        // A creative answer to a computation prompt is a FABRICATION —
        // the R7 routing change makes this unreachable for engine-owned
        // families; the check stays as the tripwire.
        c.creative += 1
        if (!verify(exercise, answer.response).correct) c.fabricated += 1
      } else {
        c.decline += 1
      }
    }
    const answered = c.rewrite + c.compiled + c.memorized + c.creative
    // Pools vary by family (exponent: 15 unique prompts, square: 19) —
    // normalize against the actual pool, not the requested count.
    console.log(
      `${drill.padEnd(22)} rewrite ${String(c.rewrite).padStart(2)}  compiled ${String(c.compiled).padStart(2)}  memorized ${String(c.memorized).padStart(2)}  creative ${String(c.creative).padStart(2)}  decline ${String(c.decline).padStart(2)}  (pool ${exercises.length})  ${c.fabricated > 0 ? `FABRICATED ${c.fabricated}` : answered === exercises.length ? '✓' : '·'}`
    )
    totals.rewrite += c.rewrite
    totals.compiled += c.compiled
    totals.memorized += c.memorized
    totals.creative += c.creative
    totals.decline += c.decline
    totals.fabricated += c.fabricated
  }
  const derived = totals.rewrite + totals.compiled + totals.memorized + totals.creative
  console.log(
    `\nTOTALS: ${derived}/${probed} prompted answers derived-or-recalled, decline ${totals.decline} (${Math.round((100 * totals.decline) / probed)}%), fabrication ${totals.fabricated}`
  )
  session.dispose()
  if (totals.fabricated > 0) {
    console.error(`rules-report: ${totals.fabricated} fabricated derivations — refusing to call this record green`)
    process.exitCode = 1
  }
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
  const records = positional.length > 0 ? positional : [join(process.cwd(), 'public', 'bootstrap.json')]
  for (const path of records) {
    if (!path.endsWith('.json')) {
      console.error(`rules-report: expected a bootstrap record path, got ${path}`)
      process.exitCode = 1
      continue
    }
    await probeRecord(path)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
