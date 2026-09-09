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
 *
 * KNOWLEDGE IS CONSUMED, PRACTICE IS NOT. A relation, a definition or a
 * passage teaches something the observer then holds: reading it twice adds
 * nothing, so those cursors only ever move forward. A word problem teaches
 * nothing — it is an EXERCISE, and what it produces is a grade against
 * whatever the observer can derive today. Its cursor therefore wraps: when
 * the last problem has been attempted the source starts again, at a smaller
 * budget, so the classroom keeps practising and every improvement to the
 * arithmetic is re-measured against the whole corpus. (Before this, the
 * 3,004 problems were spent once — by a parser that got 19 of 24 wrong —
 * and the corpus was dead to learning for good.)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TeacherAgent } from '../teacher/TeacherAgent';
import { conceptNetToRelations, parseConceptNetJsonl, type ConceptNetRow } from './conceptnet';
import { checkProblem, parseProblemRow } from './problems';
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
    license: 'see the fetch CLI that produced it (SVAMP: MIT; ASDiv: CC BY-NC 4.0)',
    description: 'arithmetic word problems with a checkable numeric answer, graded without an LLM'
  }
];

/**
 * The kinds whose rows are EXERCISES rather than knowledge: attempting one
 * stores nothing, so the source is never used up and its cursor wraps.
 */
export const PRACTICE_KINDS: ReadonlySet<CurriculumKind> = new Set<CurriculumKind>(['problems']);

/**
 * Practice costs an answer per row (the whole chat dispatch: ≈40–120 ms
 * each), so a practice source takes a smaller slice than a knowledge source
 * — otherwise one feed would spend a minute on arithmetic. At 50 rows a
 * feed the 3,004-problem corpus comes round about every 60 feeds.
 */
export const PRACTICE_BUDGET = 50;

/**
 * Words one feed may add to the deck. Growth is how the observer comes to
 * know that "spleen" and "vireo" exist, and it is unbounded over a run —
 * but a single feed adding thousands of word-only states at once buys
 * nothing (their edges arrive with the rows that named them) and makes
 * every later rebuild slower. A cap per feed spreads the growth across the
 * corpus instead of front-loading it.
 */
