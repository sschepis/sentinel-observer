import { useEffect, useMemo, useRef, useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { TeacherPanel } from './components/TeacherPanel';
import { TeacherAgent } from './teacher/TeacherAgent';
import { DECK_100 } from './teacher/decks/en-100';
import { createPersistenceStore } from './persistence/store';
import { useObserver } from './observer/useObserver';

export default function App() {
  // One store per app lifetime (stable identity — the hook and teacher share it).
  const persistence = useRef(createPersistenceStore());
  const { session, status, error, metrics, start, stop, lastStimulus, signals, diarySignals } =
    useObserver(persistence.current);
  const [tab, setTab] = useState<'mind' | 'school'>('mind');
  const [restored, setRestored] = useState(0);

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
      void teacher.restoreFromPersistence().then((count) => setRestored(count));
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
          key={restored}
          teacher={teacher}
          diarySignals={diarySignals}
          persistenceKind={persistence.current.kind}
          restoredCount={restored}
        />
      )}
    </div>
  );
}
