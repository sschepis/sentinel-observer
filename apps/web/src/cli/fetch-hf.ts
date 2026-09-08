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
 * fallback list of dataset ids because Hub ids move. `--rows N` bounds the
 * SOURCE rows read (default: all of DailyDialog; 20,000 for the two prose
 * corpora); `--offset N` starts there (resume). A page that fails is retried
 * with backoff and then SKIPPED (reported at the end), never fatal. Output is
 * appended row-by-row, so a run that stops early leaves a usable file;
 * `--fresh` truncates first.
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

interface SourceSpec {
  candidates: Array<{ dataset: string; config: string; split: string }>;
  defaultRows: number;
  out: string;
  convert: (row: Record<string, unknown>) => string[];
}

const SPECS: Record<string, SourceSpec> = {
  dailydialog: {
    candidates: [
      { dataset: 'li2017dailydialog/daily_dialog', config: 'default', split: 'train' },
      { dataset: 'daily_dialog', config: 'default', split: 'train' }
    ],
    defaultRows: 20000,
    out: 'dialogue.jsonl',
    convert: (row) => {
      const turns = Array.isArray(row.dialog) ? row.dialog.filter((t): t is string => typeof t === 'string') : [];
      return pairsFromDialogue(turns, 'dailydialog').map((pair) => JSON.stringify(pair));
    }
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

/** GET with backoff: a 429 waits what Retry-After says (or the backoff),
 *  a 5xx / network error backs off (2, 4, 8, 16, 32 s); a 4xx other than
 *  429 is final (the id or config is wrong). */
async function getJson(url: string, retries = RETRIES): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await getJsonOnce(url);
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 429) throw error;
      const wait = error instanceof HttpError && error.retryAfterMs !== null ? Math.min(error.retryAfterMs, 120_000) : 2000 * 2 ** attempt;
      if (attempt + 1 < retries) {
        console.log(`  ${(error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 60)} — waiting ${(wait / 1000).toFixed(0)} s (retry ${attempt + 1}/${retries - 1})`);
        await new Promise((resolveWait) => setTimeout(resolveWait, wait));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Pause between pages so a long run stays under the API's rate limit. */
const PAGE_PAUSE_MS = HF_TOKEN.length > 0 ? 150 : 600;

async function pickCandidate(spec: SourceSpec): Promise<{ dataset: string; config: string; split: string; total: number }> {
  for (const candidate of spec.candidates) {
    try {
      const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(candidate.dataset)}&config=${encodeURIComponent(candidate.config)}&split=${candidate.split}&offset=0&length=1`;
      const probe = (await getJson(url)) as { num_rows_total?: number };
      return { ...candidate, total: typeof probe.num_rows_total === 'number' ? probe.num_rows_total : Number.MAX_SAFE_INTEGER };
    } catch (error) {
      console.log(`  ${candidate.dataset}: ${error instanceof Error ? error.message : String(error)} — trying the next id`);
    }
  }
  throw new Error(`no reachable dataset id for ${SOURCE}`);
}

async function main(): Promise<void> {
  const spec = SPECS[SOURCE];
  if (spec === undefined) {
    console.log('usage: npm run fetch-hf -- <dailydialog|tinystories|simplewiki|svamp|asdiv> [--rows N] [--corpus DIR] [--fresh]');
    process.exit(1);
  }
  const rows = Number(arg('--rows', String(spec.defaultRows)));
  const out = resolve(CORPUS, spec.out);
  mkdirSync(dirname(out), { recursive: true });
  if (FRESH) writeFileSync(out, '');
  console.log(HF_TOKEN.length > 0 ? 'HF_TOKEN found in the environment (higher rate limits)' : 'no HF_TOKEN — anonymous rate limits; put HF_TOKEN=hf_… in apps/web/.env');
  const picked = await pickCandidate(spec);
  const limit = Math.min(rows, picked.total);
  console.log(`=== fetch-hf ${SOURCE} — ${picked.dataset} (${picked.config}/${picked.split}), ${limit} of ${picked.total} rows → ${out} ===`);
  const started = Date.now();
  let read = 0;
  let kept = 0;
  const skippedPages: number[] = [];
  for (let offset = OFFSET; offset < limit; offset += PAGE) {
    const length = Math.min(PAGE, limit - offset);
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(picked.dataset)}&config=${encodeURIComponent(picked.config)}&split=${picked.split}&offset=${offset}&length=${length}`;
    type Page = { rows?: Array<{ row?: Record<string, unknown> }> };
    let page: Page | null = null;
    // getJson retries with backoff and honors Retry-After; a page that still
    // fails is skipped and reported — one bad gateway must not end a run.
    try {
      page = (await getJson(url)) as Page;
    } catch (error) {
      console.log(`  page at ${offset} skipped: ${(error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 80)}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, PAGE_PAUSE_MS));
    if (page === null) {
      skippedPages.push(offset);
      continue;
    }
    const fetched: Page = page;
    const lines: string[] = [];
    for (const entry of fetched.rows ?? []) {
      read += 1;
      if (entry.row !== undefined) lines.push(...spec.convert(entry.row));
    }
    if (lines.length > 0) appendFileSync(out, `${lines.join('\n')}\n`);
    kept += lines.length;
    if ((offset / PAGE) % 20 === 19) {
      console.log(`  … ${read} rows read, ${kept} items kept (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    }
  }
  console.log(`done: ${read} rows read, ${kept} items kept in ${((Date.now() - started) / 1000).toFixed(0)} s → ${out}`);
  if (skippedPages.length > 0) {
    console.log(`skipped ${skippedPages.length} page(s) that kept failing (offsets ${skippedPages.slice(0, 10).join(', ')}${skippedPages.length > 10 ? ', …' : ''}); re-run with --offset N to retry one.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
