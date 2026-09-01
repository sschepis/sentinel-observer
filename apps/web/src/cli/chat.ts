#!/usr/bin/env node
/**
 * INTERACTIVE CLI CHAT — talk to a live observer in a terminal.
 *
 * The teacher runs fully offline: every answer is produced by the
 * observer's own memory, relation graph, operators, grounded frames and
 * learned templates — no LLM in the loop (the same honesty contract the
 * web app grades against).
 *
 * Usage:
 *   npm run chat                          # interactive REPL
 *   npm run chat -- --words 1000          # train more words first
 *   npm run chat -- --load teacher.json   # resume a saved observer
 *   npm run chat -- --save teacher.json   # export the observer on exit
 *   npm run chat -- "what is water"       # single-shot question (pipes OK)
 *
 * REPL commands:
 *   /help        this list
 *   /stats       learning state (words, competencies, graph, queues)
 *   /memories    episodic facts the observer retained across turns
 *   /templates   learned language templates (admitted/candidates)
 *   /relations   relation graph size + a sample of edges
 *   /sweep       run the contradiction sweep over the relation graph
 *   /save <path> export the observer's bootstrap to a JSON file
 *   /quit        exit (Ctrl-D / Ctrl-C work too)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { ObserverSession } from '../observer/engine'
import { OBSERVER_OPTIONS } from '../observer/options'
import { TeacherAgent } from '../teacher/TeacherAgent'
import { ACTIVE_DECK } from '../teacher/decks'
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation'
import { MemoryPersistenceStore } from '../persistence/store'
import { sweepConflicts } from '../teacher/sweep'
import type { BootstrapRecord } from '../teacher/bootstrap'
import type { ChatAnswerWithMemory } from '../teacher/TeacherAgent'

const TTY = process.stdout.isTTY === true
const paint = (code: number, text: string): string => (TTY ? `\u001b[${code}m${text}\u001b[0m` : text)
const dim = (text: string): string => paint(2, text)
const bold = (text: string): string => paint(1, text)
const green = (text: string): string => paint(32, text)
const yellow = (text: string): string => paint(33, text)
const red = (text: string): string => paint(31, text)
const cyan = (text: string): string => paint(36, text)

const WORDS = process.argv.includes('--words') ? Number(process.argv[process.argv.indexOf('--words') + 1] ?? 400) : 400
const LOAD = process.argv.includes('--load') ? process.argv[process.argv.indexOf('--load') + 1] ?? '' : ''
const SAVE = process.argv.includes('--save') ? process.argv[process.argv.indexOf('--save') + 1] ?? '' : ''
/** The shipped trained observer (public/bootstrap.json, built by npm run
 *  train) — the CLI's default: a fully-taught conversational core instead
 *  of a scratch 400-word observer. */
const SHIPPED_BOOTSTRAP = new URL('../../public/bootstrap.json', import.meta.url).pathname
const FLAG_WITH_VALUE = new Set(['--words', '--load', '--save'])
const positional: string[] = []
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i]
  if (FLAG_WITH_VALUE.has(arg)) {
    i += 1
    continue
  }
  if (arg.startsWith('-')) continue
  positional.push(arg)
}
const SINGLE_SHOT = positional.join(' ').trim()

function format(answer: ChatAnswerWithMemory): string {
  const modeLabel: Record<string, string> = {
    memorized: green('[memorized]'),
    operator: cyan('[operator]'),
    creative: yellow('[creative]'),
    ask: red('[ask]'),
    decline: dim('[decline]')
  }
  const mode = modeLabel[answer.mode] ?? dim(`[${answer.mode}]`)
  const line = answer.mode === 'decline' ? 'I have not learned that yet.' : answer.response
  const tags: string[] = []
  if (answer.mode === 'creative') {
    tags.push(answer.grounded ? 'grounded' : 'markov-fallback')
    if ('hedged' in answer && answer.hedged === true) tags.push('hedged')
  }
  if (answer.mode === 'memorized' && answer.confidence !== null) {
    tags.push(`conf ${answer.confidence.toFixed(2)}`)
  }
  if (answer.mode === 'creative' && answer.confidence !== null) {
    tags.push(`conf ${answer.confidence.toFixed(2)}`)
  }
  if ('remembered' in answer && answer.remembered !== undefined && answer.remembered.length > 0) {
    tags.push(`remembers ${answer.remembered.length} fact${answer.remembered.length === 1 ? '' : 's'}`)
  }
  if ('stored' in answer && answer.stored !== undefined && answer.stored.length > 0) {
    tags.push(`stored ${answer.stored.length} fact${answer.stored.length === 1 ? '' : 's'}`)
  }
  const suffix = tags.length > 0 ? ` ${dim(tags.join(' · '))}` : ''
  return `${mode} ${line}${suffix}`
}

