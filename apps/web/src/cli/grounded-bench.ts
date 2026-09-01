#!/usr/bin/env node
/**
 * GROUNDED BENCH (P5) — does creative fabrication drop to zero?
 *
 * Runs a probe corpus through the creative layer and measures, per answer:
 *   - grounded: generated from typed frames + passed the internal critic
 *     (every content claim backed by a stored edge) — the fabrication-free
 *     share;
 *   - fallback: the labeled Markov path — the critic's unbacked claims are
 *     reported so the honest degradation is visible, never hidden.
 *
 * The fabrication RATE is the fraction of GROUNDED answers carrying an
 * unbacked claim — it must be 0 (the critic refuses before speaking).
 *
 * Usage: npm run grounded-bench
 */
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { CONVERSATION_CUE_TOKENS } from '../teacher/conversation';
import { PRIME_SPACE, deckVocabulary } from '../teacher/primeSignature';
import { criticize, contentWordsOf } from '../teacher/groundedFrames';
import type { DeckWord } from '../teacher/deck';

const DECK: readonly DeckWord[] = [
  { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
  { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' },
  { word: 'sparrow', definition: 'a small brown bird that lives near houses', example: 'A sparrow sings.' },
  { word: 'dog', definition: 'a common animal with four legs that people keep as a pet', example: 'The dog barks.' },
  { word: 'puppy', definition: 'a young dog that is small and playful', example: 'The puppy runs.' },
  { word: 'apple', definition: 'a round red or green fruit', example: 'I eat an apple.' },
  { word: 'pear', definition: 'a sweet yellow or green fruit', example: 'I like pears.' },
  { word: 'fruit', definition: 'a sweet part of a plant that contains seeds', example: 'I like fruit.' },
  { word: 'water', definition: 'a clear liquid that falls as rain and is used for drinking', example: 'Water is wet.' },
  { word: 'snow', definition: 'frozen white water that falls from the sky', example: 'Snow is cold.' },
  { word: 'house', definition: 'a building where people live', example: 'I live in a house.' },
  { word: 'game', definition: 'a contest with rules that people play to win', example: 'We play a game.' },
  { word: 'tennis', definition: 'a game played with a ball and a racket', example: 'Tennis needs a racket.' },
  { word: 'animal', definition: 'a living creature that can move and feel', example: 'A dog is an animal.' }
];

const session = new ObserverSession(
  {
    primeCount: 64,
    gridSize: 128,
    memoryMode: 'compact',
    smfWidth: 128,
    vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
  },
  100
);
await session.initialize();
const teacher = new TeacherAgent(session, DECK, null, 1, 4, 0x5eed);
for (const entry of DECK) teacher.teach(entry.word);
for (const cue of ['hello', 'hi', 'how are you', 'what is up', 'good morning', 'nice to see you', 'tell me more', 'okay then', 'really', 'interesting']) {
  teacher.teachResponse({ cue, response: `well, ${cue} — I am still learning.` });
  teacher.respond(cue);
}

const PROBES = [
  'tell me about robin',
  'tell me about the bird',
  'tell me about snow',
  'tell me about tennis',
  'tell me about fruit',
  'tell me about the dog',
  'tell me about the puppy',
  'can you describe a robin',
  'tell me about the sparrow',
  'tell me about your day'
];

let groundedAnswers = 0;
let fabrication = 0;
let fallbackAnswers = 0;
console.log('probe                          mode       grounded  unbacked claims');
console.log('─'.repeat(76));
for (const probe of PROBES) {
  const answer = teacher.chatAnswer(probe);
  if (answer.mode !== 'creative') {
    console.log(`${probe.padEnd(30)} ${answer.mode.padEnd(12)} —        —`);
    continue;
  }
  const relations = teacher.relations();
  const verdict = criticize(answer.response, relations, teacher.negationsList());
  const unbacked = verdict.unbacked.length > 0 ? verdict.unbacked.slice(0, 3).join(' | ') : 'none';
  if (answer.grounded) {
    groundedAnswers += 1;
    if (!verdict.grounded) fabrication += 1; // a grounded-labeled answer with an unbacked claim
  } else {
    fallbackAnswers += 1;
  }
  console.log(
    `${probe.padEnd(30)} creative    ${String(answer.grounded).padEnd(9)} ${unbacked}`
  );
  if (answer.grounded) {
    console.log(`  -> "${answer.response}"`);
  }
}

console.log('─'.repeat(76));
const total = groundedAnswers + fallbackAnswers;
console.log(`grounded answers: ${groundedAnswers}/${total} (${total > 0 ? ((groundedAnswers / total) * 100).toFixed(0) : 0}%)`);
console.log(`Markov fallback (labeled): ${fallbackAnswers}/${total}`);
console.log(`FABRICATION RATE (unbacked claims in grounded answers): ${fabrication}/${groundedAnswers}`);
console.log(`GATE: grounded answers carry zero unbacked claims → ${fabrication === 0 ? 'PASS' : 'FAIL'}`);
session.dispose();
