/**
 * grader-check — can the teacher model tell a good answer from a bad one?
 *
 *   cd apps/web && npm run grader-check
 *   GRADER_PROBES=20 npm run grader-check
 *
 * Reads the chaperone settings exactly as the server does (.env, then
 * OBSERVER_CHAPERONE_ENDPOINT / _KEY / _MODEL), grades known-good and
 * known-bad answers drawn from the AUTHORED conversation deck (correct by
 * construction — ground truth from outside the loop), and prints the two
 * score distributions with the verdict the server's training loop would
 * record (teacher/graderCheck.ts). No observer is booted and nothing is
 * written: this is a read of the grader alone.
 *
 * Exit code 0 = trusted, 2 = untrusted, 3 = inconclusive, 1 = no endpoint.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mulberry32 } from '@sschepis/sentient-core';
import { OpenAICompatProvider, semanticGrader } from '../teacher/chaperone';
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation';
import { checkGrader, describeGraderCheck, graderProbesFrom } from '../teacher/graderCheck';

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

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};

const settings = {
  endpoint: process.env.OBSERVER_CHAPERONE_ENDPOINT ?? arg('--chaperone-endpoint', ''),
  apiKey: process.env.OBSERVER_CHAPERONE_KEY ?? arg('--chaperone-key', ''),
  model: process.env.OBSERVER_CHAPERONE_MODEL ?? arg('--chaperone-model', '')
};
const PROBES = Math.max(4, Number(process.env.GRADER_PROBES ?? arg('--probes', '12')));
const SEED = Number(process.env.GRADER_SEED ?? arg('--seed', '7'));

function histogram(scores: readonly number[]): string {
  const bins = new Array<number>(10).fill(0);
  for (const score of scores) bins[Math.min(9, Math.max(0, Math.floor(score * 10)))] += 1;
  return bins.map((count, i) => `${(i / 10).toFixed(1)}:${count}`).join('  ');
}

async function main(): Promise<void> {
  if (settings.endpoint.trim().length === 0) {
    console.log('grader-check: no chaperone endpoint configured (.env OBSERVER_CHAPERONE_ENDPOINT or --chaperone-endpoint)');
    process.exit(1);
  }
  const provider = new OpenAICompatProvider(settings);
  const grader = semanticGrader(provider);
  if (grader === null) {
    console.log('grader-check: the provider does not support structured output — it cannot grade');
    process.exit(1);
  }
  const probes = graderProbesFrom(ALL_CONVERSATION_PAIRS, PROBES, mulberry32(SEED));
  console.log(`=== grader-check — model "${grader.name}", ${probes.length} probes from the authored conversation deck (seed ${SEED}) ===`);
  console.log('each probe: the cue with its own response (known good) and another pair\'s response (known bad); 2 grader calls per probe…');
  const started = Date.now();
  const check = await checkGrader(grader, probes);
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log('');
  console.log(`known-good scores  (n=${check.good.length}): ${histogram(check.good)}`);
  console.log(`known-bad scores   (n=${check.bad.length}): ${histogram(check.bad)}`);
  console.log(`grader failures (null / threw): ${check.failures}`);
  console.log(`reinforce gate: ${check.reinforceGate.toFixed(2)} — known-good answers reaching it: ${check.goodPass === null ? '—' : `${(check.goodPass * 100).toFixed(0)}%`}`);
  console.log('');
  console.log(describeGraderCheck(check));
  console.log('');
  if (check.trusted === false) {
    console.log('What this means: every creative grade this model has given is noise. The server now records such grades');
    console.log('without applying them (no reinforcement, weakening, drive outcome or gap), so the compose drive weight');
    console.log('will drift back toward its archetype. To get real feedback, point OBSERVER_CHAPERONE_MODEL at an');
    console.log('instruction-tuned model that returns the JSON grade schema, then re-run this check.');
  }
  process.exit(check.trusted === null ? 3 : check.trusted ? 0 : 2);
}

void main();
