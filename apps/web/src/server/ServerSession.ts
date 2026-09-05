import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ObserverSignal, SemanticObserverState } from '@sschepis/sentient-core';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation';
import { FilePersistenceStore } from './FilePersistenceStore';
import type { BootstrapRecord } from '../teacher/bootstrap';
import { assertVocabularyCompatible } from '../teacher/bootstrapLoader';
import { TrainingLoop, EMPTY_TRAINING_STATS, type TrainingStats } from './trainingLoop';
import {
  Chaperone,
  NullChaperoneProvider,
  OpenAICompatProvider,
  semanticGrader,
  type ChaperoneSettings
} from '../teacher/chaperone';
import { DefinitionsRunner } from './definitionsRunner';
import { ruleStoreSnapshot } from '../components/RulesPanel';
import type { ChaperoneProgressState } from '../components/ChaperoneProgress';
import type { LearningEvent } from '../learning/events';

/**
 * The server-side observer: a long-lived ObserverSession + TeacherAgent that
 * keeps ticking while no browser is connected, persists its learning record
 * to disk on a timer (and on every shutdown), and restores it on boot —
 * reloading the page (or the server) reloads the model that has been
 * training, not a fresh one.
 *
 * Boot order (first hit wins):
 *   1. the on-disk learning record (FilePersistenceStore),
 *   2. a bootstrap record path given at startup (the shipped trained model),
 *   3. a fresh core: `words` deck words + the conversation deck.
 */

export interface ServerSessionOptions {
  dataDir: string;
  /** Bootstrap record to import when the disk has no learning record. */
  bootstrapPath?: string;
  /** Fresh-train fallback: deck words to teach (0 = skip fresh training). */
  words?: number;
  /** Include the conversation phrase deck in the fresh fallback. */
  conversation?: boolean;
  /** Autosave period in ms (the model is also saved on shutdown). */
  autosaveMs?: number;
  /** Determinism seed for the composition PRNG (absent: Math.random). */
  compositionSeed?: number;
  /** Start the continuous tick loop at boot (default true). Disabled by the
   *  parity gate so both arms measure from the identical restored state with
   *  zero background ticks — the restore itself is what is being gated. */
  tickImmediately?: boolean;
  /** Run the autonomous classroom training loop at boot (default true). */
  train?: boolean;
  /** Pause between training cycles (default 400 ms). */
  trainCadenceMs?: number;
  /** Chaperone settings for LLM-assisted training steps (server-configured —
   *  never browser state; absent = the deterministic steps only). */
  chaperone?: ChaperoneSettings;
}

export interface ServerSnapshot {
  kind: 'snapshot';
  at: number;
  /** Total traces in the serialized record. */
  traces: number;
  /** Deck stamp of the record. */
  deck: string;
  bytes: number;
}

export type ServerEvent =
  | { kind: 'metrics'; at: number; state: SemanticObserverState }
  | { kind: 'signal'; signal: ObserverSignal }
  | { kind: 'snapshot'; snapshot: ServerSnapshot }
  | { kind: 'lifecycle'; at: number; event: 'booted' | 'saved' | 'shutdown' | 'sleep' | 'wake'; detail: string }
  | { kind: 'learning'; at: number; events: readonly LearningEvent[] };

export interface ServerState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  running: boolean;
  restored: number;
  freshTrained: boolean;
  learned: number;
  total: number;
  competency: number;
  creativeUnlocked: boolean;
  savedAt: number | null;
  lastSaveMs: number | null;
  modelPath: string | null;
  tracesInModel: number;
  tickCount: number;
  /** The autonomous classroom loop (the ONLY trainer — the browser never
   *  trains). Null until the server boots with training enabled. */
  training: TrainingStats | null;
  /** Whether the loop is actively cycling right now. */
  trainingRunning: boolean;
  /** True when a chaperone endpoint is configured (server-side only). */
  chaperoneConfigured: boolean;
  /** The definitions backfill run (server-side; the browser's is gone). */
  definitions: { running: boolean; progress: ChaperoneProgressState | null; result: string | null } | null;
}

export class ServerSession {
  readonly store: FilePersistenceStore;
  session: ObserverSession | null = null;
  teacher: TeacherAgent | null = null;

