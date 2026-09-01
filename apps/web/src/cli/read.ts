#!/usr/bin/env node
/**
 * READ — teach the observer from continuous text instead of taught pairs.
 *
 * The passage is parsed by the reading grammar (the internal critic's claim
 * grammar run in reverse), so the observer ingests exactly the sentence
 * shapes it can also SAY and verify. Everything else contributes vocabulary
 * exposure and nothing more — no guessing, no fabrication.
 *
 * Usage:
 *   npm run read -- book.txt                  # read a file into the observer
 *   npm run read -- book.txt --save obs.json  # keep what it learned
 *   npm run read -- book.txt --load obs.json  # continue from a saved observer
 *   npm run read -- book.txt --dry            # extract and report, store nothing
 *   cat article.txt | npm run read            # read from stdin
 *
 * The report is the honest accounting: how much of the text parsed, which
 * edges were new, which AGREED with what the observer already knew (that is
 * corroboration — the claim stops being hedged), which conflicted (those
 * become beliefs to verify), and which words it met but does not know.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { ObserverSession } from '../observer/engine'
import { OBSERVER_OPTIONS } from '../observer/options'
import { TeacherAgent } from '../teacher/TeacherAgent'
import { ACTIVE_DECK } from '../teacher/decks'
import { MemoryPersistenceStore } from '../persistence/store'
import { sweepConflicts } from '../teacher/sweep'
import type { BootstrapRecord } from '../teacher/bootstrap'

const TTY = process.stdout.isTTY === true
const paint = (code: number, text: string): string => (TTY ? `\u001b[${code}m${text}\u001b[0m` : text)
const dim = (t: string): string => paint(2, t)
const bold = (t: string): string => paint(1, t)
const green = (t: string): string => paint(32, t)
const yellow = (t: string): string => paint(33, t)

const flag = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : process.argv[index + 1] ?? ''
}
const has = (name: string): boolean => process.argv.includes(`--${name}`)

const FLAG_VALUES = new Set(['--save', '--load', '--words'])
const positional: string[] = []
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i]
  if (FLAG_VALUES.has(arg)) { i += 1; continue }
  if (arg.startsWith('-')) continue
  positional.push(arg)
}

const SHIPPED_BOOTSTRAP = new URL('../../public/bootstrap.json', import.meta.url).pathname

function readInput(): { text: string; label: string } {
  if (positional.length > 0) {
    return { text: readFileSync(positional[0], 'utf8'), label: positional[0].split('/').pop() ?? positional[0] }
  }
  return { text: readFileSync(0, 'utf8'), label: 'stdin' }
}

async function main(): Promise<void> {
  const { text, label } = readInput()
  if (text.trim().length === 0) {
    console.error('nothing to read (pass a file path or pipe text in)')
    process.exit(1)
  }

  const session = new ObserverSession(OBSERVER_OPTIONS, 100)
  await session.initialize()
  const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 500)

  const load = flag('load')
  if (load !== null && load.length > 0) {
    const imported = teacher.importBootstrap(JSON.parse(readFileSync(load, 'utf8')) as BootstrapRecord)
    console.log(dim(`loaded ${imported.restored} traces from ${load}`))
  } else if (existsSync(SHIPPED_BOOTSTRAP)) {
    const imported = teacher.importBootstrap(JSON.parse(readFileSync(SHIPPED_BOOTSTRAP, 'utf8')) as BootstrapRecord)
    console.log(dim(`loaded the trained observer — ${imported.restored} traces`))
  }

  const conflictsBefore = sweepConflicts(teacher).length
  const edgesBefore = teacher.relations().length

  if (has('dry')) {
    // Extraction only: report what WOULD be learned, store nothing.
    const { readText } = await import('../teacher/reading')
    const known = new Set(teacher.listWords().map((w) => w.word.word))
    const result = readText(text, { vocabulary: known, source: label })
    console.log(bold(`\nread ${label} (dry run)`))
    console.log(`  sentences parsed   ${result.sentencesParsed}/${result.sentencesRead}`)
    console.log(`  relations found    ${result.relations.length}`)
    console.log(`  explicit denials   ${result.negations.length}`)
    for (const relation of result.relations.slice(0, 20)) {
      console.log(`    ${green(relation.subject)} ${relation.predicate} ${green(relation.object)}  ${dim(relation.source.slice(0, 70))}`)
    }
    if (result.relations.length > 20) console.log(dim(`    … and ${result.relations.length - 20} more`))
    session.dispose()
    return
  }

  const report = teacher.readFrom(text, label)
  const edgesAfter = teacher.relations().length
  const conflictsAfter = sweepConflicts(teacher).length

  console.log(bold(`\nread ${label}`))
  console.log(`  sentences parsed   ${report.sentencesParsed}/${report.sentencesRead} ${dim(`(${((report.sentencesParsed / Math.max(1, report.sentencesRead)) * 100).toFixed(0)}% of the text stated something the observer can verify)`)}`)
  console.log(`  relations found    ${report.relationsFound}`)
  console.log(`  new to the graph   ${green(String(report.accepted))} ${dim('(spoken hedged until an independent source confirms them)')}`)
  console.log(`  agreed with memory ${green(String(Math.max(0, report.relationsFound - report.accepted - report.conflicts)))} ${dim('(corroboration — hedging drops)')}`)
  console.log(`  conflicts to check ${report.conflicts > 0 ? yellow(String(report.conflicts)) : '0'} ${dim('(stored as beliefs to verify, never silent overwrites)')}`)
  console.log(`  explicit denials   ${report.negations}`)
  console.log(`  words learned      ${green(String(report.wordsLearned.length))} ${dim(report.wordsLearned.slice(0, 10).join(', '))}`)
  console.log(`  graph edges        ${edgesBefore} → ${edgesAfter}`)
  console.log(`  contradictions     ${conflictsBefore} → ${conflictsAfter > conflictsBefore ? yellow(String(conflictsAfter)) : String(conflictsAfter)}`)

  if (report.unknownWords.length > 0) {
    const top = report.unknownWords.slice(0, 12).map((u) => `${u.word}${u.count > 1 ? `×${u.count}` : ''}`)
    console.log(`  words it does not know: ${top.join(', ')}${report.unknownWords.length > 12 ? dim(` … +${report.unknownWords.length - 12}`) : ''}`)
    console.log(dim('  (recorded as gaps — the observer can ask about these)'))
  }

  const save = flag('save')
  if (save !== null && save.length > 0) {
    writeFileSync(save, JSON.stringify(teacher.exportBootstrap(), null, 2))
    console.log(dim(`\nsaved observer to ${save}`))
  }
  session.dispose()
}

main().catch((reason) => {
  console.error(reason)
  process.exit(1)
})
