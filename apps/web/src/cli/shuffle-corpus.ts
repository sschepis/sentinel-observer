/**
 * shuffle-corpus — rewrite a corpus JSONL in a seeded random order.
 *
 *   cd apps/web && npm run shuffle-corpus -- corpus/conceptnet.en.jsonl
 *
 * For files written before the fetchers shuffled (fetch-conceptnet wrote the
 * ConceptNet dump in its own order: sorted by relation, then alphabetically,
 * so a feeder ate every antonym before any is-a edge). The shuffle is
 * deterministic (seed 0x5eed), so the held-out tenth — fixed by row index —
 * is the same on every machine that shuffles the same file. The file is
 * rewritten in place; a `.unshuffled` copy is left beside it.
 *
 * RUN THIS BEFORE THE SERVER HAS INGESTED THE FILE. The feeder's cursor is a
 * row index: shuffling a partly-ingested file would re-feed some rows and
 * skip others. If the server already has a cursor for this source, either
 * leave the file alone or reset the cursor by starting from a fresh record.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mulberry32 } from '@sschepis/sentient-core';

const path = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (path === undefined) {
  console.log('usage: npm run shuffle-corpus -- <file.jsonl>');
  process.exit(1);
}
const file = resolve(path);
const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
copyFileSync(file, `${file}.unshuffled`);
const rng = mulberry32(0x5eed);
for (let i = lines.length - 1; i > 0; i -= 1) {
  const j = Math.floor(rng() * (i + 1));
  [lines[i], lines[j]] = [lines[j], lines[i]];
}
writeFileSync(file, `${lines.join('\n')}\n`);
console.log(`shuffled ${lines.length} rows in place → ${file} (original kept as ${file}.unshuffled)`);
