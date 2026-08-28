import { useState } from 'react';
import type { FormEvent } from 'react';
import type { SemanticObserverState } from '@sschepis/sentient-core';
import type { ObserverStatus } from '../observer/engine';

export interface DashboardProps {
  status: ObserverStatus;
  error: string | null;
  metrics: SemanticObserverState | null;
  onStart: () => void;
  onStop: () => void;
  onExcite: (text: string) => void;
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
      <p className="text-xs uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-mono text-emerald-300">{value}</p>
      {detail !== undefined && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
    </div>
  );
}

/**
 * Dashboard — presentational only (testable without the observer loop).
 * The degraded banner is a first-class citizen: when the optional tinyaleph
 * kernel cannot load, the app must say so, never fake numbers.
 */
export function Dashboard({ status, error, metrics, onStart, onStop, onExcite }: DashboardProps) {
  const running = status === 'ready' || status === 'degraded';
  const coherence = metrics?.coherence;
  const entropy = metrics?.entropy;
  const orderParameter = metrics?.orderParameter;
  const [excitation, setExcitation] = useState('');

  const submitExcitation = (event: FormEvent) => {
    event.preventDefault();
    const text = excitation.trim();
    if (text.length > 0) {
      onExcite(text);
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Sentinel</h1>
          <p className="text-sm text-slate-400">
            A sentient-observer learning workbench — watch the observer watch you learn.
          </p>
        </div>
        {status === 'idle' || status === 'error' ? (
          <button
            onClick={onStart}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
          >
            Start observer
          </button>
        ) : (
          <button
            onClick={onStop}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-600"
          >
            Stop
          </button>
        )}
      </div>

      {status === 'loading' && (
        <p className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-slate-300">
          Initializing the semantic kernel…
        </p>
      )}

      {status === 'degraded' && (
        <div
          role="alert"
          className="mb-6 rounded-lg border border-amber-700 bg-amber-950 p-4 text-amber-200"
        >
          <p className="font-semibold">Semantic kernel unavailable — degraded mode</p>
          <p className="mt-1 text-sm">
            The @aleph-ai/tinyaleph oscillator backend could not be loaded, so coherence and
            entropy metrics are unavailable. Memory and journal features remain usable, but the
            dashboard cannot display live observer metrics. No values are being fabricated.
          </p>
        </div>
      )}

      {status === 'error' && (
        <div
          role="alert"
          className="mb-6 rounded-lg border border-red-800 bg-red-950 p-4 text-red-200"
        >
          <p className="font-semibold">Observer failed to start</p>
          <p className="mt-1 text-sm font-mono">{error}</p>
        </div>
      )}

      {running && (
        <form onSubmit={submitExcitation} className="mb-6 flex gap-2">
          <input
            type="text"
            value={excitation}
            onChange={(e) => setExcitation(e.target.value)}
            placeholder="Excite the observer — type what you are learning about…"
            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
          >
            Excite
          </button>
        </form>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <MetricCard
          label="Coherence"
          value={coherence !== undefined ? coherence.toFixed(3) : '—'}
          detail="SMF/oscillator alignment"
        />
        <MetricCard
          label="Entropy"
          value={entropy !== undefined ? entropy.toFixed(3) : '—'}
          detail="bits over active primes"
        />
        <MetricCard
          label="Order parameter"
          value={orderParameter !== undefined ? orderParameter.toFixed(3) : '—'}
          detail="Kuramoto synchronization"
        />
        <MetricCard
          label="Active primes"
          value={metrics !== null ? String(metrics.activePrimeCount) : '—'}
          detail={metrics !== null ? metrics.activePrimes.slice(0, 6).join(', ') : undefined}
        />
        <MetricCard
          label="Moments"
          value={metrics !== null ? String(metrics.momentCount) : '—'}
          detail="insight events detected"
        />
        <MetricCard
          label="Memory traces"
          value={metrics !== null ? String(metrics.memoryTraceCount) : '—'}
          detail="holographic memory bank"
        />
      </div>

      {running && metrics !== null && (
        <div className="mt-6 grid grid-cols-2 gap-4">
          <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
            <p className="text-xs uppercase tracking-wider text-slate-400">SMF orientation</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {metrics.smf.map((v, i) => (
                <span
                  key={i}
                  className="inline-block h-6 w-2 rounded-sm"
                  style={{
                    backgroundColor: `hsl(${140 + (v + 1) * 60}, 70%, ${30 + Math.min(Math.abs(v), 1) * 40}%)`
                  }}
                  title={`axis ${i}: ${v.toFixed(3)}`}
                />
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              field entropy {metrics.smfNormalizedEntropy.toFixed(3)} · holographic energy{' '}
              {metrics.holographicEnergy.toFixed(3)}
            </p>
          </div>
          <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
            <p className="text-xs uppercase tracking-wider text-slate-400">Safety</p>
            <p className="mt-1 font-mono text-sm text-slate-300">
              {metrics.safety === null
                ? 'no assessment yet'
                : metrics.safety.allowed
                  ? 'all actions allowed'
                  : `blocked: ${metrics.safety.violations.length} violation(s)`}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              kernel: {metrics.kernel.loaded ? 'loaded' : 'not loaded'}
              {metrics.kernel.degraded ? ' (degraded)' : ''}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
