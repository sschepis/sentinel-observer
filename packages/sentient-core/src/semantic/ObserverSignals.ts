/**
 * Signal stream — the observer's typed output interface.
 *
 * The observer is a pure engine: it emits SIGNALS, never decisions. Each
 * signal carries a `causeId` (the stimulus that produced it) so an
 * interpreter can always answer "why did this happen". Signals without an
 * attributable cause carry `causeId: null` and are marked as ambient.
 *
 * The history is a bounded ring; consumers read it or subscribe live.
 */

import type { Stimulus } from './stimulus';
import type { SMFAxisIndex } from '../common/types';

/** A coherence crossing captured by the moment detector. */
export interface InsightSignalPayload {
  momentId: string;
  axis: string;
  coherence: number;
}

/** Sustained coherence decline, with the axis and window it occurred over. */
export interface DriftSignalPayload {
  axis: string;
  direction: 'down';
  durationMs: number;
  coherenceStart: number;
  coherenceEnd: number;
}

/** Memory lifecycle events. */
export interface MemorySignalPayload {
  event: 'stored' | 'decaying' | 'consolidated';
  traceId: string;
  content: string;
  strength?: number;
}

/** Per-tick physics metrics (subset of the full observer state). */
export interface MetricSignalPayload {
  coherence: number;
  entropy: number;
  orderParameter: number;
  activePrimeCount: number;
  totalAmplitude: number;
  holographicEnergy: number;
}

export type ObserverSignal =
  | { kind: 'metric'; at: number; causeId: string | null; payload: MetricSignalPayload }
  | { kind: 'insight'; at: number; causeId: string | null; payload: InsightSignalPayload }
  | { kind: 'drift'; at: number; causeId: string | null; payload: DriftSignalPayload }
  | { kind: 'memory'; at: number; causeId: string | null; payload: MemorySignalPayload }
  | { kind: 'stimulus'; at: number; causeId: string | null; payload: { stimulusId: string; stimulus: Stimulus } };

export type ObserverSignalKind = ObserverSignal['kind'];

/**
 * Bounded, causally-ordered signal history plus live subscription.
 *
 * Subscribers are isolated: a throwing subscriber can never break emission
 * to the remaining subscribers (the same contract as the core observables).
 */
export class SignalStream {
  private readonly buffer: ObserverSignal[] = [];
  private readonly subscribers = new Map<ObserverSignalKind | '*', Set<(signal: ObserverSignal) => void>>();

  constructor(private readonly capacity = 200) {}

  /** Push a signal; publishes to kind-specific and catch-all subscribers. */
  push(signal: ObserverSignal): void {
    this.buffer.push(signal);
    while (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
    for (const kind of [signal.kind, '*'] as const) {
      const listeners = this.subscribers.get(kind);
      if (!listeners) continue;
      for (const listener of [...listeners]) {
        try {
          listener(signal);
        } catch {
          // Isolated subscriber: one broken consumer cannot break the stream.
        }
      }
    }
  }

  subscribe(kind: ObserverSignalKind | '*', listener: (signal: ObserverSignal) => void): () => void {
    const key = kind;
    let listeners = this.subscribers.get(key);
    if (!listeners) {
      listeners = new Set();
      this.subscribers.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /** Signals so far, oldest first. */
  history(): readonly ObserverSignal[] {
    return [...this.buffer];
  }

  /** Signals of one kind, oldest first, narrowed to that kind's payload. */
  historyOf<K extends ObserverSignalKind>(kind: K): Array<Extract<ObserverSignal, { kind: K }>> {
    return this.buffer.filter((s): s is Extract<ObserverSignal, { kind: K }> => s.kind === kind);
  }

  clear(): void {
    this.buffer.length = 0;
  }
}

/** The 16 SMF axes as stable index keys for axis-scoped signals. */
export type { SMFAxisIndex };
