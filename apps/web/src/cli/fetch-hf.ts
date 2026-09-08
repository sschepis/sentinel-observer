/**
 * fetch-hf — pull dialogue and passage corpora from the Hugging Face Hub into
 * the observer's corpus directory, already cut to the shapes the observer
 * ingests (src/curriculum/text.ts).
 *
 *   cd apps/web
 *   npm run fetch-hf -- dailydialog                 # → corpus/dialogue.jsonl
 *   npm run fetch-hf -- tinystories --rows 20000    # → corpus/passages.jsonl (appends)
 *   npm run fetch-hf -- simplewiki  --rows 20000    # → corpus/passages.jsonl (appends)
 *   npm run fetch-hf -- svamp                       # → corpus/problems.jsonl (appends)
 *   npm run fetch-hf -- asdiv                       # → corpus/problems.jsonl (appends)
 *
 * Uses the public datasets-server rows API (100 rows per request), so
 * nothing is installed and no parquet is parsed. A Hugging Face token is
 * optional but raises the rate limits: put HF_TOKEN=hf_… in apps/web/.env
 * (or the environment) — never on the command line. Each source has a
 * fallback list of dataset ids because Hub ids move; a renamed id is
 * followed through the Hub API to its current name, and when every id
 * fails the available configs/splits of the last one are printed. Override
 * the id outright with `--dataset owner/name [--config c] [--split s]` —
 * the row shape is still the source's (dailydialog takes either one row per
 * dialogue with a list of turns, or one row per utterance with a dialogue
 * id — mirrors use both). `--rows N` bounds the
 * SOURCE rows read per run (default: all of DailyDialog; 20,000 for the two
 * prose corpora). Each source keeps a cursor in corpus/.fetch-hf.cursors.json,
 * so RE-RUNNING THE SAME COMMAND CONTINUES where the last run stopped;
 * `--offset N` overrides the cursor, `--fresh` truncates the file and resets
 * it. Lines already in the output are never appended twice. A 429 is never a
 * lost page: the run waits it out and slows down; only a server error that
 * keeps failing skips a page (reported at the end). Output is appended
 * page-by-page, so a run that stops early leaves a usable file.
 *
 * Licenses: DailyDialog CC BY-NC-SA 4.0 (Li et al. 2017); TinyStories
 * CDLA-Sharing-1.0 (Eldan & Li 2023); Simple English Wikipedia CC BY-SA 4.0;
 * SVAMP MIT (Patel et al. 2021); ASDiv CC BY-NC 4.0 (Miao et al. 2020).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { dirname, resolve } from 'node:path';
import { pairsFromDialogue, passageFrom } from '../curriculum/text';
import type { ProblemRow } from '../curriculum/problems';

/** .env loader, same shape as the server's: explicit env wins over the file. */
function loadEnvFile(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key.length > 0 && process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile();
const HF_TOKEN = process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN ?? '';
const RETRIES = 5;

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};
const SOURCE = process.argv.find((a) => ['dailydialog', 'tinystories', 'simplewiki', 'svamp', 'asdiv'].includes(a)) ?? '';
const CORPUS = resolve(arg('--corpus', 'corpus'));
const FRESH = process.argv.includes('--fresh');
const OFFSET = Math.max(0, Number(arg('--offset', '0')) || 0);
const PAGE = 100;
/** Explicit dataset override: `--dataset owner/name [--config c] [--split s]`. */
const DATASET_OVERRIDE = arg('--dataset', '');
const CONFIG_OVERRIDE = arg('--config', '');
const SPLIT_OVERRIDE = arg('--split', '');

