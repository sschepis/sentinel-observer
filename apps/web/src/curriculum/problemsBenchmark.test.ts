/**
 * @jest-environment node
 *
 * WORD PROBLEMS — what the observer can currently do with the arithmetic
 * corpus (SVAMP + ASDiv, corpus/problems.jsonl), and why it declines.
 *
 * Every row is a checkable problem: the observer answers through its own
 * stack (story parser → rewrite engine), the check is exact, and the verdict
 * is right / wrong / abstained. This bench samples the corpus, reports the
 * three rates by source, and CLASSIFIES the abstentions by what the problem
 * needed (a decrease, a residual "how many left", three or more quantities,
 * a rate/unit, a comparison, a fraction/decimal, …) so the next parser is
 * built for the largest bucket, not the most convenient one. Reads the
 * operator's corpus: a measurement, not a unit test.
 *
 *   cd apps/web && npx jest -c jest.bench.config.cjs --testPathPatterns problemsBenchmark
 *   PROBLEMS_SAMPLE=300 PROBLEMS_SHOW=12 …   PROBLEMS_SKIP=300 for the next slice
 */
import { describe, it, expect } from '@jest/globals';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mulberry32 } from '@sschepis/sentient-core';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { PRIME_SPACE, deckVocabulary } from '../teacher/primeSignature';
import { CONVERSATION_CUE_TOKENS } from '../teacher/conversation';
import { ACTIVE_DECK } from '../teacher/decks';
import { checkProblem, parseProblemRow, problemPrompt, type ProblemRow } from './problems';

const CORPUS = resolve(process.cwd(), process.env.PROBLEMS_CORPUS ?? 'corpus', 'problems.jsonl');
const SAMPLE = Number(process.env.PROBLEMS_SAMPLE ?? '300');
const SHOW = Number(process.env.PROBLEMS_SHOW ?? '12');
const TAUGHT = Number(process.env.PROBLEMS_TAUGHT ?? '300');
/** Skip the first N of the shuffled sample — a fresh slice for an out-of-sample check. */
const SKIP = Number(process.env.PROBLEMS_SKIP ?? '0');

/** What a problem needs, read from its text — the buckets a parser would have to cover. */
function needsOf(row: ProblemRow): string[] {
  const text = `${row.body} ${row.question}`.toLowerCase();
  const numbers = text.match(/-?\d+(?:\.\d+)?/g) ?? [];
  const needs: string[] = [];
  if (/\d+\.\d+|\bhalf\b|\bquarter\b|\bfraction\b|\d+\/\d+/.test(text)) needs.push('fraction/decimal');
  if (/\b(gave|gives|give away|ate|eat|lost|lose|sold|sell|took|take|spent|spend|used|use up|broke|fewer|less|left|remain|remaining|still has|how many more|difference)\b/.test(text)) needs.push('decrease/residual');
  if (/\b(each|every|per|apiece|in each|for each)\b/.test(text)) needs.push('rate (each/per)');
  if (/\b(times|twice|thrice|double|triple|groups? of|rows? of|packs? of|boxes? of)\b/.test(text)) needs.push('multiplicative');
  if (/\b(share|shared|split|divide|divided|equally|equal groups)\b/.test(text)) needs.push('division/sharing');
  if (/\b(more than|fewer than|less than|taller|longer|shorter|heavier|older|younger|compared)\b/.test(text)) needs.push('comparison');
  if (/\b(total|altogether|in all|all together|combined|sum)\b/.test(text)) needs.push('total');
  if (numbers.length >= 3) needs.push('3+ quantities');
  if (numbers.length <= 1) needs.push('≤1 number stated');
  if (/\b(kg|grams?|meters?|km|cm|liters?|litres?|hours?|minutes?|dollars?|cents?|\$)\b/.test(text)) needs.push('units');
  if ((row.body.match(/[.!?]/g) ?? []).length >= 3) needs.push('3+ sentences');
  return needs.length === 0 ? ['other'] : needs;
}

