/**
 * The server-side definitions backfill runner.
 *
 * The ONLY definitions fill in the system (the browser's copy is gone in
 * Phase C). Runs the chaperone over the observer's definition-less words,
 * applies each batch to the singular teacher, writes it to the server's
 * persistence store AS IT ARRIVES (a long run must survive a server
 * restart the same way it used to survive a tab close), then runs the
 * relations second pass over the newly defined words.
 */
import { TeacherAgent } from '../teacher/TeacherAgent';
import {
  Chaperone,
  NullChaperoneProvider,
  OpenAICompatProvider,
  type ChaperoneBatchResult,
  type ChaperoneSettings
} from '../teacher/chaperone';
import { MAX_CONCURRENCY } from '../teacher/chaperone';
import type { ChaperoneProgressState } from '../components/ChaperoneProgress';
import { makeEvent, type LearningEvent } from '../learning/events';
import type { PersistenceStore } from '../persistence/store';

const BATCH_SIZE = 8;

export class DefinitionsRunner {
  private controller: AbortController | null = null;
  private state: { progress: ChaperoneProgressState | null; result: string | null } = {
    progress: null,
    result: null
  };
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly teacher: TeacherAgent,
    private readonly store: PersistenceStore,
    private readonly settings: ChaperoneSettings,
    private readonly onEvents: (events: readonly LearningEvent[]) => void
  ) {}

  get running(): boolean {
    return this.controller !== null;
  }

  progress(): ChaperoneProgressState | null {
    return this.state.progress;
  }

  result(): string | null {
    return this.state.result;
  }

  /** Begin a fill over the words still missing definitions; false when no
   *  words need it or a run is already active. Never throws. */
  start(): boolean {
    if (this.controller !== null) return false;
    const target = this.teacher.listWords().filter((entry) => entry.word.definition.trim().length === 0);
    if (target.length === 0) return false;

    const provider =
      this.settings.endpoint.trim().length > 0 ? new OpenAICompatProvider(this.settings) : new NullChaperoneProvider();
    const chaperone = new Chaperone(provider);
    const controller = new AbortController();
    this.controller = controller;

    const batchSize = BATCH_SIZE;
    const totalBatches = Math.ceil(target.length / batchSize);
    const startedAt = Date.now();
    const feed: Array<{ word: string; definition: string }> = [];
    let writes: Promise<void> = Promise.resolve();

    this.state = {
      progress: {
        phase: 'running',
        batchIndex: 0,
        totalBatches,
        wordsDone: 0,
        wordsTotal: target.length,
        generated: 0,
        skipped: 0,
        errors: 0,
        lastError: null,
        currentWords: [],
        startedAt,
        elapsedMs: 0,
        feed: []
      },
      result: null
    };
    this.heartbeat = setInterval(() => {
      const progress = this.state.progress;
      if (progress !== null && progress.phase === 'running') {
        progress.elapsedMs = Date.now() - startedAt;
      }
    }, 1000);

    void (async () => {
      try {
        const run = await chaperone.fillDefinitions(
          target.map((entry) => entry.word),
          {
            batchSize,
            concurrency: MAX_CONCURRENCY,
            signal: controller.signal,
            onBatchStart: (words) => {
              const progress = this.state.progress;
              if (progress !== null && progress.phase === 'running') {
                progress.currentWords = words;
                progress.elapsedMs = Date.now() - startedAt;
              }
            },
            onBatch: (done: number, _total: number, batch: ChaperoneBatchResult) => {
              for (const entry of batch.definitions) {
                feed.unshift({ word: entry.word, definition: entry.definition });
              }
              if (batch.definitions.length > 0) {
                this.teacher.applyDefinitions(batch.definitions);
                const saved = [...batch.definitions];
                writes = writes.then(() =>
                  this.store.saveDefinitions(saved).catch((reason: unknown) => {
                    this.onEvents([
                      makeEvent({
                        kind: 'error',
                        label: 'definitions',
                        text: `could not save ${saved.length} definitions: ${reason instanceof Error ? reason.message : String(reason)}`
                      })
                    ]);
                  })
                );
              }
              this.onEvents(
                batch.definitions.map((entry) =>
                  makeEvent({
                    kind: 'definition',
                    label: entry.word,
                    text: entry.definition,
                    detail: entry.example ?? null
                  })
                )
              );
              const progress = this.state.progress;
              if (progress !== null && progress.phase === 'running') {
                progress.batchIndex += 1;
                progress.wordsDone = done;
                progress.generated += batch.definitions.length;
                progress.skipped += batch.skipped.length;
                progress.currentWords = [];
                progress.elapsedMs = Date.now() - startedAt;
                progress.feed = [...feed].slice(0, 20);
              }
            },
            onBatchError: (done: number, _total: number, words: string[], reason: string) => {
              this.onEvents([makeEvent({ kind: 'error', label: 'definitions', text: `${words.join(', ')} — ${reason}` })]);
              const progress = this.state.progress;
              if (progress !== null && progress.phase === 'running') {
                progress.batchIndex += 1;
                progress.wordsDone = done;
                progress.errors += 1;
                progress.lastError = { batch: Math.ceil(done / batchSize), words, message: reason };
                progress.currentWords = [];
                progress.elapsedMs = Date.now() - startedAt;
              }
            }
          }
        );

        if (run.definitions.length > 0) {
          this.teacher.applyDefinitions(run.definitions);
          writes = writes.then(() => this.store.saveDefinitions(run.definitions));
        }
        await writes;

        const aborted = controller.signal.aborted;
        let relationSummary: string | null = null;
        if (!aborted && run.definitions.length > 0) {
          try {
            const relationWords = target
              .filter((entry) => run.definitions.some((d) => d.word === entry.word.word))
              .map((entry) => entry.word);
            const relationsRun = await chaperone.fillRelations(relationWords, {
              batchSize: 8,
              concurrency: MAX_CONCURRENCY,
              signal: controller.signal
            });
            const relationApply = this.teacher.applyRelations(relationsRun.relations);
            if (relationApply.accepted > 0 || relationApply.conflicts > 0) {
              relationSummary =
                `${relationApply.accepted} relation edges learned` +
                (relationApply.conflicts > 0 ? `, ${relationApply.conflicts} conflicts flagged for verification` : '');
            }
          } catch (error) {
            this.onEvents([
              makeEvent({
                kind: 'error',
                label: 'relations',
                text: `relations pass failed: ${error instanceof Error ? error.message : String(error)}`
              })
            ]);
          }
        }

        const progress = this.state.progress;
        if (progress !== null && progress.phase === 'running') {
          progress.phase = 'done';
          progress.currentWords = [];
          progress.elapsedMs = Date.now() - startedAt;
          progress.feed = [...feed].slice(0, 20);
          progress.wordsDone = aborted ? progress.wordsDone : target.length;
        }
        this.state.result = aborted
          ? `stopped early — ${run.definitions.length} definitions kept from this run`
          : `generated ${run.definitions.length} definitions${run.skipped.length > 0 ? `, skipped ${run.skipped.length}` : ''}${run.errors.length > 0 ? `, ${run.errors.length} failed batches` : ''}${relationSummary !== null ? ` · ${relationSummary}` : ''}`;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        const progress = this.state.progress;
        if (progress !== null && progress.phase === 'running') {
          progress.phase = 'done';
          progress.currentWords = [];
        }
        this.state.result = `definition run could not finish: ${message}`;
      } finally {
        await writes.catch(() => {});
        if (this.heartbeat !== null) clearInterval(this.heartbeat);
        this.heartbeat = null;
        if (this.controller === controller) this.controller = null;
      }
    })();
    return true;
  }

  cancel(): void {
    this.controller?.abort();
  }
}
