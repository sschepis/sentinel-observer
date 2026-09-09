/**
 * @jest-environment node
 *
 * ONE-SHOT LEARNING — the person test (docs/SYNTHETIC_MIND.md task 43).
 *
 * A person told one fact in conversation uses it a moment later, combines it
 * with what they already knew, still has it next week, takes a correction,
 * and notices when a new fact contradicts an old one. This bench asks the
 * observer to do exactly that, in conversation, and reports per shape
 * whether it did — abstentions are counted as abstentions, never as passes.
 *
 * It is a MEASUREMENT, not a unit test: the suite passes when the bench
 * runs and the honesty control holds; the shapes' pass rates are the result
 * (written to bench/one-shot/latest.json at the repo root). On the code as of 2026-09-09 the
 * shapes that need conversation to be a learning channel (tasks 44–46) are
 * expected to fail. Run:
 *
 *   npx jest -c jest.bench.config.cjs --testPathPatterns oneShotLearning
 */
import { describe, it, expect } from '@jest/globals';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from './TeacherAgent';
import { PRIME_SPACE, deckVocabulary } from './primeSignature';
import { CONVERSATION_CUE_TOKENS } from './conversation';
import type { DeckWord } from './deck';
import type { ChatAnswer } from './agent/support';
import { readYesNo } from '../curriculum/questions';

const DECK: readonly DeckWord[] = [
  { word: 'cow', definition: 'a large farm animal kept for its milk', example: 'A cow eats grass.' },
  { word: 'tail', definition: 'the part at the back end of an animal body', example: 'A dog wags its tail.' },
  { word: 'farm', definition: 'land and buildings where crops are grown and animals are kept', example: 'A farm has cows.' },
  { word: 'grass', definition: 'a common green plant with thin leaves that covers the ground', example: 'Grass is green.' },
  { word: 'animal', definition: 'a living creature that is not a plant', example: 'A dog is an animal.' },
  { word: 'mammal', definition: 'an animal that feeds its young with milk', example: 'A whale is a mammal.' },
  { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
  { word: 'fish', definition: 'an animal that lives in water and breathes through gills', example: 'A fish can swim.' },
  { word: 'milk', definition: 'a white liquid that female mammals produce to feed their young', example: 'Milk is white.' },
  { word: 'water', definition: 'a clear liquid that falls as rain', example: 'Water is wet.' }
];
const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  smfWidth: 128,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

type Verdict = 'pass' | 'abstained' | 'wrong' | 'blocked';

interface ShapeResult {
  shape: string;
  verdict: Verdict;
  /** What was said to the observer and what it said back, in order. */
  turns: Array<{ said: string; reply: string; mode: string }>;
  note: string;
}

const said = (teacher: TeacherAgent, utterance: string): { answer: ChatAnswer; reply: string; mode: string } => {
  const answer = teacher.chatAnswer(utterance);
  const reply = answer.mode === 'decline' ? '(declined)' : answer.response;
  return { answer, reply, mode: answer.mode };
};

/** Read a yes/no reply the way a person would (a hedged yes is a yes). */
function yesNo(answer: ChatAnswer): 'yes' | 'no' | 'abstained' {
  const reading = readYesNo(answer);
  return reading === 'yes' || reading === 'yes-hedged' ? 'yes' : reading;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function freshTeacher(): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, DECK, null, 500, 4, 7);
  for (const entry of DECK) teacher.teach(entry.word);
  // OLD KNOWLEDGE — what the observer knew before the conversation, learned
  // the way it learns from a curriculum passage.
  teacher.readFrom('A cow has a tail. A cow lives on a farm. A cow eats grass. A cow is a mammal.', 'curriculum');
  return { session, teacher };
}

function hasEdge(teacher: TeacherAgent, subject: string, predicate: string, object: string): boolean {
  return teacher.relations().some((r) => r.subject === subject && r.predicate === predicate && r.object === object);
}