  private readonly options: Required<ServerSessionOptions>;
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private signalUnsubscribe: (() => void) | null = null;
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private restored = 0;
  private freshTrained = false;
  private savedAt: number | null = null;
  private lastSaveMs: number | null = null;
  private modelPath: string | null = null;
  private status: ServerState['status'] = 'idle';
  private errorMessage: string | null = null;
  private saveChain: Promise<unknown> = Promise.resolve();

  constructor(options: ServerSessionOptions) {
    this.options = {
      dataDir: options.dataDir,
      bootstrapPath: options.bootstrapPath ?? '',
      words: options.words ?? 200,
      conversation: options.conversation ?? true,
      autosaveMs: options.autosaveMs ?? 30000,
      compositionSeed: options.compositionSeed ?? 0,
      tickImmediately: options.tickImmediately ?? true,
      train: options.train ?? true,
      trainCadenceMs: options.trainCadenceMs ?? 400,
      chaperone: options.chaperone ?? { endpoint: '', apiKey: '', model: '' }
    };
    this.store = new FilePersistenceStore(this.options.dataDir);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private broadcast(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber (e.g. a closed SSE socket) must not kill the loop.
      }
    }
  }

  private trainingLoop: TrainingLoop | null = null;
  private definitionsRunner: DefinitionsRunner | null = null;

  async boot(): Promise<ServerState> {
    this.status = 'loading';
    const session = new ObserverSession(OBSERVER_OPTIONS, 250);
    this.session = session;
    await session.initialize();
    const teacher = new TeacherAgent(
      session,
      ACTIVE_DECK,
      this.store,
      1,
      undefined,
      this.options.compositionSeed !== 0 ? this.options.compositionSeed : undefined,
      undefined,
      undefined,
      undefined,
      // R7: rules mode is the shipped behavior. On the server the flag is
      // inert today (no drills run server-side; chat 2.7 derivation is
      // unconditional) — kept true for parity with the browser and for
      // future drill-driven server maintenance.
      true
    );
    this.teacher = teacher;

    const restored = await teacher.restoreFromPersistence();
    this.restored = restored.restored;

    if (restored.restored > 0) {
      const definitions = await this.store.loadDefinitions();
      if (definitions.length > 0) teacher.applyDefinitions(definitions);
    } else if (this.options.bootstrapPath.length > 0 && existsSync(this.options.bootstrapPath)) {
      const record = JSON.parse(readFileSync(this.options.bootstrapPath, 'utf8')) as BootstrapRecord;
      assertVocabularyCompatible(record);
      const imported = teacher.importBootstrap(record);
      this.restored = imported.restored;
      await teacher.persistAll();
    } else if (this.options.words > 0) {
      for (const entry of ACTIVE_DECK.slice(0, this.options.words)) teacher.teach(entry.word);
      if (this.options.conversation) {
        teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS);
        for (const pair of ALL_CONVERSATION_PAIRS) teacher.respond(pair.cue);
      }
      this.freshTrained = true;
      await teacher.flush();
    }

    this.signalUnsubscribe = session.onSignal((signal) => {
      this.broadcast({ kind: 'signal', signal });
    });

    if (this.options.tickImmediately) {
      session.start((state) => {
        this.broadcast({ kind: 'metrics', at: Date.now(), state });
      });
      this.running = true;
    }

    if ((this.options.train ?? true) && this.teacher !== null) {
      this.trainingLoop = new TrainingLoop(this.teacher, {
        settings: this.options.chaperone ?? { endpoint: '', apiKey: '', model: '' },
        cadenceMs: this.options.trainCadenceMs ?? 400,
        onEvents: (events) => this.broadcast({ kind: 'learning', at: Date.now(), events }),
        onError: (message) =>
          this.broadcast({ kind: 'lifecycle', at: Date.now(), event: 'booted', detail: `training error: ${message}` })
      });
      this.trainingLoop.start();
    }

    this.autosaveTimer = setInterval(() => {
      void this.saveNow('interval').catch(() => {});
    }, this.options.autosaveMs);
    // The autosave cadence must never keep a process alive: the model is
    // also saved on shutdown, so an unref'd timer costs nothing.
    this.autosaveTimer.unref?.();

    this.status = 'ready';
    this.broadcast({
      kind: 'lifecycle',
      at: Date.now(),
      event: 'booted',
      detail: `restored ${this.restored} traces${this.freshTrained ? ' (fresh core trained)' : ''}`
    });
    await this.saveNow('boot');
    return this.state();
  }

  /** Start/stop the autonomous classroom loop (the ONLY trainer). */
  setTraining(run: boolean): void {
    if (run) {
      if (this.trainingLoop === null && this.teacher !== null) {
        this.trainingLoop = new TrainingLoop(this.teacher, {
          settings: this.options.chaperone ?? { endpoint: '', apiKey: '', model: '' },
          cadenceMs: this.options.trainCadenceMs ?? 400,
          onEvents: (events) => this.broadcast({ kind: 'learning', at: Date.now(), events }),
          onError: (message) =>
            this.broadcast({ kind: 'lifecycle', at: Date.now(), event: 'booted', detail: `training error: ${message}` })
        });
      }
      this.trainingLoop?.start();
    } else {
      this.trainingLoop?.stop();
    }
  }

  /** Import a bootstrap record into the singular teacher (the browser's
   *  import path is gone). Returns the same summary importBootstrap gives. */
  async importRecord(record: BootstrapRecord): Promise<{ restored: number; conversations: number; definitions: number; droppedWords: number; stale: number }> {
    if (this.teacher === null) throw new Error('observer not booted');
    assertVocabularyCompatible(record);
    const summary = this.teacher.importBootstrap(record);
    await this.teacher.persistAll();
    await this.saveNow('import');
    return summary;
  }

  /** The portable model snapshot of the singular teacher. */
  exportRecord(): BootstrapRecord {
    if (this.teacher === null) throw new Error('observer not booted');
    return this.teacher.exportBootstrap('en-20000');
  }

  /** Import the deployed bootstrap from the configured path (server-side). */
  async loadDeployedBootstrap(): Promise<{ ok: boolean; summary?: { restored: number; conversations: number; definitions: number; droppedWords: number; stale: number }; error?: string }> {
    const path = this.options.bootstrapPath;
    if (path.length === 0 || !existsSync(path)) {
      return { ok: false, error: 'no bootstrap path configured or file missing' };
    }
    try {
      const record = JSON.parse(readFileSync(path, 'utf8')) as BootstrapRecord;
      const summary = await this.importRecord(record);
      return { ok: true, summary };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Grade a creative answer SERVER-SIDE (the browser never grades). The
   * score comes from the server's configured chaperone; without an endpoint
   * the grade is honestly unavailable (score null, band unapplied). The
   * returned shape mirrors what the chat expects: score, feedback, and the
   * applied reliability-weighted grade result.
   */
  async gradeCreative(
    provenance: Parameters<TeacherAgent['gradeCreativeWithReliability']>[0],
    utterance: string,
    answer: string
  ): Promise<{
    score: number | null;
    feedback: string | null;
    graded: ReturnType<TeacherAgent['gradeCreativeWithReliability']> | null;
  }> {
    if (this.teacher === null) throw new Error('observer not booted');
    const settings = this.options.chaperone ?? { endpoint: '', apiKey: '', model: '' };
    if (settings.endpoint.trim().length === 0) {
      return {
        score: null,
        feedback: 'grading unavailable — configure a teacher model on the server',
        graded: null
      };
    }
    try {
      const grader = semanticGrader(new OpenAICompatProvider(settings));
      if (grader === null) {
        return { score: null, feedback: 'grading unavailable', graded: null };
      }
      const outcome = await grader.grade(utterance, answer);
      const graded = this.teacher.gradeCreativeWithReliability(
        provenance,
        outcome?.score ?? null,
        utterance,
        answer,
        settings.model || settings.endpoint
      );
      return { score: outcome?.score ?? null, feedback: outcome?.feedback ?? null, graded };
    } catch (reason) {
      return {
        score: null,
        feedback: `grading unavailable: ${reason instanceof Error ? reason.message : String(reason)}`,
        graded: null
      };
    }
  }

  /** Start the server-side definitions backfill (false when nothing needs
   *  it or a run is already active). */
  startDefinitions(): boolean {
    if (this.teacher === null) return false;
    if (this.definitionsRunner === null) {
      this.definitionsRunner = new DefinitionsRunner(
        this.teacher,
        this.store,
        this.options.chaperone ?? { endpoint: '', apiKey: '', model: '' },
        (events) => this.broadcast({ kind: 'learning', at: Date.now(), events })
      );
    }
    return this.definitionsRunner.start();
  }

  cancelDefinitions(): void {
    this.definitionsRunner?.cancel();
  }

  /** The rule-store snapshot for the UI (compiled + rewrite + learned). */
  rulesSnapshot(): ReturnType<typeof ruleStoreSnapshot> {
    if (this.teacher === null) throw new Error('observer not booted');
    return ruleStoreSnapshot(this.teacher);
  }

  definitionsRunnerRunning(): boolean {
    return this.definitionsRunner?.running ?? false;
  }

  definitionsProgress(): ChaperoneProgressState | null {
    return this.definitionsRunner?.progress() ?? null;
  }

  definitionsResult(): string | null {
    return this.definitionsRunner?.result() ?? null;
  }

  /** Write the learning record + the portable model snapshot, atomically. */
  async saveNow(reason: string): Promise<ServerSnapshot> {
    if (this.teacher === null) throw new Error('server session not booted');
    const run = this.saveChain.then(async () => {
      const started = Date.now();
      await this.teacher!.flush();
      const record = this.teacher!.exportBootstrap('en-20000');
      const target = join(this.options.dataDir, 'model.json');
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, JSON.stringify(record), 'utf8');
      renameSync(tmp, target);
      const bytes = JSON.stringify(record).length;
      this.savedAt = started;
      this.lastSaveMs = Date.now() - started;
      this.modelPath = target;
      const snapshot: ServerSnapshot = {
        kind: 'snapshot',
        at: started,
        traces: record.traces.length,
        deck: record.deck,
        bytes
      };
      this.broadcast({ kind: 'snapshot', snapshot });
      return snapshot;
    });
    this.saveChain = run.catch(() => {});
    this.broadcast({ kind: 'lifecycle', at: Date.now(), event: 'saved', detail: reason });
    return run;
  }

  wake(): void {
    if (this.session === null || this.running) return;
    this.session.start((state) => {
      this.broadcast({ kind: 'metrics', at: Date.now(), state });
    });
    this.running = true;
    this.broadcast({ kind: 'lifecycle', at: Date.now(), event: 'wake', detail: 'observer resumed ticking' });
  }

  sleep(): void {
    if (this.session === null || !this.running) return;
    this.session.stop();
    this.running = false;
    this.broadcast({ kind: 'lifecycle', at: Date.now(), event: 'sleep', detail: 'observer paused' });
  }

  async shutdown(): Promise<void> {
    if (this.autosaveTimer !== null) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    this.trainingLoop?.stop();
    this.trainingLoop = null;
    this.signalUnsubscribe?.();
    this.signalUnsubscribe = null;
    if (this.teacher !== null) {
      try {
        await this.teacher.flush();
      } catch {
        // Shutdown must not throw: the record on disk is the last good save.
      }
    }
    await this.store.drain();
    this.broadcast({ kind: 'lifecycle', at: Date.now(), event: 'shutdown', detail: 'server stopped' });
    this.session?.dispose();
    this.session = null;
    this.teacher = null;
    this.status = 'idle';
  }

  state(): ServerState {
    const teacher = this.teacher;
    const words = teacher?.listWords() ?? [];
    const report = teacher?.conversationReport();
    return {
      status: this.status,
      error: this.errorMessage,
      running: this.running,
      restored: this.restored,
      freshTrained: this.freshTrained,
      learned: words.filter((entry) => entry.traceId !== null).length,
      total: words.length,
      competency: report?.competency ?? 0,
      creativeUnlocked: report?.creativeUnlocked ?? false,
      savedAt: this.savedAt,
      lastSaveMs: this.lastSaveMs,
      modelPath: this.modelPath,
      tracesInModel: this.session?.observer.getMemoryBank().all().length ?? 0,
      tickCount: this.session?.observer.getState().tickCount ?? 0,
      training: this.trainingLoop !== null ? this.trainingLoop.statistics() : (this.options.train ?? true ? EMPTY_TRAINING_STATS : null),
      trainingRunning: this.trainingLoop?.running ?? false,
      chaperoneConfigured: (this.options.chaperone?.endpoint ?? '').trim().length > 0,
      definitions:
        this.definitionsRunner !== null
          ? { running: this.definitionsRunner.running, progress: this.definitionsRunner.progress(), result: this.definitionsRunner.result() }
          : null
    };
  }
}
