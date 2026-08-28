import { useEffect, useMemo, useRef, useState } from 'react';
import { TeacherAgent, type GradeResult, type QuizAnswer, type AutoLoopStep } from '../teacher/TeacherAgent';
import type { ObserverSignal } from '@sschepis/sentient-core';
import type { PersistenceKind } from '../persistence/store';
import { diaryEntry, signalTimestamp } from '../observer/interpreter';
import { VoiceService, matchSpokenWord, spokenAnswer } from '../speech/voice';
import { Chaperone, OpenAICompatProvider, NullChaperoneProvider, type ChaperoneSettings } from '../teacher/chaperone';
import { ACTIVE_DECK } from '../teacher/decks';
import type { PersistenceStore } from '../persistence/store';

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
  /** The persistence store (chaperoned definitions are saved here). */
  persistence: PersistenceStore;
  /** Called after the chaperone applies definitions (refresh the lists). */
  onDefinitionsApplied: () => void;
}

/**
 * The schoolroom: the teacher teaches the OBSERVER. The human watches the
 * observer's mind — its word states, its answers, its diary — and drives the
 * loop with teach/ask/grade controls.
 */
export function TeacherPanel({ teacher, diarySignals, persistenceKind, restoredCount, staleCount, persistence, onDefinitionsApplied }: TeacherPanelProps) {
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
  const report = useMemo(() => teacher?.report() ?? null, [teacher, tick]);
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

  // ── Voice conversation ───────────────────────────────────────────────────
  const voiceRef = useRef<VoiceService | null>(null);
  if (voiceRef.current === null) {
    voiceRef.current = new VoiceService();
  }
  const voice = voiceRef.current;
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'listening' | 'speaking'>('idle');
  const [transcript, setTranscript] = useState<string | null>(null);
  const [spoken, setSpoken] = useState<string | null>(null);

  useEffect(() => () => voice.stopSpeaking(), [voice]);

  // ── Chaperone (LLM-generated, validated content) ────────────────────────
  const SETTINGS_KEY = 'sentinel-chaperone-settings';
  const [chaperoneSettings, setChaperoneSettings] = useState<ChaperoneSettings>(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return JSON.parse(raw) as ChaperoneSettings;
    } catch {
      // Corrupt settings degrade to unconfigured.
    }
    return { endpoint: '', apiKey: '', model: 'gpt-4o-mini' };
  });
  const [chaperoneProgress, setChaperoneProgress] = useState<{ done: number; total: number } | null>(null);
  const [chaperoneResult, setChaperoneResult] = useState<string | null>(null);

  const saveChaperoneSettings = (next: ChaperoneSettings) => {
    setChaperoneSettings(next);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  };

  const wordsWithoutDefinitions = useMemo(
    () => (teacher === null ? 0 : teacher.listWords().filter((w) => w.word.definition.trim().length === 0).length),
    [teacher, tick]
  );

  const runChaperone = async () => {
    if (teacher === null) return;
    const provider =
      chaperoneSettings.endpoint.trim().length > 0
        ? new OpenAICompatProvider(chaperoneSettings)
        : new NullChaperoneProvider();
    const chaperone = new Chaperone(provider);
    const target = teacher.listWords().filter((w) => w.word.definition.trim().length === 0);

    setChaperoneProgress({ done: 0, total: target.length });
    setChaperoneResult(null);
    const run = await chaperone.fillDefinitions(target.map((w) => w.word), {
      onBatch: (done, total) => setChaperoneProgress({ done, total })
    });

    if (run.definitions.length > 0) {
      teacher.applyDefinitions(run.definitions);
      await persistence.saveDefinitions(run.definitions);
      onDefinitionsApplied();
    }
    setChaperoneProgress(null);
    setChaperoneResult(
      run.errors.length > 0
        ? `generated ${run.definitions.length} definitions, skipped ${run.skipped.length}, errors in ${run.errors.length} batches (${run.errors[0]})`
        : `generated ${run.definitions.length} definitions${run.skipped.length > 0 ? `, skipped ${run.skipped.length} (invalid content rejected)` : ''}`
    );
  };

  const askAloud = () => {
    if (teacher === null) return;
    const started = voice.startListening({
      onTranscript: (heard) => {
        setTranscript(heard);
        const match = matchSpokenWord(heard, ACTIVE_DECK);
        if (match === null) {
          // The observer honestly does not recognize the word — it must not
          // guess.
          setSpoken("I do not recognize that word yet.");
          setVoiceStatus('speaking');
          voice.speak("I do not recognize that word yet.", { onEnd: () => setVoiceStatus('idle') });
          return;
        }
        // The observer hears the spoken word and answers from memory.
        const question = teacher.ask(match.word, 'recognition');
        const answer = question.answer.length > 0 ? spokenAnswer(question.answer) : 'I do not remember that word.';
        setSpoken(answer);
        setVoiceStatus('speaking');
        voice.speak(answer, { onEnd: () => setVoiceStatus('idle') });
      },
      onError: (error) => {
        setTranscript(null);
        setSpoken(`I could not hear you (${error}).`);
        setVoiceStatus('idle');
      }
    });
    if (started) {
      setVoiceStatus('listening');
    } else {
      setSpoken('Speech recognition is unavailable in this browser — use the typed quizzes below.');
    }
  };

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

      <div className="mb-6 rounded-lg border border-slate-700 bg-slate-900 p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wider text-slate-400">Speak with the observer</p>
          <span className="text-xs text-slate-500">
            {voice.sttAvailable && voice.ttsAvailable
              ? 'voice ready'
              : `voice limited: ${!voice.sttAvailable ? 'no speech recognition' : 'no speech output'} — typed quizzes work`}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={() => {
              if (voiceStatus === 'listening') {
                voice.stopListening();
                setVoiceStatus('idle');
                return;
              }
              askAloud();
            }}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${
              voiceStatus === 'listening'
                ? 'bg-red-700 hover:bg-red-600'
                : 'bg-sky-700 hover:bg-sky-600 disabled:opacity-40'
            }`}
            disabled={voiceStatus === 'listening' ? false : !voice.sttAvailable}
          >
            {voiceStatus === 'listening' ? 'Cancel listening' : 'Ask aloud'}
          </button>
          <span className="text-xs text-slate-500">
            say a word you have taught — the observer will answer aloud
          </span>
        </div>
        {transcript !== null && (
          <p className="mt-2 text-sm text-slate-400">
            heard: <span className="text-slate-200">“{transcript}”</span>
          </p>
        )}
        {spoken !== null && (
          <p className="mt-1 text-sm text-slate-300">
            the observer says: <span className="font-mono text-emerald-300">“{spoken}”</span>
            {voiceStatus === 'speaking' ? ' 🔊' : ''}
          </p>
        )}
      </div>

      <div className="mb-6 rounded-lg border border-slate-700 bg-slate-900 p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wider text-slate-400">The Chaperone — LLM content, validated</p>
          <span className="text-xs text-slate-500">
            {chaperoneSettings.endpoint.trim().length > 0
              ? `provider: ${chaperoneSettings.model || chaperoneSettings.endpoint}`
              : 'no provider configured'}
          </span>
        </div>
        {wordsWithoutDefinitions > 0 && (
          <p className="mt-2 text-sm text-slate-400">
            {wordsWithoutDefinitions} words have no meaning content yet — the observer learns them by recognition
            until definitions exist.
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            type="text"
            value={chaperoneSettings.endpoint}
            onChange={(e) => saveChaperoneSettings({ ...chaperoneSettings, endpoint: e.target.value })}
            placeholder="endpoint URL (OpenAI-compatible)"
            className="w-64 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-100 placeholder-slate-600"
          />
          <input
            type="text"
            value={chaperoneSettings.model}
            onChange={(e) => saveChaperoneSettings({ ...chaperoneSettings, model: e.target.value })}
            placeholder="model"
            className="w-36 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-100 placeholder-slate-600"
          />
          <input
            type="password"
            value={chaperoneSettings.apiKey}
            onChange={(e) => saveChaperoneSettings({ ...chaperoneSettings, apiKey: e.target.value })}
            placeholder="API key (stays in this browser)"
            className="w-48 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-100 placeholder-slate-600"
          />
          <button
            onClick={() => void runChaperone()}
            disabled={wordsWithoutDefinitions === 0 || chaperoneProgress !== null}
            className="rounded-lg bg-violet-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-600 disabled:opacity-40"
          >
            {chaperoneProgress !== null
              ? `Filling… ${chaperoneProgress.done}/${chaperoneProgress.total}`
              : `Fill definitions (${wordsWithoutDefinitions})`}
          </button>
        </div>
        {chaperoneResult !== null && (
          <p className="mt-2 text-xs text-slate-400">
            {chaperoneResult} — LLM content is schema-validated and labeled; the observer's metrics remain its own.
          </p>
        )}
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
          {report !== null && report.learned > 0 && (
            <p className="mb-2 text-xs text-slate-500">
              {report.consolidatedCount} consolidated · {report.dueCount} due for review ·{' '}
              {report.healthyCount} healthy
            </p>
          )}
          <ul className="space-y-2 font-mono text-sm">
            {words.map((entry) => {
              const reportWord = report?.words.find((w) => w.word === entry.word.word);
              const statusColor: Record<string, string> = {
                new: 'text-slate-500',
                due: 'text-amber-400',
                soon: 'text-sky-400',
                healthy: 'text-emerald-400',
                consolidated: 'text-emerald-300 font-semibold'
              };
              return (
                <li key={entry.word.word} className="flex items-center justify-between gap-2">
                  <span className="text-slate-200">
                    {entry.word.word}
                    <span className={`ml-2 text-xs ${statusColor[entry.status] ?? 'text-slate-500'}`}>
                      {entry.status}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {reportWord?.delta !== null && reportWord?.delta !== undefined && (
                      <span
                        className={`text-xs ${reportWord.delta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
                      >
                        {reportWord.delta >= 0 ? '▲' : '▼'}
                        {Math.abs(reportWord.delta).toFixed(2)}
                      </span>
                    )}
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
              );
            })}
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
