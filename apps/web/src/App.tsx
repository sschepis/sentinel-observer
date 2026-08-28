import { Dashboard } from './components/Dashboard';
import { useObserver } from './observer/useObserver';

export default function App() {
  const { status, error, metrics, start, stop, excite, lastStimulus, signals } = useObserver();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Dashboard
        status={status}
        error={error}
        metrics={metrics}
        lastStimulus={lastStimulus}
        signals={signals}
        onStart={() => void start()}
        onStop={stop}
        onExcite={(text) => {
          void excite(text);
        }}
      />
    </div>
  );
}
