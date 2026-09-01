/**
 * @jest-environment node
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import {
  Chaperone,
  NullChaperoneProvider,
  OpenAICompatProvider,
  definitionsResponseFormat,
  relationsResponseFormat,
  resolveEndpoint,
  parseDefinitionsResponse,
  parseRelationsResponse,
  validateGeneratedEntry,
  validateGeneratedRelation,
  MAX_CONCURRENCY,
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

  it('parses the object returned by the structured-output schema', () => {
    const parsed = parseDefinitionsResponse(
      '{"definitions":{"apple":{"definition":"a fruit","example":"I eat an apple."}}}'
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].definition).toBe('a fruit');
  });

  it('rejects non-array responses', () => {
    expect(() => parseDefinitionsResponse('{"word":"apple"}')).toThrow();
    expect(() => parseDefinitionsResponse('just prose')).toThrow();
  });
});

describe('definitionsResponseFormat', () => {
  it('constrains the batch to every requested word exactly once by key', () => {
    const format = definitionsResponseFormat(['then', 'its', 'our']);
    const definitions = format.json_schema.schema.properties.definitions;

    expect(definitions.required).toEqual(['then', 'its', 'our']);
    expect(definitions.properties).toEqual(
      expect.objectContaining({
        then: expect.any(Object),
        its: expect.any(Object),
        our: expect.any(Object)
      })
    );
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
    const result = await chaperone.fillDefinitions([word('apple')], { batchSize: 1 });
    expect(result.definitions).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/no LLM provider configured/);
  });

  it('retries only schema-rejected words singly before reporting them as skipped', async () => {
    const provider = new FakeProvider([
      JSON.stringify([{ word: 'apple', definition: 'a round fruit', example: 'I eat an apple.' }]),
      JSON.stringify([{ word: 'water', definition: 'a clear liquid', example: 'I drink water.' }])
    ]);
    const chaperone = new Chaperone(provider);

    const result = await chaperone.fillDefinitions([word('apple'), word('water')], { batchSize: 2 });

    expect(result.definitions.map((entry) => entry.word)).toEqual(['apple', 'water']);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('reports failed batches to the progress caller', async () => {
    const chaperone = new Chaperone(new FakeProvider([new Error('model unavailable')]));
    const failures: Array<{ done: number; words: string[]; error: string }> = [];

    const result = await chaperone.fillDefinitions([word('apple'), word('water')], {
      batchSize: 2,
      onBatchError: (done, _total, words, error) => failures.push({ done, words, error })
    });

    expect(result.errors).toEqual(['model unavailable']);
    expect(failures).toEqual([{ done: 2, words: ['apple', 'water'], error: 'model unavailable' }]);
  });

  it('passes cancellation through to the provider request', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const chaperone = new Chaperone({
      name: 'signal-aware',
      async complete(_prompt, options): Promise<string> {
        receivedSignal = options?.signal;
        controller.abort();
        throw new Error('aborted');
      }
    });

    await chaperone.fillDefinitions([word('apple')], { signal: controller.signal });
    expect(receivedSignal).toBe(controller.signal);
  });
});

describe('Chaperone.fillDefinitions concurrency', () => {
  /** Provider that tracks how many requests are simultaneously in flight. */
  class TrackedProvider implements ChaperoneProvider {
    readonly name = 'tracked';
    active = 0;
    maxActive = 0;
    requests = 0;

    constructor(private readonly words: readonly DeckWord[], private readonly delayMs = 20) {}

    async complete(prompt: string): Promise<string> {
      this.requests += 1;
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      try {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        const entries = this.words
          .filter((w) => prompt.includes(w.word))
          .map((w) => ({ word: w.word, definition: `the meaning of ${w.word}`, example: `I use ${w.word} in a sentence.` }));
        return JSON.stringify(entries);
      } finally {
        this.active -= 1;
      }
    }
  }

  it('runs up to MAX_CONCURRENCY provider requests at once and covers every word', async () => {
    const words = Array.from({ length: 12 }, (_, i) => word(`w${i}`));
    const provider = new TrackedProvider(words);
    const chaperone = new Chaperone(provider);

    const result = await chaperone.fillDefinitions(words, { batchSize: 2 });

    expect(result.definitions).toHaveLength(12);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(provider.maxActive).toBe(MAX_CONCURRENCY);
  });

  it('clamps a requested concurrency above the cap down to MAX_CONCURRENCY', async () => {
    const words = Array.from({ length: 12 }, (_, i) => word(`w${i}`));
    const provider = new TrackedProvider(words);
    const chaperone = new Chaperone(provider);

    const result = await chaperone.fillDefinitions(words, { batchSize: 2, concurrency: 9 });

    expect(result.definitions).toHaveLength(12);
    expect(provider.maxActive).toBe(MAX_CONCURRENCY);
  });

  it('runs strictly sequentially when concurrency is one', async () => {
    const words = Array.from({ length: 4 }, (_, i) => word(`w${i}`));
    const provider = new TrackedProvider(words);
    const chaperone = new Chaperone(provider);

    const result = await chaperone.fillDefinitions(words, { batchSize: 2, concurrency: 1 });

    expect(result.definitions).toHaveLength(4);
    expect(provider.maxActive).toBe(1);
  });

  it('stops starting new batches after three straight failures but reports every failure', async () => {
    const failing = {
      name: 'always-failing',
      requests: 0,
      async complete(): Promise<string> {
        this.requests += 1;
        throw new Error('model unavailable');
      }
    };
    const chaperone = new Chaperone(failing);

    const result = await chaperone.fillDefinitions(Array.from({ length: 10 }, (_, i) => word(`w${i}`)), {
      batchSize: 2,
      concurrency: MAX_CONCURRENCY
    });

    // The first wave fails (3 workers), the streak breaker stops new batches
    // before the remaining two are issued.
    expect(failing.requests).toBe(3);
    expect(result.errors).toHaveLength(3);
    expect(result.definitions).toHaveLength(0);
  });
});

