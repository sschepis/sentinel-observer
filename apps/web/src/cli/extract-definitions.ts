/**
 * EXTRACT DEFINITIONS FROM PASSAGES — the corpus the reader always wanted
 * and no fetcher ever produced.
 *
 * `curriculum/registry.ts` has read `definitions.jsonl` since the day it was
 * written; nothing has ever written one. Meanwhile ConceptNet grows the deck
 * by thousands of words a run, each admitted with `definition: ''` — a word
 * the observer knows exists and can say nothing about. On the 2026-09-09
 * record that is 9,039 words.
 *
 * The material to fix that is already on disk. A Simple English Wikipedia
 * article opens with a definition of its own title — "Air is the Earth's
 * atmosphere", "Aquaculture is the farming of fish, shrimp, abalones, algae,
 * and other seafood" — and `passages.jsonl` holds 19,324 of them. This CLI
 * lifts those lead sentences into the gloss format the deck uses.
 *
 * PRECISION OVER VOLUME. A definition goes into the deck and drives the
 * definition-extracted relation graph, so a bad one is worse than a missing
 * one. Every row must clear all of:
 *
 *   - the title is a single word (no "Autonomous communities of Spain");
 *   - the lead sentence is COPULAR and its subject is that same word, so the
 *     sentence is about the headword and not about its country or its year;
 *   - the gloss is 3–40 words of prose, with no leftover parenthetical
 *     pronunciation, no list-of-links comma soup, and no sentence that
 *     merely says the word is a name, a title or a disambiguation page;
 *   - the headword is not already defined in the deck's own decks (those
 *     glosses are written for a learner and are better).
 *
 * Usage:
 *   npm run extract-definitions                 # corpus/passages.jsonl → corpus/definitions.jsonl
 *   npm run extract-definitions -- --in corpus/passages.jsonl --out corpus/definitions.jsonl
 *   npm run extract-definitions -- --dry        # report only, write nothing
 *
 * The output is one row per line: {"word","definition","example","source"}.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACTIVE_DECK } from '../teacher/decks';

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const IN = resolve(arg('in', 'corpus/passages.jsonl'));
const OUT = resolve(arg('out', 'corpus/definitions.jsonl'));
const DRY = flag('dry');
const SHOW = Number(arg('show', '12'));

/** A single-word headword: letters, maybe a hyphen or apostrophe. */
const HEADWORD = /^[A-Za-z][A-Za-z'-]*$/;

/**
 * The lead sentence, as a copula: "<subject> is/are/was/were <gloss>." The
 * gloss stops at the first sentence end, and a sentence that never ends
 * inside the first 400 characters is not a lead sentence.
 */
const COPULA = /^(?:An?|The)?\s*([A-Za-z][A-Za-z'-]*)\s+(?:is|are|was|were)\s+([^.]{8,300}?)\.(?:\s|$)/;

/** Prose the gloss must not be: a name, a page, a list. */
const NOT_A_GLOSS =
  /\b(?:disambiguation|may refer to|can refer to|refers to (?:any|several)|a (?:male|female) (?:given )?name|a surname|a common name|the name of|an? (?:article|page|list) )\b/i;

/** Bracketed pronunciation and reference clutter Simple Wikipedia leaves in. */
const CLUTTER = /\s*\((?:[^()]*(?:pronounced|IPA|listen|born|died|Greek|Latin|Hebrew|Arabic|Chinese|Japanese|Russian)[^()]*)\)/gi;

interface Row {
  title?: unknown;
  text?: unknown;
  source?: unknown;
}

interface Definition {
  word: string;
  definition: string;
  example: string;
  source: string;
}

/** The plural/singular pair a copular subject may take for the headword. */
function subjectMatchesHead(subject: string, head: string): boolean {
  if (subject === head) return true;
  if (subject === `${head}s`) return true;
  if (head.endsWith('s') && subject === head.slice(0, -1)) return true;
  if (head.endsWith('y') && subject === `${head.slice(0, -1)}ies`) return true;
  return false;
}

function cleanGloss(raw: string): string | null {
  let gloss = raw.replace(CLUTTER, '').replace(/\s+/g, ' ').trim();
  gloss = gloss.replace(/^(?:also |sometimes |usually |often |commonly )+/i, '');
  if (gloss.length === 0) return null;
  const words = gloss.split(/\s+/);
  if (words.length < 3 || words.length > 40) return null;
  // A gloss that is mostly commas is a list of links, not a meaning.
  if ((gloss.match(/,/g) ?? []).length > 6) return null;
  if (NOT_A_GLOSS.test(gloss)) return null;
  // Unbalanced brackets mean the sentence was cut inside one.
  if ((gloss.match(/\(/g) ?? []).length !== (gloss.match(/\)/g) ?? []).length) return null;
  if (/["“”]/.test(gloss)) return null;
  // A period inside the gloss means the lead sentence was not where the
  // regex thought: "founded around August 1988 and late 1989.p75 It works
  // as a network…" is two sentences and a reference marker.
  if (/[.]/.test(gloss)) return null;
  // Wikipedia's page-reference artifacts ("p75", "pp12–14", "[3]").
  if (/\bpp?\d|\[\d+\]/.test(gloss)) return null;
  return gloss;
}

/** The sentence after the lead one, as the example — only if it is short prose. */
function exampleAfter(text: string, leadEnd: number, head: string): string {
  const rest = text.slice(leadEnd).trim();
  const hit = rest.match(/^([A-Z][^.!?]{10,160}[.!?])/);
  if (hit === null) return '';
  const sentence = hit[1].replace(/\s+/g, ' ').trim();
  // An example earns its place by using the word.
  return new RegExp(`\\b${head}s?\\b`, 'i').test(sentence) ? sentence : '';
}

function main(): void {
  if (!existsSync(IN)) {
    // eslint-disable-next-line no-console
    console.error(`no ${IN} — run npm run fetch-hf -- simplewiki first`);
    process.exit(1);
  }
  const alreadyDefined = new Set(
    ACTIVE_DECK.filter((entry) => entry.definition !== undefined && entry.definition.trim().length > 0).map((entry) => entry.word.toLowerCase())
  );
  const lines = readFileSync(IN, 'utf8').split(/\r?\n/);
  const byWord = new Map<string, Definition>();
  let read = 0;
  let notWiki = 0;
  let multiWord = 0;
  let noCopula = 0;
  let wrongSubject = 0;
  let badGloss = 0;
  let deckAlready = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let row: Row;
    try {
      row = JSON.parse(line) as Row;
    } catch {
      continue;
    }
    read += 1;
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    const source = typeof row.source === 'string' ? row.source : 'passages';
    // Only an encyclopedia opens with a definition; a story does not.
    if (source !== 'simplewiki') {
      notWiki += 1;
      continue;
    }
    if (!HEADWORD.test(title)) {
      multiWord += 1;
      continue;
    }
    const head = title.toLowerCase();
    if (alreadyDefined.has(head)) {
      deckAlready += 1;
      continue;
    }
    const lead = COPULA.exec(text);
    if (lead === null) {
      noCopula += 1;
      continue;
    }
    if (!subjectMatchesHead(lead[1].toLowerCase(), head)) {
      wrongSubject += 1;
      continue;
    }
    const gloss = cleanGloss(lead[2]);
    if (gloss === null) {
      badGloss += 1;
      continue;
    }
    if (byWord.has(head)) continue;
    byWord.set(head, {
      word: head,
      definition: gloss,
      example: exampleAfter(text, lead[0].length, head),
      source: `simplewiki:${title}`
    });
  }
  const definitions = [...byWord.values()].sort((a, b) => a.word.localeCompare(b.word));
  // eslint-disable-next-line no-console
  console.log(
    [
      `=== definitions from ${IN} ===`,
      `  read ${read} passages · kept ${definitions.length} definitions (${definitions.filter((entry) => entry.example.length > 0).length} with an example)`,
      `  rejected: ${notWiki} not encyclopedia · ${multiWord} multi-word title · ${noCopula} no copular lead · ${wrongSubject} lead is about something else · ${badGloss} gloss failed the filters · ${deckAlready} already defined in the deck`,
      `  ${Math.min(SHOW, definitions.length)} of them:`,
      ...definitions.slice(0, SHOW).map((entry) => `    ${entry.word}: ${entry.definition}${entry.example.length > 0 ? ` — "${entry.example}"` : ''}`)
    ].join('\n')
  );
  if (DRY) {
    // eslint-disable-next-line no-console
    console.log('  --dry: nothing written');
    return;
  }
  writeFileSync(OUT, `${definitions.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  // eslint-disable-next-line no-console
  console.log(`  wrote ${OUT}`);
}

main();
