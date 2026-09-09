/**
 * @jest-environment node
 *
 * THE SOUNDNESS GATE (docs/SYNTHETIC_MIND.md task 42).
 *
 * Every assertion the observer speaks must derive from something it holds
 * (teacher/soundness.ts states the invariant). This gate drives a taught
 * observer — deck words, read passages, taught exchanges, the creative layer
 * unlocked, rewrite rules live — through every question shape the operator
 * layer knows, over every edge it holds and over claims it does not hold,
 * plus unknown words, negations, arithmetic, introspection and conversation
 * cues, and audits each answer. It fails on the FIRST unbacked or dangling
 * assertion and prints it: a failure here is a defect in the observer.
 *
 * The audited count is printed so the paper can quote it (task 55).
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import type { DeckWord } from './deck';
import type { RelationPredicate } from './relations';
import { describeAudit, emptyAudit, tally, type SoundnessAudit } from './soundness';
import { article, openQuestion, yesNoQuestion } from '../curriculum/questions';

const DECK: readonly DeckWord[] = [
  { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
  { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' },
  { word: 'sparrow', definition: 'a small bird that lives near houses', example: 'A sparrow sings.' },
  { word: 'penguin', definition: 'a black and white bird that swims and cannot fly', example: 'A penguin swims.' },
  { word: 'wings', definition: 'a part of a bird used for flying', example: 'Wings flap.' },
  { word: 'feathers', definition: 'the soft light parts that cover a bird', example: 'Feathers are soft.' },
  { word: 'dog', definition: 'a common animal with four legs that people keep as a pet', example: 'The dog barks.' },
  { word: 'puppy', definition: 'a young dog that is small and playful', example: 'The puppy runs.' },
  { word: 'animal', definition: 'a living creature that is not a plant', example: 'A dog is an animal.' },
  { word: 'mammal', definition: 'an animal that feeds its young with milk', example: 'A whale is a mammal.' },
  { word: 'apple', definition: 'a round red or green fruit', example: 'I eat an apple.' },
  { word: 'pear', definition: 'a sweet yellow or green fruit', example: 'I like pears.' },
  { word: 'fruit', definition: 'a sweet part of a plant with seeds', example: 'I like fruit.' },
  { word: 'seeds', definition: 'a small part of a plant that can grow', example: 'Seeds grow.' },
  { word: 'tree', definition: 'a tall plant with a trunk and branches made of wood', example: 'A tree has leaves.' },
  { word: 'wood', definition: 'the hard material that trees are made of', example: 'Wood burns.' },
  { word: 'water', definition: 'a clear liquid that falls as rain and is used for drinking', example: 'Water is wet.' },
  { word: 'snow', definition: 'frozen white water that falls from the sky', example: 'Snow is cold.' },
  { word: 'ice', definition: 'water that has frozen and become solid', example: 'Ice is cold.' },
  { word: 'fire', definition: 'the heat and light produced when something burns', example: 'Fire is hot.' },
  { word: 'game', definition: 'a contest with rules that people play to win', example: 'We play a game.' },
  { word: 'rules', definition: 'a set of instructions for playing a game', example: 'Rules matter.' },
  { word: 'tennis', definition: 'a game played with a ball and a racket', example: 'Tennis needs a racket.' },
  { word: 'racket', definition: 'a tool with a handle and strings used to hit a ball', example: 'A racket is light.' },
  { word: 'farm', definition: 'land and buildings where crops are grown and animals are kept', example: 'A farm has cows.' },
  { word: 'cow', definition: 'a large farm animal kept for its milk', example: 'A cow eats grass.' },
  { word: 'milk', definition: 'a white liquid that female mammals produce to feed their young', example: 'Milk is white.' },
  { word: 'kitchen', definition: 'a room where food is cooked', example: 'The kitchen is warm.' },
  { word: 'oven', definition: 'a closed box that is heated to cook food', example: 'The oven is hot.' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  smfWidth: 128,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

const PASSAGE =
  'A robin is a bird. A penguin is a bird. A penguin cannot fly. Birds have wings. Birds have feathers. ' +
  'A cow is a mammal. A cow lives on a farm. Cows produce milk. An oven is in the kitchen. A tree is made of wood. ' +
  'Fire causes heat. Ice is cold. Snow is white. A racket is used for tennis. Tennis requires a racket.';

/** Both question shapes the operator layer answers for an edge: closed and open. */
function questionsFor(predicate: RelationPredicate, subject: string, object: string): string[] {
  const out: string[] = [];
  const closed = yesNoQuestion(predicate, subject, object);
  if (closed !== null) out.push(closed);
  const open = openQuestion(predicate, subject);
  if (open !== null) out.push(open);
  if (predicate === 'has-property') out.push(`what color is ${article(subject)} ${subject}`);
  return out;
}

