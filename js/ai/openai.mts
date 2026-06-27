/**
 * OpenAI model provider adapter.
 *
 * `openai()` returns a provider-neutral `Model` backed by the OpenAI chat API.
 * It handles Fino message parts, tool calls, streaming events, embeddings, and
 * native JSON schema response formats when requested by the agent.
 */

import type {
  GenerateRequest,
  GenerateResult,
  StreamEvent,
  ProviderOptions,
  Model,
  ModelStream,
  StopReason,
  ToolCall,
} from 'fino:ai/model';
import type { SseEvent } from 'fino:net/http/eventstream';
import {
  resolveApiKey,
  streamFromResponse,
  ModelStreamImpl,
  ModelError,
  ClientLike,
  ResponseLike,
  OPENAI_BASE_URL,
} from 'internal:ai/shared';
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

function buildOpenAIRequest(
  req: GenerateRequest,
  modelName: string,
  maxTokens: number,
  temperature: number | undefined,
  stream: boolean,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  if (req.system != null) {
    const hasSystemMsg = req.messages.some((m) => m.role === 'system');
    if (!hasSystemMsg) {
      const content = typeof req.system === 'string'
        ? req.system
        : (req.system as Array<Record<string, unknown>>).map((p) => p.text as string).join('');
      messages.push({ role: 'system', content });
    }
  }

  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    const parts = msg.content as Array<{ type: string; [k: string]: unknown }>;
    const openaiParts: Array<Record<string, unknown>> = [];

    for (const part of parts) {
      if (part.type === 'text') {
        openaiParts.push({ type: 'text', text: part.text });
      } else if (part.type === 'image') {
        openaiParts.push({
          type: 'image_url',
          image_url: { url: `data:${part.mediaType};base64,${part.data}` },
        });
      } else if (part.type === 'document') {
        openaiParts.push({
          type: 'file',
          file: {
            filename: part.name ?? 'document',
            file_data: `data:${part.mediaType};base64,${part.data}`,
          },
        });
      } else if (part.type === 'tool_use') {
        // Tool use blocks in assistant messages are expressed as tool_calls
        // They are handled separately at the message level
      } else if (part.type === 'tool_result') {
        // Tool results become their own message with role 'tool'
        messages.push({
          role: 'tool',
          tool_call_id: part.toolCallId,
          content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
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
          function: { name: p.name, arguments: JSON.stringify(p.args ?? {}) },
        })),
      });
    } else if (openaiParts.length > 0) {
      messages.push({ role: msg.role, content: openaiParts });
    }
  }

  const body: Record<string, unknown> = {
    model: modelName,
    max_tokens: req.maxTokens ?? maxTokens,
    messages,
    stream,
  };

  if (stream) body.stream_options = { include_usage: true };

  const temp = req.temperature ?? temperature;
  if (temp != null) body.temperature = temp;

  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  if (req.toolChoice != null) {
    if (req.toolChoice === 'auto') body.tool_choice = 'auto';
    else if (req.toolChoice === 'any') body.tool_choice = 'required';
    else if (req.toolChoice === 'none') body.tool_choice = 'none';
    else body.tool_choice = { type: 'function', function: { name: (req.toolChoice as { name: string }).name } };
  }

  if (req.stopSequences?.length) body.stop = req.stopSequences;

  if (req.responseFormat?.type === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: req.responseFormat.name ?? 'response',
        schema: req.responseFormat.schema,
        strict: req.responseFormat.strict ?? true,
      },
    };
  }

  return body;
}

interface OpenAIStreamState {
  toolsByIndex: Map<number, { id: string; name: string }>;
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
  const choices = (chunk.choices as Array<Record<string, unknown>>) ?? [];

  if (chunk.usage != null && choices.length === 0) {
    const u = chunk.usage as Record<string, unknown>;
    const details = u.prompt_tokens_details as Record<string, number> | undefined;
    const cached = details?.cached_tokens ?? 0;
    results.push({
      type: 'usage',
      usage: {
        inputTokens: (u.prompt_tokens as number) ?? 0,
        outputTokens: (u.completion_tokens as number) ?? 0,
        ...(cached ? { cacheReadInputTokens: cached } : {}),
      },
    });
    return results;
  }

  for (const choice of choices) {
    const delta = (choice.delta as Record<string, unknown>) ?? {};

    if (typeof delta.content === 'string' && delta.content) {
      results.push({ type: 'text_delta', index: 0, text: delta.content });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
        const idx = tc.index as number;
        const fn = (tc.function as Record<string, unknown>) ?? {};

        if (typeof tc.id === 'string') {
          state.toolsByIndex.set(idx, { id: tc.id, name: (fn.name as string) ?? '' });
          results.push({ type: 'tool_call_start', index: idx, id: tc.id, name: (fn.name as string) ?? '' });
        }

        if (typeof fn.arguments === 'string' && fn.arguments) {
          results.push({ type: 'tool_call_delta', index: idx, json: fn.arguments });
        }
      }
    }