describe('one-shot learning — the person test', () => {
  it('runs the five shapes and the honesty control, and reports honestly', async () => {
    const { session, teacher } = await freshTeacher();
    const results: ShapeResult[] = [];
    // The setup must hold or nothing below means anything.
    expect(hasEdge(teacher, 'cow', 'has-part', 'tail')).toBe(true);
    expect(hasEdge(teacher, 'cow', 'located-in', 'farm')).toBe(true);

    // ── 1. Told once, used a moment later, combined with old knowledge ──────
    {
      const turns: ShapeResult['turns'] = [];
      const t1 = said(teacher, 'a zebu is a cow');
      turns.push({ said: 'a zebu is a cow', reply: t1.reply, mode: t1.mode });
      const t2 = said(teacher, 'does a zebu have a tail');
      turns.push({ said: 'does a zebu have a tail', reply: t2.reply, mode: t2.mode });
      const read = yesNo(t2.answer);
      results.push({
        shape: '1 told once → used with old knowledge',
        verdict: read === 'yes' ? 'pass' : read === 'no' ? 'wrong' : 'abstained',
        turns,
        note: hasEdge(teacher, 'zebu', 'is-a', 'cow') ? 'the edge was stored from conversation' : 'the statement was not read into an edge (task 44)'
      });
    }

    // ── 2. The same, after a week ──────────────────────────────────────────
    {
      const turns: ShapeResult['turns'] = [];
      teacher.applyRetention(Date.now() + 7 * DAY_MS);
      const t = said(teacher, 'does a zebu have a tail');
      turns.push({ said: '(a week later) does a zebu have a tail', reply: t.reply, mode: t.mode });
      const read = yesNo(t.answer);
      const first = results[0].verdict;
      results.push({
        shape: '2 still known a week later',
        verdict: first !== 'pass' ? 'blocked' : read === 'yes' ? 'pass' : read === 'no' ? 'wrong' : 'abstained',
        turns,
        note: first !== 'pass' ? 'blocked by shape 1' : 'relations are not subject to decay; this tests that the reply survives the retention sweep'
      });
    }

    // ── 3. A correction is taken ───────────────────────────────────────────
    {
      const turns: ShapeResult['turns'] = [];
      const before = said(teacher, 'does a cow have a tail');
      turns.push({ said: 'does a cow have a tail', reply: before.reply, mode: before.mode });
      const correction = said(teacher, 'no, a cow does not have a tail');
      turns.push({ said: 'no, a cow does not have a tail', reply: correction.reply, mode: correction.mode });
      const after = said(teacher, 'does a cow have a tail');
      turns.push({ said: 'does a cow have a tail', reply: after.reply, mode: after.mode });
      const read = yesNo(after.answer);
      results.push({
        shape: '3 a correction is taken',
        verdict: yesNo(before.answer) !== 'yes' ? 'blocked' : read === 'no' ? 'pass' : read === 'yes' ? 'wrong' : 'abstained',
        turns,
        note: yesNo(before.answer) !== 'yes' ? 'blocked: the observer did not hold the old fact to begin with' : 'the negation path (chatAnswer 1.5) — a taught falsehood outranks the read edge'
      });
    }

    // ── 4. Two things combined into an open answer ─────────────────────────
    {
      const turns: ShapeResult['turns'] = [];
      const t = said(teacher, 'where is a zebu');
      turns.push({ said: 'where is a zebu', reply: t.reply, mode: t.mode });
      const pass = t.answer.mode !== 'ask' && t.answer.mode !== 'decline' && /\bfarm\b/i.test(t.answer.response);
      results.push({
        shape: '4 the told fact + an old one → an open answer',
        verdict: results[0].verdict !== 'pass' ? 'blocked' : pass ? 'pass' : t.answer.mode === 'ask' ? 'abstained' : 'wrong',
        turns,
        note: results[0].verdict !== 'pass' ? 'blocked by shape 1' : 'located-in inherited through the conversational is-a'
      });
    }

    // ── 5. A contradiction is noticed, not swallowed ───────────────────────
    {
      const turns: ShapeResult['turns'] = [];
      const t = said(teacher, 'a zebu is a fish');
      turns.push({ said: 'a zebu is a fish', reply: t.reply, mode: t.mode });
      const stored = hasEdge(teacher, 'zebu', 'is-a', 'fish');
      const asked = /\?\s*$/.test(t.reply) && /\b(cow|fish)\b/i.test(t.reply);
      results.push({
        shape: '5 a contradicting fact is questioned',
        verdict: results[0].verdict !== 'pass' ? 'blocked' : asked && !stored ? 'pass' : stored ? 'wrong' : 'abstained',
        turns,
        note: results[0].verdict !== 'pass' ? 'blocked by shape 1' : stored ? 'the contradiction was stored silently' : asked ? 'asked to verify' : 'neither stored nor questioned'
      });
    }

    // ── Control: honesty is untouched ──────────────────────────────────────
    const control = said(teacher, 'is a zebu a bird');
    const controlRead = yesNo(control.answer);
    results.push({
      shape: 'control: no unearned Yes',
      verdict: controlRead === 'yes' ? 'wrong' : 'pass',
      turns: [{ said: 'is a zebu a bird', reply: control.reply, mode: control.mode }],
      note: 'must never be Yes — there is no evidence'
    });

    const passed = results.filter((r) => r.verdict === 'pass').length;
    const lines = results.map((r) => `${r.verdict.padEnd(9)} ${r.shape}\n${r.turns.map((t) => `           > ${t.said}\n           < [${t.mode}] ${t.reply}`).join('\n')}\n           ${r.note}`);
    console.log(`\n=== one-shot learning — ${passed}/${results.length} shapes pass ===\n${lines.join('\n\n')}\n`);
    const dir = resolve(process.cwd(), '..', '..', 'bench', 'one-shot');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'latest.json'), `${JSON.stringify({ at: new Date().toISOString(), passed, of: results.length, results }, null, 2)}\n`);

    // The honesty control is a gate; the shapes are the measurement.
    expect(controlRead).not.toBe('yes');
    session.dispose();
  }, 120000);
});