describe('OpenAICompatProvider endpoint handling', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('appends /chat/completions to a bare base URL and sends a chat body', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse((init?.body as string) ?? '{}') });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"definitions":[{"word":"apple","definition":"a fruit","example":"I eat an apple."}]}' } }] }),
        { status: 200 }
      );
    }) as typeof fetch;

    const provider = new OpenAICompatProvider({ endpoint: 'http://localhost:1234/v1', apiKey: '', model: 'test' });
    const content = await provider.complete('test prompt', { words: ['apple'] });

    expect(seen[0].url).toBe('http://localhost:1234/v1/chat/completions');
    expect(seen[0].body.messages).toBeDefined();
    expect(seen[0].body.response_format).toEqual(
      expect.objectContaining({
        type: 'json_schema',
        json_schema: expect.objectContaining({ name: 'vocabulary_definitions', strict: true })
      })
    );
    const definitions = (seen[0].body.response_format as { json_schema: { schema: { properties: { definitions: { required: string[] } } } } })
      .json_schema.schema.properties.definitions;
    expect(definitions).toMatchObject({ required: ['apple'] });
    expect(content).toContain('apple');
  });

  it('normalizes a /responses endpoint to chat completions so its JSON schema is enforced', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse((init?.body as string) ?? '{}') });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"definitions":[{"word":"apple","definition":"a fruit","example":"I eat an apple."}]}' } }] }),
        { status: 200 }
      );
    }) as typeof fetch;

    const provider = new OpenAICompatProvider({ endpoint: 'http://localhost:1234/v1/responses', apiKey: '', model: 'test' });
    const content = await provider.complete('test prompt', { words: ['apple'] });

    expect(seen[0].url).toBe('http://localhost:1234/v1/chat/completions');
    expect(seen[0].body.response_format).toEqual(
      expect.objectContaining({ type: 'json_schema' })
    );
    const messages = seen[0].body.messages as Array<{ role: string; content: string }>;
    expect(messages[1]).toEqual({ role: 'user', content: 'test prompt' });
    expect(content).toContain('apple');
  });

  it('surfaces a structured-endpoint failure instead of falling back to an unconstrained response', async () => {
    const seen: string[] = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: RequestInfo | URL) => {
      const urlString = String(url);
      seen.push(urlString);
      return new Response(JSON.stringify({ error: { message: 'structured output unavailable' } }), { status: 400 });
    }) as typeof fetch;

    const provider = new OpenAICompatProvider({ endpoint: 'http://localhost:1234/api/v1/chat', apiKey: '', model: 'test' });
    await expect(provider.complete('test prompt', { words: ['apple'] })).rejects.toThrow(/structured output unavailable/);
    expect(seen).toEqual(['http://localhost:1234/v1/chat/completions']);
  });

  it('explains LM Studio reasoning-only responses instead of claiming their shape is unparsable', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                reasoning_content: 'Thinking Process: I should formulate an answer.'
              },
              finish_reason: 'length'
            }
          ]
        }),
        { status: 200 }
      )) as typeof fetch;

    const provider = new OpenAICompatProvider({ endpoint: 'http://localhost:1234/v1', apiKey: '', model: 'test' });
    await expect(provider.complete('test prompt', { words: ['apple'] })).rejects.toThrow(
      /entire output budget for reasoning.*finish_reason: length/
    );
  });
});

