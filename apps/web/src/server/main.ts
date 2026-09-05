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
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServerSession } from './ServerSession';
import { startHttpServer } from './http';

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
const AUTOSAVE_MS = Number(process.env.OBSERVER_AUTOSAVE_MS ?? arg('--autosave-ms', '30000'));
const SEED = Number(process.env.OBSERVER_SEED ?? arg('--seed', '0'));
const CHAPERONE_ENDPOINT = process.env.OBSERVER_CHAPERONE_ENDPOINT ?? arg('--chaperone-endpoint', '');
const CHAPERONE_KEY = process.env.OBSERVER_CHAPERONE_KEY ?? arg('--chaperone-key', '');
const CHAPERONE_MODEL = process.env.OBSERVER_CHAPERONE_MODEL ?? arg('--chaperone-model', '');
const RESEARCH_TOPICS = process.env.OBSERVER_RESEARCH_TOPICS === '1' || process.argv.includes('--research-topics');
const TRAIN = !process.argv.includes('--no-train');

async function main(): Promise<void> {
  if (!Number.isFinite(PORT) || PORT <= 0) throw new Error(`invalid port: ${process.env.OBSERVER_PORT ?? arg('--port', '8787')}`);

  const server = new ServerSession({
    dataDir: DATA_DIR,
    bootstrapPath: existsSync(BOOTSTRAP) ? BOOTSTRAP : '',
    words: WORDS,
    conversation: CONVERSATION,
    autosaveMs: AUTOSAVE_MS,
    compositionSeed: SEED,
    train: TRAIN,
    researchTopics: RESEARCH_TOPICS,
    chaperone: CHAPERONE_ENDPOINT.length > 0 ? { endpoint: CHAPERONE_ENDPOINT, apiKey: CHAPERONE_KEY, model: CHAPERONE_MODEL } : undefined
  });

  const state = await server.boot();
  // eslint-disable-next-line no-console
  console.log(
    `[observer-server] booted — ${state.learned}/${state.total} words · competency ${(state.competency * 100).toFixed(1)}% · ` +
      `restored ${state.restored} traces${state.freshTrained ? ' (fresh core trained)' : ''} · data ${DATA_DIR}`
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
