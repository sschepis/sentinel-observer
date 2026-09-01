import { useCallback, useEffect, useRef, useState } from 'react';
import type { ObserverSignal, SemanticObserverState } from '@sschepis/sentient-core';
import { RemoteClient, type RemoteServerState } from './client';

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
  server: RemoteServerState | null;
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
  const [server, setServer] = useState<RemoteServerState | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    try {
      const state = await client.state();
      setServer(state);
      setStatus(state.status === 'error' ? 'error' : 'ready');
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
        if (event.kind === 'metrics') {
          setMetrics(event.state);
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

  const disconnect = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    client.disconnect();
    setStatus('idle');
  }, [client]);

  useEffect(() => () => disconnect(), [disconnect]);

  return { status, error, metrics, signals, server, client, connect, disconnect, refresh };
}
