/**
* fino:ai/model/anthropic — Anthropic provider adapter for the shared `Model`.
*
* Anthropic Messages API reference: https://docs.anthropic.com/en/api/messages
*
* `anthropic()` returns a provider-neutral `Model` backed by Anthropic's
* Messages API. `anthropicProvider()` returns a discovery-capable provider that
* calls Anthropic's `GET /v1/models` endpoint and can construct models from
* discovered ids. Both paths translate Fino message parts into Anthropic content
* blocks, map server-sent events into `StreamEvent` values, normalize usage and
* stop reasons, and expose native JSON Schema response-format support through
* model capabilities.
*
* ## Defaults and limits
*
* `apiKey` defaults to `ANTHROPIC_API_KEY`, `baseUrl` defaults to the public
* Anthropic API, and `model` defaults to `claude-opus-4-8`. The adapter supports
* text, image, document, tool-use, and tool-result content parts. Anthropic does
* not provide a native embeddings endpoint through this adapter; `embed()`
* rejects with a clear error. Use an embeddings-capable provider for memory or
* semantic-similarity workflows.
*
* Pass a custom `client` for tests, proxies, or runtimes that need their own
* HTTP transport. This adapter does not retry; retry and fallback policy belong
* to `fino:ai/agent`.
*
* ```ts no_run
* import { agent } from 'fino:ai/agent';
* import { anthropicProvider } from 'fino:ai/model/anthropic';
*
* const [info] = await anthropicProvider().listModels();
* const bot = agent({
*   model: await info.create(),
*   instructions: 'Prefer explicit assumptions.',
* });
*
* const result = await bot.generate('Review this migration plan.');
* console.log(result.text);
* ```
*/
import type { GenerateRequest, GenerateResult, StreamEvent, ProviderOptions, Model, ModelCreateOptions, ModelInfo, ModelProvider, ModelStream, TextPart, StopReason, ToolCall } from 'fino:ai/model';
import type { SseEvent } from 'fino:net/http/eventstream';
import { resolveApiKey, streamFromResponse, ModelStreamImpl, ModelError, ModelListingUnsupportedError, ClientLike, ANTHROPIC_BASE_URL } from 'internal:ai/shared';
import { HttpClient } from 'fino:net/http/client';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
function mapStopReason(raw: string): StopReason {
  switch (raw) {
    case 'end_turn': return 'end_turn';
    case 'tool_use': return 'tool_use';
    case 'max_tokens': return 'max_tokens';
    case 'stop_sequence': return 'stop_sequence';
    case 'refusal': return 'refusal';
    default: return 'end_turn';
  }
}
function convertContentPart(part: {
  type: string;
  [k: string]: unknown;
}): Record<string, unknown> {
  if (part.type === 'text') {
    return part.cache ? {
      type: 'text',
      text: part.text,
      cache_control: { type: 'ephemeral' }
    } : {
      type: 'text',
      text: part.text
    };
  }
  if (part.type === 'image') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: part.mediaType,
        data: part.data
      }
    };
  }
  if (part.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: part.id,
      name: part.name,
      input: part.args
    };
  }
  if (part.type === 'tool_result') {
    return {
      type: 'tool_result',
      tool_use_id: part.toolCallId,
      content: part.content,
      ...part.isError ? { is_error: true } : {}
    };
  }
  if (part.type === 'document') {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: part.mediaType,
        data: part.data
      },
      ...part.name ? { title: part.name } : {}
    };
  }
  return part;
}
function buildAnthropicRequest(req: GenerateRequest, modelName: string, maxTokens: number, temperature: number | undefined, topP: number | undefined, providerOptions: Record<string, unknown> | undefined): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  let system: unknown;
  for (const msg of req.messages) {
    if (msg.role === 'system') {
      system = typeof msg.content === 'string' ? msg.content : (msg.content as Array<{
        type: string;
        [k: string]: unknown;
      }>).map(convertContentPart);
      continue;
    }
    messages.push({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : (msg.content as Array<{
        type: string;
        [k: string]: unknown;
      }>).map(convertContentPart)
    });
  }
  if (req.system != null && system == null) {
    system = typeof req.system === 'string' ? req.system : (req.system as TextPart[]).map((p) => p.cache ? {
      type: 'text',
      text: p.text,
      cache_control: { type: 'ephemeral' }
    } : {
      type: 'text',
      text: p.text
    });
  }
  const body: Record<string, unknown> = {
    model: modelName,
    max_tokens: req.maxTokens ?? maxTokens,
    messages
  };
  if (system != null) body.system = system;
  const temp = req.temperature ?? temperature;
  if (temp != null) body.temperature = temp;
  const effectiveTopP = req.topP ?? topP;
  if (effectiveTopP != null) body.top_p = effectiveTopP;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    }));
  }
  if (req.toolChoice != null) {
    if (req.toolChoice === 'auto') body.tool_choice = { type: 'auto' };
    else if (req.toolChoice === 'any') body.tool_choice = { type: 'any' };
    else if (req.toolChoice === 'none') body.tool_choice = { type: 'none' };
    else body.tool_choice = {
      type: 'tool',
      name: (req.toolChoice as {
        name: string;
      }).name
    };
  }
  if (req.stopSequences?.length) body.stop_sequences = req.stopSequences;
  if (req.responseFormat?.type === 'json_schema') {
    body.output_config = { format: {
      type: 'json_schema',
      json_schema: {
        name: req.responseFormat.name ?? 'response',
        schema: req.responseFormat.schema,
        ...req.responseFormat.strict != null ? { strict: req.responseFormat.strict } : {}
      }
    } };
  }
  const anthropicOptions = req.providerOptions?.anthropic ?? providerOptions?.anthropic;
  if (anthropicOptions && typeof anthropicOptions === 'object' && !Array.isArray(anthropicOptions)) {
    Object.assign(body, anthropicOptions);
  }
  return body;
}
interface AnthropicStreamState {
  blocks: Map<number, {
    type: string;
    id?: string;
    name?: string;
  }>;
  inputTokens: number;
  cacheRead: number;
  cacheCreation: number;
}
function mapAnthropicEvent(event: SseEvent, state: AnthropicStreamState): StreamEvent[] {
  const results: StreamEvent[] = [];
  switch (event.type) {
    case 'message_start': {
      const msg = JSON.parse(event.data) as {
        message?: {
          usage?: Record<string, number>;
        };
      };
      const usage = msg.message?.usage;
      if (usage) {
        state.inputTokens = usage.input_tokens ?? 0;
        state.cacheRead = usage.cache_read_input_tokens ?? 0;
        state.cacheCreation = usage.cache_creation_input_tokens ?? 0;
      }
      break;
    }
    case 'content_block_start': {
      const frame = JSON.parse(event.data) as {
        index: number;
        content_block: {
          type: string;
          id?: string;
          name?: string;
        };
      };
      state.blocks.set(frame.index, frame.content_block);
      if (frame.content_block.type === 'tool_use') {
        results.push({
          type: 'tool_call_start',
          index: frame.index,
          id: frame.content_block.id!,
          name: frame.content_block.name!
        });
      }
      break;
    }
    case 'content_block_delta': {
      const frame = JSON.parse(event.data) as {
        index: number;
        delta: {
          type: string;
          text?: string;
          partial_json?: string;
        };
      };
      if (frame.delta.type === 'text_delta' && frame.delta.text) {
        results.push({
          type: 'text_delta',
          index: frame.index,
          text: frame.delta.text
        });
      } else if (frame.delta.type === 'input_json_delta' && frame.delta.partial_json != null) {
        results.push({
          type: 'tool_call_delta',
          index: frame.index,
          json: frame.delta.partial_json
        });
      }
      break;
    }
    case 'content_block_stop': {
      const frame = JSON.parse(event.data) as {
        index: number;
      };
      const block = state.blocks.get(frame.index);
      if (block?.type === 'tool_use') {
        results.push({
          type: 'tool_call_end',
          index: frame.index
        });
      }
      break;
    }
    case 'message_delta': {
      const frame = JSON.parse(event.data) as {
        delta: {
          stop_reason?: string;
        };
        usage?: {
          output_tokens?: number;
        };
      };
      results.push({
        type: 'usage',
        usage: {
          inputTokens: state.inputTokens,
          outputTokens: frame.usage?.output_tokens ?? 0,
          ...state.cacheRead ? { cacheReadInputTokens: state.cacheRead } : {},
          ...state.cacheCreation ? { cacheCreationInputTokens: state.cacheCreation } : {}
        }
      });
      if (frame.delta.stop_reason) {
        results.push({
          type: 'stop',
          reason: mapStopReason(frame.delta.stop_reason)
        });
      }
      break;
    }
  }
  return results;
}
function normalizeAnthropicResponse(data: Record<string, unknown>): GenerateResult {
  const content = data.content as Array<Record<string, unknown>> ?? [];
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      text += block.text as string;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id as string,
        name: block.name as string,
        args: block.input
      });
    }
  }
  const usage = data.usage as Record<string, number> ?? {};
  return {
    text,
    toolCalls,
    stopReason: mapStopReason(data.stop_reason as string ?? 'end_turn'),
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      ...usage.cache_read_input_tokens ? { cacheReadInputTokens: usage.cache_read_input_tokens } : {},
      ...usage.cache_creation_input_tokens ? { cacheCreationInputTokens: usage.cache_creation_input_tokens } : {}
    },
    providerMetadata: { anthropic: data }
  };
}
class AnthropicModel implements Model {
  readonly id: string;
  readonly name: string;
  readonly provider = 'anthropic';
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
      document: true
    },
    sampling: {
      temperature: true,
      topP: true,
      seed: false,
      stopSequences: true
    }
  };
  readonly dimensions = 0;
  #client: ClientLike;
  #apiKey: string;
  #baseUrl: string;
  #headers: Record<string, string>;
  #maxTokens: number;
  #temperature: number | undefined;
  #topP: number | undefined;
  #providerOptions: Record<string, unknown> | undefined;
  constructor(modelName: string, apiKey: string, client: ClientLike, baseUrl: string, headers: Record<string, string>, maxTokens: number, temperature: number | undefined, topP: number | undefined, providerOptions: Record<string, unknown> | undefined) {
    this.id = modelName;
    this.name = modelName;
    this.#client = client;
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.#headers = headers;
    this.#maxTokens = maxTokens;
    this.#temperature = temperature;
    this.#topP = topP;
    this.#providerOptions = providerOptions;
  }
  stream(req: GenerateRequest): ModelStream {
    const client = this.#client;
    const apiKey = this.#apiKey;
    const baseUrl = this.#baseUrl;
    const headers = this.#headers;
    const maxTokens = this.#maxTokens;
    const temperature = this.#temperature;
    const topP = this.#topP;
    const providerOptions = this.#providerOptions;
    const modelName = this.name;
    async function* gen(): AsyncGenerator<StreamEvent> {
      const body = buildAnthropicRequest(req, modelName, maxTokens, temperature, topP, providerOptions);
      const res = await client.request(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'text/event-stream',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          ...headers
        },
        body: JSON.stringify({
          ...body,
          stream: true
        }),
        signal: req.signal ?? null
      });
      const reader = await streamFromResponse(res);
      const state: AnthropicStreamState = {
        blocks: new Map(),
        inputTokens: 0,
        cacheRead: 0,
        cacheCreation: 0
      };
      for await (const event of reader) {
        for (const mapped of mapAnthropicEvent(event, state)) {
          yield mapped;
        }
      }
    }
    return new ModelStreamImpl(gen());
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const body = buildAnthropicRequest(req, this.name, this.#maxTokens, this.#temperature, this.#topP, this.#providerOptions);
    const res = await this.#client.request(`${this.#baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'x-api-key': this.#apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        ...this.#headers
      },
      body: JSON.stringify({
        ...body,
        stream: false
      }),
      signal: req.signal ?? null
    });
    if (res.status < 200 || res.status >= 300) {
      const body = await res.text();
      throw new ModelError(`Anthropic API error ${res.status}: ${body}`, {
        status: res.status,
        body
      });
    }
    return normalizeAnthropicResponse(await res.json() as Record<string, unknown>);
  }
  embed(_texts: string[]): Promise<Float32Array[]> {
    return Promise.reject(new Error('Anthropic does not provide a native embeddings endpoint. Use an OpenAI-compatible provider for embeddings.'));
  }
}
class AnthropicModelProvider implements ModelProvider {
  readonly provider = 'anthropic';
  #apiKey: string;
  #client: ClientLike;
  #baseUrl: string;
  #headers: Record<string, string>;
  #maxTokens: number;
  #temperature: number | undefined;
  #topP: number | undefined;
  #providerOptions: Record<string, unknown> | undefined;
  constructor(opts: ProviderOptions = {}) {
    this.#apiKey = resolveApiKey(opts, 'ANTHROPIC_API_KEY');
    this.#client = opts.client != null ? (opts.client as unknown) as ClientLike : (new HttpClient() as unknown) as ClientLike;
    this.#baseUrl = opts.baseUrl ?? ANTHROPIC_BASE_URL;
    this.#headers = opts.headers ?? {};
    this.#maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#temperature = opts.temperature;
    this.#topP = opts.topP;
    this.#providerOptions = opts.providerOptions;
  }
  #authHeaders(headers?: Record<string, string>): Record<string, string> {
    return {
      'content-type': 'application/json',
      'accept': 'application/json',
      'x-api-key': this.#apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      ...this.#headers,
      ...headers ?? {}
    };
  }
  async listModels(opts: {
    signal?: AbortSignal;
  } = {}): Promise<ModelInfo[]> {
    const url = `${this.#baseUrl}/v1/models`;
    const res = await this.#client.request(url, {
      method: 'GET',
      headers: this.#authHeaders(),
      signal: opts.signal ?? null
    }) as ResponseLike;
    if (res.status < 200 || res.status >= 300) {
      const body = await res.text();
      if (res.status === 404) {
        throw new ModelListingUnsupportedError(`Anthropic provider at ${this.#baseUrl} does not support model listing (${url})`, {
          provider: this.provider,
          status: res.status,
          body
        });
      }
      throw new ModelError(`Anthropic API error ${res.status}: ${body}`, {
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
    return new AnthropicModel(id, this.#apiKey, this.#client, this.#baseUrl, {
      ...this.#headers,
      ...opts.headers ?? {}
    }, opts.maxTokens ?? this.#maxTokens, opts.temperature ?? this.#temperature, opts.topP ?? this.#topP, opts.providerOptions ?? this.#providerOptions);
  }
  #info(entry: Record<string, unknown>): ModelInfo {
    const id = String(entry.id);
    const createdAt = typeof entry.created_at === 'string' ? Date.parse(entry.created_at) : undefined;
    return {
      id,
      provider: this.provider,
      ...typeof entry.display_name === 'string' ? { displayName: entry.display_name } : {},
      ...createdAt !== undefined && !Number.isNaN(createdAt) ? { createdAt } : {},
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
          document: true
        },
        sampling: {
          temperature: true,
          topP: true,
          seed: false,
          stopSequences: true
        }
      },
      metadata: { ...entry },
      create: (opts?: ModelCreateOptions) => this.createModel(id, opts)
    };
  }
}
/**
* Create an Anthropic model provider.
*
* `listModels()` calls `GET /v1/models` on `baseUrl`, which defaults to the
* public Anthropic API origin.
*/
export function anthropicProvider(opts: ProviderOptions = {}): ModelProvider {
  return new AnthropicModelProvider(opts);
}
/**
* Create an Anthropic-backed `Model`.
*
* `apiKey` defaults to `ANTHROPIC_API_KEY`. Override `client` in tests or
* custom runtimes that provide their own HTTP transport.
*/
export function anthropic(opts: ProviderOptions = {}): Model {
  return new AnthropicModel(opts.model ?? 'claude-opus-4-8', resolveApiKey(opts, 'ANTHROPIC_API_KEY'), opts.client != null ? (opts.client as unknown) as ClientLike : (new HttpClient() as unknown) as ClientLike, opts.baseUrl ?? ANTHROPIC_BASE_URL, opts.headers ?? {}, opts.maxTokens ?? DEFAULT_MAX_TOKENS, opts.temperature, opts.topP, opts.providerOptions);
}
