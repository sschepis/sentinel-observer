/**
 * Run the observer server AND the web dev UI together — the app is a pure
 * client, so development needs both processes:
 *   npm run dev:all
 * (equivalent: `npm run server` in one terminal, `npm run dev` in another.)
 *
 * ENVIRONMENT. The server reads apps/web/.env at boot (see .env.example) —
 * the chaperone endpoint/model, and the READOUT switches the current design
 * runs under: OBSERVER_SMF_WEIGHT=0 (index-only memory scoring, the arm the
 * null-model benchmark chose) with OBSERVER_GATES_FILE pointing at the gates
 * refitted for that arm, and OBSERVER_CORPUS for the classroom's corpus. This
 * launcher loads the same file first so the summary below shows exactly what
 * the server will run with, and warns when the readout is not the intended
 * one — an explicit variable in the shell still wins over the file.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The server's own .env loader, mirrored: KEY=VALUE lines, `#` comments; the shell wins. */
function loadEnvFile(path) {
  if (!existsSync(path)) return false;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key.length > 0 && process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

const envPath = join(webDir, '.env');
const hadEnv = loadEnvFile(envPath);
const env = process.env;
const smf = env.OBSERVER_SMF_WEIGHT;
const gates = env.OBSERVER_GATES_FILE ?? '';
const corpus = env.OBSERVER_CORPUS ?? (existsSync(join(webDir, 'corpus')) ? 'corpus (default)' : '');
const store = env.OBSERVER_STORE ?? 'json (default)';
const model = env.OBSERVER_CHAPERONE_MODEL ?? '';
const warnings = [];
if (!hadEnv) warnings.push(`no ${envPath} — copy .env.example to .env and fill it in`);
if (smf === undefined) warnings.push('OBSERVER_SMF_WEIGHT is unset — the server will score memories with the SMF term the null arms retired; the intended readout is OBSERVER_SMF_WEIGHT=0');
if (gates.length === 0) warnings.push('OBSERVER_GATES_FILE is unset — the server will run on the hand constants, not the gates refitted for its readout arm');
else if (!existsSync(resolve(webDir, gates))) warnings.push(`OBSERVER_GATES_FILE not found: ${resolve(webDir, gates)}`);
if (model.length === 0) warnings.push('OBSERVER_CHAPERONE_MODEL is unset — no LLM chaperone (gaps, exchanges and creative grades stay unanswered)');
if (corpus.length === 0) warnings.push('no corpus — the classroom has nothing to ingest (npm run fetch-conceptnet / fetch-hf)');

console.log(
  `[dev:all] readout: smf-weight=${smf ?? 'unset (SMF on)'} · coupling=${env.OBSERVER_COUPLING ?? 'default'} · gates=${gates || 'hand constants'} · ` +
    `corpus=${corpus || 'none'} · store=${store} · data=${env.OBSERVER_DATA ?? './data (default)'} · chaperone=${model || 'none'}${env.OBSERVER_RESEARCH_TOPICS === '1' ? ' (+research)' : ''}`
);
for (const warning of warnings) console.warn(`[dev:all] WARNING: ${warning}`);

const children = [
  spawn('npm', ['run', 'server'], { cwd: webDir, stdio: 'inherit', env: process.env }),
  spawn('npm', ['run', 'dev'], { cwd: webDir, stdio: 'inherit', env: process.env })
];

const shutdown = () => {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
};

for (const child of children) {
  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[dev:all] a process exited with code ${String(code)} — shutting the other down`);
      shutdown();
      process.exit(code ?? 1);
    }
  });
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});
