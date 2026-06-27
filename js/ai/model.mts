/**
 * Provider-neutral model contracts for AI applications.
 *
 * Agents, tools, evals, and providers share these message, stream, usage, and
 * generation types. Provider modules adapt remote APIs into this small `Model`
 * interface so the rest of the framework can stay provider-agnostic.
 */

import { assembleResult, ModelError } from 'internal:ai/shared';
import { anthropic } from 'internal:ai/anthropic';
import { openai } from 'internal:ai/openai';

/**
 * Chat message role understood by all providers.
 */
export type Role = 'user' | 'assistant' | 'system';

/**
 * Text content part.
 */
export interface TextPart {
  type: 'text';
  text: string;
  cache?: true;
}

/**
 * Inline image content part.
 *
 * `data` is base64-encoded bytes without a data URI prefix.
 */
export interface ImagePart {
  type: 'image';
  mediaType: string;
  data: string;
}

/**
 * Model-requested tool call content part.
 */
export interface ToolUsePart {
  type: 'tool_use';
  id: string;
  name: string;
  args: unknown;
}

/**
 * Tool result content part sent back to the model.
 */
export interface ToolResultPart {
  type: 'tool_result';
  toolCallId: string;
  content: string | ContentPart[];
  isError?: boolean;
}

/**
 * Inline document content part.
 *
 * `data` is base64-encoded bytes without a data URI prefix. Providers may map
 * this to files, documents, or other native document upload fields.
 */
export interface DocumentPart {
  type: 'document';
  mediaType: string;
  data: string;
  name?: string;
}

/**
 * Content part accepted in a model message.
 */
export type ContentPart = TextPart | ImagePart | ToolUsePart | ToolResultPart | DocumentPart;

/**
 * Native structured response format request.
 */
export interface ResponseFormat {
  type: 'json_schema';
  name?: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

/**
 * Provider-neutral chat message.
 */
export interface ModelMessage {
  role: Role;
  content: string | ContentPart[];
}

/**
 * Provider-neutral tool definition sent with model requests.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Provider-neutral generation request.
 */
export interface GenerateRequest {
  model?: string;
  messages: ModelMessage[];
  system?: string | TextPart[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'any' | 'none' | { name: string };
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  responseFormat?: ResponseFormat;
  signal?: AbortSignal;
}

/**
 * Token usage reported by a provider.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * Reason a model stopped generating.
 */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error' | 'refusal' | 'content_filter';

/**
 * Assembled tool call returned by `generate()` or `ModelStream.result()`.
 */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/**
 * Complete non-streamed model result.
 */
export interface GenerateResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: StopReason;
}

/**
 * Streaming event emitted by provider adapters.
 */
export type StreamEvent =
  | { type: 'text_delta'; index: number; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; json: string }
  | { type: 'tool_call_end'; index: number }
  | { type: 'usage'; usage: Usage }
  | { type: 'stop'; reason: StopReason }
  | { type: 'error'; message: string };

/**
 * Async stream of model events.
 */
export interface ModelStream extends AsyncIterable<StreamEvent> {
  result(): Promise<GenerateResult>;
}

/**
 * Provider-neutral model adapter.
 */
export interface Model {
  /**
   * Stable model identifier used for provider requests and telemetry.
   *
   * Provider implementations set this explicitly. `name` remains available as
   * a compatibility alias for local test doubles and older call sites.
   */
  readonly id?: string;
  readonly name: string;
  /**
   * Provider identifier such as `openai` or `anthropic`.
   *
   * Agent code uses this for telemetry and feature decisions instead of
   * guessing from the model id.
   */
  readonly provider?: string;
  /**
   * Optional provider features that affect request construction.
   *
   * `responseFormat` means the provider can accept native JSON Schema response
   * format requests. The agent still defaults to portable forced-tool
   * structured output unless `structuredOutputMode: 'native'` is requested.
   */
  readonly capabilities?: {
    responseFormat?: boolean;
  };
  readonly dimensions: number;
  stream(req: GenerateRequest): ModelStream;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Common provider options accepted by bundled providers.
 */
export interface ProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  client?: {
    request(url: string | URL, init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | null;
      signal?: AbortSignal | null;
    }): Promise<{
      status: number;
      body: AsyncIterable<Uint8Array> | null;
      text(): Promise<string>;
      json(): Promise<unknown>;
    }>;
  };
  model?: string;
  maxTokens?: number;
  temperature?: number;
  dimensions?: number;
}

export { assembleResult, ModelError, anthropic, openai };
