#!/usr/bin/env node
/**
 * POLYSEMY BENCH (§7.1 / §7.5, Phase F.1/F.2) — size the cross-sense
 * fabrication path, BEFORE and AFTER the sense split.
 *
 * §7.1 proposes that a word whose relation graph carries is-a parents from
 * more than one sense (e.g. 'bank' → institution AND slope) can answer
 * cross-sense probes "Yes" with provenance — a confident, wrong answer the
 * adversarial bench cannot see, because its negative-target selector computes
 * the merged closure and so never probes the cross-sense claim.
 *
 * This bench measures that claim against the FULL shipped record when it is
 * available (`public/bootstrap.json`), and falls back to a small, local deck
 * of real polysemous words when it is not. The probe set is DERIVED from the
 * relation graph (wordsWithUnrelatedIsAParents / crossSenseProbesFor), never
 * hand-written. Two passes run in one invocation:
 *
 *   1. BEFORE (§7.1, the merged-sense era) — the default teacher. The
 *      printed count of confident cross-sense "Yes" answers is the size of
 *      the exposure.
 *   2. AFTER (§7.2, senseSplit ON) — each reading gets its own sense node
 *      with its own four-prime signature; the surface word excites the
 *      union at split amplitude; the same probes must produce 0 confident
 *      cross-sense answers, with a disambiguating ask where context is
 *      absent (the §2 instrument: recall over the sense candidates is
 *      bimodal → 'disambiguate').
 *
 * Usage: npx tsx src/cli/polysemy-bench.ts [record.json]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ObserverSession } from '../observer/engine';
import { OBSERVER_OPTIONS } from '../observer/options';
import { ACTIVE_DECK } from '../teacher/decks';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { PRIME_SPACE, deckVocabulary } from '../teacher/primeSignature';
import { claimsRelationalYes } from '../teacher/adversarial';
import { BOOTSTRAP_VERSION, BOOTSTRAP_VOCABULARY_SCHEME, type BootstrapRecord } from '../teacher/bootstrap';
import {
  wordsWithUnrelatedIsAParents,
  isAParentsOf,
  isAQuestion
} from '../teacher/polysemyProbes';
import {
  assignSenses,
  mergedGraphFor,
  reservedSignatureKeys,
  senseVocabulary,
  type SenseAssignment
} from '../teacher/senseModel';
import type { Relation } from '../teacher/relations';
import type { DeckWord } from '../teacher/deck';

/** A small local deck of real polysemous words — the record-less fallback. */
const LOCAL_DECK: readonly DeckWord[] = [
  { word: 'bank', definition: 'a financial institution that keeps and lends money', example: 'The bank keeps my money.' },
  { word: 'institution', definition: 'an organization that serves a public purpose', example: 'A school is an institution.' },
  { word: 'slope', definition: 'a surface that slants up or down', example: 'The hill has a slope.' },
  { word: 'spring', definition: 'a season of the year when plants begin to grow', example: 'Flowers bloom in spring.' },
  { word: 'season', definition: 'a division of the year with its own weather', example: 'Winter is a cold season.' },
  { word: 'coil', definition: 'a series of rings wound into a spiral', example: 'A spring is a metal coil.' },
  { word: 'bark', definition: 'the hard outer layer of a tree', example: 'The tree has rough bark.' },
  { word: 'layer', definition: 'a flat sheet that lies over something', example: 'The cake has a top layer.' },
  { word: 'sound', definition: 'a noise that can be heard', example: 'The bell makes a sound.' },
  { word: 'mole', definition: 'a small animal that digs tunnels underground', example: 'The mole digs in the garden.' },
  { word: 'animal', definition: 'a living thing that can move and feel', example: 'A dog is an animal.' },
  { word: 'unit', definition: 'a fixed amount used for measuring', example: 'A meter is a unit of length.' },
  { word: 'organ', definition: 'a musical instrument with pipes that makes music', example: 'The organ plays in the church.' },
  { word: 'instrument', definition: 'a tool made for making music', example: 'The piano is an instrument.' },
  { word: 'part', definition: 'a piece of a larger whole', example: 'The wheel is a part of the car.' },
  { word: 'crane', definition: 'a tall bird with long legs that wades in water', example: 'The crane stands by the pond.' },
  { word: 'bird', definition: 'an animal with wings and feathers', example: 'The bird sings.' },
  { word: 'machine', definition: 'a device with moving parts that does work', example: 'The machine lifts heavy loads.' }
];

