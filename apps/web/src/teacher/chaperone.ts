import type { DeckWord } from './deck';
import { RELATION_PREDICATES, type Relation, type RelationPredicate } from './relations';
import { isContentWord } from './context';

/**
 * The Chaperone: an LLM that generates and VALIDATES the content the
 * observer learns. The honesty contract applies here harder than anywhere:
 * LLM output is treated as untrusted data — schema-validated, filtered, and
 * labeled — never blended with the observer's measured state.
 */

export interface ChaperoneProvider {
  readonly name: string;
  /** Complete a chat prompt; rejects on transport/API errors. */
  complete(prompt: string, options?: { signal?: AbortSignal; words?: readonly string[] }): Promise<string>;
  /**
   * Optional: complete with an arbitrary response-format schema. Providers
   * that support it can serve the semantic grader and creative answers;
   * providers without it are reported as "no grading model" rather than
   * faked. Returns a raw content string.
   */
  completeRaw?(prompt: string, options?: { signal?: AbortSignal; responseFormat?: unknown; systemPrompt?: string; temperature?: number; maxTokens?: number }): Promise<string>;
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

/** Structured edges for one batch: validated, deduped, provenance-tagged. */
export interface ChaperoneRelationsBatchResult {
  relations: Relation[];
  /** Words the provider produced zero valid edges for. */
  skipped: string[];
}

/** The full relations run: accepted edges plus what was skipped/failed. */
export interface ChaperoneRelationsRunResult {
  relations: Relation[];
  skipped: string[];
  errors: string[];
}

/** A proposed conversational exchange (cue + expected response). */
export interface ConversationPairResult {
  cue: string;
  response: string;
}

/** LLM-generated conversation curriculum plus what was rejected. */
export interface ConversationPairRun {
  pairs: ConversationPairResult[];
  /** Cues the model proposed that failed validation (dedup or shape). */
  rejected: string[];
  error: string | null;
}

interface PairsResponse {
  pairs?: ConversationPairResult[] | null;
}

/**
 * Structured-output schema for generated conversation phrase pairs: a cue
 * (what a human says) and a plain-English learner response. Inverse of the
 * definitions schema, validated the same way.
 */
export function conversationPairsResponseFormat() {
  return {
    type: 'json_schema' as const,
    json_schema: {
      name: 'conversation_pairs',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pairs: {
            type: 'array',
            maxItems: 15,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                cue: { type: 'string', minLength: 2, maxLength: 120 },
                response: { type: 'string', minLength: 5, maxLength: 200 }
              },
              required: ['cue', 'response']
            }
          }
        },
        required: ['pairs']
      }
    }
  };
}

