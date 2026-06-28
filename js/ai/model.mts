/**
 * fino:ai/model — provider-neutral messages, streams, and model adapters.
 *
 * This module defines the narrow contract that the rest of `fino:ai` builds
 * on. Providers adapt remote APIs into `Model`, agents consume `Model` without
 * provider-specific branches, tools use the shared message and content-part
 * shapes, and evals can run against any compatible implementation, including
 * optional local llama.cpp models.
 *
 * ## Design
 *
 * `Model.stream()` is the canonical path for agent execution. Provider adapters
 * emit normalized `StreamEvent` values for text, tool-call deltas, usage, stop
 * reasons, and errors; `assembleResult()` folds those events into the same
 * `GenerateResult` shape returned by `Model.generate()`. Message content parts
 * are provider-neutral and are translated by `fino:ai/model/openai`,
 * `fino:ai/model/anthropic`, and `fino:ai/model/local` into each provider's
 * native format.
 *
 * This module does not hide provider capabilities. Adapters expose `id`,
 * `provider`, and optional `capabilities` so higher layers can make explicit
 * choices, such as using native structured-output transport only when a model
 * declares support for it. Provider registries can also discover available
 * model ids from OpenAI-compatible and Anthropic endpoints before constructing
 * a concrete `Model`.
 *
 * ```ts no_run
 * import { assembleResult, modelRegistry, openaiProvider } from 'fino:ai/model';
 *
 * const registry = modelRegistry([
 *   openaiProvider({ baseUrl: 'https://api.openai.com/v1' }),
 * ]);
 * const [info] = await registry.list();
 * const model = await info.create({ temperature: 0.2 });
 * const stream = model.stream({
 *   messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
 * });
 *
 * const result = await assembleResult(stream);
 * console.log(result.text, result.usage);
 * ```
 */

import {
  assembleResult as sharedAssembleResult,
  ModelError as SharedModelError,
  ModelListingUnsupportedError as SharedModelListingUnsupportedError,
} from 'internal:ai/shared';
import {
  anthropic as anthropicFactory,
  anthropicProvider as createAnthropicProvider,
} from 'internal:ai/model/anthropic';
import {
  openai as openaiFactory,
  openaiProvider as createOpenAIProvider,
} from 'internal:ai/model/openai';
import {
  hasLlamaCpp as localHasLlamaCpp,
  local as localFactory,
  localProvider as createLocalProvider,
  LocalModelLibraryError as SharedLocalModelLibraryError,
  LocalModelUnsupportedError as SharedLocalModelUnsupportedError,
} from 'internal:ai/model/local';

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
 * Options applied when constructing a `Model` from a provider or registry.
 */
export interface ModelCreateOptions {
  /**
   * Default maximum output token count for models created from the provider.
   */
  maxTokens?: number;
  /**
   * Default sampling temperature for models created from the provider.
   */
  temperature?: number;
  /**
   * Embedding vector dimensions for providers that support embeddings.
   */
  dimensions?: number;
  /**
   * Additional provider headers merged with the provider's configured headers.
   */
  headers?: Record<string, string>;
}

/**
 * Discovered model entry returned by a `ModelProvider`.
 *
 * `create()` constructs a provider-neutral `Model` for this exact model id
 * using the provider configuration that discovered it.
 */
export interface ModelInfo {
  /**
   * Provider model id used in generation requests.
   */
  readonly id: string;
  /**
   * Provider identifier such as `openai` or `anthropic`.
   */
  readonly provider: string;
  /**
   * Human-readable name returned by the provider, when available.
   */
  readonly displayName?: string;
  /**
   * Provider-reported creation timestamp, when available.
   */
  readonly createdAt?: number;
  /**
   * Owner or organization returned by OpenAI-compatible endpoints.
   */
  readonly ownedBy?: string;
  /**
   * Capabilities inferred by the provider adapter for this model.
   */
  readonly capabilities?: Model['capabilities'];
  /**
   * Raw provider metadata for callers that need provider-specific fields.
   */
  readonly metadata?: Record<string, unknown>;
  /**
   * Construct a `Model` for this discovered model id.
   *
   * Remote providers usually return synchronously. Local providers may return a
   * promise because resolving a model can involve filesystem or cache work.
   */
  create(opts?: ModelCreateOptions): Model | Promise<Model>;
}

/**
 * Provider that can discover available model ids and construct `Model`
 * adapters for those ids.
 */
export interface ModelProvider {
  /**
   * Stable provider name used in `ModelInfo.provider` and registry filters.
   */
  readonly provider: string;
  /**
   * Fetch available models from the provider endpoint.
   */
  listModels(opts?: { signal?: AbortSignal }): Promise<ModelInfo[]>;
  /**
   * Construct a model by provider model id.
   */
  createModel(id: string, opts?: ModelCreateOptions): Model | Promise<Model>;
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

export type {
  LocalModelOptions,
  LocalProviderOptions,
  LocalModelSource,
  LocalModelProviderEntry,
} from 'internal:ai/model/local';

/**
 * Registry for discovering and constructing provider-neutral models.
 *
 * The registry caches `listModels()` results per provider instance. Pass
 * `refresh: true` to bypass the cache for a call.
 */
export class ModelRegistry {
  #providers: ModelProvider[];
  #cache = new Map<ModelProvider, ModelInfo[]>();

