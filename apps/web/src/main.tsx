import { createRoot } from 'react-dom/client';
import { Buffer } from 'buffer';
import App from './App';
import './index.css';

// The tinyaleph crypto backend references Buffer; the semantic kernel only
// uses the oscillator/entropy surface, but the module graph is eager. Assign
// on globalThis so worker/SSR contexts also resolve it.
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

createRoot(document.getElementById('root')!).render(<App />);
