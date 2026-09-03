import { useMemo, useState } from 'react';
import type { TeacherAgent } from '../teacher/TeacherAgent';
import type { PersistenceKind } from '../persistence/store';
import type { LearningEngine } from '../learning/useLearningEngine';
import type { BootstrapRecord } from '../teacher/bootstrap';
import {
  fetchDeployedBootstrap,
  importRecord as importBootstrapRecord,
  MAX_RECORD_BYTES
} from '../teacher/bootstrapLoader';
import { ChaperoneProgress } from './ChaperoneProgress';
import { MAX_CONCURRENCY } from '../teacher/chaperone';
import type { VoiceSettings } from '../speech/voiceSettings';
import { ELEVENLABS_DEFAULT_VOICE_ID } from '../speech/voiceSettings';
import {
  MODEL_SETTING_BOUNDS,
  DEFAULT_MODEL_SETTINGS,
  dueHorizonsFor,
  type SettingBound
} from '../observer/modelSettings';

export interface SettingsViewProps {
  teacher: TeacherAgent | null;
  engine: LearningEngine;
  persistenceKind: PersistenceKind;
  restoredCount: number;
  staleCount: number;
  onRecordImported: () => void;
  /** Voice (TTS) configuration — optional for backwards-compatible stubs. */
  voiceSettings?: VoiceSettings;
  onVoiceSettingsChange?: (next: VoiceSettings) => void;
}

