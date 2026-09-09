/**
 * @jest-environment node
 *
 * CORPUS PROFILE (tasks 60/61) — where the time goes once a corpus is in the
 * graph. Builds a profiling record once (2,000 taught words + PROFILE_ROWS
 * ConceptNet rows, saved under bench/curriculum/.profile-record.json,
 * gitignored) and then times: import, the cold and warm graph rebuild, ten
 * closed questions (with OBSERVER_PROFILE_CHAT=1 per-stage laps), and one
 * 100-row feed. Reads the operator's corpus: a measurement, not a unit test.
 *
 *   cd apps/web && OBSERVER_PROFILE_REBUILD=1 OBSERVER_PROFILE_CHAT=1 \
 *     npx jest -c jest.bench.config.cjs --testPathPatterns corpusProfile
 */
import { it } from '@jest/globals';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import type { BootstrapRecord } from '../teacher/bootstrap';
import { CurriculumFeeder, discoverSources } from './registry';

it('profiles rebuild, question and feed cost on a corpus-scale graph', async () => {
  const session = new ObserverSession(OBSERVER_OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, ACTIVE_DECK, null, 500, 4, 7);
  let t = Date.now();
  const recordPath = resolve(process.cwd(), '..', '..', 'bench', 'curriculum', '.profile-record.json');
  const corpusDir = resolve(process.cwd(), process.env.PROFILE_CORPUS ?? 'corpus');
  if (!existsSync(recordPath)) {
    const src = discoverSources(corpusDir).filter((s) => s.id === 'conceptnet');
    if (src.length === 0) {
      console.log(`no corpus/conceptnet.en.jsonl under ${corpusDir} — nothing profiled`);
      session.dispose();
      return;
    }
    // Build the profiling record once: 2,000 taught words + PROFILE_ROWS corpus rows.
    for (const entry of ACTIVE_DECK.slice(0, 2000)) teacher.teach(entry.word);
    const f = new CurriculumFeeder(teacher, src);
    const rows = Number(process.env.PROFILE_ROWS ?? '20000');
    for (let fed = 0; fed < rows; fed += 1000) {
      const r = f.feed(src[0], 1000);
      console.log(`  built: fed ${fed + r.rows} rows in ${r.ms} ms (+${r.accepted} edges, +${r.grown} words)`);
    }
    writeFileSync(recordPath, JSON.stringify(teacher.exportBootstrap()));
    console.log(`record built in ${Date.now() - t} ms → ${recordPath}`);
    session.dispose();
    return;
  }
  const restored = teacher.importBootstrap(JSON.parse(readFileSync(recordPath, 'utf8')) as BootstrapRecord);
  console.log(`import ${Date.now() - t} ms, restored ${restored.restored}, words ${teacher.listWords().length}, grown ${teacher.grownWordList().length}`);
  t = Date.now();
  const n = teacher.relations().length;
  console.log(`relations() cold ${Date.now() - t} ms → ${n} edges`);
  t = Date.now();
  teacher.relations();
  console.log(`relations() warm ${Date.now() - t} ms`);
  for (const q of ['is a dog an animal', 'does a bird have wings', 'is a car a vehicle', 'can a fish swim', 'is water a liquid', 'is a hammer a tool', 'does a house have a roof', 'is a rose a flower', 'can a bird fly', 'is milk a drink']) {
    t = Date.now();
    const a = teacher.chatAnswer(q);
    console.log(`chatAnswer "${q}" ${Date.now() - t} ms → [${a.mode}] ${a.mode === 'decline' ? '' : a.response.slice(0, 60)}`);
  }
  const sources = discoverSources(corpusDir).filter((s) => s.id === 'conceptnet');
  const feeder = new CurriculumFeeder(teacher, sources);
  t = Date.now();
  const fed = feeder.feed(sources[0], 100);
  console.log(`feed 100 rows ${Date.now() - t} ms (report ${fed.ms}) +${fed.accepted} edges +${fed.grown} words`);
  t = Date.now();
  teacher.relations();
  console.log(`relations() after feed ${Date.now() - t} ms`);
  session.dispose();
}, 600000);
