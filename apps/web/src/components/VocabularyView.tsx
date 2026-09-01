import { useEffect, useMemo, useState } from 'react';
import type { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';

export interface VocabularyViewProps {
  teacher: TeacherAgent | null;
  /** Recomputes the list when the teacher mutates outside React. */
  revision: number;
}

type VocabularyFilter = 'all' | 'new' | 'learning' | 'consolidated' | 'due';

const PAGE_SIZE = 50;

const STATUS_TONE: Record<string, string> = {
  new: 'text-slate-500',
  due: 'text-amber-400',
  soon: 'text-sky-400',
  healthy: 'text-emerald-400',
  learning: 'text-sky-400',
  consolidated: 'text-emerald-300'
};

/** The deck browser: what the observer knows, what it is still learning. */
export function VocabularyView({ teacher, revision }: VocabularyViewProps) {
  const [filter, setFilter] = useState<VocabularyFilter>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [teachInput, setTeachInput] = useState('');
  const [teachStatus, setTeachStatus] = useState('');
  const [localRevision, setLocalRevision] = useState(0);

  const words = useMemo(() => teacher?.listWords() ?? [], [teacher, revision, localRevision]);
  const report = useMemo(() => teacher?.report() ?? null, [teacher, revision, localRevision]);

  const reportByWord = useMemo(
    () => new Map((report?.words ?? []).map((entry) => [entry.word, entry])),
    [report]
  );

  useEffect(() => {
    setPage(1);
  }, [filter, query]);

  const counts = useMemo(() => {
    const tally = { all: words.length, new: 0, learning: 0, consolidated: 0, due: 0 };
    for (const entry of words) {
      if (entry.status === 'new') tally.new += 1;
      else if (entry.status === 'learning') tally.learning += 1;
      else tally.consolidated += 1;
      const reported = reportByWord.get(entry.word.word);
      if (reported !== undefined && (reported.status === 'due' || reported.status === 'soon')) tally.due += 1;
    }
    return tally;
  }, [words, reportByWord]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return words.filter((entry) => {
      if (needle.length > 0 && !entry.word.word.toLowerCase().includes(needle)) return false;
      if (filter === 'all') return true;
      if (filter === 'due') {
        const reported = reportByWord.get(entry.word.word);
        return reported !== undefined && (reported.status === 'due' || reported.status === 'soon');
      }
      return entry.status === filter;
    });
  }, [words, filter, query, reportByWord]);

  const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const visible = matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const teachWords = () => {
    if (teacher === null) return;
    const asked = [
      ...new Set(
        teachInput
          .toLowerCase()
          .split(/[,\s]+/)
          .map((word) => word.trim())
          .filter((word) => word.length > 0)
      )
    ];
    if (asked.length === 0) return;
    const inDeck = new Set(ACTIVE_DECK.map((entry) => entry.word));
    const alreadyTaught = new Set(words.filter((entry) => entry.traceId !== null).map((entry) => entry.word.word));
    const unknown = asked.filter((word) => !inDeck.has(word));
    const teachable = asked.filter((word) => inDeck.has(word) && !alreadyTaught.has(word));
    let stored = 0;
    for (const word of teachable) {
      if (teacher.teach(word).traceId !== null) stored += 1;
    }
    setTeachStatus(
      `taught ${stored} word${stored === 1 ? '' : 's'}` +
        (unknown.length > 0 ? ` · ${unknown.length} not in the deck (${unknown.slice(0, 4).join(', ')})` : '') +
        (asked.length - teachable.length - unknown.length > 0
          ? ` · ${asked.length - teachable.length - unknown.length} already learned`
          : '')
    );
    setTeachInput('');
    setLocalRevision((n) => n + 1);
  };

  const chips: Array<{ key: VocabularyFilter; label: string; count: number }> = [
    { key: 'all', label: 'All', count: counts.all },
    { key: 'consolidated', label: 'Learned', count: counts.consolidated },
    { key: 'learning', label: 'Learning', count: counts.learning },
    { key: 'due', label: 'Needs review', count: counts.due },
    { key: 'new', label: 'Not taught', count: counts.new }
  ];

  if (teacher === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-slate-500">Wake the observer to see its vocabulary.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 border-b border-slate-800/80 px-6 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <button
              key={chip.key}
              onClick={() => setFilter(chip.key)}
              aria-pressed={filter === chip.key}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                filter === chip.key
                  ? 'bg-slate-100 text-slate-900'
                  : 'bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              {chip.label}
              <span className="ml-1.5 text-slate-500">{chip.count.toLocaleString()}</span>
            </button>
          ))}
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the deck…"
            aria-label="Search the deck"
            className="ml-auto w-56 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1 text-xs text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-slate-600"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={teachInput}
            onChange={(event) => setTeachInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') teachWords();
            }}
            placeholder="Teach specific words (comma separated)…"
            aria-label="Teach specific words"
            className="w-72 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1 text-xs text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-slate-600"
          />
          <button
            onClick={teachWords}
            disabled={teachInput.trim().length === 0}
            className="rounded-lg bg-slate-800 px-3 py-1 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
          >
            Teach
          </button>
          {teachStatus.length > 0 && <span className="text-xs text-slate-500">{teachStatus}</span>}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center p-10">
            <p className="text-sm text-slate-600">No words match this filter.</p>
          </div>
        ) : (
          <ul>
            {visible.map((entry) => {
              const reported = reportByWord.get(entry.word.word);
              const status = reported?.status ?? entry.status;
              const hasDefinition = entry.word.definition.trim().length > 0;
              return (
                <li
                  key={entry.word.word}
                  className="flex items-center gap-4 border-b border-slate-900/70 px-6 py-2.5 hover:bg-slate-900/40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="font-mono text-sm text-slate-100">{entry.word.word}</span>
                      <span className={`text-[11px] uppercase tracking-wide ${STATUS_TONE[status] ?? 'text-slate-500'}`}>
                        {status}
                      </span>
                    </span>
                    <span
                      className={`mt-0.5 block truncate text-xs ${hasDefinition ? 'text-slate-500' : 'italic text-slate-700'}`}
                      title={hasDefinition ? entry.word.definition : undefined}
                    >
                      {hasDefinition ? entry.word.definition : 'no meaning content yet'}
                    </span>
                  </span>
                  {reported?.delta != null && (
                    <span className={`w-14 text-right text-xs ${reported.delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {reported.delta >= 0 ? '▲' : '▼'}
                      {Math.abs(reported.delta).toFixed(2)}
                    </span>
                  )}
                  <span className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-slate-800">
                    <span
                      className="block h-full rounded-full bg-emerald-400"
                      style={{ width: `${Math.round((entry.strength ?? 0) * 100)}%` }}
                    />
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-xs text-slate-500">
                    {entry.successes}✓ {entry.failures}✗
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-slate-800/80 px-6 py-2.5">
        <button
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          disabled={page <= 1}
          className="rounded-lg bg-slate-900 px-3 py-1 text-xs text-slate-300 transition hover:bg-slate-800 disabled:opacity-30"
        >
          ← Prev
        </button>
        <p className="text-xs text-slate-600">
          Page {page} of {pageCount} · {matches.length.toLocaleString()} words
        </p>
        <button
          onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
          disabled={page >= pageCount}
          className="rounded-lg bg-slate-900 px-3 py-1 text-xs text-slate-300 transition hover:bg-slate-800 disabled:opacity-30"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
