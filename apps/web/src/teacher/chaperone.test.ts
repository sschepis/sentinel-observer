/**
 * @jest-environment node
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import {
  Chaperone,
  NullChaperoneProvider,
  OpenAICompatProvider,
  resolveEndpoint,
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
        JSON.stringify({ choices: [{ message: { content: '[{"word":"apple","definition":"a fruit","example":"I eat an apple."}]' } }] }),
        { status: 200 }
      );
    }) as typeof fetch;

    const provider = new OpenAICompatProvider({ endpoint: 'http://localhost:1234/v1', apiKey: '', model: 'test' });
    const content = await provider.complete('test prompt');

    expect(seen[0].url).toBe('http://localhost:1234/v1/chat/completions');
    expect(seen[0].body.messages).toBeDefined();
    expect(content).toContain('apple');
  });

  it('uses the responses API style for /responses endpoints', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse((init?.body as string) ?? '{}') });
      return new Response(
        JSON.stringify({ output: [{ content: [{ text: '[{"word":"apple","definition":"a fruit","example":"I eat an apple."}]' }] }] }),
        { status: 200 }
      );
    }) as typeof fetch;

    const provider = new OpenAICompatProvider({ endpoint: 'http://localhost:1234/v1/responses', apiKey: '', model: 'test' });
    const content = await provider.complete('test prompt');

    expect(seen[0].url).toBe('http://localhost:1234/v1/responses');
    // /v1/responses takes message objects with PLAIN-STRING content — the
    // shape the live server accepted; part-tagged content is rejected there.
    const input = (seen[0].body as { input?: Array<{ role: string; content: string }> }).input;
    expect(input).toBeDefined();
    expect(input![1]).toEqual({ role: 'user', content: 'test prompt' });
    expect(content).toContain('apple');
  });

  it('retries once with the responses shape when a chat request is rejected with the input-required signature', async () => {
    const seen: string[] = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: RequestInfo | URL) => {
      const urlString = String(url);
      seen.push(urlString);
      if (seen.length === 1) {
        // The native endpoint rejects the first attempt — force the fallback.
        return new Response(JSON.stringify({ error: { message: 'Invalid discriminator value', param: 'input' } }), { status: 400 });
      }
      return new Response(
        JSON.stringify({ output: [{ content: [{ text: '[{"word":"apple","definition":"a fruit","example":"I eat an apple."}]' }] }] }),
        { status: 200 }
      );
    }) as typeof fetch;

    const provider = new OpenAICompatProvider({ endpoint: 'http://localhost:1234/api/v1/chat', apiKey: '', model: 'test' });
    const content = await provider.complete('test prompt');

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe('http://localhost:1234/api/v1/chat');
    expect(seen[1]).toBe('http://localhost:1234/v1/responses');
    expect(content).toContain('apple');
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

  it('posts the INPUT-shaped body to /api/v1/chat for the native endpoint', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse((init?.body as string) ?? '{}') });
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: '[{"word":"apple","definition":"a fruit","example":"I eat an apple."}]' } }] }),
        { status: 200 }
      );
    }) as typeof fetch;

    const provider = new OpenAICompatProvider({ endpoint: 'http://localhost:1234/api/v1/chat', apiKey: '', model: 'test' });
    const content = await provider.complete('test prompt');

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('http://localhost:1234/api/v1/chat');
    // The native endpoint takes a FLAT array of discriminated parts — the
    // exact shape the live server's 'text' | 'image' union validator accepts.
    const input = seen[0].body.input as Array<{ type: string; text: string }>;
    expect(input).toHaveLength(1);
    expect(input[0].type).toBe('text');
    expect(input[0].text).toContain('test prompt');
    // No message objects, no roles — the native API rejects them.
    expect(JSON.stringify(seen[0].body)).not.toContain('"role"');
    expect(content).toContain('apple');
  });

  it('derives the native URL from a bare /api/v1 base', () => {
    const resolved = resolveEndpoint('http://localhost:1234/api/v1');
    expect(resolved.style).toBe('native');
    expect(resolved.nativeUrl).toBe('http://localhost:1234/api/v1/chat');
  });
});