const CUE_RE = /^[a-z][a-z0-9 ,'?!.-]*$/;
const RESPONSE_RE = /[a-z]{2,}/;

/**
 * Validate + sanitize one proposed pair:
 *  - cue is lower-case printable English, 2-120 chars, not a duplicate
 *  - response is 5-200 chars with at least one real word, not identical to the cue
 */
export function validateConversationPair(
  pair: ConversationPairResult,
  existingCues: ReadonlySet<string>
): ConversationPairResult | null {
  const rawCue = pair.cue.trim();
  const cue = rawCue.toLowerCase();
  const response = pair.response.trim();
  if (cue.length < 2 || cue.length > 120) return null;
  // The cue must ALREADY be lowercase English — the model is told to emit
  // lowercase cues, and normalized case here would smuggle bad shape in.
  if (rawCue !== cue) return null;
  if (!CUE_RE.test(cue)) return null;
  if (response.length < 5 || response.length > 200) return null;
  if (!RESPONSE_RE.test(response.toLowerCase())) return null;
  if (response.toLowerCase() === cue) return null;
  if (existingCues.has(cue)) return null;
  return { cue, response };
}

/**
 * Tolerantly parse a conversation-pairs payload. The model may wrap JSON in
 * prose or code fences; the parser finds the pairs array and validates each
 * entry. Duplicates or malformed entries are dropped (reported via
 * `rejected`), never accepted.
 */
export function parseConversationPairs(content: string): { pairs: ConversationPairResult[]; rejected: string[] } {
  const pairs: ConversationPairResult[] = [];
  const rejected: string[] = [];
  if (typeof content !== 'string' || content.trim().length === 0) return { pairs, rejected };
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  const object = text.match(/\{\s*"pairs"\s*:\s*\[([\s\S]*?)\]\s*\}/);
  if (!object) return { pairs, rejected };
  // Each entry may be separated by commas and arbitrary whitespace/newlines.
  const rawEntries = object[1].match(/\{\s*"cue"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"response"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g);
  if (!rawEntries) return { pairs, rejected };
  const existing = new Set<string>();
  for (const raw of rawEntries) {
    const match = raw.match(/\{\s*"cue"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"response"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/);
    if (!match) continue;
    const cue = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const response = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const valid = validateConversationPair({ cue, response }, existing);
    if (valid !== null) {
      existing.add(valid.cue);
      pairs.push(valid);
    } else {
      rejected.push(cue);
    }
  }
  return { pairs, rejected };
}

interface DefinitionsResponse {
  definitions: GeneratedEntry[] | Record<string, Omit<GeneratedEntry, 'word'>>;
}

/**
 * LM Studio's documented structured-output contract for
 * `/v1/chat/completions`. Keeping this beside the parser makes the requested
 * response shape explicit at both the transport and validation boundaries.
 */
export function definitionsResponseFormat(words: readonly string[]) {
  const expectedWords = [...new Set(words.map((word) => word.trim().toLowerCase()).filter(Boolean))];

  return {
    type: 'json_schema' as const,
    json_schema: {
      name: 'vocabulary_definitions',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          definitions: {
            // A keyed object is stronger than an array + enum: it requires
            // every requested word exactly once, so the model cannot replace
            // "its" with "i", omit the remaining words, or duplicate one.
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(
              expectedWords.map((word) => [
                word,
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    definition: { type: 'string', minLength: DEFINITION_MIN, maxLength: DEFINITION_MAX },
                    example: { type: 'string', minLength: EXAMPLE_MIN, maxLength: EXAMPLE_MAX }
                  },
                  required: ['definition', 'example']
                }
              ])
            ),
            required: expectedWords
          }
        },
        required: ['definitions']
      }
    }
  };
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

  async completeRaw(): Promise<string> {
    throw new Error('no LLM provider configured — configure an endpoint in the schoolroom');
  }
}

/**
 * An OpenAI-compatible endpoint. The API key lives in localStorage only and
 * is sent exclusively to the configured endpoint.
 *
 * Endpoint URL handling: a bare base URL (`http://localhost:1234/v1`) gets
 * `/chat/completions` appended; URLs ending in `/chat/completions`,
 * `/responses`, or `/api/v1/chat` are normalized to that endpoint. LM Studio
 * documents JSON-schema structured output for `/v1/chat/completions`; using
 * that endpoint is therefore required here instead of silently falling back
 * to an endpoint that cannot enforce the content contract.
 */
export class OpenAICompatProvider implements ChaperoneProvider {
  readonly name: string;

  constructor(private readonly settings: ChaperoneSettings) {
    this.name = settings.model || settings.endpoint;
  }

  async complete(prompt: string, options?: { signal?: AbortSignal; words?: readonly string[] }): Promise<string> {
    const SYSTEM_PROMPT =
      'You write plain-English learner definitions and example sentences. Every field must contain complete, meaningful English. Never use ellipses, placeholders, abbreviations, or filler text. Return every requested word exactly once. The response must contain no prose or markdown outside the JSON object.';

    return this.completeRaw(prompt, {
      signal: options?.signal,
      responseFormat: definitionsResponseFormat(options?.words ?? []),
      systemPrompt: SYSTEM_PROMPT,
      temperature: 0.4,
      maxTokens: 2048
    });
  }