/** The turns of a dialogue row, whatever the column is called on this mirror. */
function dialogueTurns(row: Record<string, unknown>): string[] {
  for (const key of ['dialog', 'dialogue', 'utterances', 'turns', 'text']) {
    const value = row[key];
    if (Array.isArray(value)) {
      const turns = value.map((t) => (typeof t === 'string' ? t : t !== null && typeof t === 'object' && typeof (t as { text?: unknown }).text === 'string' ? (t as { text: string }).text : '')).filter((t) => t.length > 0);
      if (turns.length > 0) return turns;
    }
    // Some mirrors store the whole dialogue as one string, turns on lines or
    // separated by " __eou__ ".
    if (typeof value === 'string' && value.length > 0) {
      const turns = value.split(/__eou__|\r?\n/).map((t) => t.trim()).filter((t) => t.length > 0);
      if (turns.length > 1) return turns;
    }
  }
  return [];
}

interface SourceSpec {
  candidates: Array<{ dataset: string; config: string; split: string }>;
  defaultRows: number;
  out: string;
  convert: (row: Record<string, unknown>) => string[];
  /** Lines still buffered when the run ends (stateful converters). */
  flush?: () => string[];
}

/**
 * DailyDialog mirrors come in two shapes: one row per DIALOGUE (a list of
 * turns) or one row per UTTERANCE (a text plus a dialogue id, rows in order).
 * The second needs state: turns are gathered under the current dialogue id
 * and cut into pairs when the id changes (and once more at the end).
 */
function dialogueConverter(): Pick<SourceSpec, 'convert' | 'flush'> {
  let currentId: string | null = null;
  let turns: string[] = [];
  let described = false;
  const emit = (): string[] => {
    const lines = pairsFromDialogue(turns, 'dailydialog').map((pair) => JSON.stringify(pair));
    turns = [];
    return lines;
  };
  const utteranceOf = (row: Record<string, unknown>): string | null => {
    for (const key of ['utterance', 'text', 'sentence', 'content', 'message']) {
      if (typeof row[key] === 'string' && (row[key] as string).trim().length > 0) return (row[key] as string).trim();
    }
    return null;
  };
  const dialogueIdOf = (row: Record<string, unknown>): string | null => {
    for (const key of ['dialog_id', 'dialogue_id', 'conversation_id', 'conv_id', 'dialogId', 'id']) {
      const value = row[key];
      if (typeof value === 'string' || typeof value === 'number') return String(value);
    }
    return null;
  };
  return {
    convert: (row) => {
      const whole = dialogueTurns(row);
      if (whole.length > 1) return pairsFromDialogue(whole, 'dailydialog').map((pair) => JSON.stringify(pair));
      const utterance = utteranceOf(row);
      const id = dialogueIdOf(row);
      if (utterance === null || id === null) {
        if (!described) {
          described = true;
          console.log(`  cannot read this row shape — columns: ${Object.keys(row).join(', ')} (need a list of turns, or an utterance + dialogue id per row)`);
        }
        return [];
      }
      const lines = id !== currentId && turns.length > 0 ? emit() : [];
      currentId = id;
      turns.push(utterance);
      return lines;
    },
    flush: () => (turns.length > 0 ? emit() : [])
  };
}

