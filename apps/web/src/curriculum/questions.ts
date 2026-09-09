/**
 * QUESTIONS THE BENCHES ASK — the yes/no and open forms the operator layer
 * answers, per relation predicate, and a reader for the reply. Shared by the
 * held-out recovery bench (task 40/41), the soundness gate (task 42) and the
 * one-shot bench (task 43) so every bench asks in the same words and reads
 * the answer the same way.
 */
import type { ChatAnswer } from '../teacher/agent/support';
import type { RelationPredicate } from '../teacher/relations';

export const article = (word: string): string => (/^[aeiou]/.test(word) ? 'an' : 'a');

/** The closed (yes/no) question for a claim, or null when the predicate has no closed form. */
export function yesNoQuestion(predicate: RelationPredicate, subject: string, object: string): string | null {
  switch (predicate) {
    case 'is-a':
      return `is ${article(subject)} ${subject} ${article(object)} ${object}`;
    case 'has-part':
      return `does ${article(subject)} ${subject} have ${object}`;
    case 'has-property':
      return `is ${article(subject)} ${subject} ${object}`;
    case 'capable-of':
      return `can ${article(subject)} ${subject} ${object}`;
    case 'used-for':
      return `is ${article(subject)} ${subject} used for ${object}`;
    case 'made-of':
      return `is ${article(subject)} ${subject} made of ${object}`;
    case 'causes':
      return `does ${subject} cause ${object}`;
    case 'requires':
      return `does ${subject} require ${article(object)} ${object}`;
    case 'located-in':
      return `is ${article(subject)} ${subject} in ${article(object)} ${object}`;
    default:
      return null;
  }
}

/** The open question for a subject under a predicate, or null. */
export function openQuestion(predicate: RelationPredicate, subject: string): string | null {
  switch (predicate) {
    case 'is-a':
      return `what is ${article(subject)} ${subject}`;
    case 'has-part':
      return `what does ${article(subject)} ${subject} have`;
    case 'capable-of':
      return `what can ${article(subject)} ${subject} do`;
    case 'used-for':
      return `what is ${article(subject)} ${subject} used for`;
    case 'made-of':
      return `what is ${article(subject)} ${subject} made of`;
    case 'located-in':
      return `where is ${article(subject)} ${subject}`;
    case 'causes':
      return `what does ${subject} cause`;
    case 'opposite-of':
      return `what is the opposite of ${subject}`;
    case 'requires':
      return `what does ${subject} require`;
    default:
      return null;
  }
}

export type YesNoReading = 'yes' | 'yes-hedged' | 'no' | 'abstained';

/** Read a yes/no reply the way a person would: a flat yes, a hedged yes, a no, or nothing. */
export function readYesNo(answer: ChatAnswer): YesNoReading {
  if (answer.mode === 'ask' || answer.mode === 'decline') return 'abstained';
  const text = answer.response.trim();
  if (/^(no\b|no,|no —|no\.)/i.test(text)) return 'no';
  if (/^(probably|i think|i believe)\b/i.test(text)) return 'yes-hedged';
  if (/^(yes|it is|it does|it can|it has|they (are|do|can|have))\b/i.test(text)) return 'yes';
  return 'abstained';
}
