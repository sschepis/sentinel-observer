import { useMemo, useState } from 'react';
import { TeacherAgent, type GradeResult, type QuizAnswer } from '../teacher/TeacherAgent';
import { STARTER_DECK } from '../teacher/deck';
import type { ObserverSignal } from '@sschepis/sentient-core';
import { diaryEntry, signalTimestamp } from '../observer/interpreter';

export interface TeacherPanelProps {
  /** The teacher, built over the running observer session. */
  teacher: TeacherAgent | null;
  /**
   * The observer's durable (non-metric) signals — memory, insight, drift —
   * which feed its diary. Metric ticks are excluded so the diary is never
   * flooded by the tick loop.
   */
  diarySignals: ObserverSignal[];
}

/**
 * The schoolroom: the teacher teaches the OBSERVER. The human watches the
 * observer's mind — its word states, its answers, its diary — and drives the
 * loop with teach/ask/grade controls.
 */
export function TeacherPanel({ teacher, diarySignals }: TeacherPanelProps) {
  // tick is a refresh counter: bumping it recomputes the derived lists.
  const [tick, setTick] = useState(0);
  const [current, setCurrent] = useState<{ mode: 'quiz'; question: QuizAnswer } | null>(null);
  const [lastGrade, setLastGrade] = useState<GradeResult | null>(null);

  const words = useMemo(() => teacher?.listWords() ?? [], [teacher, tick]);
  const diary = useMemo(
    () =>
      diarySignals
        .map((signal) => ({ entry: diaryEntry(signal), signal }))
        .filter((item): item is { entry: string; signal: ObserverSignal } => item.entry !== null)
        .slice(-12)
        .reverse(),
    [diarySignals]
  );

  const refresh = () => setTick((n) => n + 1);

  if (teacher === null) {
    return (
      <div className="mx-auto max-w-4xl p-6 text-slate-400">
        Start the observer first — the teacher needs a learner.
      </div>
    );
  }

  const teachNext = () => {
    const next = teacher.nextNewWord() ?? teacher.nextReview();
    if (next === null) return;
    const result = teacher.teach(next);
    void result;
    setCurrent(null);
    setLastGrade(null);
    refresh();
  };

  const askNext = (direction: 'recognition' | 'production') => {
    const next = teacher.nextReview() ?? teacher.nextNewWord();
    if (next === null) return;
    setCurrent({ mode: 'quiz', question: teacher.ask(next, direction) });
    setLastGrade(null);
    refresh();
  };

  const grade = () => {
    if (current === null) return;
    // The teacher grades by the answer key — comparing the observer's actual
    // recall against the taught trace — not by a human's opinion. A blank or
    // wrong recall is a failure and is fed back to the observer as such.
    const result = teacher.grade(current.question.word.word, current.question);
    setLastGrade(result);
    refresh();
  };

  const production = current !== null && current.question.cue === current.question.word.definition;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">The Schoolroom</h1>
          <p className="text-sm text-slate-400">
            The teacher teaches, the observer learns. Watch its mind as it acquires English.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={teachNext}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
          >
            Teach next word
          </button>
          <button
            onClick={() => askNext('recognition')}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-600"
          >
            Quiz: word → meaning
          </button>
          <button
            onClick={() => askNext('production')}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-600"
          >
            Quiz: meaning → word
          </button>
        </div>
      </div>

      {current !== null && (
        <div className="mb-6 rounded-lg border border-slate-700 bg-slate-900 p-4">
          <p className="text-xs uppercase tracking-wider text-slate-400">
            Question {production ? '(production: meaning → word)' : '(recognition: word → meaning)'}
          </p>
          <p className="mt-2 text-lg text-slate-100">“{current.question.cue}”</p>
          <p className="mt-2 text-sm text-slate-400">
            The observer answered:{' '}
            <span className="font-mono text-slate-200">
              {current.question.answer.length > 0 ? `"${current.question.answer}"` : 'nothing (blank)'}
            </span>
          </p>
          {lastGrade === null ? (
            <div className="mt-3 flex gap-2">
              <button
                onClick={grade}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500"
              >
                Grade the answer
              </button>
            </div>
          ) : (
            <p
              className={`mt-3 text-sm ${
                lastGrade.verdict === 'correct' ? 'text-emerald-300' : 'text-red-300'
              }`}
            >
              Graded {lastGrade.verdict}
              {lastGrade.verdict === 'correct' && lastGrade.confidence !== null
                ? ` (recall confidence ${lastGrade.confidence.toFixed(2)})`
                : ''}
              : expected “{lastGrade.expected}” — the observer said “
              {lastGrade.answer || 'nothing'}”. The quiz event has been fed back into its field.
            </p>
          )}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
          <p className="mb-2 text-xs uppercase tracking-wider text-slate-400">
            The observer's vocabulary ({words.filter((w) => w.status !== 'new').length}/{words.length})
          </p>
          <ul className="space-y-2 font-mono text-sm">
            {words.map((entry) => (
              <li key={entry.word.word} className="flex items-center justify-between gap-2">
                <span className="text-slate-200">
                  {entry.word.word}
                  <span className="ml-2 text-xs text-slate-500">{entry.status}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="h-1.5 w-24 overflow-hidden rounded bg-slate-700">
                    <span
                      className="block h-full rounded bg-emerald-400"
                      style={{ width: `${Math.round((entry.strength ?? 0) * 100)}%` }}
                    />
                  </span>
                  <span className="w-14 text-right text-xs text-slate-400">
                    {entry.successes}✓ {entry.failures}✗
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-slate-700 bg-slate-900 p-4">
          <p className="mb-2 text-xs uppercase tracking-wider text-slate-400">
            The observer's diary
          </p>
          {diary.length === 0 ? (
            <p className="text-sm text-slate-500">
              The diary is empty — teach the observer something and it will begin to write.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {diary.map(({ entry, signal }) => (
                <li key={signal.at} className="flex gap-2">
                  <span className="shrink-0 font-mono text-xs text-slate-500">
                    {signalTimestamp(signal)}
                  </span>
                  <span className="text-slate-300">{entry}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
