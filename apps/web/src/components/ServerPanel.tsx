import { useCallback, useEffect, useMemo, useState } from 'react';
import { RemoteClient, type RemoteServerState, type RemoteWordEntry } from '../server/client';
import type { ObserverSignal } from '@sschepis/sentient-core';
import type { VoiceSettings } from '../speech/voiceSettings';
import { ELEVENLABS_DEFAULT_VOICE_ID } from '../speech/voiceSettings';
import { ChaperoneProgress } from './ChaperoneProgress';

/**
 * The remote-mode panels: server status, its live signal feed, and the
 * vocabulary the SERVER's observer holds — the model lives on the server,
 * so these views read it from there instead of a local teacher.
 */

export interface ServerPanelProps {
  client: RemoteClient;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  signals: ObserverSignal[];
  refresh: () => Promise<void>;
  /** The server's training loop stats (the ONLY trainer). */
  training: RemoteServerState['training'];
  trainingRunning: boolean;
}

function ServerPanel({ client, status, error, signals, refresh, training, trainingRunning }: ServerPanelProps) {
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState('');

  const saveNow = () => {
    setSaving(true);
    client
      .save()
      .then(() => {
        setSaveResult('saved');
        return refresh();
      })
      .catch((reason: unknown) => setSaveResult(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 border-b border-slate-800/80 px-6 py-4">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${status === 'ready' ? 'bg-emerald-400' : status === 'error' ? 'bg-rose-500' : 'bg-sky-400 animate-pulse'}`} />
          <h2 className="text-sm font-medium text-slate-200">Observer server</h2>
          <span className="ml-auto text-[11px] text-slate-500">{status === 'ready' ? 'the observer is learning on the server' : error ?? 'connecting…'}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => client.train(!trainingRunning).then(() => refresh())}
            disabled={status !== 'ready'}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
              trainingRunning
                ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
                : 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
            }`}
          >
            {trainingRunning ? 'Stop training' : 'Start training'}
          </button>
          <button
            onClick={saveNow}
            disabled={saving || status !== 'ready'}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save now'}
          </button>
          <button
            onClick={() => client.downloadSnapshot()}
            disabled={status !== 'ready'}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
          >
            Download trained model
          </button>
          <button
            onClick={() => client.wake().then(() => refresh())}
            disabled={status !== 'ready'}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
          >
            Wake
          </button>
          <button
            onClick={() => client.sleep().then(() => refresh())}
            disabled={status !== 'ready'}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
          >
            Sleep
          </button>
          {saveResult.length > 0 && <span className="text-xs text-slate-500">{saveResult}</span>}
        </div>
        <p className="text-[11px] leading-relaxed text-slate-600">
          The observer runs as a server process: it keeps learning while this page is closed, saves its model to disk
          regularly, and reloads the trained model when the server restarts. Reloading this page changes nothing — the
          model is not in the browser.
        </p>
        {training !== null && (
          <p className="text-[11px] text-slate-500">
            classroom: <span className="text-slate-300">{training.cycles} cycles</span> ·{' '}
            <span className="text-slate-300">{training.wordsTaught}</span> words taught ·{' '}
            <span className="text-slate-300">{training.wordsReviewed}</span> reviews ·{' '}
            <span className="text-slate-300">{training.phrasesTaught}</span> phrases ·{' '}
            <span className="text-slate-300">{training.drillsInduced}</span> rules induced
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">Live signals</h3>
        {signals.length === 0 ? (
          <p className="text-xs text-slate-600">Waiting for the server&apos;s signal stream…</p>
        ) : (
          <ul className="space-y-1">
            {[...signals].reverse().map((signal, index) => (
              <li key={`${signal.at}-${index}`} className="text-xs text-slate-500">
                <span className="text-slate-600">{new Date(signal.at).toLocaleTimeString()} </span>
                <span className="text-slate-400">{signal.kind}</span>
                <span className="text-slate-600"> · {String(signal.causeId ?? '')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export interface RemoteVocabularyProps {
  client: RemoteClient;
  /** Bumped externally when the server teaches (SSE-driven refresh). */
  revision: number;
}

export function RemoteVocabulary({ client, revision }: RemoteVocabularyProps) {
  const [words, setWords] = useState<RemoteWordEntry[]>([]);
  const [query, setQuery] = useState('');
  const [teachInput, setTeachInput] = useState('');
  const [teachStatus, setTeachStatus] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    client
      .words()
      .then((list) => {
        if (!cancelled) {
          setWords(list);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, revision]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return words.filter((entry) => needle.length === 0 || entry.word.toLowerCase().includes(needle));
  }, [words, query]);

  const taught = useMemo(() => words.filter((entry) => entry.traceId !== null).length, [words]);

  const teachWords = () => {
    const asked = [
      ...new Set(
        teachInput
          .toLowerCase()
          .split(/[,\s]+/)
          .map((word) => word.trim())
          .filter((word) => word.length > 0)
      )
    ];
    if (asked.length === 0) return;
    let stored = 0;
    void (async () => {
      for (const word of asked) {
        try {
          const result = await client.teachWord(word);
          if (result.traceId !== null) stored += 1;
        } catch {
          // Unknown words are rejected by the server — counted honestly below.
        }
      }
      setTeachStatus(`taught ${stored} word${stored === 1 ? '' : 's'} on the server · ${asked.length - stored} skipped`);
      setTeachInput('');
      await client.words().then(setWords).catch(() => {});
    })();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 border-b border-slate-800/80 px-6 py-3">
        <p className="text-[11px] text-slate-500">
          {loading ? 'loading…' : `${taught.toLocaleString()} of ${words.length.toLocaleString()} words taught — the server's vocabulary`}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the server's deck…"
            aria-label="Search the deck"
            className="w-56 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1 text-xs text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-slate-600"
          />
          <input
            type="text"
            value={teachInput}
            onChange={(event) => setTeachInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') teachWords();
            }}
            placeholder="Teach words (comma separated)…"
            aria-label="Teach specific words"
            className="w-72 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1 text-xs text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-slate-600"
          />
          <button
            onClick={teachWords}
            disabled={teachInput.trim().length === 0}
            className="rounded-lg bg-slate-800 px-3 py-1 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
          >
            Teach on server
          </button>
          {teachStatus.length > 0 && <span className="text-xs text-slate-500">{teachStatus}</span>}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul>
          {matches.slice(0, 200).map((entry) => (
            <li key={entry.word} className="flex items-center gap-4 border-b border-slate-900/70 px-6 py-2.5 hover:bg-slate-900/40">
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-sm text-slate-100">{entry.word}</span>
                  <span className={`text-[11px] uppercase tracking-wide ${entry.status === 'new' ? 'text-slate-500' : entry.status === 'consolidated' ? 'text-emerald-300' : 'text-sky-400'}`}>
                    {entry.status}
                  </span>
                </span>
                <span className={`mt-0.5 block truncate text-xs ${entry.definition.length > 0 ? 'text-slate-500' : 'italic text-slate-700'}`}>
                  {entry.definition.length > 0 ? entry.definition : 'no meaning content yet'}
                </span>
              </span>
              <span className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-slate-800">
                <span className="block h-full rounded-full bg-emerald-400" style={{ width: `${Math.round((entry.strength ?? 0) * 100)}%` }} />
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-xs text-slate-500">
                {entry.successes}✓ {entry.failures}✗
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export interface RemoteSettingsProps {
  url: string;
  saveUrl: (next: string) => void;
  client: RemoteClient;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  refresh: () => Promise<void>;
  voiceSettings?: VoiceSettings;
  onVoiceSettingsChange?: (next: VoiceSettings) => void;
}

/** Settings view in remote mode: where the observer server lives, and how to
 *  get the trained model out of it. */
export function RemoteSettings({
  url,
  saveUrl,
  client,
  status,
  error,
  refresh,
  voiceSettings,
  onVoiceSettingsChange
}: RemoteSettingsProps) {
  const [draft, setDraft] = useState(url);
  const [saved, setSaved] = useState(false);
  const [definitions, setDefinitions] = useState<{ running: boolean; progress: unknown; result: string | null } | null>(null);
  const [definitionsError, setDefinitionsError] = useState<string | null>(null);
  const [recordStatus, setRecordStatus] = useState('');

  const refreshDefinitions = useCallback(() => {
    if (status !== 'ready') return;
    client
      .definitions()
      .then(setDefinitions)
      .catch(() => {});
  }, [client, status]);

  useEffect(() => {
    refreshDefinitions();
    const id = setInterval(refreshDefinitions, 2000);
    return () => clearInterval(id);
  }, [refreshDefinitions]);

  const apply = () => {
    const next = draft.trim().replace(/\/$/, '');
    if (next.length === 0) return;
    saveUrl(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto px-6 py-5">
      <div>
        <h2 className="text-sm font-medium text-slate-200">Observer server</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          The observer runs as a server process, not in this browser. Its learning record is saved to disk regularly
          and restored on boot, so reloading this page — or restarting the server — reloads the model that has been
          training.
        </p>
      </div>
      <div className="space-y-2">
        <label className="block text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">Server URL</label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="w-80 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-100 outline-none transition focus:border-slate-600"
            placeholder="http://localhost:8787"
          />
          <button
            onClick={apply}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700"
          >
            {saved ? 'Saved' : 'Connect'}
          </button>
        </div>
        <p className="text-[11px] text-slate-600">
          {status === 'ready' ? 'connected — the observer is learning on the server' : error ?? 'not connected — the app runs the observer in this browser instead'}
        </p>
      </div>
      <div className="space-y-2">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">Trained model</h3>
        <button
          onClick={() => client.downloadSnapshot()}
          disabled={status !== 'ready'}
          className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
        >
          Download the trained model (bootstrap record)
        </button>
        <button
          onClick={() => client.save().then(() => refresh())}
          disabled={status !== 'ready'}
          className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
        >
          Save the model to disk now
        </button>
        <p className="text-[11px] leading-relaxed text-slate-600">
          The server also saves automatically on a timer and on shutdown. The download is the same record the batch
          trainer exports.
        </p>
        <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700">
          Import a record into the server…
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) {
                void file
                  .text()
                  .then((text) => JSON.parse(text) as unknown)
                  .then((record) => client.importRecord(record))
                  .then((summary) => {
                    setRecordStatus(`imported ${summary.restored} traces · ${summary.conversations} exchanges`);
                    return refresh();
                  })
                  .catch((reason: unknown) =>
                    setRecordStatus(reason instanceof Error ? reason.message : String(reason))
                  );
              }
              event.target.value = '';
            }}
          />
        </label>
        <button
          onClick={() => client.loadBootstrap().then(() => refresh()).catch(() => setRecordStatus('bootstrap load failed'))}
          disabled={status !== 'ready'}
          className="mt-2 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
        >
          Load the deployed bootstrap on the server
        </button>
        {recordStatus.length > 0 && <p className="mt-1.5 text-xs text-slate-500">{recordStatus}</p>}
      </div>
      <div className="space-y-2">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">Definition backfill</h3>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => client.startDefinitions().then(refreshDefinitions).catch((reason: unknown) => setDefinitionsError(reason instanceof Error ? reason.message : String(reason)))}
            disabled={status !== 'ready' || definitions?.running === true}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
          >
            Fill missing definitions (server)
          </button>
          {definitions?.running === true && (
            <button
              onClick={() => client.cancelDefinitions().then(refreshDefinitions)}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500"
            >
              Stop
            </button>
          )}
        </div>
        {definitionsError !== null && <p className="text-xs text-rose-400">{definitionsError}</p>}
        {definitions !== null && (
          <ChaperoneProgress progress={definitions.progress as never} result={definitions.result} onCancel={() => client.cancelDefinitions().then(refreshDefinitions)} />
        )}
      </div>
      {voiceSettings !== undefined && onVoiceSettingsChange !== undefined && (
        <div className="space-y-3">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">Voice</h3>
          <label className="flex items-center justify-between gap-4">
            <span className="text-xs text-slate-300">Speak answers aloud</span>
            <input
              type="checkbox"
              checked={voiceSettings.enabled}
              onChange={(event) => onVoiceSettingsChange({ ...voiceSettings, enabled: event.target.checked })}
              aria-label="Speak answers aloud"
              className="h-4 w-4 accent-emerald-500"
            />
          </label>
          <div>
            <p className="text-xs text-slate-300">Voice engine</p>
            <div className="mt-2 flex gap-2">
              {(['browser', 'elevenlabs'] as const).map((provider) => (
                <button
                  key={provider}
                  onClick={() => onVoiceSettingsChange({ ...voiceSettings, provider })}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                    voiceSettings.provider === provider
                      ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
                      : 'border-slate-700 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  {provider === 'browser' ? 'Browser speech' : 'ElevenLabs'}
                </button>
              ))}
            </div>
          </div>
          {voiceSettings.provider === 'elevenlabs' && (
            <div className="grid gap-3">
              <label className="block">
                <span className="text-xs text-slate-300">ElevenLabs API key</span>
                <input
                  type="password"
                  value={voiceSettings.elevenlabs.apiKey}
                  onChange={(event) =>
                    onVoiceSettingsChange({
                      ...voiceSettings,
                      elevenlabs: { ...voiceSettings.elevenlabs, apiKey: event.target.value }
                    })
                  }
                  placeholder="elevenlabs api key"
                  className="mt-1.5 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-slate-600"
                  autoComplete="off"
                />
                <span className="mt-1 block text-[11px] text-slate-500">Stored in this browser only; sent only to ElevenLabs.</span>
              </label>
              <label className="block">
                <span className="text-xs text-slate-300">Voice id</span>
                <input
                  value={voiceSettings.elevenlabs.voiceId}
                  onChange={(event) =>
                    onVoiceSettingsChange({
                      ...voiceSettings,
                      elevenlabs: { ...voiceSettings.elevenlabs, voiceId: event.target.value }
                    })
                  }
                  placeholder={ELEVENLABS_DEFAULT_VOICE_ID}
                  className="mt-1.5 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-slate-600"
                />
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ServerPanel;
