/**
 * @jest-environment node
 */
/**
 * READING PRECISION BENCHMARK — the honest gate on learning from text.
 *
 * A hand-labelled passage of encyclopedic prose (the shape a simple-English
 * article or a children's non-fiction book has), with every relation a human
 * would accept written out. The extractor is scored on PRECISION (edges it
 * produced that are correct) and RECALL (labelled edges it found).
 *
 * Precision is the gate that matters: a wrong edge poisons the graph, the
 * corroboration layer and the contradiction sweep. Recall can be low and the
 * system stays honest — the observer simply learned less from the page.
 */
import { describe, it, expect } from '@jest/globals';
import { readText, readSentence, splitSentences, resolveWord } from './reading';
import { ACTIVE_DECK } from './decks';

const VOCABULARY = new Set(ACTIVE_DECK.map((entry) => entry.word));

/** Encyclopedic prose: statements, narrative, dialogue, hedges, questions. */
const PASSAGE = `
The robin is a bird. It has feathers and wings. Robins can fly.
Robins live in gardens and forests. A robin is not a fish.
The nest is made of grass and mud. Birds have beaks.
A whale is a mammal. Whales live in the ocean. A whale is not a fish.
Whales can swim. They have lungs.
The hammer is a tool. A hammer is used for nails.
Iron is a metal. Metal is made of atoms.
"I saw a robin yesterday," said the girl. She thought it was beautiful.
Did the whale sing? Perhaps the bird might migrate in winter.
The old man walked slowly to the river because he was tired.
`;

/** Every relation a careful human would accept from the passage above. */
const EXPECTED: ReadonlyArray<[string, string, string]> = [
  ['robin', 'is-a', 'bird'],
  ['robin', 'has-part', 'feather'],
  ['robin', 'has-part', 'wing'],
  ['robin', 'capable-of', 'fly'],
  ['robin', 'located-in', 'garden'],
  ['robin', 'located-in', 'forest'],
  ['nest', 'made-of', 'grass'],
  ['nest', 'made-of', 'mud'],
  ['bird', 'has-part', 'beak'],
  ['whale', 'is-a', 'mammal'],
  ['whale', 'located-in', 'ocean'],
  ['whale', 'capable-of', 'swim'],
  ['whale', 'has-part', 'lung'],
  ['hammer', 'is-a', 'tool'],
  ['hammer', 'used-for', 'nail'],
  ['iron', 'is-a', 'metal'],
  ['metal', 'made-of', 'atom']
];

/** Statements the passage explicitly denies. */
const EXPECTED_NEGATIONS: ReadonlyArray<[string, string, string]> = [
  ['robin', 'is-a', 'fish'],
  ['whale', 'is-a', 'fish']
];

const key = (s: string, p: string, o: string): string => `${s}|${p}|${o}`;

describe('reading: sentence segmentation', () => {
  it('splits on terminals without breaking abbreviations or decimals', () => {
    const sentences = splitSentences('Dr. Smith saw a robin. It weighed 2.5 grams! Did it fly? Yes.');
    expect(sentences).toEqual([
      'Dr. Smith saw a robin.',
      'It weighed 2.5 grams!',
      'Did it fly?',
      'Yes.'
    ]);
  });
});

describe('reading: the vocabulary gate', () => {
  it('resolves plurals to their deck singular and refuses unknown words', () => {
    expect(resolveWord('robins', VOCABULARY)).toBe('robin');
    expect(resolveWord('feathers', VOCABULARY)).toBe('feather');
    expect(resolveWord('quokkas', VOCABULARY)).toBeNull();
    expect(resolveWord('the', VOCABULARY)).toBeNull();
  });
});

describe('reading: modality gates (nothing unasserted is read)', () => {
  const cases: Array<[string, string]> = [
    ['questions', 'Is a robin a bird?'],
    ['hedges', 'A robin might be a bird.'],
    ['past tense', 'A robin was a bird.'],
    ['future', 'A robin will be a bird.'],
    ['attributed opinion', 'She said a robin is a fish.'],
    ['conditionals', 'If a robin is a bird then it can fly.']
  ];
  for (const [label, sentence] of cases) {
    it(`skips ${label}`, () => {
      expect(readSentence(sentence, VOCABULARY, null)).toEqual([]);
    });
  }
});

describe('reading: anaphora', () => {
  it('resolves "it/they" to the running narrative subject, and drops it when there is none', () => {
    expect(readSentence('It has feathers.', VOCABULARY, 'robin')).toEqual([
      { subject: 'robin', predicate: 'has-part', object: 'feather', negated: false, sentence: 'It has feathers' }
    ]);
    expect(readSentence('It has feathers.', VOCABULARY, null)).toEqual([]);
  });
});

describe('reading precision benchmark (hand-labelled passage)', () => {
  const result = readText(PASSAGE, { vocabulary: VOCABULARY, source: 'benchmark' });
  const expected = new Set(EXPECTED.map(([s, p, o]) => key(s, p, o)));
  const produced = result.relations.map((r) => key(r.subject, r.predicate, r.object));
  const correct = produced.filter((k) => expected.has(k));
  const wrong = produced.filter((k) => !expected.has(k));
  const precision = produced.length === 0 ? 0 : correct.length / produced.length;
  const recall = correct.length / expected.size;

  it('reports its yield', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[readingBench] sentences ${result.sentencesParsed}/${result.sentencesRead} parsed · ` +
        `edges ${produced.length} (correct ${correct.length}, wrong ${wrong.length}) · ` +
        `precision ${(precision * 100).toFixed(1)}% · recall ${(recall * 100).toFixed(1)}% · ` +
        `negations ${result.negations.length} · unknown words ${result.unknownWords.size}` +
        (wrong.length > 0 ? `\n  wrong: ${wrong.join(', ')}` : '')
    );
    expect(result.sentencesRead).toBeGreaterThan(15);
  });

  it('produces no WRONG edges (precision is the honesty gate)', () => {
    expect(wrong).toEqual([]);
  });

  it('reads most of the labelled relations', () => {
    expect(recall).toBeGreaterThanOrEqual(0.7);
  });

  it('reads explicit negations as confirmed-false, not as edges', () => {
    const negated = new Set(result.negations.map((n) => key(n.subject, n.predicate, n.object)));
    for (const [s, p, o] of EXPECTED_NEGATIONS) expect(negated.has(key(s, p, o))).toBe(true);
    // and never as positive edges
    for (const [s, p, o] of EXPECTED_NEGATIONS) expect(produced).not.toContain(key(s, p, o));
  });

  it('stamps reading provenance so corroboration hedges single-source claims', () => {
    for (const relation of result.relations) {
      expect(relation.origin).toBe('reading');
      expect(relation.sourceClasses).toEqual(['reading']);
      expect(relation.source).toContain('benchmark: ');
    }
  });

  it('counts vocabulary exposure and reports unknown words for the curriculum', () => {
    expect(result.knownWords.get('robin')).toBeGreaterThanOrEqual(3);
    expect(result.unknownWords.size).toBeGreaterThanOrEqual(0);
  });
});
