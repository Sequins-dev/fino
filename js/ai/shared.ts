/**
 * internal:ai/shared — shared support code for AI provider adapters.
 *
 * This module holds the common pieces used by `fino:ai/model/openai`,
 * `fino:ai/model/anthropic`, `fino:ai/model/local`, and the `fino:ai/model`
 * convenience exports: provider base URLs, API-key resolution, provider HTTP
 * errors, SSE response handling, schema normalization, stream assembly, and
 * the basic `ModelStream` implementation. Keeping them in one place guarantees
 * every bundled adapter reports failures with the same `ModelError` shape and
 * folds streamed events into `GenerateResult` with identical semantics.
 *
 * ## Boundary
 *
 * As an `internal:*` module this is importable only from other built-ins.
 * Application code should import from `fino:ai/model` or a concrete provider
 * module instead; the pieces that matter publicly (`assembleResult`,
 * `ModelError`, `ModelListingUnsupportedError`) are re-exported there.
 * Provider HTTP failures throw `ModelError`; non-2xx streaming responses
 * include status, body, and parsed retry-after delay when the provider
 * supplied one.
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
 *
 * Used by the Anthropic adapter and provider registry whenever their options
 * omit `baseUrl`. Pass an explicit `baseUrl` to target a proxy or gateway
 * instead.
 */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
