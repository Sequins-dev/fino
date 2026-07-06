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
* `GenerateResult` shape returned by `Model.generate()`. Embeddings use the
* separate `EmbeddingModel` contract so chat-only providers and tests do not
* need fake embedding methods.
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
import { assembleResult as sharedAssembleResult, ModelError as SharedModelError, ModelListingUnsupportedError as SharedModelListingUnsupportedError } from 'internal:ai/shared';
import { anthropic as anthropicFactory, anthropicProvider as createAnthropicProvider } from 'internal:ai/model/anthropic';
import { openai as openaiFactory, openaiProvider as createOpenAIProvider } from 'internal:ai/model/openai';
import { hasLlamaCpp as localHasLlamaCpp, local as localFactory, localProvider as createLocalProvider, LocalModelLibraryError as SharedLocalModelLibraryError, LocalModelUnsupportedError as SharedLocalModelUnsupportedError } from 'internal:ai/model/local';
import type { ReadonlySignal } from 'fino:signals';
/**
* Chat message role understood by all providers.
*
* `user` and `assistant` carry the conversation turns. A `system` message
* placed in `GenerateRequest.messages` is routed to the provider's native
* system-prompt channel and takes precedence over `GenerateRequest.system`.
*/
export type Role = 'user' | 'assistant' | 'system';
/**
* Text content part.
*
* The most common part; a plain-string message body is shorthand for a single
* text part. Use the part form when a message mixes text with images,
* documents, or tool traffic, or when a span of text should be a prompt-cache
* breakpoint.
*
* ```ts no_run
* import type { ModelMessage } from 'fino:ai/model';
*
* const message: ModelMessage = {
*   role: 'user',
*   content: [
*     { type: 'text', text: manualText, cache: true },
*     { type: 'text', text: 'Which chapter covers installation?' },
*   ],
* };
* ```
*/
export interface TextPart {
  /** Part discriminant. */
  type: 'text';
  /** The text carried by this part. */
  text: string;
  /**
  * Marks this part as a provider prompt-cache breakpoint.
  *
  * The Anthropic adapter maps it to `cache_control: { type: 'ephemeral' }`.
  * Providers without explicit breakpoints ignore the flag; cache hits still
  * surface through `Usage.cacheReadInputTokens` when reported.
  */
  cache?: true;
}
/**
* Inline image content part.
*
* `data` is base64-encoded bytes without a data URI prefix. Send images only
* to models whose `capabilities.input.image` is true; providers reject or
* silently drop modalities they do not accept.
*
* ```ts no_run
* import type { ModelMessage } from 'fino:ai/model';
*
* const message: ModelMessage = {
*   role: 'user',
*   content: [
*     { type: 'image', mediaType: 'image/png', data: screenshotBase64 },
*     { type: 'text', text: 'What error does this screenshot show?' },
*   ],
* };
* ```
*/
export interface ImagePart {
  /** Part discriminant. */
  type: 'image';
  /** MIME type of the encoded bytes, such as `image/png` or `image/jpeg`. */
  mediaType: string;
  /** Base64-encoded image bytes without a `data:` URI prefix. */
  data: string;
}
/**
* Model-requested tool call content part.
*
* Appears in assistant messages when replaying conversation history that
* included tool calls: echo the model's request back as a `tool_use` part,
* then answer it with a matching `tool_result` part in the following user
* message.
*
* ```ts no_run
* import type { ModelMessage } from 'fino:ai/model';
*
* const history: ModelMessage[] = [
*   { role: 'user', content: 'What is the weather in Lisbon?' },
*   {
*     role: 'assistant',
*     content: [{ type: 'tool_use', id: 'call_1', name: 'weather', args: { city: 'Lisbon' } }],
*   },
*   {
*     role: 'user',
*     content: [{ type: 'tool_result', toolCallId: 'call_1', content: '19C and sunny' }],
*   },
* ];
* ```
*/
export interface ToolUsePart {
  /** Part discriminant. */
  type: 'tool_use';
  /** Provider-assigned call id, answered via `ToolResultPart.toolCallId`. */
  id: string;
  /** Name of the tool from the request's `ToolDefinition` list. */
  name: string;
  /** Parsed tool arguments produced by the model. */
  args: unknown;
}
/**
* Tool result content part sent back to the model.
*
* Sent in a `user` message after the assistant requested a tool call. Set
* `isError` when the tool run failed so the model can recover instead of
* treating the output as a successful result.
*
* ```ts no_run
* import type { ModelMessage } from 'fino:ai/model';
*
* const reply: ModelMessage = {
*   role: 'user',
*   content: [{
*     type: 'tool_result',
*     toolCallId: call.id,
*     content: JSON.stringify(rows),
*   }],
* };
* ```
*/
export interface ToolResultPart {
  /** Part discriminant. */
  type: 'tool_result';
  /** Id of the `ToolUsePart` (or `ToolCall`) this result answers. */
  toolCallId: string;
  /** Tool output as plain text, or as parts when the result includes media. */
  content: string | ContentPart[];
  /** Marks the result as a tool failure rather than a successful output. */
  isError?: boolean;
}
/**
* Inline document content part.
*
* `data` is base64-encoded bytes without a data URI prefix. Providers may map
* this to files, documents, or other native document upload fields. Send
* documents only to models whose `capabilities.input.document` is true.
*
* ```ts no_run
* import type { ModelMessage } from 'fino:ai/model';
*
* const message: ModelMessage = {
*   role: 'user',
*   content: [
*     { type: 'document', mediaType: 'application/pdf', data: contractBase64, name: 'contract.pdf' },
*     { type: 'text', text: 'List the termination clauses.' },
*   ],
* };
* ```
*/
export interface DocumentPart {
  /** Part discriminant. */
  type: 'document';
  /** MIME type of the encoded bytes, such as `application/pdf`. */
  mediaType: string;
  /** Base64-encoded document bytes without a `data:` URI prefix. */
  data: string;
  /** Display filename hint passed to providers that accept one. */
  name?: string;
}
/**
* Content part accepted in a model message.
*
* Message content is either a plain string or an ordered list of these parts;
* the string form is shorthand for a single `TextPart`.
*/
export type ContentPart = TextPart | ImagePart | ToolUsePart | ToolResultPart | DocumentPart;
/**
* Native structured response format request.
*
* Adapters translate this to the provider's native structured-output
* transport: `response_format` on OpenAI-compatible APIs and `output_config`
* on Anthropic. Check `capabilities.structuredOutput.native` before relying on
* it; higher layers fall back to prompt-based JSON extraction for models
* without native support.
*
* ```ts no_run
* const result = await model.generate({
*   messages: [{ role: 'user', content: 'Extract the invoice fields.' }],
*   responseFormat: {
*     type: 'json_schema',
*     name: 'invoice',
*     schema: {
*       type: 'object',
*       properties: { total: { type: 'number' }, currency: { type: 'string' } },
*       required: ['total', 'currency'],
*     },
*   },
* });
* const invoice = JSON.parse(result.text);
* ```
*/
export interface ResponseFormat {
  /** Format discriminant; only JSON Schema output is defined. */
  type: 'json_schema';
  /** Schema name sent to the provider. Defaults to `response`. */
  name?: string;
  /** JSON Schema object the model output must conform to. */
  schema: Record<string, unknown>;
  /**
  * Request strict provider-side schema enforcement.
  *
  * The OpenAI adapter defaults this to `true`; the Anthropic adapter passes
  * it through only when set.
  */
  strict?: boolean;
}
/**
* Provider-neutral chat message.
*
* `content` is either plain text or an ordered list of content parts for
* multimodal and tool-carrying turns.
*
* ```ts no_run
* import type { ModelMessage } from 'fino:ai/model';
*
* const messages: ModelMessage[] = [
*   { role: 'user', content: 'Summarize the release notes.' },
*   { role: 'assistant', content: 'The release adds SSE routes and fixes two loader bugs.' },
*   { role: 'user', content: 'Shorter, one sentence.' },
* ];
* ```
*/
export interface ModelMessage {
  /** Who produced the message. */
  role: Role;
  /** Plain text, or content parts for multimodal and tool traffic. */
  content: string | ContentPart[];
}
/**
* Provider-neutral tool definition sent with model requests.
*
* This is the wire shape adapters transmit; higher-level tool registration and
* dispatch live in `fino:ai/tool`. `parameters` is a JSON Schema object
* describing the tool's arguments.
*
* ```ts no_run
* import type { ToolDefinition } from 'fino:ai/model';
*
* const weather: ToolDefinition = {
*   name: 'weather',
*   description: 'Look up current weather for a city.',
*   parameters: {
*     type: 'object',
*     properties: { city: { type: 'string' } },
*     required: ['city'],
*   },
* };
* ```
*/
export interface ToolDefinition {
  /** Tool name the model uses in `tool_use` parts and tool-call events. */
  name: string;
  /** Natural-language description that tells the model when to call it. */
  description: string;
  /** JSON Schema object describing the tool's arguments. */
  parameters: Record<string, unknown>;
}
/**
* Provider-neutral generation request.
*
* The same request shape is accepted by `Model.generate()` and
* `Model.stream()`. Sampling fields set here override any defaults configured
* on the model at construction time.
*
* ```ts no_run
* const controller = new AbortController();
* const result = await model.generate({
*   system: 'You are a terse release-notes editor.',
*   messages: [{ role: 'user', content: draft }],
*   maxTokens: 512,
*   temperature: 0,
*   signal: controller.signal,
* });
* ```
*/
export interface GenerateRequest {
  /** Conversation turns, oldest first. */
  messages: ModelMessage[];
  /**
  * System prompt for the request.
  *
  * The `TextPart[]` form allows prompt-cache breakpoints via `cache: true`.
  * Ignored when a `system`-role message already appears in `messages`.
  */
  system?: string | TextPart[];
  /** Tool definitions offered to the model for this request. */
  tools?: ToolDefinition[];
  /**
  * How the model may use the offered tools.
  *
  * `auto` lets the model decide, `any` requires some tool call, `none`
  * forbids tool calls, and `{ name }` forces one specific tool. Consult
  * `capabilities.toolChoice` for which modes a model honors.
  */
  toolChoice?: 'auto' | 'any' | 'none' | {
    name: string;
  };
  /** Maximum output tokens; overrides the model's configured default. */
  maxTokens?: number;
  /** Sampling temperature; overrides the model's configured default. */
  temperature?: number;
  /** Nucleus sampling cutoff; overrides the model's configured default. */
  topP?: number;
  /** Sampling seed for providers that support reproducible output. */
  seed?: number;
  /** Sequences that end generation with `stopReason: 'stop_sequence'`. */
  stopSequences?: string[];
  /** Native structured-output request. */
  responseFormat?: ResponseFormat;
  /**
  * Raw request-body extras keyed by provider name.
  *
  * The entry matching the model's provider (for example
  * `{ anthropic: { thinking: { type: 'enabled' } } }`) is object-merged into
  * the outgoing request body; other keys are ignored.
  */
  providerOptions?: Record<string, unknown>;
  /** Aborts the underlying HTTP request and stream when signaled. */
  signal?: AbortSignal;
}
/**
* Token usage reported by a provider.
*
* The `cache*` fields describe the provider's native prompt cache; the
* `localCache*` fields describe requests answered by a local Fino response
* cache (`fino:ai/cache`) without touching the provider at all. Optional
* fields are present only when the provider or cache reported them.
*
* ```ts no_run
* const result = await model.generate({ messages });
* const { inputTokens, outputTokens, cacheReadInputTokens = 0 } = result.usage;
* recordCost(inputTokens - cacheReadInputTokens, cacheReadInputTokens, outputTokens);
* ```
*/
export interface Usage {
  /** Provider-billed input tokens for the request. */
  inputTokens: number;
  /** Provider-billed output tokens for the request. */
  outputTokens: number;
  /** Provider-native cache-read input tokens, when reported by the provider. */
  cacheReadInputTokens?: number;
  /** Provider-native cache-creation input tokens, when reported by the provider. */
  cacheCreationInputTokens?: number;
  /** Input tokens avoided by a local Fino cache hit. */
  localCacheReadInputTokens?: number;
  /** Output tokens avoided by a local Fino cache hit. */
  localCacheReadOutputTokens?: number;
}
/**
* Reason a model stopped generating.
*
* `end_turn` is a normal completion. `tool_use` means the model is waiting on
* tool results. `max_tokens` and `stop_sequence` indicate the output was cut
* by a limit from the request. `error`, `refusal`, and `content_filter` are
* abnormal terminations surfaced by the provider.
*/
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error' | 'refusal' | 'content_filter';
/**
* Assembled tool call returned by `generate()` or `ModelStream.result()`.
*
* This is the folded form of the incremental `tool_call_start` /
* `tool_call_delta` / `tool_call_end` stream events, with `args` already
* JSON-parsed. Answer each call with a `tool_result` part and continue the
* conversation.
*
* ```ts no_run
* const result = await model.generate({ messages, tools });
* if (result.stopReason === 'tool_use') {
*   for (const call of result.toolCalls) {
*     const output = await dispatch(call.name, call.args);
*     messages.push(
*       { role: 'assistant', content: [{ type: 'tool_use', ...call }] },
*       { role: 'user', content: [{ type: 'tool_result', toolCallId: call.id, content: output }] },
*     );
*   }
* }
* ```
*/
export interface ToolCall {
  /** Provider-assigned call id, echoed back via `ToolResultPart.toolCallId`. */
  id: string;
  /** Name of the requested tool. */
  name: string;
  /**
  * Parsed tool arguments.
  *
  * Falls back to `{}` when the streamed argument JSON was empty or failed to
  * parse.
  */
  args: unknown;
}
/**
* Complete non-streamed model result.
*
* Returned by `Model.generate()` and produced by folding a stream through
* `ModelStream.result()` or `assembleResult()` — all three paths yield this
* same shape.
*
* ```ts no_run
* const result = await model.generate({ messages, maxTokens: 256 });
* if (result.stopReason === 'max_tokens') {
*   console.warn('Output truncated after', result.usage.outputTokens, 'tokens');
* }
* console.log(result.text);
* ```
*/
export interface GenerateResult {
  /** Generated text, concatenated across content blocks in index order. */
  text: string;
  /** Tool calls requested by the model, empty when there were none. */
  toolCalls: ToolCall[];
  /** Token usage for the request. */
  usage: Usage;
  /** Why generation stopped. */
  stopReason: StopReason;
  /** Non-fatal provider notes about how the request was handled. */
  warnings?: string[];
  /**
  * Raw provider response data keyed by provider name, such as
  * `{ anthropic: rawResponse }`. Set by non-streamed generation paths that
  * have the full provider response in hand.
  */
  providerMetadata?: Record<string, unknown>;
}
/**
* Current retained view of a model stream.
*
* This is a lossy read model for UIs and progress meters. Use the stream
* itself when every provider event must be processed. The state advances only
* as events are pulled from the stream, so something must be consuming it.
*
* ```ts no_run
* const stream = model.stream({ messages });
* const unsubscribe = stream.state.subscribe(({ text }) => render(text));
* const result = await stream.result();
* unsubscribe();
* ```
*/
export interface ModelStreamState {
  /** Text folded from `text_delta` events, ordered by content index. */
  text: string;
  /** Latest usage values reported by the provider. */
  usage: Usage;
  /** Latest stop reason, or `end_turn` before a stop event arrives. */
  stopReason: StopReason;
}
/**
* Feature metadata exposed by chat model adapters.
*
* Capabilities are semantic flags, not provider names. Agent code uses these
* fields to decide whether to request tools, native JSON Schema output,
* multimodal input, and optional sampling controls. Every field is optional;
* an absent field means the adapter made no claim, so treat it as unknown
* rather than unsupported.
*
* ```ts no_run
* const nativeJson = model.capabilities?.structuredOutput?.native === true;
* const result = await model.generate({
*   messages,
*   ...(nativeJson ? { responseFormat: { type: 'json_schema', schema } } : {}),
* });
* ```
*/
export interface ModelCapabilities {
  /** Whether the adapter implements incremental streaming. */
  streaming?: boolean;
  /** Whether the model can call tools at all. */
  toolCalling?: boolean;
  /** Which `GenerateRequest.toolChoice` modes the model honors. */
  toolChoice?: {
    auto?: boolean;
    any?: boolean;
    none?: boolean;
    named?: boolean;
  };
  /**
  * Structured-output support: whether JSON Schema requests are accepted at
  * all (`jsonSchema`), whether strict enforcement is available
  * (`strictJsonSchema`), and whether a native transport carries the schema
  * (`native`).
  */
  structuredOutput?: {
    jsonSchema?: boolean;
    strictJsonSchema?: boolean;
    native?: boolean;
  };
  /** Input modalities the model accepts. */
  input?: {
    text?: boolean;
    image?: boolean;
    document?: boolean;
  };
  /** Which sampling controls from `GenerateRequest` take effect. */
  sampling?: {
    temperature?: boolean;
    topP?: boolean;
    seed?: boolean;
    stopSequences?: boolean;
  };
  /** True when inference runs in-process without network access. */
  local?: boolean;
}
/**
* Feature metadata exposed by embedding model adapters.
*
* ```ts no_run
* const batchSize = embedder.capabilities?.maxBatchSize ?? 64;
* for (const batch of chunk(texts, batchSize)) {
*   vectors.push(...await embedder.embed(batch));
* }
* ```
*/
export interface EmbeddingCapabilities {
  /** Width of the vectors returned by `embed()`. */
  dimensions?: number;
  /** Maximum number of texts accepted per `embed()` call. */
  maxBatchSize?: number;
  /** Maximum tokens per input text. */
  maxInputTokens?: number;
}
/**
* Streaming event emitted by provider adapters.
*
* `text_delta` carries an `index` so parallel content blocks concatenate in
* the right order. Tool calls arrive as a `tool_call_start` naming the tool,
* `tool_call_delta` events carrying argument-JSON fragments, and a
* `tool_call_end`. `usage` may be emitted more than once; the latest values
* win. `stop` reports the stop reason, and `error` signals an abnormal
* termination — `assembleResult()` converts it into a thrown `Error`.
*
* ```ts no_run
* for await (const event of model.stream({ messages })) {
*   if (event.type === 'text_delta') write(event.text);
*   else if (event.type === 'stop') console.log('done:', event.reason);
* }
* ```
*/
export type StreamEvent = {
  type: 'text_delta';
  index: number;
  text: string;
} | {
  type: 'tool_call_start';
  index: number;
  id: string;
  name: string;
} | {
  type: 'tool_call_delta';
  index: number;
  json: string;
} | {
  type: 'tool_call_end';
  index: number;
} | {
  type: 'usage';
  usage: Usage;
} | {
  type: 'stop';
  reason: StopReason;
} | {
  type: 'error';
  message: string;
};
/**
* Async stream of model events.
*
* Iterate it to process every provider event, or call `result()` to drain the
* remaining events and receive the folded `GenerateResult`. The `state` signal
* is a retained, lossy view for UIs; it only advances while events are being
* pulled.
*
* ```ts no_run
* const stream = model.stream({ messages });
* for await (const event of stream) {
*   if (event.type === 'text_delta') write(event.text);
* }
* const { toolCalls, usage } = await stream.result();
* ```
*/
export interface ModelStream extends AsyncIterable<StreamEvent> {
  /** Retained state folded from events observed so far. */
  readonly state: ReadonlySignal<ModelStreamState>;
  /**
  * Drain the remaining events and fold them into a `GenerateResult`.
  *
  * Rejects when the provider emits an `error` event or the request fails.
  */
  result(): Promise<GenerateResult>;
}
/**
* Provider-neutral chat model adapter.
*
* This is the contract agents and evals consume; `anthropic()`, `openai()`,
* and `local()` all return implementations of it. Provider HTTP failures
* surface as `ModelError`.
*
* ```ts no_run
* import { anthropic } from 'fino:ai/model';
*
* const model = anthropic();
* const result = await model.generate({
*   messages: [{ role: 'user', content: 'Name three prime numbers.' }],
*   maxTokens: 128,
* });
* console.log(result.text);
* ```
*/
export interface ChatModel {
  /**
  * Stable model identifier used for provider requests and telemetry.
  *
  * Provider implementations set this explicitly. `name` remains available as
  * a compatibility alias for local test doubles and older call sites.
  */
  readonly id?: string;
  /** Model name; historically the same value as `id`. */
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
  */
  readonly capabilities?: ModelCapabilities;
  /**
  * Start a streaming generation.
  *
  * This is the canonical execution path; adapters implement streaming first
  * and derive `generate()` from it.
  */
  stream(req: GenerateRequest): ModelStream;
  /**
  * Run a generation to completion and return the folded result.
  *
  * Equivalent to `stream(req).result()`.
  */
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
/**
* Provider-neutral embedding model adapter.
*
* Kept separate from `ChatModel` so chat-only providers and test doubles do
* not need fake embedding methods. Memory and semantic-eval APIs accept this
* narrower contract.
*
* ```ts no_run
* import type { EmbeddingModel } from 'fino:ai/model';
*
* async function indexChunks(embedder: EmbeddingModel, chunks: string[]) {
*   const vectors = await embedder.embed(chunks);
*   for (let i = 0; i < chunks.length; i++) {
*     await store.put(chunks[i], vectors[i]);
*   }
* }
* ```
*/
export interface EmbeddingModel {
  /** Stable embedding model identifier. */
  readonly id: string;
  /** Model name; historically the same value as `id`. */
  readonly name: string;
  /** Provider identifier such as `openai`. */
  readonly provider: string;
  /** Optional embedding feature metadata. */
  readonly capabilities?: EmbeddingCapabilities;
  /** Width of the vectors returned by `embed()`. */
  readonly dimensions: number;
  /**
  * Embed a batch of texts into vectors, one per input in the same order.
  */
  embed(texts: string[]): Promise<Float32Array[]>;
}
/**
* Provider-neutral model adapter used by chat and agent APIs.
*
* Providers may also implement `EmbeddingModel`; memory and semantic eval APIs
* depend on that narrower embedding contract instead of requiring every chat
* model to expose embeddings.
*/
export type Model = ChatModel;
/**
* Options applied when constructing a `Model` from a provider or registry.
*
* These become per-model defaults: each `GenerateRequest` can still override
* the sampling values for an individual call.
*
* ```ts no_run
* const model = await registry.create('gpt-4o-mini', {
*   maxTokens: 1024,
*   temperature: 0,
* });
* ```
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
  /** Default nucleus sampling cutoff for the constructed model. */
  topP?: number;
  /** Default sampling seed for providers that support reproducible output. */
  seed?: number;
  /**
  * Default raw request-body extras keyed by provider name, merged into every
  * request unless a request supplies its own `providerOptions`.
  */
  providerOptions?: Record<string, unknown>;
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
*
* ```ts no_run
* const models = await registry.list({ provider: 'anthropic' });
* const info = models.find((m) => m.capabilities?.toolCalling);
* if (!info) throw new Error('No tool-calling model available');
* const model = await info.create({ temperature: 0.2 });
* ```
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
  * Model construction is always async so remote and local providers share one
  * call shape. Remote providers usually resolve immediately, while local
  * providers may need filesystem or cache work.
  */
  create(opts?: ModelCreateOptions): Promise<Model>;
}
/**
* Provider that can discover available model ids and construct `Model`
* adapters for those ids.
*
* Providers are usually consumed through a `ModelRegistry`, but they can be
* used directly when only one provider is in play.
*
* ```ts no_run
* import { anthropicProvider } from 'fino:ai/model';
*
* const provider = anthropicProvider();
* const [info] = await provider.listModels();
* const model = await provider.createModel(info.id, { maxTokens: 2048 });
* ```
*/
export interface ModelProvider {
  /**
  * Stable provider name used in `ModelInfo.provider` and registry filters.
  */
  readonly provider: string;
  /**
  * Fetch available models from the provider endpoint.
  *
  * Throws `ModelListingUnsupportedError` when the endpoint has no model
  * discovery, and `ModelError` for other HTTP failures.
  */
  listModels(opts?: {
    signal?: AbortSignal;
  }): Promise<ModelInfo[]>;
  /**
  * Construct a model by provider model id.
  */
  createModel(id: string, opts?: ModelCreateOptions): Promise<Model>;
}
/**
* Common provider options accepted by bundled providers.
*
* All fields are optional: API keys fall back to environment variables and
* `baseUrl` defaults to the provider's public endpoint. Point `baseUrl` at
* any compatible server — the OpenAI adapter works against OpenAI-compatible
* endpoints such as vLLM or llama-server.
*
* ```ts no_run
* import { openai } from 'fino:ai/model';
*
* const model = openai({
*   baseUrl: 'http://localhost:8000/v1',
*   apiKey: 'local',
*   model: 'llama-3.1-8b-instruct',
*   maxTokens: 2048,
* });
* ```
*/
export interface ProviderOptions {
  /**
  * Provider API key.
  *
  * Falls back to the provider's environment variable (`ANTHROPIC_API_KEY` or
  * `OPENAI_API_KEY`); factories throw when neither is available.
  */
  apiKey?: string;
  /** Endpoint base URL. Defaults to the provider's public API. */
  baseUrl?: string;
  /** Extra headers sent with every provider request. */
  headers?: Record<string, string>;
  /**
  * Custom HTTP client used instead of the built-in one.
  *
  * Primarily for tests and custom network policy; the shape matches the
  * built-in `HttpClient.request()`.
  */
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
  /**
  * Model id for the single-model factories.
  *
  * `anthropic()` defaults to `claude-opus-4-8` and `openai()` defaults to
  * `gpt-4o`. Ignored by the provider factories, which take ids per call.
  */
  model?: string;
  /** Default maximum output tokens for requests to the model. */
  maxTokens?: number;
  /** Default sampling temperature for requests to the model. */
  temperature?: number;
  /** Default nucleus sampling cutoff for requests to the model. */
  topP?: number;
  /** Default sampling seed for providers that support reproducible output. */
  seed?: number;
  /** Default raw request-body extras keyed by provider name. */
  providerOptions?: Record<string, unknown>;
  /** Embedding vector dimensions for providers that support embeddings. */
  dimensions?: number;
}
/**
* Option and source types for the local llama.cpp adapter, re-exported so
* `local()` and `localProvider()` callers can type their configuration without
* importing internal modules.
*/
export type { LocalModelOptions, LocalProviderOptions, LocalModelSource, LocalModelProviderEntry } from 'internal:ai/model/local';
/**
* Registry for discovering and constructing provider-neutral models.
*
* A registry aggregates several `ModelProvider` instances behind one lookup
* surface so application code can list, find, and construct models without
* caring which provider serves them. `listModels()` results are cached per
* provider instance; pass `refresh: true` to bypass the cache for a call.
*
* ```ts no_run
* import { anthropicProvider, modelRegistry, openaiProvider } from 'fino:ai/model';
*
* const registry = modelRegistry([openaiProvider(), anthropicProvider()]);
* for (const info of await registry.list()) {
*   console.log(info.provider, info.id);
* }
* const model = await registry.create('claude-opus-4-8', { temperature: 0.2 });
* ```
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
  *
  * Any cached listing for the same provider instance is discarded so the
  * next `list()` fetches fresh results from it.
  */
  add(provider: ModelProvider): this {
    this.#providers.push(provider);
    this.#cache.delete(provider);
    return this;
  }
  /**
  * List discovered models across all providers or one provider.
  *
  * Results are served from the per-provider cache unless `refresh` is set or
  * a provider has not been listed yet. Throws when `provider` names a
  * provider that is not registered.
  */
  async list(opts: {
    provider?: string;
    refresh?: boolean;
    signal?: AbortSignal;
  } = {}): Promise<ModelInfo[]> {
    const providers = this.#matchingProviders(opts.provider);
    const out: ModelInfo[] = [];
    for (const provider of providers) {
      if (opts.refresh || !this.#cache.has(provider)) {
        this.#cache.set(provider, await provider.listModels({ signal: opts.signal }));
      }
      out.push(...this.#cache.get(provider) ?? []);
    }
    return out;
  }
  /**
  * Find a model by id, or return `null` when no provider reports it.
  *
  * Throws when more than one provider reports the same id; pass `provider`
  * to disambiguate.
  */
  async get(id: string, opts: {
    provider?: string;
    refresh?: boolean;
  } = {}): Promise<ModelInfo | null> {
    const matches = (await this.list(opts)).filter((model) => model.id === id);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new Error(`Model id "${id}" is ambiguous; pass provider to choose one.`);
    }
    return matches[0]!;
  }
  /**
  * Construct a `Model` by discovered id.
  *
  * Looks the id up with `get()` and forwards the remaining options to
  * `ModelInfo.create()`. Throws when the id is unknown or ambiguous across
  * providers.
  */
  async create(id: string, opts: ModelCreateOptions & {
    provider?: string;
    refresh?: boolean;
  } = {}): Promise<Model> {
    const { provider, refresh, ...createOpts } = opts;
    const info = await this.get(id, {
      provider,
      refresh
    });
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
*
* Convenience wrapper around `new ModelRegistry(providers)`.
*
* ```ts no_run
* import { modelRegistry, openaiProvider } from 'fino:ai/model';
*
* const registry = modelRegistry([openaiProvider()]);
* const model = await registry.create('gpt-4o-mini');
* ```
*/
export function modelRegistry(providers: ModelProvider[] = []): ModelRegistry {
  return new ModelRegistry(providers);
}
/**
* Assemble streamed provider events into a complete `GenerateResult`.
*
* Text deltas are concatenated per content index and joined in index order,
* tool-call argument fragments are JSON-parsed (falling back to `{}` when the
* JSON is empty or malformed), and the latest `usage` and `stop` values win.
* Throws when the stream emits an `error` event. `ModelStream.result()` uses
* this internally, so calling it directly is only needed for bare event
* iterables such as recorded or transformed streams.
*
* ```ts no_run
* import { assembleResult } from 'fino:ai/model';
*
* const result = await assembleResult(recordedEvents());
* console.log(result.text, result.stopReason);
* ```
*/
export function assembleResult(events: AsyncIterable<StreamEvent>): Promise<GenerateResult> {
  return sharedAssembleResult(events);
}
/**
* Error thrown for provider HTTP failures.
*
* Carries the HTTP `status`, the raw response `body` when available, and
* `retryAfterMs` parsed from a `Retry-After` header — useful for backoff on
* 429 and 5xx responses.
*
* ```ts no_run
* import { ModelError } from 'fino:ai/model';
*
* try {
*   await model.generate({ messages });
* } catch (err) {
*   if (err instanceof ModelError && err.status === 429) {
*     await delay(err.retryAfterMs ?? 1000);
*   } else {
*     throw err;
*   }
* }
* ```
*/
export const ModelError = SharedModelError;
/**
* Error thrown when a provider endpoint does not support model listing.
*
* Raised by `ModelProvider.listModels()` when the models endpoint responds
* with 404 — common for OpenAI-compatible servers that implement chat but not
* discovery. Carries the `provider` name, HTTP `status`, and response `body`.
*/
export const ModelListingUnsupportedError = SharedModelListingUnsupportedError;
/**
* Create an Anthropic-backed `Model`.
*
* `apiKey` defaults to `ANTHROPIC_API_KEY` (throws when neither is set),
* `baseUrl` defaults to the public Anthropic API, and `model` defaults to
* `claude-opus-4-8`.
*
* ```ts no_run
* import { anthropic } from 'fino:ai/model';
*
* const model = anthropic({ model: 'claude-opus-4-8', maxTokens: 4096 });
* const result = await model.generate({
*   messages: [{ role: 'user', content: 'Explain kqueue in two sentences.' }],
* });
* ```
*/
export function anthropic(opts: ProviderOptions = {}): Model {
  return anthropicFactory(opts);
}
/**
* Create an Anthropic provider that can list and construct models.
*
* `apiKey` defaults to `ANTHROPIC_API_KEY`. `listModels()` calls
* `GET /v1/models` on `baseUrl` and infers capabilities per model id.
*
* ```ts no_run
* import { anthropicProvider } from 'fino:ai/model';
*
* const provider = anthropicProvider();
* const models = await provider.listModels();
* const model = await provider.createModel(models[0].id);
* ```
*/
export function anthropicProvider(opts: ProviderOptions = {}): ModelProvider {
  return createAnthropicProvider(opts);
}
/**
* Create an OpenAI-backed `Model`.
*
* `apiKey` defaults to `OPENAI_API_KEY` (throws when neither is set),
* `baseUrl` defaults to the public OpenAI API, and `model` defaults to
* `gpt-4o`. Point `baseUrl` at any OpenAI-compatible server such as vLLM or
* llama-server. The returned model also implements `EmbeddingModel` backed by
* the OpenAI embeddings endpoint.
*
* ```ts no_run
* import { openai } from 'fino:ai/model';
*
* const model = openai({ model: 'gpt-4o-mini' });
* const stream = model.stream({
*   messages: [{ role: 'user', content: 'Stream a limerick about io_uring.' }],
* });
* for await (const event of stream) {
*   if (event.type === 'text_delta') write(event.text);
* }
* ```
*/
export function openai(opts: ProviderOptions = {}): Model {
  return openaiFactory(opts);
}
/**
* Create an OpenAI-compatible provider that can list and construct models.
*
* `apiKey` defaults to `OPENAI_API_KEY`. `listModels()` calls `GET /models`
* on `baseUrl`; servers without a models endpoint make it throw
* `ModelListingUnsupportedError`.
*
* ```ts no_run
* import { openaiProvider } from 'fino:ai/model';
*
* const provider = openaiProvider({ baseUrl: 'http://localhost:8000/v1', apiKey: 'local' });
* const models = await provider.listModels();
* const model = await provider.createModel(models[0].id);
* ```
*/
export function openaiProvider(opts: ProviderOptions = {}): ModelProvider {
  return createOpenAIProvider(opts);
}
/**
* Whether a default system `libllama` was found when this module was evaluated.
*
* This is a capability gate for optional local model support. It reflects only
* default lookup paths such as `LLAMA_CPP_LIBRARY` and `FINO_LLAMA_LIBRARY`;
* callers can still pass an explicit `libraryPath` to `local()`.
*
* ```ts no_run
* import { anthropic, hasLlamaCpp, local } from 'fino:ai/model';
*
* const model = hasLlamaCpp
*   ? await local({ model: './models/qwen2.5-0.5b-instruct-q4_k_m.gguf' })
*   : anthropic();
* ```
*/
export const hasLlamaCpp = localHasLlamaCpp;
/**
* Error thrown when local llama.cpp support is requested but no usable
* `libllama` library is available.
*
* Carries the `libraryPath` that failed to load, when one was given. Check
* `hasLlamaCpp` first to avoid the throw on default lookup paths.
*/
export const LocalModelLibraryError = SharedLocalModelLibraryError;
/**
* Error thrown for local model request features that the llama.cpp adapter does
* not implement.
*
* Currently raised for requests that use `tools`, `toolChoice`, or
* `responseFormat`, and for `embed()` calls on local models.
*/
export const LocalModelUnsupportedError = SharedLocalModelUnsupportedError;
/**
* Create a local llama.cpp-backed `Model`.
*
* The model source can be a local GGUF path or an explicit Hugging Face GGUF
* file. Construction is async because Hugging Face sources may need to be
* downloaded into the local cache before llama.cpp opens them. Throws
* `LocalModelLibraryError` when no usable `libllama` can be loaded. Close
* long-lived models with `model.close?.()` to release the llama.cpp handle.
*
* ```ts no_run
* import { local } from 'fino:ai/model';
*
* const model = await local({
*   model: { repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf' },
*   contextSize: 8192,
*   gpuLayers: 99,
* });
* const result = await model.generate({
*   messages: [{ role: 'user', content: 'Write a haiku about rivers.' }],
* });
* ```
*/
export const local = localFactory;
/**
* Create a local provider for configured GGUF models.
*
* Local providers do not discover remote model catalogs. `listModels()` returns
* the configured entries so registries can present local and remote models
* through one interface.
*
* ```ts no_run
* import { localProvider, modelRegistry } from 'fino:ai/model';
*
* const registry = modelRegistry([
*   localProvider({
*     models: [
*       { id: 'qwen-0.5b', model: './models/qwen2.5-0.5b-instruct-q4_k_m.gguf' },
*     ],
*   }),
* ]);
* const model = await registry.create('qwen-0.5b');
* ```
*/
export const localProvider = createLocalProvider;
