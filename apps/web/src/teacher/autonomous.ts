import type { TeacherAgent } from './TeacherAgent';
import type { Chaperone, SemanticGrader } from './chaperone';
import { nextDrillConcept, runDrill, type DrillResult } from './technical/drill';
import { computeDrives } from './drives';

/**
 * The autonomous classroom: the LLM and the observer learn together, with
 * no human in the loop. One cycle:
 *   1. teach any GAPS (utterances the observer failed in past conversation)
 *   2. one new word lesson
 *   3. spaced-repetition reviews of due words
 *   4. a TECHNICAL DRILL, graded with no LLM at all — the only phase that
 *      can distinguish generalizing from memorizing, because it tests on
 *      exercises the observer was never shown
 *   5. the LLM proposes an exchange; the observer answers; if it did not
 *      already know the exchange, teach it
 *   6. creative practice (once unlocked): a novel prompt, the observer
 *      composes, the LLM grades, the grade feeds back into memory
 *   7. curiosity: the observer asks, the LLM answers, the answer is stored
 *   8. the drive vector for the cycle
 */

export interface AutonomousEvent {
  role: 'llm' | 'observer' | 'system';
  text: string;
  meta?: string;
  /** Stable key stamped by the UI feed (optional). */
  _id?: number;
}

export interface AutonomousCycleResult {
  events: AutonomousEvent[];
  phrasesTaught: number;
  wordsTaught: number;
  /** Spaced-repetition reviews run this cycle (ask + grade on due words). */
  wordsReviewed: number;
  creativeScore: number | null;
  creativeFeedback: string | null;
  /** LLM calls made during the cycle (proposals, grades, gap/curiosity answers). */
  llmCalls: number;
  /** Turns where the OBSERVER itself produced the answer (recalled/operator/creative). */
  selfAnswered: number;
  /** The technical drill run this cycle, graded without an LLM. */
  drill: DrillResult | null;
}

/** New word lessons per cycle (default; overridable per run). */
const WORDS_PER_CYCLE = 3;
/** Spaced-repetition reviews per cycle (default; overridable per run). */
const REVIEWS_PER_CYCLE = 2;

/**
 * Self-sufficiency classification of a chat mode — the crutch meter:
 *   'strict'    — answered with ZERO LLM involvement (memorized, operator)
 *   'graded'    — the observer generated the answer; the LLM only graded it
 *   'dependent' — required the LLM to produce or teach the answer (ask, hybrid)
 */
export function selfSufficiencyClass(mode: string): 'strict' | 'graded' | 'dependent' {
  if (mode === 'memorized' || mode === 'operator') return 'strict';
  if (mode === 'creative') return 'graded';
  return 'dependent';
}

/** Open prompts the LLM uses for creative practice (filtered against cues). */
export const AUTONOMOUS_CREATIVE_PROMPTS: readonly string[] = [
  'what do you enjoy?',
  'tell me about your day',
  'what is your dream?',
  'do you like the rain?',
  'what do you think about music?',
  'where would you like to go?',
  'are you tired of learning?',
  'what do you want to do tomorrow?',
  'do you believe in kindness?',
  'what would you tell a friend?'
];