    if (choice.finish_reason != null && !state.seenFinish) {
      state.seenFinish = true;
      for (const [idx] of state.toolsByIndex) {
        results.push({ type: 'tool_call_end', index: idx });
      }
      results.push({ type: 'stop', reason: mapFinishReason(choice.finish_reason as string) });
    }
  }

  return results;
}

function normalizeOpenAIResponse(data: Record<string, unknown>): GenerateResult {
  const choices = (data.choices as Array<Record<string, unknown>>) ?? [];
  const choice = choices[0] ?? {};
  const message = (choice.message as Record<string, unknown>) ?? {};

  const text = (message.content as string | null) ?? '';
  const toolCalls: ToolCall[] = [];

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
      const fn = (tc.function as Record<string, unknown>) ?? {};
      let args: unknown = {};
      try { args = JSON.parse(fn.arguments as string); } catch { /* keep empty */ }
      toolCalls.push({ id: tc.id as string, name: fn.name as string, args });
    }
  }

  const usage = (data.usage as Record<string, unknown>) ?? {};
  const details = usage.prompt_tokens_details as Record<string, number> | undefined;
  const cached = details?.cached_tokens ?? 0;
  return {
    text,
    toolCalls,
    stopReason: mapFinishReason((choice.finish_reason as string) ?? 'stop'),
    usage: {
      inputTokens: (usage.prompt_tokens as number) ?? 0,
      outputTokens: (usage.completion_tokens as number) ?? 0,
      ...(cached ? { cacheReadInputTokens: cached } : {}),
    },
  };
}

class OpenAIModel implements Model {
  readonly id: string;
  readonly name: string;
  readonly provider = 'openai';
  readonly capabilities = { responseFormat: true };
  readonly dimensions: number;
  #client: ClientLike;
  #apiKey: string;
  #baseUrl: string;
  #headers: Record<string, string>;
  #maxTokens: number;
  #temperature: number | undefined;
  #embeddingModel: string;

  constructor(
    modelName: string,
    apiKey: string,
    client: ClientLike,
    baseUrl: string,
    headers: Record<string, string>,
    maxTokens: number,
    temperature: number | undefined,
    dimensions: number,
    embeddingModel: string,
  ) {
    this.id = modelName;
    this.name = modelName;
    this.dimensions = dimensions;
    this.#client = client;
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.#headers = headers;
    this.#maxTokens = maxTokens;
    this.#temperature = temperature;
    this.#embeddingModel = embeddingModel;
  }

  #authHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'authorization': `Bearer ${this.#apiKey}`,
      ...this.#headers,
    };
  }

  stream(req: GenerateRequest): ModelStream {
    const client = this.#client;
    const baseUrl = this.#baseUrl;
    const modelName = this.name;
    const maxTokens = this.#maxTokens;
    const temperature = this.#temperature;
    const authHeaders = this.#authHeaders();

    async function* gen(): AsyncGenerator<StreamEvent> {
      const body = buildOpenAIRequest(req, modelName, maxTokens, temperature, true);
      const res = await client.request(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...authHeaders, accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: req.signal ?? null,
      });
      const reader = await streamFromResponse(res);
      const state: OpenAIStreamState = { toolsByIndex: new Map(), seenFinish: false };
      for await (const event of reader) {
        for (const mapped of mapOpenAIEvent(event, state)) {
          yield mapped;
        }
      }
    }

    return new ModelStreamImpl(gen());
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const body = buildOpenAIRequest(req, this.name, this.#maxTokens, this.#temperature, false);
    const res = await this.#client.request(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...this.#authHeaders(), accept: 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal ?? null,
    });
    if (res.status < 200 || res.status >= 300) {
      const body = await res.text();
      throw new ModelError(`OpenAI API error ${res.status}: ${body}`, { status: res.status, body });
    }
    return normalizeOpenAIResponse((await res.json()) as Record<string, unknown>);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await this.#client.request(`${this.#baseUrl}/embeddings`, {
      method: 'POST',
      headers: this.#authHeaders(),
      body: JSON.stringify({ model: this.#embeddingModel, input: texts }),
    }) as ResponseLike;
    if (res.status < 200 || res.status >= 300) {
      const body = await res.text();
      throw new ModelError(`OpenAI API error ${res.status}: ${body}`, { status: res.status, body });
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => new Float32Array(d.embedding));
  }
}

/**
 * Create an OpenAI-backed `Model`.
 *
 * `apiKey` defaults to `OPENAI_API_KEY`. Override `client` in tests or custom
 * runtimes that provide their own HTTP transport.
 */
export function openai(opts: ProviderOptions = {}): Model {
  const apiKey = resolveApiKey(opts, 'OPENAI_API_KEY');
  const client = opts.client != null
    ? opts.client as unknown as ClientLike
    : new HttpClient() as unknown as ClientLike;

  return new OpenAIModel(
    opts.model ?? 'gpt-4o',
    apiKey,
    client,
    opts.baseUrl ?? OPENAI_BASE_URL,
    opts.headers ?? {},
    opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    opts.temperature,
    opts.dimensions ?? 0,
    'text-embedding-3-small',
  );
}
