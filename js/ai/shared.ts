/**
* internal:ai/shared — shared support code for AI provider adapters.
*
* This module holds the common pieces used by `fino:ai/model/openai`,
* `fino:ai/model/anthropic`, and the `fino:ai/model` convenience exports: provider
* base URLs, API-key resolution, provider HTTP errors, SSE response handling,
* schema normalization, stream assembly, and the basic `ModelStream`
* implementation.
*
* ## Boundary
*
* Application code should normally import from `fino:ai/model` or a concrete
* provider module. These helpers are kept together so bundled adapters normalize
* errors and stream assembly consistently. Provider HTTP failures throw
* `ModelError`; non-2xx streaming responses include status, body, and parsed
* retry-after delay when the provider supplied one.
*
* ```ts no_run
* import { assembleResult } from 'fino:ai/model';
*
* // Provider adapters expose streams; application code usually consumes the
* // public helper from fino:ai/model instead of importing internal utilities.
* const result = await assembleResult(stream);
* ```
*
* @internal
*/
import { env } from 'fino:process';
import { parseEventStream, EventSourceReader } from 'fino:net/http/eventstream';
import { createSignal } from 'fino:signals';
import type { StreamEvent, GenerateResult, ModelStream, ModelStreamState } from 'fino:ai/model';
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
  constructor(message: string, opts: {
    status: number;
    retryAfterMs?: number;
    body?: string;
  }) {
    super(message);
    this.name = 'ModelError';
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.body = opts.body;
  }
}
/**
* Error thrown when a provider endpoint does not expose model discovery.
*/
export class ModelListingUnsupportedError extends Error {
  provider: string;
  status: number;
  body?: string;
  constructor(message: string, opts: {
    provider: string;
    status: number;
    body?: string;
  }) {
    super(message);
    this.name = 'ModelListingUnsupportedError';
    this.provider = opts.provider;
    this.status = opts.status;
    this.body = opts.body;
  }
}
function parseRetryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined;
  const val = headers['retry-after'] ?? headers['Retry-After'];
  if (!val) return undefined;
  const secs = parseFloat(val);
  return isNaN(secs) ? undefined : Math.ceil(secs * 1e3);
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
export function resolveApiKey(opts: {
  apiKey?: string;
}, ...envNames: string[]): string {
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
    throw new ModelError(`Provider API error ${res.status}: ${body}`, {
      status: res.status,
      retryAfterMs,
      body
    });
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
  const toolsByIndex = new Map<number, {
    id: string;
    name: string;
    parts: string[];
  }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  let localCacheReadInputTokens: number | undefined;
  let localCacheReadOutputTokens: number | undefined;
  let stopReason: GenerateResult['stopReason'] = 'end_turn';
  for await (const event of events) {
    switch (event.type) {
      case 'text_delta':
        textByIndex.set(event.index, (textByIndex.get(event.index) ?? '') + event.text);
        break;
      case 'tool_call_start':
        toolsByIndex.set(event.index, {
          id: event.id,
          name: event.name,
          parts: []
        });
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
        localCacheReadInputTokens = event.usage.localCacheReadInputTokens;
        localCacheReadOutputTokens = event.usage.localCacheReadOutputTokens;
        break;
      case 'stop':
        stopReason = event.reason;
        break;
      case 'error': throw new Error(event.message);
    }
  }
  const text = [...textByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join('');
  const toolCalls = [...toolsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => {
    let args: unknown = {};
    try {
      args = JSON.parse(s.parts.join(''));
    } catch {}
    return {
      id: s.id,
      name: s.name,
      args
    };
  });
  return {
    text,
    toolCalls,
    stopReason,
    usage: {
      inputTokens,
      outputTokens,
      ...cacheReadInputTokens != null ? { cacheReadInputTokens } : {},
      ...cacheCreationInputTokens != null ? { cacheCreationInputTokens } : {},
      ...localCacheReadInputTokens != null ? { localCacheReadInputTokens } : {},
      ...localCacheReadOutputTokens != null ? { localCacheReadOutputTokens } : {}
    }
  };
}
/**
* Create the initial retained state for a model stream.
*
* @internal
*/
export function initialModelStreamState(): ModelStreamState {
  return {
    text: '',
    usage: {
      inputTokens: 0,
      outputTokens: 0
    },
    stopReason: 'end_turn'
  };
}

function renderTextByIndex(textByIndex: Map<number, string>): string {
  return [...textByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('');
}

/**
* Incrementally fold one provider event into a retained model stream state.
*
* @internal
*/
export function foldModelStreamEvent(state: ModelStreamState, event: StreamEvent, textByIndex: Map<number, string>): ModelStreamState {
  switch (event.type) {
    case 'text_delta':
      textByIndex.set(event.index, (textByIndex.get(event.index) ?? '') + event.text);
      return {
        ...state,
        text: renderTextByIndex(textByIndex)
      };
    case 'usage':
      return {
        ...state,
        usage: event.usage
      };
    case 'stop':
      return {
        ...state,
        stopReason: event.reason
      };
    case 'error':
      return {
        ...state,
        stopReason: 'error'
      };
    default:
      return state;
  }
}
/**
* Basic `ModelStream` implementation backed by an async generator.
*/
export class ModelStreamImpl implements ModelStream {
  #gen: AsyncGenerator<StreamEvent>;
  #state = createSignal<ModelStreamState>(initialModelStreamState());
  #textByIndex = new Map<number, string>();

  constructor(gen: AsyncGenerator<StreamEvent>) {
    this.#gen = gen;
  }

  /** Retained state folded from provider events observed so far. */
  get state() {
    return this.#state;
  }

  #fold(event: StreamEvent): void {
    this.#state.set((state) => foldModelStreamEvent(state, event, this.#textByIndex));
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    const iterator = this.#gen;
    const fold = (event: StreamEvent) => this.#fold(event);
    return {
      async next() {
        const next = await iterator.next();
        if (!next.done) fold(next.value);
        return next;
      },
      return: iterator.return?.bind(iterator),
      throw: iterator.throw?.bind(iterator)
    };
  }
  result(): Promise<GenerateResult> {
    const self = this;
    async function* folded() {
      for await (const event of self) yield event;
    }
    return assembleResult(folded());
  }
}
