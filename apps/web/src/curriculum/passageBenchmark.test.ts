/**
 * @jest-environment node
 *
 * PASSAGE PARSE-RATE BENCH (bench config only: `npx jest -c
 * jest.bench.config.cjs --testPathPatterns passageBenchmark`).
 *
 * For each passage source in the corpus directory (env CORPUS_DIR, default
 * ./corpus), over its HELD-OUT rows: how many sentences the reader's claim
 * grammar parses, how many typed claims it yields, how many are denials,
 * and a sample of the claims for a human precision check — the numbers a
 * source's reading budget is set from (Rule 1: a corpus earns its place by
 * what the reader can honestly take from it, not by its size). Skips
 * quietly when no passages file exists.
 */
import { describe, it, expect } from '@jest/globals';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACTIVE_DECK } from '../teacher/decks';
import { readText } from '../teacher/reading';
import { discoverSources, isHeldOutRow } from './registry';
import { readFileSync } from 'node:fs';

const CORPUS_DIR = process.env.CORPUS_DIR ?? 'corpus';
const SAMPLE = Number(process.env.PASSAGE_SAMPLE ?? 12);

describe('passage parse-rate bench (src/curriculum)', () => {
  it('reports per-source parse rate, claims per passage and a claim sample over the held-out rows', () => {
    const passages = discoverSources(resolve(CORPUS_DIR)).find((source) => source.kind === 'passages');
    if (passages === undefined || !existsSync(passages.path)) {
      // eslint-disable-next-line no-console
      console.log(`[passageBench] no passages.jsonl in ${CORPUS_DIR} — run npm run fetch-hf -- simplewiki|tinystories first`);
      expect(true).toBe(true);
      return;
    }
    const vocabulary = new Set(ACTIVE_DECK.map((entry) => entry.word.toLowerCase()));
    const rows = readFileSync(passages.path, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
    const held = rows.filter((_, index) => isHeldOutRow(index));
    const perSource = new Map<string, { passages: number; sentences: number; parsed: number; claims: number; negations: number; sample: string[] }>();
    for (const line of held) {
      let row: { title?: string; text?: string; source?: string };
      try {
        row = JSON.parse(line) as typeof row;
      } catch {
        continue;
      }
      if (typeof row.text !== 'string') continue;
      const key = row.source ?? 'passages';
      const stats = perSource.get(key) ?? { passages: 0, sentences: 0, parsed: 0, claims: 0, negations: 0, sample: [] };
      const read = readText(row.text, { vocabulary, source: key });
      stats.passages += 1;
      stats.sentences += read.sentencesRead;
      stats.parsed += read.sentencesParsed;
      stats.claims += read.relations.length;
      stats.negations += read.negations.length;
      for (const relation of read.relations) {
        if (stats.sample.length < SAMPLE) stats.sample.push(`${relation.subject} ${relation.predicate} ${relation.object}  ← "${relation.source.slice(0, 70)}"`);
      }
      perSource.set(key, stats);
    }
    const lines: string[] = [];
    for (const [key, stats] of perSource) {
      lines.push(
        `  ${key}: ${stats.passages} held-out passages · ${stats.sentences} sentences · parsed ${stats.parsed} (${((100 * stats.parsed) / Math.max(1, stats.sentences)).toFixed(1)}%) · ` +
          `${stats.claims} claims (${(stats.claims / Math.max(1, stats.passages)).toFixed(2)} per passage) · ${stats.negations} denials`
      );
      for (const sample of stats.sample) lines.push(`      ${sample}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[passageBench] ${passages.path}\n${lines.join('\n')}`);
    expect(perSource.size).toBeGreaterThan(0);
  }, 600000);
});
