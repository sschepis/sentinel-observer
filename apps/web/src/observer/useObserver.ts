import { useCallback, useEffect, useRef, useState } from 'react';
import type { SemanticObserverState } from '@sschepis/sentient-core';
import { ObserverSession, type ObserverSessionState } from './engine';

/**
 * React binding for an ObserverSession.
 *
 * Explicit degradation contract (inherited from the core): the status machine
 * distinguishes ready / degraded / error — the UI must render the degraded
 * banner whenever `status === 'degraded'`, and must never fabricate metrics.
 */
export function useObserver(): ObserverSessionState & {
  start: () => Promise<void>;
  stop: () => void;
  processInput: (text: string) => void;
} {
  const sessionRef = useRef<ObserverSession | null>(null);
  const [status, setStatus] = useState<ObserverSessionState['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<SemanticObserverState | null>(null);

  const stop = useCallback(() => {
    sessionRef.current?.stop();
  }, []);

  const start = useCallback(async () => {
    if (sessionRef.current === null) {
      sessionRef.current = new ObserverSession({}, 250);
    }
    const session = sessionRef.current;
    setStatus('loading');
    setError(null);
    try {
      await session.initialize();
      const initial = session.state();
      setMetrics(initial);
      setStatus(initial.kernel.degraded ? 'degraded' : 'ready');
      session.start(
        (next) => setMetrics(next),
        (momentId) => {
          // Insight moments surface in the journal (M1); for M0 we track the
          // count via the tick state and leave the event for the UI layer.
          void momentId;
        }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, []);

  useEffect(() => () => stop(), [stop]);

  const processInput = useCallback((text: string) => {
    sessionRef.current?.processInput(text);
  }, []);

  return {
    status,
    error,
    metrics,
    kernelLoaded: metrics?.kernel.loaded ?? false,
    start,
    stop,
    processInput
  };
}