export const GROWTH_PER_FEED = 400;

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
  /** What the observer took, by kind (problems: answered correctly). */
  accepted: number;
  agreed: number;
  denied: number;
  negations: number;
  /** Problems only: answered wrong / abstained. */
  wrong: number;
  abstained: number;
  /** Relations only: words the observer learned to know exist this step. */
  grown: number;
  /** Rows left in the source after this step. */
  remaining: number;
  /** Practice sources only: this step finished a pass and the cursor wrapped. */
  wrapped: boolean;
  /** Practice sources only: which pass over the corpus this step belongs to. */
  pass: number;
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
  private vocabulary: Set<string> | null = null;
  private vocabularyAt = -1;
  private turn = 0;
  /** Passes completed per practice source, this process. */
  private readonly passes = new Map<string, number>();

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

  /**
   * The deck vocabulary the adapters filter to. REBUILT WHENEVER THE DECK
   * HAS GROWN by any route: a passage that taught a word, a definition, the
   * chaperone. The cache used to be built once per feeder, so ConceptNet
   * rows about words learned through another channel were skipped for the
   * whole life of the loop — silently, since a skipped row looks exactly
   * like a row about two unknown words.
   */
  private deckVocabulary(): Set<string> {
    const words = this.teacher.listWords();
    if (this.vocabulary === null || words.length !== this.vocabularyAt) {
      this.vocabulary = new Set(words.map((entry) => entry.word.word.toLowerCase()).filter((word) => WORD_SHAPE.test(word)));
      this.vocabularyAt = words.length;
    }
    return this.vocabulary;
  }

  /** Words this feed may add to the deck (see growth cap in `feed`). */
  private grow(words: Iterable<string>, vocabulary: Set<string>, cap: number): number {
    const toGrow: string[] = [];
    for (const word of words) {
      if (toGrow.length >= cap) break;
      if (!vocabulary.has(word)) toGrow.push(word);
    }
    if (toGrow.length === 0) return 0;
    const growth = this.teacher.growVocabulary(toGrow);
    for (const entry of growth.added) {
      vocabulary.add(entry.word);
      this.vocabularyAt += 1;
    }
    return growth.added.length;
  }

  /**
   * One step: the next source with rows left (round-robin), `budget` rows.
   * A practice source is always live — when its cursor has reached the end
   * it wraps and starts the corpus again (see the header).
   */
  step(budget: number): FeedReport | null {
    const live = this.sources.filter((source) => this.remaining(source) > 0 || PRACTICE_KINDS.has(source.kind));
    if (live.length === 0) return null;
    const source = live[this.turn % live.length];
    this.turn += 1;
    return this.feed(source, budget);
  }

  /** Feed `budget` rows from one source. */
  feed(source: CurriculumSource, budget: number): FeedReport {
    const started = Date.now();
    const rows = this.rowsOf(source);
    const isPractice = PRACTICE_KINDS.has(source.kind);
    let cursor = this.teacher.curriculumCursor(source.id);
    let wrapped = false;
    if (isPractice && cursor >= rows.length) {
      // A new pass over the exercises: the corpus is not used up, and the
      // observer that answers it now is not the one that answered it last
      // time.
      cursor = 0;
      wrapped = true;
      this.passes.set(source.id, (this.passes.get(source.id) ?? 0) + 1);
    }
    const sliceBudget = isPractice ? Math.min(Math.max(1, Math.floor(budget)), PRACTICE_BUDGET) : Math.max(1, Math.floor(budget));
    const end = Math.min(rows.length, cursor + sliceBudget);
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
      wrong: 0,
      abstained: 0,
      grown: 0,
      remaining: rows.length - end,
      wrapped,
      pass: (this.passes.get(source.id) ?? 0) + 1,
      ms: 0
    };
    switch (source.kind) {
      case 'relations': {
        const rows = parseConceptNetJsonl(slice.join('\n'));
        // VOCABULARY GROWTH: a row's unknown end becomes a word the observer
        // knows exists (word-only, no definition) — provided the other end is
        // a word it already holds, so the graph stays anchored to what it can
        // define. Growth happens before conversion so the batch passes the
        // adapter's both-known filter.
        const vocabulary = this.deckVocabulary();
        const toGrow = new Set<string>();
        for (const row of rows) {
          const a = row.start.trim();
          const b = row.end.trim();
          if (!WORD_SHAPE.test(a) || !WORD_SHAPE.test(b)) continue;
          if (vocabulary.has(a) && !vocabulary.has(b)) toGrow.add(b);
          else if (vocabulary.has(b) && !vocabulary.has(a)) toGrow.add(a);
        }
        report.grown = this.grow(toGrow, vocabulary, GROWTH_PER_FEED);
        const batch = conceptNetToRelations(rows, vocabulary);
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
        // A DEFINITION IS BETTER VOCABULARY THAN AN EMPTY SLOT. The deck
        // already grows from ConceptNet rows with `definition: ''` — a word
        // it knows exists and cannot say anything about. A row that brings
        // a gloss should therefore be allowed to admit its word, not be
        // skipped for not being in the deck yet.
        if (definitions.length > 0) {
          const vocabulary = this.deckVocabulary();
          report.grown = this.grow(
            definitions.map((entry) => entry.word).filter((word) => WORD_SHAPE.test(word)),
            vocabulary,
            GROWTH_PER_FEED
          );
          report.accepted = this.teacher.applyDefinitions(definitions);
        }
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
      case 'problems': {
        for (const line of slice) {
          const row = parseProblemRow(line);
          if (row === null) {
            report.skipped += 1;
            continue;
          }
          const check = checkProblem(this.teacher, row);
          if (check.verdict === 'correct') report.accepted += 1;
          else if (check.verdict === 'wrong') report.wrong += 1;
          else report.abstained += 1;
        }
        break;
      }
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
    parts.push(`${report.accepted} new edges`, `${report.agreed} agreed`, `${report.denied} denied`, `${report.negations} negations`, `${report.grown} new words`);
  } else if (report.kind === 'passages') {
    parts.push(`${report.accepted} edges read`, `${report.negations} negations`);
  } else if (report.kind === 'problems') {
    const attempted = report.accepted + report.wrong;
    parts.push(
      `pass ${report.pass}${report.wrapped ? ' (corpus came round)' : ''}`,
      `${report.accepted} right`,
      `${report.wrong} wrong`,
      `${report.abstained} abstained`,
      `accuracy when answering ${attempted === 0 ? '—' : `${((100 * report.accepted) / attempted).toFixed(0)}%`}`
    );
  } else if (report.kind === 'definitions') {
    parts.push(`${report.accepted} defined`, `${report.grown} new words`);
  } else {
    parts.push(`${report.accepted} taught`);
  }
  if (report.skipped > 0) parts.push(`${report.skipped} skipped`);
  parts.push(`${report.remaining} left`, `${report.ms} ms`);
  return parts.join(' · ');
}

// Re-exported for the benches.
export type { ConceptNetRow };
