import { useEffect, useMemo, useRef, useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { TeacherPanel } from './components/TeacherPanel';
import { TeacherAgent } from './teacher/TeacherAgent';
import { DECK_100 } from './teacher/decks/en-100';
import { PRIME_SPACE, deckVocabulary } from './teacher/primeSignature';
import { createPersistenceStore } from './persistence/store';
import { useObserver } from './observer/useObserver';

/**
 * Phase-2/3 encoding: a 32-prime field, whole-word prime signatures for the
 * deck, and the COMPACT memory bank (lean traces + prefiltered recall — the
 * scale substrate measured at 99% accuracy over 500 words).
 */
const OBSERVER_OPTIONS = {
  primeCount: 32,
  gridSize: 64,
  memoryMode: 'compact' as const,
  vocabulary: deckVocabulary(DECK_100, PRIME_SPACE)
};

export default function App() {
  // One store per app lifetime (stable identity — the hook and teacher share it).
  const persistence = useRef(createPersistenceStore());
  const { session, status, error, metrics, start, stop, lastStimulus, signals, diarySignals } =
    useObserver(persistence.current, OBSERVER_OPTIONS);
  const [tab, setTab] = useState<'mind' | 'school'>('mind');
  const [restored, setRestored] = useState(0);
  const [staleCount, setStaleCount] = useState(0);

  // The teacher exists only when the observer (the learner) is running.
  const teacher = useMemo(
    () =>
      session !== null ? new TeacherAgent(session, DECK_100, persistence.current) : null,
    [session]
  );

  // Restore the observer's learning record once the learner is awake.
  const restoreGuard = useRef(false);
  useEffect(() => {
    if (teacher !== null && (status === 'ready' || status === 'degraded') && !restoreGuard.current) {
      restoreGuard.current = true;
      void teacher.restoreFromPersistence().then(
        (result) => {
          setRestored(result.restored);
          setStaleCount(result.stale);
        },
        (reason) => {
          console.warn('learning-record restore failed — starting fresh', reason);
          setRestored(0);
          setStaleCount(0);
        }
      );
    }
  }, [teacher, status]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <nav className="border-b border-slate-800 bg-slate-950/80">
        <div className="mx-auto flex max-w-4xl items-center gap-4 px-6 py-3">
          <span className="font-semibold text-slate-100">Sentinel</span>
          <button
            onClick={() => setTab('mind')}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              tab === 'mind' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            The observer's mind
          </button>
          <button
            onClick={() => setTab('school')}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              tab === 'school' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            The schoolroom
          </button>
        </div>
      </nav>

      {tab === 'mind' ? (
        <Dashboard
          status={status}
          error={error}
          metrics={metrics}
          lastStimulus={lastStimulus}
          signals={signals}
          onStart={() => void start()}
          onStop={stop}
        />
      ) : (
        <TeacherPanel
          key={`${restored}-${staleCount}`}
          teacher={teacher}
          diarySignals={diarySignals}
          persistenceKind={persistence.current.kind}
          restoredCount={restored}
          staleCount={staleCount}
        />
      )}
    </div>
  );
}