const LOCAL_CHAPERONE_SENSES: readonly Relation[] = [
  { subject: 'bank', predicate: 'is-a', object: 'slope', source: 'sloping land beside a body of water', origin: 'chaperone' },
  { subject: 'spring', predicate: 'is-a', object: 'coil', source: 'a wound metal device that returns to shape', origin: 'chaperone' },
  { subject: 'bark', predicate: 'is-a', object: 'sound', source: 'the sharp sound a dog makes', origin: 'chaperone' },
  { subject: 'mole', predicate: 'is-a', object: 'unit', source: 'a chemical unit of amount', origin: 'chaperone' },
  { subject: 'organ', predicate: 'is-a', object: 'part', source: 'a part of the body that does a job', origin: 'chaperone' },
  { subject: 'crane', predicate: 'is-a', object: 'machine', source: 'a machine that lifts and moves heavy things', origin: 'chaperone' }
];

const LOCAL_BOOTSTRAP_RECORD: BootstrapRecord = {
  version: BOOTSTRAP_VERSION,
  vocabularyScheme: BOOTSTRAP_VOCABULARY_SCHEME,
  deck: 'polysemy-probe',
  generatedAt: new Date().toISOString(),
  source: { words: LOCAL_DECK.map((d) => d.word), conversation: false, definitionsFilled: true },
  traces: [],
  wordStates: [],
  definitions: LOCAL_DECK.map((d) => ({ word: d.word, definition: d.definition, example: d.example })),
  relations: LOCAL_CHAPERONE_SENSES.map((r) => ({ ...r }))
};

interface Measurement {
  exposed: string[];
  crossSenseConfidentYes: number;
  confidentlyMultiSense: string[];
  disambiguatingAsks: number;
  confidentYesTotal: number;
}

/**
 * The measurement itself: derive the probe set from the UNSPlit graph (the
 * surface-word view both eras share), run every cross-sense probe through
 * chatAnswer, and classify each answer as a confident "Yes" (the exposure),
 * a hedged answer, or a disambiguating ask. A parent is a CROSS-SENSE
 * parent when its origin is not 'regex' (i.e. the word's definitional
 * gloss) — those are the "other senses" §7.1 is about.
 */
function measure(teacher: TeacherAgent, title: string): Measurement {
  const relations = teacher.unsplitRelations();
  const exposed = wordsWithUnrelatedIsAParents(relations);

  let crossSenseConfidentYes = 0;
  let disambiguatingAsks = 0;
  let confidentYesTotal = 0;
  const confidentlyMultiSense: string[] = [];
  console.log(`\n-- ${title} --`);
  for (const word of exposed) {
    const parents = isAParentsOf(relations, word);
    let wordConfident = 0;
    for (const parent of parents) {
      const origin = relations.find(
        (r) => r.subject === word && r.predicate === 'is-a' && r.object === parent
      )?.origin;
      const probe = isAQuestion(word, parent);
      const answer = teacher.chatAnswer(probe);
      const confident = claimsRelationalYes(answer);
      if (confident) {
        wordConfident += 1;
        confidentYesTotal += 1;
        if (origin !== 'regex') crossSenseConfidentYes += 1;
      }
      const spoken = 'response' in answer ? answer.response : '';
      if (answer.mode === 'ask' && /^Do you mean /.test(spoken)) disambiguatingAsks += 1;
      console.log(`  ${probe.padEnd(34)} [${origin ?? '?'}] -> [${answer.mode}] ${spoken}`);
    }
    if (wordConfident >= 2) confidentlyMultiSense.push(word);
  }
  return { exposed, crossSenseConfidentYes, confidentlyMultiSense, disambiguatingAsks, confidentYesTotal };
}

