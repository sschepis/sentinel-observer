import { useCallback, useEffect, useRef, useState } from 'react';
import type { SemanticObserverState, ObserverSignal, StimulusResult, SemanticObserverOptions } from '@sschepis/sentient-core';
import { ObserverSession, type ObserverSessionState } from './engine';
import type { PersistenceStore } from '../persistence/store';

/**
 * Ambient priming stimulus.
 *
 * A freshly initialized observer has an unexcited oscillator field, which is
 * HONESTLY all zeros — but a silent, dead dashboard is useless. Priming is a
 * real input (a starter text excitation), exactly like a resting baseline.
 * The values shown afterwards are the real physics of that excitation.
 */
const PRIMING_TEXT = 'coherence, resonance, consciousness, structure, harmony, wisdom, truth, love';

const MAX_RECENT_SIGNALS = 40;
/** Non-metric signals are the observer's DURABLE events (memory, insight,
 * drift) — kept separately so the metric flood from the tick loop can never
 * evict them from the diary. */
const MAX_DIARY_SIGNALS = 200;

/**
 * React binding for an ObserverSession.
 *
 * Explicit degradation contract (inherited from the core): the status machine
 * distinguishes ready / degraded / error — the UI must render the degraded
 * banner whenever `status === 'degraded'`, and must never fabricate metrics.
 */
export function useObserver(
  persistence: PersistenceStore | null = null,
  observerOptions: SemanticObserverOptions = {}
): ObserverSessionState & {
  session: ObserverSession | null;
  start: () => Promise<void>;
  stop: () => void;
  lastStimulus: StimulusResult | null;
  signals: ObserverSignal[];
  diarySignals: ObserverSignal[];
} {
  const sessionRef = useRef<ObserverSession | null>(null);
  const [status, setStatus] = useState<ObserverSessionState['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<SemanticObserverState | null>(null);
  const [lastStimulus, setLastStimulus] = useState<StimulusResult | null>(null);
  const [signals, setSignals] = useState<ObserverSignal[]>([]);
  const [diarySignals, setDiarySignals] = useState<ObserverSignal[]>([]);

  const stop = useCallback(() => {
    sessionRef.current?.stop();
  }, []);

  const start = useCallback(async () => {
    if (sessionRef.current === null) {
      sessionRef.current = new ObserverSession(observerOptions, 250);
    }
    const session = sessionRef.current;
    setStatus('loading');
    setError(null);
    setSignals([]);
    setDiarySignals([]);
    try {
      await session.initialize();
      // Prime the field with a real stimulus so the dashboard is alive from
      // the first tick, then let decay physics do its work.
      const priming = session.observeText(PRIMING_TEXT);
      setLastStimulus(priming);
      const initial = session.state();
      setMetrics(initial);
      setStatus(initial.kernel.degraded ? 'degraded' : 'ready');

      session.onSignal((signal) => {
        setSignals((prev) => [...prev.slice(-(MAX_RECENT_SIGNALS - 1)), signal]);
        if (signal.kind !== 'metric') {
          setDiarySignals((prev) => [...prev.slice(-(MAX_DIARY_SIGNALS - 1)), signal]);
          if (persistence !== null) {
            void persistence.appendDiary([signal]).catch(() => {
              // Persistence failure must never break the observer loop.
            });
          }
        }
      });

      session.start((next) => setMetrics(next));

      // Restore the observer's diary from previous sessions (new signals
      // append AFTER the restored entries, preserving order). A failed load
      // degrades to an empty diary — never an unhandled rejection.
      if (persistence !== null) {
        void persistence.loadDiary().then(
          (entries) => {
            if (entries.length > 0) {
              setDiarySignals((prev) => {
                const merged = [...entries, ...prev];
                return merged.slice(-MAX_DIARY_SIGNALS);
              });
            }
          },
          (reason) => {
            console.warn('diary restore failed — starting with an empty diary', reason);
          }
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, []);

  useEffect(() => () => sessionRef.current?.dispose(), []);

  return {
    session: sessionRef.current,
    status,
    error,
    metrics,
    kernelLoaded: metrics?.kernel.loaded ?? false,
    start,
    stop,
    lastStimulus,
    signals,
    diarySignals
  };
}
