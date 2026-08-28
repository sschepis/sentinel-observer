/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import {
  Chaperone,
  NullChaperoneProvider,
  parseDefinitionsResponse,
  validateGeneratedEntry,
  type ChaperoneProvider
} from './chaperone';
import type { DeckWord } from './deck';

/** Deterministic fake provider for tests. */
class FakeProvider implements ChaperoneProvider {
  readonly name = 'fake';
  private readonly responses: Array<string | Error>;
  private index = 0;

  constructor(responses: Array<string | Error>) {
    this.responses = responses;
  }

  async complete(): Promise<string> {
    const next = this.responses[Math.min(this.index++, this.responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  }
}

const word = (w: string): DeckWord => ({ word: w, definition: '', example: '' });

describe('parseDefinitionsResponse', () => {
  it('parses a JSON array and strips code fences', () => {
    const parsed = parseDefinitionsResponse('```json\n[{"word":"apple","definition":"a fruit","example":"I eat an apple."}]\n```');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].word).toBe('apple');
  });

  it('rejects non-array responses', () => {
    expect(() => parseDefinitionsResponse('{"word":"apple"}')).toThrow();
    expect(() => parseDefinitionsResponse('just prose')).toThrow();
  });
});

describe('validateGeneratedEntry', () => {
  it('accepts valid content', () => {
    const entry = validateGeneratedEntry(
      { word: 'apple', definition: 'a round red or green fruit', example: 'I eat an apple every day.' },
      'apple'
    );
    expect(entry).not.toBeNull();
  });

  it('rejects the wrong word, short content, and examples without the word', () => {
    expect(
      validateGeneratedEntry({ word: 'apply', definition: 'a round fruit', example: 'I eat an apple.' }, 'apple')
    ).toBeNull();
    expect(
      validateGeneratedEntry({ word: 'apple', definition: 'a', example: 'I eat an apple.' }, 'apple')
    ).toBeNull();
    expect(
      validateGeneratedEntry({ word: 'apple', definition: 'a round red or green fruit', example: 'I eat one.' }, 'apple')
    ).toBeNull();
  });
});

describe('Chaperone.generateBatch', () => {
  it('accepts valid entries and reports invalid ones as skipped — never silently', async () => {
    const provider = new FakeProvider([
      JSON.stringify([
        { word: 'apple', definition: 'a round red or green fruit', example: 'I eat an apple.' },
        { word: 'water', definition: 'x', example: 'wrong example' },
        { word: 'music', definition: 'sounds that are pleasant', example: 'I listen to music.' }
      ])
    ]);
    const chaperone = new Chaperone(provider);
    const result = await chaperone.generateBatch([word('apple'), word('water'), word('music')]);

    expect(result.definitions.map((d) => d.word)).toEqual(['apple', 'music']);
    expect(result.skipped).toEqual(['water']);
  });

  it('propagates provider failures', async () => {
    const chaperone = new Chaperone(new FakeProvider([new Error('LLM endpoint returned 500')]));
    await expect(chaperone.generateBatch([word('apple')])).rejects.toThrow('500');
  });
});

describe('Chaperone.fillDefinitions', () => {
  it('batches progress, collects errors, and honors abort', async () => {
    const words = Array.from({ length: 10 }, (_, i) => word(`w${i}`));
    // Prompt-aware fake: responds with valid entries for the words in the
    // prompt, so validation succeeds per batch.
    const provider: ChaperoneProvider = {
      name: 'prompt-aware',
      async complete(prompt: string): Promise<string> {
        const entries = words
          .filter((w) => prompt.includes(w.word))
          .map((w) => ({
            word: w.word,
            definition: `the meaning of ${w.word}`,
            example: `I use ${w.word} in a sentence.`
          }));
        return JSON.stringify(entries);
      }
    };
    const chaperone = new Chaperone(provider);

    const batches: number[] = [];
    const result = await chaperone.fillDefinitions(words, {
      batchSize: 4,
      onBatch: (done) => batches.push(done)
    });

    expect(batches).toEqual([4, 8, 10]);
    expect(result.definitions).toHaveLength(10);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('reports the honest absence of a provider', async () => {
    const chaperone = new Chaperone(new NullChaperoneProvider());
    expect(chaperone.getProviderName()).toBe('none');
    const result = await chaperone.fillDefinitions([word('apple')], { batchSize: 1 });
    expect(result.definitions).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/no LLM provider configured/);
  });
});