const SPECS: Record<string, SourceSpec> = {
  dailydialog: {
    // The canonical id (li2017dailydialog/daily_dialog) is a loading-script
    // dataset the datasets-server no longer serves; the mirrors below carry
    // the same 13k dialogues as parquet. Renames are followed automatically.
    candidates: [
      { dataset: 'li2017dailydialog/daily_dialog', config: 'default', split: 'train' },
      { dataset: 'roskoN/dailydialog', config: 'default', split: 'train' },
      { dataset: 'pixelsandpointers/better_daily_dialog', config: 'default', split: 'train' },
      { dataset: 'OpenRL/daily_dialog', config: 'default', split: 'train' },
      { dataset: 'daily_dialog', config: 'default', split: 'train' }
    ],
    defaultRows: 20000,
    out: 'dialogue.jsonl',
    ...dialogueConverter()
  },
  tinystories: {
    candidates: [{ dataset: 'roneneldan/TinyStories', config: 'default', split: 'train' }],
    defaultRows: 20000,
    out: 'passages.jsonl',
    convert: (row) => {
      const text = typeof row.text === 'string' ? row.text : '';
      const passage = passageFrom('story', text, 'tinystories');
      return passage === null ? [] : [JSON.stringify(passage)];
    }
  },
  svamp: {
    candidates: [{ dataset: 'ChilleD/SVAMP', config: 'default', split: 'train' }],
    defaultRows: 1000,
    out: 'problems.jsonl',
    convert: (row) => {
      const body = typeof row.Body === 'string' ? row.Body : '';
      const question = typeof row.Question === 'string' ? row.Question : '';
      const answer = row.Answer === undefined || row.Answer === null ? '' : String(row.Answer);
      if (question.length === 0 || answer.length === 0) return [];
      const problem: ProblemRow = { body, question, answer, source: 'svamp' };
      return [JSON.stringify(problem)];
    }
  },
  asdiv: {
    candidates: [{ dataset: 'EleutherAI/asdiv', config: 'asdiv', split: 'validation' }],
    defaultRows: 2500,
    out: 'problems.jsonl',
    convert: (row) => {
      const body = typeof row.body === 'string' ? row.body : '';
      const question = typeof row.question === 'string' ? row.question : '';
      const answer = typeof row.answer === 'string' ? row.answer : row.answer === undefined || row.answer === null ? '' : String(row.answer);
      if (question.length === 0 || answer.length === 0) return [];
      const problem: ProblemRow = { body, question, answer, source: 'asdiv' };
      return [JSON.stringify(problem)];
    }
  },
  simplewiki: {
    candidates: [
      { dataset: 'wikimedia/wikipedia', config: '20231101.simple', split: 'train' },
      { dataset: 'wikipedia', config: '20220301.simple', split: 'train' }
    ],
    defaultRows: 20000,
    out: 'passages.jsonl',
    convert: (row) => {
      const title = typeof row.title === 'string' ? row.title : '';
      const text = typeof row.text === 'string' ? row.text : '';
      const passage = passageFrom(title, text, 'simplewiki', { lead: true });
      return passage === null ? [] : [JSON.stringify(passage)];
    }
  }
};

/** An HTTP failure that says how long to wait (429 with Retry-After). */
class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs: number | null) {
    super(message);
  }
}