function printHelp(): void {
  console.log(bold('Commands'))
  console.log('  /help        this list')
  console.log('  /stats       learning state (words, competencies, graph, queues)')
  console.log('  /memories    episodic facts the observer retained')
  console.log('  /templates   learned language templates (admitted/candidates)')
  console.log('  /relations   relation graph size + a sample of edges')
  console.log('  /sweep       run the contradiction sweep over the relation graph')
  console.log('  /teach       teach a phrase: /teach <cue> :: <response> (the practice loop)')
  console.log('  /save <path> export the observer bootstrap to JSON')
  console.log('  /quit        exit')
  console.log('')
  console.log(dim('Anything else is asked to the observer. Try: "hello", "what is water", "can a bird fly", "tell me a story".'))
}

function printStats(teacher: TeacherAgent): void {
  const report = teacher.conversationReport()
  const taught = teacher.listWords().filter((w) => w.traceId !== null).length
  const due = teacher.listWords().filter((w) => w.dueAt !== null && w.dueAt <= Date.now()).length
  const relations = teacher.relations()
  const negations = teacher.negationsList()
  const facts = teacher.episodicFacts()
  const templates = teacher.learnedTemplateAudit()
  const pendingRegrades = teacher.graderReliability().pendingRegrades()
  console.log(bold('Learning state'))
  console.log(`  words taught          ${taught}${due > 0 ? dim(` (${due} due for review)`) : ''}`)
  console.log(`  conversation          competency ${(report.competency * 100).toFixed(0)}% · creative unlocked: ${report.creativeUnlocked}`)
  console.log(`  relation graph        ${relations.length} edges, ${negations.length} denials`)
  console.log(`  episodic memory       ${facts.length} salient facts`)
  console.log(`  learned templates     ${templates.filter((t) => t.status === 'admitted').length} admitted, ${templates.filter((t) => t.status === 'candidate').length} exploring, ${templates.filter((t) => t.status === 'dropped').length} dropped`)
  console.log(`  grader reliability    ${pendingRegrades.length} pending re-grades`)
}

function printMemories(teacher: TeacherAgent): void {
  const facts = teacher.episodicFacts()
  if (facts.length === 0) {
    console.log(dim('No salient facts retained yet — tell the observer about yourself ("I am learning English for work").'))
    return
  }
  console.log(bold('Episodic memory'))
  for (const fact of [...facts].sort((a, b) => b.timesSeen - a.timesSeen)) {
    const kind = fact.kind === 'user-fact' ? 'user' : fact.kind
    const statement = fact.content
    const seen = fact.timesSeen > 1 ? ` · seen ${fact.timesSeen}x` : ''
    console.log(`  ${dim(`[${kind}]`)} ${statement}${seen}`)
  }
}

function printTemplates(teacher: TeacherAgent): void {
  const audits = teacher.learnedTemplateAudit()
  const learned = audits.filter((t) => t.learned)
  if (learned.length === 0) {
    console.log(dim('No learned templates yet — the fixed frames answer until strong grades demonstrate new structures.'))
    return
  }
  console.log(bold('Learned templates'))
  for (const t of learned) {
    const status = t.status === 'admitted' ? green('admitted') : t.status === 'candidate' ? yellow('candidate') : dim('dropped')
    console.log(`  ${status} ${dim(t.id)} ${t.text} ${dim(`(evidence ${t.evidence}, acceptance ${(t.acceptance * 100).toFixed(0)}%)`)}`)
  }
}

function printRelations(teacher: TeacherAgent): void {
  const relations = teacher.relations()
  console.log(bold(`Relation graph (${relations.length} edges)`))
  for (const relation of relations.slice(0, 12)) {
    const strength = relation.strength !== undefined ? ` ${dim(`s=${relation.strength.toFixed(2)}`)}` : ''
    const classes = relation.sourceClasses !== undefined && relation.sourceClasses.length > 0
      ? ` ${dim(`[${relation.sourceClasses.join(',')}]`)}`
      : ''
    console.log(`  ${relation.subject} ${relation.predicate} ${relation.object}${strength}${classes}`)
  }
  if (relations.length > 12) console.log(dim(`  … and ${relations.length - 12} more`))
  const negations = teacher.negationsList()
  if (negations.length > 0) {
    console.log(dim(`  ${negations.length} denials, e.g. ${negations.slice(0, 3).map((n) => `${n.subject} is-not ${n.object}`).join(' · ')}`))
  }
}

function printSweep(teacher: TeacherAgent): void {
  const items = sweepConflicts(teacher)
  if (items.length === 0) {
    console.log(green('Sweep clean — no unresolved contradictions in the relation graph.'))
    return
  }
  console.log(bold(`Contradiction sweep — ${items.length} conflict${items.length === 1 ? '' : 's'} (schedule verification)`))
  for (const item of items.slice(0, 10)) {
    const kind = item.kind === 'direct' ? 'direct' : item.direction === 'explicit-positive' ? 'explicit+inherit-' : item.direction === 'explicit-negative' ? 'explicit-inherit+' : 'inherited-vs-inherited'
    console.log(`  ${red(`[${kind}]`)} ${item.subject} ${item.predicate} ${item.object} ${dim(`severity ${item.severity.toFixed(2)} · probe: ${item.question}`)}`)
  }
  if (items.length > 10) console.log(dim(`  … and ${items.length - 10} more`))
}

