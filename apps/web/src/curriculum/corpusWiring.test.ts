/**
 * @jest-environment node
 *
 * IS THE TRAINING DATA ACTUALLY WIRED IN? (bench config; reads the
 * operator's corpus directory.)
 *
 * Every corpus we download is only worth what the classroom does with it,
 * and the failure mode is silent: a file nothing reads, a reader nothing
 * produces, a cursor that reached the end and stopped. This bench walks the
 * real corpus directory and reports, per source, what one feed actually
 * changes in the observer — edges, definitions, exchanges, grades, words —
 * so a corpus that is present but inert cannot look the same as one that is
 * teaching.
 *
 * It found, on 2026-09-09: problems.jsonl exhausted at 3,004 of 3,004 (the
 * whole arithmetic corpus spent once, by a parser that got 19 of 24 wrong,
 * and dead to learning thereafter); definitions.jsonl never produced by any
 * fetcher while 9,039 ConceptNet-grown words sat with no definition; and
 * dialogue.jsonl missing entirely.
 *
 *   cd apps/web && npx jest -c jest.bench.config.cjs --testPathPatterns corpusWiring
 *   OBSERVER_CORPUS=corpus WIRING_BUDGET=40 …
 */
import { describe, it, expect } from '@jest/globals';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { PRIME_SPACE, deckVocabulary } from '../teacher/primeSignature';
import { CONVERSATION_CUE_TOKENS } from '../teacher/conversation';
import { ACTIVE_DECK } from '../teacher/decks';
import { CurriculumFeeder, KNOWN_SOURCES, PRACTICE_KINDS, discoverSources, describeFeed } from './registry';

const CORPUS = resolve(process.cwd(), process.env.OBSERVER_CORPUS ?? 'corpus');
const BUDGET = Number(process.env.WIRING_BUDGET ?? '40');
const TAUGHT = Number(process.env.WIRING_TAUGHT ?? '400');

describe('corpus wiring', () => {
  it('reports, per source on disk, what one feed changes in the observer', async () => {
    if (!existsSync(CORPUS)) {
      // eslint-disable-next-line no-console
      console.log(`no corpus at ${CORPUS} — nothing measured (set OBSERVER_CORPUS)`);
      return;
    }
    const sources = discoverSources(CORPUS);
    const present = new Set(sources.map((source) => source.id));
    const missing = KNOWN_SOURCES.filter((known) => !present.has(known.id));

    const deck = ACTIVE_DECK.slice(0, TAUGHT);
    const session = new ObserverSession(
      {
        primeCount: 128,
        gridSize: 256,
        memoryMode: 'compact' as const,
        smfWidth: 128,
        vocabulary: deckVocabulary([...deck, ...CONVERSATION_CUE_TOKENS.map((word) => ({ word }))], PRIME_SPACE)
      },
      100
    );
    await session.initialize();
    const teacher = new TeacherAgent(session, deck, null, 500, 4, 7);
    for (const entry of deck) teacher.teach(entry.word);

    const lines: string[] = [`=== corpus wiring — ${CORPUS} ===`, `  sources on disk: ${sources.map((source) => source.id).join(', ') || 'none'}`];
    if (missing.length > 0) {
      lines.push(`  READERS WITH NO FILE: ${missing.map((known) => `${known.id} (${known.file})`).join(', ')}`);
    }

    const feeder = new CurriculumFeeder(teacher, sources);
    const undefinedWordsBefore = teacher.listWords().filter((entry) => entry.word.definition.trim().length === 0).length;
    for (const source of sources) {
      const words = teacher.listWords().length;
      const edges = teacher.relations().length;
      const exchanges = teacher.listConversationPairs().length;
      const report = feeder.feed(source, BUDGET);
      const changed = {
        words: teacher.listWords().length - words,
        edges: teacher.relations().length - edges,
        exchanges: teacher.listConversationPairs().length - exchanges
      };
      lines.push(
        `  ${source.id.padEnd(12)} ${describeFeed(report)}`,
        `  ${''.padEnd(12)} → deck +${changed.words} words · graph +${changed.edges} edges · +${changed.exchanges} exchanges${
          PRACTICE_KINDS.has(source.kind) ? ' · practice: recycles, never used up' : ''
        }`
      );
      // A source that is present must DO something: either it changes the
      // observer, or it grades it. A feed that changes nothing and grades
      // nothing is a corpus that is only pretending to teach.
      const didSomething =
        changed.words > 0 || changed.edges > 0 || changed.exchanges > 0 || report.accepted > 0 || report.wrong > 0 || report.abstained > 0 || report.negations > 0;
      expect({ source: source.id, didSomething }).toEqual({ source: source.id, didSomething: true });
    }
    const undefinedWordsAfter = teacher.listWords().filter((entry) => entry.word.definition.trim().length === 0).length;
    lines.push(`  words with no definition: ${undefinedWordsBefore} → ${undefinedWordsAfter}`);

    // THE PRACTICE INVARIANT: a graded source is never used up. Feed it to
    // the end and it comes round again.
    const problems = sources.find((source) => source.id === 'problems');
    if (problems !== undefined) {
      const rows = feeder.rowsOf(problems).length;
      teacher.setCurriculumCursor('problems', rows);
      expect(feeder.remaining(problems)).toBe(0);
      const again = feeder.feed(problems, BUDGET);
      lines.push(`  problems at the end of the corpus: ${again.wrapped ? `wrapped into pass ${again.pass}` : 'DID NOT WRAP — the corpus is dead to learning'}`);
      expect(again.wrapped).toBe(true);
      expect(again.accepted + again.wrong + again.abstained).toBeGreaterThan(0);
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    session.dispose();
  }, 15 * 60 * 1000);
});