  async completeRaw(prompt: string, options: { signal?: AbortSignal; responseFormat?: unknown; systemPrompt?: string; temperature?: number; maxTokens?: number } = {}): Promise<string> {
    const target = resolveEndpoint(this.settings.endpoint);

    // A stalled connection must not leave the chat pending forever or block
    // the autonomous classroom: the caller's abort signal is chained with a
    // hard timeout so the fetch settles one way or the other.
    const signal =
      options.signal !== undefined
        ? AbortSignal.any([options.signal, AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS);

    const response = await fetch(target.chatUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.settings.apiKey.length > 0 ? { authorization: `Bearer ${this.settings.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: this.settings.model,
        messages: [
          { role: 'system', content: options.systemPrompt ?? '' },
          { role: 'user', content: prompt }
        ],
        ...(options.responseFormat !== undefined ? { response_format: options.responseFormat } : {}),
        temperature: options.temperature ?? 0.4,
        // A bounded generation prevents an incomplete JSON document from a
        // constrained decoder from keeping the UI in a running state forever.
        max_tokens: options.maxTokens ?? 2048,
        stream: false
      }),
      signal
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LLM endpoint returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const payload = (await response.json()) as ChatCompletionPayload;
    const choice = payload.choices?.[0];
    const content = contentText(choice?.message?.content);
    if (!content) {
      if (choice?.finish_reason === 'length' && choice.message?.reasoning_content) {
        throw new Error(
          'LM Studio used the entire output budget for reasoning and returned no final answer (finish_reason: length). Choose a model that supports reasoning off, or increase its reasoning/output budget.'
        );
      }
      throw new Error('LLM response contained no content');
    }
    return content;
  }
}

/**
 * Structured-output schema for the SEMANTIC GRADE of an observer answer:
 * a quality score in [0, 1] plus one short sentence of feedback. This is the
 * Phase-2 grader: once the observer's memorized recall is competent, novel
 * answers are evaluated semantically instead of by identity.
 */
export function gradeResponseFormat() {
  return {
    type: 'json_schema' as const,
    json_schema: {
      name: 'answer_grade',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          score: {
            type: 'number',
            description: 'Semantic quality of the answer to the utterance, 0 (unrelated) to 1 (perfect).'
          },
          feedback: {
            type: 'string',
            minLength: 2,
            maxLength: 300,
            description: 'One short plain-English sentence explaining the score.'
          }
        },
        required: ['score', 'feedback']
      }
    }
  };
}

/** A semantic score plus a human-readable explanation. */
export interface GradeOutcome {
  score: number;
  feedback: string;
}

/**
 * Tolerantly parse a semantic-grade payload. The model may wrap JSON in
 * prose or code fences; the parser finds the grade object and validates it.
 * Returns null when the content does not contain a usable grade — the
 * UI reports "grade unavailable" rather than inventing one.
 */
export function parseGradeOutcome(content: string): GradeOutcome | null {
  if (typeof content !== 'string' || content.trim().length === 0) return null;
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  const object = text.match(/\{\s*"score"\s*:\s*([0-9.]+)\s*,\s*"feedback"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/);
  if (!object) return null;

  const score = Number(object[1]);
  const feedback = object[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
  if (!Number.isFinite(score) || score < 0 || score > 1) return null;
  if (feedback.length < 2 || feedback.length > 300) return null;
  return { score, feedback };
}

/**
 * The semantic grader: an LLM evaluates the observer's answer against the
 * utterance and returns a [0, 1] quality score plus feedback. Built on the
 * same OpenAI-compatible provider as the Chaperone.
 */
export interface SemanticGrader {
  readonly name: string;
  grade(utterance: string, answer: string, options?: { signal?: AbortSignal }): Promise<GradeOutcome | null>;
}

const GRADE_SYSTEM_PROMPT =
  'You are a fair English teacher grading a learner. Grade ONLY how well the answer responds to the utterance: ' +
  'whether it is a plausible, sensible, grammatically complete English reply. Score 1 for a perfect answer, 0 for ' +
  'unrelated or nonsensical text. Be honest — never inflate. Respond ONLY with the JSON object.';

/**
 * Wrap a provider as a semantic grader. Returns null for providers that
 * cannot carry an arbitrary response schema (never fakes a grade).
 */
export function semanticGrader(provider: ChaperoneProvider): SemanticGrader | null {
  if (typeof provider.completeRaw !== 'function') return null;
  return {
    name: provider.name,
    async grade(utterance, answer, options) {
      const raw = await provider.completeRaw!(
        `Utterance: "${utterance}"\nLearner's answer: "${answer}"\nGrade the answer's semantic quality as JSON:{"score": 0..1, "feedback": "..."}.`,
        {
          signal: options?.signal,
          responseFormat: gradeResponseFormat(),
          systemPrompt: GRADE_SYSTEM_PROMPT,
          temperature: 0.2,
          maxTokens: 512
        }
      );
      return parseGradeOutcome(raw);
    }
  };
}

/** The actual LM Studio OpenAI-compatible chat-completions envelope. */
interface ChatCompletionPayload {
  choices?: Array<{
    message?: {
      content?: unknown;
      reasoning_content?: string;
    };
    finish_reason?: string | null;
  }>;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const part of content) {
    if (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string') {
      return part.text;
    }
  }
  return '';
}

/** Resolve an endpoint setting into chat/native/responses URLs and the preferred style. */
export function resolveEndpoint(endpoint: string): {
  chatUrl: string;
  nativeUrl: string;
  responsesUrl: string;
  style: 'chat' | 'native' | 'responses';
} {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  // LM Studio native v1 API: /api/v1/chat
  if (/\/api\/v1\/chat$/.test(trimmed)) {
    return {
      chatUrl: trimmed.replace(/\/api\/v1\/chat$/, '/v1/chat/completions'),
      nativeUrl: trimmed,
      responsesUrl: trimmed.replace(/\/api\/v1\/chat$/, '/v1/responses'),
      style: 'native'
    };
  }
  if (/\/api\/v1$/.test(trimmed)) {
    return {
      chatUrl: `${trimmed.replace(/\/api\/v1$/, '/v1')}/chat/completions`,
      nativeUrl: `${trimmed}/chat`,
      responsesUrl: `${trimmed.replace(/\/api\/v1$/, '/v1')}/responses`,
      style: 'native'
    };
  }
  if (/\/responses$/.test(trimmed)) {
    return {
      chatUrl: trimmed.replace(/\/responses$/, '/chat/completions'),
      nativeUrl: trimmed.replace(/\/responses$/, '/api/v1/chat'),
      responsesUrl: trimmed,
      style: 'responses'
    };
  }
  if (/\/chat\/completions$/.test(trimmed)) {
    return {
      chatUrl: trimmed,
      nativeUrl: trimmed.replace(/\/v1\/chat\/completions$/, '/api/v1/chat'),
      responsesUrl: trimmed.replace(/\/chat\/completions$/, '/responses'),
      style: 'chat'
    };
  }
  return {
    chatUrl: `${trimmed}/chat/completions`,
    nativeUrl: `${trimmed}/api/v1/chat`,
    responsesUrl: `${trimmed}/responses`,
    style: 'chat'
  };
}

const DEFINITION_MIN = 5;
const DEFINITION_MAX = 200;
const EXAMPLE_MIN = 5;
const EXAMPLE_MAX = 200;
const BATCH_SIZE = 8;
/** Hard ceiling on one LLM request — a stalled connection must never leave
 *  the chat pending forever or block the autonomous classroom. */
export const LLM_REQUEST_TIMEOUT_MS = 60_000;
/** Cap on simultaneous LLM requests — the local server queues beyond this. */
export const MAX_CONCURRENCY = 3;
/** Pacing between a worker's successive batches (per worker, not global). */
const BATCH_DELAY_MS = 750;

/** Parse the JSON-schema response, tolerating legacy array responses. */
export function parseDefinitionsResponse(text: string): Array<{ word: string; definition: string; example: string }> {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const parsed: unknown = JSON.parse(cleaned);
  if (Array.isArray(parsed)) {
    return parsed as GeneratedEntry[];
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('LLM response did not match the definitions schema');
  }
  const definitions = (parsed as DefinitionsResponse).definitions;
  if (Array.isArray(definitions)) return definitions;
  if (typeof definitions !== 'object' || definitions === null) {
    throw new Error('LLM response did not match the definitions schema');
  }
  return Object.entries(definitions).map(([word, entry]) => ({
    word,
    definition: typeof entry?.definition === 'string' ? entry.definition : '',
    example: typeof entry?.example === 'string' ? entry.example : ''
  }));
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

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURED RELATIONS (the second pass: typed edges alongside definitions)
// ═══════════════════════════════════════════════════════════════════════════

/** Max edges the model may propose for one word. */
export const RELATIONS_PER_WORD_MAX = 6;
const RELATION_OBJECT_MIN = 1;
const RELATION_OBJECT_MAX = 40;

interface RelationsResponse {
  relations?: Record<string, Array<{ predicate?: string; object?: string }> | null> | null;
}

/**
 * Structured-output schema for generated typed edges: keyed by word, each
 * entry an array of {predicate (enum), object} pairs. Mirrors the definitions
 * schema — every requested word exactly once, nothing else accepted.
 */
export function relationsResponseFormat(words: readonly string[]) {
  const expectedWords = [...new Set(words.map((word) => word.trim().toLowerCase()).filter(Boolean))];

  return {
    type: 'json_schema' as const,
    json_schema: {
      name: 'word_relations',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          relations: {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(
              expectedWords.map((word) => [
                word,
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    relations: {
                      type: 'array',
                      maxItems: RELATIONS_PER_WORD_MAX,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          predicate: { type: 'string', enum: [...RELATION_PREDICATES] },
                          object: { type: 'string', minLength: RELATION_OBJECT_MIN, maxLength: RELATION_OBJECT_MAX }
                        },
                        required: ['predicate', 'object']
                      }
                    }
                  },
                  required: ['relations']
                }
              ])
            ),
            required: expectedWords
          }
        },
        required: ['relations']
      }
    }
  };
}

/** Parse the relations JSON-schema response into flat (word, predicate, object) rows. */
export function parseRelationsResponse(text: string): Array<{ word: string; predicate: string; object: string }> {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const parsed: unknown = JSON.parse(cleaned);
  if (Array.isArray(parsed)) {
    return parsed as Array<{ word: string; predicate: string; object: string }>;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('LLM response did not match the relations schema');
  }
  const relations = (parsed as RelationsResponse).relations;
  if (typeof relations !== 'object' || relations === null) {
    throw new Error('LLM response did not match the relations schema');
  }
  const out: Array<{ word: string; predicate: string; object: string }> = [];
  for (const [word, value] of Object.entries(relations)) {
    // Each word's value is { relations: [...] } — the schema's keyed shape.
    const list = (value as { relations?: Array<{ predicate?: string; object?: string }> } | null)?.relations;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      out.push({
        word,
        predicate: typeof entry?.predicate === 'string' ? entry.predicate : '',
        object: typeof entry?.object === 'string' ? entry.object : ''
      });
    }
  }
  return out;
}

/**
 * Validate one proposed edge: a known predicate, a 1-2 token content-word
 * object that is not the subject. Anything else is SKIPPED, never accepted.
 */
export function validateGeneratedRelation(
  raw: { predicate?: string; object?: string },
  subject: string
): { predicate: RelationPredicate; object: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const predicate = (raw.predicate ?? '').trim().toLowerCase() as RelationPredicate;
  const object = (raw.object ?? '').trim().toLowerCase();
  if (!RELATION_PREDICATES.includes(predicate)) return null;
  if (object.length < RELATION_OBJECT_MIN || object.length > RELATION_OBJECT_MAX) return null;
  if (!/^[a-z]+(?:\s+[a-z]+)?$/.test(object)) return null;
  const tokens = object.split(' ');
  if (!tokens.every((token) => isContentWord(token))) return null;
  if (object === subject) return null;
  return { predicate, object };
}

export class Chaperone {
  constructor(private readonly provider: ChaperoneProvider) {}

  /**
   * Generate + validate a batch of NEW conversational phrase pairs for the
   * observer's current level. The model is given the pairs already taught
   * (so it avoids duplicates) and a competency description (so it targets
   * what the observer still needs — greetings, small talk, questions,
   * requests, feelings, etc.). Providers without structured output return
   * an error result, never a fabrication.
   */
  async generateConversationPairs(options: {
    count: number;
    existingCues: readonly string[];
    level: string;
    signal?: AbortSignal;
  }): Promise<ConversationPairRun> {
    if (typeof this.provider.completeRaw !== 'function') {
      return { pairs: [], rejected: [], error: 'provider does not support structured output' };
    }
    const want = Math.max(1, Math.min(12, Math.floor(options.count)));
    const forbidden =
      options.existingCues.length > 0
        ? `Never reuse these cues (already taught):\n${options.existingCues.slice(-40).join('; ')}`
        : '';
    const systemPrompt =
      'You design a conversation curriculum for a learner who memorizes entire exchanges and answers from memory. ' +
      'Propose common, natural English exchanges a real conversation needs. Every CUE must be a lowercase, plain ' +
      'English thing a human might actually say. Every RESPONSE must be a short, natural, complete English sentence ' +
      'the learner would memorize and repeat (5-15 words). Vary the topics across basic everyday needs. ' +
      'Respond ONLY with the JSON object.';
    const prompt = `The learner's current level: ${options.level}\n${forbidden}\n\nPropose ${want} NEW exchanges as {"cue": "...", "response": "..."}.`;

    try {
      const raw = await this.provider.completeRaw(prompt, {
        signal: options.signal,
        responseFormat: conversationPairsResponseFormat(),
        systemPrompt,
        temperature: 0.8,
        maxTokens: 1024
      });
      const { pairs, rejected } = parseConversationPairs(raw);
      // The parser dedups within itself; the CURRICULUM dedup (against cues
      // already taught) is the caller's set — apply it here so a proposed
      // pair that repeats an existing cue is rejected, not taught again.
      const forbiddenCues = new Set(options.existingCues.map((cue) => cue.toLowerCase()));
      const accepted: ConversationPairResult[] = [];
      const reRejected: string[] = [];
      for (const pair of pairs) {
        if (forbiddenCues.has(pair.cue)) reRejected.push(pair.cue);
        else accepted.push(pair);
      }
      return {
        pairs: accepted,
        rejected: [...rejected, ...reRejected],
        error: null
      };
    } catch (error) {
      const aborted = options.signal?.aborted === true;
      return {
        pairs: [],
        rejected: [],
        error: aborted ? 'aborted' : error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * The HYBRID voice: draft ONE short answer conditioned on the observer's
   * OWN recalled memories — the LLM speaks with the observer's memories,
   * not as a blank model. Used only after the observer's own layers fail.
   */
  async generateHybridAnswer(
    utterance: string,
    memories: readonly string[],
    options: { signal?: AbortSignal; rememberedFacts?: readonly string[] } = {}
  ): Promise<string | null> {
    if (typeof this.provider.completeRaw !== 'function') return null;
    const context = memories.length > 0 ? `\nThe learner remembers these phrases:\n${memories.map((m) => `- ${m}`).join('\n')}` : '';
    // EPISODIC FACTS: the learner's selective long-term memory about the
    // human. Tagged as remembered so the draft may reference them, but the
    // instruction forbids inventing new facts — the prompt is honest about
    // what the observer actually knows.
    const facts =
      options.rememberedFacts !== undefined && options.rememberedFacts.length > 0
        ? `\nThe learner remembers these facts about the human:\n${options.rememberedFacts.map((f) => `- ${f}`).join('\n')}`
        : '';
    const systemPrompt =
      'You are the voice of a learner who only remembers the phrases listed below. ' +
      'Answer the utterance with EXACTLY ONE short, natural English sentence built only from the remembered ' +
      'words and patterns — never copy a remembered phrase verbatim, never use words the learner does not know. ' +
      'You may mention a remembered fact about the human only when the utterance relates to it; never invent facts. ' +
      'Output only the sentence.';
    try {
      // The system prompt is sent once via the `system` role; the user
      // message carries only the memory context and the utterance.
      const raw = await this.provider.completeRaw(
        `${context}${facts}\nThe learner was asked: "${utterance}"\nThe learner says:`,
        { signal: options.signal, systemPrompt, temperature: 0.6, maxTokens: 128 }
      );
      const sentence = raw.trim().replace(/^["']|["']$/g, '');
      return sentence.length > 0 ? sentence : null;
    } catch {
      // Transport/API failure → no draft (the caller treats null as "the
      // hybrid voice is unavailable"; abort and failure are equivalent here).
      return null;
    }
  }

  /**
   * Teach the observer how to answer utterances it FAILED to answer (gaps).
   * The model writes a natural, memorizable response for each gap cue. This
   * is the self-teaching loop: the observer learns from the conversations it
   * actually had.
   */
  async answerGaps(options: {
    gaps: readonly string[];
    existingCues: readonly string[];
    signal?: AbortSignal;
  }): Promise<ConversationPairRun> {
    if (typeof this.provider.completeRaw !== 'function') {
      return { pairs: [], rejected: [], error: 'provider does not support structured output' };
    }
    const gaps = options.gaps.slice(0, 8).map((gap) => gap.trim()).filter((gap) => gap.length > 0);
    if (gaps.length === 0) return { pairs: [], rejected: [], error: null };
    const forbidden =
      options.existingCues.length > 0
        ? `Never reuse these cues (already taught):\n${options.existingCues.slice(-40).join('; ')}`
        : '';
    const systemPrompt =
      'You teach a learner who memorizes entire exchanges and answers from memory. ' +
      'For each utterance below — things a real person recently said to the learner — write the natural, ' +
      'short, complete English response a learner should memorize and repeat (5-15 words). ' +
      'The response must be a plausible, friendly, everyday reply. Respond ONLY with the JSON object.';
    const prompt = `The learner could not answer these utterances:\n${gaps.map((gap) => `- "${gap}"`).join('\n')}\n${forbidden}\n\nFor each utterance, propose the learner's response as {"cue": "<the utterance>", "response": "<the reply>"}.`;

    try {
      const raw = await this.provider.completeRaw(prompt, {
        signal: options.signal,
        responseFormat: conversationPairsResponseFormat(),
        systemPrompt,
        temperature: 0.6,
        maxTokens: 1024
      });
      const { pairs, rejected } = parseConversationPairs(raw);
      const forbiddenSet = new Set(options.existingCues.map((cue) => cue.toLowerCase()));
      const accepted: ConversationPairResult[] = [];
      const reRejected: string[] = [];
      for (const pair of pairs) {
        if (forbiddenSet.has(pair.cue)) reRejected.push(pair.cue);
        else accepted.push(pair);
      }
      return { pairs: accepted, rejected: [...rejected, ...reRejected], error: null };
    } catch (error) {
      const aborted = options.signal?.aborted === true;
      return {
        pairs: [],
        rejected: [],
        error: aborted ? 'aborted' : error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Generate + validate definitions for a batch of words. Every batch is
   * rate-limited and validated; invalid entries are SKIPPED and reported,
   * never silently accepted.
   */
  async generateBatch(
    words: readonly DeckWord[],
    options: { signal?: AbortSignal } = {}
  ): Promise<ChaperoneBatchResult> {
    const requested = words.map((w) => w.word).join(', ');
    const prompt = `Write a plain-English learner definition (5-200 characters, noun-phrase style) and a short example sentence (5-200 characters, must contain the word) for each of these words: ${requested}. Return exactly ${words.length} entries, one for every requested word; preserve each word's spelling exactly.`;

    const response = await this.provider.complete(prompt, {
      signal: options.signal,
      words: words.map((word) => word.word)
    });
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
   * The RELATIONS second pass: generate + validate typed edges for words
   * whose definitions were already accepted. The model sees the accepted
   * definition text (the source field of every edge), so the edges are
   * about the exact content the observer will store.
   */
  async generateRelations(
    words: readonly DeckWord[],
    options: { signal?: AbortSignal } = {}
  ): Promise<ChaperoneRelationsBatchResult> {
    if (typeof this.provider.completeRaw !== 'function') {
      throw new Error('provider does not support structured output');
    }
    const requested = words.map((w) => w.word).join(', ');
    const prompt =
      `For each word below, state up to ${RELATIONS_PER_WORD_MAX} true, plain-English facts about it — what it IS a kind of, ` +
      `what it HAS as a part or property, what it can DO, what it is USED FOR, what it CAUSES, what it REQUIRES, what it ` +
      `is the OPPOSITE of, and where it is LOCATED. The OBJECT must be the plain word or a short two-word phrase (lowercase). ` +
      `Return exactly ${words.length} entries, one per requested word. Respond ONLY with the JSON object.\nWords: ${requested}.`;

    const raw = await this.provider.completeRaw(prompt, {
      signal: options.signal,
      responseFormat: relationsResponseFormat(words.map((word) => word.word)),
      systemPrompt:
        'You extract true, learner-appropriate facts as typed edges. Every predicate must come from the allowed set; every ' +
        'object must be a concrete plain-English word or short phrase, never a full sentence. Prefer the most salient, ' +
        'checkable facts. The response must contain no prose or markdown outside the JSON object.',
      temperature: 0.4,
      maxTokens: 2048
    });
    const parsed = parseRelationsResponse(raw);

    const relations: Relation[] = [];
    const skipped: string[] = [];
    for (const entry of words) {
      const candidates = parsed.filter(
        (candidate) => (candidate.word ?? '').trim().toLowerCase() === entry.word.toLowerCase()
      );
      const accepted: Array<{ predicate: RelationPredicate; object: string }> = [];
      const seen = new Set<string>();
      for (const candidate of candidates) {
        const valid = validateGeneratedRelation(candidate, entry.word);
        if (valid !== null && !seen.has(`${valid.predicate}\u0000${valid.object}`)) {
          seen.add(`${valid.predicate}\u0000${valid.object}`);
          accepted.push(valid);
        }
      }
      if (accepted.length > 0) {
        for (const edge of accepted) {
          relations.push({
            subject: entry.word,
            predicate: edge.predicate,
            object: edge.object,
            source: entry.definition,
            origin: 'chaperone'
          });
        }
      } else {
        skipped.push(entry.word);
      }
    }
    return { relations, skipped };
  }

  /**
   * Run the relations pass over the deck in batches, mirroring
   * `fillDefinitions`'s worker pool, pacing, and abort handling.
   */
  async fillRelations(
    words: readonly DeckWord[],
    options: {
      batchSize?: number;
      concurrency?: number;
      onBatch?: (done: number, total: number, batch: ChaperoneRelationsBatchResult) => void;
      onBatchError?: (done: number, total: number, words: string[], error: string) => void;
      onBatchStart?: (words: string[]) => void;
      signal?: AbortSignal;
    } = {}
  ): Promise<ChaperoneRelationsRunResult> {
    const size = Math.max(1, Math.floor(options.batchSize ?? BATCH_SIZE));
    const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(options.concurrency ?? MAX_CONCURRENCY)));
    const target = words.filter((w) => w.definition.trim().length > 0);
    const relations: Relation[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];
    let done = 0;
    let consecutiveFailures = 0;
    let stopped = false;
    let nextBatchIndex = 0;

    const processBatch = async (index: number): Promise<void> => {
      const batch = target.slice(index * size, (index + 1) * size);
      if (batch.length === 0) return;
      options.onBatchStart?.(batch.map((w) => w.word));
      try {
        const result = await this.generateRelations(batch, { signal: options.signal });
        relations.push(...result.relations);
        skipped.push(...result.skipped);
        consecutiveFailures = 0;
        done += batch.length;
        options.onBatch?.(done, target.length, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        done += batch.length;
        options.onBatchError?.(done, target.length, batch.map((w) => w.word), message);
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) stopped = true;
      }
    };

    const worker = async (): Promise<void> => {
      while (!stopped && !options.signal?.aborted) {
        const index = nextBatchIndex++;
        if (index * size >= target.length) return;
        await processBatch(index);
        if (stopped || options.signal?.aborted) return;
        if ((index + 1) * size < target.length) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
        }
      }
    };

    const workerCount = Math.min(concurrency, Math.ceil(target.length / size));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return { relations, skipped, errors };
  }

  /**
   * Run the chaperone over the deck's definition-less words in batches.
   *
   * Batches run over a small worker pool (up to `concurrency` simultaneous
   * LLM requests, capped at MAX_CONCURRENCY); each worker paces its own
   * successive batches. `onBatch` reports progress; `onBatchStart` fires
   * BEFORE the model is asked (so the UI shows activity during generation,
   * not only after). Failures per batch are collected, not swallowed. Stop
   * cleanly via an AbortSignal.
   */
  async fillDefinitions(
    words: readonly DeckWord[],
    options: {
      batchSize?: number;
      concurrency?: number;
      onBatch?: (done: number, total: number, batch: ChaperoneBatchResult) => void;
      onBatchError?: (done: number, total: number, words: string[], error: string) => void;
      onBatchStart?: (words: string[]) => void;
      signal?: AbortSignal;
    } = {}
  ): Promise<ChaperoneRunResult> {
    const size = Math.max(1, Math.floor(options.batchSize ?? BATCH_SIZE));
    const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(options.concurrency ?? MAX_CONCURRENCY)));
    const target = words.filter((w) => w.definition.trim().length === 0);
    const definitions: GeneratedEntry[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];
    let done = 0;
    let consecutiveFailures = 0;
    let stopped = false;
    let nextBatchIndex = 0;

    const processBatch = async (index: number): Promise<void> => {
      const batch = target.slice(index * size, (index + 1) * size);
      if (batch.length === 0) return;
      options.onBatchStart?.(batch.map((w) => w.word));
      try {
        const result = await this.generateBatch(batch, { signal: options.signal });
        const recovered: GeneratedEntry[] = [...result.definitions];
        const unresolved: string[] = [];

        // Some otherwise capable local models become terse or emit filler
        // when asked for many structured examples at once. Re-asking only
        // the rejected words one at a time uses a smaller exact-key schema
        // (which we verified against LM Studio) without accepting bad data.
        for (const word of batch) {
          if (!result.skipped.includes(word.word)) continue;
          if (options.signal?.aborted) {
            unresolved.push(word.word);
            continue;
          }
          options.onBatchStart?.([word.word]);
          try {
            const retry = await this.generateBatch([word], { signal: options.signal });
            recovered.push(...retry.definitions);
            unresolved.push(...retry.skipped);
          } catch (error) {
            unresolved.push(word.word);
            errors.push(`retry for ${word.word}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        definitions.push(...recovered);
        skipped.push(...unresolved);
        consecutiveFailures = 0;
        done += batch.length;
        options.onBatch?.(done, target.length, { definitions: recovered, skipped: unresolved });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        done += batch.length;
        options.onBatchError?.(done, target.length, batch.map((w) => w.word), message);
        consecutiveFailures += 1;
        // A provider that fails three batches in a row is broken or
        // unconfigured — stop instead of hammering every remaining batch.
        // With concurrent workers the streak counts failures in the order
        // they COMPLETE; workers already in flight finish their batch.
        if (consecutiveFailures >= 3) stopped = true;
      }
    };

    const worker = async (): Promise<void> => {
      while (!stopped && !options.signal?.aborted) {
        const index = nextBatchIndex++;
        if (index * size >= target.length) return;
        await processBatch(index);
        if (stopped || options.signal?.aborted) return;
        if ((index + 1) * size < target.length) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
        }
      }
    };

    const workerCount = Math.min(concurrency, Math.ceil(target.length / size));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return { definitions, skipped, errors };
  }
}
