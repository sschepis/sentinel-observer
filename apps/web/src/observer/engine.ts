import {
  SemanticObserver,
  type SemanticObserverOptions,
  type SemanticObserverState
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
 * it to wall-clock time. A throwing subscriber can never kill the loop — the
 * core's IsolatedSubject pattern guarantees that.
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

  get isDegraded(): boolean {
    return this.observer.getState === undefined ? false : this.safeState()?.kernel.degraded ?? false;
  }

  start(onTick: (state: SemanticObserverState) => void, onMoment?: (id: string) => void): void {
    if (this.timer !== null) return;
    if (onMoment) {
      this.observer.moments.subscribe((moment) => onMoment(moment.id));
    }
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

  processInput(text: string): void {
    this.observer.processInput(text);
  }

  private safeState(): SemanticObserverState | null {
    try {
      return this.observer.getState();
    } catch {
      return null;
    }
  }
}
