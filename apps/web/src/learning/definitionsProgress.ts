/**
 * THE DEFINITIONS BACKFILL'S PROGRESS SHAPE, at a leaf.
 *
 * The run happens on the server (`server/definitionsRunner.ts`) and is
 * rendered by a component, so both sides need to name the same shape. It
 * used to live in the component, which meant `ServerSession` — a process
 * with no DOM — imported a React module to describe its own state. Erased
 * at compile time, and still the wrong direction: a shape two sides share
 * belongs to neither of them.
 */

export interface ChaperoneProgressState {
  phase: 'running' | 'done';
  /** Batches completed. */
  batchIndex: number;
  totalBatches: number;
  wordsDone: number;
  wordsTotal: number;
  generated: number;
  skipped: number;
  errors: number;
  /** Most recent failed request, shown immediately rather than only at completion. */
  lastError: { batch: number; words: string[]; message: string } | null;
  /** Words the model is currently being asked about. */
  currentWords: string[];
  startedAt: number;
  elapsedMs: number;
  /** The newest generated definitions, newest first (a live feed). */
  feed: Array<{ word: string; definition: string }>;
}
