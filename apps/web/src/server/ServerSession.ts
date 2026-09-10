/** The server's code revision — surfaced in /api/state so a stale process
 *  (running older source) is immediately identifiable from the UI. */
export const SERVER_BUILD = '2026-09-10.1';

/** The event-loop metronome's period, and the window its worst value covers. */
const LOOP_PROBE_MS = 250;
const LOOP_WINDOW_MS = 60_000;

/**
 * THE SAVE MUST NOT COST MORE THAN A FRACTION OF THE CLOCK.
 *
 * A snapshot is `flush()` (traces 154 MB, word states 121 MB, learning
 * state 7 MB) followed by `exportBootstrap` and one `JSON.stringify` of
 * 137 MB — and all of that building and serialising is synchronous, on the
 * one thread that also answers HTTP. Measured on the live record
 * (2026-09-10, by the server's own lag monitor): **a 60-second stall**. On a
 * 30-second autosave the process was spending more time writing itself out
 * than learning, and the UI was dark for most of every minute — which is
 * what an entire afternoon of "the dashboard is broken" actually was.
 *
 * So the autosave now budgets itself: after a save that took `t`, the next
 * one waits at least `t / SAVE_DUTY_CYCLE`. A one-second save keeps the
 * plain cadence; a forty-second save earns four hundred seconds of quiet.
 * The record is never at risk — a save still runs on shutdown, on demand
 * ("Save now"), and the `.tmp`-then-rename means a skipped or interrupted
 * save cannot corrupt what is already on disk.
 */
const SAVE_DUTY_CYCLE = 0.1;

/** How often the live server applies the retention law (ANALYSIS.md §6 #3).
 *  Safety-class constant: the sweep is idempotent and the law is wall-clock,
 *  so the cadence only bounds how stale a strength reading can be. */
export const RETENTION_SWEEP_MS = 5 * 60 * 1000;
/** Task 39: the on-demand entropy readout is re-measured at most this often. */
export const ENTROPY_CACHE_MS = 30 * 1000;
import { existsSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObserverSignal, SemanticObserverState } from '@sschepis/sentient-core';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent } from '../teacher/TeacherAgent';
import type { DriveSignals } from '../teacher/drives';
import { ACTIVE_DECK } from '../teacher/decks';
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation';
import { FilePersistenceStore } from './FilePersistenceStore';
import { SqlitePersistenceStore } from './SqlitePersistenceStore';
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
import { extractUnknownSubject, tokenizeText } from '../teacher/context';
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
  /** R17: the loop also researches the subjects of its unanswered gaps
   *  through the chaperone each cycle (default false). */
  researchTopics?: boolean;
  /** Working store: 'json' (legacy, default) or 'sqlite' (recommended —
   *  one-time migration imports the legacy JSON files when present). */
  store?: 'json' | 'sqlite';
  /** src/curriculum: corpus directory the classroom ingests from (absent = none). */
  corpusDir?: string;
  /** Corpus feed cadence and slice, from the environment (see main.ts).
   *  Undefined keeps the measured defaults in trainingLoop.ts. */
  curriculumEvery?: number;
  curriculumBudget?: number;
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
  /** The running code revision — bump SERVER_BUILD on behavior changes. */
  build: string;
  /** The autonomous classroom loop (the ONLY trainer — the browser never
   *  trains). Null until the server boots with training enabled. */
  training: TrainingStats | null;
  /** Whether the loop is actively cycling right now. */
  trainingRunning: boolean;
  /** True when a chaperone endpoint is configured (server-side only). */
  chaperoneConfigured: boolean;
  /** The definitions backfill run (server-side; the browser's is gone). */
  definitions: { running: boolean; progress: ChaperoneProgressState | null; result: string | null } | null;
  /** The oscillator field's live numbers (the substrate), read without
   *  perturbing it; `ticking` says whether the field is being advanced at
   *  all — when it is not, the numbers are the last settled state. */
  field: { coherence: number; entropy: number; orderParameter: number; traces: number; ticking: boolean } | null;
  /** The drive vector, non-perturbing snapshot (teacher/drives.ts). */
  drives: DriveSignals | null;
  /** Task 39: the network entropy — how unsure the observer would be if
   *  asked about each concept it knows (bits; the closure measure). */
  knowledge: { concepts: number; total: number; mean: number; certain: number; conflicted: number; unknown: number } | null;
  /** HOW RESPONSIVE THIS PROCESS IS, measured by the server itself: the
   *  worst event-loop delay seen in the last window, and the window's
   *  length. The observer and the HTTP server share one thread, so a long
   *  synchronous step — a snapshot write, a corpus feed, a graph rebuild —
   *  is time the server cannot answer anyone. Without this number the only
   *  evidence was the UI going quiet, which looks identical to a bug in
   *  the UI (docs/TASKS.md #87). */
  loop: { maxLagMs: number; windowMs: number; skippedSaves: number } | null;
}

