import { createRoot } from 'react-dom/client';
import { Buffer } from 'buffer';
import App from './App';
import './index.css';

// The tinyaleph crypto backend references Buffer; the semantic kernel only
// uses the oscillator/entropy surface, but the module graph is eager. Assign
// on globalThis so worker/SSR contexts also resolve it.
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

/**
 * THIS APP REGISTERS NO SERVICE WORKER — so if one is controlling the page,
 * it belongs to something else that once ran on this localhost port, and it
 * is actively harmful here. A service worker that caches responses cannot
 * cache an `text/event-stream`: `Cache.put()` throws
 * "encountered a network error", the intercepted request surfaces to the
 * page as 503, and the training feed and field metrics — everything that
 * arrives over the stream — never appear. A cached `/api/state` from an
 * older build is worse: the strip shows numbers that no longer come from
 * the running server at all.
 *
 * Localhost is one origin shared by every project that ever used the port,
 * and a registration outlives the app that made it. So: unregister anything
 * we find, once, and reload into a clean page.
 */
function evictForeignServiceWorkers(): void {
  if (!('serviceWorker' in navigator)) return;
  void navigator.serviceWorker
    .getRegistrations()
    .then(async (registrations) => {
      if (registrations.length === 0) return;
      const removed = await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
      if (!removed.some(Boolean)) return;
      // eslint-disable-next-line no-console
      console.warn(
        `[sentinel] unregistered ${removed.filter(Boolean).length} service worker(s) left on this origin by another app — they break the event stream. Reloading once.`
      );
      // One reload, and only when a worker was actually controlling us:
      // without a controller the page is already clean.
      if (navigator.serviceWorker.controller !== null) window.location.reload();
    })
    .catch(() => {
      // Nothing to do: an origin that refuses the query has no worker we
      // could remove either.
    });
}

evictForeignServiceWorkers();

createRoot(document.getElementById('root')!).render(<App />);
