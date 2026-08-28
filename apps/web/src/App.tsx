import { Dashboard } from './components/Dashboard';
import { useObserver } from './observer/useObserver';

export default function App() {
  const { status, error, metrics, start, stop } = useObserver();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Dashboard status={status} error={error} metrics={metrics} onStart={() => void start()} onStop={stop} />
    </div>
  );
}
