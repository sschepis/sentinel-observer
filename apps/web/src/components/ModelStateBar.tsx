import { useEffect, useState } from 'react';
import type { TeacherAgent } from '../teacher/TeacherAgent';
import type { ObserverStatus } from '../observer/engine';
import type { DriveState } from '../teacher/drives';

const EMPTY_DRIVES: DriveState = {
  coherence: 0,
  curiosity: 0,
  novelty: 0,
  conservation: 0,
  selfConsistency: 0
};

export interface ModelStateBarProps {
  teacher: TeacherAgent | null;
  status: ObserverStatus;
  /** Words with a memory trace / total deck size. */
  learnedWords: number;
  totalWords: number;
  competency: number;
  creativeUnlocked: boolean;
  /** True while the autonomous classroom is running. */
  learning: boolean;
  /** Recomputes the summary when the teacher mutates outside React. */
  revision?: number;
}

function Stat({ label, value, tone = 'text-slate-100' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col justify-center px-3.5 py-1.5">
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">{label}</span>
      <span className={`font-mono text-sm leading-tight ${tone}`}>{value}</span>
    </div>
  );
}

function Meter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex items-center gap-1.5" title={`${label} ${value.toFixed(2)}`}>
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label.slice(0, 4)}</span>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-slate-800">
        <span
          className={`block h-full rounded-full ${tone} transition-[width] duration-500`}
          style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
        />
      </span>
    </div>
  );
}

/**
 * The model-state strip that sits above every view: one dense row of the
 * observer's live physics, its curriculum progress and its drive vector.
 *
 * It polls the teacher with READ-ONLY reads, so displaying the model can
 * never perturb the model.
 */
export function ModelStateBar({
  teacher,
  status,
  learnedWords,
  totalWords,
  competency,
  creativeUnlocked,
  learning,
  revision = 0
}: ModelStateBarProps) {
  const [drives, setDrives] = useState<DriveState>(EMPTY_DRIVES);
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    if (teacher === null) return;
    const id = setInterval(() => {
      setDrives(teacher.driveSignalsStatic());
      setPulse((n) => n + 1);
    }, 2000);
    return () => clearInterval(id);
  }, [teacher]);

  const state = teacher?.observerState() ?? null;
  const progress = totalWords > 0 ? learnedWords / totalWords : 0;

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

  return (
    <header
      data-pulse={pulse}
      data-revision={revision}
      className="flex shrink-0 flex-wrap items-stretch gap-x-1 gap-y-1 border-b border-slate-800/80 bg-slate-950/60 px-4 py-1.5 backdrop-blur"
    >
      <div className="flex items-center gap-2 px-2">
        <span className="relative flex h-2 w-2">
          {learning && (
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${statusTone} opacity-70`} />
          )}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${statusTone}`} />
        </span>
        <span className="text-xs font-medium text-slate-300">
          {status === 'idle' ? 'asleep' : learning ? 'learning' : status === 'degraded' ? 'degraded' : 'awake'}
        </span>
      </div>

      <div className="w-px self-stretch bg-slate-800/80" />

      <Stat label="coherence" value={(state?.coherence ?? 0).toFixed(3)} tone="text-emerald-300" />
      <Stat label="entropy" value={(state?.entropy ?? 0).toFixed(3)} tone="text-amber-300" />
      <Stat label="order" value={(state?.orderParameter ?? 0).toFixed(3)} tone="text-sky-300" />
      <Stat label="traces" value={String(state?.memoryTraceCount ?? 0)} tone="text-slate-200" />

      <div className="w-px self-stretch bg-slate-800/80" />

      <div className="flex min-w-40 flex-col justify-center px-3.5 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">vocabulary</span>
        <div className="flex items-center gap-2">
          <span className="h-1 w-20 overflow-hidden rounded-full bg-slate-800">
            <span
              className="block h-full rounded-full bg-emerald-400 transition-[width] duration-500"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </span>
          <span className="font-mono text-xs text-slate-300">
            {learnedWords.toLocaleString()}/{totalWords.toLocaleString()}
          </span>
        </div>
      </div>

      <Stat label="recall" value={`${Math.round(competency * 100)}%`} tone="text-slate-200" />
      <Stat
        label="creative"
        value={creativeUnlocked ? 'unlocked' : 'locked'}
        tone={creativeUnlocked ? 'text-emerald-300' : 'text-slate-500'}
      />

      <div className="w-px self-stretch bg-slate-800/80" />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-1.5">
        <Meter label="curiosity" value={drives.curiosity} tone="bg-fuchsia-400" />
        <Meter label="novelty" value={drives.novelty} tone="bg-violet-400" />
        <Meter label="conservation" value={drives.conservation} tone="bg-amber-400" />
        <Meter label="coherence" value={drives.coherence} tone="bg-emerald-400" />
      </div>
    </header>
  );
}
