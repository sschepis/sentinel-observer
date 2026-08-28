import { useEffect, useMemo, useState } from 'react';
import { TeacherAgent, type GradeResult, type QuizAnswer, type AutoLoopStep } from '../teacher/TeacherAgent';
import type { ObserverSignal } from '@sschepis/sentient-core';
import type { PersistenceKind } from '../persistence/store';
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
  /** Where the learning record is stored (honest persistence status). */
  persistenceKind: PersistenceKind;
  /** Traces restored from persistence this session. */
  restoredCount: number;
  /** Stale (pre-encoding) traces detected and reset for re-teaching. */
  staleCount: number;
}

/**
 * The schoolroom: the teacher teaches the OBSERVER. The human watches the
 * observer's mind — its word states, its answers, its diary — and drives the
 * loop with teach/ask/grade controls.
 */
export function TeacherPanel({ teacher, diarySignals, persistenceKind, restoredCount, staleCount }: TeacherPanelProps) {
  // tick is a refresh counter: bumping it recomputes the derived lists.
  const [tick, setTick] = useState(0);
  const [current, setCurrent] = useState<{ mode: 'quiz'; question: QuizAnswer } | null>(null);
  const [lastGrade, setLastGrade] = useState<GradeResult | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoStep, setAutoStep] = useState<AutoLoopStep | null>(null);

  // The teacher's autonomous loop drives the same question display the human
  // sees, and stops cleanly when this panel unmounts.
  useEffect(() => {
    if (teacher === null) return;
    const unsubscribe = teacher.onAutoStep((step) => {
      setAutoStep(step);
      setAutoRunning(step.phase !== 'done' && step.phase !== 'error' && teacher.isAutoLoopRunning());
      if (step.phase === 'asking' && step.word !== null && step.cue !== null) {
        const state = teacher.listWords().find((w) => w.word.word === step.word);
        if (state !== undefined) {
          setCurrent({
            mode: 'quiz',
            question: { word: state.word, cue: step.cue, answer: step.answer ?? '', recall: null }
          });
          setLastGrade(null);
        }
      } else if (step.phase === 'grading' && step.grade !== null) {
        setLastGrade(step.grade);
      }
      if (step.phase === 'teaching' || step.phase === 'grading') {
        setTick((n) => n + 1);
      }
    });
    return () => {
      unsubscribe();
      teacher.stopAutoLoop();
    };
  }, [teacher]);

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

  const toggleAutoLoop = () => {
    if (teacher === null) return;
    if (teacher.isAutoLoopRunning()) {
      teacher.stopAutoLoop();
      setAutoRunning(false);
    } else {
      setAutoStep({ phase: 'idle', word: null, cue: null, answer: null, grade: null, message: 'the school begins' });
      teacher.startAutoLoop();
      setAutoRunning(true);
    }
  };

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
    const next =
      direction === 'recognition'
        ? teacher.nextReview() ?? teacher.nextLearnedWord()
        : teacher.nextLearnedWord();
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
          <p className="mt-1 text-xs text-slate-500">
            {persistenceKind === 'indexeddb'
              ? 'progress is saved across sessions'
              : 'session-only: no persistent storage available'}
            {restoredCount > 0 ? ` · ${restoredCount} memories restored from previous sessions` : ''}
            {staleCount > 0
              ? ` · ${staleCount} stale memories detected — the observer will re-learn them under the new encoding`
              : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={toggleAutoLoop}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${
              autoRunning
                ? 'bg-amber-700 text-white hover:bg-amber-600'
                : 'bg-emerald-600 text-white hover:bg-emerald-500'
            }`}
          >
            {autoRunning ? 'Pause teaching' : 'Let the teacher teach'}
          </button>
          <button
            onClick={teachNext}
            disabled={autoRunning}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-600 disabled:opacity-40 disabled:hover:bg-slate-700"
          >
            Teach next word
          </button>
          <button
            onClick={() => askNext('recognition')}
            disabled={autoRunning}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-600 disabled:opacity-40 disabled:hover:bg-slate-700"
          >
            Quiz: word → meaning
          </button>
          <button
            onClick={() => askNext('production')}
            disabled={autoRunning}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-600 disabled:opacity-40 disabled:hover:bg-slate-700"
          >
            Quiz: meaning → word
          </button>
        </div>
      </div>

      {autoStep !== null && autoStep.phase !== 'idle' && (
        <div className="mb-6 rounded-lg border border-slate-700 bg-slate-900 p-4">
          <p className="text-xs uppercase tracking-wider text-slate-400">
            The teacher at work
            <span className="ml-2 text-slate-500">({autoStep.phase})</span>
          </p>
          <p className="mt-1 text-sm text-slate-300">{autoStep.message}</p>
        </div>
      )}

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
              {diary.map(({ entry, signal }, index) => (
                <li key={`${signal.kind}-${signal.at}-${index}`} className="flex gap-2">
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
