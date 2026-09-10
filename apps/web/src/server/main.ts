#!/usr/bin/env node
/**
 * OBSERVER SERVER — the observer lives on the server, not in the browser.
 *
 * A long-lived process running the full ObserverSession + TeacherAgent:
 * it keeps ticking while no page is connected, saves its learning record to
 * disk on a timer and on shutdown, and restores the trained model on boot —
 * reloading the page (or restarting the server) reloads the model that has
 * been training, never a fresh one.
 *
 * The browser connects to the JSON + SSE API (see server/http.ts) instead of
 * running its own observer.
 *
 * Usage:
 *   npm run server --workspace @sschepis/sentinel-web
 *   npm run server -- --port 8787 --data ./data --bootstrap public/bootstrap.json
 *
 * Flags / env:
 *   --port N              HTTP port (default 8787, env OBSERVER_PORT)
 *   --data DIR            data directory (default ./data, env OBSERVER_DATA)
 *   --bootstrap PATH      bootstrap record to import when the disk is empty
 *                         (default public/bootstrap.json when it exists)
 *   --words N             fresh-train fallback: deck words (default 200; 0 = none)
 *   --no-conversation     skip the conversation deck in the fresh fallback
 *   --autosave-ms N       save period (default 30000)
 *   --seed N              composition PRNG seed (default 0 = Math.random)
 *   --chaperone-endpoint URL  LLM endpoint for the chaperone (training's
 *                         LLM steps + grading; env OBSERVER_CHAPERONE_ENDPOINT)
 *   --chaperone-key KEY   LLM API key (env OBSERVER_CHAPERONE_KEY)
 *   --chaperone-model M   model name (env OBSERVER_CHAPERONE_MODEL)
 *   --research-topics     each cycle also researches the subjects of the
 *                         observer's unanswered gaps through the chaperone
 *                         (env OBSERVER_RESEARCH_TOPICS=1)
 *   --no-train            boot with the training loop stopped
 *   --store sqlite|json   working store (default json; sqlite migrates the
 *                         legacy JSON files once — recommended)
 *   --corpus DIR          corpus directory of JSONL sources the classroom
 *                         ingests under its budget (src/curriculum; env
 *                         OBSERVER_CORPUS; default ./corpus when it exists)
 *
 * Readout / gate switches (docs/NULL_ARMS.md, TASKS.md #10–12; env only,
 * deliberate operator actions, never defaults):
 *   OBSERVER_SMF_WEIGHT=0   score memories by prime-signature overlap alone
 *                           (index-only readout; stored traces untouched)
 *   OBSERVER_COUPLING=0     Kuramoto coupling off
 *   OBSERVER_GATES_FILE=p   apply the calibrated gates artifact written by
 *                           `npm run refit-gates` (bench/calibration/*.json)
 *                           at boot — the fitted recall floor and
 *                           high-confidence bar for the selected readout arm
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServerSession } from './ServerSession';
import { startHttpServer } from './http';
import { applyCalibratedGates, CALIBRATED_GATE_SCORES, type CalibratedGatesArtifact } from '../teacher/calibration';

/**
 * Minimal .env loader (zero dependencies): KEY=VALUE lines, `#` comments.
 * Explicit shell env vars and CLI flags always win over the file. The file
 * holds the server's chaperone configuration (see .env.example) — the
 * endpoint and model of the LLM the observer trains through.
 */
function loadEnvFile(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  try {
    for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key.length > 0 && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // A broken .env is a convenience failure, never a boot failure.
  }
}
loadEnvFile();

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};

const PORT = Number(process.env.OBSERVER_PORT ?? arg('--port', '8787'));
const DATA_DIR = resolve(process.env.OBSERVER_DATA ?? arg('--data', './data'));
const SHIPPED_BOOTSTRAP = new URL('../../public/bootstrap.json', import.meta.url).pathname;
const BOOTSTRAP_FLAG = process.env.OBSERVER_BOOTSTRAP ?? arg('--bootstrap', '');
const BOOTSTRAP = BOOTSTRAP_FLAG.length > 0 ? resolve(BOOTSTRAP_FLAG) : SHIPPED_BOOTSTRAP;
const WORDS = Number(process.env.OBSERVER_WORDS ?? arg('--words', '200'));
const CONVERSATION = !process.argv.includes('--no-conversation');
// 30 s was the default until 2026-09-10, when the record reached 400 MB and
// a single save measured 60 s of blocked event loop: the process spent more
// time writing itself out than learning. The duty-cycle budget in
// ServerSession is the real guard; this is just a sane floor.
const AUTOSAVE_MS = Number(process.env.OBSERVER_AUTOSAVE_MS ?? arg('--autosave-ms', '120000'));
const SEED = Number(process.env.OBSERVER_SEED ?? arg('--seed', '0'));
const CHAPERONE_ENDPOINT = process.env.OBSERVER_CHAPERONE_ENDPOINT ?? arg('--chaperone-endpoint', '');
const CHAPERONE_KEY = process.env.OBSERVER_CHAPERONE_KEY ?? arg('--chaperone-key', '');
const CHAPERONE_MODEL = process.env.OBSERVER_CHAPERONE_MODEL ?? arg('--chaperone-model', '');
const RESEARCH_TOPICS = process.env.OBSERVER_RESEARCH_TOPICS === '1' || process.argv.includes('--research-topics');
const TRAIN = !process.argv.includes('--no-train');
const STORE = process.env.OBSERVER_STORE ?? arg('--store', 'json');
const CORPUS_FLAG = process.env.OBSERVER_CORPUS ?? arg('--corpus', '');
const CORPUS = CORPUS_FLAG.length > 0 ? resolve(CORPUS_FLAG) : existsSync(resolve('./corpus')) ? resolve('./corpus') : '';