/**
 * Default OpenAI API base URL, including the `/v1` path prefix.
 *
 * Used by the OpenAI adapter and provider registry whenever their options omit
 * `baseUrl`. Any OpenAI-compatible endpoint (self-hosted inference servers,
 * gateways) can be substituted via an explicit `baseUrl`.
 */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/**
 * Error thrown for provider HTTP failures.
 *
 * Raised whenever a provider endpoint answers with a non-2xx status, both on
 * streaming requests (via `streamFromResponse`) and on the one-shot calls the
 * bundled adapters make. The response body text is preserved for diagnostics,
 * and when the provider sent a `Retry-After` header the parsed delay is
 * exposed in milliseconds so callers can implement backoff. Re-exported
 * publicly from `fino:ai/model`.
 *
 * ```ts no_run
 * import { ModelError } from 'fino:ai/model';
 *
 * try {
 *   await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
 * } catch (err) {
 *   if (err instanceof ModelError && err.status === 429) {
 *     await new Promise((resolve) => setTimeout(resolve, err.retryAfterMs ?? 1000));
 *     // retry the request
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 */
export class ModelError extends Error {
  /** HTTP status code returned by the provider. */
  status: number;
  /**
   * Delay parsed from the response's `Retry-After` header, in milliseconds.
   *
   * Only set when the provider sent a numeric `Retry-After` value; HTTP-date
   * forms are not parsed.
   */
  retryAfterMs?: number;
  /** Raw response body text, when it could be read. */
  body?: string;
  /** Create a provider error carrying the HTTP status and optional retry/body details. */
  constructor(
    message: string,
    opts: {
      status: number;
      retryAfterMs?: number;
      body?: string;
    },
  ) {
    super(message);
    this.name = 'ModelError';
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.body = opts.body;
  }
}
/**
 * Error thrown when a provider endpoint does not expose model discovery.
 *
 * The bundled provider registries probe the provider's model-listing endpoint
 * (`GET /models` and equivalents) to enumerate available model ids. Endpoints
 * that answer `404` — common for self-hosted OpenAI-compatible servers that
 * only implement chat completions — produce this error instead of a generic
 * `ModelError`, so callers can distinguish "listing not supported" from a
 * real request failure and fall back to a static model list. Re-exported
 * publicly from `fino:ai/model`.
 *
 * ```ts no_run
 * import { ModelListingUnsupportedError, modelRegistry, openaiProvider } from 'fino:ai/model';
 *
 * const registry = modelRegistry([openaiProvider({ baseUrl: 'http://localhost:8080/v1' })]);
 * try {
 *   const models = await registry.list();
 * } catch (err) {
 *   if (err instanceof ModelListingUnsupportedError) {
 *     // Endpoint has no discovery; construct models by known id instead.
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 */
export class ModelListingUnsupportedError extends Error {
  /** Provider identifier the failed registry belongs to, such as `openai` or `anthropic`. */
  provider: string;
  /** HTTP status code returned by the listing endpoint. */
  status: number;
  /** Raw response body text, when it could be read. */
  body?: string;
  /** Create a listing-unsupported error for the given provider and response details. */
  constructor(
    message: string,
    opts: {
      provider: string;
      status: number;
      body?: string;
    },
  ) {
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
 *
 * A structural subset of the `fino:net/http` client response: just enough for
 * adapters to check the status, stream an SSE body, and read error text. Tests
 * satisfy it with plain objects rather than real network responses, which is
 * how the model adapters are exercised without hitting live provider APIs.
 *
 * ```ts no_run
 * import type { ResponseLike } from 'internal:ai/shared';
 *
 * function fakeResponse(sse: string): ResponseLike {
 *   const bytes = new TextEncoder().encode(sse);
 *   return {
 *     status: 200,
 *     body: (async function* () { yield bytes; })(),
 *     async text() { return sse; },
 *     async json() { return JSON.parse(sse); },
 *   };
 * }
 * ```
 */
export interface ResponseLike {
  /** HTTP status code. */
  readonly status: number;
  /** Streaming response body as byte chunks, or `null` when there is none. */
  readonly body: AsyncIterable<Uint8Array> | null;
  /** Response headers keyed by name; consulted for `Retry-After` on failures. */
  readonly headers?: Record<string, string>;
  /** Read the full body as text. Used to capture error bodies for diagnostics. */
  text(): Promise<string>;
  /** Read and parse the full body as JSON. Used for non-streaming provider calls. */
  json(): Promise<unknown>;
}
/**
 * Minimal HTTP client shape accepted by provider adapters.
 *
 * Provider constructors take any object with a compatible `request` method.
 * This lets tests inject scripted fakes and lets applications supply a
 * preconfigured `fino:net/http` client (custom TLS, proxies, shared
 * connection pools) via the adapters' `client` option without the adapters
 * depending on a concrete class.
 *
 * ```ts no_run
 * import type { ClientLike, ResponseLike } from 'internal:ai/shared';
 *
 * const recorded: string[] = [];
 * const client: ClientLike = {
 *   async request(url, init) {
 *     recorded.push(`${init?.method ?? 'GET'} ${url}`);
 *     return fakeResponse('data: {"done":true}\n\n');
 *   },
 * };
 * // Pass to an adapter: openai({ model: 'gpt-4o', client })
 * ```
 */
export interface ClientLike {
  /**
   * Issue an HTTP request and resolve with the response.
   *
   * Adapters always pass explicit `method`, `headers`, and a string `body`
   * for provider calls, and forward the caller's `AbortSignal` when one was
   * provided so in-flight requests can be cancelled.
   */
  request(
    url: string | URL,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | null;
      signal?: AbortSignal | null;
    },
  ): Promise<ResponseLike>;
}
/**
 * Schema accepted as either a `fino:validate` builder or plain JSON Schema.
 *
 * APIs that take structured-output or tool-parameter schemas accept both
 * forms; `normalizeSchema` collapses them to plain JSON Schema before a
 * provider request is built. The type parameter carries the builder's
 * inferred value type through to callers that validate results.
 */
export type SchemaLike<T = unknown> = SchemaBuilder<T> | Record<string, unknown>;
/**
 * Normalize a schema builder or plain object into JSON Schema.
 *
 * Detection is structural: any object with a `schema` property is treated as
 * a `fino:validate` builder and its `.schema` is returned; anything else is
 * assumed to already be JSON Schema and passed through unchanged. This is the
 * single conversion point used by tool definitions, structured output, and
 * task schemas, so both forms behave identically everywhere.
 *
 * ```ts no_run
 * import { normalizeSchema } from 'internal:ai/shared';
 * import { v } from 'fino:validate';
 *
 * const fromBuilder = normalizeSchema(v.object({ name: v.string() }));
 * // { type: 'object', properties: { name: { type: 'string' } }, ... }
 *
 * const passthrough = normalizeSchema({ type: 'object' });
 * // { type: 'object' } — already JSON Schema, returned as-is
 * ```
 */
export function normalizeSchema<T = unknown>(schema: SchemaLike<T>): Record<string, unknown> {
  if (schema && typeof schema === 'object' && 'schema' in schema) {
    return (schema as SchemaBuilder<T>).schema;
  }
  return schema as Record<string, unknown>;
}
/**
 * Resolve an API key from explicit options or environment variables.
 *
 * An explicit `apiKey` in the options always wins. Otherwise each environment
 * variable name is consulted in order and the first non-empty value is used,
 * which lets an adapter prefer its own variable while accepting a generic
 * fallback.
 *
 * Throws if no key is found, with a message naming the environment variables
 * that were checked.
 *
 * ```ts no_run
 * import { resolveApiKey } from 'internal:ai/shared';
 *
 * const key = resolveApiKey({ apiKey: opts.apiKey }, 'ANTHROPIC_API_KEY');
 * // Explicit option → ANTHROPIC_API_KEY env var → throws
 * ```
 */
export function resolveApiKey(
  opts: {
    apiKey?: string;
  },
  ...envNames: string[]
): string {
  if (opts.apiKey) return opts.apiKey;
  for (const name of envNames) {
    const value = (env as Record<string, string | undefined>)[name];
    if (value) return value;
  }
  throw new Error(`No API key found. Set ${envNames.join(' or ')} or pass apiKey in options.`);
}
/**
 * Convert a successful provider response body into an event-source reader.
 *
 * On a 2xx status the body is handed to the `fino:net/http/eventstream`
 * parser and returned as an `EventSourceReader` yielding SSE events, which
 * provider adapters then translate into normalized `StreamEvent` values.
 *
 * Throws `ModelError` on any non-2xx status, after reading the full body so
 * the error carries the response text and any parsed `Retry-After` delay.
 * Throws a plain `Error` if a successful response has no body.
 *
 * ```ts no_run
 * import { streamFromResponse } from 'internal:ai/shared';
 *
 * const res = await client.request(`${baseUrl}/v1/messages`, {
 *   method: 'POST',
 *   headers,
 *   body: JSON.stringify({ ...request, stream: true }),
 * });
 * const reader = await streamFromResponse(res);
 * for await (const event of reader) {
 *   // event.data is one SSE payload from the provider
 * }
 * ```
 */
export async function streamFromResponse(res: ResponseLike): Promise<EventSourceReader> {
  if (res.status < 200 || res.status >= 300) {
    const body = await res.text();
    const retryAfterMs = parseRetryAfterMs(res.headers);
    throw new ModelError(`Provider API error ${res.status}: ${body}`, {
      status: res.status,
      retryAfterMs,
      body,
    });
  }
  if (!res.body) {
    throw new Error(`Provider API returned no response body`);
  }
  return parseEventStream(res.body as AsyncIterable<Uint8Array | ArrayBuffer>);
}
/**
 * Assemble streamed provider events into a complete `GenerateResult`.
 *
 * Consumes the stream to completion: `text_delta` events are concatenated per
 * content index and joined in ascending index order, tool-call JSON fragments
 * are accumulated per index, and the last reported usage and stop reason win.
 * Optional cache-token counters appear in the result's `usage` only when the
 * provider reported them. Tool arguments whose accumulated JSON fails to
 * parse fall back to `{}` rather than failing the whole result. This is how
 * the bundled adapters implement `Model.generate()` on top of their streaming
 * path, and it is re-exported publicly from `fino:ai/model`.
 *
 * Rejects with a plain `Error` if the stream emits an `error` event.
 *
 * ```ts no_run
 * import { assembleResult } from 'fino:ai/model';
 *
 * const stream = model.stream({
 *   messages: [{ role: 'user', content: 'Summarize this repo.' }],
 * });
 * const result = await assembleResult(stream);
 * console.log(result.text, result.toolCalls, result.stopReason, result.usage);
 * ```
 */
export async function assembleResult(events: AsyncIterable<StreamEvent>): Promise<GenerateResult> {
  const textByIndex = new Map<number, string>();
  const toolsByIndex = new Map<
    number,
    {
      id: string;
      name: string;
      parts: string[];
    }
  >();
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
          parts: [],
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
      try {
        args = JSON.parse(s.parts.join(''));
      } catch {}
      return {
        id: s.id,
        name: s.name,
        args,
      };
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
      ...(localCacheReadInputTokens != null ? { localCacheReadInputTokens } : {}),
      ...(localCacheReadOutputTokens != null ? { localCacheReadOutputTokens } : {}),
    },
  };
}
/**
 * Create the initial retained state for a model stream.
 *
 * Empty text, zeroed usage, and an `end_turn` stop reason — the value a
 * `ModelStream.state` signal holds before any provider events arrive.
 *
 * @internal
 */
