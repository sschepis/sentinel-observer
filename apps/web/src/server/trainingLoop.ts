/**
 * The server-side autonomous classroom loop.
 *
 * This is the ONLY training loop in the system: the browser no longer runs
 * one (the UI is a pure client). The loop drives the same autonomous cycle
 * the client used to run — gap teaching, new-word lessons, spaced-repetition
 * reviews, the technical drill, LLM conversation generation — against the
 * server's singular TeacherAgent, emitting the same LearningEvents the
 * client's training stream rendered.
 *
 * Chaperone settings come from SERVER configuration (env/CLI), never from
 * the browser. When no endpoint is configured the loop still runs its
 * deterministic work (lessons, reviews, drills) through the null provider —
 * the LLM-dependent steps honestly no-op instead of blocking training.
 */
import { TeacherAgent } from '../teacher/TeacherAgent';
import { runAutonomousCycle } from '../teacher/autonomous';
import {
  Chaperone,
  NullChaperoneProvider,
  OpenAICompatProvider,
  semanticGrader,
  type ChaperoneSettings
} from '../teacher/chaperone';
import { fromAutonomousEvent, makeEvent, type LearningEvent } from '../learning/events';

export interface TrainingStats {
  cycles: number;
  wordsTaught: number;
  wordsReviewed: number;
  phrasesTaught: number;
  llmCalls: number;
  selfAnswered: number;
  drillsRun: number;
  drillsInduced: number;
  drillsMemorized: number;
}

export const EMPTY_TRAINING_STATS: TrainingStats = {
  cycles: 0,
  wordsTaught: 0,
  wordsReviewed: 0,
  phrasesTaught: 0,
  llmCalls: 0,
  selfAnswered: 0,
  drillsRun: 0,
  drillsInduced: 0,
  drillsMemorized: 0
};

export interface TrainingLoopOptions {
  /** Server-configured chaperone (endpoint/model/key) — never browser state. */
  settings: ChaperoneSettings;
  /** Pause between cycles (the client's cyclePauseMs; default 400). */
  cadenceMs?: number;
  wordsPerCycle?: number;
  reviewsPerCycle?: number;
  onEvents?: (events: readonly LearningEvent[]) => void;
  onCycle?: (stats: Readonly<TrainingStats>) => void;
  onError?: (message: string) => void;
}

export class TrainingLoop {
  private controller: AbortController | null = null;
  private readonly stats: TrainingStats = { ...EMPTY_TRAINING_STATS };

  constructor(
    private readonly teacher: TeacherAgent,
    private readonly options: TrainingLoopOptions
  ) {}

  get running(): boolean {
    return this.controller !== null;
  }

  statistics(): Readonly<TrainingStats> {
    return { ...this.stats };
  }

  /** Begin the loop; false when already running. Never throws. */
  start(): boolean {
    if (this.controller !== null) return false;
    const controller = new AbortController();
    this.controller = controller;
    this.options.onEvents?.([makeEvent({ kind: 'system', label: 'system', text: 'learning started' })]);
    void this.run(controller);
    return true;
  }

  stop(): void {
    this.controller?.abort();
  }

  private async run(controller: AbortController): Promise<void> {
    const settings = this.options.settings;
    const provider =
      settings.endpoint.trim().length > 0 ? new OpenAICompatProvider(settings) : new NullChaperoneProvider();
    const chaperone = new Chaperone(provider);
    const grader = semanticGrader(provider);
    try {
      while (!controller.signal.aborted) {
        const cycle = await runAutonomousCycle(this.teacher, chaperone, grader, controller.signal, {
          wordsPerCycle: this.options.wordsPerCycle ?? 3,
          reviewsPerCycle: this.options.reviewsPerCycle ?? 2
        });
        if (controller.signal.aborted) break;
        const at = Date.now();
        this.stats.cycles += 1;
        this.stats.wordsTaught += cycle.wordsTaught;
        this.stats.wordsReviewed += cycle.wordsReviewed;
        this.stats.phrasesTaught += cycle.phrasesTaught;
        this.stats.llmCalls += cycle.llmCalls;
        this.stats.selfAnswered += cycle.selfAnswered;
        if (cycle.drill !== null) {
          this.stats.drillsRun += 1;
          if (cycle.drill.verdict === 'induced' || cycle.drill.verdict === 'rule-induced') this.stats.drillsInduced += 1;
          if (cycle.drill.verdict === 'memorized') this.stats.drillsMemorized += 1;
        }
        this.options.onCycle?.(this.statistics());
        this.options.onEvents?.(cycle.events.map((event) => fromAutonomousEvent(event, at)));
        await pause(this.options.cadenceMs ?? 400, controller.signal);
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        const message = reason instanceof Error ? reason.message : String(reason);
        this.options.onError?.(message);
        this.options.onEvents?.([makeEvent({ kind: 'error', label: 'error', text: message })]);
      }
    } finally {
      if (this.controller === controller) this.controller = null;
      this.options.onEvents?.([makeEvent({ kind: 'system', label: 'system', text: 'learning stopped' })]);
    }
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
