/**
* fino:ai/model/local — optional llama.cpp adapter for local GGUF models.
*
* This module lets Fino applications use the same provider-neutral `Model`
* interface for local llama.cpp models that they use for remote providers.
* Local support is optional: `hasLlamaCpp` is computed once when the module is
* evaluated by probing the default libllama lookup paths, and importing the
* module never throws when libllama is absent.
*
* ## Design
*
* The adapter loads system `libllama` through `fino:ffi` and uses FFI
* `StructType` descriptors for llama.cpp's by-value parameter structs. Pass a
* local `.gguf` path, or pass an explicit Hugging Face repository and file.
* Hugging Face sources are downloaded into a cache before the model is opened.
*
* The built-in direct `libllama` path tokenizes prompts, decodes batches,
* samples tokens through llama.cpp sampler chains, detokenizes output pieces,
* and cleans up native resources. v1 intentionally rejects native tool calls,
* structured response formats, and embeddings because the local adapter does
* not yet have portable support for those capabilities.
*
* Library discovery honors the `LLAMA_CPP_LIBRARY` and `FINO_LLAMA_LIBRARY`
* environment variables first, then platform-conventional install locations
* (Homebrew and `/usr/local/lib` on macOS; `/usr/local/lib`, `/usr/lib`, and
* multiarch directories on Linux). When a companion `libggml` is found next to
* libllama or in the same conventional locations, its compute backends (BLAS,
* CPU variants) are registered too. All llama.cpp and ggml logging is
* silenced so model loading does not write to stderr.
*
* Streaming is emulated: `stream()` runs the full generation and yields the
* complete text as a single `text_delta` event, and reported token usage is
* always zero. Concurrent `generate()` and `stream()` calls on one model are
* serialized because they share a single llama.cpp context.
*
* ```ts no_run
* import { hasLlamaCpp, local } from 'fino:ai/model/local';
*
* if (hasLlamaCpp) {
*   const model = await local({
*     model: './models/tinyllama.Q4_K_M.gguf',
*     contextSize: 4096,
*     threads: 8,
*   });
*
*   const result = await model.generate({
*     messages: [{ role: 'user', content: 'Write one sentence about local AI.' }],
*   });
*   console.log(result.text);
* }
* ```
*/
import type { ContentPart, GenerateRequest, GenerateResult, Model, ModelCreateOptions, ModelInfo, ModelProvider, ModelStream, StreamEvent } from 'fino:ai/model';
import { dlopen, FfiCallback, Pointer, structType } from 'fino:ffi';
import { env, os } from 'fino:process';
import { DiskFileSystem } from 'fino:file';
import { dirname, join } from 'fino:file/path';
import { HttpClient } from 'fino:net/http/client';
import { encodeUtf8, decodeUtf8 } from 'internal:encoding';
import { ModelStreamImpl } from 'internal:ai/shared';
import type { ClientLike, ResponseLike } from 'internal:ai/shared';
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_CACHE_DIR = '.fino/models';
const DEFAULT_TEMPERATURE = .8;
const DEFAULT_TOP_K = 40;
const DEFAULT_TOP_P = .95;
const LLAMA_DEFAULT_SEED = 4294967295;
const POINTER_SIZE = 8;
const LlamaModelParams = structType([
  ['devices', 'pointer'],
  ['tensor_buft_overrides', 'pointer'],
  ['n_gpu_layers', 'i32'],
  ['split_mode', 'i32'],
  ['main_gpu', 'i32'],
  {
    name: '_pad0',
    type: 'bytes',
    size: 4
  },
  ['tensor_split', 'pointer'],
  ['progress_callback', 'pointer'],
  ['progress_callback_user_data', 'pointer'],
  ['kv_overrides', 'pointer'],
  ['vocab_only', 'bool'],
  ['use_mmap', 'bool'],
  ['use_direct_io', 'bool'],
  ['use_mlock', 'bool'],
  ['check_tensors', 'bool'],
  ['use_extra_bufts', 'bool'],
  ['no_host', 'bool'],
  ['no_alloc', 'bool']
], {
  size: 72,
  align: 8
});
const LlamaContextParams = structType([
  ['n_ctx', 'u32'],
  ['n_batch', 'u32'],
  ['n_ubatch', 'u32'],
  ['n_seq_max', 'u32'],
  ['n_threads', 'i32'],
  ['n_threads_batch', 'i32'],
  ['rope_scaling_type', 'i32'],
  ['pooling_type', 'i32'],
  ['attention_type', 'i32'],
  ['flash_attn_type', 'i32'],
  ['rope_freq_base', 'f32'],
  ['rope_freq_scale', 'f32'],
  ['yarn_ext_factor', 'f32'],
  ['yarn_attn_factor', 'f32'],
  ['yarn_beta_fast', 'f32'],
  ['yarn_beta_slow', 'f32'],
  ['yarn_orig_ctx', 'u32'],
  ['defrag_thold', 'f32'],
  ['cb_eval', 'pointer'],
  ['cb_eval_user_data', 'pointer'],
  ['type_k', 'i32'],
  ['type_v', 'i32'],
  ['abort_callback', 'pointer'],
  ['abort_callback_data', 'pointer'],
  ['embeddings', 'bool'],
  ['offload_kqv', 'bool'],
  ['no_perf', 'bool'],
  ['op_offload', 'bool'],
  ['swa_full', 'bool'],
  ['kv_unified', 'bool'],
  {
    name: '_pad2',
    type: 'bytes',
    size: 2
  },
  ['samplers', 'pointer'],
  ['n_samplers', 'usize']
], {
  size: 136,
  align: 8
});
const LlamaBatch = structType([
  ['n_tokens', 'i32'],
  {
    name: '_pad0',
    type: 'bytes',
    size: 4
  },
  ['token', 'pointer'],
  ['embd', 'pointer'],
  ['pos', 'pointer'],
  ['n_seq_id', 'pointer'],
  ['seq_id', 'pointer'],
  ['logits', 'pointer']
], {
  size: 56,
  align: 8
});
const LlamaSamplerChainParams = structType([['no_perf', 'bool']], {
  size: 1,
  align: 1
});
const LLAMA_SYMBOLS = {
  llama_backend_init: {
    parameters: [],
    result: 'void'
  },
  llama_log_set: {
    parameters: ['pointer', 'pointer'],
    result: 'void'
  },
  llama_model_default_params: {
    parameters: [],
    result: LlamaModelParams
  },
  llama_context_default_params: {
    parameters: [],
    result: LlamaContextParams
  },
  llama_sampler_chain_default_params: {
    parameters: [],
    result: LlamaSamplerChainParams
  },
  llama_model_load_from_file: {
    parameters: ['buffer', LlamaModelParams],
    result: 'pointer',
    async: true
  },
  llama_init_from_model: {
    parameters: ['pointer', LlamaContextParams],
    result: 'pointer',
    async: true
  },
  llama_free: {
    parameters: ['pointer'],
    result: 'void'
  },
  llama_model_free: {
    parameters: ['pointer'],
    result: 'void'
  },
  llama_model_get_vocab: {
    parameters: ['pointer'],
    result: 'pointer'
  },
  llama_n_batch: {
    parameters: ['pointer'],
    result: 'u32'
  },
  llama_batch_init: {
    parameters: [
      'i32',
      'i32',
      'i32'
    ],
    result: LlamaBatch
  },
  llama_batch_free: {
    parameters: [LlamaBatch],
    result: 'void'
  },
  llama_decode: {
    parameters: ['pointer', LlamaBatch],
    result: 'i32',
    async: true
  },
  llama_tokenize: {
    parameters: [
      'pointer',
      'buffer',
      'i32',
      'buffer',
      'i32',
      'bool',
      'bool'
    ],
    result: 'i32'
  },
  llama_token_to_piece: {
    parameters: [
      'pointer',
      'i32',
      'buffer',
      'i32',
      'i32',
      'bool'
    ],
    result: 'i32'
  },
  llama_vocab_is_eog: {
    parameters: ['pointer', 'i32'],
    result: 'bool'
  },
  llama_sampler_chain_init: {
    parameters: [LlamaSamplerChainParams],
    result: 'pointer'
  },
  llama_sampler_chain_add: {
    parameters: ['pointer', 'pointer'],
    result: 'void'
  },
  llama_sampler_init_top_k: {
    parameters: ['i32'],
    result: 'pointer'
  },
  llama_sampler_init_top_p: {
    parameters: ['f32', 'usize'],
    result: 'pointer'
  },
  llama_sampler_init_temp: {
    parameters: ['f32'],
    result: 'pointer'
  },
  llama_sampler_init_dist: {
    parameters: ['u32'],
    result: 'pointer'
  },
  llama_sampler_init_greedy: {
    parameters: [],
    result: 'pointer'
  },
  llama_sampler_sample: {
    parameters: [
      'pointer',
      'pointer',
      'i32'
    ],
    result: 'i32'
  },
  llama_sampler_accept: {
    parameters: ['pointer', 'i32'],
    result: 'void'
  },
  llama_sampler_free: {
    parameters: ['pointer'],
    result: 'void'
  }
};
const GGML_SYMBOLS = {
  ggml_backend_load: {
    parameters: ['buffer'],
    result: 'pointer'
  },
  ggml_backend_load_all: {
    parameters: [],
    result: 'void'
  },
  ggml_log_set: {
    parameters: ['pointer', 'pointer'],
    result: 'void'
  }
};
let silentLogCallback: ReturnType<typeof FfiCallback> | null = null;
/**
* Source accepted by the local llama.cpp adapter.
*
* A plain string or the `{ path }` form names a GGUF file on disk. The
* `{ repo, file, revision }` form names an explicit GGUF file in a Hugging
* Face repository, downloaded into the cache directory on first use
* (`revision` defaults to `main`). Every form must end in `.gguf` — the
* adapter refuses to guess quantizations or resolve non-GGUF artifacts and
* throws for anything else.
*/
export type LocalModelSource = string | {
  path: string;
} | {
  repo: string;
  file: string;
  revision?: string;
};
/**
* Internal binding shape used by tests and by the direct FFI wrapper.
*
* Application code normally does not provide bindings directly. Use
* `libraryPath` to point at a system `libllama`. A bindings object owns the
* whole native lifecycle: `open` produces an opaque handle, `generate` runs
* one prompt to completion against that handle, and `close` releases it.
*
* ```ts no_run
* import { local, type LocalLlamaBindings } from 'fino:ai/model/local';
*
* const fake: LocalLlamaBindings = {
*   async open(path, options) { return { path, options }; },
*   async generate(handle, prompt, options) { return `echo: ${prompt}`; },
*   close(handle) {},
* };
* const model = await local({ model: '/tmp/model.gguf', bindings: fake });
* ```
*
* @internal
*/
export interface LocalLlamaBindings {
  /**
  * Load the GGUF file at `path` and resolve with an opaque handle for
  * subsequent `generate` and `close` calls.
  */
  open(path: string, options: LocalOpenOptions): Promise<unknown>;
  /**
  * Run one full generation for `prompt` against an open handle, resolving
  * with the output text (stop sequences already applied).
  */
  generate(handle: unknown, prompt: string, options: LocalGenerateOptions): Promise<string>;
  /**
  * Release every native resource held by `handle`.
  */
  close(handle: unknown): void;
}
/**
* Options passed to libllama when opening a model.
*
* `local()` fills every field from `LocalModelOptions` before calling
* `LocalLlamaBindings.open`, so bindings always receive concrete values.
*
* ```ts no_run
* import type { LocalOpenOptions } from 'fino:ai/model/local';
*
* const options: LocalOpenOptions = { contextSize: 4096, threads: 0, batchSize: 512, gpuLayers: 0 };
* ```
*
* @internal
*/
export interface LocalOpenOptions {
  /**
  * Token window of the llama.cpp context.
  */
  contextSize: number;
  /**
  * CPU worker thread count; `0` lets libllama choose.
  */
  threads: number;
  /**
  * Maximum tokens submitted per decode batch.
  */
  batchSize: number;
  /**
  * Number of transformer layers offloaded to the GPU.
  */
  gpuLayers: number;
}
/**
* Options passed to libllama when generating text.
*
* Sampling fields left `undefined` fall back to the adapter defaults
* (temperature 0.8, top-k 40, top-p 0.95) inside the binding.
*
* ```ts no_run
* import type { LocalGenerateOptions } from 'fino:ai/model/local';
*
* const options: LocalGenerateOptions = { maxTokens: 64, temperature: 0, stopSequences: ['\n'] };
* ```
*
* @internal
*/
export interface LocalGenerateOptions {
  /**
  * Hard cap on the number of generated tokens.
  */
  maxTokens: number;
  /**
  * Sampling temperature; values of `0` or below select greedy sampling.
  */
  temperature?: number;
  /**
  * Nucleus sampling threshold; applied only when strictly between 0 and 1.
  */
  topP?: number;
  /**
  * Top-k cutoff; applied only when positive.
  */
  topK?: number;
  /**
  * Sequences that end generation; output is trimmed at the first match.
  */
  stopSequences: string[];
}
/**
* Options for creating a local llama.cpp-backed model.
*
* Inherited `ModelCreateOptions` fields act as generation defaults: requests
* that omit `maxTokens` or `temperature` fall back to the values given here,
* then to the module defaults (512 tokens, temperature 0.8).
*
* ```ts no_run
* import { local } from 'fino:ai/model/local';
*
* const model = await local({
*   model: {
*     repo: 'bartowski/SmolLM2-135M-Instruct-GGUF',
*     file: 'SmolLM2-135M-Instruct-Q2_K.gguf',
*   },
*   cacheDir: '/tmp/fino-models',
*   contextSize: 2048,
*   threads: 4,
*   maxTokens: 64,
*   temperature: 0,
*   stopSequences: ['\n'],
* });
* ```
*/
export interface LocalModelOptions extends ModelCreateOptions {
  /**
  * Stable id exposed on the constructed `Model`.
  *
  * Defaults to the local path or Hugging Face file identity. Providers use
  * this to preserve configured ids from `ModelInfo`.
  */
  id?: string;
  /**
  * Local GGUF path or explicit Hugging Face GGUF file.
  */
  model: LocalModelSource;
  /**
  * Explicit path to a system `libllama`.
  *
  * When omitted, the module-level default libllama discovery is used.
  */
  libraryPath?: string;
  /**
  * Cache directory for Hugging Face downloads. Defaults to `.fino/models`.
  */
  cacheDir?: string;
  /**
  * Hugging Face token for private repositories. Defaults to the `HF_TOKEN`
  * environment variable.
  */
  hfToken?: string;
  /**
  * llama.cpp context size. Defaults to 4096 tokens.
  */
  contextSize?: number;
  /**
  * CPU worker thread count. Defaults to 0, which lets libllama choose.
  */
  threads?: number;
  /**
  * Prompt batch size. Defaults to 512.
  */
  batchSize?: number;
  /**
  * Number of layers to place on GPU. Defaults to 0.
  */
  gpuLayers?: number;
  /**
  * Sampling nucleus. Defaults to 0.95; values outside the exclusive (0, 1)
  * range disable the top-p stage.
  */
  topP?: number;
  /**
  * Sampling top-k. Defaults to 40; values of 0 or below disable the top-k
  * stage.
  */
  topK?: number;
  /**
  * Default stop sequences for requests that do not supply their own.
  *
  * Generation ends at the first match and the matched sequence is trimmed
  * from the returned text.
  */
  stopSequences?: string[];
  /**
  * HTTP client used for Hugging Face downloads.
  *
  * This is primarily useful for tests and custom network policy.
  */
  client?: ClientLike;
  /**
  * Direct bindings used by tests and embedders that provide their own
  * wrapper.
  *
  * @internal
  */
  bindings?: LocalLlamaBindings;
}
/**
* Configured model entry exposed by `localProvider()`.
*
* Entries are static configuration: `listModels()` reports each one as a
* `ModelInfo` row, and the model's GGUF source is only resolved and opened
* when the entry is instantiated through `createModel()` or
* `ModelInfo.create()`.
*
* ```ts no_run
* import type { LocalModelProviderEntry } from 'fino:ai/model/local';
*
* const entry: LocalModelProviderEntry = {
*   id: 'smol',
*   model: { repo: 'bartowski/SmolLM2-135M-Instruct-GGUF', file: 'SmolLM2-135M-Instruct-Q2_K.gguf' },
*   displayName: 'SmolLM2 135M',
* };
* ```
*/
export interface LocalModelProviderEntry {
  /**
  * Stable identifier used by `listModels()` and `createModel()`, and
  * preserved as the constructed model's `id`.
  */
  id: string;
  /**
  * GGUF source opened when the entry is instantiated.
  */
  model: LocalModelSource;
  /**
  * Human-readable name surfaced on the listed `ModelInfo`.
  */
  displayName?: string;
  /**
  * Extra `ModelInfo` metadata. Defaults to `{ source: model }` when omitted.
  */
  metadata?: Record<string, unknown>;
}
/**
* Options for a local provider.
*
* Everything except `models` is shared `LocalModelOptions` configuration —
* library path, cache directory, sampling defaults, and so on — applied to
* every model the provider creates. Per-call `ModelCreateOptions` passed to
* `createModel()` layer on top of these shared options.
*
* ```ts no_run
* import { localProvider } from 'fino:ai/model/local';
*
* const provider = localProvider({
*   cacheDir: '/tmp/fino-models',
*   contextSize: 2048,
*   models: [{ id: 'tiny', model: '/models/tiny.Q4_K_M.gguf' }],
* });
* ```
*/
export interface LocalProviderOptions extends Omit<LocalModelOptions, 'model'> {
  /**
  * Models returned by `listModels()`.
  */
  models?: LocalModelProviderEntry[];
}
/**
* Error thrown when libllama cannot be loaded.
*
* `local()` throws this when an explicit `libraryPath` fails to open, or when
* no `libraryPath` is given and default discovery found no libllama (that is,
* `hasLlamaCpp` is `false`).
*
* ```ts no_run
* import { local, LocalModelLibraryError } from 'fino:ai/model/local';
*
* try {
*   await local({ model: '/tmp/model.gguf', libraryPath: '/opt/llama/lib/libllama.so' });
* } catch (err) {
*   if (err instanceof LocalModelLibraryError) {
*     console.error(`libllama unavailable at ${err.libraryPath}`);
*   }
* }
* ```
*/
export class LocalModelLibraryError extends Error {
  /**
  * The explicit library path that failed to load, when one was provided.
  * Absent when default discovery found no candidate at all.
  */
  libraryPath?: string;
  /**
  * Create the error, optionally recording the library path that failed.
  */
  constructor(message: string, opts: {
    libraryPath?: string;
  } = {}) {
    super(message);
    this.name = 'LocalModelLibraryError';
    this.libraryPath = opts.libraryPath;
  }
}
/**
* Error thrown for model request features that the local adapter does not
* support.
*
* Raised for tool definitions or any explicit `toolChoice`, native
* `responseFormat` requests, non-text content parts (images, documents), and
* `embed()` calls. Catch it to fall back to a remote provider for requests
* that need those capabilities.
*
* ```ts no_run
* import { local, LocalModelUnsupportedError } from 'fino:ai/model/local';
*
* const model = await local({ model: './models/tiny.Q4_K_M.gguf' });
* try {
*   await model.generate({
*     messages: [{ role: 'user', content: 'What is the weather?' }],
*     tools: [{ name: 'weather', description: 'Look up weather', parameters: {} }],
*   });
* } catch (err) {
*   if (err instanceof LocalModelUnsupportedError) {
*     // route this request to a remote model instead
*   }
* }
* ```
*/
export class LocalModelUnsupportedError extends Error {
  /**
  * Create the error with a description of the unsupported capability.
  */
  constructor(message: string) {
    super(message);
    this.name = 'LocalModelUnsupportedError';
  }
}
class FfiLlamaBindings implements LocalLlamaBindings {
  #lib: ReturnType<typeof dlopen>;
  #ggml: ReturnType<typeof dlopen> | null = null;
  #libraryPath: string;
  #backendInitialized = false;
  constructor(lib: ReturnType<typeof dlopen>, libraryPath: string) {
    this.#lib = lib;
    this.#libraryPath = libraryPath;
  }
  async open(path: string, options: LocalOpenOptions): Promise<ArrayBuffer> {
    this.#initBackend();
    const modelParams = this.#lib.symbols.llama_model_default_params() as ArrayBuffer;
    LlamaModelParams.set(modelParams, 'n_gpu_layers', options.gpuLayers);
    const contextParams = this.#lib.symbols.llama_context_default_params() as ArrayBuffer;
    LlamaContextParams.set(contextParams, 'n_ctx', options.contextSize);
    LlamaContextParams.set(contextParams, 'n_batch', options.batchSize);
    LlamaContextParams.set(contextParams, 'n_threads', options.threads);
    LlamaContextParams.set(contextParams, 'n_threads_batch', options.threads);
    const model = await this.#lib.symbols.llama_model_load_from_file(cstring(path), modelParams) as ArrayBuffer | null;
    if (model === null) throw new Error('llama.cpp model open failed');
    const ctx = await this.#lib.symbols.llama_init_from_model(model, contextParams) as ArrayBuffer | null;
    if (ctx === null) {
      this.#lib.symbols.llama_model_free(model);
      throw new Error('llama.cpp context creation failed');
    }
    return packHandles(model, ctx);
  }
  async generate(handle: unknown, prompt: string, options: LocalGenerateOptions): Promise<string> {
    const { model, ctx } = unpackHandles(handle as ArrayBuffer);
    const vocab = this.#lib.symbols.llama_model_get_vocab(model) as ArrayBuffer | null;
    if (vocab === null) throw new Error('llama.cpp model has no vocabulary');
    const promptTokens = this.#tokenize(vocab, prompt, true, true);
    if (promptTokens.length === 0) return '';
    const sampler = this.#createSampler(options);
    let promptBatch: ArrayBuffer | null = null;
    let tokenBatch: ArrayBuffer | null = null;
    try {
      const nBatch = Math.max(1, Number(this.#lib.symbols.llama_n_batch(ctx)) || 1);
      for (let offset = 0; offset < promptTokens.length; offset += nBatch) {
        const chunk = promptTokens.slice(offset, offset + nBatch);
        promptBatch = this.#makeBatch(chunk, offset, offset + chunk.length >= promptTokens.length);
        const promptRc = Number(await this.#lib.symbols.llama_decode(ctx, promptBatch));
        this.#lib.symbols.llama_batch_free(promptBatch);
        promptBatch = null;
        if (promptRc < 0) throw new Error(`llama.cpp prompt decode failed with code ${promptRc}`);
      }
      const pieces: string[] = [];
      let pos = promptTokens.length;
      let next = Number(this.#lib.symbols.llama_sampler_sample(sampler, ctx, -1));
      for (let i = 0; i < options.maxTokens; i++) {
        if (this.#isEog(vocab, next)) break;
        const piece = this.#tokenToPiece(vocab, next);
        pieces.push(piece);
        const text = pieces.join('');
        if (options.stopSequences.some((stop) => stop !== '' && text.includes(stop))) break;
        this.#lib.symbols.llama_sampler_accept(sampler, next);
        tokenBatch = this.#makeBatch([next], pos, true);
        const rc = Number(await this.#lib.symbols.llama_decode(ctx, tokenBatch));
        this.#lib.symbols.llama_batch_free(tokenBatch);
        tokenBatch = null;
        if (rc < 0) throw new Error(`llama.cpp decode failed with code ${rc}`);
        pos++;
        next = Number(this.#lib.symbols.llama_sampler_sample(sampler, ctx, -1));
      }
      return trimAtStop(pieces.join(''), options.stopSequences);
    } finally {
      if (tokenBatch !== null) this.#lib.symbols.llama_batch_free(tokenBatch);
      if (promptBatch !== null) this.#lib.symbols.llama_batch_free(promptBatch);
      this.#lib.symbols.llama_sampler_free(sampler);
    }
  }
  close(handle: unknown): void {
    const { model, ctx } = unpackHandles(handle as ArrayBuffer);
    this.#lib.symbols.llama_free(ctx);
    this.#lib.symbols.llama_model_free(model);
  }
  #initBackend(): void {
    if (this.#backendInitialized) return;
    installLlamaLogSilencer(this.#lib);
    this.#ggml = tryOpenGgml(this.#libraryPath);
    if (this.#ggml !== null) {
      installGgmlLogSilencer(this.#ggml);
      if (!loadPreferredGgmlBackends(this.#ggml, this.#libraryPath)) {
        this.#ggml.symbols.ggml_backend_load_all();
      }
    }
    this.#lib.symbols.llama_backend_init();
    this.#backendInitialized = true;
  }
  #tokenize(vocab: ArrayBuffer, text: string, addSpecial: boolean, parseSpecial: boolean): number[] {
    const bytes = encodeUtf8(text);
    let capacity = Math.max(8, bytes.byteLength + 8);
    for (;;) {
      const tokenBytes = new Uint8Array(capacity * 4);
      const rc = Number(this.#lib.symbols.llama_tokenize(vocab, bytes, bytes.byteLength, tokenBytes, capacity, addSpecial, parseSpecial));
      if (rc >= 0) return readI32Array(tokenBytes, rc);
      capacity = Math.max(capacity * 2, -rc);
    }
  }
  #tokenToPiece(vocab: ArrayBuffer, token: number): string {
    let capacity = 32;
    for (;;) {
      const out = new Uint8Array(capacity);
      const rc = Number(this.#lib.symbols.llama_token_to_piece(vocab, token, out, capacity, 0, true));
      if (rc >= 0) return decodeUtf8(out.subarray(0, rc));
      capacity = Math.max(capacity * 2, -rc);
    }
  }
  #isEog(vocab: ArrayBuffer, token: number): boolean {
    return Boolean(this.#lib.symbols.llama_vocab_is_eog(vocab, token));
  }
  #createSampler(options: LocalGenerateOptions): ArrayBuffer {
    const params = this.#lib.symbols.llama_sampler_chain_default_params() as ArrayBuffer;
    const chain = this.#lib.symbols.llama_sampler_chain_init(params) as ArrayBuffer | null;
    if (chain === null) throw new Error('llama.cpp sampler creation failed');
    const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    if (temperature <= 0) {
      this.#lib.symbols.llama_sampler_chain_add(chain, this.#lib.symbols.llama_sampler_init_greedy());
      return chain;
    }
    const topK = options.topK ?? DEFAULT_TOP_K;
    if (topK > 0) {
      this.#lib.symbols.llama_sampler_chain_add(chain, this.#lib.symbols.llama_sampler_init_top_k(topK));
    }
    const topP = options.topP ?? DEFAULT_TOP_P;
    if (topP > 0 && topP < 1) {
      this.#lib.symbols.llama_sampler_chain_add(chain, this.#lib.symbols.llama_sampler_init_top_p(topP, 1));
    }
    this.#lib.symbols.llama_sampler_chain_add(chain, this.#lib.symbols.llama_sampler_init_temp(temperature));
    this.#lib.symbols.llama_sampler_chain_add(chain, this.#lib.symbols.llama_sampler_init_dist(LLAMA_DEFAULT_SEED));
    return chain;
  }
  #makeBatch(tokens: number[], startPos: number, logitsLast: boolean): ArrayBuffer {
    const batch = this.#lib.symbols.llama_batch_init(tokens.length, 0, 1) as ArrayBuffer;
    LlamaBatch.set(batch, 'n_tokens', tokens.length);
    const tokenPtr = LlamaBatch.get(batch, 'token') as ArrayBuffer;
    const posPtr = LlamaBatch.get(batch, 'pos') as ArrayBuffer;
    const nSeqIdPtr = LlamaBatch.get(batch, 'n_seq_id') as ArrayBuffer;
    const seqIdPtr = LlamaBatch.get(batch, 'seq_id') as ArrayBuffer;
    const logitsPtr = LlamaBatch.get(batch, 'logits') as ArrayBuffer;
    for (let i = 0; i < tokens.length; i++) {
      Pointer.writeI32(tokenPtr, i * 4, tokens[i]);
      Pointer.writeI32(posPtr, i * 4, startPos + i);
      Pointer.writeI32(nSeqIdPtr, i * 4, 1);
      const seqSlot = Pointer.readPointer(seqIdPtr, i * POINTER_SIZE) as ArrayBuffer;
      Pointer.writeI32(seqSlot, 0, 0);
      Pointer.writeU8(logitsPtr, i, logitsLast && i === tokens.length - 1 ? 1 : 0);
    }
    return batch;
  }
}
function cstring(value: string): Uint8Array {
  const bytes = encodeUtf8(value);
  const out = new Uint8Array(bytes.byteLength + 1);
  out.set(bytes);
  return out;
}
function readI32Array(bytes: Uint8Array, count: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(view.getInt32(i * 4, true));
  return out;
}
function trimAtStop(text: string, stopSequences: string[]): string {
  let end = text.length;
  for (const stop of stopSequences) {
    if (stop === '') continue;
    const idx = text.indexOf(stop);
    if (idx >= 0 && idx < end) end = idx;
  }
  return end === text.length ? text : text.slice(0, end);
}
function packHandles(model: ArrayBuffer, ctx: ArrayBuffer): ArrayBuffer {
  const out = new ArrayBuffer(16);
  const outPtr = Pointer.of(out);
  Pointer.writePointer(outPtr, 0, model);
  Pointer.writePointer(outPtr, 8, ctx);
  return out;
}
function unpackHandles(handle: ArrayBuffer): {
  model: ArrayBuffer;
  ctx: ArrayBuffer;
} {
  const ptr = Pointer.of(handle);
  return {
    model: Pointer.readPointer(ptr, 0) as ArrayBuffer,
    ctx: Pointer.readPointer(ptr, 8) as ArrayBuffer
  };
}
function getSilentLogCallback(): ReturnType<typeof FfiCallback> {
  silentLogCallback ??= new FfiCallback({
    parameters: [
      'i32',
      'pointer',
      'pointer'
    ],
    result: 'void'
  }, () => {});
  return silentLogCallback;
}
function installLlamaLogSilencer(lib: ReturnType<typeof dlopen>): void {
  lib.symbols.llama_log_set(getSilentLogCallback().pointer, Pointer.null());
}
function installGgmlLogSilencer(ggml: ReturnType<typeof dlopen>): void {
  ggml.symbols.ggml_log_set(getSilentLogCallback().pointer, Pointer.null());
}
function candidateLibraryPaths(): string[] {
  const paths: string[] = [];
  if (env.LLAMA_CPP_LIBRARY) paths.push(env.LLAMA_CPP_LIBRARY);
  if (env.FINO_LLAMA_LIBRARY) paths.push(env.FINO_LLAMA_LIBRARY);
  if (os === 'darwin') {
    paths.push('libllama.dylib', '/opt/homebrew/lib/libllama.dylib', '/usr/local/lib/libllama.dylib');
  } else if (os === 'linux') {
    paths.push('libllama.so', '/usr/local/lib/libllama.so', '/usr/lib/libllama.so', '/usr/lib/x86_64-linux-gnu/libllama.so', '/usr/lib/aarch64-linux-gnu/libllama.so');
  } else {
    paths.push('llama.dll');
  }
  return [...new Set(paths)];
}
function candidateGgmlPaths(llamaPath: string): string[] {
  const paths: string[] = [];
  const slash = llamaPath.lastIndexOf('/');
  if (slash >= 0) paths.push(`${llamaPath.slice(0, slash)}/libggml.dylib`, `${llamaPath.slice(0, slash)}/libggml.so`);
  if (os === 'darwin') {
    paths.push('libggml.dylib', '/opt/homebrew/lib/libggml.dylib', '/usr/local/lib/libggml.dylib');
  } else if (os === 'linux') {
    paths.push('libggml.so', '/usr/local/lib/libggml.so', '/usr/lib/libggml.so', '/usr/lib/x86_64-linux-gnu/libggml.so', '/usr/lib/aarch64-linux-gnu/libggml.so');
  }
  return [...new Set(paths)];
}
function candidateGgmlBackendPaths(llamaPath: string): string[] {
  const paths: string[] = [];
  const slash = llamaPath.lastIndexOf('/');
  if (slash >= 0 && os !== 'darwin') {
    const dir = llamaPath.slice(0, slash);
    paths.push(`${dir}/libggml-cpu.so`);
  }
  if (os === 'darwin') {
    if (!llamaPath.startsWith('/usr/local/')) {
      paths.push('/opt/homebrew/opt/ggml/libexec/libggml-blas.so', '/opt/homebrew/opt/ggml/libexec/libggml-cpu-apple_m4.so', '/opt/homebrew/opt/ggml/libexec/libggml-cpu-apple_m2_m3.so', '/opt/homebrew/opt/ggml/libexec/libggml-cpu-apple_m1.so');
    }
    if (!llamaPath.startsWith('/opt/homebrew/')) {
      paths.push('/usr/local/opt/ggml/libexec/libggml-blas.so', '/usr/local/opt/ggml/libexec/libggml-cpu-apple_m4.so', '/usr/local/opt/ggml/libexec/libggml-cpu-apple_m2_m3.so', '/usr/local/opt/ggml/libexec/libggml-cpu-apple_m1.so');
    }
  } else if (os === 'linux') {
    paths.push('libggml-cpu.so', '/usr/local/lib/libggml-cpu.so', '/usr/lib/libggml-cpu.so', '/usr/lib/x86_64-linux-gnu/libggml-cpu.so', '/usr/lib/aarch64-linux-gnu/libggml-cpu.so');
  }
  return [...new Set(paths)];
}
function loadPreferredGgmlBackends(ggml: ReturnType<typeof dlopen>, llamaPath: string): boolean {
  let loaded = false;
  for (const path of candidateGgmlBackendPaths(llamaPath)) {
    try {
      const reg = ggml.symbols.ggml_backend_load(cstring(path)) as ArrayBuffer | null;
      if (reg !== null) loaded = true;
    } catch {}
  }
  return loaded;
}
function tryOpenGgml(llamaPath: string): ReturnType<typeof dlopen> | null {
  for (const path of candidateGgmlPaths(llamaPath)) {
    try {
      return dlopen(path, GGML_SYMBOLS);
    } catch {}
  }
  return null;
}
function tryOpenBindings(path: string): LocalLlamaBindings | null {
  try {
    return new FfiLlamaBindings(dlopen(path, LLAMA_SYMBOLS), path);
  } catch {
    return null;
  }
}
function resolveDefaultBindings(): LocalLlamaBindings | null {
  for (const path of candidateLibraryPaths()) {
    const bindings = tryOpenBindings(path);
    if (bindings) return bindings;
  }
  return null;
}
const defaultBindings = resolveDefaultBindings();
/**
* Whether the default libllama was found during module evaluation.
*
* This boolean only reflects the default lookup paths. Passing
* `libraryPath` to `local()` can still succeed when this is `false`.
*/
export const hasLlamaCpp = defaultBindings !== null;
function requireBindings(opts: LocalModelOptions): LocalLlamaBindings {
  if (opts.bindings) return opts.bindings;
  if (opts.libraryPath) {
    const explicit = tryOpenBindings(opts.libraryPath);
    if (explicit) return explicit;
    throw new LocalModelLibraryError(`Unable to load libllama at ${opts.libraryPath}`, { libraryPath: opts.libraryPath });
  }
  if (defaultBindings) return defaultBindings;
  throw new LocalModelLibraryError('llama.cpp support is not available. Check hasLlamaCpp or pass libraryPath to a system libllama.');
}
function sourceId(source: LocalModelSource): string {
  if (typeof source === 'string') return source;
  if ('path' in source) return source.path;
  return `${source.repo}/${source.file}`;
}
function assertGguf(file: string): void {
  if (!file.toLowerCase().endsWith('.gguf')) {
    throw new Error(`Local llama.cpp models must be explicit GGUF files; got "${file}"`);
  }
}
async function pathExists(fs: DiskFileSystem, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}
async function mkdirp(fs: DiskFileSystem, path: string): Promise<void> {
  if (path === '.' || path === '/' || await pathExists(fs, path)) return;
  await mkdirp(fs, dirname(path).toString());
  try {
    await fs.mkdir(path);
  } catch {
    if (!await pathExists(fs, path)) throw new Error(`Unable to create directory ${path}`);
  }
}
async function resolveModelPath(opts: LocalModelOptions): Promise<string> {
  const source = opts.model;
  if (typeof source === 'string') {
    assertGguf(source);
    return source;
  }
  if ('path' in source) {
    assertGguf(source.path);
    return source.path;
  }
  assertGguf(source.file);
  const fs = new DiskFileSystem();
  const revision = source.revision ?? 'main';
  const cachePath = join(opts.cacheDir ?? DEFAULT_CACHE_DIR, source.repo.replace(/\//g, '__'), revision, source.file).toString();
  if (await pathExists(fs, cachePath)) return cachePath;
  await mkdirp(fs, dirname(cachePath).toString());
  const url = `https://huggingface.co/${source.repo}/resolve/${revision}/${source.file}`;
  const token = opts.hfToken ?? env.HF_TOKEN;
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const client = opts.client ?? (new HttpClient() as unknown) as ClientLike;
  const res = await client.request(url, {
    method: 'GET',
    headers
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Hugging Face download failed ${res.status}: ${await res.text()}`);
  }
  await fs.writeFile(cachePath, await responseBytes(res));
  return cachePath;
}
async function responseBytes(res: ResponseLike): Promise<Uint8Array> {
  if (res.body) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
  return encodeUtf8(await res.text());
}
function contentText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return part.text;
    if (part.type === 'tool_result') return typeof part.content === 'string' ? part.content : contentText(part.content);
    throw new LocalModelUnsupportedError(`Local llama.cpp models only support text content parts; got ${part.type}`);
  }).join('');
}
function renderPrompt(req: GenerateRequest): string {
  const lines: string[] = [];
  if (req.system != null) {
    const sys = typeof req.system === 'string' ? req.system : req.system.map((p) => p.text).join('');
    if (sys) lines.push(`System: ${sys}`);
  }
  for (const message of req.messages) {
    const role = message.role[0].toUpperCase() + message.role.slice(1);
    lines.push(`${role}: ${contentText(message.content)}`);
  }
  lines.push('Assistant:');
  return lines.join('\n');
}
function assertSupported(req: GenerateRequest): void {
  if (req.tools?.length || req.toolChoice != null) {
    throw new LocalModelUnsupportedError('Local llama.cpp models do not support tool calling yet.');
  }
  if (req.responseFormat != null) {
    throw new LocalModelUnsupportedError('Local llama.cpp models do not support native response formats yet.');
  }
}
class LocalLlamaModel implements Model {
  readonly id: string;
  readonly name: string;
  readonly provider = 'local';
  readonly capabilities = {
    streaming: true,
    toolCalling: false,
    toolChoice: {
      auto: false,
      any: false,
      none: true,
      named: false
    },
    structuredOutput: {
      jsonSchema: false,
      strictJsonSchema: false,
      native: false
    },
    input: {
      text: true,
      image: false,
      document: false
    },
    sampling: {
      temperature: true,
      topP: true,
      seed: false,
      stopSequences: true
    },
    local: true
  };
  readonly dimensions = 0;
  #bindings: LocalLlamaBindings;
  #handle: unknown;
  #defaults: Required<Pick<LocalModelOptions, 'maxTokens' | 'contextSize' | 'threads' | 'batchSize' | 'gpuLayers'>> & {
    temperature?: number;
    topP?: number;
    topK?: number;
    stopSequences: string[];
  };
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  constructor(id: string, bindings: LocalLlamaBindings, handle: unknown, opts: LocalModelOptions) {
    this.id = id;
    this.name = id;
    this.#bindings = bindings;
    this.#handle = handle;
    this.#defaults = {
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      contextSize: opts.contextSize ?? 4096,
      threads: opts.threads ?? 0,
      batchSize: opts.batchSize ?? 512,
      gpuLayers: opts.gpuLayers ?? 0,
      ...opts.temperature != null ? { temperature: opts.temperature } : {},
      ...opts.topP != null ? { topP: opts.topP } : {},
      ...opts.topK != null ? { topK: opts.topK } : {},
      stopSequences: opts.stopSequences ?? []
    };
  }
  stream(req: GenerateRequest): ModelStream {
    const self = this;
    async function* gen(): AsyncGenerator<StreamEvent> {
      const text = await self.#generateText(req);
      if (text) yield {
        type: 'text_delta',
        index: 0,
        text
      };
      yield {
        type: 'usage',
        usage: {
          inputTokens: 0,
          outputTokens: 0
        }
      };
      yield {
        type: 'stop',
        reason: 'end_turn'
      };
    }
    return new ModelStreamImpl(gen());
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.stream(req).result();
  }
  async embed(_texts: string[]): Promise<Float32Array[]> {
    throw new LocalModelUnsupportedError('Local llama.cpp embeddings are not supported yet.');
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#bindings.close(this.#handle);
  }
  async #generateText(req: GenerateRequest): Promise<string> {
    if (this.#closed) throw new Error(`Local model "${this.id}" is closed`);
    assertSupported(req);
    const prompt = renderPrompt(req);
    const options: LocalGenerateOptions = {
      maxTokens: req.maxTokens ?? this.#defaults.maxTokens,
      temperature: req.temperature ?? this.#defaults.temperature,
      topP: req.topP ?? this.#defaults.topP,
      topK: this.#defaults.topK,
      stopSequences: req.stopSequences ?? this.#defaults.stopSequences
    };
    const run = this.#queue.then(() => this.#bindings.generate(this.#handle, prompt, options));
    this.#queue = run.catch(() => undefined);
    return await run;
  }
}
/**
* Create a llama.cpp-backed local model.
*
* Construction resolves the model source, downloads Hugging Face GGUF files
* into the cache when necessary, loads the optional libllama, and opens the
* model. Requests fall back to the option defaults given here, then to the
* module defaults (512 max tokens, temperature 0.8, top-k 40, top-p 0.95); a
* temperature of `0` or below switches to deterministic greedy sampling.
* Concurrent `generate()` and `stream()` calls are serialized on the single
* llama.cpp context. Close long-lived models with `model.close?.()` when your
* application is done with them.
*
* Throws `LocalModelLibraryError` when libllama cannot be loaded, and a plain
* `Error` when the source is not a `.gguf` file, a Hugging Face download
* fails, or the model itself fails to open.
*
* ```ts no_run
* import { local } from 'fino:ai/model/local';
*
* const model = await local({
*   model: {
*     repo: 'bartowski/SmolLM2-135M-Instruct-GGUF',
*     file: 'SmolLM2-135M-Instruct-Q2_K.gguf',
*   },
*   contextSize: 2048,
*   maxTokens: 64,
* });
*
* for await (const event of model.stream({
*   messages: [{ role: 'user', content: 'Tell me a joke.' }],
* })) {
*   if (event.type === 'text_delta') console.log(event.text);
* }
* ```
*/
export async function local(opts: LocalModelOptions): Promise<Model> {
  const bindings = requireBindings(opts);
  const path = await resolveModelPath(opts);
  const handle = await bindings.open(path, {
    contextSize: opts.contextSize ?? 4096,
    threads: opts.threads ?? 0,
    batchSize: opts.batchSize ?? 512,
    gpuLayers: opts.gpuLayers ?? 0
  });
  return new LocalLlamaModel(opts.id ?? sourceId(opts.model), bindings, handle, opts);
}
class LocalModelProvider implements ModelProvider {
  readonly provider = 'local';
  #opts: LocalProviderOptions;
  constructor(opts: LocalProviderOptions = {}) {
    this.#opts = opts;
  }
  async listModels(_opts: {
    signal?: AbortSignal;
  } = {}): Promise<ModelInfo[]> {
    return (this.#opts.models ?? []).map((entry) => ({
      id: entry.id,
      provider: this.provider,
      ...entry.displayName ? { displayName: entry.displayName } : {},
      capabilities: {
        streaming: true,
        toolCalling: false,
        toolChoice: {
          auto: false,
          any: false,
          none: true,
          named: false
        },
        structuredOutput: {
          jsonSchema: false,
          strictJsonSchema: false,
          native: false
        },
        input: {
          text: true,
          image: false,
          document: false
        },
        sampling: {
          temperature: true,
          topP: true,
          seed: false,
          stopSequences: true
        },
        local: true
      },
      metadata: entry.metadata ?? { source: entry.model },
      create: (opts?: ModelCreateOptions) => this.createModel(entry.id, opts)
    }));
  }
  createModel(id: string, opts: ModelCreateOptions = {}): Promise<Model> {
    const entry = (this.#opts.models ?? []).find((model) => model.id === id);
    if (!entry) throw new Error(`Local model "${id}" is not configured`);
    return local({
      ...this.#opts,
      ...opts,
      id,
      model: entry.model
    });
  }
}
/**
* Create a local provider for configured GGUF models.
*
* `listModels()` returns the static `models` entries supplied here. It does not
* scan local directories or query Hugging Face. `createModel(id)` — or the
* `create()` callback on a listed `ModelInfo` — opens the entry's GGUF source
* through `local()` with the provider's shared options, and throws when `id`
* was not configured.
*
* ```ts no_run
* import { localProvider } from 'fino:ai/model/local';
*
* const provider = localProvider({
*   cacheDir: '/tmp/fino-models',
*   models: [
*     {
*       id: 'smol',
*       model: {
*         repo: 'bartowski/SmolLM2-135M-Instruct-GGUF',
*         file: 'SmolLM2-135M-Instruct-Q2_K.gguf',
*       },
*       displayName: 'SmolLM2 135M',
*     },
*   ],
* });
*
* const [info] = await provider.listModels();
* const model = await info.create({ maxTokens: 128 });
* ```
*/
export function localProvider(opts: LocalProviderOptions = {}): ModelProvider {
  return new LocalModelProvider(opts);
}
