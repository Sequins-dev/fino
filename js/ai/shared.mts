/**
 * Shared provider utilities for bundled AI adapters.
 *
 * Most exports in this file support `fino:ai/model` and provider modules rather
 * than direct application use.
 */

import { env } from 'fino:process';
import { parseEventStream, EventSourceReader } from 'fino:net/http/eventstream';
import type { StreamEvent, GenerateResult, ModelStream } from 'fino:ai/model';
import type { SchemaBuilder } from 'fino:validate';

/**
 * Default Anthropic API base URL.
 */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * Default OpenAI API base URL.
 */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Error thrown for provider HTTP failures.
 */
export class ModelError extends Error {
  status: number;
  retryAfterMs?: number;
  body?: string;

  constructor(message: string, opts: { status: number; retryAfterMs?: number; body?: string }) {
    super(message);
    this.name = 'ModelError';
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.body = opts.body;
  }
}

function parseRetryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined;
  const val = headers['retry-after'] ?? headers['Retry-After'];
  if (!val) return undefined;
  const secs = parseFloat(val);
  return isNaN(secs) ? undefined : Math.ceil(secs * 1000);
}

/**
 * Minimal HTTP response shape used by provider adapters.
 */
export interface ResponseLike {
  readonly status: number;
  readonly body: AsyncIterable<Uint8Array> | null;
  readonly headers?: Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/**
 * Minimal HTTP client shape accepted by provider adapters.
 */
export interface ClientLike {
  request(url: string | URL, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | null;
    signal?: AbortSignal | null;
  }): Promise<ResponseLike>;
}

/**
 * Schema accepted as either a `fino:validate` builder or plain JSON Schema.
 */
export type SchemaLike<T = unknown> = SchemaBuilder<T> | Record<string, unknown>;

/**
 * Normalize a schema builder or plain object into JSON Schema.
 */
export function normalizeSchema<T = unknown>(schema: SchemaLike<T>): Record<string, unknown> {
  if (schema && typeof schema === 'object' && 'schema' in schema) {
    return (schema as SchemaBuilder<T>).schema;
  }
  return schema as Record<string, unknown>;
}

/**
 * Resolve an API key from explicit options or environment variables.
 */
export function resolveApiKey(opts: { apiKey?: string }, ...envNames: string[]): string {
  if (opts.apiKey) return opts.apiKey;
  for (const name of envNames) {
    const value = (env as Record<string, string | undefined>)[name];
    if (value) return value;
  }
  throw new Error(`No API key found. Set ${envNames.join(' or ')} or pass apiKey in options.`);
}

/**
 * Convert a successful provider response body into an event-source reader.
 */
export async function streamFromResponse(res: ResponseLike): Promise<EventSourceReader> {
  if (res.status < 200 || res.status >= 300) {
    const body = await res.text();
    const retryAfterMs = parseRetryAfterMs(res.headers);
    throw new ModelError(`Provider API error ${res.status}: ${body}`, { status: res.status, retryAfterMs, body });
  }
  if (!res.body) {
    throw new Error(`Provider API returned no response body`);
  }
  return parseEventStream(res.body as AsyncIterable<Uint8Array | ArrayBuffer>);
}

/**
 * Assemble streamed provider events into a complete `GenerateResult`.
 */
export async function assembleResult(events: AsyncIterable<StreamEvent>): Promise<GenerateResult> {
  const textByIndex = new Map<number, string>();
  const toolsByIndex = new Map<number, { id: string; name: string; parts: string[] }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  let stopReason: GenerateResult['stopReason'] = 'end_turn';

  for await (const event of events) {
    switch (event.type) {
      case 'text_delta':
        textByIndex.set(event.index, (textByIndex.get(event.index) ?? '') + event.text);
        break;
      case 'tool_call_start':
        toolsByIndex.set(event.index, { id: event.id, name: event.name, parts: [] });
        break;
      case 'tool_call_delta': {
        const t = toolsByIndex.get(event.index);
        if (t) t.parts.push(event.json);
        break;
      }
      case 'usage':
        inputTokens = event.usage.inputTokens;
        outputTokens = event.usage.outputTokens;
        cacheReadInputTokens = event.usage.cacheReadInputTokens;
        cacheCreationInputTokens = event.usage.cacheCreationInputTokens;
        break;
      case 'stop':
        stopReason = event.reason;
        break;
      case 'error':
        throw new Error(event.message);
    }
  }

  const text = [...textByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => t)
    .join('');

  const toolCalls = [...toolsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => {
      let args: unknown = {};
      try { args = JSON.parse(s.parts.join('')); } catch { /* leave empty */ }
      return { id: s.id, name: s.name, args };
    });

  return {
    text,
    toolCalls,
    stopReason,
    usage: {
      inputTokens,
      outputTokens,
      ...(cacheReadInputTokens != null ? { cacheReadInputTokens } : {}),
      ...(cacheCreationInputTokens != null ? { cacheCreationInputTokens } : {}),
    },
  };
}

/**
 * Basic `ModelStream` implementation backed by an async generator.
 */
export class ModelStreamImpl implements ModelStream {
  #gen: AsyncGenerator<StreamEvent>;

  constructor(gen: AsyncGenerator<StreamEvent>) {
    this.#gen = gen;
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return this.#gen;
  }

  result(): Promise<GenerateResult> {
    return assembleResult(this.#gen);
  }
}
