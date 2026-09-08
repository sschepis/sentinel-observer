/**
 * THE REGISTRY AND THE FEEDER — which local corpora exist, and how the
 * classroom eats them a little at a time.
 *
 * Sources are plain JSONL files in the corpus directory, one row per item,
 * written by the fetch CLIs (cli/fetch-conceptnet.ts, …) on the operator's
 * machine. The feeder loads each file once, hands the classroom `budget`
 * rows per step (round-robin over the sources that still have rows),
 * converts them with the kind's adapter, ingests them, and advances the
 * teacher's persisted cursor — so a restart resumes, and a corpus is never
 * ingested twice.
 *
 * HELD-OUT SLICE (Rule 3): every tenth row of every source is never
 * ingested. The benches read those rows (`heldOutRows`) to ask what the
 * observer recovers, answers or reads correctly about material it was not
 * shown — the same split for every source, fixed by row index so it is the
 * same slice on every machine and every run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TeacherAgent } from '../teacher/TeacherAgent';
import { conceptNetToRelations, parseConceptNetJsonl, type ConceptNetRow } from './conceptnet';
import { WORD_SHAPE, type CurriculumKind, type CurriculumSource } from './types';

/** The files the registry recognizes in a corpus directory. */
export const KNOWN_SOURCES: ReadonlyArray<Omit<CurriculumSource, 'path'> & { file: string }> = [
  {
    file: 'conceptnet.en.jsonl',
    id: 'conceptnet',
    kind: 'relations',
    license: 'ConceptNet 5 — CC BY-SA 4.0 (Speer, Chin & Havasi 2017); contributing resources under their own terms',
    description: 'typed commonsense edges between deck words, with weights and confirmed-false claims'
  },
  {
    file: 'definitions.jsonl',
    id: 'definitions',
    kind: 'definitions',
    license: 'see the fetch CLI that produced it',
    description: 'word → learner gloss + example, for deck words without a definition'
  },
  {
    file: 'dialogue.jsonl',
    id: 'dialogue',
    kind: 'dialogue',
    license: 'see the fetch CLI that produced it (DailyDialog: CC BY-NC-SA 4.0)',
    description: 'short single-turn cue → response exchanges'
  },
  {
    file: 'passages.jsonl',
    id: 'passages',
    kind: 'passages',
    license: 'see the fetch CLI that produced it (Simple English Wikipedia: CC BY-SA 4.0; TinyStories: CDLA-Sharing-1.0)',
    description: 'declarative prose for the reader'
  },
  {
    file: 'problems.jsonl',
    id: 'problems',
    kind: 'problems',
    license: 'see the fetch CLI that produced it (bAbI: BSD)',
    description: 'question + checkable answer, graded without an LLM'
  }
];

/** Every tenth row is held out (index % HOLD_OUT_EVERY === HOLD_OUT_EVERY − 1). */
export const HOLD_OUT_EVERY = 10;
export const isHeldOutRow = (index: number): boolean => index % HOLD_OUT_EVERY === HOLD_OUT_EVERY - 1;

/** The sources present in a corpus directory. */
export function discoverSources(corpusDir: string): CurriculumSource[] {
  const dir = resolve(corpusDir);
  if (!existsSync(dir)) return [];
  const found: CurriculumSource[] = [];
  for (const known of KNOWN_SOURCES) {
    const path = join(dir, known.file);
    if (existsSync(path)) found.push({ id: known.id, kind: known.kind, path, license: known.license, description: known.description });
  }
  return found;
}

export interface FeedReport {
  sourceId: string;
  kind: CurriculumKind;
  /** Rows consumed this step (held-out rows included in the cursor advance). */
  rows: number;
  /** Rows the adapter refused. */
  skipped: number;
  /** What the observer took, by kind. */
  accepted: number;
  agreed: number;
  denied: number;
  negations: number;
  /** Rows left in the source after this step. */
  remaining: number;
  ms: number;
}

/** Parse one JSONL row of a non-ConceptNet source. */
function parseRow<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

export class CurriculumFeeder {
  private readonly lines = new Map<string, string[]>();
  private vocabulary: ReadonlySet<string> | null = null;
  private turn = 0;

  constructor(
    private readonly teacher: TeacherAgent,
    readonly sources: readonly CurriculumSource[]
  ) {}