export function initialModelStreamState(): ModelStreamState {
  return {
    text: '',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
    },
    stopReason: 'end_turn',
  };
}

function renderTextByIndex(textByIndex: Map<number, string>): string {
  return [...textByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, text]) => text)
    .join('');
}

/**
 * Incrementally fold one provider event into a retained model stream state.
 *
 * Returns a new state object; the previous state is never mutated, which
 * keeps signal change detection reliable. The caller owns `textByIndex`, a
 * mutable per-stream map of content index to accumulated text that this
 * function updates in place on `text_delta` events. `usage` and `stop` events
 * replace the corresponding fields, an `error` event forces the stop reason
 * to `error`, and tool-call events leave the state unchanged.
 *
 * @internal
 */
export function foldModelStreamEvent(
  state: ModelStreamState,
  event: StreamEvent,
  textByIndex: Map<number, string>,
): ModelStreamState {
  switch (event.type) {
    case 'text_delta':
      textByIndex.set(event.index, (textByIndex.get(event.index) ?? '') + event.text);
      return {
        ...state,
        text: renderTextByIndex(textByIndex),
      };
    case 'usage':
      return {
        ...state,
        usage: event.usage,
      };
    case 'stop':
      return {
        ...state,
        stopReason: event.reason,
      };
    case 'error':
      return {
        ...state,
        stopReason: 'error',
      };
    default:
      return state;
  }
}
/**
 * Basic `ModelStream` implementation backed by an async generator.
 *
 * Provider adapters wrap their event generators in this class to get both
 * halves of the `ModelStream` contract: async iteration over normalized
 * `StreamEvent` values, and a retained `state` signal that UIs can subscribe
 * to for incremental text and usage without consuming the stream themselves.
 * Every event that passes through the iterator is folded into the signal as
 * it is observed. The stream is single-pass: events pulled by one consumer
 * are not replayed for another.
 *
 * ```ts no_run
 * import { ModelStreamImpl } from 'internal:ai/shared';
 * import type { StreamEvent } from 'fino:ai/model';
 *
 * async function* events(): AsyncGenerator<StreamEvent> {
 *   yield { type: 'text_delta', index: 0, text: 'Hello' };
 *   yield { type: 'stop', reason: 'end_turn' };
 * }
 *
 * const stream = new ModelStreamImpl(events());
 * stream.state.subscribe((s) => render(s.text));
 * const result = await stream.result();
 * ```
 */