function report(measurement: Measurement, split: boolean): void {
  console.log(`\nwords with unrelated is-a parents: ${measurement.exposed.length}`);
  if (split) {
    console.log(`confident cross-sense "Yes" answers after the sense split: ${measurement.crossSenseConfidentYes}`);
    console.log(`confident "Yes" answers total (all senses): ${measurement.confidentYesTotal}`);
    console.log(`disambiguating asks (context absent): ${measurement.disambiguatingAsks}`);
    console.log(`words confidently asserted under TWO unrelated senses: ${measurement.confidentlyMultiSense.length}${measurement.confidentlyMultiSense.length > 0 ? ` — ${measurement.confidentlyMultiSense.join(', ')}` : ''}`);
    console.log(`\n§7.2 after-split: ${measurement.crossSenseConfidentYes === 0 ? 'PASS — 0 confident cross-sense answers' : `FAIL — exposure remains ${measurement.crossSenseConfidentYes}`}`);
  } else {
    console.log(`confident cross-sense "Yes" answers (size of the exposure): ${measurement.crossSenseConfidentYes}`);
    console.log(`words confidently asserted under TWO unrelated senses: ${measurement.confidentlyMultiSense.length}${measurement.confidentlyMultiSense.length > 0 ? ` — ${measurement.confidentlyMultiSense.join(', ')}` : ''}`);
    console.log(`\n§7.1: ${measurement.crossSenseConfidentYes === 0 ? 'NOT confirmed — the merged-sense path is hedged, not confident, for this record' : `CONFIRMED — exposure size ${measurement.crossSenseConfidentYes}`}`);
  }
}

/** The after-split assignment, minted over the same merged graph the
 *  teacher derives and reserved against the deployed vocabulary — so the
 *  session vocabulary and the teacher's split agree by construction. */
function assignmentFor(relations: readonly Relation[], vocabulary: Readonly<Record<string, readonly number[]>>): SenseAssignment {
  return assignSenses(relations, PRIME_SPACE, reservedSignatureKeys(vocabulary));
}

/** The definitions the teacher actually derives from: the deck's own
 *  definitions, with the record filling only EMPTY ones (exactly what
 *  `applyDefinitions` does on import). The assignment must be minted over
 *  this graph — minting it over the record's definitions alone misses every
 *  deck-defined word (the record omits them), leaving the split to cover a
 *  different population than the teacher's graph exposes. */
function effectiveDefinitionsFor(record: BootstrapRecord): Array<{ word: string; definition: string }> {
  const recordDefs = new Map((record.definitions ?? []).map((d) => [d.word, d]));
  return ACTIVE_DECK.map((entry) => {
    if (entry.definition.trim().length > 0) return { word: entry.word, definition: entry.definition };
    const recordDef = recordDefs.get(entry.word);
    return { word: entry.word, definition: recordDef !== undefined ? recordDef.definition : entry.definition };
  });
}

