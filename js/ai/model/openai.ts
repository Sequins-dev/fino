/**
* fino:ai/model/openai — OpenAI provider adapter for the shared `Model` interface.
*
* OpenAI API reference: https://platform.openai.com/docs/api-reference
*
* `openai()` returns a provider-neutral `Model` backed by OpenAI chat
* completions and embeddings. `openaiProvider()` returns a discovery-capable
* provider that calls `GET /models` on an OpenAI-compatible base URL and can
* construct models from discovered ids. Both paths translate Fino message parts
* into OpenAI content blocks, map streamed chunks into `StreamEvent` values,
* normalize usage and stop reasons, and expose native JSON Schema
* response-format support through model capabilities.
*
* ## Defaults and limits
*
* `apiKey` defaults to `OPENAI_API_KEY`, `baseUrl` defaults to the public
* OpenAI API, and `model` defaults to `gpt-4o`. The adapter uses
* `text-embedding-3-small` for `embed()` and returns embeddings in input order
* even when the provider response is unordered. Provider HTTP failures throw
* `ModelError` with the response status and body.
*
* Pass a custom `client` for tests, proxies, or runtimes that need their own
* HTTP transport. This adapter does not retry; retry and fallback policy belong
* to `fino:ai/agent`.
*
* ```ts no_run
* import { agent } from 'fino:ai/agent';
* import { openaiProvider } from 'fino:ai/model/openai';
*
* const [info] = await openaiProvider().listModels();
* const bot = agent({
*   model: await info.create({ temperature: 0.2 }),
*   instructions: 'Answer with one concise paragraph.',
* });
*
* const result = await bot.generate('Explain durable agent sessions.');
* console.log(result.text);
* ```
*/
import type { GenerateRequest, GenerateResult, StreamEvent, ProviderOptions, Model, ModelCreateOptions, ModelInfo, ModelProvider, ModelStream, StopReason, ToolCall } from 'fino:ai/model';
import type { SseEvent } from 'fino:net/http/eventstream';
import { resolveApiKey, streamFromResponse, ModelStreamImpl, ModelError, ModelListingUnsupportedError, ClientLike, ResponseLike, OPENAI_BASE_URL } from 'internal:ai/shared';
import { HttpClient } from 'fino:net/http/client';
const DEFAULT_MAX_TOKENS = 4096;
function mapFinishReason(raw: string): StopReason {
  switch (raw) {
    case 'stop': return 'end_turn';
    case 'tool_calls':
    case 'function_call': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'content_filter': return 'content_filter';
    default: return 'end_turn';
  }
}
function buildOpenAIRequest(req: GenerateRequest, modelName: string, maxTokens: number, temperature: number | undefined, topP: number | undefined, seed: number | undefined, providerOptions: Record<string, unknown> | undefined, stream: boolean): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (req.system != null) {
    const hasSystemMsg = req.messages.some((m) => m.role === 'system');
    if (!hasSystemMsg) {
      const content = typeof req.system === 'string' ? req.system : (req.system as Array<Record<string, unknown>>).map((p) => p.text as string).join('');
      messages.push({
        role: 'system',
        content
      });
    }
  }
  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      messages.push({
        role: msg.role,
        content: msg.content
      });
      continue;
    }
    const parts = msg.content as Array<{
      type: string;
      [k: string]: unknown;
    }>;
    const openaiParts: Array<Record<string, unknown>> = [];
    for (const part of parts) {
      if (part.type === 'text') {
        openaiParts.push({
          type: 'text',
          text: part.text
        });
      } else if (part.type === 'image') {
        openaiParts.push({
          type: 'image_url',
          image_url: { url: `data:${part.mediaType};base64,${part.data}` }
        });
      } else if (part.type === 'document') {
        openaiParts.push({
          type: 'file',
          file: {
            filename: part.name ?? 'document',
            file_data: `data:${part.mediaType};base64,${part.data}`
          }
        });
      } else if (part.type === 'tool_use') {} else if (part.type === 'tool_result') {
        // Tool results become their own message with role 'tool'
        messages.push({
          role: 'tool',
          tool_call_id: part.toolCallId,
          content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content)
        });
        continue;
      }
    }
    const toolUseParts = parts.filter((p) => p.type === 'tool_use');
    if (toolUseParts.length > 0) {
      messages.push({
        role: 'assistant',
        content: openaiParts.length > 0 ? openaiParts : null,
        tool_calls: toolUseParts.map((p) => ({
          id: p.id,
          type: 'function',
          function: {
            name: p.name,
            arguments: JSON.stringify(p.args ?? {})
          }
        }))
      });
    } else if (openaiParts.length > 0) {
      messages.push({
        role: msg.role,
        content: openaiParts
      });
    }
  }
  const body: Record<string, unknown> = {
    model: modelName,
    max_tokens: req.maxTokens ?? maxTokens,
    messages,
    stream
  };
  if (stream) body.stream_options = { include_usage: true };
  const temp = req.temperature ?? temperature;
  if (temp != null) body.temperature = temp;
  const effectiveTopP = req.topP ?? topP;
  if (effectiveTopP != null) body.top_p = effectiveTopP;
  const effectiveSeed = req.seed ?? seed;
  if (effectiveSeed != null) body.seed = effectiveSeed;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
  }
  if (req.toolChoice != null) {
    if (req.toolChoice === 'auto') body.tool_choice = 'auto';
    else if (req.toolChoice === 'any') body.tool_choice = 'required';
    else if (req.toolChoice === 'none') body.tool_choice = 'none';
    else body.tool_choice = {
      type: 'function',
      function: { name: (req.toolChoice as {
        name: string;
      }).name }
    };
  }
  if (req.stopSequences?.length) body.stop = req.stopSequences;
  if (req.responseFormat?.type === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: req.responseFormat.name ?? 'response',
        schema: req.responseFormat.schema,
        strict: req.responseFormat.strict ?? true
      }
    };
  }
  const openaiOptions = req.providerOptions?.openai ?? providerOptions?.openai;
  if (openaiOptions && typeof openaiOptions === 'object' && !Array.isArray(openaiOptions)) {
    Object.assign(body, openaiOptions);
  }
  return body;
}
interface OpenAIStreamState {
  toolsByIndex: Map<number, {
    id: string;
    name: string;
  }>;
  seenFinish: boolean;
}
function mapOpenAIEvent(event: SseEvent, state: OpenAIStreamState): StreamEvent[] {
  if (event.data === '[DONE]') return [];
  let chunk: Record<string, unknown>;
  try {
    chunk = JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    return [];
  }
  const results: StreamEvent[] = [];
  const choices = chunk.choices as Array<Record<string, unknown>> ?? [];
  if (chunk.usage != null && choices.length === 0) {
    const u = chunk.usage as Record<string, unknown>;
    const details = u.prompt_tokens_details as Record<string, number> | undefined;
    const cached = details?.cached_tokens ?? 0;
    results.push({
      type: 'usage',
      usage: {
        inputTokens: u.prompt_tokens as number ?? 0,
        outputTokens: u.completion_tokens as number ?? 0,
        ...cached ? { cacheReadInputTokens: cached } : {}
      }
    });
    return results;
  }
  for (const choice of choices) {
    const delta = choice.delta as Record<string, unknown> ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      results.push({
        type: 'text_delta',
        index: 0,
        text: delta.content
      });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
        const idx = tc.index as number;
        const fn = tc.function as Record<string, unknown> ?? {};
        if (typeof tc.id === 'string') {
          state.toolsByIndex.set(idx, {
            id: tc.id,
            name: fn.name as string ?? ''
          });
          results.push({
            type: 'tool_call_start',
            index: idx,
            id: tc.id,
            name: fn.name as string ?? ''
          });
        }
        if (typeof fn.arguments === 'string' && fn.arguments) {
          results.push({
            type: 'tool_call_delta',
            index: idx,
            json: fn.arguments
          });
        }
      }
    }
    if (choice.finish_reason != null && !state.seenFinish) {
      state.seenFinish = true;
      for (const [idx] of state.toolsByIndex) {
        results.push({
          type: 'tool_call_end',
          index: idx
        });
      }
      results.push({
        type: 'stop',
        reason: mapFinishReason(choice.finish_reason as string)
      });
    }
  }
  return results;
}
function normalizeOpenAIResponse(data: Record<string, unknown>): GenerateResult {
  const choices = data.choices as Array<Record<string, unknown>> ?? [];
  const choice = choices[0] ?? {};
  const message = choice.message as Record<string, unknown> ?? {};
  const text = message.content as string | null ?? '';
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
      const fn = tc.function as Record<string, unknown> ?? {};
      let args: unknown = {};
      try {
        args = JSON.parse(fn.arguments as string);
      } catch {}
      toolCalls.push({
        id: tc.id as string,
        name: fn.name as string,
        args
      });
    }
  }
  const usage = data.usage as Record<string, unknown> ?? {};
  const details = usage.prompt_tokens_details as Record<string, number> | undefined;
  const cached = details?.cached_tokens ?? 0;
  return {
    text,
    toolCalls,
    stopReason: mapFinishReason(choice.finish_reason as string ?? 'stop'),
    usage: {
      inputTokens: usage.prompt_tokens as number ?? 0,
      outputTokens: usage.completion_tokens as number ?? 0,
      ...cached ? { cacheReadInputTokens: cached } : {}
    },
    providerMetadata: { openai: data }
  };
}
class OpenAIModel implements Model {
  readonly id: string;
  readonly name: string;
  readonly provider = 'openai';
  readonly capabilities = {
    streaming: true,
    toolCalling: true,
    toolChoice: {
      auto: true,
      any: true,
      none: true,
      named: true
    },
    structuredOutput: {
      jsonSchema: true,
      strictJsonSchema: true,
      native: true
    },
    input: {
      text: true,
      image: true,
      document: false
    },
    sampling: {
      temperature: true,
      topP: true,
      seed: true,
      stopSequences: true
    }
  };
  readonly dimensions: number;
  #client: ClientLike;
  #apiKey: string;
  #baseUrl: string;
  #headers: Record<string, string>;
  #maxTokens: number;
  #temperature: number | undefined;
  #topP: number | undefined;
  #seed: number | undefined;
  #providerOptions: Record<string, unknown> | undefined;
  #embeddingModel: string;
  constructor(modelName: string, apiKey: string, client: ClientLike, baseUrl: string, headers: Record<string, string>, maxTokens: number, temperature: number | undefined, topP: number | undefined, seed: number | undefined, providerOptions: Record<string, unknown> | undefined, dimensions: number, embeddingModel: string) {
    this.id = modelName;
    this.name = modelName;
    this.dimensions = dimensions;
    this.#client = client;
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.#headers = headers;
    this.#maxTokens = maxTokens;
    this.#temperature = temperature;
    this.#topP = topP;
    this.#seed = seed;
    this.#providerOptions = providerOptions;
    this.#embeddingModel = embeddingModel;
  }
  #authHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'authorization': `Bearer ${this.#apiKey}`,
      ...this.#headers
    };
  }
  stream(req: GenerateRequest): ModelStream {
    const client = this.#client;
    const baseUrl = this.#baseUrl;
    const modelName = this.name;
    const maxTokens = this.#maxTokens;
    const temperature = this.#temperature;
    const topP = this.#topP;
    const seed = this.#seed;
    const providerOptions = this.#providerOptions;
    const authHeaders = this.#authHeaders();
    async function* gen(): AsyncGenerator<StreamEvent> {
      const body = buildOpenAIRequest(req, modelName, maxTokens, temperature, topP, seed, providerOptions, true);
      const res = await client.request(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          accept: 'text/event-stream'
        },
        body: JSON.stringify(body),
        signal: req.signal ?? null
      });
      const reader = await streamFromResponse(res);
      const state: OpenAIStreamState = {
        toolsByIndex: new Map(),
        seenFinish: false
      };
      for await (const event of reader) {
        for (const mapped of mapOpenAIEvent(event, state)) {
          yield mapped;
        }
      }
    }
    return new ModelStreamImpl(gen());
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const body = buildOpenAIRequest(req, this.name, this.#maxTokens, this.#temperature, this.#topP, this.#seed, this.#providerOptions, false);
    const res = await this.#client.request(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...this.#authHeaders(),
        accept: 'application/json'
      },
      body: JSON.stringify(body),
      signal: req.signal ?? null
    });
    if (res.status < 200 || res.status >= 300) {
      const body = await res.text();
      throw new ModelError(`OpenAI API error ${res.status}: ${body}`, {
        status: res.status,
        body
      });
    }
    return normalizeOpenAIResponse(await res.json() as Record<string, unknown>);
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await this.#client.request(`${this.#baseUrl}/embeddings`, {
      method: 'POST',
      headers: this.#authHeaders(),
      body: JSON.stringify({
        model: this.#embeddingModel,
        input: texts
      })
    }) as ResponseLike;
    if (res.status < 200 || res.status >= 300) {
      const body = await res.text();
      throw new ModelError(`OpenAI API error ${res.status}: ${body}`, {
        status: res.status,
        body
      });
    }
    const data = await res.json() as {
      data: Array<{
        embedding: number[];
        index: number;
      }>;
    };
    return data.data.sort((a, b) => a.index - b.index).map((d) => new Float32Array(d.embedding));
  }
}
class OpenAIModelProvider implements ModelProvider {
  readonly provider = 'openai';
  #apiKey: string;
  #client: ClientLike;
  #baseUrl: string;
  #headers: Record<string, string>;
  #maxTokens: number;
  #temperature: number | undefined;
  #topP: number | undefined;
  #seed: number | undefined;
  #providerOptions: Record<string, unknown> | undefined;
  #dimensions: number;
  constructor(opts: ProviderOptions = {}) {
    this.#apiKey = resolveApiKey(opts, 'OPENAI_API_KEY');
    this.#client = opts.client != null ? (opts.client as unknown) as ClientLike : (new HttpClient() as unknown) as ClientLike;
    this.#baseUrl = opts.baseUrl ?? OPENAI_BASE_URL;
    this.#headers = opts.headers ?? {};
    this.#maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#temperature = opts.temperature;
    this.#topP = opts.topP;
    this.#seed = opts.seed;
    this.#providerOptions = opts.providerOptions;
    this.#dimensions = opts.dimensions ?? 0;
  }
  #authHeaders(headers?: Record<string, string>): Record<string, string> {
    return {
      'content-type': 'application/json',
      'authorization': `Bearer ${this.#apiKey}`,
      ...this.#headers,
      ...headers ?? {}
    };
  }
  async listModels(opts: {
    signal?: AbortSignal;
  } = {}): Promise<ModelInfo[]> {
    const url = `${this.#baseUrl}/models`;
    const res = await this.#client.request(url, {
      method: 'GET',
      headers: {
        ...this.#authHeaders(),
        accept: 'application/json'
      },
      signal: opts.signal ?? null
    }) as ResponseLike;
    if (res.status < 200 || res.status >= 300) {
      const body = await res.text();
      if (res.status === 404) {
        throw new ModelListingUnsupportedError(`OpenAI-compatible provider at ${this.#baseUrl} does not support model listing (${url})`, {
          provider: this.provider,
          status: res.status,
          body
        });
      }
      throw new ModelError(`OpenAI API error ${res.status}: ${body}`, {
        status: res.status,
        body
      });
    }
    const data = await res.json() as {
      data?: Array<Record<string, unknown>>;
    };
    return (data.data ?? []).map((entry) => this.#info(entry));
  }
  async createModel(id: string, opts: ModelCreateOptions = {}): Promise<Model> {
    return new OpenAIModel(id, this.#apiKey, this.#client, this.#baseUrl, {
      ...this.#headers,
      ...opts.headers ?? {}
    }, opts.maxTokens ?? this.#maxTokens, opts.temperature ?? this.#temperature, opts.topP ?? this.#topP, opts.seed ?? this.#seed, opts.providerOptions ?? this.#providerOptions, opts.dimensions ?? this.#dimensions, 'text-embedding-3-small');
  }
  #info(entry: Record<string, unknown>): ModelInfo {
    const id = String(entry.id);
    return {
      id,
      provider: this.provider,
      ...typeof entry.created === 'number' ? { createdAt: entry.created } : {},
      ...typeof entry.owned_by === 'string' ? { ownedBy: entry.owned_by } : {},
      capabilities: {
        streaming: true,
        toolCalling: true,
        toolChoice: {
          auto: true,
          any: true,
          none: true,
          named: true
        },
        structuredOutput: {
          jsonSchema: true,
          strictJsonSchema: true,
          native: true
        },
        input: {
          text: true,
          image: true,
          document: false
        },
        sampling: {
          temperature: true,
          topP: true,
          seed: true,
          stopSequences: true
        }
      },
      metadata: { ...entry },
      create: (opts?: ModelCreateOptions) => this.createModel(id, opts)
    };
  }
}
/**
* Create an OpenAI-compatible model provider.
*
* `listModels()` calls `GET /models` on `baseUrl`, which defaults to the
* public OpenAI `/v1` API base URL. OpenAI-compatible gateways (vLLM, Ollama,
* LiteLLM, and similar) can override `baseUrl` and keep the same discovery
* shape. Each returned `ModelInfo` carries the raw listing entry in
* `metadata` and a `create()` shortcut that builds the model with the
* provider's credentials and defaults; `createModel(id, opts)` does the same
* for an id you already know. Options passed to `create()`/`createModel()`
* override the provider-level defaults per model.
*
* Throws immediately if no API key is given and `OPENAI_API_KEY` is unset.
* `listModels()` throws `ModelListingUnsupportedError` when the endpoint
* responds 404 (a compatible gateway without a listing route) and `ModelError`
* for any other non-2xx response.
*
* ```ts no_run
* import { openaiProvider } from 'fino:ai/model/openai';
*
* const provider = openaiProvider({
*   baseUrl: 'http://localhost:8000/v1',
*   apiKey: 'sk-local',
* });
*
* const models = await provider.listModels();
* console.log(models.map((m) => m.id));
*
* const model = await provider.createModel(models[0].id, { temperature: 0 });
* const result = await model.generate({
*   messages: [{ role: 'user', content: 'Summarize the release notes.' }],
* });
* console.log(result.text);
* ```
*/
export function openaiProvider(opts: ProviderOptions = {}): ModelProvider {
  return new OpenAIModelProvider(opts);
}
/**
* Create an OpenAI-backed `Model`.
*
* `model` defaults to `gpt-4o` and `apiKey` defaults to `OPENAI_API_KEY`;
* construction throws if neither the option nor the environment variable
* provides a key. Sampling options (`maxTokens`, `temperature`, `topP`,
* `seed`) become model-level defaults that individual `generate()` and
* `stream()` requests may override, and `providerOptions.openai` entries are
* merged verbatim into every request body for provider-specific knobs.
*
* `generate()` and `stream()` call `POST /chat/completions`; `embed()` calls
* `POST /embeddings` with `text-embedding-3-small` and returns one
* `Float32Array` per input, in input order. Non-2xx responses throw
* `ModelError` carrying the status and response body. Override `client` in
* tests or custom runtimes that provide their own HTTP transport.
*
* ```ts no_run
* import { openai } from 'fino:ai/model/openai';
*
* const model = openai({ model: 'gpt-4o-mini', temperature: 0.3 });
*
* const result = await model.generate({
*   system: 'You are a terse changelog writer.',
*   messages: [{ role: 'user', content: 'Describe the 2.1 release.' }],
* });
* console.log(result.text, result.usage);
*
* const stream = model.stream({
*   messages: [{ role: 'user', content: 'Draft the announcement post.' }],
* });
* for await (const event of stream) {
*   if (event.type === 'text_delta') console.log(event.text);
* }
* ```
*/
export function openai(opts: ProviderOptions = {}): Model {
  return new OpenAIModel(opts.model ?? 'gpt-4o', resolveApiKey(opts, 'OPENAI_API_KEY'), opts.client != null ? (opts.client as unknown) as ClientLike : (new HttpClient() as unknown) as ClientLike, opts.baseUrl ?? OPENAI_BASE_URL, opts.headers ?? {}, opts.maxTokens ?? DEFAULT_MAX_TOKENS, opts.temperature, opts.topP, opts.seed, opts.providerOptions, opts.dimensions ?? 0, 'text-embedding-3-small');
}