/** Corpus feed cadence and slice. The measured defaults live in
 *  trainingLoop.ts; these let an operator slow the feed down (a busy
 *  machine) or speed it up (a fresh corpus to get through) without editing
 *  code. A non-numeric or non-positive value is ignored. */
const positive = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
};
const CURRICULUM_EVERY = positive(process.env.OBSERVER_CURRICULUM_EVERY);
const CURRICULUM_BUDGET = positive(process.env.OBSERVER_CURRICULUM_BUDGET);

const GATES_FILE = process.env.OBSERVER_GATES_FILE ?? '';

/** Apply the calibrated gates artifact BEFORE the observer boots, so every
 *  gate read during restore and the first turns already sees the fitted
 *  scores. A missing or malformed file is a hard error: an operator who
 *  asked for calibrated gates must not silently run on the hand constants. */
function applyGatesFile(path: string): void {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`OBSERVER_GATES_FILE not found: ${resolved}`);
  const artifact = JSON.parse(readFileSync(resolved, 'utf8')) as CalibratedGatesArtifact;
  if (artifact === null || typeof artifact !== 'object' || typeof artifact.gates !== 'object') {
    throw new Error(`OBSERVER_GATES_FILE is not a calibrated gates artifact: ${resolved}`);
  }
  const armEnv = process.env.OBSERVER_SMF_WEIGHT !== undefined && Number(process.env.OBSERVER_SMF_WEIGHT) === 0 ? 'smf-off' : 'control';
  if (typeof artifact.arm === 'string' && artifact.arm !== armEnv) {
    // The gates were fitted under one readout arm; running them under another
    // is exactly the miscalibration the artifact exists to prevent.
    throw new Error(`OBSERVER_GATES_FILE was fitted under arm "${artifact.arm}" but the readout arm is "${armEnv}" (set OBSERVER_SMF_WEIGHT accordingly, or refit)`);
  }
  const applied = applyCalibratedGates(artifact);
  // eslint-disable-next-line no-console
  console.log(
    `[observer-server] calibrated gates from ${resolved} (arm ${artifact.arm ?? 'unspecified'}, commit ${artifact.commit ?? '?'}): ` +
      applied.map((gate) => `${gate}=${CALIBRATED_GATE_SCORES[gate]?.toFixed(3) ?? 'constant'}`).join(', ')
  );
}

async function main(): Promise<void> {
  if (!Number.isFinite(PORT) || PORT <= 0) throw new Error(`invalid port: ${process.env.OBSERVER_PORT ?? arg('--port', '8787')}`);
  if (GATES_FILE.length > 0) applyGatesFile(GATES_FILE);

  const server = new ServerSession({
    dataDir: DATA_DIR,
    bootstrapPath: existsSync(BOOTSTRAP) ? BOOTSTRAP : '',
    words: WORDS,
    conversation: CONVERSATION,
    autosaveMs: AUTOSAVE_MS,
    compositionSeed: SEED,
    train: TRAIN,
    store: STORE === 'sqlite' ? 'sqlite' : 'json',
    researchTopics: RESEARCH_TOPICS,
    corpusDir: CORPUS.length > 0 ? CORPUS : undefined,
    curriculumEvery: CURRICULUM_EVERY,
    curriculumBudget: CURRICULUM_BUDGET,
    chaperone: CHAPERONE_ENDPOINT.length > 0 ? { endpoint: CHAPERONE_ENDPOINT, apiKey: CHAPERONE_KEY, model: CHAPERONE_MODEL } : undefined
  });

  const state = await server.boot();
  // eslint-disable-next-line no-console
  console.log(
    `[observer-server] booted — ${state.learned}/${state.total} words · competency ${(state.competency * 100).toFixed(1)}% · ` +
      `restored ${state.restored} traces${state.freshTrained ? ' (fresh core trained)' : ''} · data ${DATA_DIR} · store ${STORE}` +
      ` · readout ${process.env.OBSERVER_SMF_WEIGHT !== undefined && Number(process.env.OBSERVER_SMF_WEIGHT) === 0 ? 'smf-off (index-only)' : 'control (SMF term on)'}` +
      (GATES_FILE.length > 0 ? ' · calibrated gates' : ' · hand-constant gates') +
      (CORPUS.length > 0 ? ` · corpus ${CORPUS}` : ' · no corpus') +
      (CORPUS.length > 0 ? ` (feed ${CURRICULUM_BUDGET ?? 1000} rows every ${CURRICULUM_EVERY ?? 5} cycles)` : '')
  );

  const http = startHttpServer(server, PORT);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[observer-server] ${signal} — saving the trained model…`);
    void server.shutdown().then(() => {
      http.close(() => process.exit(0));
      // Force-exit if sockets refuse to drain.
      setTimeout(() => process.exit(0), 3000).unref();
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[observer-server] boot failed', error);
  process.exit(1);
});
