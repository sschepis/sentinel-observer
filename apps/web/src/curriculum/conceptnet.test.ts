/**
 * @jest-environment node
 *
 * ConceptNet → the relation graph (src/curriculum). The adapter, the
 * multi-valued ingestion path, the held-out split and the persisted cursor.
 * Rule 1 for the ingestion itself: the observer must answer what it was
 * fed, hedge it as single-source, refuse what ConceptNet denies, and know
 * nothing about the held-out rows.
 */
import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  conceptNetToRelations,
  conceptNetConfidenceBump,
  conceptNetWeightOf,
  conceptTerm,
  parseConceptNetLine,
  parseConceptNetJsonl,
  type ConceptNetRow
} from './conceptnet';
import { CurriculumFeeder, discoverSources, isHeldOutRow, HOLD_OUT_EVERY } from './registry';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { PRIME_SPACE, deckVocabulary } from '../teacher/primeSignature';
import { CONVERSATION_CUE_TOKENS } from '../teacher/conversation';
import type { DeckWord } from '../teacher/deck';

const row = (rel: string, start: string, end: string, weight = 1, sources = 1): ConceptNetRow => ({ rel, start, end, weight, sources });

describe('the ConceptNet adapter', () => {
  it('reads English concept URIs and drops other languages', () => {
    expect(conceptTerm('/c/en/dog')).toBe('dog');
    expect(conceptTerm('/c/en/ice_cream/n/wn/food')).toBe('ice cream');
    expect(conceptTerm('/c/fr/chien')).toBeNull();
    expect(conceptTerm('/r/IsA')).toBeNull();
  });

  it('parses an assertions-dump line, keeping weight, contributor count and surface text', () => {
    const line = [
      '/a/[/r/IsA/,/c/en/dog/n/,/c/en/animal/]',
      '/r/IsA',
      '/c/en/dog/n',
      '/c/en/animal',
      '{"dataset": "/d/wordnet/3.1", "license": "cc:by/4.0", "sources": [{"contributor": "/s/resource/wordnet/rdf/3.1"}, {"contributor": "/s/resource/verbosity"}], "surfaceText": "[[a dog]] is [[an animal]]", "weight": 2.0}'
    ].join('\t');
    expect(parseConceptNetLine(line)).toEqual({ rel: 'IsA', start: 'dog', end: 'animal', weight: 2, sources: 2, surface: '[[a dog]] is [[an animal]]' });
    // Unmapped relations and non-English ends are not rows.
    expect(parseConceptNetLine(line.replace(/IsA/g, 'RelatedTo'))).toBeNull();
    expect(parseConceptNetLine(line.replaceAll('/c/en/animal', '/c/de/tier'))).toBeNull();
  });

  it('maps relations onto the observer\'s predicates, swaps PartOf, filters to single deck words, and separates Not* claims', () => {
    const vocabulary = new Set(['dog', 'animal', 'pet', 'wheel', 'car', 'fly', 'bird', 'fish']);
    const batch = conceptNetToRelations(
      [
        row('IsA', 'dog', 'animal', 2.8, 3),
        row('IsA', 'dog', 'pet'),
        row('PartOf', 'wheel', 'car'),
        row('CapableOf', 'bird', 'fly'),
        row('NotIsA', 'dog', 'fish'),
        row('IsA', 'dog', 'animal'), // duplicate
        row('IsA', 'dog', 'dog'), // self-edge
        row('IsA', 'ice cream', 'food'), // multi-word / out of vocabulary
        row('RelatedTo', 'dog', 'animal') // unmapped
      ],
      vocabulary
    );
    expect(batch.relations.map((r) => `${r.subject} ${r.predicate} ${r.object}`)).toEqual([
      'dog is-a animal',
      'dog is-a pet',
      'car has-part wheel',
      'bird capable-of fly'
    ]);
    expect(batch.relations.every((r) => r.origin === 'conceptnet')).toBe(true);
    expect(batch.relations[0].source).toBe('conceptnet:IsA:w=2.8:n=3');
    expect(batch.negations).toEqual([{ subject: 'dog', predicate: 'is-a', object: 'fish', evidence: 'conceptnet:NotIsA:w=1:n=1' }]);
    expect(batch.skipped).toBe(4);
    expect(batch.read).toBe(9);
  });

  it('weight → a small confidence overlay; the weight is recoverable from the source string', () => {
    expect(conceptNetConfidenceBump(1)).toBe(0);
    expect(conceptNetConfidenceBump(2)).toBeCloseTo(0.1, 9);
    expect(conceptNetConfidenceBump(9)).toBe(0.3);
    expect(conceptNetWeightOf('conceptnet:IsA:w=2.8:n=3')).toBe(2.8);
    expect(conceptNetWeightOf('chaperone')).toBe(1);
  });

  it('round-trips the fetcher\'s JSONL, dropping malformed lines', () => {
    const rows = parseConceptNetJsonl(`${JSON.stringify(row('IsA', 'dog', 'animal', 2, 2))}\nnot json\n\n${JSON.stringify({ rel: 'UsedFor', start: 'car', end: 'travel' })}`);
    expect(rows).toEqual([row('IsA', 'dog', 'animal', 2, 2), { rel: 'UsedFor', start: 'car', end: 'travel', weight: 1, sources: 1, surface: undefined }]);
  });

  it('holds out every tenth row', () => {
    expect(HOLD_OUT_EVERY).toBe(10);
    expect([0, 1, 8, 9, 10, 19, 20].map(isHeldOutRow)).toEqual([false, false, false, true, false, true, false]);
  });
});