function saveBootstrap(teacher: TeacherAgent, path: string): void {
  writeFileSync(path, JSON.stringify(teacher.exportBootstrap(), null, 2))
  console.log(dim(`saved observer to ${path}`))
}

/** /teach <cue> :: <response> — the practice loop: the human teaches a
 *  phrase the observer did not know, and the observer immediately practices
 *  it (store + speak), so the very next encounter recalls it. */
function teachPhrase(teacher: TeacherAgent, argument: string): void {
  const separator = argument.indexOf('::')
  if (separator <= 0) {
    console.log(dim('usage: /teach <cue> :: <response>  (e.g. /teach good morning :: A bright start!)'))
    return
  }
  const cue = argument.slice(0, separator).trim().toLowerCase()
  const response = argument.slice(separator + 2).trim()
  if (cue.length === 0 || response.length === 0) {
    console.log(dim('usage: /teach <cue> :: <response>'))
    return
  }
  teacher.teachConversationDeck([{ cue, response }])
  const practiced = teacher.respond(cue)
  const outcome =
    practiced.response !== null && practiced.confidence !== null && practiced.confidence >= 0.8
      ? green(`recalled (conf ${practiced.confidence.toFixed(2)})`)
      : dim(`recalling (conf ${practiced.confidence?.toFixed(2) ?? '—'}) — one more practice will seal it`)
  console.log(`  taught "${cue}" · practice: ${outcome} — "${practiced.response ?? response}"`)
}

async function main(): Promise<void> {
  const session = new ObserverSession(OBSERVER_OPTIONS, 100)
  await session.initialize()
  const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 500)

  if (LOAD.length > 0) {
    const record = JSON.parse(readFileSync(LOAD, 'utf8')) as BootstrapRecord
    const imported = teacher.importBootstrap(record)
    console.log(dim(`imported ${imported.restored} traces · ${imported.conversations} conversations · ${imported.definitions} definitions from ${LOAD}`))
  } else if (!process.argv.includes('--words') && existsSync(SHIPPED_BOOTSTRAP)) {
    // Default: the shipped trained observer (full conversation curriculum).
    const record = JSON.parse(readFileSync(SHIPPED_BOOTSTRAP, 'utf8')) as BootstrapRecord
    const imported = teacher.importBootstrap(record)
    console.log(dim(`loaded the trained observer — ${imported.restored} traces · ${imported.conversations} conversations from ${SHIPPED_BOOTSTRAP}`))
  } else if (WORDS > 0) {
    console.log(dim(`training ${WORDS} words…`))
    for (const entry of ACTIVE_DECK.slice(0, WORDS)) {
      teacher.teach(entry.word)
    }
    teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS)
    for (const pair of ALL_CONVERSATION_PAIRS) {
      teacher.respond(pair.cue)
    }
  }
  const report = teacher.conversationReport()
  console.log(dim(`ready — ${teacher.listWords().filter((w) => w.traceId !== null).length} words · ${ALL_CONVERSATION_PAIRS.length} conversation exchanges · competency ${(report.competency * 100).toFixed(0)}% · type /help for commands`))
  console.log('')

  const ask = (question: string, echoQuestion: boolean): void => {
    const answer = teacher.chatAnswer(question)
    if (echoQuestion) console.log(`${bold('you')}> ${question}`)
    console.log(`${green('sentinel')}> ${format(answer)}`)
    console.log('')
  }

  // Single-shot mode: positional arguments are one question; pipes and
  // scripts get the same answer path with no REPL.
  if (SINGLE_SHOT.length > 0) {
    ask(SINGLE_SHOT, true)
    if (SAVE.length > 0) saveBootstrap(teacher, SAVE)
    session.dispose()
    return
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: TTY })
  let pendingSave = SAVE
  const finish = (): void => {
    if (pendingSave.length > 0) saveBootstrap(teacher, pendingSave)
    session.dispose()
    process.exit(0)
  }
  rl.on('SIGINT', finish)
  rl.on('close', finish)

  const loop = (): void => {
    rl.question(`${bold('you')}> `, (line) => {
      const input = line.trim()
      if (input.length > 0) {
        const [command, ...rest] = input.split(/\s+/)
        const argument = rest.join(' ')
        switch (command) {
          case '/help': printHelp(); break
          case '/stats': printStats(teacher); break
          case '/memories': printMemories(teacher); break
          case '/templates': printTemplates(teacher); break
          case '/relations': printRelations(teacher); break
          case '/sweep': printSweep(teacher); break
          case '/save':
            if (argument.length > 0) {
              saveBootstrap(teacher, argument)
              pendingSave = argument
            } else {
              console.log(dim('usage: /save <path.json>'))
            }
            break
          case '/teach':
            teachPhrase(teacher, argument)
            break
          case '/quit':
            finish()
            return
          default:
            ask(input, false)
        }
      }
      loop()
    })
  }
  loop()
}

main().catch((reason) => {
  console.error(reason)
  process.exit(1)
})
