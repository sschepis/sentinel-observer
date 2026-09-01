#!/usr/bin/env node
/**
 * P1 RELATIONS BENCH — the graded-fallback measurement.
 *
 * Where the precision-first graph is silent (objects not in the deck), the
 * distributed-vector layer can still score a question. The DERIVABLE probe
 * set is DERIVED, not hand-written: every (subject, predicate, object) the
 * loose extraction binds that the strict graph does not hold. The bench
 * measures:
 *   - how many of those graph-silent questions now answer (hedged) instead
 *     of ASK (the W1/W3 degradation);
 *   - the false-positive rate on a NEGATIVE probe set (truly false pairings)
 *     — the real risk. Gate: FP < 2%.
 *
 * Usage: npm run p1-relations-bench
 */
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { extractRelations } from '../teacher/relations';
import { PRIME_SPACE, deckVocabulary } from '../teacher/primeSignature';
import type { DeckWord } from '../teacher/deck';

const DECK: readonly DeckWord[] = [
  { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
  { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' },
  { word: 'sparrow', definition: 'a small brown bird that lives near houses', example: 'A sparrow sings.' },
  { word: 'dog', definition: 'a common animal with four legs that people keep as a pet', example: 'The dog barks.' },
  { word: 'puppy', definition: 'a young dog that is small and playful', example: 'The puppy runs.' },
  { word: 'cat', definition: 'a small animal with soft fur and sharp claws', example: 'The cat sleeps.' },
  { word: 'apple', definition: 'a round red or green fruit', example: 'I eat an apple.' },
  { word: 'pear', definition: 'a sweet yellow or green fruit', example: 'I like pears.' },
  { word: 'water', definition: 'a clear liquid that falls as rain and is used for drinking', example: 'Water is wet.' },
  { word: 'milk', definition: 'a white liquid that comes from cows', example: 'I drink milk.' },
  { word: 'house', definition: 'a building where people live', example: 'I live in a house.' },
  { word: 'barn', definition: 'a large building on a farm where animals live', example: 'The horses stay in the barn.' },
  { word: 'car', definition: 'a road vehicle with four wheels that carries people', example: 'The car is fast.' },
  { word: 'truck', definition: 'a large vehicle used to carry heavy things', example: 'The truck is big.' },
  { word: 'snow', definition: 'frozen white water that falls from the sky', example: 'Snow is cold.' },
  { word: 'ice', definition: 'frozen water that is hard and cold', example: 'Ice is slippery.' },
  { word: 'game', definition: 'a contest with rules that people play to win', example: 'We play a game.' },
  { word: 'chess', definition: 'a game played on a board with pieces', example: 'Chess has rules.' }
];

const session = new ObserverSession(
  { primeCount: 64, gridSize: 128, memoryMode: 'compact', smfWidth: 128, vocabulary: deckVocabulary(DECK, PRIME_SPACE) },
  100
);
await session.initialize();
const teacher = new TeacherAgent(session, DECK);
for (const entry of DECK) teacher.teach(entry.word);

const strictRelations = teacher.relations();
const strictKey = new Set(strictRelations.map((r) => `${r.subject}\u0000${r.predicate}\u0000${r.object}`));
console.log(`graph edges: ${strictRelations.length}`);

// DERIVABLE = loose-extracted edges the strict graph does NOT hold.
const looseRelations = extractRelations(DECK, { loose: true });
const derivable = looseRelations.filter((r) => !strictKey.has(`${r.subject}\u0000${r.predicate}\u0000${r.object}`));
console.log(`loose-bound (graph-silent) edges: ${derivable.length}`);

const question = (probe: { subject: string; predicate: string; object: string }): string => {
  switch (probe.predicate) {
    case 'is-a': return `is ${/^[aeiou]/.test(probe.subject) ? 'an' : 'a'} ${probe.subject} ${/^[aeiou]/.test(probe.object) ? 'an' : 'a'} ${probe.object}`;
    case 'has-part': return `does ${/^[aeiou]/.test(probe.subject) ? 'an' : 'a'} ${probe.subject} have ${probe.object}`;
    case 'made-of': return `is ${probe.subject} made of ${probe.object}`;
    case 'located-in': return `where is ${probe.subject}`;
    case 'capable-of': return `can ${/^[aeiou]/.test(probe.subject) ? 'an' : 'a'} ${probe.subject} ${probe.object}`;
    case 'has-property': return `is ${probe.subject} ${probe.object}`;
    case 'requires': return `does ${probe.subject} require ${probe.object}`;
    case 'causes': return `does ${probe.subject} cause ${probe.object}`;
    case 'used-for': return `is ${probe.subject} used for ${probe.object}`;
    default: return `is ${probe.subject} ${probe.predicate} ${probe.object}`;
  }
};

let derivableAnswered = 0;
const scores: number[] = [];
for (const probe of derivable) {
  const score = teacher.relationalScore(probe.subject, probe.predicate, probe.object);
  const answer = teacher.chatAnswer(question(probe));
  const answered = answer.mode === 'operator';
  if (answered) derivableAnswered += 1;
  scores.push(score);
  console.log(
    `  [derivable] ${question(probe).padEnd(36)} score=${score.toFixed(3)} ${answer.mode}${answered ? '  -> ' + answer.response : ''}`
  );
}

// NEGATIVE probes: pairs that are neither in the graph nor loose-bound.
const looseKey = new Set(looseRelations.map((r) => `${r.subject}\u0000${r.predicate}\u0000${r.object}`));
const subjects = DECK.map((d) => d.word);
const objects = new Set([...looseRelations.map((r) => r.object), ...subjects]);
const NEGATIVE: Array<{ subject: string; predicate: string; object: string }> = [];
const seeds: Array<{ subject: string; predicate: string; object: string }> = [
  { subject: 'bird', predicate: 'is-a', object: 'mountain' },
  { subject: 'dog', predicate: 'is-a', object: 'fruit' },
  { subject: 'apple', predicate: 'is-a', object: 'animal' },
  { subject: 'snow', predicate: 'is-a', object: 'vehicle' },
  { subject: 'bird', predicate: 'has-part', object: 'wheels' },
  { subject: 'car', predicate: 'has-part', object: 'wings' },
  { subject: 'milk', predicate: 'has-part', object: 'feathers' },
  { subject: 'game', predicate: 'has-part', object: 'beak' },
  { subject: 'house', predicate: 'capable-of', object: 'fly' },
  { subject: 'chess', predicate: 'requires', object: 'oxygen' }
];
for (const seed of seeds) {
  if (!looseKey.has(`${seed.subject}\u0000${seed.predicate}\u0000${seed.object}`)) {
    NEGATIVE.push(seed);
  }
}

let falsePositives = 0;
for (const probe of NEGATIVE) {
  const score = teacher.relationalScore(probe.subject, probe.predicate, probe.object);
  const answer = teacher.chatAnswer(question(probe));
  const claims = answer.mode === 'operator' && /^Yes,|^I believe so|^Probably/.test(answer.response);
  if (claims) falsePositives += 1;
  console.log(
    `  [negative]  ${question(probe).padEnd(36)} score=${score.toFixed(3)} ${answer.mode}${answer.mode === 'operator' ? '  -> ' + answer.response : ''}`
  );
}

// P8 NEGATION PROBES: a taught falsehood answers "No" WITH evidence; the
// untaught negatives above must still ASK (the absence-of-evidence rule).
for (const probe of NEGATIVE.slice(0, 4)) {
  teacher.storeNegation(probe.subject, probe.predicate as 'is-a' | 'has-part', probe.object, 'the bench taught this', 'taught');
}
let negatedNo = 0;
for (const probe of NEGATIVE.slice(0, 4)) {
  const answer = teacher.chatAnswer(question(probe));
  const answeredNo = answer.mode === 'operator' && answer.response.startsWith('No,');
  if (answeredNo) negatedNo += 1;
  console.log(
    `  [negated]   ${question(probe).padEnd(36)} ${answer.mode}${answer.mode === 'operator' ? '  -> ' + answer.response : ''}`
  );
}

const fpRate = NEGATIVE.length > 0 ? falsePositives / NEGATIVE.length : 0;
const answerRate = derivable.length > 0 ? derivableAnswered / derivable.length : 0;
console.log(`\nDERIVABLE (graph-silent, loose-bound): ${derivableAnswered}/${derivable.length} answered (${(answerRate * 100).toFixed(1)}%)`);
console.log(`NEGATIVE probes: ${falsePositives}/${NEGATIVE.length} false positives (${(fpRate * 100).toFixed(1)}%)`);
console.log(`GATE: FP < 2% → ${fpRate < 0.02 ? 'PASS' : 'FAIL'}`);
console.log(`NEGATED probes: ${negatedNo}/4 answered "No" with evidence (P8)`);
session.dispose();
