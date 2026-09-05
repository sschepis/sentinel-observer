import { useEffect, useMemo, useRef, useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { ChatView } from './components/ChatView';
import { RulesPanel } from './components/RulesPanel';
import { ModelStateBar } from './components/ModelStateBar';
import ServerPanel, { RemoteVocabulary, RemoteSettings } from './components/ServerPanel';
import { useChat } from './chat/useChat';
import { VoiceService, spokenAnswer } from './speech/voice';
import { loadVoiceSettings, saveVoiceSettings, type VoiceSettings } from './speech/voiceSettings';
import { RemoteClient, remoteChatTeacher } from './server/client';
import { useRemoteObserver } from './server/useRemoteObserver';

/**
 * The app is a PURE CLIENT. The observer — the model — lives exclusively in
 * a server-side persistent process: it trains there, persists there, and
 * restores there. This page sends user turns and feedback to the server and
 * renders the server's state; it never runs model activity of its own. The
 * only client-side state is UX: conversation transcripts, voice settings,
 * and the server URL.
 */

type View = 'chat' | 'training' | 'vocabulary' | 'rules' | 'mind' | 'settings';

const NAV: ReadonlyArray<{ key: View; label: string; icon: string; hint: string }> = [
  { key: 'chat', label: 'Chat', icon: '◍', hint: 'Talk to the observer' },
  { key: 'training', label: 'Training', icon: '⁘', hint: 'Watch it learn, live' },
  { key: 'vocabulary', label: 'Vocabulary', icon: '≡', hint: 'What it knows' },
  { key: 'rules', label: 'Rules', icon: '⌬', hint: 'Its procedures' },
  { key: 'mind', label: 'Mind', icon: '◎', hint: 'Raw observer physics' },
  { key: 'settings', label: 'Settings', icon: '⚙', hint: 'Server and voice' }
];

const VIEW_TITLE: Record<View, string> = {
  chat: 'Chat',
  training: 'Training',
  vocabulary: 'Vocabulary',
  rules: 'Rules',
  mind: "The observer's mind",
  settings: 'Settings'
};

/** Where the observer server lives (editable in Settings). */
const SERVER_URL_KEY = 'sentinel-server-url';
const DEFAULT_SERVER_URL = 'http://localhost:8787';

export default function App() {
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

  const connected = remoteAvailable === true && remote.status === 'ready';
  const remoteClient = remote.client;
  const remoteTeacher = useMemo(() => remoteChatTeacher(remoteClient), [remoteClient]);

  const [view, setView] = useState<View>('chat');
  const [summaryTick, setSummaryTick] = useState(0);
  const [voice] = useState(() => new VoiceService());
  const [voiceSettings, setVoiceSettingsState] = useState<VoiceSettings>(() => loadVoiceSettings());
  useEffect(() => {
    voice.configure(voiceSettings);
  }, [voice, voiceSettings]);

  // The chat hook talks to the server's observer exclusively. The chaperone
  // settings object is vestigial client-side plumbing: all grading happens
  // ON THE SERVER (gradeServerSide), so the client values are never used.
  const chat = useChat(
    remoteTeacher,
    { endpoint: '', apiKey: '', model: '' },
    () => setSummaryTick((n) => n + 1),
    (text) => {
      if (voiceSettings.enabled && voice.ttsAvailable()) voice.speak(spokenAnswer(text));
    }
  );

  // The rule panel reads the SERVER's rule store.
  const [rulesSnapshot, setRulesSnapshot] = useState<unknown>(null);
  const rulesRevision = useRef(0);
  useEffect(() => {
    if (view !== 'rules' || !connected) return;
    let cancelled = false;
    remoteClient
      .rules()
      .then((snapshot) => {
        if (!cancelled) {
          rulesRevision.current += 1;
          setRulesSnapshot(snapshot);
        }
      })
      .catch(() => {
        // The server rules read is best-effort; the panel shows its state.
      });
    return () => {
      cancelled = true;
    };
  }, [view, connected, remoteClient, summaryTick]);

  const summary = useMemo(() => {
    if (remote.server !== null) {
      return {
        learned: remote.server.learned,
        total: remote.server.total,
        competency: remote.server.competency,
        creativeUnlocked: remote.server.creativeUnlocked
      };
    }
    return { learned: 0, total: 0, competency: 0, creativeUnlocked: false };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote.server, summaryTick]);

  const trainingRunning = remote.server?.trainingRunning ?? false;

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
              {item.key === 'training' && trainingRunning && (
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
          <button
            onClick={() => {
              if (remote.server?.running === true) void remoteClient.sleep().then(() => remote.refresh());
              else void remoteClient.wake().then(() => remote.refresh());
            }}
            className="w-full rounded-lg border border-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-600 hover:text-slate-100"
          >
            {remote.server?.running === true ? 'Pause the server observer' : 'Resume the server observer'}
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
            Learning on the observer server
            {remote.server?.savedAt !== null && remote.server?.savedAt !== undefined
              ? ` · saved ${new Date(remote.server!.savedAt!).toLocaleTimeString()}`
              : ''}
          </p>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <ModelStateBar
          teacher={null}
          status={remote.status}
          learnedWords={summary.learned}
          totalWords={summary.total}
          competency={summary.competency}
          creativeUnlocked={summary.creativeUnlocked}
          learning={remote.server?.running ?? false}
          revision={0}
        />

        <div className="flex shrink-0 items-center gap-3 border-b border-slate-800/60 px-6 py-2.5">
          <h1 className="text-sm font-medium text-slate-200">{VIEW_TITLE[view]}</h1>
          <span className="flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 py-0.5 text-[11px] text-sky-300">
            <span className={`h-1.5 w-1.5 rounded-full ${remote.server?.running === true ? 'animate-pulse bg-sky-400' : 'bg-slate-500'}`} />
            observer server · {remote.server?.running === true ? 'learning' : 'paused'}
          </span>
          {view !== 'training' && trainingRunning && (
            <button
              onClick={() => setView('training')}
              className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] text-emerald-300 transition hover:bg-emerald-500/20"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              learning · {remote.server?.training?.cycles ?? 0} cycles
            </button>
          )}
        </div>

        {view === 'chat' && (
          <ChatView
            chat={chat}
            ready={connected}
            creativeUnlocked={summary.creativeUnlocked}
            voice={voice}
            onStartObserver={() => void remoteClient.wake().then(() => remote.refresh())}
          />
        )}

        {view === 'training' && (
          <ServerPanel
            client={remoteClient}
            status={remote.status}
            error={remote.error}
            signals={remote.signals}
            refresh={remote.refresh}
            training={remote.server?.training ?? null}
            trainingRunning={trainingRunning}
          />
        )}

        {view === 'vocabulary' && <RemoteVocabulary client={remoteClient} revision={summaryTick} />}

        {view === 'rules' && <RulesPanel snapshot={rulesSnapshot as never} />}

        {view === 'mind' && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Dashboard
              status={remote.status}
              error={remote.error}
              metrics={remote.metrics}
              lastStimulus={null}
              signals={remote.signals}
              onStart={() => void remoteClient.wake().then(() => remote.refresh())}
              onStop={() => void remoteClient.sleep().then(() => remote.refresh())}
            />
          </div>
        )}

        {view === 'settings' && (
          <RemoteSettings
            url={serverUrl}
            saveUrl={saveServerUrl}
            client={remoteClient}
            status={remote.status}
            error={remote.error}
            refresh={remote.refresh}
            voiceSettings={voiceSettings}
            onVoiceSettingsChange={(next) => {
              setVoiceSettingsState(next);
              saveVoiceSettings(next);
            }}
          />
        )}
      </main>
    </div>
  );
}