export class ServerSession {
  readonly store: FilePersistenceStore | SqlitePersistenceStore;
  session: ObserverSession | null = null;
  teacher: TeacherAgent | null = null;

  private readonly options: Required<ServerSessionOptions>;
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private signalUnsubscribe: (() => void) | null = null;
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  /** ANALYSIS.md §6 #3: the live server must apply the retention law on a
   *  clock. Before this timer, `applyRetention` ran only on restore, so a
   *  long-lived process never decayed a trace until it was restarted. */
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  /** The event-loop lag monitor: a metronome whose drift IS the lag. */
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private loopExpected = 0;
  private loopMaxLagMs = 0;
  private loopWindowStart = 0;
  /** Autosaves skipped because the last one was expensive (see SAVE_DUTY_CYCLE). */
  private skippedSaves = 0;
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
      autosaveMs: options.autosaveMs ?? 120_000,
      compositionSeed: options.compositionSeed ?? 0,
      tickImmediately: options.tickImmediately ?? true,
      train: options.train ?? true,
      trainCadenceMs: options.trainCadenceMs ?? 400,
      chaperone: options.chaperone ?? { endpoint: '', apiKey: '', model: '' },
      researchTopics: options.researchTopics ?? false,
      store: options.store ?? 'json',
      corpusDir: options.corpusDir ?? '',
      // 0 means "unset": the measured defaults in trainingLoop.ts stand.
      curriculumEvery: options.curriculumEvery ?? 0,
      curriculumBudget: options.curriculumBudget ?? 0
    };
    this.store =
      this.options.store === 'sqlite'
        ? new SqlitePersistenceStore(this.options.dataDir)
        : new FilePersistenceStore(this.options.dataDir);
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
        // ANALYSIS.md §6 #16: the boot-time loop dropped this flag, so
        // `--research-topics` was inert until training was toggled via the API.
        researchTopics: this.options.researchTopics ?? false,
        corpusDir: this.options.corpusDir.length > 0 ? this.options.corpusDir : undefined,
        curriculumEvery: this.options.curriculumEvery > 0 ? this.options.curriculumEvery : undefined,
        curriculumBudget: this.options.curriculumBudget > 0 ? this.options.curriculumBudget : undefined,
        onEvents: (events) => this.broadcast({ kind: 'learning', at: Date.now(), events }),
        onError: (message) =>
          this.broadcast({ kind: 'lifecycle', at: Date.now(), event: 'booted', detail: `training error: ${message}` })
      });
      this.trainingLoop.start();
    }

    // THE SERVER MEASURES ITS OWN RESPONSIVENESS. A 250 ms metronome: the
    // amount by which each tick is LATE is the time the event loop spent
    // inside something synchronous, which is exactly the time no HTTP
    // request could be answered. The worst value in each rolling minute is
    // reported on the state line.
    this.loopExpected = Date.now() + LOOP_PROBE_MS;
    this.loopWindowStart = Date.now();
    this.loopTimer = setInterval(() => {
      const now = Date.now();
      const lag = Math.max(0, now - this.loopExpected);
      this.loopExpected = now + LOOP_PROBE_MS;
      if (lag > this.loopMaxLagMs) this.loopMaxLagMs = lag;
      if (now - this.loopWindowStart >= LOOP_WINDOW_MS) {
        this.loopWindowStart = now;
        this.loopMaxLagMs = lag;
      }
    }, LOOP_PROBE_MS);
    this.loopTimer.unref?.();

    this.autosaveTimer = setInterval(() => {
      const cost = this.lastSaveMs;
      if (cost !== null && this.savedAt !== null) {
        const quietFor = cost / SAVE_DUTY_CYCLE;
        if (Date.now() - this.savedAt < quietFor) {
          this.skippedSaves += 1;
          return;
        }
      }
      void this.saveNow('interval').catch(() => {});
    }, this.options.autosaveMs);
    // The autosave cadence must never keep a process alive: the model is
    // also saved on shutdown, so an unref'd timer costs nothing.
    this.autosaveTimer.unref?.();

    // The retention law runs on the live clock, not only at restore. Every
    // RETENTION_SWEEP_MS the word traces, non-word traces, composition
    // weights and drive weights decay to the model's prediction at the
    // elapsed interval — the same one call `restoreFromPersistence` makes.
    this.retentionTimer = setInterval(() => {
      try {
        this.teacher?.applyRetention(Date.now());
      } catch (error) {
        this.broadcast({
          kind: 'lifecycle',
          at: Date.now(),
          event: 'booted',
          detail: `retention sweep error: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }, RETENTION_SWEEP_MS);
    this.retentionTimer.unref?.();

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
          researchTopics: this.options.researchTopics ?? false,
          corpusDir: this.options.corpusDir.length > 0 ? this.options.corpusDir : undefined,
          curriculumEvery: this.options.curriculumEvery > 0 ? this.options.curriculumEvery : undefined,
          curriculumBudget: this.options.curriculumBudget > 0 ? this.options.curriculumBudget : undefined,
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
      const feedback =
        graded.untrusted === true
          ? `${outcome?.feedback ?? `graded ${(outcome?.score ?? 0).toFixed(2)}`} — not applied: this grader failed its check (it cannot tell good answers from bad ones)`
          : outcome?.feedback ?? null;
      return { score: outcome?.score ?? null, feedback, graded };
    } catch (reason) {
      return {
        score: null,
        feedback: `grading unavailable: ${reason instanceof Error ? reason.message : String(reason)}`,
        graded: null
      };
    }
  }

  /**
   * CLOSE THE ASK → TOLD → OWN LOOP (the reply-teaching surface): when the
   * observer is waiting on an answer — a pending rule question, or an
   * unanswered gap whose subject the human's reply names — the reply IS the
   * answer and is taught, not answered as a new utterance.
   */
  tryTeachReply(utterance: string): { handled: boolean; message: string } | null {
    if (this.teacher === null) throw new Error('observer not booted');
    const teacher = this.teacher;

    const ruleReply = teacher.tryTeachReply(utterance);
    if (ruleReply !== null) return { handled: true, message: ruleReply.message };

    const gaps = teacher.listGaps();
    if (gaps.length === 0) return null;
    const gap = gaps[gaps.length - 1];
    const known = new Set(teacher.listWords().map((entry) => entry.word.word));
    // The subject the observer asked about: the unknown word the question
    // names — or, when every word already exists in the deck (the common
    // case: the word is KNOWN but untaught), the question's last content
    // word. The reply must name that subject to be adopted as the answer.
    const gapTokens = tokenizeText(gap).filter((token) => /^[a-z]{2,}$/.test(token));
    const subject = extractUnknownSubject(gap, known) ?? gapTokens[gapTokens.length - 1] ?? null;
    if (subject === null) return null;
    if (!tokenizeText(utterance).includes(subject)) return null;

    const response = utterance.trim();
    if (response.length < 5 || response.length > 200) return null;
    if (teacher.teachResponse({ cue: gap, response }) === null) return null;
    teacher.respond(gap);
    return { handled: true, message: `I'll remember that. ${response}` };
  }

  /**
   * The chaperone answers an outstanding gap and the observer learns the
   * answer (the "have the teacher answer" affordance). Requires a
   * server-configured chaperone; the response is validated as a taught
   * exchange before adoption — never guessed content.
   */
  async answerGap(cue: string): Promise<{ answered: boolean; cue: string; response: string | null; error: string | null }> {
    if (this.teacher === null) throw new Error('observer not booted');
    const settings = this.options.chaperone ?? { endpoint: '', apiKey: '', model: '' };
    if (settings.endpoint.trim().length === 0) {
      return { answered: false, cue, response: null, error: 'no teacher model configured on the server' };
    }
    try {
      const provider = new OpenAICompatProvider(settings);
      const chaperone = new Chaperone(provider);
      const existingCues = this.teacher.listConversationPairs().map((pair) => pair.cue);
      const run = await chaperone.answerGaps({ gaps: [cue], existingCues, signal: undefined });
      const pair = run.pairs[0];
      if (pair === undefined || this.teacher.teachResponse(pair) === null) {
        return { answered: false, cue, response: null, error: run.error ?? 'the teacher model produced no valid answer' };
      }
      this.teacher.respond(pair.cue);
      return { answered: true, cue: pair.cue, response: pair.response, error: null };
    } catch (error) {
      return { answered: false, cue, response: null, error: error instanceof Error ? error.message : String(error) };
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

  /** The entropy readout when the training loop is not measuring it: at most
   *  once every ENTROPY_CACHE_MS, so a polling client never pays twice. */
  private entropyCache: { at: number; report: ReturnType<TeacherAgent['networkEntropy']> } | null = null;
  private cachedEntropy(teacher: TeacherAgent): ReturnType<TeacherAgent['networkEntropy']> {
    const now = Date.now();
    if (this.entropyCache === null || now - this.entropyCache.at > ENTROPY_CACHE_MS) {
      this.entropyCache = { at: now, report: teacher.networkEntropy({ topN: 10 }) };
    }
    return this.entropyCache.report;
  }

  /**
   * THE INTROSPECTION SNAPSHOT — everything the observer currently wants,
   * believes, prioritizes, and trusts, for the web introspection view. Pure
   * reads of the singular teacher: goals (with their computed reasons), the
   * drive vector + learned behavior weights, curiosity + unanswered gaps,
   * belief traces, memory health, the measured handover, calibration gates,
   * and the training loop's stats.
   */
  introspection(): Record<string, unknown> {
    if (this.teacher === null) throw new Error('observer not booted');
    const teacher = this.teacher;
    const report = teacher.report();
    const conversation = teacher.conversationReport();
    const bank = this.session?.observer.getMemoryBank();
    const beliefs = (bank?.all() ?? [])
      .filter((trace) => trace.metadata?.kind === 'belief')
      .reverse()
      .slice(0, 30)
      .map((trace) => ({
        about: String(trace.metadata?.about ?? ''),
        content: trace.content,
        beliefKind: String(trace.metadata?.beliefKind ?? ''),
        contradicts: trace.metadata?.contradicts === true,
        strength: trace.strength
      }));
    const calibration = teacher
      .calibrationGates()
      .map((gate) => ({ gate, report: teacher.calibrationReport(gate) }));
    return {
      at: Date.now(),
      objectives: {
        goals: teacher.activeGoalView(),
        stalled: teacher.stalledGoals().map((goal) => ({ type: goal.type, target: goal.target })),
        history: teacher.goalHistorySnapshot()
      },
      drives: {
        signals: teacher.driveSignalsStatic(),
        behaviorWeights: teacher.driveWeights(),
        outcomes: teacher.behaviorOutcomeCounts()
      },
      curiosity: {
        question: teacher.curiosityQuestion(),
        gaps: teacher.listGaps().slice(0, 20)
      },
      beliefs,
      memory: {
        learned: report.learned,
        total: report.total,
        healthy: report.healthyCount,
        due: report.dueCount,
        consolidated: report.consolidatedCount,
        competency: conversation.competency,
        creativeUnlocked: conversation.creativeUnlocked,
        taughtPhrases: teacher.listConversationPairs().length,
        hypothesisEdges: teacher.hypothesisEdgeList().length,
        compiledRules: teacher.compiledRuleCount(),
        learnedPatterns: teacher.learnedPatternCount(),
        rewriteRules: teacher.rewriteRuleStore().all().length
      },
      trust: {
        lambdas: teacher.fadeLambdas(),
        dependence: teacher.teacherDependenceRate(),
        calibration,
        // TASKS.md #17: the deviation meter read from what was SAID (speech
        // act × backing), beside the routing-layer counts it replaces.
        deviation: teacher.deviationMeter(),
        answerModes: teacher.answerModeCounts(),
        // The grader check's verdicts per grader (teacher/graderCheck.ts).
        graders: teacher.graderTrustSnapshot(),
        // docs/SYNTHETIC_MIND.md task 39: the network entropy — how unsure
        // the observer would be if asked about each concept it knows, summed.
        // The latest training-loop reading when the loop runs (free), else
        // measured now (a readout; ~ms on the full deck).
        entropy: this.trainingLoop?.statistics().entropy ?? this.cachedEntropy(teacher)
      },
      training: this.trainingLoop !== null ? this.trainingLoop.statistics() : null
    };
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
      // One serialization per snapshot (ANALYSIS.md §6 #15): the record is
      // ~50 MB at deck scale and stringify blocks the event loop.
      const serialized = JSON.stringify(record);
      // AWAITED, NOT SYNC. model.json is 134 MB at deck scale (measured
      // 2026-09-10) and a synchronous write of it made the server deaf for
      // seconds at a time, every autosave — long enough that the browser's
      // 1.5 s probe timed out and the app went "offline" while the server
      // was in fact healthy and saving (docs/TASKS.md #85).
      await writeFile(tmp, serialized, 'utf8');
      await rename(tmp, target);
      const bytes = serialized.length;
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
    if (this.retentionTimer !== null) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    if (this.loopTimer !== null) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
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
      build: SERVER_BUILD,
      training: this.trainingLoop !== null ? this.trainingLoop.statistics() : (this.options.train ?? true ? EMPTY_TRAINING_STATS : null),
      trainingRunning: this.trainingLoop?.running ?? false,
      chaperoneConfigured: (this.options.chaperone?.endpoint ?? '').trim().length > 0,
      definitions:
        this.definitionsRunner !== null
          ? { running: this.definitionsRunner.running, progress: this.definitionsRunner.progress(), result: this.definitionsRunner.result() }
          : null,
      loop:
        this.loopTimer === null
          ? null
          : { maxLagMs: this.loopMaxLagMs, windowMs: Math.max(1, Date.now() - this.loopWindowStart), skippedSaves: this.skippedSaves },
      field: this.fieldState(),
      drives: teacher !== null ? teacher.driveSignalsStatic() : null,
      knowledge: this.knowledgeState(teacher)
    };
  }

  /** The substrate's live numbers — a read of the settled state, never a tick. */
  private fieldState(): ServerState['field'] {
    if (this.session === null) return null;
    try {
      const state = this.session.observer.getState();
      return {
        coherence: state.coherence,
        entropy: state.entropy,
        orderParameter: state.orderParameter,
        traces: state.memoryTraceCount,
        ticking: this.running
      };
    } catch {
      return null;
    }
  }

  /** The network entropy for the state line: the training loop's latest
   *  reading when it has one, else the 30-second cache (never per poll). */
  private knowledgeState(teacher: TeacherAgent | null): ServerState['knowledge'] {
    if (teacher === null) return null;
    try {
      const report = this.trainingLoop?.statistics().entropy ?? this.cachedEntropy(teacher);
      return {
        concepts: report.concepts,
        total: report.total,
        mean: report.mean,
        certain: report.byState.certain,
        conflicted: report.byState.conflicted,
        unknown: report.byState.unknown
      };
    } catch {
      return null;
    }
  }
}