describe('word problems (src/curriculum/problems.ts)', () => {
  it('reports right / wrong / abstained on the arithmetic corpus and classifies what the abstentions needed', async () => {
    if (!existsSync(CORPUS)) {
      console.log(`no ${CORPUS} — run npm run fetch-hf -- svamp / asdiv first; nothing measured`);
      return;
    }
    const rows = readFileSync(CORPUS, 'utf8')
      .split(/\r?\n/)
      .map((line) => parseProblemRow(line))
      .filter((row): row is ProblemRow => row !== null);
    const rng = mulberry32(0x7a11);
    const sample = rows.slice();
    for (let i = sample.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [sample[i], sample[j]] = [sample[j], sample[i]];
    }
    const probes = sample.slice(SKIP, Math.min(SKIP + SAMPLE, sample.length));

    // A small taught core is enough: arithmetic runs through the rewrite
    // engine and the story parser, not through the vocabulary.
    const deck = ACTIVE_DECK.slice(0, TAUGHT);
    const session = new ObserverSession(
      { primeCount: 128, gridSize: 256, memoryMode: 'compact' as const, smfWidth: 128, vocabulary: deckVocabulary([...deck, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE) },
      100
    );
    await session.initialize();
    const teacher = new TeacherAgent(session, deck, null, 500, 4, 7);
    for (const entry of deck) teacher.teach(entry.word);

    const bySource: Record<string, { correct: number; wrong: number; abstained: number }> = {};
    const needBuckets: Record<string, { seen: number; correct: number; wrong: number; abstained: number }> = {};
    const wrongs: Array<{ prompt: string; expected: string; got: number | null; reply: string }> = [];
    const abstained: Array<{ prompt: string; expected: string; reply: string; needs: string[] }> = [];
    const rights: Array<{ prompt: string; expected: string; reply: string }> = [];
    const started = Date.now();
    for (const row of probes) {
      const check = checkProblem(teacher, row);
      const source = row.source ?? 'unknown';
      const tally = (bySource[source] ??= { correct: 0, wrong: 0, abstained: 0 });
      tally[check.verdict] += 1;
      for (const need of needsOf(row)) {
        const bucket = (needBuckets[need] ??= { seen: 0, correct: 0, wrong: 0, abstained: 0 });
        bucket.seen += 1;
        bucket[check.verdict] += 1;
      }
      const reply = check.response.length === 0 ? '(declined)' : check.response;
      if (check.verdict === 'wrong') wrongs.push({ prompt: problemPrompt(row), expected: row.answer, got: check.got, reply });
      else if (check.verdict === 'abstained') abstained.push({ prompt: problemPrompt(row), expected: row.answer, reply, needs: needsOf(row) });
      else rights.push({ prompt: problemPrompt(row), expected: row.answer, reply });
    }
    const totals = Object.values(bySource).reduce((acc, t) => ({ correct: acc.correct + t.correct, wrong: acc.wrong + t.wrong, abstained: acc.abstained + t.abstained }), { correct: 0, wrong: 0, abstained: 0 });
    const attempted = totals.correct + totals.wrong;
    const lines = [
      `=== word problems — ${probes.length} of ${rows.length} rows, ${((Date.now() - started) / 1000).toFixed(0)} s ===`,
      `  right ${totals.correct} · wrong ${totals.wrong} · abstained ${totals.abstained} · answered ${((100 * attempted) / probes.length).toFixed(1)}% · accuracy when answering ${attempted === 0 ? '—' : `${((100 * totals.correct) / attempted).toFixed(0)}%`}`,
      ...Object.entries(bySource).map(([source, t]) => `  ${source.padEnd(8)} right ${t.correct} · wrong ${t.wrong} · abstained ${t.abstained}`),
      '  what the problems needed (a problem can need several):',
      ...Object.entries(needBuckets)
        .sort((a, b) => b[1].seen - a[1].seen)
        .map(([need, b]) => `    ${need.padEnd(20)} ${String(b.seen).padStart(4)} seen · ${String(b.correct).padStart(3)} right · ${String(b.wrong).padStart(3)} wrong · ${String(b.abstained).padStart(3)} abstained`),
      `  every wrong answer (${wrongs.length}):`,
      ...wrongs.map((w) => `    "${w.prompt}" → expected ${w.expected}, got ${w.got} — ${w.reply.slice(0, 90)}`),
      `  ${Math.min(SHOW, rights.length)} of the right answers:`,
      ...rights.slice(0, SHOW).map((r) => `    "${r.prompt}" → ${r.reply.slice(0, 70)}`),
      `  ${Math.min(SHOW, abstained.length)} of the abstentions:`,
      ...abstained.slice(0, SHOW).map((a) => `    "${a.prompt}" (expected ${a.expected}) [${a.needs.join(', ')}] → ${a.reply.slice(0, 80)}`)
    ];
    console.log(lines.join('\n'));
    const dir = resolve(process.cwd(), '..', '..', 'bench', 'curriculum');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, `word-problems-${new Date().toISOString().slice(0, 10)}-n${probes.length}${SKIP > 0 ? `-skip${SKIP}` : ''}.json`),
      `${JSON.stringify({ at: new Date().toISOString(), sample: probes.length, rows: rows.length, totals, bySource, needBuckets, wrongs, abstainedSample: abstained.slice(0, 60), rightSample: rights.slice(0, 60) }, null, 2)}\n`
    );
    // The honesty contract, not a capability bar: whatever it answers is exact.
    expect(totals.wrong).toBeLessThanOrEqual(Math.max(2, Math.floor(attempted * 0.1)));
    session.dispose();
  }, 20 * 60 * 1000);
});