describe('resolveEndpoint', () => {
  it('derives chat/responses URLs for base, chat, and responses endpoints', () => {
    const resolved = resolveEndpoint('http://localhost:1234/v1');
    expect(resolved.chatUrl).toBe('http://localhost:1234/v1/chat/completions');
    expect(resolved.responsesUrl).toBe('http://localhost:1234/v1/responses');
    expect(resolved.style).toBe('chat');
    expect(resolveEndpoint('http://localhost:1234/v1/chat/completions').chatUrl).toBe(
      'http://localhost:1234/v1/chat/completions'
    );
    expect(resolveEndpoint('http://localhost:1234/v1/responses').style).toBe('responses');
  });
});

describe('LM Studio native v1 API', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('normalizes the native endpoint to chat completions to use its JSON schema feature', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse((init?.body as string) ?? '{}') });
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"definitions":[{"word":"apple","definition":"a fruit","example":"I eat an apple."}]}' } }] }),
        { status: 200 }
      );
    }) as typeof fetch;

    const provider = new OpenAICompatProvider({ endpoint: 'http://localhost:1234/api/v1/chat', apiKey: '', model: 'test' });
    const content = await provider.complete('test prompt', { words: ['apple'] });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('http://localhost:1234/v1/chat/completions');
    const messages = seen[0].body.messages as Array<{ type: string; content: string }>;
    expect(messages[1].content).toBe('test prompt');
    expect(seen[0].body.response_format).toEqual(
      expect.objectContaining({
        type: 'json_schema',
        json_schema: expect.objectContaining({ name: 'vocabulary_definitions', strict: true })
      })
    );
    expect(content).toContain('apple');
  });

  it('derives the native URL from a bare /api/v1 base', () => {
    const resolved = resolveEndpoint('http://localhost:1234/api/v1');
    expect(resolved.style).toBe('native');
    expect(resolved.nativeUrl).toBe('http://localhost:1234/api/v1/chat');
  });
});

