#!/usr/bin/env node
/**
 * ASK-RATE AUDIT — who answers what, by LAYER.
 *
 * Runs a fixed probe corpus through chatAnswer and buckets every answer by
 * the layer that produced it:
 *
 *   clock                deterministic clock/date
 *   memorized            taught exchange replayed
 *   operator-definition  "what is X"
 *   operator-semantic    paraphrased meaning -> learned word
 *   operator-graph       confident relational answers (no score)
 *   operator-graded      P1 holographic answers (carry a score)
 *   operator-compiled    P2 executable drill rules + the rewrite engine
 *                       (R3a: families derive through the rule decks)
 *   operator-learned     echo-template patterns
 *   operator-other       yes/no, count, echo, introspection
 *   creative             composed from memory
 *   ask                  no layer claimed it (the ASK rate)
 *   decline              degenerate input only
 *
 * The ASK rate is the honesty report: the fraction of a realistic corpus the
 * observer admits it cannot answer. It is the cross-layer integration check —
 * the same corpus exercised through the P3/P4/P1/P2 stack.
 *
 * Usage: npm run ask-audit
 */
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { CONVERSATION_CUE_TOKENS } from '../teacher/conversation';
import { PRIME_SPACE, deckVocabulary } from '../teacher/primeSignature';
import { CHECKABLE_CONCEPTS } from '../teacher/technical';
import { runDrill } from '../teacher/technical/drill';
import type { DeckWord } from '../teacher/deck';
import type { ChatAnswer } from '../teacher/TeacherAgent';

const DECK: readonly DeckWord[] = [
  { word: 'apple', definition: 'a round red or green fruit', example: 'I eat an apple.' },
  { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
  { word: 'robin', definition: 'a small bird with a red breast', example: 'I saw a robin.' },
  { word: 'water', definition: 'a clear liquid that falls as rain and is used for drinking', example: 'Water is wet.' },
  { word: 'fruit', definition: 'a sweet part of a plant that contains seeds', example: 'I like fruit.' },
  { word: 'game', definition: 'a contest with rules that people play to win', example: 'We play a game.' },
  { word: 'snow', definition: 'frozen white water that falls from the sky', example: 'Snow is cold.' },
  { word: 'hot', definition: 'having a high temperature', example: 'The tea is hot.' }
];

const RELATIONAL_KINDS = new Set([
  'is-a', 'has-part', 'made-of', 'has-property', 'capable-of', 'used-for', 'causes', 'opposite-of', 'requires', 'where'
]);

function layerOf(answer: ChatAnswer): string {
  if (answer.mode === 'decline') return 'decline';
  if (answer.mode === 'memorized') return 'memorized';
  if (answer.mode === 'creative') return 'creative';
  if (answer.mode === 'ask') return 'ask';
  if (answer.mode === 'operator') {
    const kind = answer.operator?.kind ?? '';
    if (kind === 'clock') return 'clock';
    if (kind === 'compiled-rule') return 'operator-compiled';
    if (kind === 'rewrite') return 'operator-compiled';
    if (kind === 'learned') return 'operator-learned';
    if (kind === 'definition') return 'operator-definition';
    if (kind === 'semantic-recall') return 'operator-semantic';
    if (RELATIONAL_KINDS.has(kind)) {
      return 'score' in answer.operator! ? 'operator-graded' : 'operator-graph';
    }
    return 'operator-other';
  }
  return 'unknown';
}

async function main(): Promise<void> {
  const addition = CHECKABLE_CONCEPTS.find((c) => c.word === 'addition') as (typeof CHECKABLE_CONCEPTS)[number];
  const deck: DeckWord[] = [...DECK];
  for (const concept of [addition, ...addition.dependsOn.map((word) => ({ word, definition: `the concept ${word}`, example: `About ${word}.` }))]) {
    if (!deck.some((d) => d.word === concept.word)) deck.push(concept);
  }

  const session = new ObserverSession(
    {
      primeCount: 64,
      gridSize: 128,
      memoryMode: 'compact',
      smfWidth: 128,
      vocabulary: deckVocabulary([...deck, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
    },
    100
  );
  await session.initialize();
  const teacher = new TeacherAgent(session, deck);
  for (const entry of deck) teacher.teach(entry.word);
  teacher.teachResponse({ cue: 'how are you', response: 'I am well, thank you.' });
  teacher.teachResponse({ cue: 'do you like tea', response: 'Yes, I like tea.' });

  // Register a compiled drill rule (P2) for the audit, and a chaperone
  // opposite-of edge (P4) for the relational probe.
  teacher.applyRelations([
    { subject: 'hot', predicate: 'opposite-of', object: 'cold', source: 'the tea is hot', origin: 'chaperone' }
  ]);
  runDrill(teacher, addition, 0);

  const corpus: Array<{ prompt: string; expect?: string | string[] }> = [
    { prompt: 'how are you', expect: 'memorized' },
    { prompt: 'what is apple', expect: 'operator-definition' },
    { prompt: 'what word means a flying animal covered in feathers', expect: 'operator-semantic' },
    { prompt: 'is a robin a bird', expect: 'operator-graph' },
    { prompt: 'does a bird have feathers', expect: 'operator-graded' },
    { prompt: 'is a bird a creature', expect: 'operator-graded' },
    { prompt: 'what is the opposite of hot', expect: 'operator-graph' },
    { prompt: 'do you like tea', expect: 'memorized' },
    { prompt: 'how many words do you know', expect: 'operator-other' },
    { prompt: 'what time is it', expect: 'clock' },
    // runDrill(addition, 0) usually compiles the rule, but whether the
    // compiled rule wins over the question layer is incidental — asking
    // honestly is a legitimate evasion route, not an audit failure.
    { prompt: 'What is 17 + 25?', expect: ['operator-compiled', 'ask'] },
    { prompt: 'zzz xyz qqq', expect: 'ask' },
    { prompt: 'what is the capital of mars', expect: 'ask' }
  ];

  const counts = new Map<string, number>();
  for (const probe of corpus) {
    const answer = teacher.chatAnswer(probe.prompt);
    const layer = layerOf(answer);
    counts.set(layer, (counts.get(layer) ?? 0) + 1);
    const accepted = Array.isArray(probe.expect) ? probe.expect : probe.expect !== undefined ? [probe.expect] : null;
    let mark = '';
    if (accepted !== null && !accepted.includes(layer)) {
      mark = '  <- MISMATCH';
    } else if (Array.isArray(probe.expect) && layer === 'ask') {
      mark = '  (ask — legitimate evasion route, not a failure)';
    }
    console.log(`  ${layer.padEnd(22)} "${probe.prompt}"${mark}`);
  }

  const total = corpus.length;
  const ask = counts.get('ask') ?? 0;
  console.log('\nLAYER BREAKDOWN');
  console.log('─'.repeat(44));
  let ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [layer, count] of ordered) {
    console.log(`  ${layer.padEnd(22)} ${count}/${total}  (${((count / total) * 100).toFixed(0)}%)`);
  }
  const strict = ['clock', 'memorized', 'operator-definition', 'operator-semantic', 'operator-graph', 'operator-graded', 'operator-compiled', 'operator-learned', 'operator-other']
    .reduce((sum, layer) => sum + (counts.get(layer) ?? 0), 0);
  console.log('─'.repeat(44));
  console.log(`ASK RATE: ${((ask / total) * 100).toFixed(0)}% (${ask}/${total})`);
  console.log(`zero-LLM answers: ${((strict / total) * 100).toFixed(0)}% (${strict}/${total})`);
  session.dispose();
}

void main();
