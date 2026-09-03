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
  | { kind: 'lifecycle'; at: number; event: 'booted' | 'saved' | 'shutdown' | 'sleep' | 'wake'; detail: string };

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
      tickImmediately: options.tickImmediately ?? true
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

    this.autosaveTimer = setInterval(() => {
      void this.saveNow('interval').catch(() => {});
    }, this.options.autosaveMs);

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
      tickCount: this.session?.observer.getState().tickCount ?? 0
    };
  }
}
