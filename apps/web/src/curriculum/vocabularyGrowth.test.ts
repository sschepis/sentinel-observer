/**
 * @jest-environment node
 *
 * VOCABULARY GROWTH — append-only, and it moves nothing that exists.
 *
 * The observer's stored memories are encoded under the deck's signatures. A
 * word added later must get a signature that collides with none of them,
 * must leave every pre-existing signature byte-identical, and must leave
 * recall of taught words exactly where it was. Growth that fails any of
 * those is not growth, it is corruption — so this is the gate, not a
 * unit test of convenience.
 */
import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { PRIME_SPACE, deckVocabulary } from '../teacher/primeSignature';
import { CONVERSATION_CUE_TOKENS } from '../teacher/conversation';
import { CurriculumFeeder, discoverSources } from './registry';
import type { ConceptNetRow } from './conceptnet';
import type { DeckWord } from '../teacher/deck';

const DECK: readonly DeckWord[] = [
  { word: 'dog', definition: 'a common animal with four legs that people keep as a pet', example: 'The dog barks.' },
  { word: 'animal', definition: 'a living creature that is not a plant', example: 'A dog is an animal.' },
  { word: 'mammal', definition: 'an animal that feeds its young with milk', example: 'A whale is a mammal.' },
  { word: 'bird', definition: 'a creature with wings and feathers that can fly', example: 'A bird can fly.' },
  { word: 'water', definition: 'a clear liquid that falls as rain and is used for drinking', example: 'Water is wet.' },
  { word: 'rain', definition: 'water that falls from clouds', example: 'Rain is wet.' },
  { word: 'farm', definition: 'land and buildings where crops are grown and animals kept', example: 'A farm has cows.' }
];
const VOCAB = deckVocabulary([...DECK, ...CONVERSATION_CUE_TOKENS.map((w) => ({ word: w }))], PRIME_SPACE);
const OPTIONS = { primeCount: 64, gridSize: 128, memoryMode: 'compact' as const, smfWidth: 128, vocabulary: VOCAB };

async function taughtTeacher(): Promise<{ session: ObserverSession; teacher: TeacherAgent }> {
  const session = new ObserverSession(OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, DECK, null, 500, 4, 7);
  for (const entry of DECK) teacher.teach(entry.word);
  return { session, teacher };
}