function getJsonOnce(url: string): Promise<unknown> {
  return new Promise((resolveJson, reject) => {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'sentient-observer fetch-hf' };
    if (HF_TOKEN.length > 0) headers.authorization = `Bearer ${HF_TOKEN}`;
    httpsGet(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          const retryAfter = Number(response.headers['retry-after']);
          reject(new HttpError(status, `HTTP ${status}${body.startsWith('<') ? '' : `: ${body.slice(0, 120)}`}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null));
          return;
        }
        try {
          resolveJson(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/**
 * PACING. The datasets-server rate-limits per client over a window it does
 * not disclose, and its 429s usually carry no Retry-After. So a 429 is never
 * a bad page — it is the server saying "slower": we wait (30 s, then doubling
 * to 5 min), and we lengthen the pause between pages for the rest of the
 * run (`pagePauseMs`, halved back slowly after a stretch of clean pages).
 * Only a 5xx / network failure that keeps failing skips a page.
 */
let pagePauseMs = HF_TOKEN.length > 0 ? 400 : 1200;
const MIN_PAGE_PAUSE_MS = HF_TOKEN.length > 0 ? 400 : 1200;
const MAX_PAGE_PAUSE_MS = 8000;
const RATE_LIMIT_WAITS_MS = [30_000, 60_000, 120_000, 240_000, 300_000];
let cleanPages = 0;

/** GET with backoff. 429: wait Retry-After or the rate-limit ladder, and
 *  slow the whole run down — as many times as it takes. 5xx / network:
 *  back off 2, 4, 8, 16, 32 s, then give up on this page. A 4xx other than
 *  429 is final (the id or config is wrong). */
async function getJson(url: string, retries = RETRIES): Promise<unknown> {
  let lastError: unknown = null;
  let rateLimited = 0;
  for (let attempt = 0; attempt < retries; ) {
    try {
      return await getJsonOnce(url);
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError && error.status === 429) {
        if (rateLimited >= RATE_LIMIT_WAITS_MS.length * 2) throw error; // ~30 min of pure 429s: something else is wrong
        const wait = error.retryAfterMs !== null ? Math.min(error.retryAfterMs, 300_000) : RATE_LIMIT_WAITS_MS[Math.min(rateLimited, RATE_LIMIT_WAITS_MS.length - 1)];
        rateLimited += 1;
        cleanPages = 0;
        pagePauseMs = Math.min(MAX_PAGE_PAUSE_MS, pagePauseMs * 2);
        console.log(`  HTTP 429 (rate limit) — waiting ${(wait / 1000).toFixed(0)} s, then ${(pagePauseMs / 1000).toFixed(1)} s between pages`);
        await sleep(wait);
        continue; // a 429 does not use up a retry
      }
      if (error instanceof HttpError && error.status >= 400 && error.status < 500) throw error;
      attempt += 1;
      if (attempt < retries) {
        const wait = 2000 * 2 ** (attempt - 1);
        console.log(`  ${(error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 60)} — waiting ${(wait / 1000).toFixed(0)} s (retry ${attempt}/${retries - 1})`);
        await sleep(wait);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** After a page succeeds: a long clean stretch earns a slightly faster pace. */
function pageSucceeded(): void {
  cleanPages += 1;
  if (cleanPages >= 40 && pagePauseMs > MIN_PAGE_PAUSE_MS) {
    pagePauseMs = Math.max(MIN_PAGE_PAUSE_MS, Math.floor(pagePauseMs / 2));
    cleanPages = 0;
  }
}

/**
 * RESUME. Each source remembers the next offset to read in
 * corpus/.fetch-hf.cursors.json, so re-running the same command continues
 * where the last run stopped instead of re-reading (and re-appending) from
 * zero. `--offset N` overrides it, `--fresh` resets it. Output lines already
 * present in the file are not appended twice either.
 */
function cursorPath(): string {
  return resolve(CORPUS, '.fetch-hf.cursors.json');
}
function readCursors(): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(cursorPath(), 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
  } catch {
    return {};
  }
}
function writeCursor(source: string, next: number): void {
  const cursors = readCursors();
  cursors[source] = next;
  writeFileSync(cursorPath(), `${JSON.stringify(cursors, null, 2)}\n`);
}

type Candidate = { dataset: string; config: string; split: string };

/** The Hub's current id for a dataset (renamed repos redirect; the API
 *  answers with the new id). Null when the Hub does not know it. */
async function currentDatasetId(dataset: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'sentient-observer fetch-hf' };
    if (HF_TOKEN.length > 0) headers.authorization = `Bearer ${HF_TOKEN}`;
    const response = await fetch(`https://huggingface.co/api/datasets/${dataset}`, { headers, redirect: 'follow' });
    if (!response.ok) return null;
    const info = (await response.json()) as { id?: unknown };
    return typeof info.id === 'string' && info.id.length > 0 ? info.id : null;
  } catch {
    return null;
  }
}

/** The configs and splits the datasets-server has for a dataset, for the
 *  error message — so the operator can pass --config / --split. */
async function describeSplits(dataset: string): Promise<string> {
  try {
    const url = `https://datasets-server.huggingface.co/splits?dataset=${encodeURIComponent(dataset)}`;
    const answer = (await getJson(url, 1)) as { splits?: Array<{ config?: string; split?: string }> };
    const pairs = (answer.splits ?? []).map((s) => `${s.config ?? '?'}/${s.split ?? '?'}`);
    return pairs.length === 0 ? 'no configs/splits served' : `configs/splits served: ${pairs.slice(0, 12).join(', ')}${pairs.length > 12 ? ', …' : ''}`;
  } catch (error) {
    return `/splits: ${(error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 100)}`;
  }
}

async function probe(candidate: Candidate): Promise<{ total: number } | HttpError | Error> {
  try {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(candidate.dataset)}&config=${encodeURIComponent(candidate.config)}&split=${encodeURIComponent(candidate.split)}&offset=0&length=1`;
    const answer = (await getJson(url)) as { num_rows_total?: number };
    return { total: typeof answer.num_rows_total === 'number' ? answer.num_rows_total : Number.MAX_SAFE_INTEGER };
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function pickCandidate(spec: SourceSpec): Promise<Candidate & { total: number }> {
  const candidates: Candidate[] =
    DATASET_OVERRIDE.length > 0
      ? [{ dataset: DATASET_OVERRIDE, config: CONFIG_OVERRIDE || 'default', split: SPLIT_OVERRIDE || 'train' }]
      : spec.candidates.map((c) => ({ ...c, config: CONFIG_OVERRIDE || c.config, split: SPLIT_OVERRIDE || c.split }));
  let last: Candidate | null = null;
  for (const candidate of candidates) {
    last = candidate;
    let result = await probe(candidate);
    if (!(result instanceof Error)) return { ...candidate, total: result.total };
    // A 404 is usually a rename or a loading-script dataset the server dropped:
    // ask the Hub where the id went and try once more under the current name.
    if (result instanceof HttpError && result.status === 404) {
      const current = await currentDatasetId(candidate.dataset);
      if (current !== null && current !== candidate.dataset) {
        console.log(`  ${candidate.dataset}: renamed on the Hub → ${current}`);
        const renamed = { ...candidate, dataset: current };
        last = renamed;
        result = await probe(renamed);
        if (!(result instanceof Error)) return { ...renamed, total: result.total };
      }
    }
    console.log(`  ${last.dataset} (${last.config}/${last.split}): ${result.message.split('\n')[0].slice(0, 100)} — trying the next id`);
  }
  const hint = last === null ? '' : `\n  ${last.dataset}: ${await describeSplits(last.dataset)}`;
  throw new Error(
    `no reachable dataset id for ${SOURCE}.${hint}\n  Open https://huggingface.co/datasets?search=${encodeURIComponent(SOURCE)} in a browser, pick a parquet copy, and pass it:\n    npm run fetch-hf -- ${SOURCE} --dataset owner/name [--config default] [--split train]`
  );
}

async function main(): Promise<void> {
  const spec = SPECS[SOURCE];
  if (spec === undefined) {
    console.log('usage: npm run fetch-hf -- <dailydialog|tinystories|simplewiki|svamp|asdiv> [--rows N] [--offset N] [--corpus DIR] [--fresh] [--dataset owner/name [--config c] [--split s]]');
    process.exit(1);
  }
  const rows = Number(arg('--rows', String(spec.defaultRows)));
  const out = resolve(CORPUS, spec.out);
  mkdirSync(dirname(out), { recursive: true });
  if (FRESH) {
    writeFileSync(out, '');
    writeCursor(SOURCE, 0);
  }
  console.log(HF_TOKEN.length > 0 ? 'HF_TOKEN found in the environment (higher rate limits)' : 'no HF_TOKEN — anonymous rate limits; put HF_TOKEN=hf_… in apps/web/.env');
  const picked = await pickCandidate(spec);
  // Where to start: --offset wins, then the saved cursor, then 0. `--rows` is
  // the number of SOURCE rows this run reads from that start.
  // Lines already in the output file are never appended twice — a re-run over
  // the same rows, or a mirror that repeats an item, adds nothing.
  const present = new Set<string>(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter((line) => line.length > 0) : []);
  let saved = readCursors()[SOURCE] ?? 0;
  if (saved > 0 && present.size === 0) {
    // A cursor with nothing to show for it means the last run kept nothing
    // (wrong row shape, wrong mirror): start over rather than skip the rows.
    console.log(`  the saved cursor (${saved}) kept nothing last time — starting over at 0`);
    saved = 0;
  }
  const start = process.argv.includes('--offset') ? OFFSET : saved;
  const limit = Math.min(start + rows, picked.total);
  console.log(`=== fetch-hf ${SOURCE} — ${picked.dataset} (${picked.config}/${picked.split}), rows ${start}–${limit} of ${picked.total} → ${out} (${present.size} items already there${saved > 0 && start === saved ? `, resuming at the saved cursor ${saved}` : ''}) ===`);
  if (start >= limit) {
    console.log('nothing to read: the saved cursor is at or past the end; pass --offset 0 to start over or --fresh to truncate.');
    return;
  }
  const started = Date.now();
  let read = 0;
  let kept = 0;
  let duplicates = 0;
  const skippedPages: number[] = [];
  for (let offset = start; offset < limit; offset += PAGE) {
    const length = Math.min(PAGE, limit - offset);
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(picked.dataset)}&config=${encodeURIComponent(picked.config)}&split=${encodeURIComponent(picked.split)}&offset=${offset}&length=${length}`;
    type Page = { rows?: Array<{ row?: Record<string, unknown> }> };
    let page: Page | null = null;
    // getJson waits out rate limits and retries server errors; a page that
    // still fails is skipped and reported — one bad gateway must not end a run.
    try {
      page = (await getJson(url)) as Page;
    } catch (error) {
      console.log(`  page at ${offset} skipped: ${(error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 80)}`);
    }
    await sleep(pagePauseMs);
    if (page === null) {
      skippedPages.push(offset);
      writeCursor(SOURCE, offset + length);
      continue;
    }
    pageSucceeded();
    const fetched: Page = page;
    const lines: string[] = [];
    for (const entry of fetched.rows ?? []) {
      read += 1;
      if (entry.row === undefined) continue;
      for (const line of spec.convert(entry.row)) {
        if (present.has(line)) {
          duplicates += 1;
          continue;
        }
        present.add(line);
        lines.push(line);
      }
    }
    if (lines.length > 0) appendFileSync(out, `${lines.join('\n')}\n`);
    kept += lines.length;
    writeCursor(SOURCE, offset + length);
    if (offset === start && read > 0 && kept === 0 && (fetched.rows?.[0]?.row) !== undefined) {
      console.log(`  first page kept nothing — row columns: ${Object.keys(fetched.rows![0].row!).join(', ')}`);
    }
    if (((offset - start) / PAGE) % 20 === 19) {
      console.log(`  … ${read} rows read, ${kept} items kept${duplicates > 0 ? `, ${duplicates} already present` : ''} (${((Date.now() - started) / 1000).toFixed(0)} s, ${(pagePauseMs / 1000).toFixed(1)} s/page)`);
    }
  }
  const tail = (spec.flush?.() ?? []).filter((line) => !present.has(line));
  if (tail.length > 0) {
    appendFileSync(out, `${tail.join('\n')}\n`);
    kept += tail.length;
  }
  console.log(`done: ${read} rows read, ${kept} items kept${duplicates > 0 ? `, ${duplicates} already present` : ''} in ${((Date.now() - started) / 1000).toFixed(0)} s → ${out} (cursor now ${limit}; re-run the same command to continue)`);
  if (skippedPages.length > 0) {
    console.log(`skipped ${skippedPages.length} page(s) that kept failing (offsets ${skippedPages.slice(0, 10).join(', ')}${skippedPages.length > 10 ? ', …' : ''}); re-run with --offset N --rows 100 to retry one.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
