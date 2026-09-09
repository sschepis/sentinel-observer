/**
 * CHECKABLE PROBLEMS — ground truth from outside the loop (Rule 3).
 *
 * A problem row is a prompt with an answer that can be checked without
 * asking anyone: arithmetic word problems (SVAMP, ASDiv) whose answer is a
 * number. The observer answers through its own stack (the story parser →
 * the rewrite engine), the check is exact, and the verdict is world
 * feedback the grader check never has to vouch for: a wrong derivation
 * weakens the rules it derived through (R5), a correct one is credited, an
 * unparsed problem is recorded as a gap the classroom can chase.
 *
 * Only shapes the observer has an answering PATH for are ingested here — a
 * problem set it cannot attempt yet (bAbI's story-state questions) would
 * only measure its absence, so those wait for the engine that answers them
 * (TASKS.md). What this file measures is the honest number: of the checkable
 * problems it was shown, how many did it answer, and how many of those were
 * right.
 */
import type { TeacherAgent } from '../teacher/TeacherAgent';

export interface ProblemRow {
  /** The situation ("John has 3 apples. He buys 2 more.") — may be empty. */
  body: string;
  /** The question ("How many apples does he have now?"). */
  question: string;
  /** The checkable answer, as the source states it ("5", "5.0"). */
  answer: string;
  source?: string;
}

export type ProblemVerdict = 'correct' | 'wrong' | 'abstained';

export interface ProblemCheck {
  /** WHICH LAYER SPOKE. A wrong answer is only fixable once you know where
   *  it came from: the rewrite engine (and which rules), a compiled rule, a
   *  memorized exchange or the creative layer. */
  layer?: string;
  prompt: string;
  expected: number | null;
  got: number | null;
  /** What the observer said (empty when it declined). */
  response: string;
  mode: string;
  verdict: ProblemVerdict;
}

/** The first number in a text, or null ("The answer is 6." → 6; "6.0" → 6). */
export function numberIn(text: string): number | null {
  const match = /-?\d+(?:\.\d+)?/.exec(text.replace(/,/g, ''));
  if (match === null) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

/** Parse a problems.jsonl row. */
export function parseProblemRow(line: string): ProblemRow | null {
  try {
    const row = JSON.parse(line) as Partial<ProblemRow>;
    if (typeof row.question !== 'string' || typeof row.answer !== 'string') return null;
    return { body: typeof row.body === 'string' ? row.body : '', question: row.question, answer: row.answer, source: typeof row.source === 'string' ? row.source : undefined };
  } catch {
    return null;
  }
}

/** The prompt the observer is asked: the situation and the question as one
 *  utterance, whitespace normalized. */
export function problemPrompt(row: ProblemRow): string {
  return `${row.body.trim()} ${row.question.trim()}`.replace(/\s+/g, ' ').trim();
}

/**
 * Pose one checkable problem and book the verdict. A correct operator answer
 * credits `answer`; a wrong one records the grade against exactly the rules
 * it derived through and weakens them; an ask/decline is an abstention and
 * the prompt becomes a gap (the observer knows it could not do this one).
 *
 * WHAT COUNTS AS AN ANSWER. Three shapes are abstentions, not wrong answers,
 * and conflating them cost this bench its meaning once already: an ask or a
 * decline; an UNGROUNDED composition, which says so in words ("I have
 * nothing grounded to say about that yet — these are only words I put
 * together: …") and whose text is word-play that happens to echo the
 * problem's own digits; and any reply that names no number at all. Grading
 * those as wrong turned an honest observer into a 23%-accurate one on
 * paper — 10 of 24 "wrong" answers had offered no number, and the rest were
 * declines the grader read digits out of.
 */
export function checkProblem(teacher: TeacherAgent, row: ProblemRow): ProblemCheck {
  const prompt = problemPrompt(row);
  const expected = numberIn(row.answer);
  const answer = teacher.chatAnswer(prompt);
  const ungrounded = answer.mode === 'creative' && answer.grounded === false;
  if (answer.mode === 'decline' || answer.mode === 'ask' || ungrounded) {
    return {
      prompt,
      expected,
      got: null,
      response: answer.mode === 'decline' ? '' : answer.response,
      mode: answer.mode,
      layer: ungrounded ? 'creative:ungrounded' : answer.mode,
      verdict: 'abstained'
    };
  }
  const got = numberIn(answer.response);
  if (got === null) {
    // It said something, and none of it was a number: it did not answer.
    return { prompt, expected, got: null, response: answer.response, mode: answer.mode, layer: `${answer.mode}:no-number`, verdict: 'abstained' };
  }
  const correct = expected !== null && got !== null && Math.abs(got - expected) < 1e-6;
  const provenance = answer.provenance;
  teacher.recordAnswerGrade(prompt, answer.mode, correct ? 'correct' : 'wrong', provenance);
  if (correct) {
    teacher.noteBehaviorOutcome('answer', true);
  } else {
    teacher.noteBehaviorOutcome('answer', false);
    // R5: the world contradicted the derivation — weaken the rules it used,
    // never the whole store (an operator that cited no rules has nothing to
    // weaken; the ledger still names it).
    for (const ruleId of provenance.ruleIds ?? []) {
      teacher.weakenRule(ruleId, 1, { evidence: 'verified-wrong', expected: row.answer, input: prompt.slice(0, 80) });
    }
  }
  const operator = answer.mode === 'operator' ? answer.operator : null;
  const layer = [answer.mode, operator?.kind, (answer.provenance.ruleIds ?? []).slice(0, 4).join('+')].filter((part) => part !== undefined && part !== '').join(':');
  return { prompt, expected, got, response: answer.response, mode: answer.mode, layer, verdict: correct ? 'correct' : 'wrong' };
}
