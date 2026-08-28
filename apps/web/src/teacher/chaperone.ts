import type { DeckWord } from './deck';

/**
 * The Chaperone: an LLM that generates and VALIDATES the content the
 * observer learns. The honesty contract applies here harder than anywhere:
 * LLM output is treated as untrusted data — schema-validated, filtered, and
 * labeled — never blended with the observer's measured state.
 */

export interface ChaperoneProvider {
  readonly name: string;
  /** Complete a chat prompt; rejects on transport/API errors. */
  complete(prompt: string, options?: { signal?: AbortSignal }): Promise<string>;
}

export interface ChaperoneSettings {
  endpoint: string;
  apiKey: string;
  model: string;
}

export interface GeneratedEntry {
  word: string;
  definition: string;
  example: string;
}

export interface ChaperoneBatchResult {
  definitions: GeneratedEntry[];
  /** Words in the batch the provider did not produce valid content for. */
  skipped: string[];
}

export interface ChaperoneRunResult {
  definitions: GeneratedEntry[];
  skipped: string[];
  /** Batches that failed outright (reported, never silently dropped). */
  errors: string[];
}

/**
 * The honest absence of an LLM: every operation reports why it cannot run
 * instead of producing placeholder content.
 */
export class NullChaperoneProvider implements ChaperoneProvider {
  readonly name = 'none';

  async complete(): Promise<string> {
    throw new Error('no LLM provider configured — configure an endpoint in the schoolroom');
  }
}

/**
 * An OpenAI-compatible endpoint (any provider exposing POST /chat/completions
 * or the Responses API at /responses). The API key lives in localStorage only
 * and is sent exclusively to the configured endpoint.
 *
 * Endpoint URL handling: a bare base URL (`http://localhost:1234/v1`) gets
 * `/chat/completions` appended; URLs ending in `/chat/completions` or
 * `/responses` are used as-is. When a chat-style request is rejected with
 * the Responses-API signature error ("'input' is required"), the provider
 * retries once against the `/responses` sibling — so both LM Studio API
 * styles work without configuration guesswork.
 */
export class OpenAICompatProvider implements ChaperoneProvider {
  readonly name: string;

  constructor(private readonly settings: ChaperoneSettings) {
    this.name = settings.model || settings.endpoint;
  }

  async complete(prompt: string, options?: { signal?: AbortSignal }): Promise<string> {
    const target = resolveEndpoint(this.settings.endpoint);
    const chat = async (style: 'chat' | 'responses') => {
      const url = style === 'chat' ? target.chatUrl : target.responsesUrl;
      const body =
        style === 'chat'
          ? {
              model: this.settings.model,
              messages: [
                {
                  role: 'system',
                  content:
                    'You write plain-English learner definitions and example sentences. Respond ONLY with a JSON array of objects {"word": string, "definition": string, "example": string}. No prose, no markdown.'
                },
                { role: 'user', content: prompt }
              ],
              temperature: 0.4
            }
          : {
              model: this.settings.model,
              input: [
                {
                  role: 'system',
                  content:
                    'You write plain-English learner definitions and example sentences. Respond ONLY with a JSON array of objects {"word": string, "definition": string, "example": string}. No prose, no markdown.'
                },
                { role: 'user', content: prompt }
              ],
              temperature: 0.4
            };

      return fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.settings.apiKey.length > 0 ? { authorization: `Bearer ${this.settings.apiKey}` } : {})
        },
        body: JSON.stringify(body),
        signal: options?.signal
      });
    };

    let response = await chat(target.style);
    if (!response.ok && target.style === 'chat') {
      // A server that speaks the Responses API rejects a chat body with
      // "'input' is required" — retry once with the responses shape.
      const errorBody = await response.text().catch(() => '');
      if (/input.*required|invalid_union/i.test(errorBody)) {
        response = await chat('responses');
      }
    }

    if (!response.ok) {
      throw new Error(`LLM endpoint returned ${response.status}`);
    }
    const payload = (await response.json()) as
      | { choices?: Array<{ message?: { content?: string } }> }
      | { output?: Array<{ content?: Array<{ text?: string }> }> };
    const content =
      (payload as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ??
      (payload as { output?: Array<{ content?: Array<{ text?: string }> }> }).output?.[0]?.content?.[0]?.text ??
      '';
    if (!content) {
      throw new Error('LLM response contained no content');
    }
    return content;
  }
}

