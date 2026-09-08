/**
 * fetch-conceptnet — build corpus/conceptnet.en.jsonl for the observer.
 *
 *   cd apps/web && npm run fetch-conceptnet
 *   npm run fetch-conceptnet -- --in ~/Downloads/conceptnet-assertions-5.7.0.csv.gz
 *   npm run fetch-conceptnet -- --out corpus/conceptnet.en.jsonl --min-weight 1
 *
 * Streams the ConceptNet 5.7 assertions dump (1.2 GB gzip, ~34M rows; the
 * default URL is the public S3 mirror, or `--in` a local copy) through
 * gunzip line by line, and keeps only rows that are:
 *   · English on both ends,
 *   · a relation the observer can hold (src/curriculum/conceptnet.ts),
 *   · between two single words of the active deck.
 * What comes out is a few tens of MB the server can load whole. Nothing is
 * written anywhere else; the dump itself is not kept unless you passed a
 * local file. Progress every million input lines.
 *
 * License: ConceptNet 5 is CC BY-SA 4.0 (Speer, Chin & Havasi 2017).
 */
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { dirname, resolve } from 'node:path';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { ACTIVE_DECK } from '../teacher/decks';
import { CONCEPTNET_RELATIONS, parseConceptNetLine } from '../curriculum/conceptnet';
import { WORD_SHAPE } from '../curriculum/types';

const DEFAULT_URL = 'https://s3.amazonaws.com/conceptnet/downloads/2019/edges/conceptnet-assertions-5.7.0.csv.gz';

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};

const IN = arg('--in', '');
const OUT = resolve(arg('--out', 'corpus/conceptnet.en.jsonl'));
const MIN_WEIGHT = Number(arg('--min-weight', '1'));

function openSource(): Promise<Readable> {
  if (IN.length > 0) return Promise.resolve(createReadStream(resolve(IN)));
  return new Promise((resolveStream, reject) => {
    const follow = (url: string, hops: number): void => {
      httpsGet(url, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location !== undefined && hops < 5) {
          response.resume();
          follow(new URL(response.headers.location, url).toString(), hops + 1);
          return;
        }
        if (status !== 200) {
          reject(new Error(`download failed: HTTP ${status} for ${url}`));
          return;
        }
        resolveStream(response);
      }).on('error', reject);
    };
    follow(DEFAULT_URL, 0);
  });
}

async function main(): Promise<void> {
  const vocabulary = new Set(ACTIVE_DECK.map((entry) => entry.word.toLowerCase()).filter((word) => WORD_SHAPE.test(word)));
  console.log(`=== fetch-conceptnet — ${IN.length > 0 ? `reading ${IN}` : `downloading ${DEFAULT_URL}`} ===`);
  console.log(`deck vocabulary: ${vocabulary.size} single words · relations kept: ${Object.keys(CONCEPTNET_RELATIONS).join(', ')} · min weight ${MIN_WEIGHT}`);
  mkdirSync(dirname(OUT), { recursive: true });
  const out = createWriteStream(OUT);
  const source = await openSource();
  const lines = createInterface({ input: source.pipe(createGunzip()), crlfDelay: Infinity });
  const started = Date.now();
  let read = 0;
  let kept = 0;
  const perRelation = new Map<string, number>();
  for await (const line of lines) {
    read += 1;
    if (read % 1_000_000 === 0) {
      console.log(`  … ${(read / 1e6).toFixed(0)}M lines read, ${kept} kept (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    }
    // Cheap prefilter before parsing: English on both ends.
    if (!line.includes('\t/c/en/')) continue;
    const row = parseConceptNetLine(line);
    if (row === null || row.weight < MIN_WEIGHT) continue;
    if (!WORD_SHAPE.test(row.start) || !WORD_SHAPE.test(row.end)) continue;
    if (!vocabulary.has(row.start) || !vocabulary.has(row.end) || row.start === row.end) continue;
    out.write(`${JSON.stringify(row)}\n`);
    kept += 1;
    perRelation.set(row.rel, (perRelation.get(row.rel) ?? 0) + 1);
  }
  await new Promise<void>((done) => out.end(done));
  console.log(`done: ${read} lines read, ${kept} rows kept in ${((Date.now() - started) / 1000).toFixed(0)} s → ${OUT}`);
  for (const [rel, count] of [...perRelation.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${rel.padEnd(16)} ${count}`);
  }
  console.log('next: start the server with OBSERVER_CORPUS=corpus (or --corpus corpus); the classroom ingests it under its budget.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