/** Trigger a browser download for a blob. */
function downloadFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="text-sm font-medium text-slate-200">{title}</h2>
      {hint !== undefined && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

const FIELD =
  'rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-slate-600';

function Slider({
  label,
  hint,
  value,
  display,
  bound,
  onChange
}: {
  label: string;
  hint: string;
  value: number;
  display: string;
  bound: SettingBound;
  onChange: (next: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between">
        <span className="text-sm text-slate-300">{label}</span>
        <span className="font-mono text-xs text-slate-400">{display}</span>
      </span>
      <input
        type="range"
        min={bound.min}
        max={bound.max}
        step={bound.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
        className="mt-2 w-full accent-emerald-500"
      />
      <span className="mt-1 block text-xs text-slate-500">{hint}</span>
    </label>
  );
}

/** Provider configuration, definition backfill, voice, and learning-record I/O. */
export function SettingsView({
  teacher,
  engine,
  persistenceKind,
  restoredCount,
  staleCount,
  onRecordImported,
  voiceSettings,
  onVoiceSettingsChange
}: SettingsViewProps) {
  const [recordStatus, setRecordStatus] = useState('');

  const missingDefinitions = useMemo(
    () => (teacher?.listWords() ?? []).filter((entry) => entry.word.definition.trim().length === 0).length,
    [teacher, engine.revision]
  );

  const loadBootstrap = async () => {
    if (teacher === null) return;
    setRecordStatus('loading bootstrap.json…');
    try {
      const record = await fetchDeployedBootstrap();
      const result = await importBootstrapRecord(teacher, record, { markDeployed: true });
      setRecordStatus(
        `imported ${result.restored} traces (${result.conversations} conversation, ${result.definitions} definitions)` +
          `${result.stale > 0 ? `, ${result.stale} stale skipped` : ''}` +
          `${result.droppedWords > 0 ? `, ${result.droppedWords} words not in this deck` : ''} — saved in this browser`
      );
      onRecordImported();
    } catch (reason) {
      setRecordStatus(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const exportRecord = () => {
    if (teacher === null) return;
    // The app teaches the en-20000 deck (ACTIVE_DECK); the bootstrap loader
    // only accepts records trained on 'en-20000' or 'classroom', so a record
    // exported here must carry the same deck it can be re-imported under.
    const record = teacher.exportBootstrap('en-20000');
    downloadFile(
      `sentinel-record-${new Date().toISOString().slice(0, 10)}.json`,
      new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' })
    );
    setRecordStatus(`exported ${record.traces.length} traces (${record.definitions.length} definitions)`);
  };

  const importRecord = async (file: File) => {
    if (teacher === null) return;
    // A multi-hundred-MB file would freeze the main thread (or OOM a phone)
    // inside JSON.parse — refuse it before ever reading it.
    if (file.size > MAX_RECORD_BYTES) {
      setRecordStatus(
        `${file.name} is ${(file.size / 1024 / 1024).toFixed(0)}MB — too large to import safely (limit ${(
          MAX_RECORD_BYTES / 1024 / 1024
        ).toFixed(0)}MB)`
      );
      return;
    }
    setRecordStatus(`importing ${file.name}…`);
    try {
      const record = JSON.parse(await file.text()) as BootstrapRecord;
      const result = await importBootstrapRecord(teacher, record);
      setRecordStatus(
        `imported ${file.name}: ${result.restored} traces, ${result.definitions} definitions` +
          `${result.stale > 0 ? `, ${result.stale} stale skipped` : ''}` +
          `${result.droppedWords > 0 ? `, ${result.droppedWords} words not in this deck` : ''}`
      );
      onRecordImported();
    } catch (reason) {
      setRecordStatus(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const { settings, saveSettings } = engine;
  const { model, saveModel } = engine;
  const horizons = dueHorizonsFor(model.forgettingRate);
  const forgettingLabel =
    model.forgettingRate === 1
      ? 'default'
      : model.forgettingRate > 1
        ? `${model.forgettingRate}× slower`
        : `${(1 / model.forgettingRate).toFixed(2).replace(/\.?0+$/, '')}× faster`;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-8">
        <Section
          title="Teacher model"
          hint="An OpenAI-compatible endpoint. It writes definitions, proposes exchanges and grades answers. The key stays in this browser."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-xs text-slate-500">Endpoint URL</span>
              <input
                type="text"
                value={settings.endpoint}
                onChange={(event) => saveSettings({ ...settings, endpoint: event.target.value })}
                placeholder="https://api.openai.com/v1/chat/completions"
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-slate-500">Model</span>
              <input
                type="text"
                value={settings.model}
                onChange={(event) => saveSettings({ ...settings, model: event.target.value })}
                placeholder="gpt-4o-mini"
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-slate-500">API key</span>
              <input
                type="password"
                value={settings.apiKey}
                onChange={(event) => saveSettings({ ...settings, apiKey: event.target.value })}
                placeholder="sk-…"
                autoComplete="off"
                className={FIELD}
              />
            </label>
          </div>
          <p className={`mt-3 text-xs ${engine.configured ? 'text-emerald-400/80' : 'text-amber-300/80'}`}>
            {engine.configured
              ? `configured — up to ${MAX_CONCURRENCY} concurrent requests`
              : 'not configured — autonomous learning and grading are unavailable'}
          </p>
        </Section>

        <Section
          title="Memory and pacing"
          hint="These are read as the observer runs, so a change applies immediately — including to a learning loop already in progress."
        >
          <div className="space-y-5">
            <Slider
              label="Forgetting"
              hint={`A word falls due for review after ~${horizons.fresh.toFixed(0)} day${horizons.fresh >= 1.5 ? 's' : ''} freshly taught, ~${horizons.practised.toFixed(0)} days once practised, ~${horizons.consolidated.toFixed(0)} once consolidated.`}
              value={model.forgettingRate}
              display={forgettingLabel}
              bound={MODEL_SETTING_BOUNDS.forgettingRate}
              onChange={(forgettingRate) => saveModel({ ...model, forgettingRate })}
            />
            <Slider
              label="Review threshold"
              hint="Strength below which a word is scheduled for review. Higher means it reviews sooner and more often."
              value={model.reviewThreshold}
              display={model.reviewThreshold.toFixed(2)}
              bound={MODEL_SETTING_BOUNDS.reviewThreshold}
              onChange={(reviewThreshold) => saveModel({ ...model, reviewThreshold })}
            />
            <Slider
              label="New words per cycle"
              hint="How much new vocabulary each learning cycle introduces. Zero consolidates what it already has."
              value={model.wordsPerCycle}
              display={String(model.wordsPerCycle)}
              bound={MODEL_SETTING_BOUNDS.wordsPerCycle}
              onChange={(wordsPerCycle) => saveModel({ ...model, wordsPerCycle })}
            />
            <Slider
              label="Reviews per cycle"
              hint="How many due words are re-tested each cycle."
              value={model.reviewsPerCycle}
              display={String(model.reviewsPerCycle)}
              bound={MODEL_SETTING_BOUNDS.reviewsPerCycle}
              onChange={(reviewsPerCycle) => saveModel({ ...model, reviewsPerCycle })}
            />
            <Slider
              label="Pause between cycles"
              hint="Slower cycles leave the browser more responsive while learning runs."
              value={model.cyclePauseMs}
              display={`${model.cyclePauseMs} ms`}
              bound={MODEL_SETTING_BOUNDS.cyclePauseMs}
              onChange={(cyclePauseMs) => saveModel({ ...model, cyclePauseMs })}
            />
          </div>
          <div className="mt-5 flex items-center justify-between border-t border-slate-800 pt-4">
            <p className="max-w-md text-xs text-slate-600">
              The prime basis and vocabulary are deliberately not adjustable: a learning record is
              encoded against them, and changing one would decode every stored memory against a
              basis that no longer matches.
            </p>
            <button
              onClick={() => saveModel({ ...DEFAULT_MODEL_SETTINGS })}
              className="shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
            >
              Reset to defaults
            </button>
          </div>
        </Section>

        <Section
          title="Definitions"
          hint="Words without meaning content are learned by recognition only. Backfilling gives the observer something to understand."
        >
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={engine.runDefinitions}
              disabled={missingDefinitions === 0 || engine.definitionProgress?.phase === 'running'}
              className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:bg-slate-800 disabled:text-slate-500"
            >
              {engine.definitionProgress?.phase === 'running'
                ? 'Filling…'
                : `Fill definitions (${missingDefinitions.toLocaleString()})`}
            </button>
            <span className="text-xs text-slate-500">
              {missingDefinitions === 0 ? 'every word has meaning content' : `${missingDefinitions.toLocaleString()} words are missing definitions`}
            </span>
          </div>
          <ChaperoneProgress
            progress={engine.definitionProgress}
            result={engine.definitionResult}
            onCancel={engine.cancelDefinitions}
          />
        </Section>

        <Section title="Learning record" hint="The observer's memory is portable: export it, import it, or load the headlessly-trained bootstrap.">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void loadBootstrap()}
              disabled={teacher === null}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500 hover:text-slate-100 disabled:opacity-40"
            >
              Load bootstrap record
            </button>
            <button
              onClick={exportRecord}
              disabled={teacher === null}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500 hover:text-slate-100 disabled:opacity-40"
            >
              Export record
            </button>
            <label className="cursor-pointer rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500 hover:text-slate-100">
              Import record…
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) void importRecord(file);
                  event.target.value = '';
                }}
              />
            </label>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            {persistenceKind === 'indexeddb' ? 'Progress is saved across sessions.' : 'Session-only: no persistent storage available.'}
            {restoredCount > 0 ? ` ${restoredCount.toLocaleString()} memories restored.` : ''}
            {staleCount > 0 ? ` ${staleCount.toLocaleString()} stale memories reset for re-teaching.` : ''}
          </p>
          {recordStatus.length > 0 && <p className="mt-1.5 text-xs text-slate-400">{recordStatus}</p>}
        </Section>

        {voiceSettings !== undefined && onVoiceSettingsChange !== undefined && (
          <Section
            title="Voice"
            hint="Have the observer speak its answers aloud. Browser speech needs no account; ElevenLabs needs an API key, which is stored only in this browser and sent only to ElevenLabs."
          >
            <div className="space-y-4">
              <label className="flex items-center justify-between gap-4">
                <span className="text-sm text-slate-300">Speak answers aloud</span>
                <input
                  type="checkbox"
                  checked={voiceSettings.enabled}
                  onChange={(event) => onVoiceSettingsChange({ ...voiceSettings, enabled: event.target.checked })}
                  aria-label="Speak answers aloud"
                  className="h-4 w-4 accent-emerald-500"
                />
              </label>
              <div>
                <p className="text-sm text-slate-300">Voice engine</p>
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
                    <span className="text-sm text-slate-300">ElevenLabs API key</span>
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
                      className={`mt-1.5 w-full ${FIELD}`}
                      autoComplete="off"
                    />
                    <span className="mt-1 block text-xs text-slate-500">
                      Never committed or logged — stored in this browser only.
                    </span>
                  </label>
                  <label className="block">
                    <span className="text-sm text-slate-300">Voice id</span>
                    <input
                      value={voiceSettings.elevenlabs.voiceId}
                      onChange={(event) =>
                        onVoiceSettingsChange({
                          ...voiceSettings,
                          elevenlabs: { ...voiceSettings.elevenlabs, voiceId: event.target.value }
                        })
                      }
                      placeholder={ELEVENLABS_DEFAULT_VOICE_ID}
                      className={`mt-1.5 w-full ${FIELD}`}
                    />
                  </label>
                </div>
              )}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