/** Resolve an endpoint setting into chat/responses URLs and the preferred style. */
export function resolveEndpoint(endpoint: string): {
  chatUrl: string;
  responsesUrl: string;
  style: 'chat' | 'responses';
} {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  if (/\/responses$/.test(trimmed)) {
    return { chatUrl: trimmed.replace(/\/responses$/, '/chat/completions'), responsesUrl: trimmed, style: 'responses' };
  }
  if (/\/chat\/completions$/.test(trimmed)) {
    return { chatUrl: trimmed, responsesUrl: trimmed.replace(/\/chat\/completions$/, '/responses'), style: 'chat' };
  }
  return { chatUrl: `${trimmed}/chat/completions`, responsesUrl: `${trimmed}/responses`, style: 'chat' };
}

const DEFINITION_MIN = 5;
const DEFINITION_MAX = 200;
const EXAMPLE_MIN = 5;
const EXAMPLE_MAX = 200;
const BATCH_SIZE = 8;
const BATCH_DELAY_MS = 750;

/** Parse an LLM JSON response, tolerating code fences. */
export function parseDefinitionsResponse(text: string): Array<{ word: string; definition: string; example: string }> {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error('LLM response was not a JSON array');
  }
  return parsed as Array<{ word: string; definition: string; example: string }>;
}

/** Schema-validate one LLM-produced entry against the honest content rules. */
export function validateGeneratedEntry(raw: { word: string; definition: string; example: string }, expected: string): GeneratedEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const word = (raw.word ?? '').trim().toLowerCase();
  const definition = (raw.definition ?? '').trim();
  const example = (raw.example ?? '').trim();

  if (word !== expected.toLowerCase()) return null;
  if (definition.length < DEFINITION_MIN || definition.length > DEFINITION_MAX) return null;
  if (example.length < EXAMPLE_MIN || example.length > EXAMPLE_MAX) return null;
  if (!new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(example.toLowerCase())) {
    return null;
  }
  return { word, definition, example };
}

export class Chaperone {
  constructor(private readonly provider: ChaperoneProvider) {}

  /** The provider backing this chaperone (reported to the UI). */
  getProviderName(): string {
    return this.provider.name;
  }

  /**
   * Generate + validate definitions for a batch of words. Every batch is
   * rate-limited and validated; invalid entries are SKIPPED and reported,
   * never silently accepted.
   */
  async generateBatch(words: readonly DeckWord[]): Promise<ChaperoneBatchResult> {
    const requested = words.map((w) => w.word).join(', ');
    const prompt = `Write a plain-English learner definition (5-200 characters, noun-phrase style) and a short example sentence (5-200 characters, must contain the word) for each of these words: ${requested}.`;

    const response = await this.provider.complete(prompt);
    const parsed = parseDefinitionsResponse(response);

    const definitions: GeneratedEntry[] = [];
    const skipped: string[] = [];
    for (const entry of words) {
      const raw = parsed.find((candidate) => (candidate.word ?? '').trim().toLowerCase() === entry.word.toLowerCase());
      const valid = raw !== undefined ? validateGeneratedEntry(raw, entry.word) : null;
      if (valid !== null) {
        definitions.push(valid);
      } else {
        skipped.push(entry.word);
      }
    }
    return { definitions, skipped };
  }

  /**
   * Run the chaperone over the deck's definition-less words in batches.
   * `onBatch` reports progress; failures per batch are collected, not
   * swallowed. Stop cleanly via an AbortSignal.
   */
  async fillDefinitions(
    words: readonly DeckWord[],
    options: {
      batchSize?: number;
      onBatch?: (done: number, total: number, batch: ChaperoneBatchResult) => void;
      signal?: AbortSignal;
    } = {}
  ): Promise<ChaperoneRunResult> {
    const size = Math.max(1, Math.floor(options.batchSize ?? BATCH_SIZE));
    const target = words.filter((w) => w.definition.trim().length === 0);
    const definitions: GeneratedEntry[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];
    let done = 0;
    let consecutiveFailures = 0;

    for (let i = 0; i < target.length; i += size) {
      if (options.signal?.aborted) break;
      const batch = target.slice(i, i + size);
      try {
        const result = await this.generateBatch(batch);
        definitions.push(...result.definitions);
        skipped.push(...result.skipped);
        consecutiveFailures = 0;
        done += batch.length;
        options.onBatch?.(done, target.length, result);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        done += batch.length;
        consecutiveFailures += 1;
        // A provider that fails three batches in a row is broken or
        // unconfigured — stop instead of hammering every remaining batch.
        if (consecutiveFailures >= 3) break;
      }
      if (i + size < target.length && !options.signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    return { definitions, skipped, errors };
  }
}