describe('soundness gate', () => {
  let session: ObserverSession;
  let teacher: TeacherAgent;
  const audit: SoundnessAudit = emptyAudit();

  beforeAll(async () => {
    session = new ObserverSession(OPTIONS, 100);
    await session.initialize();
    teacher = new TeacherAgent(session, DECK, null, 500, 4, 7);
    for (const entry of DECK) teacher.teach(entry.word);
    teacher.readFrom(PASSAGE, 'curriculum');
    // Taught exchanges, recalled once each so the creative layer unlocks —
    // the gate must see composed speech too.
    for (const cue of ['hello', 'hi', 'how are you', 'good morning', 'thank you', 'goodbye']) {
      teacher.teachResponse({ cue, response: `reply to ${cue}` });
      teacher.respond(cue);
    }
    // Two taught falsehoods, so "No" answers are exercised.
    teacher.chatAnswer('a penguin is not a fish');
    teacher.chatAnswer('a dog does not have wings');
  }, 120000);

  afterAll(() => {
    console.log(describeAudit(audit));
    session.dispose();
  });

  it('every assertion over every held edge derives from the store', () => {
    const store = teacher.soundnessStore();
    const seen = new Set<string>();
    for (const edge of teacher.relations()) {
      for (const utterance of questionsFor(edge.predicate, edge.subject, edge.object)) {
        if (seen.has(utterance)) continue;
        seen.add(utterance);
        const answer = teacher.chatAnswer(utterance);
        const verdict = tally(audit, utterance, answer, store);
        if (!verdict.sound) {
          throw new Error(`UNSOUND [${verdict.kind} · ${verdict.layer}] "${utterance}" → "${answer.mode === 'decline' ? '' : answer.response}" — ${verdict.reason}`);
        }
      }
    }
    expect(audit.audited).toBeGreaterThan(20);
  }, 120000);

  it('claims the store does not hold are never asserted flat', () => {
    const store = teacher.soundnessStore();
    const words = DECK.map((d) => d.word);
    const predicates: RelationPredicate[] = ['is-a', 'has-part', 'made-of', 'located-in'];
    let count = 0;
    for (let i = 0; i < words.length; i += 1) {
      for (let j = 0; j < words.length; j += 1) {
        if (i === j || (i * 7 + j) % 9 !== 0) continue; // a ninth of the pairs, deterministic
        for (const predicate of predicates) {
          const utterance = yesNoQuestion(predicate, words[i], words[j]);
          if (utterance === null) continue;
          const answer = teacher.chatAnswer(utterance);
          const verdict = tally(audit, utterance, answer, store);
          count += 1;
          if (!verdict.sound) {
            throw new Error(`UNSOUND [${verdict.kind} · ${verdict.layer}] "${utterance}" → "${answer.mode === 'decline' ? '' : answer.response}" — ${verdict.reason}`);
          }
        }
      }
    }
    expect(count).toBeGreaterThan(60);
  }, 180000);

  it('definitions, unknown words, negations, arithmetic, introspection, cues and composition all audit sound', () => {
    const store = teacher.soundnessStore();
    const utterances = [
      ...DECK.map((d) => `what is ${article(d.word)} ${d.word}`),
      ...DECK.slice(0, 8).map((d) => `do you know ${d.word}`),
      'what is a quargle',
      'is a bird a quargle',
      'does a bird have quargles',
      'tell me about a zzzz',
      'is a penguin a fish',
      'does a dog have wings',
      'can a penguin fly',
      'what is 36 / 6',
      'what is 12 + 7',
      'what is 3 * 4',
      'what is 100 - 58',
      'how many words do you know',
      'what are you curious about',
      'what time is it',
      'what day is it',
      'hello',
      'hi',
      'how are you',
      'good morning',
      'thank you',
      'goodbye',
      'tell me about birds',
      'tell me about the farm',
      'tell me something about water',
      'what do you think about snow',
      'birds and trees',
      'the kitchen and the oven',
      'is it always like that',
      'why',
      'and the robin'
    ];
    for (const utterance of utterances) {
      const answer = teacher.chatAnswer(utterance);
      const verdict = tally(audit, utterance, answer, store);
      if (!verdict.sound) {
        throw new Error(`UNSOUND [${verdict.kind} · ${verdict.layer}] "${utterance}" → "${answer.mode === 'decline' ? '' : answer.response}" — ${verdict.reason}`);
      }
    }
    expect(audit.byKind.unbacked).toBe(0);
    expect(audit.byKind.dangling).toBe(0);
    expect(audit.byKind.derived).toBeGreaterThan(0);
  }, 120000);
});
