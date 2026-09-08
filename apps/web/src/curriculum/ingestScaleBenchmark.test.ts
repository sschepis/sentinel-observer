/**
 * @jest-environment node
 *
 * INGEST SCALE BENCH — what does the relation graph cost as ConceptNet
 * arrives? (bench config only: `npx jest -c jest.bench.config.cjs
 * --testPathPatterns ingestScale`).
 *
 * Every feed rebuilds the derived graph (merge, corroboration classes, sense
 * split, hypothesis tier, hologram). This bench ingests synthetic ConceptNet
 * rows over the full active deck at growing sizes and reports the feed time,
 * the rebuild time of one relations() read, and a relational question's
 * latency — the numbers the training loop's CURRICULUM_EVERY / BUDGET are
 * chosen from. Env INGEST_SIZES (default "5000,20000,50000") and
 * INGEST_RECORD=public/bootstrap.json to run over the real record.
 *
 * Rows are synthetic but shaped like the real thing: random deck-word pairs
 * over the mapped relations, weights 1–4. The graph's cost depends on edge
 * count and vocabulary, not on which words — so the synthetic curve is the
 * budget's honest upper bound.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { mulberry32 } from '@sschepis/sentient-core';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import type { BootstrapRecord } from '../teacher/bootstrap';
import { conceptNetToRelations, CONCEPTNET_RELATIONS, type ConceptNetRow } from './conceptnet';
import { WORD_SHAPE } from './types';

const SIZES = (process.env.INGEST_SIZES ?? '5000,20000,50000').split(',').map((n) => Number(n.trim())).filter((n) => n > 0);
const RECORD = process.env.INGEST_RECORD ?? '';
const RELS = Object.keys(CONCEPTNET_RELATIONS).filter((rel) => CONCEPTNET_RELATIONS[rel].negation !== true);

function syntheticRows(words: readonly string[], count: number, rng: () => number): ConceptNetRow[] {
  const rows: ConceptNetRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = words[Math.floor(rng() * words.length)];
    const end = words[Math.floor(rng() * words.length)];
    if (start === end) continue;
    rows.push({ rel: RELS[Math.floor(rng() * RELS.length)], start, end, weight: 1 + Math.floor(rng() * 4), sources: 1 });
  }
  return rows;
}

describe('ingest scale bench (src/curriculum)', () => {
  it('reports feed time, graph rebuild time and question latency as the ingested graph grows', async () => {
    const session = new ObserverSession(OBSERVER_OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, ACTIVE_DECK, null, 500, 4, 7);
    if (RECORD.length > 0) {
      teacher.importBootstrap(JSON.parse(readFileSync(RECORD, 'utf8')) as BootstrapRecord);
    } else {
      // A taught core so the graph has definition edges to reconcile against.
      for (const entry of ACTIVE_DECK.slice(0, 2000)) teacher.teach(entry.word);
    }
    const words = ACTIVE_DECK.map((entry) => entry.word.toLowerCase()).filter((word) => WORD_SHAPE.test(word));
    const vocabulary = new Set(words);
    const rng = mulberry32(0xc0ffee);
    const lines: string[] = [];
    let total = 0;
    for (const size of SIZES) {
      const rows = syntheticRows(words, size - total, rng);
      const batch = conceptNetToRelations(rows, vocabulary);
      const t0 = Date.now();
      const took = teacher.ingestRelationBatch(batch);
      const feedMs = Date.now() - t0;
      total = size;
      teacher.invalidateRelations();
      const t1 = Date.now();
      const edges = teacher.relations().length;
      const rebuildMs = Date.now() - t1;
      const t2 = Date.now();
      teacher.chatAnswer('is a dog an animal');
      teacher.chatAnswer('what is a bird made of');
      const askMs = (Date.now() - t2) / 2;
      const line = `  ${String(size).padStart(7)} rows → +${took.accepted} edges (graph ${edges}) · feed ${feedMs} ms · rebuild ${rebuildMs} ms · question ${askMs.toFixed(0)} ms`;
      lines.push(line);
      // eslint-disable-next-line no-console
      console.log(line);
      expect(took.accepted).toBeGreaterThan(0);
    }
    // eslint-disable-next-line no-console
    console.log(`\n[ingestScale] ${RECORD.length > 0 ? `record ${RECORD}` : '2000-word taught core'}, deck ${words.length} words:\n${lines.join('\n')}`);
    session.dispose();
  }, 600000);
});