  /**
   * Create a registry with an optional initial provider list.
   */
  constructor(providers: ModelProvider[] = []) {
    this.#providers = [...providers];
  }

  /**
   * Add a provider and return this registry for chaining.
   */
  add(provider: ModelProvider): this {
    this.#providers.push(provider);
    this.#cache.delete(provider);
    return this;
  }

  /**
   * List discovered models across all providers or one provider.
   */
  async list(opts: { provider?: string; refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
    const providers = this.#matchingProviders(opts.provider);
    const out: ModelInfo[] = [];
    for (const provider of providers) {
      if (opts.refresh || !this.#cache.has(provider)) {
        this.#cache.set(provider, await provider.listModels({ signal: opts.signal }));
      }
      out.push(...(this.#cache.get(provider) ?? []));
    }
    return out;
  }

  /**
   * Find a model by id, or return `null` when no provider reports it.
   */
  async get(id: string, opts: { provider?: string; refresh?: boolean } = {}): Promise<ModelInfo | null> {
    const matches = (await this.list(opts)).filter((model) => model.id === id);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new Error(`Model id "${id}" is ambiguous; pass provider to choose one.`);
    }
    return matches[0]!;
  }

  /**
   * Construct a `Model` by discovered id.
   */
  async create(id: string, opts: ModelCreateOptions & { provider?: string; refresh?: boolean } = {}): Promise<Model> {
    const { provider, refresh, ...createOpts } = opts;
    const info = await this.get(id, { provider, refresh });
    if (!info) throw new Error(`Model "${id}" not found`);
    return info.create(createOpts);
  }

  #matchingProviders(providerName: string | undefined): ModelProvider[] {
    if (providerName === undefined) return this.#providers;
    const providers = this.#providers.filter((provider) => provider.provider === providerName);
    if (providers.length === 0) throw new Error(`No model provider named "${providerName}"`);
    return providers;
  }
}

/**
 * Create a model registry from one or more providers.
 */
export function modelRegistry(providers: ModelProvider[] = []): ModelRegistry {
  return new ModelRegistry(providers);
}

/**
 * Assemble streamed provider events into a complete `GenerateResult`.
 */
export function assembleResult(events: AsyncIterable<StreamEvent>): Promise<GenerateResult> {
  return sharedAssembleResult(events);
}

/**
 * Error thrown for provider HTTP failures.
 */
export const ModelError = SharedModelError;

/**
 * Error thrown when a provider endpoint does not support model listing.
 */
export const ModelListingUnsupportedError = SharedModelListingUnsupportedError;

/**
 * Create an Anthropic-backed `Model`.
 *
 * `apiKey` defaults to `ANTHROPIC_API_KEY`.
 */
export function anthropic(opts: ProviderOptions = {}): Model {
  return anthropicFactory(opts);
}

/**
 * Create an Anthropic provider that can list and construct models.
 *
 * `apiKey` defaults to `ANTHROPIC_API_KEY`.
 */
export function anthropicProvider(opts: ProviderOptions = {}): ModelProvider {
  return createAnthropicProvider(opts);
}

/**
 * Create an OpenAI-backed `Model`.
 *
 * `apiKey` defaults to `OPENAI_API_KEY`.
 */
export function openai(opts: ProviderOptions = {}): Model {
  return openaiFactory(opts);
}

/**
 * Create an OpenAI-compatible provider that can list and construct models.
 *
 * `apiKey` defaults to `OPENAI_API_KEY`.
 */
export function openaiProvider(opts: ProviderOptions = {}): ModelProvider {
  return createOpenAIProvider(opts);
}

/**
 * Whether the default llama.cpp shim was found when this module was evaluated.
 *
 * This is a capability gate for optional local model support. It reflects only
 * default lookup paths such as `FINO_LLAMA_LIBRARY`; callers can still pass an
 * explicit `libraryPath` to `local()`.
 */
export const hasLlamaCpp = localHasLlamaCpp;

/**
 * Error thrown when local llama.cpp support is requested but no usable shim is
 * available.
 */
export const LocalModelLibraryError = SharedLocalModelLibraryError;

/**
 * Error thrown for local model request features that the llama.cpp adapter does
 * not implement.
 */
export const LocalModelUnsupportedError = SharedLocalModelUnsupportedError;

/**
 * Create a local llama.cpp-backed `Model`.
 *
 * The model source can be a local GGUF path or an explicit Hugging Face GGUF
 * file. Construction is async because Hugging Face sources may need to be
 * downloaded into the local cache before llama.cpp opens them.
 */
export const local = localFactory;

/**
 * Create a local provider for configured GGUF models.
 *
 * Local providers do not discover remote model catalogs. `listModels()` returns
 * the configured entries so registries can present local and remote models
 * through one interface.
 */
export const localProvider = createLocalProvider;
