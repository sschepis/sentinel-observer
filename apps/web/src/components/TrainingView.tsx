import { useEffect, useMemo, useRef, useState } from 'react';
import type { ObserverSignal } from '@sschepis/sentient-core';
import type { LearningEngine } from '../learning/useLearningEngine';
import {
  EVENT_FILTERS,
  EVENT_STYLES,
  fromObserverSignal,
  type LearningEvent,
  type LearningEventKind
} from '../learning/events';
import { ChaperoneProgress } from './ChaperoneProgress';

export interface TrainingViewProps {
  engine: LearningEngine;
  /** The observer's own durable signals — folded into the same stream. */
  diarySignals: ObserverSignal[];
  ready: boolean;
  onStartObserver?: () => void;
  onOpenSettings: () => void;
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

function EventRow({ event }: { event: LearningEvent }) {
  const style = EVENT_STYLES[event.kind];
  return (
    <li className="group flex gap-3 border-b border-slate-900/70 px-4 py-2 hover:bg-slate-900/40">
      <span className="w-16 shrink-0 pt-0.5 font-mono text-[11px] text-slate-600">{timeOf(event.at)}</span>
      <span className="flex w-32 shrink-0 items-start gap-1.5 pt-0.5">
        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
        <span className={`truncate text-[11px] font-medium uppercase tracking-wide ${style.tone}`} title={event.label}>
          {event.label}
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm leading-relaxed text-slate-200">{event.text}</span>
        {event.detail != null && event.detail.length > 0 && (
          <span className="mt-0.5 block break-words text-xs italic text-slate-500">{event.detail}</span>
        )}
      </span>
    </li>
  );
}

/**
 * Training: one running stream of everything the observer is doing — words
 * learned, reviews, definitions, the dialogue with its teacher, the
 * questions it asks itself, grades and its own memory signals.
 *
 * The loop it drives lives in the app shell, so leaving this page does not
 * interrupt learning.
 */
export function TrainingView({ engine, diarySignals, ready, onStartObserver, onOpenSettings }: TrainingViewProps) {
  const [filterKey, setFilterKey] = useState('all');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const memoryEvents = useMemo(
    () => diarySignals.map(fromObserverSignal).filter((event): event is LearningEvent => event !== null),
    [diarySignals]
  );

  const stream = useMemo(
    () => [...engine.events, ...memoryEvents].sort((a, b) => a.at - b.at),
    [engine.events, memoryEvents]
  );

  const counts = useMemo(() => {
    const tally = new Map<LearningEventKind, number>();
    for (const event of stream) tally.set(event.kind, (tally.get(event.kind) ?? 0) + 1);
    return tally;
  }, [stream]);

  const activeFilter = EVENT_FILTERS.find((f) => f.key === filterKey) ?? EVENT_FILTERS[0];

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const admitted = new Set<LearningEventKind>(activeFilter.kinds);
    return stream.filter((event) => {
      if (!admitted.has(event.kind)) return false;
      if (needle.length === 0) return true;
      return (
        event.text.toLowerCase().includes(needle) ||
        event.label.toLowerCase().includes(needle) ||
        (event.detail ?? '').toLowerCase().includes(needle)
      );
    });
  }, [stream, activeFilter, query]);

  useEffect(() => {
    if (!follow) return;
    const scroller = scrollerRef.current;
    if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
  }, [visible, follow]);

  const selfSufficiency =
    engine.stats.selfAnswered + engine.stats.llmCalls > 0
      ? Math.round((engine.stats.selfAnswered / (engine.stats.selfAnswered + engine.stats.llmCalls)) * 100)
      : null;
  const creativeMean =
    engine.stats.creativeScores.length > 0
      ? engine.stats.creativeScores.reduce((a, b) => a + b, 0) / engine.stats.creativeScores.length
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Controls */}
      <div className="shrink-0 border-b border-slate-800/80 px-6 py-3">
        <div className="flex flex-wrap items-center gap-3">
          {engine.running ? (
            <button
              onClick={engine.stop}
              className="rounded-lg bg-rose-600/90 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-rose-500"
            >
              Stop learning
            </button>
          ) : (
            <button
              onClick={engine.start}
              disabled={!ready || !engine.configured}
              title={
                !ready
                  ? 'Wake the observer first'
                  : !engine.configured
                    ? 'Configure a teacher model in Settings first'
                    : 'Run the autonomous learning loop'
              }
              className="rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-medium text-slate-950 transition hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-500"
            >
              Start learning
            </button>
          )}

          <span className="flex items-center gap-1.5 text-xs text-slate-500">
            <span
              className={`h-1.5 w-1.5 rounded-full ${engine.running ? 'animate-pulse bg-emerald-400' : 'bg-slate-700'}`}
            />
            {engine.running ? 'running — safe to navigate away' : 'idle'}
          </span>

          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-slate-500">
            <span>{engine.stats.cycles} cycles</span>
            <span className="text-emerald-400/80">{engine.stats.wordsTaught} words</span>
            <span className="text-teal-400/80">{engine.stats.wordsReviewed} reviews</span>
            <span className="text-cyan-400/80">{engine.stats.phrasesTaught} phrases</span>
            {engine.stats.drillsRun > 0 && (
              <span
                className="text-orange-400/80"
                title="Drills are graded with no LLM. Induced = correct on exercises it was never shown; memorized = correct only on what it was taught."
              >
                {engine.stats.drillsRun} drills · {engine.stats.drillsInduced} induced ·{' '}
                {engine.stats.drillsMemorized} memorized
              </span>
            )}
            {engine.stats.lastDrill !== null && (
              <span className="text-slate-400">
                {engine.stats.lastDrill.concept} {Math.round(engine.stats.lastDrill.testAccuracy * 100)}% unseen
              </span>
            )}
            {selfSufficiency !== null && <span className="text-slate-400">{selfSufficiency}% self-answered</span>}
            {creativeMean !== null && <span className="text-amber-400/80">creative {creativeMean.toFixed(2)}</span>}
          </div>
        </div>

        {!engine.configured && (
          <p className="mt-2 text-xs text-amber-300/80">
            No teacher model configured.{' '}
            <button onClick={onOpenSettings} className="underline underline-offset-2 hover:text-amber-200">
              Add one in Settings
            </button>{' '}
            to let the observer learn on its own.
          </p>
        )}
        {!ready && onStartObserver !== undefined && (
          <p className="mt-2 text-xs text-slate-500">
            The observer is asleep.{' '}
            <button onClick={onStartObserver} className="underline underline-offset-2 hover:text-slate-300">
              Wake it
            </button>{' '}
            to begin.
          </p>
        )}
        {engine.error !== null && <p className="mt-2 text-xs text-rose-400">{engine.error}</p>}
      </div>

      {/* Filters */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800/80 px-6 py-2.5">
        {EVENT_FILTERS.map((filter) => {
          const count =
            filter.key === 'all'
              ? stream.length
              : filter.kinds.reduce((sum, kind) => sum + (counts.get(kind) ?? 0), 0);
          const active = filter.key === filterKey;
          return (
            <button
              key={filter.key}
              onClick={() => setFilterKey(filter.key)}
              aria-pressed={active}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                active
                  ? 'bg-slate-100 text-slate-900'
                  : 'bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              {filter.label}
              <span className={active ? 'ml-1.5 text-slate-500' : 'ml-1.5 text-slate-600'}>{count}</span>
            </button>
          );
        })}
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter the stream…"
          aria-label="Filter the stream"
          className="ml-auto w-52 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1 text-xs text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-slate-600"
        />
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-500">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
            className="h-3 w-3 accent-emerald-500"
          />
          Follow
        </label>
        <button
          onClick={engine.clearEvents}
          className="rounded-lg border border-slate-800 px-2.5 py-1 text-xs text-slate-500 transition hover:border-slate-600 hover:text-slate-300"
        >
          Clear
        </button>
      </div>

      {engine.definitionProgress !== null && (
        <div className="shrink-0 px-6 pb-2 pt-3">
          <ChaperoneProgress
            progress={engine.definitionProgress}
            result={engine.definitionResult}
            onCancel={engine.cancelDefinitions}
          />
        </div>
      )}

      {/* The stream */}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center p-10 text-center">
            <p className="max-w-sm text-sm text-slate-600">
              {stream.length === 0
                ? 'Nothing yet. Start learning and every word, question, answer and grade appears here as it happens.'
                : 'No events match this filter.'}
            </p>
          </div>
        ) : (
          <ul>
            {visible.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
