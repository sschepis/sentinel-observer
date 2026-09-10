import { useCallback, useEffect, useRef, useState } from 'react';
import type { ObserverSignal, SemanticObserverState } from '@sschepis/sentient-core';
import { RemoteClient, type RemoteServerState } from './client';

/** A bounded live feed of the server's classroom events (what the training
 *  loop is doing RIGHT NOW — the Training tab's heartbeat). */
export interface RemoteLearningEvent {
  /** WHEN THIS EVENT HAPPENED — not when its batch arrived. The batch time
   *  used to be stamped onto every retained line on every arrival, so all 80
   *  rows showed the same clock reading and the feed looked like it had all
   *  happened at once. */
  at: number;
  kind: string;
  text: string;
  label?: string;
  /** Second line, when the event carries one (a definition's example). */
  detail?: string | null;
  /** 0..1 when the event carries a grade. */
  score?: number | null;
}

/**
 * React binding for the observer server.
 *
 * The observer lives on the server; this hook subscribes to its SSE stream
 * (metrics every tick, signals, saves, lifecycle) and exposes the same shape
 * the local `useObserver` exposes where it makes sense — status, metrics,
 * signals — plus the server's own state (restored counts, save bookkeeping).
 */
export interface RemoteObserverState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  metrics: SemanticObserverState | null;
  signals: ObserverSignal[];
  learningEvents: RemoteLearningEvent[];
  server: RemoteServerState | null;
  /** When the state line was last read successfully (null before the first
   *  read) — the UI marks the strip stale rather than showing an old
   *  reading as a live one. */
  stateAt: number | null;
  client: RemoteClient;
  connect: () => void;
  disconnect: () => void;
  refresh: () => Promise<void>;
}

const MAX_SIGNALS = 40;

export function useRemoteObserver(url: string): RemoteObserverState {
  const clientRef = useRef<RemoteClient | null>(null);
  if (clientRef.current === null) clientRef.current = new RemoteClient(url);
  const client = clientRef.current;

  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<SemanticObserverState | null>(null);
  const [signals, setSignals] = useState<ObserverSignal[]>([]);
  const [learningEvents, setLearningEvents] = useState<RemoteLearningEvent[]>([]);
  const [server, setServer] = useState<RemoteServerState | null>(null);
  /** When the state line was last read SUCCESSFULLY — the UI shows numbers
   *  as stale rather than presenting an old reading as a live one. */
  const [stateAt, setStateAt] = useState<number | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  /** When the last stream event arrived, for the liveness watchdog. */
  const lastEventRef = useRef<number>(Date.now());
  /** The freshest server state, readable from the watchdog without making
   *  it depend on a re-render. */
  const serverRef = useRef<RemoteServerState | null>(null);

  const refresh = useCallback(async () => {
    try {
      const state = await client.state();
      setServer(state);
      serverRef.current = state;
      setStateAt(Date.now());
      // A SUCCESSFUL READ CLEARS THE FAILURE. Without this the hook stayed
      // in `error` after the server came back, and every number on the
      // model-state strip froze at whatever it last read (see the polling
      // effect below).
      setError(null);
      // THE SERVER'S OWN STATUS DECIDES. It answers on the port while it is
      // still reading the record back (a minute at 400 MB), and 'loading'
      // must not be reported to the UI as 'ready' — an empty strip labelled
      // ready is the same lie as a frozen one labelled live.
      setStatus(state.status === 'error' ? 'error' : state.status === 'ready' ? 'ready' : 'loading');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus('error');
    }
  }, [client]);

  const connect = useCallback(() => {
    setStatus('loading');
    setError(null);
    unsubscribeRef.current?.();
    unsubscribeRef.current = client.connect(
      (event) => {
        lastEventRef.current = Date.now();
        if (event.kind === 'metrics') {
          setMetrics(event.state);
          return;
        }
        if (event.kind === 'learning') {
          // Map the ARRIVING events only, and keep each one's own timestamp
          // (the batch time is the fallback for a server that does not send
          // one). Re-mapping the retained array is what rewrote every row's
          // clock on every batch.
          const arriving: RemoteLearningEvent[] = event.events.map((item) => ({
            at: item.at ?? event.at,
            kind: item.kind,
            text: item.text,
            label: item.label,
            detail: item.detail ?? null,
            score: item.score ?? null
          }));
          setLearningEvents((prev) => [...arriving, ...prev].slice(0, 80));
          return;
        }
        if (event.kind === 'signal') {
          setSignals((prev) => [...prev.slice(-(MAX_SIGNALS - 1)), event.signal]);
          return;
        }
        if (event.kind === 'state') {
          void refresh();
          return;
        }
        // snapshot / lifecycle: the server's bookkeeping changed.
        void refresh();
      },
      () => {
        // The EventSource retries on its own; surface the state honestly.
        setStatus('error');
        setError('connection to the observer server lost — retrying');
        void refresh().catch(() => {});
      }
    );
    void refresh();
  }, [client, refresh]);

  // THE POLL MUST OUTLIVE A FAILURE. The state line (field, vocabulary,
  // drives, knowledge entropy) must not depend on a server event arriving,
  // so it is polled every few seconds — and the poll runs whenever the hook
  // is connected AT ALL, not only while it is healthy.
  //
  // It used to be gated on `status === 'ready'`, which made a single failed
  // read permanent: the dev server restarts on every source edit, one GET
  // failed, status went to `error`, the interval was torn down, and nothing
  // was left to notice the server had come back. Every number on the strip
  // then sat frozen at its last reading while the app looked awake — which
  // is the one thing this project must never do with a number.
  useEffect(() => {
    if (status === 'idle') return;
    const id = setInterval(() => {
      void refresh();
    }, 4000);
    return () => clearInterval(id);
  }, [status, refresh]);

  // A STREAM THAT HAS GONE QUIET IS A DEAD STREAM. The server sends a
  // comment keepalive every 15 s, which does not fire an event listener, so
  // silence here means only that no real event arrived — harmless while the
  // field sleeps. But when the server says it is ticking or training and
  // nothing has arrived for half a minute, the EventSource is half-open (a
  // laptop that slept, a restarted server the browser never re-reached):
  // rebuild it rather than waiting for a retry that is not coming.
  useEffect(() => {
    if (status === 'idle') return;
    const id = setInterval(() => {
      const expectingEvents = serverRef.current?.running === true || serverRef.current?.trainingRunning === true;
      if (!expectingEvents) return;
      if (Date.now() - lastEventRef.current < 30_000) return;
      lastEventRef.current = Date.now();
      connect();
    }, 10_000);
    return () => clearInterval(id);
  }, [status, connect]);

  const disconnect = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    client.disconnect();
    setStatus('idle');
  }, [client]);

  useEffect(() => () => disconnect(), [disconnect]);

  return { status, error, metrics, signals, learningEvents, server, stateAt, client, connect, disconnect, refresh };
}