describe('growVocabulary', () => {
  it('adds word-only entries with unique signatures and leaves every existing signature and every recall byte-identical', async () => {
    const { session, teacher } = await taughtTeacher();
    const observer = session.observer;
    const before = Object.fromEntries(Object.keys(VOCAB).map((word) => [word, [...(observer.vocabularySignature(word) ?? [])]]));
    const recallBefore = DECK.map((entry) => teacher.recallMemories(entry.word, 3).map((m) => `${m.id}:${m.score.toFixed(6)}`));
    const sizeBefore = observer.vocabularySize();

    const growth = teacher.growVocabulary(['zebu', 'okapi', 'Zebu', 'dog', 'ice cream', 'x', 'yak']);
    expect(growth.added.map((entry) => entry.word)).toEqual(['zebu', 'okapi', 'yak']);
    expect(growth.skipped).toBe(4); // duplicate, known, two-word, too short
    expect(observer.vocabularySize()).toBe(sizeBefore + 3);
    // Word-only entries: known, present in the states, undefined.
    expect(teacher.knowsWord('zebu')).toBe(true);
    expect(teacher.listWords().find((entry) => entry.word.word === 'zebu')?.word.definition).toBe('');
    // Unique signatures, four in-basis primes each, colliding with nothing.
    const all = new Set(Object.values(before).map((primes) => primes.join(',')));
    for (const entry of growth.added) {
      expect(entry.primes).toHaveLength(4);
      expect(entry.primes.every((p) => PRIME_SPACE.includes(p))).toBe(true);
      expect(all.has(entry.primes.join(','))).toBe(false);
      all.add(entry.primes.join(','));
      expect(observer.vocabularySignature(entry.word)).toEqual(entry.primes);
    }
    // NOTHING EXISTING MOVED.
    for (const [word, primes] of Object.entries(before)) {
      expect(observer.vocabularySignature(word)).toEqual(primes);
    }
    const recallAfter = DECK.map((entry) => teacher.recallMemories(entry.word, 3).map((m) => `${m.id}:${m.score.toFixed(6)}`));
    expect(recallAfter).toEqual(recallBefore);
    // A grown word encodes: text about it excites its own primes, so an edge
    // about it can be stored and asked.
    teacher.ingestRelationBatch({
      relations: [{ subject: 'zebu', predicate: 'is-a', object: 'mammal', source: 'conceptnet:IsA:w=2:n=2', origin: 'conceptnet' }],
      negations: [],
      skipped: 0,
      read: 1
    });
    const asked = teacher.chatAnswer('is a zebu a mammal');
    expect(asked.mode).toBe('operator');
    if (asked.mode === 'operator') expect(asked.response).toMatch(/^(Probably|I think|I believe so)/);
    // Growth is idempotent: asking again adds nothing.
    expect(teacher.growVocabulary(['zebu', 'yak']).added).toEqual([]);
    session.dispose();
  }, 60000);

  it('grown words ride the record with their exact primes and come back byte-identically on restore', async () => {
    const { session, teacher } = await taughtTeacher();
    const growth = teacher.growVocabulary(['zebu', 'okapi']);
    const record = teacher.exportBootstrap('test');
    const grown = (record.learningState as { grownWords?: Array<{ word: string; primes: number[] }> }).grownWords;
    expect(grown).toEqual(growth.added);
    session.dispose();

    // A fresh observer over the same deck, importing the record: the grown
    // words are there before word states bind, with the same signatures.
    const again = new ObserverSession(OPTIONS, 100);
    await again.initialize();
    const restored = new TeacherAgent(again, DECK, null, 500, 4, 7);
    restored.importBootstrap(record);
    expect(restored.knowsWord('zebu')).toBe(true);
    expect(again.observer.vocabularySignature('zebu')).toEqual(growth.added[0].primes);
    expect(again.observer.vocabularySignature('okapi')).toEqual(growth.added[1].primes);
    // Re-growing on top adds nothing and changes nothing.
    expect(restored.growVocabulary([{ word: 'zebu', primes: [2, 3, 5, 7] }]).added).toEqual([]);
    expect(again.observer.vocabularySignature('zebu')).toEqual(growth.added[0].primes);
    again.dispose();
  }, 60000);

  it('the feeder grows the unknown end of a ConceptNet row whose other end is known, then lands the edge', async () => {
    const { session, teacher } = await taughtTeacher();
    const dir = mkdtempSync(join(tmpdir(), 'corpus-'));
    try {
      const rows: ConceptNetRow[] = [
        { rel: 'IsA', start: 'zebu', end: 'mammal', weight: 2, sources: 2 },
        { rel: 'AtLocation', start: 'zebu', end: 'farm', weight: 1, sources: 1 },
        { rel: 'IsA', start: 'quokka', end: 'wombat', weight: 1, sources: 1 } // neither end known: not grown, not kept
      ];
      writeFileSync(join(dir, 'conceptnet.en.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
      const feeder = new CurriculumFeeder(teacher, discoverSources(dir));
      const report = feeder.step(10);
      expect(report?.grown).toBe(1);
      expect(report?.accepted).toBe(2);
      expect(report?.skipped).toBe(1);
      expect(teacher.knowsWord('zebu')).toBe(true);
      expect(teacher.knowsWord('quokka')).toBe(false);
      const edges = new Set(teacher.relations().map((r) => `${r.subject} ${r.predicate} ${r.object}`));
      expect(edges.has('zebu is-a mammal')).toBe(true);
      expect(edges.has('zebu located-in farm')).toBe(true);
      // The grown word is a curiosity target: heard, undefined.
      teacher.chatAnswer('tell me about a zebu');
      session.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