  /** The rows of a source (loaded once; the file is the operator's, read-only). */
  rowsOf(source: CurriculumSource): readonly string[] {
    let rows = this.lines.get(source.id);
    if (rows === undefined) {
      rows = readFileSync(source.path, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
      this.lines.set(source.id, rows);
    }
    return rows;
  }

  /** The held-out rows of a source — for the benches, never ingested. */
  heldOutRows(source: CurriculumSource): string[] {
    return this.rowsOf(source).filter((_, index) => isHeldOutRow(index));
  }

  remaining(source: CurriculumSource): number {
    return Math.max(0, this.rowsOf(source).length - this.teacher.curriculumCursor(source.id));
  }

  /** The deck vocabulary the adapters filter to (computed once). */
  private deckVocabulary(): ReadonlySet<string> {
    if (this.vocabulary === null) {
      this.vocabulary = new Set(this.teacher.listWords().map((entry) => entry.word.word.toLowerCase()).filter((word) => WORD_SHAPE.test(word)));
    }
    return this.vocabulary;
  }

  /** One step: the next source with rows left (round-robin), `budget` rows. */
  step(budget: number): FeedReport | null {
    const live = this.sources.filter((source) => this.remaining(source) > 0);
    if (live.length === 0) return null;
    const source = live[this.turn % live.length];
    this.turn += 1;
    return this.feed(source, budget);
  }

  /** Feed `budget` rows from one source. */
  feed(source: CurriculumSource, budget: number): FeedReport {
    const started = Date.now();
    const rows = this.rowsOf(source);
    const cursor = this.teacher.curriculumCursor(source.id);
    const end = Math.min(rows.length, cursor + Math.max(1, Math.floor(budget)));
    const slice: string[] = [];
    for (let index = cursor; index < end; index += 1) {
      if (!isHeldOutRow(index)) slice.push(rows[index]);
    }
    const report: FeedReport = {
      sourceId: source.id,
      kind: source.kind,
      rows: end - cursor,
      skipped: 0,
      accepted: 0,
      agreed: 0,
      denied: 0,
      negations: 0,
      remaining: rows.length - end,
      ms: 0
    };
    switch (source.kind) {
      case 'relations': {
        const batch = conceptNetToRelations(parseConceptNetJsonl(slice.join('\n')), this.deckVocabulary());
        report.skipped = batch.skipped;
        const took = this.teacher.ingestRelationBatch(batch);
        report.accepted = took.accepted;
        report.agreed = took.agreed;
        report.denied = took.denied;
        report.negations = took.negations;
        break;
      }
      case 'definitions': {
        const definitions: Array<{ word: string; definition: string; example: string }> = [];
        for (const line of slice) {
          const row = parseRow<{ word?: unknown; definition?: unknown; example?: unknown }>(line);
          if (row === null || typeof row.word !== 'string' || typeof row.definition !== 'string') {
            report.skipped += 1;
            continue;
          }
          definitions.push({ word: row.word.toLowerCase(), definition: row.definition, example: typeof row.example === 'string' ? row.example : '' });
        }
        report.accepted = definitions.length > 0 ? this.teacher.applyDefinitions(definitions) : 0;
        report.skipped += definitions.length - report.accepted;
        break;
      }
      case 'dialogue': {
        for (const line of slice) {
          const row = parseRow<{ cue?: unknown; response?: unknown }>(line);
          if (row === null || typeof row.cue !== 'string' || typeof row.response !== 'string') {
            report.skipped += 1;
            continue;
          }
          if (this.teacher.teachResponse({ cue: row.cue, response: row.response }) !== null) {
            // Drill it once, as the classroom does, so recall competency is
            // not diluted by every new phrase.
            this.teacher.respond(row.cue);
            report.accepted += 1;
          } else {
            report.skipped += 1;
          }
        }
        break;
      }
      case 'passages': {
        for (const line of slice) {
          const row = parseRow<{ title?: unknown; text?: unknown }>(line);
          if (row === null || typeof row.text !== 'string' || row.text.trim().length === 0) {
            report.skipped += 1;
            continue;
          }
          const read = this.teacher.readFrom(row.text, `corpus:${typeof row.title === 'string' ? row.title : source.id}`);
          report.accepted += read.accepted;
          report.negations += read.negations;
        }
        break;
      }
      case 'problems':
        // TASKS.md: the checkable-problem channel is wired by the drill layer
        // (a later step); rows are consumed so the cursor stays honest, and
        // counted as skipped so the report says nothing was learned.
        report.skipped = slice.length;
        break;
    }
    this.teacher.setCurriculumCursor(source.id, end);
    report.ms = Date.now() - started;
    return report;
  }
}

/** One line for the learning stream. */
export function describeFeed(report: FeedReport): string {
  const parts = [`${report.sourceId}: ${report.rows} rows`];
  if (report.kind === 'relations') {
    parts.push(`${report.accepted} new edges`, `${report.agreed} agreed`, `${report.denied} denied`, `${report.negations} negations`);
  } else if (report.kind === 'passages') {
    parts.push(`${report.accepted} edges read`, `${report.negations} negations`);
  } else {
    parts.push(`${report.accepted} taught`);
  }
  if (report.skipped > 0) parts.push(`${report.skipped} skipped`);
  parts.push(`${report.remaining} left`, `${report.ms} ms`);
  return parts.join(' · ');
}

// Re-exported for the benches.
export type { ConceptNetRow };