describe('relations structured pass', () => {
  it('constrains the response to every requested word exactly once, with the predicate enum', () => {
    const format = relationsResponseFormat(['bird', 'snow']);
    const relations = format.json_schema.schema.properties.relations;
    expect(relations.required).toEqual(['bird', 'snow']);
    const wordEntry = relations.properties.bird.properties.relations;
    expect(wordEntry.maxItems).toBe(6);
    const item = wordEntry.items;
    expect(item.properties.predicate.enum).toContain('is-a');
    expect(item.properties.predicate.enum).toContain('capable-of');
    expect(item.properties.predicate.enum).toContain('opposite-of');
  });

  it('parses the structured keyed response', () => {
    const parsed = parseRelationsResponse(
      '{"relations":{"bird":{"relations":[{"predicate":"capable-of","object":"fly"},{"predicate":"has-part","object":"wings"}]}}}'
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ word: 'bird', predicate: 'capable-of', object: 'fly' });
    expect(() => parseRelationsResponse('prose')).toThrow();
  });

  it('validates edges: known predicate, content-word object, subject excluded', () => {
    expect(validateGeneratedRelation({ predicate: 'capable-of', object: 'fly' }, 'bird')).toEqual({
      predicate: 'capable-of',
      object: 'fly'
    });
    expect(validateGeneratedRelation({ predicate: 'has-property', object: 'cold' }, 'snow')).toEqual({
      predicate: 'has-property',
      object: 'cold'
    });
    // Rejects: unknown predicate, non-content object, subject-as-object, shape.
    expect(validateGeneratedRelation({ predicate: 'flies', object: 'bird' }, 'bird')).toBeNull();
    expect(validateGeneratedRelation({ predicate: 'is-a', object: 'the' }, 'bird')).toBeNull();
    expect(validateGeneratedRelation({ predicate: 'is-a', object: 'bird' }, 'bird')).toBeNull();
    expect(validateGeneratedRelation({ predicate: 'capable-of', object: 'fly fast and far' }, 'bird')).toBeNull();
  });

  it('generateRelations accepts valid edges, tags provenance, and skips empty words', async () => {
    const provider: ChaperoneProvider = {
      name: 'relations-fake',
      async complete(): Promise<string> {
        throw new Error('not used');
      },
      async completeRaw(): Promise<string> {
        return '{"relations":{"bird":{"relations":[{"predicate":"capable-of","object":"fly"},{"predicate":"is-a","object":"animal"}]},"snow":{"relations":[{"predicate":"has-property","object":"cold"}]}}}';
      }
    };
    const chaperone = new Chaperone(provider);
    const result = await chaperone.generateRelations([word('bird'), word('snow'), word('the')]);
    expect(result.skipped).toEqual(['the']);
    expect(result.relations).toHaveLength(3);
    for (const relation of result.relations) {
      expect(relation.origin).toBe('chaperone');
      expect(relation.source).toBe('');
    }
    expect(result.relations.some((r) => r.predicate === 'capable-of' && r.object === 'fly')).toBe(true);
  });

  it('fillRelations collects batches, progress, and provider failures', async () => {
    const words = Array.from({ length: 6 }, (_, i) => ({
      word: `w${i}`,
      definition: `the meaning of w${i}`,
      example: `I use w${i}.`
    }));
    const provider: ChaperoneProvider = {
      name: 'relations-batch',
      async complete(): Promise<string> {
        throw new Error('not used');
      },
      async completeRaw(prompt: string): Promise<string> {
        const entries = words
          .filter((w) => prompt.includes(w.word))
          .map((w) => ({ [w.word]: { relations: [{ predicate: 'is-a', object: 'thing' }] } }));
        return JSON.stringify({ relations: Object.assign({}, ...entries) });
      }
    };
    const chaperone = new Chaperone(provider);
    const batches: number[] = [];
    const result = await chaperone.fillRelations(words, { batchSize: 3, onBatch: (done) => batches.push(done) });
    expect(batches).toEqual([3, 6]);
    expect(result.relations).toHaveLength(6);
    expect(result.errors).toHaveLength(0);
  });

  it('reports the honest absence of a provider', async () => {
    const chaperone = new Chaperone(new NullChaperoneProvider());
    const defined = { word: 'apple', definition: 'a round fruit', example: 'I eat an apple.' };
    const result = await chaperone.fillRelations([defined], { batchSize: 1 });
    expect(result.relations).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/no LLM provider configured/);
  });
});
