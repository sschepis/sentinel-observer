import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TeacherAgent } from '../teacher/TeacherAgent';
import type { PersistenceStore } from '../persistence/store';
import {
  Chaperone,
  OpenAICompatProvider,
  NullChaperoneProvider,
  MAX_CONCURRENCY,
  semanticGrader,
  type ChaperoneSettings,
  type ChaperoneBatchResult
} from '../teacher/chaperone';
import type { ChaperoneProgressState } from '../components/ChaperoneProgress';
import { runAutonomousCycle } from '../teacher/autonomous';
import {
  loadModelSettings,
  saveModelSettings,
  type ModelSettings
} from '../observer/modelSettings';
import { fromAutonomousEvent, makeEvent, type LearningEvent } from './events';

const SETTINGS_KEY = 'sentinel-chaperone-settings';
/** How many events the stream keeps in memory. */
const MAX_EVENTS = 600;

export interface LearningStats {
  cycles: number;
  wordsTaught: number;
  wordsReviewed: number;
  phrasesTaught: number;
  llmCalls: number;
  selfAnswered: number;
  creativeScores: number[];
  /** Technical drills run, and how they came out. */
  drillsRun: number;
  drillsInduced: number;
  drillsMemorized: number;
  /** Held-out accuracy of the most recent drill, with its concept. */
  lastDrill: { concept: string; testAccuracy: number; verdict: string } | null;
}

const EMPTY_STATS: LearningStats = {
  cycles: 0,
  wordsTaught: 0,
  wordsReviewed: 0,
  phrasesTaught: 0,
  llmCalls: 0,
  selfAnswered: 0,
  creativeScores: [],
  drillsRun: 0,
  drillsInduced: 0,
  drillsMemorized: 0,
  lastDrill: null
};

export interface LearningEngine {
  settings: ChaperoneSettings;
  saveSettings: (next: ChaperoneSettings) => void;
  configured: boolean;
  /** Runtime model tuning (forgetting rate, pacing). */
  model: ModelSettings;
  saveModel: (next: ModelSettings) => void;
  /** Every learning event, oldest first. */
  events: LearningEvent[];
  clearEvents: () => void;
  running: boolean;
  stats: LearningStats;
  error: string | null;
  start: () => void;
  stop: () => void;
  /** Definition backfill (the Chaperone). */
  definitionProgress: ChaperoneProgressState | null;
  definitionResult: string | null;
  runDefinitions: () => void;
  cancelDefinitions: () => void;
  /** Bumped whenever the loop mutates the teacher, so views recompute. */
  revision: number;
}

function loadSettings(): ChaperoneSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw !== null) return JSON.parse(raw) as ChaperoneSettings;
  } catch {
    // Corrupt settings degrade to unconfigured.
  }
  return { endpoint: '', apiKey: '', model: 'gpt-4o-mini' };
}

/**
 * The learning engine: the autonomous classroom loop and the definition
 * backfill, owned OUTSIDE any view.
 *
 * This is the fix for the loop dying on navigation — the hook is mounted by
 * the app shell, so switching between chat and training never unmounts the
 * running loop. Views subscribe to `events`, `stats` and `running`.
 */
