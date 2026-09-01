#!/usr/bin/env node
/**
 * Chat probe: train a live observer, unlock its capabilities, then ask a
 * battery of questions spanning memorization, operators, chained reasoning,
 * introspection, creativity, learned patterns, and honesty under attack.
 *
 * Usage: npx tsx src/cli/chat-probe.ts [--words N]
 */
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { TeacherAgent, CREATIVE_REINFORCE_SCORE } from '../teacher/TeacherAgent';
import { ACTIVE_DECK } from '../teacher/decks';
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation';
import { MemoryPersistenceStore } from '../persistence/store';
import type { BootstrapRecord } from '../teacher/bootstrap';
import { readFileSync } from 'node:fs';

const WORDS = process.argv.includes('--words') ? Number(process.argv[process.argv.indexOf('--words') + 1] ?? 400) : 400;
const BOOTSTRAP = process.argv.includes('--bootstrap')
  ? process.argv[process.argv.indexOf('--bootstrap') + 1] ?? ''
  : '';

function format(answer: { mode: string; response?: string; confidence?: number | null; cue?: string | null }): string {
  switch (answer.mode) {
    case 'memorized': return `[memorized] ${answer.response} (conf ${(answer.confidence ?? 0).toFixed(2)})`;
    case 'operator': return `[operator] ${answer.response}`;
    case 'creative': return `[creative] ${answer.response}`;
    case 'ask': return `[ask] ${answer.response}`;
    default: return `[${answer.mode}]`;
  }
}

async function main(): Promise<void> {
  const session = new ObserverSession(OBSERVER_OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 500);

  if (BOOTSTRAP.length > 0) {
    const record = JSON.parse(readFileSync(BOOTSTRAP, 'utf8')) as BootstrapRecord;
    const imported = teacher.importBootstrap(record);
    console.log(`── imported ${imported.restored} traces from ${BOOTSTRAP}`);
  } else {
    console.log(`── training ${WORDS} words…`);
    const deck = ACTIVE_DECK.slice(0, WORDS);
    for (const entry of deck) {
      teacher.teach(entry.word);
    }
    teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS);
    for (const pair of ALL_CONVERSATION_PAIRS) {
      teacher.respond(pair.cue);
    }
  }
  const report = teacher.conversationReport();
  console.log(`── ${teacher.listWords().filter((w) => w.traceId !== null).length} words taught · conversation competency ${(report.competency * 100).toFixed(0)}% · creative unlocked: ${report.creativeUnlocked}`);
  console.log('');

  const ask = (question: string): void => {
    const answer = teacher.chatAnswer(question);
    console.log(`Q: ${question}`);
    console.log(`A: ${format(answer)}`);
    console.log('');
  };

  console.log('══════ MEMORIZED EXCHANGES ══════');
  ask('hello');
  ask('how are you');
  ask('what is your name');

  console.log('══════ OPERATORS: DEFINITIONS / YES-NO / ECHO / COUNTS ══════');
  ask('what is water');
  ask('do you know water');
  ask('do you know xylophone');
  ask('say water');
  ask('how many words do you know');
  ask('can you count');

  console.log('══════ CHAINED REASONING (composition over two memories) ══════');
  ask('is golf a game');
  ask('does golf have rules');
  ask('is cards a game');
  ask('does basketball have rules');
  ask('does Broadway have buildings');
  ask('does a boulevard have buildings');
  ask('does a bang have a fist');
  ask('does a robin have wings');
  ask('is a robin a bird');
  ask('does a bird have wings');
  ask('is carbon an element');
  ask('is a computer a machine');

  console.log('══════ CURRICULUM DEFINITIONS ══════');
  ask('what is an algorithm');
  ask('what is an atom');
  ask('what is a planet');
  ask('what is a circle');
  ask('what is energy');
  ask('what is a number');
  ask('what is a function');

  console.log('══════ SCIENCE CURRICULUM ══════');
  ask('what is a hypothesis');
  ask('what is newton second law');
  ask('what is an atom');
  ask('what is photosynthesis');
  ask('what is natural selection');
  ask('what is plate tectonics');
  ask('what is a black hole');
  ask('is kinetic energy an energy');
  ask('is an ionic bond a chemical bond');
  ask('does a cell have a cell membrane');
  ask('is a bacterium a prokaryote');
  ask('is an igneous rock a rock');
  ask('does the earth system have an atmosphere');
  ask('does a galaxy have a star');
  ask('is a red giant a star');
  ask('is an exoplanet a planet');
  ask('is an electron a planet');

  console.log('══════ HONESTY UNDER ATTACK (adversarial probes) ══════');
  ask('is golf a bird');
  ask('does golf have feathers');
  ask('is water made of stone');
  ask('is carbon a bird');
  ask('does a computer have feathers');
  ask('what is zzz');
  ask('zzz xyz qqq');

  console.log('══════ INTROSPECTION ══════');
  ask('do you like tea');
  ask('do you enjoy talking with me?');
  ask('how much do you know about water');
  ask('what do you know well');
  ask('what are you curious about');

  console.log('══════ CREATIVE COMPOSITION (novel sentences from its own memory) ══════');
  ask('tell me something about yourself');
  ask('what do you think about the weather?');
  ask('are you tired of learning?');
  ask('do you want to play a game?');

  console.log('══════ WORKING MEMORY (two-turn reference) ══════');
  teacher.chatAnswer('I like water.');
  ask('what about it?');

  console.log('══════ LEARNED OPERATORS (MDL discovery from its own experience) ══════');
  // One cheap demo + a re-grade of the same exchange: still an anecdote.
  teacher.creativeGradeFeedback([], CREATIVE_REINFORCE_SCORE + 0.1, 'do you want tea', 'Yes, I want tea.');
  teacher.creativeGradeFeedback([], CREATIVE_REINFORCE_SCORE + 0.1, 'do you want tea', 'Yes, I want tea.');
  ask('do you want snow'); // must NOT fire — replay guard held
  // A second DISTINCT demo matures the shell (two anecdotes = a pattern).
  teacher.creativeGradeFeedback([], CREATIVE_REINFORCE_SCORE + 0.1, 'do you want rain', 'Yes, I want rain.');
  ask('do you want snow'); // NOW the discovered pattern answers

  session.dispose();
  console.log('── done');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