const DECK: readonly DeckWord[] = [
  { word: 'dog', definition: 'a common animal with four legs that people keep as a pet', example: 'The dog barks.' },
  { word: 'animal', definition: 'a living creature that is not a plant', example: 'A dog is an animal.' },
  { word: 'pet', definition: 'an animal kept at home for company', example: 'My pet sleeps.' },
  { word: 'mammal', definition: 'an animal that feeds its young with milk', example: 'A whale is a mammal.' },
  { word: 'fish', definition: 'a creature that lives in water and breathes through gills', example: 'A fish swims.' },
  { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
  { word: 'fly', definition: 'to move through the air with wings', example: 'Birds fly.' },
  { word: 'sing', definition: 'to make musical sounds with the voice', example: 'Birds sing.' },
  { word: 'wing', definition: 'a part of a bird used for flying', example: 'A wing flaps.' },
  { word: 'car', definition: 'a road vehicle with four wheels and an engine', example: 'The car is fast.' },
  { word: 'wheel', definition: 'a round part that turns so a vehicle can move', example: 'A wheel turns.' },
  { word: 'travel', definition: 'to go from one place to another', example: 'We travel by car.' },
  // Not in any authored curriculum: the single-source case must exist.
  { word: 'zebu', definition: 'a kind of ox with a hump on its back', example: 'A zebu pulls the cart.' }
];

const OPTIONS = {
  primeCount: 64,
  gridSize: 128,
  memoryMode: 'compact' as const,
  smfWidth: 128,
  vocabulary: deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE)
};

async function taughtTeacher(): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, DECK, null, 500, 4, 7);
  for (const entry of DECK) teacher.teach(entry.word);
  return { session, teacher };
}

