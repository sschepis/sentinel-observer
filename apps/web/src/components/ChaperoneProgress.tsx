/**
 * The Chaperone run display: live progress, elapsed time, ETA, batch
 * activity, and a feed of freshly generated definitions — so the schoolroom
 * visibly works while the model is generating, instead of a frozen button.
 * Presentational only: every value arrives via props.
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

export interface ChaperoneProgressProps {
  progress: ChaperoneProgressState | null;
  /** Final summary shown once the run completes. */
  result: string | null;
  onCancel: () => void;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function ChaperoneProgress({ progress, result, onCancel }: ChaperoneProgressProps) {
  if (progress === null) {
    return result !== null ? <p className="mt-2 text-xs text-slate-400">{result}</p> : null;
  }

  const elapsed = progress.elapsedMs;
  const percent = progress.wordsTotal > 0 ? Math.round((progress.wordsDone / progress.wordsTotal) * 100) : 0;
  const etaMs =
    progress.batchIndex > 0
      ? (elapsed / progress.batchIndex) * Math.max(0, progress.totalBatches - progress.batchIndex)
      : null;

  return (
    <div className="mt-3 rounded-lg border border-slate-700 bg-slate-950 p-3">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>
          {progress.phase === 'running' ? (
            <>
              <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-violet-400 align-middle" />
              generating batch {progress.batchIndex + 1}/{progress.totalBatches}
            </>
          ) : (
            'run complete'
          )}
        </span>
        <span>
          {progress.wordsDone}/{progress.wordsTotal} words · {progress.generated} generated · {progress.skipped} skipped ·{' '}
          {progress.errors} failed batches
        </span>
      </div>

      <div className="mt-2 h-2 w-full overflow-hidden rounded bg-slate-800">
        <div className="h-full rounded bg-violet-500 transition-all" style={{ width: `${percent}%` }} />
      </div>

      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
        <span>
          elapsed {formatDuration(elapsed)}
          {etaMs !== null ? ` · ETA ${formatDuration(etaMs)}` : ''}
        </span>
        {progress.phase === 'running' && (
          <button onClick={onCancel} className="rounded bg-slate-800 px-2 py-0.5 text-slate-300 hover:bg-slate-700">
            Cancel
          </button>
        )}
      </div>

      {progress.phase === 'running' && progress.currentWords.length > 0 && (
        <p className="mt-2 text-xs text-slate-400">
          asking the model about:{' '}
          <span className="font-mono text-slate-200">{progress.currentWords.slice(0, 8).join(', ')}</span>
        </p>
      )}

      {progress.lastError !== null && (
        <div role="alert" className="mt-2 rounded border border-red-900 bg-red-950/50 p-2 text-xs text-red-200">
          <p>
            Batch {progress.lastError.batch} failed for{' '}
            <span className="font-mono">{progress.lastError.words.join(', ')}</span>.
          </p>
          <p className="mt-1 break-words font-mono text-red-300">{progress.lastError.message}</p>
        </div>
      )}

      {progress.feed.length > 0 && (
        <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto border-t border-slate-800 pt-2 font-mono text-xs">
          {progress.feed.map((entry, index) => (
            <li key={`${entry.word}-${index}`} className="text-slate-300">
              <span className="text-emerald-400">✓</span> {entry.word} — {entry.definition}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
