import {
  SemanticObserver,
  type SemanticObserverOptions,
  type SemanticObserverState,
  type ObserverSignal,
  type StimulusResult,
  type TraceLike,
  type RecallResult,
  type RecallResultLike
} from '@sschepis/sentient-core';

export type ObserverStatus = 'idle' | 'loading' | 'ready' | 'degraded' | 'error';

export interface ObserverSessionState {
  status: ObserverStatus;
  error: string | null;
  metrics: SemanticObserverState | null;
}

/**
 * Owns a SemanticObserver instance and its tick loop.
 *
 * The observer is a pure engine: this session is the only place that couples
 * it to wall-clock time. All interaction goes through the typed stimulus
 * contract (`observe`), never raw processInput.
 */
export class ObserverSession {
  readonly observer: SemanticObserver;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;

  constructor(
    options: SemanticObserverOptions = {},
    intervalMs = 250
  ) {
    this.observer = new SemanticObserver(options);
    this.intervalMs = intervalMs;
  }

  async initialize(): Promise<void> {
    await this.observer.initialize();
  }

  /** Observe a stimulus; returns its immediate, honest effect. */
  observeText(content: string): StimulusResult {
    return this.observer.observe({ kind: 'text', content, weight: 0.5 });
  }

  /** Settle the field between lessons (see SemanticObserver.settleField). */
  settleField(): void {
    this.observer.settleField();
  }

  observeEvent(
    type: 'quiz.answer' | 'review.completed' | 'note.created' | 'source.ingested',
    outcome: 'success' | 'failure',
    detail?: string
  ): StimulusResult {
    return this.observer.observe({ kind: 'event', type, outcome, detail });
  }

  /**
   * Store the current orientation as a memory trace — the observer's way of
   * committing what it was just taught to long-term memory. `metadata`
   * tags the trace (e.g. `{ kind: 'conversation', cue }`) so recall can
   * distinguish learned words from learned exchanges.
   */
  storeMemory(content: string, options: { metadata?: Record<string, unknown> } = {}): TraceLike | null {
    return this.observer.storeMemory(content, options);
  }

  /**
   * The observer answers: recall memory from a cue. Returns ranked traces
   * with similarity scores — the top result is what the observer "says".
   */
  recall(cue: string, topK = 5): RecallResult[] {
    return this.observer.recallMemory(cue, topK);
  }

  /**
   * INSTRUMENTATION (§2 / improvements.md A.2): the FULL scored candidate
   * list for a cue — `recall` is the decision; this is the distribution the
   * decision was made from, read with NO side effects (no touching, no
   * signals). Empty ([]) when the bank carries no `recallAll` instrumentation.
   */
  recallAll(cue: string): RecallResultLike[] {
    return this.observer.recallAllContent(cue);
  }

  /**
   * INSTRUMENTATION (§2): the prefilter candidate count a recall would score
   * for a cue (the §3.1 figure, ~1,200 at deck scale). 0 without the bank's
   * instrumentation.
   */
  prefilterCandidateCount(cue: string): number {
    return this.observer.prefilterCandidateCount(cue);
  }

  /** Subscribe to the observer's signal stream; returns an unsubscribe fn. */
  onSignal(listener: (signal: ObserverSignal) => void): () => void {
    return this.observer.getSignals().subscribe('*', listener);
  }

  start(onTick: (state: SemanticObserverState) => void): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      try {
        this.observer.tick(this.intervalMs / 1000);
        onTick(this.observer.getState());
      } catch (error) {
        // A tick failure must never kill the session loop; surface it on the
        // next status refresh instead of dropping the interval silently.
        console.error('observer tick failed', error);
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  state(): SemanticObserverState {
    return this.observer.getState();
  }

  dispose(): void {
    this.stop();
    this.observer.dispose();
  }
}
