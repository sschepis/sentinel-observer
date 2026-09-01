/**
 * DRILL BENCH — does the observer generalize, or does it memorize?
 *
 * Runs the technical drill loop over the checkable curriculum and reports,
 * per concept, accuracy on the exercises it was taught against accuracy on
 * exercises it has never seen. No LLM is involved: `verify()` knows the
 * answers, so every number here is an exact mark.
 *
 *   npm run drill-bench
 */
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { CONVERSATION_CUE_TOKENS } from '../teacher/conversation';
import { PRIME_SPACE, deckVocabulary } from '../teacher/primeSignature';
import { CHECKABLE_CONCEPTS } from '../teacher/technical';
import { runDrill } from '../teacher/technical/drill';
import type { DeckWord } from '../teacher/deck';
import type { TechnicalConcept } from '../teacher/technical/types';

const ROUNDS = Number(process.env.ROUNDS ?? 2);
const CONCEPT_LIMIT = Number(process.env.CONCEPTS ?? 8);

function deckFor(concepts: readonly TechnicalConcept[]): DeckWord[] {
  const words = new Map<string, DeckWord>();
  for (const concept of concepts) {
    words.set(concept.word, {
      word: concept.word,
      definition: concept.definition,
      example: concept.example
    });
    for (const prerequisite of concept.dependsOn) {
      if (!words.has(prerequisite)) {
        words.set(prerequisite, {
          word: prerequisite,
          definition: `the concept ${prerequisite}`,
          example: `This is about ${prerequisite}.`
        });
      }
    }
  }
  return [...words.values()];
}

async function main(): Promise<void> {
  const concepts = CHECKABLE_CONCEPTS.slice(0, CONCEPT_LIMIT);
  const deck = deckFor(concepts);

  const session = new ObserverSession(
    {
      primeCount: 128,
      gridSize: 256,
      memoryMode: 'compact',
      memoryCapacity: 5000,
      vocabulary: deckVocabulary(
        [...deck, ...CONVERSATION_CUE_TOKENS.map((word) => ({ word }))],
        PRIME_SPACE
      )
    },
    100
  );
  await session.initialize();
  const teacher = new TeacherAgent(session, deck);

  for (const entry of deck) teacher.teach(entry.word);

  console.log(`\ndrill bench — ${concepts.length} concepts, ${ROUNDS} rounds each\n`);
  console.log('concept                  round   taught%  unseen%    bar%  verdict');
  console.log('─'.repeat(74));

  const totals = { induced: 0, 'rule-induced': 0, memorized: 0, unlearned: 0 };

  for (const concept of concepts) {
    for (let round = 0; round < ROUNDS; round += 1) {
      const result = runDrill(teacher, concept, round);
      totals[result.verdict] += 1;
      console.log(
        `${concept.word.padEnd(24)} ${String(round + 1).padStart(5)}  ` +
          `${(result.trainAccuracy * 100).toFixed(0).padStart(7)}  ` +
          `${(result.testAccuracy * 100).toFixed(0).padStart(7)}  ` +
          `${(result.chance * 100).toFixed(0).padStart(7)}  ${result.verdict}${result.verdict === 'rule-induced' ? ` (rule: ${(result.ruleTestAccuracy ?? 0) * 100}% held-out)` : ''}`
      );
    }
  }

  console.log('─'.repeat(74));
  console.log(
    `induced ${totals.induced} · rule-induced ${totals['rule-induced']} · memorized ${totals.memorized} · unlearned ${totals.unlearned}`
  );
  console.log(
    '\nA high taught% with an unseen% at chance is MEMORIZATION: the observer\n' +
      'stored the instances it was shown and has no rule to apply to new ones.\n' +
      'rule-induced rounds mean the symbolic search compiled an executable\n' +
      'rule from the taught instances (P2) — the rule was acquired, not asked.\n'
  );

  session.dispose();
}

void main();
