import { useEffect, useState } from 'react';
import type { SemanticObserverState } from '@sschepis/sentient-core';
import type { ObserverStatus } from '../observer/engine';
import type { RemoteServerState } from '../server/client';

/**
 * THE MODEL-STATE STRIP above every view: one dense row of what the observer
 * on the server is right now. Every number here comes from the server —
 * the browser holds no observer — and every number is labelled for what it
 * actually is, with the tooltip saying where it comes from:
 *
 *   field      the oscillator substrate's live coherence / entropy / order
 *              (from the tick stream, or the last settled state when the
 *              field is asleep) and how many memory traces it holds;
 *   knowledge  the network entropy (docs/SYNTHETIC_MIND.md task 39): how
 *              unsure the observer would be if asked about each concept it
 *              knows, in bits per concept — the number that should fall as
 *              it learns;
 *   vocabulary words with a memory trace / every word it knows (deck + grown);
 *   exchanges  the share of taught conversation exchanges it recalls (the
 *              competency the creative layer unlocks on);
 *   drives     the drive vector, non-perturbing snapshot.
 *
 * A value the server has not sent is shown as "—", never as 0.000. And a
 * value the server sent A WHILE AGO is shown as stale, never as current:
 * the strip carries the age of its own reading, because a frozen number
 * that looks live is the one failure this project cannot tolerate in a
 * readout. (It happened: a single failed poll used to end the polling for
 * good, and the whole strip sat still while the app looked awake.)
 */
export interface ModelStateBarProps {
  status: ObserverStatus;
  /** The server's state line (null while offline). */
  server: RemoteServerState | null;
  /** When that state line was last read successfully. */
  stateAt?: number | null;
  /** The live field metrics from the tick stream (null until one arrives). */
  metrics: SemanticObserverState | null;
  /** True while the autonomous classroom is running. */
  learning: boolean;
}

function Stat({ label, value, tone = 'text-slate-100', title }: { label: string; value: string; tone?: string; title?: string }) {
  return (
    <div className="flex flex-col justify-center px-3.5 py-1.5" title={title}>
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">{label}</span>
      <span className={`font-mono text-sm leading-tight ${tone}`}>{value}</span>
    </div>
  );
}