describe('ingesting ConceptNet into the observer', () => {
  it('multi-valued: several objects per predicate all land; a ConceptNet denial refuses exactly that claim; agreement raises confidence', async () => {
    const { session, teacher } = await taughtTeacher();
    const before = teacher.relations().length;
    const vocabulary = new Set(DECK.map((entry) => entry.word));
    const batch = conceptNetToRelations(
      [
        row('IsA', 'dog', 'animal', 3.5, 4), // agrees with the definition head
        row('IsA', 'dog', 'pet'),
        row('IsA', 'dog', 'mammal'),
        row('NotIsA', 'dog', 'fish'),
        row('IsA', 'dog', 'fish'), // denied by the row above
        row('CapableOf', 'bird', 'fly'),
        row('CapableOf', 'bird', 'sing'),
        row('PartOf', 'wheel', 'car'),
        row('UsedFor', 'car', 'travel'),
        row('IsA', 'zebu', 'mammal')
      ],
      vocabulary
    );
    const took = teacher.ingestRelationBatch(batch);
    expect(took.negations).toBe(1);
    expect(took.denied).toBe(1);
    // dog is-a animal was already in the graph (definition extraction): agreed, not new.
    expect(took.agreed).toBeGreaterThanOrEqual(1);
    const edges = new Set(teacher.relations().map((r) => `${r.subject} ${r.predicate} ${r.object}`));
    expect(edges.has('dog is-a pet')).toBe(true);
    expect(edges.has('dog is-a mammal')).toBe(true);
    expect(edges.has('dog is-a fish')).toBe(false);
    expect(edges.has('bird capable-of sing')).toBe(true);
    expect(edges.has('car has-part wheel')).toBe(true);
    expect(edges.has('car used-for travel')).toBe(true);
    expect(teacher.relations().length).toBeGreaterThan(before);
    // No same-predicate "conflict" beliefs were manufactured by the many is-a objects.
    expect(teacher.beliefsOf('dog').filter((b) => b.beliefKind === 'relation-conflict')).toHaveLength(0);

    // Spoken: an edge ONLY ConceptNet states is answered hedged (one outside
    // voice); one the authored curriculum also states is corroborated and
    // answered flat. Which is which is read from the graph, not assumed.
    const zebu = teacher.relations().find((r) => r.subject === 'zebu' && r.predicate === 'is-a' && r.object === 'mammal');
    expect(zebu?.sourceClasses).toEqual(['conceptnet']);
    const hedged = teacher.chatAnswer('is a zebu a mammal');
    expect(hedged.mode).toBe('operator');
    if (hedged.mode === 'operator') expect(hedged.response).toMatch(/^(Probably|I think|I believe so)/);
    const corroborated = teacher.relations().find((r) => r.subject === 'dog' && r.predicate === 'is-a' && r.object === 'pet');
    expect(corroborated?.sourceClasses).toEqual(expect.arrayContaining(['conceptnet']));
    expect((corroborated?.sourceClasses?.length ?? 0) >= 2).toBe(true);
    const flat = teacher.chatAnswer('is a dog a pet');
    if (flat.mode === 'operator') expect(flat.response).toMatch(/^Yes/);
    const fish = teacher.chatAnswer('is a dog a fish');
    expect(fish.mode).toBe('operator');
    if (fish.mode === 'operator') expect(fish.response).toMatch(/^No/);
    // The agreeing edge carries two classes now (curriculum + conceptnet) and its weight bump.
    const agreed = teacher.relations().find((r) => r.subject === 'dog' && r.predicate === 'is-a' && r.object === 'animal');
    expect(agreed?.sourceClasses).toEqual(expect.arrayContaining(['curriculum', 'conceptnet']));
    session.dispose();
  }, 60000);

  it('the feeder skips held-out rows, advances the persisted cursor, resumes after a restore, and never ingests a row twice', async () => {
    const { session, teacher } = await taughtTeacher();
    const dir = mkdtempSync(join(tmpdir(), 'corpus-'));
    try {
      const rows: ConceptNetRow[] = [];
      const objects = ['animal', 'pet', 'mammal'];
      // 30 rows: 3 subjects × objects, then filler UsedFor edges; row 9, 19, 29 are held out.
      for (let i = 0; i < 30; i += 1) {
        const subject = ['dog', 'bird', 'car'][i % 3];
        rows.push(i < 9 ? row('IsA', subject, objects[i % 3]) : row('UsedFor', subject, 'travel', 1 + (i % 3)));
      }
      writeFileSync(join(dir, 'conceptnet.en.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
      const sources = discoverSources(dir);
      expect(sources.map((s) => s.id)).toEqual(['conceptnet']);
      const feeder = new CurriculumFeeder(teacher, sources);
      expect(feeder.remaining(sources[0])).toBe(30);
      expect(feeder.heldOutRows(sources[0])).toHaveLength(3);

      const first = feeder.step(12);
      expect(first?.rows).toBe(12);
      expect(teacher.curriculumCursor('conceptnet')).toBe(12);
      expect(first?.remaining).toBe(18);
      const second = feeder.step(12);
      expect(teacher.curriculumCursor('conceptnet')).toBe(24);
      const third = feeder.step(12);
      expect(third?.rows).toBe(6);
      expect(teacher.curriculumCursor('conceptnet')).toBe(30);
      expect(feeder.step(12)).toBeNull(); // exhausted
      expect(second).not.toBeNull();

      // The cursor rides the record: a restored teacher resumes at 30 and re-ingests nothing.
      const record = teacher.exportBootstrap('test');
      expect((record.learningState as { curriculumCursors?: Record<string, number> }).curriculumCursors).toEqual({ conceptnet: 30 });
      const again = new CurriculumFeeder(teacher, sources);
      expect(again.remaining(sources[0])).toBe(0);
      session.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