async function benchShippedRecord(path: string): Promise<void> {
  console.log(`\n=== ${path} — full shipped record ===`);
  const record = JSON.parse(readFileSync(path, 'utf8')) as BootstrapRecord;

  // ── BEFORE: the merged-sense era (§7.1 exposure) ────────────────────────
  {
    const session = new ObserverSession(OBSERVER_OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, ACTIVE_DECK, null, 1, 0, 7);
    const imported = teacher.importBootstrap(record);
    console.log(`restored ${imported.restored} traces, ${imported.definitions} definitions`);
    report(measure(teacher, 'BEFORE sense split (§7.1 merged-sense era)'), false);
    session.dispose();
  }

  // ── AFTER: the sense split (§7.2, senseSplit ON) ─────────────────────────
  {
    const known = new Set(ACTIVE_DECK.map((entry) => entry.word));
    const effectiveDefinitions = effectiveDefinitionsFor(record);
    const merged = mergedGraphFor(effectiveDefinitions, known, record.relations ?? []);
    const assignment = assignmentFor(merged, OBSERVER_OPTIONS.vocabulary);
    const session = new ObserverSession(
      { ...OBSERVER_OPTIONS, vocabulary: senseVocabulary(OBSERVER_OPTIONS.vocabulary, assignment) },
      100
    );
    await session.initialize();
    const teacher = new TeacherAgent(session, ACTIVE_DECK, null, 1, 0, 7, undefined, undefined, undefined, false, { assignment });
    teacher.importBootstrap(record);
    // Split deployment over a merged-era record: re-teach one trace PER SENSE
    // for the exposed words (the record's word traces live on the surface).
    const exposed = wordsWithUnrelatedIsAParents(merged);
    let stored = 0;
    for (const word of exposed) stored += teacher.ensureSenseTraces(word);
    console.log(`split deployment: ${stored} sense traces re-taught over ${exposed.length} exposed words`);
    report(measure(teacher, 'AFTER sense split (§7.2 senseSplit ON)'), true);
    session.dispose();
  }
}

async function benchLocalDeck(): Promise<void> {
  console.log('\n=== local polysemous deck reproduction (no shipped record) ===');
  const localGraph = mergedGraphFor(
    LOCAL_DECK.map((d) => ({ word: d.word, definition: d.definition })),
    new Set(LOCAL_DECK.map((d) => d.word)),
    LOCAL_CHAPERONE_SENSES
  );

  // ── BEFORE: the merged-sense era (§7.1 exposure) ────────────────────────
  {
    const session = new ObserverSession(
      { primeCount: 64, gridSize: 128, memoryMode: 'compact', smfWidth: 128, vocabulary: deckVocabulary(LOCAL_DECK, PRIME_SPACE) },
      100
    );
    await session.initialize();
    const teacher = new TeacherAgent(session, LOCAL_DECK);
    for (const entry of LOCAL_DECK) teacher.teach(entry.word);
    teacher.importBootstrap(LOCAL_BOOTSTRAP_RECORD);
    report(measure(teacher, 'BEFORE sense split (§7.1 merged-sense era)'), false);
    session.dispose();
  }

  // ── AFTER: the sense split (§7.2, senseSplit ON) ─────────────────────────
  {
    const baseVocabulary = deckVocabulary(LOCAL_DECK, PRIME_SPACE);
    const assignment = assignmentFor(localGraph, baseVocabulary);
    const session = new ObserverSession(
      { primeCount: 64, gridSize: 128, memoryMode: 'compact', smfWidth: 128, vocabulary: senseVocabulary(baseVocabulary, assignment) },
      100
    );
    await session.initialize();
    const teacher = new TeacherAgent(session, LOCAL_DECK, null, 1, 0, 7, undefined, undefined, undefined, false, { assignment });
    // Import the chaperone senses FIRST so teach sees the split and stores
    // one trace per sense (the split-era teaching order).
    teacher.importBootstrap(LOCAL_BOOTSTRAP_RECORD);
    for (const entry of LOCAL_DECK) teacher.teach(entry.word);
    report(measure(teacher, 'AFTER sense split (§7.2 senseSplit ON)'), true);
    session.dispose();
  }
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const recordPath = positional.length > 0 ? positional[0] : join(process.cwd(), 'public', 'bootstrap.json');
  if (existsSync(recordPath)) {
    await benchShippedRecord(recordPath);
  } else {
    console.log(`shipped record not found at ${recordPath} — falling back to the local probe deck`);
    await benchLocalDeck();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
