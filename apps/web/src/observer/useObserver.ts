import { useCallback, useEffect, useRef, useState } from 'react';
import type { SemanticObserverState } from '@sschepis/sentient-core';
import { ObserverSession, type ObserverSessionState } from './engine';

/**
 * Ambient priming stimulus.
 *
 * A freshly initialized observer has an unexcited oscillator field, which is
 * HONESTLY all zeros — but a silent, dead dashboard is useless. Priming is a
 * real input (a starter text excitation), exactly like a resting baseline.
 * The values shown afterwards are the real physics of that excitation.
 */
const PRIMING_TEXT = 'coherence, resonance, consciousness, structure, harmony, wisdom, truth, love';

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
  excite: (text: string) => void;
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
      // Prime the field with a real stimulus so the dashboard is alive from
      // the first tick, then let decay physics do its work.
      session.processInput(PRIMING_TEXT);
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

  const excite = useCallback((text: string) => {
    const session = sessionRef.current;
    if (session === null || (status !== 'ready' && status !== 'degraded')) return;
    session.processInput(text);
    setMetrics(session.state());
  }, [status]);

  return {
    status,
    error,
    metrics,
    kernelLoaded: metrics?.kernel.loaded ?? false,
    start,
    stop,
    excite
  };
}
