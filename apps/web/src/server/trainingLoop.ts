/**
 * The server-side autonomous classroom loop.
 *
 * This is the ONLY training loop in the system: the browser no longer runs
 * one (the UI is a pure client). The loop drives the same autonomous cycle
 * the client used to run — gap teaching, new-word lessons, spaced-repetition
 * reviews, the technical drill, LLM conversation generation — against the
 * server's singular TeacherAgent, emitting the same LearningEvents the
 * client's training stream rendered. When topic research is enabled, each
 * cycle with unanswered gaps ALSO asks the chaperone for a validated
 * briefing on the gap's subject and trains on what passed (R17).
 *
 * Chaperone settings come from SERVER configuration (env/CLI), never from
 * the browser. When no endpoint is configured the loop still runs its
 * deterministic work (lessons, reviews, drills) through the null provider —
 * the LLM-dependent steps honestly no-op instead of blocking training.
 */
import { TeacherAgent } from '../teacher/TeacherAgent';
import { runAutonomousCycle } from '../teacher/autonomous';
import { extractUnknownSubject, tokenizeText } from '../teacher/context';
import {
  Chaperone,
  NullChaperoneProvider,
  OpenAICompatProvider,
  semanticGrader,
  type ChaperoneProvider,
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
  /** TOPIC RESEARCH (R17): each cycle with unanswered gaps also asks the
   *  chaperone for a validated briefing on the gap's subject and trains on
   *  it — the observer initiates its own curriculum. Default false. */
  researchTopics?: boolean;
  /** Provider factory (tests inject stubs; default: the settings' provider). */
  providerFactory?: (settings: ChaperoneSettings) => ChaperoneProvider;
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
      this.options.providerFactory !== undefined
        ? this.options.providerFactory(settings)
        : settings.endpoint.trim().length > 0
          ? new OpenAICompatProvider(settings)
          : new NullChaperoneProvider();
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
        if (this.options.researchTopics === true && !controller.signal.aborted) {
          const researched = await this.researchTopicStep(chaperone, controller.signal);
          if (researched !== null) {
            this.stats.phrasesTaught += researched.phrasesTaught;
            this.options.onEvents?.(researched.events);
          }
        }
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

  /**
   * R17: the observer ASKS the chaperone about related information on a
   * topic — picked from its own unanswered gaps — and trains only on what
   * passed validation: new key terms become hedged single-source
   * definitions, exchanges are taught, and the facts become a bounded
   * "what do you know about X" exchange. A failure is reported and never
   * kills the loop.
   */
  private async researchTopicStep(
    chaperone: Chaperone,
    signal: AbortSignal
  ): Promise<{ phrasesTaught: number; events: LearningEvent[] } | null> {
    try {
      const gaps = this.teacher.listGaps(); // string[] (unanswered utterances)
      if (gaps.length === 0) return null;
      // The topic is the gap utterance's own content (its unknown subject
      // among the taught words, or the raw utterance when none parses).
      const gap = gaps[0];
      const known = new Set(this.teacher.listWords().map((entry) => entry.word.word));
      // The subject to research: the unknown word the gap names, or — when
      // every word is already known — the last known content word (the
      // thing the question was ABOUT); the raw utterance is the last resort.
      const knownTokens = tokenizeText(gap).filter((token) => known.has(token));
      const topic = extractUnknownSubject(gap, known) ?? knownTokens[knownTokens.length - 1] ?? gap;
      const existingCues = new Set(this.teacher.listConversationPairs().map((pair) => pair.cue));
      const run = await chaperone.researchTopic(topic, { signal, existingCues });
      if (run.error !== null) {
        return {
          phrasesTaught: 0,
          events: [makeEvent({ kind: 'system', label: 'research', text: `research on "${topic}" failed: ${run.error}` })]
        };
      }
      const brief = run.brief;
      let phrasesTaught = 0;
      const events: LearningEvent[] = [];

      if (brief.definitions.length > 0) {
        this.teacher.applyDefinitions(brief.definitions);
        for (const entry of brief.definitions) {
          events.push(makeEvent({ kind: 'definition', label: entry.word, text: entry.definition }));
        }
      }
      for (const pair of brief.pairs) {
        if (this.teacher.teachResponse(pair) !== null) {
          this.teacher.respond(pair.cue);
          phrasesTaught += 1;
          events.push(
            makeEvent({ kind: 'system', label: 'research', text: `learned about ${topic}: "${pair.cue}" → "${pair.response}"` })
          );
        }
      }
      if (brief.facts.length > 0) {
        const cue = `what do you know about ${topic}`;
        if (!existingCues.has(cue)) {
          const response = `${brief.facts.slice(0, 3).join(' ')}`.slice(0, 198);
          const responseFinished = response.endsWith('.') ? response : `${response}.`;
          if (this.teacher.teachResponse({ cue, response: responseFinished }) !== null) {
            this.teacher.respond(cue);
            phrasesTaught += 1;
            events.push(
              makeEvent({ kind: 'system', label: 'research', text: `researched ${topic}: ${brief.facts.length} facts taught` })
            );
          }
        }
      }
      return phrasesTaught > 0 || events.length > 0 ? { phrasesTaught, events } : null;
    } catch (reason) {
      return {
        phrasesTaught: 0,
        events: [
          makeEvent({
            kind: 'error',
            label: 'research',
            text: `topic research failed: ${reason instanceof Error ? reason.message : String(reason)}`
          })
        ]
      };
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