export function useLearningEngine(
  teacher: TeacherAgent | null,
  persistence: PersistenceStore,
  restoreEpoch: number
): LearningEngine {
  const [settings, setSettings] = useState<ChaperoneSettings>(loadSettings);
  const [model, setModel] = useState<ModelSettings>(loadModelSettings);
  const [events, setEvents] = useState<LearningEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<LearningStats>(EMPTY_STATS);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [definitionProgress, setDefinitionProgress] = useState<ChaperoneProgressState | null>(null);
  const [definitionResult, setDefinitionResult] = useState<string | null>(null);

  // Refs so the long-lived loop always reads current values without being
  // torn down and restarted on every render.
  const teacherRef = useRef(teacher);
  teacherRef.current = teacher;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const modelRef = useRef(model);
  modelRef.current = model;
  const loopAbortRef = useRef<AbortController | null>(null);
  const definitionAbortRef = useRef<AbortController | null>(null);
  /** Drills per concept, kept across cycles so the loop spreads out. */
  const drillCountsRef = useRef(new Map<string, number>());

  const configured = settings.endpoint.trim().length > 0;

  const push = useCallback((next: readonly LearningEvent[]) => {
    if (next.length === 0) return;
    setEvents((prev) => [...prev, ...next].slice(-MAX_EVENTS));
  }, []);

  const saveSettings = useCallback((next: ChaperoneSettings) => {
    setSettings(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // Settings are a convenience; a full quota must not break the app.
    }
  }, []);

  const clearEvents = useCallback(() => setEvents([]), []);

  const saveModel = useCallback((next: ModelSettings) => {
    setModel(saveModelSettings(next));
  }, []);

  // Tuning is read at the point of use, so it applies to a running loop.
  useEffect(() => {
    teacher?.setTuning({
      forgettingRate: model.forgettingRate,
      reviewThreshold: model.reviewThreshold
    });
  }, [teacher, model.forgettingRate, model.reviewThreshold]);

  // ── The autonomous classroom loop ────────────────────────────────────────
  const start = useCallback(() => {
    const agent = teacherRef.current;
    if (agent === null || loopAbortRef.current !== null) return;
    if (settingsRef.current.endpoint.trim().length === 0) {
      setError('Configure a teacher model endpoint in Settings before starting.');
      return;
    }

    const controller = new AbortController();
    loopAbortRef.current = controller;
    setRunning(true);
    setError(null);
    push([makeEvent({ kind: 'system', label: 'system', text: 'learning started' })]);

    void (async () => {
      const provider = new OpenAICompatProvider(settingsRef.current);
      const chaperone = new Chaperone(provider);
      const grader = semanticGrader(provider);
      try {
        while (!controller.signal.aborted) {
          const cycle = await runAutonomousCycle(agent, chaperone, grader, controller.signal, {
            drillCounts: drillCountsRef.current,
            wordsPerCycle: modelRef.current.wordsPerCycle,
            reviewsPerCycle: modelRef.current.reviewsPerCycle
          });
          if (controller.signal.aborted) break;
          const at = Date.now();
          push(cycle.events.map((event) => fromAutonomousEvent(event, at)));
          setStats((prev) => ({
            cycles: prev.cycles + 1,
            wordsTaught: prev.wordsTaught + cycle.wordsTaught,
            wordsReviewed: prev.wordsReviewed + cycle.wordsReviewed,
            phrasesTaught: prev.phrasesTaught + cycle.phrasesTaught,
            llmCalls: prev.llmCalls + cycle.llmCalls,
            selfAnswered: prev.selfAnswered + cycle.selfAnswered,
            creativeScores:
              cycle.creativeScore !== null
                ? [...prev.creativeScores, cycle.creativeScore].slice(-100)
                : prev.creativeScores,
            drillsRun: prev.drillsRun + (cycle.drill !== null ? 1 : 0),
            drillsInduced: prev.drillsInduced + (cycle.drill?.verdict === 'induced' || cycle.drill?.verdict === 'rule-induced' ? 1 : 0),
            drillsMemorized: prev.drillsMemorized + (cycle.drill?.verdict === 'memorized' ? 1 : 0),
            lastDrill:
              cycle.drill !== null
                ? {
                    concept: cycle.drill.concept,
                    testAccuracy: cycle.drill.testAccuracy,
                    verdict: cycle.drill.verdict
                  }
                : prev.lastDrill
          }));
          setRevision((n) => n + 1);
          await new Promise((resolve) => setTimeout(resolve, modelRef.current.cyclePauseMs));
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          const message = reason instanceof Error ? reason.message : String(reason);
          setError(message);
          push([makeEvent({ kind: 'error', label: 'error', text: message })]);
        }
      } finally {
        if (loopAbortRef.current === controller) loopAbortRef.current = null;
        setRunning(false);
        push([makeEvent({ kind: 'system', label: 'system', text: 'learning stopped' })]);
      }
    })();
  }, [push]);

  const stop = useCallback(() => {
    loopAbortRef.current?.abort();
  }, []);

  // ── Definition backfill ──────────────────────────────────────────────────
  const runDefinitions = useCallback(() => {
    const agent = teacherRef.current;
    if (agent === null || definitionAbortRef.current !== null) return;
    const target = agent.listWords().filter((w) => w.word.definition.trim().length === 0);
    if (target.length === 0) return;

    const current = settingsRef.current;
    const provider =
      current.endpoint.trim().length > 0 ? new OpenAICompatProvider(current) : new NullChaperoneProvider();
    const chaperone = new Chaperone(provider);
    const controller = new AbortController();
    definitionAbortRef.current = controller;

    const batchSize = 8;
    const totalBatches = Math.ceil(target.length / batchSize);
    const startedAt = Date.now();
    const feed: Array<{ word: string; definition: string }> = [];
    // Definitions are written to storage AS THEY ARRIVE, chained so the
    // writes never overlap. A run over thousands of words is long; closing
    // the tab halfway must not throw away what the model already answered
    // (it would all be re-requested on the next load).
    let writes: Promise<void> = Promise.resolve();

    const heartbeat = setInterval(() => {
      setDefinitionProgress((prev) => (prev === null ? prev : { ...prev, elapsedMs: Date.now() - startedAt }));
    }, 1000);

    setDefinitionProgress({
      phase: 'running',
      batchIndex: 0,
      totalBatches,
      wordsDone: 0,
      wordsTotal: target.length,
      generated: 0,
      skipped: 0,
      errors: 0,
      lastError: null,
      currentWords: [],
      startedAt,
      elapsedMs: 0,
      feed: []
    });
    setDefinitionResult(null);

    void (async () => {
      try {
        const run = await chaperone.fillDefinitions(target.map((w) => w.word), {
          batchSize,
          concurrency: MAX_CONCURRENCY,
          signal: controller.signal,
          onBatchStart: (words) => {
            setDefinitionProgress((prev) =>
              prev === null ? prev : { ...prev, currentWords: words, elapsedMs: Date.now() - startedAt }
            );
          },
          onBatch: (done: number, _total: number, batch: ChaperoneBatchResult) => {
            for (const entry of batch.definitions) {
              feed.unshift({ word: entry.word, definition: entry.definition });
            }
            if (batch.definitions.length > 0) {
              agent.applyDefinitions(batch.definitions);
              const saved = [...batch.definitions];
              writes = writes.then(() =>
                persistence.saveDefinitions(saved).catch((reason: unknown) => {
                  push([
                    makeEvent({
                      kind: 'error',
                      label: 'definitions',
                      text: `could not save ${saved.length} definitions: ${reason instanceof Error ? reason.message : String(reason)}`
                    })
                  ]);
                })
              );
              setRevision((n) => n + 1);
            }
            push(
              batch.definitions.map((entry) =>
                makeEvent({
                  kind: 'definition',
                  label: entry.word,
                  text: entry.definition,
                  detail: entry.example ?? null
                })
              )
            );
            setDefinitionProgress((prev) =>
              prev === null
                ? prev
                : {
                    ...prev,
                    phase: 'running',
                    batchIndex: prev.batchIndex + 1,
                    wordsDone: done,
                    generated: prev.generated + batch.definitions.length,
                    skipped: prev.skipped + batch.skipped.length,
                    currentWords: [],
                    elapsedMs: Date.now() - startedAt,
                    feed: [...feed].slice(0, 20)
                  }
            );
          },
          onBatchError: (done: number, _total: number, words: string[], reason: string) => {
            push([makeEvent({ kind: 'error', label: 'definitions', text: `${words.join(', ')} — ${reason}` })]);
            setDefinitionProgress((prev) =>
              prev === null
                ? prev
                : {
                    ...prev,
                    batchIndex: prev.batchIndex + 1,
                    wordsDone: done,
                    errors: prev.errors + 1,
                    lastError: { batch: Math.ceil(done / batchSize), words, message: reason },
                    currentWords: [],
                    elapsedMs: Date.now() - startedAt
                  }
            );
          }
        });

        if (run.definitions.length > 0) {
          // Batches already applied and saved themselves; this final pass
          // catches the retry-path entries and confirms the whole set.
          agent.applyDefinitions(run.definitions);
          writes = writes.then(() => persistence.saveDefinitions(run.definitions));
          setRevision((n) => n + 1);
        }
        await writes;

        const aborted = controller.signal.aborted;

        // The RELATIONS second pass over the newly-defined words: typed edges
        // the regex extractor cannot see (capable-of, used-for, causes, ...).
        // Disagreements become beliefs to verify, never silent overrides.
        let relationSummary: string | null = null;
        if (!aborted && run.definitions.length > 0) {
          try {
            const relationWords = target
              .filter((state) => run.definitions.some((d) => d.word === state.word.word))
              .map((state) => state.word);
            const relationsRun = await chaperone.fillRelations(relationWords, {
              batchSize: 8,
              concurrency: MAX_CONCURRENCY,
              signal: controller.signal
            });
            const relationApply = agent.applyRelations(relationsRun.relations);
            if (relationApply.accepted > 0 || relationApply.conflicts > 0) {
              relationSummary = `${relationApply.accepted} relation edges learned` +
                (relationApply.conflicts > 0 ? `, ${relationApply.conflicts} conflicts flagged for verification` : '');
              setRevision((n) => n + 1);
            }
          } catch (error) {
            push([
              makeEvent({
                kind: 'error',
                label: 'relations',
                text: `relations pass failed: ${error instanceof Error ? error.message : String(error)}`
              })
            ]);
          }
        }

        setDefinitionProgress((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                phase: 'done',
                currentWords: [],
                elapsedMs: Date.now() - startedAt,
                feed: [...feed].slice(0, 20),
                wordsDone: aborted ? prev.wordsDone : target.length
              }
        );
        setDefinitionResult(
          aborted
            ? `stopped early — ${run.definitions.length} definitions kept from this run`
            : `generated ${run.definitions.length} definitions${run.skipped.length > 0 ? `, skipped ${run.skipped.length}` : ''}${run.errors.length > 0 ? `, ${run.errors.length} failed batches` : ''}${relationSummary !== null ? ` · ${relationSummary}` : ''}`
        );
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setDefinitionProgress((prev) => (prev === null ? prev : { ...prev, phase: 'done', currentWords: [] }));
        setDefinitionResult(`definition run could not finish: ${message}`);
      } finally {
        // Even on failure, whatever the model already answered must land.
        await writes.catch(() => {});
        clearInterval(heartbeat);
        if (definitionAbortRef.current === controller) definitionAbortRef.current = null;
      }
    })();
  }, [persistence, push]);

  const cancelDefinitions = useCallback(() => {
    definitionAbortRef.current?.abort();
  }, []);

  // Abort both jobs if the whole app goes away.
  useEffect(
    () => () => {
      loopAbortRef.current?.abort();
      definitionAbortRef.current?.abort();
    },
    []
  );

  return useMemo(
    () => ({
      settings,
      saveSettings,
      configured,
      model,
      saveModel,
      events,
      clearEvents,
      running,
      stats,
      error,
      start,
      stop,
      definitionProgress,
      definitionResult,
      runDefinitions,
      cancelDefinitions,
      revision
    }),
    [
      settings,
      saveSettings,
      configured,
      model,
      saveModel,
      events,
      clearEvents,
      running,
      stats,
      error,
      start,
      stop,
      definitionProgress,
      definitionResult,
      runDefinitions,
      cancelDefinitions,
      revision
    ]
  );
}
