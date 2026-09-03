import { useEffect, useMemo, useRef, useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { ChatView } from './components/ChatView';
import { TrainingView } from './components/TrainingView';
import { VocabularyView } from './components/VocabularyView';
import { RulesPanel, ruleStoreSnapshot } from './components/RulesPanel';
import { SettingsView } from './components/SettingsView';
import { ModelStateBar } from './components/ModelStateBar';
import ServerPanel, { RemoteVocabulary, RemoteSettings } from './components/ServerPanel';
import { TeacherAgent } from './teacher/TeacherAgent';
import { ACTIVE_DECK } from './teacher/decks';
import { createPersistenceStore } from './persistence/store';
import { useObserver } from './observer/useObserver';
import { OBSERVER_OPTIONS } from './observer/options';
import { useLearningEngine } from './learning/useLearningEngine';
import { useChat } from './chat/useChat';
import { VoiceService, spokenAnswer } from './speech/voice';
import { fromEpisodicFact } from './learning/events';
import { RemoteClient, remoteChatTeacher } from './server/client';
import { useRemoteObserver } from './server/useRemoteObserver';
import {
  fetchDeployedBootstrap,
  importRecord,
  shouldAutoImportBootstrap
} from './teacher/bootstrapLoader';

/**
 * Phase-2/3 encoding: a 256-prime field, whole-word prime signatures for the
 * deck, and the COMPACT memory bank (lean traces + prefiltered recall — the
 * scale substrate measured at 99% accuracy over 500 words). The options are
 * shared with the batch trainer (observer/options.ts) so trained records
 * always restore against the same prime basis.
 */

type View = 'chat' | 'training' | 'vocabulary' | 'rules' | 'mind' | 'settings';

const NAV: ReadonlyArray<{ key: View; label: string; icon: string; hint: string }> = [
  { key: 'chat', label: 'Chat', icon: '◍', hint: 'Talk to the observer' },
  { key: 'training', label: 'Training', icon: '⁘', hint: 'Watch it learn, live' },
  { key: 'vocabulary', label: 'Vocabulary', icon: '≡', hint: 'What it knows' },
  { key: 'rules', label: 'Rules', icon: '⌬', hint: 'Its procedures' },
  { key: 'mind', label: 'Mind', icon: '◎', hint: 'Raw observer physics' },
  { key: 'settings', label: 'Settings', icon: '⚙', hint: 'Teacher model and records' }
];

const VIEW_TITLE: Record<View, string> = {
  chat: 'Chat',
  training: 'Training',
  vocabulary: 'Vocabulary',
  rules: 'Rules',
  mind: "The observer's mind",
  settings: 'Settings'
};

/** How often the summary strip is recomputed (each pass is a full deck scan). */
const SUMMARY_INTERVAL_MS = 3000;

/** Bounded retries for the learning-record restore (exponential backoff). */
const RESTORE_MAX_ATTEMPTS = 3;
const RESTORE_RETRY_BASE_MS = 1000;

/** Where the observer server lives (editable in Settings). When the server
 *  is unreachable the app honestly degrades to the in-browser observer. */
const SERVER_URL_KEY = 'sentinel-server-url';
const DEFAULT_SERVER_URL = 'http://localhost:8787';

export default function App() {
  // One store per app lifetime (stable identity — the hook and teacher share it).
  const persistence = useRef(createPersistenceStore());
  const { session, status, error, metrics, start, stop, lastStimulus, signals, diarySignals } =
    useObserver(persistence.current, OBSERVER_OPTIONS);

  // ── The observer server (remote mode) ────────────────────────────────────
  // The observer may run as a server process instead of in this browser.
  // The app probes the configured URL once; when reachable, the server IS
  // the observer (chat, dashboard, vocabulary, training all read it), and
  // the in-browser observer above is never started.
  const [serverUrl, setServerUrl] = useState<string>(() => {
    try {
      return localStorage.getItem(SERVER_URL_KEY) ?? DEFAULT_SERVER_URL;
    } catch {
      return DEFAULT_SERVER_URL;
    }
  });
  const saveServerUrl = (next: string) => {
    setServerUrl(next);
    try {
      localStorage.setItem(SERVER_URL_KEY, next);
    } catch {
      // A convenience; a quota failure must not break the app.
    }
  };
  const remote = useRemoteObserver(serverUrl);
  const [remoteAvailable, setRemoteAvailable] = useState<boolean | null>(null);
  const [probeEpoch, setProbeEpoch] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setRemoteAvailable(null);
    RemoteClient.probe(serverUrl).then(
      () => {
        if (!cancelled) setRemoteAvailable(true);
      },
      () => {
        if (!cancelled) setRemoteAvailable(false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [serverUrl, probeEpoch]);

  useEffect(() => {
    if (remoteAvailable === true) {
      remote.connect();
    } else if (remoteAvailable === false) {
      remote.disconnect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteAvailable]);
  const serverMode = remoteAvailable === true && remote.status === 'ready';
  const remoteClient = remote.client;
  const remoteTeacher = useMemo(() => remoteChatTeacher(remoteClient), [remoteClient]);

  const [view, setView] = useState<View>('chat');
  const [restored, setRestored] = useState(0);
  const [staleCount, setStaleCount] = useState(0);
  // Bumped whenever the async learning-record restore (traces, word states,
  // chaperoned definitions) completes, and whenever a record is imported.
  const [restoreEpoch, setRestoreEpoch] = useState(0);
  const [summaryTick, setSummaryTick] = useState(0);
  const [voice] = useState(() => new VoiceService());
  // W6: a per-session composition seed (P5 determinism). The browser session
  // gets ONE seed for its lifetime, so the same conversation state reproduces
  // the same creative sentence within the session — the PRNG is never the
  // bare Math.random the composition layer used to run on. A fresh session
  // draws a fresh seed (variety across sessions); the batch/bench CLIs pass
  // fixed seeds for cross-run reproducibility.
  const compositionSeed = useRef<number | null>(null);
  if (compositionSeed.current === null) {
    compositionSeed.current = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  }

  // The teacher exists only when the observer (the learner) is running.
  // R7: rules mode is the shipped behavior — the drill loop (when the
  // learning engine runs drills) routes memorized drills to rewrite-rule
  // synthesis with a DSL fallback for families the engine does not own.
  const teacher = useMemo(
    () =>
      session !== null
        ? new TeacherAgent(session, ACTIVE_DECK, persistence.current, 1, undefined, compositionSeed.current!, undefined, undefined, undefined, true)
        : null,
    [session]
  );

  const ready = serverMode ? true : status === 'ready' || status === 'degraded';

  // The learning loop is owned HERE, not by a view — switching pages never
  // unmounts it, so learning continues while the human chats or browses.
  // In remote mode the observer learns ON THE SERVER (its own continuous
  // process); this loop stays idle because the local teacher is null.
  const engine = useLearningEngine(teacher, persistence.current, restoreEpoch);

  const chat = useChat(
    serverMode ? remoteTeacher : teacher,
    engine.settings,
    () => setSummaryTick((n) => n + 1),
    (text) => {
      // Speak only the first sentence — a recalled trace is "word: definition.
      // example", and reading the whole raw content aloud is a wall of words.
      if (voice.ttsAvailable) voice.speak(spokenAnswer(text));
    },
    // The observer's new long-term memories land in the training stream as
    // "remembers" events — the human sees what it chose to remember.
    (facts) => {
      for (const fact of facts) engine.pushEvent(fromEpisodicFact(fact));
    }
  );

  // Restore the observer's learning record once the learner is awake. A
  // transient IndexedDB failure must not leave the session unrestored: the
  // guard is reset and the restore retried with exponential backoff (up to
  // RESTORE_MAX_ATTEMPTS), then given up with a visible warning.
  const restoreGuard = useRef(false);
  useEffect(() => {
    if (teacher === null || !ready || restoreGuard.current) return;
    restoreGuard.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const attempt = async () => {
      if (cancelled) return;
      try {
        const result = await teacher.restoreFromPersistence();
        setRestored(result.restored);
        setStaleCount(result.stale);
        // Chaperoned definitions load AFTER the teacher exists; applying
        // them upgrades word-only words to full learning.
        const definitions = await persistence.current.loadDefinitions();
        if (definitions.length > 0) teacher.applyDefinitions(definitions);
        setRestoreEpoch((n) => n + 1);
      } catch (reason) {
        if (cancelled) return;
        attempts += 1;
        if (attempts < RESTORE_MAX_ATTEMPTS) {
          console.warn(
            `learning-record restore failed (attempt ${attempts}/${RESTORE_MAX_ATTEMPTS}) — retrying`,
            reason
          );
          timer = setTimeout(() => {
            void attempt();
          }, RESTORE_RETRY_BASE_MS * 2 ** (attempts - 1));
        } else {
          // Give up: reset the guard so a later sleep/wake cycle (a changed
          // teacher or ready) can retry from scratch — the session is never
          // permanently locked out of restoring.
          restoreGuard.current = false;
          console.warn('learning-record restore failed after 3 attempts — starting fresh', reason);
          setRestored(0);
          setStaleCount(0);
        }
      }
    };
    void attempt();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      // A dep change (new teacher, readiness change) restarts the attempt
      // budget instead of inheriting a stale in-flight guard.
      restoreGuard.current = false;
    };
  }, [teacher, ready]);

  useEffect(() => {
    if (teacher === null) return;
    const id = setInterval(() => setSummaryTick((n) => n + 1), SUMMARY_INTERVAL_MS);
    return () => clearInterval(id);
  }, [teacher]);

  // The record trained headlessly (npm run train) is imported automatically
  // when this browser has learned nothing yet, or when a newer record has
  // been deployed since the last import. Gated on the restore so a fresh
  // page never mistakes "not loaded yet" for "nothing learned".
  const bootstrapGuard = useRef(false);
  useEffect(() => {
    if (teacher === null || restoreEpoch <= 0 || bootstrapGuard.current) return;
    bootstrapGuard.current = true;
    void (async () => {
      try {
        if (!(await shouldAutoImportBootstrap(teacher))) return;
        const record = await fetchDeployedBootstrap();
        await importRecord(teacher, record, { markDeployed: true });
        setRestoreEpoch((n) => n + 1);
      } catch (reason) {
        // No deployed record is a normal state, not a failure.
        console.info('no bootstrap record imported', reason);
      }
    })();
  }, [teacher, restoreEpoch]);

  // Writes are coalesced, so a page that goes away mid-window would drop the
  // pending save. 'pagehide' and the hidden visibility state are the two
  // events that actually fire on mobile Safari and on tab close.
  useEffect(() => {
    if (teacher === null) return;
    const flush = () => {
      void teacher.flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, [teacher]);

  const sleep = () => {
    engine.stop();
    void teacher?.flush();
    stop();
  };

  const summary = useMemo(() => {
    if (serverMode && remote.server !== null) {
      return {
        learned: remote.server.learned,
        total: remote.server.total,
        competency: remote.server.competency,
        creativeUnlocked: remote.server.creativeUnlocked
      };
    }
    if (teacher === null) return { learned: 0, total: ACTIVE_DECK.length, competency: 0, creativeUnlocked: false };
    const words = teacher.listWords();
    const report = teacher.conversationReport();
    return {
      learned: words.filter((entry) => entry.traceId !== null).length,
      total: words.length,
      competency: report.competency,
      creativeUnlocked: report.creativeUnlocked
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher, restoreEpoch, summaryTick, serverMode, remote.server]);

  return (
    <div className="flex h-full bg-slate-950 text-slate-100">
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-800/80 bg-slate-950">
        <div className="flex items-center gap-2.5 px-5 py-4">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/15 text-sm text-emerald-300">
            ◈
          </span>
          <span className="text-sm font-semibold tracking-tight text-slate-100">Sentinel</span>
        </div>

        <nav className="space-y-0.5 px-3">
          {NAV.map((item) => (
            <button
              key={item.key}
              onClick={() => setView(item.key)}
              aria-current={view === item.key ? 'page' : undefined}
              title={item.hint}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                view === item.key
                  ? 'bg-slate-800/80 font-medium text-slate-100'
                  : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
              }`}
            >
              <span className="w-4 text-center text-xs opacity-70">{item.icon}</span>
              {item.label}
              {item.key === 'training' && engine.running && (
                <span className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              )}
            </button>
          ))}
        </nav>

        {view === 'chat' && (
          <div className="mt-5 flex min-h-0 flex-1 flex-col border-t border-slate-800/60 pt-4">
            <div className="flex items-center justify-between px-5 pb-2">
              <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">Conversations</span>
              <button
                onClick={chat.newConversation}
                title="New conversation"
                aria-label="New conversation"
                className="flex h-5 w-5 items-center justify-center rounded text-slate-500 transition hover:bg-slate-800 hover:text-slate-200"
              >
                +
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {chat.conversations.length === 0 ? (
                <p className="px-2 py-1 text-xs text-slate-600">No conversations yet.</p>
              ) : (
                [...chat.conversations].reverse().map((conversation) => (
                  <div
                    key={conversation.id}
                    className={`group flex items-center rounded-lg transition ${
                      conversation.id === chat.activeId ? 'bg-slate-800/80' : 'hover:bg-slate-900'
                    }`}
                  >
                    <button
                      onClick={() => chat.selectConversation(conversation.id)}
                      className={`min-w-0 flex-1 truncate px-3 py-2 text-left text-sm ${
                        conversation.id === chat.activeId ? 'text-slate-100' : 'text-slate-400'
                      }`}
                      title={conversation.title}
                    >
                      {conversation.title}
                    </button>
                    <button
                      onClick={() => chat.removeConversation(conversation.id)}
                      aria-label={`Delete ${conversation.title}`}
                      className="mr-1.5 hidden h-5 w-5 shrink-0 items-center justify-center rounded text-slate-600 transition hover:bg-slate-700 hover:text-slate-200 group-hover:flex"
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        <div className={`${view === 'chat' ? '' : 'mt-auto'} border-t border-slate-800/60 px-5 py-3`}>
          {serverMode ? (
            <button
              onClick={() => {
                if (remote.server?.running === true) void remoteClient.sleep().then(() => remote.refresh());
                else void remoteClient.wake().then(() => remote.refresh());
              }}
              className="w-full rounded-lg border border-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-600 hover:text-slate-100"
            >
              {remote.server?.running === true ? 'Pause the server observer' : 'Resume the server observer'}
            </button>
          ) : (
            <button
              onClick={() => (ready ? sleep() : void start())}
              disabled={status === 'loading'}
              className="w-full rounded-lg border border-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-600 hover:text-slate-100 disabled:opacity-40"
            >
              {status === 'loading' ? 'Waking…' : ready ? 'Put the observer to sleep' : 'Wake the observer'}
            </button>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
            {serverMode
              ? `Learning on the observer server${remote.server?.savedAt !== null ? ` · saved ${new Date(remote.server!.savedAt!).toLocaleTimeString()}` : ''}`
              : persistence.current.kind === 'indexeddb'
                ? 'Memory saved in this browser'
                : 'Session-only memory'}
            {!serverMode && restored > 0 ? ` · ${restored.toLocaleString()} restored` : ''}
          </p>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <ModelStateBar
          teacher={serverMode ? null : teacher}
          status={serverMode ? remote.status : status}
          learnedWords={summary.learned}
          totalWords={summary.total}
          competency={summary.competency}
          creativeUnlocked={summary.creativeUnlocked}
          learning={serverMode ? (remote.server?.running ?? false) : engine.running}
          revision={engine.revision}
        />

        <div className="flex shrink-0 items-center gap-3 border-b border-slate-800/60 px-6 py-2.5">
          <h1 className="text-sm font-medium text-slate-200">{VIEW_TITLE[view]}</h1>
          {serverMode && (
            <span className="flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 py-0.5 text-[11px] text-sky-300">
              <span className={`h-1.5 w-1.5 rounded-full ${remote.server?.running === true ? 'animate-pulse bg-sky-400' : 'bg-slate-500'}`} />
              observer server · {remote.server?.running === true ? 'learning' : 'paused'}
            </span>
          )}
          {!serverMode && view !== 'training' && engine.running && (
            <button
              onClick={() => setView('training')}
              className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] text-emerald-300 transition hover:bg-emerald-500/20"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              learning · {engine.stats.cycles} cycles
            </button>
          )}
        </div>

        {view === 'chat' && (
          <ChatView
            chat={chat}
            ready={ready}
            creativeUnlocked={summary.creativeUnlocked}
            voice={voice}
            onStartObserver={() => (serverMode ? void remoteClient.wake().then(() => remote.refresh()) : void start())}
          />
        )}

        {view === 'training' &&
          (serverMode ? (
            <ServerPanel
              client={remoteClient}
              status={remote.status}
              error={remote.error}
              signals={remote.signals}
              refresh={remote.refresh}
            />
          ) : (
            <TrainingView
              engine={engine}
              diarySignals={diarySignals}
              ready={ready}
              onStartObserver={() => void start()}
              onOpenSettings={() => setView('settings')}
            />
          ))}

        {view === 'vocabulary' &&
          (serverMode ? (
            <RemoteVocabulary client={remoteClient} revision={summaryTick} />
          ) : (
            <VocabularyView teacher={teacher} revision={summaryTick + engine.revision} />
          ))}

        {view === 'rules' &&
          (serverMode ? (
            <div className="mx-auto w-full max-w-4xl px-6 py-8 text-sm text-slate-500">
              The observer&apos;s rule store lives on the server; open the local mode to inspect its rules.
            </div>
          ) : (
            <RulesPanel
              snapshot={
                teacher !== null ? ruleStoreSnapshot(teacher) : null
              }
            />
          ))}

        {view === 'mind' && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Dashboard
              status={serverMode ? remote.status : status}
              error={serverMode ? remote.error : error}
              metrics={serverMode ? remote.metrics : metrics}
              lastStimulus={serverMode ? null : lastStimulus}
              signals={serverMode ? remote.signals : signals}
              onStart={() => (serverMode ? void remoteClient.wake().then(() => remote.refresh()) : void start())}
              onStop={() => (serverMode ? void remoteClient.sleep().then(() => remote.refresh()) : sleep())}
            />
          </div>
        )}

        {view === 'settings' &&
          (serverMode ? (
            <RemoteSettings
              url={serverUrl}
              saveUrl={saveServerUrl}
              client={remoteClient}
              status={remote.status}
              error={remote.error}
              refresh={remote.refresh}
            />
          ) : (
            <SettingsView
              teacher={teacher}
              engine={engine}
              persistenceKind={persistence.current.kind}
              restoredCount={restored}
              staleCount={staleCount}
              onRecordImported={() => setRestoreEpoch((n) => n + 1)}
            />
          ))}
      </main>
    </div>
  );
}