function Meter({ label, value, tone }: { label: string; value: number | null; tone: string }) {
  return (
    <div className="flex items-center gap-1.5" title={`${label} ${value === null ? '—' : value.toFixed(2)}`}>
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label.slice(0, 4)}</span>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-slate-800">
        <span
          className={`block h-full rounded-full ${value === null ? 'bg-slate-700' : tone} transition-[width] duration-500`}
          style={{ width: value === null ? '0%' : `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
        />
      </span>
    </div>
  );
}

const fixed = (value: number | null | undefined, digits: number): string => (value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits));

/** How old a reading may get before the strip stops calling it current. */
const STALE_AFTER_MS = 12_000;

export function ModelStateBar({ status, server, stateAt = null, metrics, learning }: ModelStateBarProps) {
  // The strip keeps its own clock: when the poll stops, nothing else
  // re-renders it, and a readout that cannot notice its own silence is
  // exactly the problem.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);
  const age = stateAt === null ? null : now - stateAt;
  const stale = server !== null && (age === null || age > STALE_AFTER_MS);
  const ageText = age === null ? 'never read' : age < 90_000 ? `${Math.round(age / 1000)}s ago` : `${Math.round(age / 60_000)} min ago`;

  // The field: the tick stream is freshest; the state line's settled reading
  // is the fallback (and the only source while the field is asleep).
  const field = server?.field ?? null;
  const ticking = field?.ticking ?? server?.running ?? false;
  // A stale tick-stream reading must not outlive the field's sleep — nor
  // the connection that carried it.
  const live = ticking && !stale ? metrics : null;
  const coherence = live?.coherence ?? field?.coherence ?? null;
  const entropy = live?.entropy ?? field?.entropy ?? null;
  const order = live?.orderParameter ?? field?.orderParameter ?? null;
  const traces = live?.memoryTraceCount ?? field?.traces ?? server?.tracesInModel ?? null;
  const knowledge = server?.knowledge ?? null;
  const drives = server?.drives ?? null;
  const learned = server?.learned ?? null;
  const total = server?.total ?? null;
  const progress = learned !== null && total !== null && total > 0 ? learned / total : 0;
  const competency = server?.competency ?? null;
  const creativeUnlocked = server?.creativeUnlocked ?? null;

  const statusTone =
    status === 'ready'
      ? 'bg-emerald-400'
      : status === 'degraded'
        ? 'bg-amber-400'
        : status === 'error'
          ? 'bg-rose-500'
          : status === 'loading'
            ? 'bg-sky-400'
            : 'bg-slate-600';
  const statusText = server === null ? 'offline' : stale ? 'stale' : status === 'idle' || !ticking ? 'asleep' : learning ? 'learning' : status === 'degraded' ? 'degraded' : 'awake';

  return (
    <header
      className={`flex shrink-0 flex-wrap items-stretch gap-x-1 gap-y-1 border-b bg-slate-950/60 px-4 py-1.5 backdrop-blur transition-opacity ${
        stale ? 'border-amber-500/40 opacity-60' : 'border-slate-800/80'
      }`}
    >
      <div
        className="flex items-center gap-2 px-2"
        title={
          server === null
            ? 'no observer server reachable'
            : `server build ${server.build} · ${server.tickCount.toLocaleString()} ticks · state read ${ageText}${
                server.lastSaveMs !== null ? ` · last snapshot took ${(server.lastSaveMs / 1000).toFixed(1)} s (the server answers nothing while it writes one)` : ''
              }${stale ? ' — these numbers are NOT current; the app is retrying' : ''}`
        }
      >
        <span className="relative flex h-2 w-2">
          {learning && server !== null && !stale && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${statusTone} opacity-70`} />}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${server === null ? 'bg-slate-600' : stale ? 'bg-amber-400' : statusTone}`} />
        </span>
        <span className={`text-xs font-medium ${stale ? 'text-amber-300' : 'text-slate-300'}`}>{statusText}</span>
        {stale && <span className="font-mono text-[10px] text-amber-400/80">{ageText}</span>}
      </div>

      <div className="w-px self-stretch bg-slate-800/80" />

      <Stat
        label="field coherence"
        value={fixed(coherence, 3)}
        tone="text-emerald-300"
        title={`the oscillator field's phase coherence${ticking ? ' (live)' : ' (last settled state — the field is asleep)'}`}
      />
      <Stat label="field entropy" value={fixed(entropy, 3)} tone="text-amber-300" title="entropy of the oscillator amplitude distribution (the substrate, not the knowledge)" />
      <Stat label="order" value={fixed(order, 3)} tone="text-sky-300" title="Kuramoto order parameter of the field" />
      <Stat label="traces" value={traces === null ? '—' : traces.toLocaleString()} tone="text-slate-200" title="memory traces in the bank" />

      <div className="w-px self-stretch bg-slate-800/80" />

      <Stat
        label="knowledge entropy"
        value={knowledge === null ? '—' : `${knowledge.mean.toFixed(2)} bits`}
        tone="text-fuchsia-300"
        title={
          knowledge === null
            ? 'not yet measured'
            : `per concept, over ${knowledge.concepts.toLocaleString()} concepts (total ${knowledge.total.toLocaleString()} bits) · ${knowledge.certain.toLocaleString()} slots certain · ${knowledge.conflicted.toLocaleString()} conflicted · ${knowledge.unknown.toLocaleString()} unknown — how unsure it would be if asked; falls as it learns`
        }
      />

      <div className="w-px self-stretch bg-slate-800/80" />

      <div className="flex min-w-40 flex-col justify-center px-3.5 py-1.5" title="words with a memory trace / every word the observer knows (deck + grown)">
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">vocabulary</span>
        <div className="flex items-center gap-2">
          <span className="h-1 w-20 overflow-hidden rounded-full bg-slate-800">
            <span className="block h-full rounded-full bg-emerald-400 transition-[width] duration-500" style={{ width: `${Math.round(progress * 100)}%` }} />
          </span>
          <span className="font-mono text-xs text-slate-300">
            {learned === null || total === null ? '—' : `${learned.toLocaleString()}/${total.toLocaleString()}`}
          </span>
        </div>
      </div>

      <Stat
        label="exchanges recalled"
        value={competency === null ? '—' : `${Math.round(competency * 100)}%`}
        tone="text-slate-200"
        title="share of taught conversation exchanges the observer recalls (the competency the creative layer unlocks on)"
      />
      <Stat
        label="creative"
        value={creativeUnlocked === null ? '—' : creativeUnlocked ? 'unlocked' : 'locked'}
        tone={creativeUnlocked === true ? 'text-emerald-300' : 'text-slate-500'}
        title="whether the composition layer may speak"
      />

      <div className="w-px self-stretch bg-slate-800/80" />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-1.5" title="the drive vector (non-perturbing snapshot)">
        <Meter label="curiosity" value={drives?.curiosity ?? null} tone="bg-fuchsia-400" />
        <Meter label="novelty" value={drives?.novelty ?? null} tone="bg-violet-400" />
        <Meter label="conservation" value={drives?.conservation ?? null} tone="bg-amber-400" />
        <Meter label="coherence" value={drives?.coherence ?? null} tone="bg-emerald-400" />
      </div>
    </header>
  );
}