export async function runAutonomousCycle(
  teacher: TeacherAgent,
  chaperone: Chaperone,
  grader: SemanticGrader | null,
  signal?: AbortSignal,
  options: {
    drillCounts?: Map<string, number>;
    round?: number;
    wordsPerCycle?: number;
    reviewsPerCycle?: number;
  } = {}
): Promise<AutonomousCycleResult> {
  const events: AutonomousEvent[] = [];
  const wordsPerCycle = options.wordsPerCycle ?? WORDS_PER_CYCLE;
  const reviewsPerCycle = options.reviewsPerCycle ?? REVIEWS_PER_CYCLE;
  let phrasesTaught = 0;
  let wordsTaught = 0;
  let wordsReviewed = 0;
  let creativeScore: number | null = null;
  let creativeFeedback: string | null = null;
  let llmCalls = 0;
  let selfAnswered = 0;
  let drill: DrillResult | null = null;

  // 1. Gaps first — the observer learns from the conversations it had.
  const gaps = teacher.listGaps();
  if (gaps.length > 0) {
    llmCalls += 1;
    const run = await chaperone.answerGaps({
      gaps,
      existingCues: teacher.listConversationPairs().map((pair) => pair.cue),
      signal
    });
    for (const pair of run.pairs) {
      if (teacher.teachGap(pair.cue, pair.response) !== null) {
        phrasesTaught += 1;
        events.push({
          role: 'system',
          text: `learned from a missed question: "${pair.cue}" → "${pair.response}"`,
          meta: 'gap'
        });
      }
    }
    if (run.error !== null && run.error !== 'aborted') {
      events.push({ role: 'system', text: `gap teaching failed: ${run.error}`, meta: 'error' });
    }
  }

  // 2. NEW WORD LESSONS — the curriculum grows each cycle.
  for (let i = 0; i < wordsPerCycle; i += 1) {
    const next = teacher.nextNewWord();
    if (next === null) break;
    const result = teacher.teach(next);
    if (result.traceId !== null) {
      wordsTaught += 1;
      events.push({ role: 'system', text: `learned word: ${next}`, meta: 'word' });
    }
  }

  // 3. SPACED-REPETITION REVIEWS — due words get asked and graded, which is
  //    what keeps the well-worn tracks well-worn (decay + reinforcement).
  //    `nextReview` falls back to NEW words when nothing is due — those are
  //    taught in step 2, so a never-taught word here is skipped, never
  //    cold-quizzed as a failure (a blank answer used to inflate difficulty
  //    and shrink stability for a word the observer never met).
  for (let i = 0; i < reviewsPerCycle; i += 1) {
    const due = teacher.nextReview();
    if (due === null) break;
    if (teacher.recallStrengthOf(due) === null) continue; // never taught — skip
    const question = teacher.ask(due, 'recognition');
    const grade = teacher.grade(due, question);
    wordsReviewed += 1;
    events.push({
      role: 'system',
      text: `reviewed "${due}" → ${grade.verdict === 'correct' ? 'recalled' : 'missed'} (strength ${(grade.confidence ?? 0).toFixed(2)})`,
      meta: 'review'
    });
  }

  // 4. TECHNICAL DRILL — the one phase that needs no LLM, because the
  //    answers are checkable. It also reports whether the observer
  //    generalized or merely stored the instances. P-curriculum: the
  //    verdict feeds the teacher's weak-drill signal (concepts that keep
  //    failing drills stay on the lesson queue), and concepts with failure
  //    streaks are drilled before the least-recently-drilled.
  const drillCounts = options.drillCounts ?? new Map<string, number>();
  const concept = nextDrillConcept(teacher, drillCounts, new Map(Object.entries(teacher.drillFailuresSnapshot())));
  if (concept !== null) {
    drill = runDrill(teacher, concept, options.round ?? drillCounts.get(concept.word) ?? 0);
    drillCounts.set(concept.word, (drillCounts.get(concept.word) ?? 0) + 1);
    teacher.recordDrillResult(concept.word, drill.verdict);
    phrasesTaught += drill.taught;
    // Held-out answers are the observer's own work: no LLM was consulted.
    selfAnswered += Math.round(drill.testAccuracy * 100) > 0 ? 1 : 0;
    events.push(...drill.events);
  }

  // 5. The LLM talks; the observer answers; teach if it did not know.
  const level = `memorized ${teacher.listConversationPairs().length} exchanges`;
  llmCalls += 1;
  const run = await chaperone.generateConversationPairs({
    count: 1,
    existingCues: teacher.listConversationPairs().map((pair) => pair.cue),
    level,
    signal
  });
  if (run.error !== null && run.error !== 'aborted') {
    events.push({ role: 'system', text: `exchange proposal failed: ${run.error}`, meta: 'error' });
  } else {
    const pair = run.pairs[0];
    if (pair) {
      events.push({ role: 'llm', text: pair.cue });
      const answer = teacher.chatAnswer(pair.cue);
      if (answer.mode === 'memorized' && answer.response === pair.response) {
        events.push({ role: 'observer', text: answer.response, meta: 'recalled' });
        selfAnswered += 1;
      } else {
        events.push({
          role: 'observer',
          text:
            answer.mode === 'ask'
              ? answer.response
              : answer.mode === 'decline'
                ? "I don't know that yet."
                : answer.response,
          meta: answer.mode
        });
        if (teacher.teachResponse(pair) !== null) {
          phrasesTaught += 1;
          // Drill the new exchange immediately so recall competency (produced
          // / taught) does not get diluted by every new phrase — this is what
          // keeps creative mode unlocked as the curriculum grows.
          teacher.respond(pair.cue);
          events.push({ role: 'system', text: `taught: "${pair.cue}" → "${pair.response}"`, meta: 'pair' });
        }
      }
    }
  }

  // 6. Creative practice (once unlocked): compose + grade + reinforce.
  if (grader !== null && teacher.conversationReport().creativeUnlocked) {
    const used = new Set(teacher.listConversationPairs().map((p) => p.cue));
    const prompt = AUTONOMOUS_CREATIVE_PROMPTS.find((p) => !used.has(p.toLowerCase())) ?? AUTONOMOUS_CREATIVE_PROMPTS[0];
    events.push({ role: 'llm', text: prompt, meta: 'creative' });
    const reply = teacher.creativeReply(prompt);
    if (reply.sentence.trim().length > 0) {
      events.push({ role: 'observer', text: reply.sentence, meta: 'creative' });
      selfAnswered += 1;
      llmCalls += 1;
      try {
        const outcome = await grader.grade(prompt, reply.sentence, { signal });
        if (outcome !== null) {
          creativeScore = outcome.score;
          creativeFeedback = outcome.feedback;
          // P7/P8: the grade weakens EXACTLY the producers — the cited edges
          // the grounded composer filled travel with the reply. Discarding
          // them (edges: []) used to leave a wrong classroom grade unable to
          // call the answer's own edges into question.
          teacher.creativeGradeFeedback(
            { traceIds: reply.seedTraceIds, edges: reply.edges },
            outcome.score,
            prompt,
            reply.sentence
          );
          events.push({ role: 'system', text: `graded ${outcome.score.toFixed(2)} — ${outcome.feedback}`, meta: 'grade' });
        }
      } catch (reason) {
        // One transient LLM error must never kill the classroom loop — the
        // grade is skipped, the cycle continues.
        events.push({
          role: 'system',
          text: `creative grading failed: ${reason instanceof Error ? reason.message : String(reason)}`,
          meta: 'error'
        });
      }
    }
  }

  // 7. Curiosity: the observer asks about something IT wants to learn; the
  //    LLM answers, and the answer is memorized (decay decides its fate).
  const curiosity = teacher.curiosityQuestion();
  if (curiosity !== null) {
    events.push({ role: 'observer', text: curiosity, meta: 'curious' });
    llmCalls += 1;
    const answerRun = await chaperone.answerGaps({
      gaps: [curiosity],
      existingCues: teacher.listConversationPairs().map((pair) => pair.cue),
      signal
    });
    const pair = answerRun.pairs[0];
    if (pair !== undefined) {
      if (teacher.teachGap(curiosity, pair.response) !== null) phrasesTaught += 1;
      events.push({ role: 'llm', text: pair.response, meta: 'teach' });
    } else if (answerRun.error !== null) {
      events.push({ role: 'system', text: `curiosity answer failed: ${answerRun.error}`, meta: 'error' });
    }
  }

  // 8. The drive vector — the observer's archetypal priorities this cycle.
  //    Computed from the STATIC signals (the loop's own recent activity):
  //    a report-only `drives(utterance)` would run a fresh respond — a
  //    side-effectful interaction that can store "I used to recall X better"
  //    beliefs and apply retention credit to creative traces for no reason
  //    other than the report.
  const driveState = computeDrives(teacher.driveSignalsStatic());
  events.push({
    role: 'system',
    text: `drives — curiosity ${driveState.curiosity.toFixed(2)} · novelty ${driveState.novelty.toFixed(2)} · conservation ${driveState.conservation.toFixed(2)} · coherence ${driveState.coherence.toFixed(2)}`,
    meta: 'drives'
  });

  return { events, phrasesTaught, wordsTaught, wordsReviewed, creativeScore, creativeFeedback, llmCalls, selfAnswered, drill };
}