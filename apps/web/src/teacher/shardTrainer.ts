/**
 * SHARD TRAINER — parallel deck-shard training over a persistent worker pool.
 *
 * The scale bench established the path: train disjoint deck shards in
 * parallel observers over a SHARED vocabulary (the invariant that makes
 * traces merge-compatible), concatenate the exports into one record, and
 * restore into a single observer. This module is the production form: the
 * worker pool is created once and kept alive across shards (no per-shard
 * cold start), which is what turned the measured 2.4–3.1× into near-linear
 * wall-clock scaling.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import type { BootstrapRecord } from './bootstrap';
import type { DeckWord } from './deck';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function workerSource(): string {
  return `
import { parentPort } from 'node:worker_threads';
import { ObserverSession } from '${SRC_ROOT}/observer/engine.ts';
import { OBSERVER_OPTIONS } from '${SRC_ROOT}/observer/options.ts';
import { TeacherAgent } from '${SRC_ROOT}/teacher/TeacherAgent.ts';
import { MemoryPersistenceStore } from '${SRC_ROOT}/persistence/store.ts';

async function trainDeck(deck) {
  const session = new ObserverSession(OBSERVER_OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, deck, new MemoryPersistenceStore(), 500);
  for (const entry of deck) teacher.teach(entry.word);
  const record = teacher.exportBootstrap('scale-shard');
  session.dispose();
  return record;
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'exit') {
    process.exit(0);
  }
  if (msg.type === 'train') {
    try {
      const record = await trainDeck(msg.deck);
      parentPort.postMessage({ type: 'record', id: msg.id, record });
    } catch (error) {
      parentPort.postMessage({ type: 'error', id: msg.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
});
`.trim();
}

/**
 * Concatenate shard records into a single bootstrap record with the
 * merge-hygiene passes applied — see `mergeRecords.ts` (kept jest-safe so
 * benches can import the merge without the worker-pool machinery).
 */
export { mergeRecords } from './mergeRecords';

/** A persistent pool of shard-training workers. */
export class ShardTrainer {
  private readonly workers: Worker[] = [];
  private readonly bundlePath: string;
  private nextId = 0;

  constructor(private readonly count = 4) {
    const cacheDir = join(SRC_ROOT, 'node_modules', '.cache', 'sentient');
    mkdirSync(cacheDir, { recursive: true });
    this.bundlePath = join(cacheDir, `shard-trainer-${process.pid}.bundle.cjs`);
  }

  private async ensureWorkers(): Promise<void> {
    if (this.workers.length > 0) return;
    const entry = join(SRC_ROOT, 'node_modules', '.cache', 'sentient', `shard-trainer-${process.pid}.ts`);
    writeFileSync(entry, workerSource(), 'utf8');
    try {
      await build({
        entryPoints: [entry],
        outfile: this.bundlePath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        external: ['@sschepis/sentient-core']
      });
    } finally {
      rmSync(entry, { force: true });
    }
    for (let i = 0; i < this.count; i += 1) this.workers.push(new Worker(this.bundlePath));
  }

  /**
   * Train the given deck shards in parallel and return their records in
   * input order. Safe to call repeatedly — the pool persists between calls.
   */
  async train(shards: readonly (readonly DeckWord[])[], onProgress?: (done: number, total: number) => void): Promise<BootstrapRecord[]> {
    await this.ensureWorkers();
    const records = new Array<BootstrapRecord>(shards.length);
    const pending = shards.map((deck, index) => ({ index, deck }));
    let done = 0;
    await Promise.all(
      this.workers.map(async (worker) => {
        // A dead worker (OOM, a throw outside the handler, a bundle that
        // fails to start) never answers its message — without 'error'/'exit'
        // listeners the in-flight promise would hang forever and a throw
        // inside the handler would abort the process. The listeners reject
        // the pending task so train() fails loudly instead.
        let crashed: Error | null = null;
        // Read through a function so TS cannot narrow the closure-assigned
        // variable to `never` between the async task awaits.
        const crashMessage = (): string | null => (crashed === null ? null : crashed.message);
        const onWorkerError = (error: Error): void => {
          crashed ??= new Error(`shard worker crashed: ${error.message}`);
        };
        const onWorkerExit = (code: number): void => {
          crashed ??= new Error(`shard worker exited with code ${code}`);
          const index = this.workers.indexOf(worker);
          if (index >= 0) this.workers.splice(index, 1);
        };
        worker.on('error', onWorkerError);
        worker.on('exit', onWorkerExit);
        const errors: string[] = [];
        try {
          while (pending.length > 0 && crashMessage() === null) {
            const task = pending.shift();
            if (task === undefined) break;
            const id = this.nextId;
            this.nextId += 1;
            const result = await new Promise<{ record?: BootstrapRecord; error?: string }>((resolve, reject) => {
              const onMessage = (msg: { type: string; id?: number; record?: BootstrapRecord; error?: string }): void => {
                if (msg.id !== id) return;
                worker.off('message', onMessage);
                worker.off('error', onTaskError);
                worker.off('exit', onTaskExit);
                resolve({ record: msg.record, error: msg.error });
              };
              const onTaskError = (error: Error): void => {
                worker.off('message', onMessage);
                reject(new Error(`shard worker crashed: ${error.message}`));
              };
              const onTaskExit = (code: number): void => {
                worker.off('message', onMessage);
                reject(new Error(`shard worker exited with code ${code}`));
              };
              worker.on('message', onMessage);
              worker.on('error', onTaskError);
              worker.on('exit', onTaskExit);
              worker.postMessage({ type: 'train', id, deck: task.deck });
            });
            const failure = crashMessage();
            if (failure !== null) {
              errors.push(failure);
              break;
            }
            if (result.error !== undefined) {
              errors.push(result.error);
              break;
            }
            if (result.record === undefined) {
              errors.push('worker returned no record');
              break;
            }
            records[task.index] = result.record;
            done += 1;
            onProgress?.(done, shards.length);
          }
        } finally {
          worker.off('error', onWorkerError);
          worker.off('exit', onWorkerExit);
        }
        if (errors.length > 0) throw new Error(`shard training failed: ${errors.join('; ')}`);
      })
    );
    return records;
  }

  /**
   * Stop the pool. Returns a promise the caller can await so the process can
   * exit cleanly instead of leaving worker threads behind.
   */
  async dispose(): Promise<void> {
    const workers = [...this.workers];
    this.workers.length = 0;
    for (const worker of workers) {
      try {
        worker.postMessage({ type: 'exit' });
      } catch {
        // Worker already dead — nothing left to stop.
      }
    }
    // terminate() is the guarantee: a worker stuck inside a train handler
    // never answers 'exit', and dispose() must not hang on it.
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)));
    rmSync(this.bundlePath, { force: true });
  }
}