export class ModelStreamImpl implements ModelStream {
  #gen: AsyncGenerator<StreamEvent>;
  #state = createSignal<ModelStreamState>(initialModelStreamState());
  #textByIndex = new Map<number, string>();

  /** Wrap `gen` so its events drive both iteration and the retained state signal. */
  constructor(gen: AsyncGenerator<StreamEvent>) {
    this.#gen = gen;
  }

  /**
   * Retained state folded from provider events observed so far.
   *
   * A `fino:signals` signal holding the latest `ModelStreamState`. It only
   * advances as events are pulled from the stream — by direct iteration or by
   * awaiting `result()` — so an unconsumed stream never updates it.
   */
  get state() {
    return this.#state;
  }

  #fold(event: StreamEvent): void {
    this.#state.set((state) => foldModelStreamEvent(state, event, this.#textByIndex));
  }

  /** Iterate provider events, folding each one into `state` as it is observed. */
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
      throw: iterator.throw?.bind(iterator),
    };
  }
  /**
   * Consume the remaining events and assemble them into a `GenerateResult`.
   *
   * Delegates to `assembleResult` while still folding each event into
   * `state`, so progress subscribers keep updating while the final result is
   * awaited. Events already pulled by an earlier iterator are not replayed;
   * call this on an otherwise-unconsumed stream for a complete result.
   */
  result(): Promise<GenerateResult> {
    const self = this;
    async function* folded() {
      for await (const event of self) yield event;
    }
    return assembleResult(folded());
  }
}
