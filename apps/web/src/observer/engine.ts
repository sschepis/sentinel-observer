import {
  SemanticObserver,
  type SemanticObserverOptions,
  type SemanticObserverState,
  type ObserverSignal,
  type StimulusResult,
  type MemoryTrace,
  type RecallResult
} from '@sschepis/sentient-core';

export type ObserverStatus = 'idle' | 'loading' | 'ready' | 'degraded' | 'error';

export interface ObserverSessionState {
  status: ObserverStatus;
  error: string | null;
  metrics: SemanticObserverState | null;
  kernelLoaded: boolean;
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

  observeAttention(focus: 'reading' | 'review' | 'quiz' | 'idle', intensity: number): StimulusResult {
    return this.observer.observe({ kind: 'attention', focus, intensity });
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
   * committing what it was just taught to long-term memory.
   */
  storeMemory(content: string): MemoryTrace | null {
    return this.observer.storeMemory(content);
  }

  /**
   * The observer answers: recall memory from a cue. Returns ranked traces
   * with similarity scores — the top result is what the observer "says".
   */
  recall(cue: string, topK = 5): RecallResult[] {
    return this.observer.recallMemory(cue, topK);
  }

  setNoise(level: number): StimulusResult {
    return this.observer.observe({ kind: 'noise', level });
  }

  /** Subscribe to the observer's signal stream; returns an unsubscribe fn. */
  onSignal(listener: (signal: ObserverSignal) => void): () => void {
    return this.observer.getSignals().subscribe('*', listener);
  }

  signalHistory(): readonly ObserverSignal[] {
    return this.observer.getSignals().history();
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
