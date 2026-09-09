/**
 * THE DEVIATION METER LABELS WHAT WAS SAID, NOT WHO SAID IT (TASKS.md #17).
 *
 * The paper's deviation meter counts every answer as grounded (memorized /
 * operator), composed (creative) or abstained (ask / decline) — by the
 * ROUTING LAYER that produced it. That is the wrong key: a frame spoken at
 * the ask layer about a read-about entity ("Zeus is a god. He has …") is an
 * assertion, and was being counted as an abstention; a composed sentence
 * that says nothing about the world is not a deviation from fact. For the
 * meter to be "the objective record of when and how often the observer left
 * grounded territory" it has to read the utterance.
 *
 * SPEECH ACT — read from the text:
 *   · question    the observer asked (a question mark, or the ask/teach-me
 *                 shapes it uses to request teaching);
 *   · decline     it said it has not learned something / cannot tell;
 *   · assertion   anything else spoken — a claim about the world.
 *
 * METER CATEGORY — the speech act crossed with what BACKS it:
 *   · abstained   a question or a decline;
 *   · grounded    an assertion that cites memory (traces, edges, an operator,
 *                 rules) in its provenance, or one the memorized/operator
 *                 layers produced (their answers are recall or computation);
 *   · composed    an assertion that cites nothing — the composition layer's
 *                 Markov fallback, and any other unbacked claim, wherever it
 *                 came from.
 *
 * An assertion produced by the composition layer WITH cited edges (a grounded
 * frame) is therefore 'grounded' here, not 'composed': the meter measures
 * deviation from fact, and an edge-backed frame did not deviate. The
 * per-composition grounding score (grounding.ts) keeps measuring how much of
 * the wording is the observer's own material — that is a different question.
 */
import type { ChatAnswer } from './agent/support';

export type SpeechAct = 'assertion' | 'question' | 'decline';
export type MeterCategory = 'grounded' | 'composed' | 'abstained';

export interface SpeechReading {
  act: SpeechAct;
  meter: MeterCategory;
  /** True when the assertion cites nothing in its provenance. */
  unbacked: boolean;
}

const QUESTION_SHAPES: readonly RegExp[] = [
  /\?\s*$/,
  /\bcould you teach me\b/i,
  /\bcan you teach me\b/i,
  /\bdo you mean\b/i,
  /\bwhat is the rule for\b/i
];

const DECLINE_SHAPES: readonly RegExp[] = [
  /^i do not know\b/i,
  /^i don't know\b/i,
  /^i cannot tell\b/i,
  /^i can't tell\b/i,
  /^i have not learned\b/i,
  /^i haven't learned\b/i,
  /^i do not have\b/i,
  /^i cannot trust\b/i,
  /^i could not parse\b/i,
  // The composition layer's Markov fallback, spoken with its label (task 42):
  // the observer says it has nothing grounded and quotes the words as play.
  /^i have nothing grounded\b/i
];

/**
 * THE LABELED FALLBACK, SPOKEN. When the composition layer cannot ground a
 * sentence in the relation graph it still produces one (the Markov path);
 * that sentence is NOT a claim about the world and must not be spoken as one
 * — the soundness invariant (teacher/soundness.ts) forbids exactly that
 * shape. So it is spoken inside a decline that names what it is: word-play,
 * not fact. The `grounded: false` flag on the answer and the 'composed'
 * grounding score keep measuring the same thing they always did.
 */
export const UNGROUNDED_LEAD = 'I have nothing grounded to say about that yet — these are only words I put together:';
export function speakUngrounded(sentence: string): string {
  return `${UNGROUNDED_LEAD} “${sentence.trim()}”`;
}

/** Classify a spoken response by its shape alone. Exported for the bench. */
export function speechActOf(response: string): SpeechAct {
  const text = response.trim();
  if (text.length === 0) return 'decline';
  // A question anywhere in the utterance makes it a request for teaching
  // ("I do not know what X means. Could you teach me?") — the teach-me tail
  // is what the observer is DOING with the turn.
  if (QUESTION_SHAPES.some((shape) => shape.test(text))) return 'question';
  if (DECLINE_SHAPES.some((shape) => shape.test(text))) return 'decline';
  return 'assertion';
}

/** Whether an answer's provenance cites anything: a trace, an edge, an
 *  operator, a learned pattern or a rule. */
function citesMemory(answer: ChatAnswer): boolean {
  const provenance = answer.provenance;
  if (provenance === undefined) return false;
  if (provenance.traceIds.length > 0) return true;
  if (provenance.edges.length > 0) return true;
  if (provenance.operatorId !== undefined && provenance.operatorId.length > 0) return true;
  if (provenance.ruleIds !== undefined && provenance.ruleIds.length > 0) return true;
  if (provenance.templateIds !== undefined && provenance.templateIds.length > 0) return true;
  return false;
}

/** The meter reading for one chat answer. */
export function readSpeech(answer: ChatAnswer): SpeechReading {
  if (answer.mode === 'decline') return { act: 'decline', meter: 'abstained', unbacked: false };
  const act = speechActOf(answer.response);
  if (act !== 'assertion') return { act, meter: 'abstained', unbacked: false };
  // Memorized and operator answers are recall or computation by construction:
  // the trace or the operator IS the backing, whether or not the provenance
  // object lists it.
  if (answer.mode === 'memorized' || answer.mode === 'operator') return { act, meter: 'grounded', unbacked: false };
  const backed = citesMemory(answer);
  return { act, meter: backed ? 'grounded' : 'composed', unbacked: !backed };
}
