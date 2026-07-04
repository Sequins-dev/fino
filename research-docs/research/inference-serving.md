# Fino Inference Serving

> Status: research and direction-setting document.
>
> Parent: [typescript-model-factory.md](./typescript-model-factory.md) — the
> model-factory strategy. Siblings: [tensor-engine.md](./tensor-engine.md),
> [data-stack.md](./data-stack.md), [model-artifacts.md](./model-artifacts.md),
> [ml-workbench.md](./ml-workbench.md), [classical-ml.md](./classical-ml.md).
>
> Scope: the serving layer — request scheduling, continuous batching,
> KV-cache management, streaming APIs, and the HTTP surface. Execution is not
> this document's job: the tensor engine runs inference the same way it runs
> training (forward-only eager dispatch under `noGrad`, and capture/replay is
> at its best on shape-stable decode steps), and the llama.cpp adapter runs
> it today. This document covers everything between "a model that can run a
> forward pass" and "a production token service."

## 1. Thesis

In Python, serving is a second system bolted next to the training framework:
vLLM/TGI own the scheduler, run in their own processes, and talk to the
application over HTTP. Fino can collapse that: the serving loop, the app, the
agent stack, and the training substrate share one process, one event loop,
and one type system. Every fino-native property applies directly — async
iterables for token streams, HTTP/1-2-3 already in-process, realm capability
narrowing around untrusted prompts, OTel tracing from HTTP edge to kernel
launch.

The parity target is vLLM/TGI-class behavior — continuous batching, paged
KV, streaming — not their scale ceiling (multi-node disaggregated serving is
out of scope). The serving core is deliberately execution-agnostic: it is a
scheduler over a narrow model interface, exactly as the engine is TypeScript
over a narrow backend interface.

## 2. Execution Providers

One interface, implemented three ways. Sketch of the contract the scheduler
drives (prefill and decode are batch-level, iteration-granular):

```ts
interface InferenceModel {
  readonly caps: { ownsKvCache: boolean; embeddings: boolean; logits: boolean };
  prefill(seqs: SeqInput[]): Promise<StepResult>;   // new sequences join here
  decodeStep(seqIds: number[]): Promise<StepResult>; // one token per live seq
  release(seqId: number): void;                      // frees KV immediately
  embed?(batch: Batch): Promise<Tensor>;             // encoder path
}
```

- **llama.cpp (now).** The C API is already multi-sequence: `llama_batch`
  carries per-token sequence ids, so continuous batching is a TS scheduler
  over the existing `fino:ai/model/local` binding — no new native surface.
  KV is provider-owned (`ownsKvCache: true`); the scheduler tracks slots,
  llama.cpp tracks blocks. (Multi-sequence batching semantics verified
  against the header during the spike, like every C-API claim in this
  family.)
- **`fino:tensor` (after engine Phase 2).** A transformer running on the
  engine. Here KV is engine tensors and the serving layer owns paging:
  fixed-size blocks, per-sequence block tables, allocation from the engine's
  pool. Decode steps are shape-stable, which is precisely the engine's
  capture/replay sweet spot — steady-state decode becomes a single graph
  launch per iteration.
- **ONNX Runtime (with the artifacts adapter).** Encoders — embedding
  models, rerankers, classifiers — via the `fino:model/onnx` adapter
  ([model-artifacts.md](./model-artifacts.md)). No KV, batch-in/batch-out;
  the same scheduler handles them as a degenerate single-step case.

## 3. The Serving Core

- **Continuous batching.** Iteration-level scheduling (the Orca insight):
  the scheduler runs a decode loop; at each step, finished sequences leave,
  queued requests join via prefill, nobody waits for a batch to drain.
  Admission control balances prefill against decode latency (chunked prefill
  later if needed); a simple FIFO-with-priority queue first, fairness policy
  when load testing demands one.
- **KV management.** For the engine path: paged blocks with block tables,
  preemption by eviction (drop lowest-priority sequence, re-prefill on
  readmission), occupancy as a first-class metric. Prefix caching
  (shared-prompt block reuse — agent system prompts make this valuable) is a
  later layer over the same block structure. For llama.cpp, the same policy
  decisions map onto its sequence API.
- **Streaming and cancellation.** A request yields an async iterable of
  tokens — the runtime's native idiom, feeding SSE at the HTTP layer with
  backpressure for free. `AbortSignal` cancellation releases the sequence
  slot and its KV immediately; a disconnected client must never hold GPU
  memory.
- **Constrained decoding (later).** Grammar/JSON-schema-constrained output:
  llama.cpp grammars now, a logit-processor hook on the engine path later.
  The agent stack's tool-calling makes this a first-class consumer, not a
  nicety.

## 4. The Serving Surface

- **OpenAI-compatible routes** mounted on `fino:net/http/app` — chat
  completions, completions, embeddings, SSE streaming. The OpenAI wire
  format is the de facto standard every client library speaks; implement a
  versioned subset honestly rather than chasing full compat.
- **In-process loopback.** A `fino:ai/model` provider that calls the
  scheduler directly — agents, `fino:ai/eval`, and `fino:ai/memory`
  embeddings use the served model with zero HTTP overhead, in the same
  process that trains and tracks it.
- **Model lifecycle.** Models resolve through the hub client and
  `models.lock` ([model-artifacts.md](./model-artifacts.md)); weights load
  via mmap'd safetensors/GGUF descriptors (warm start is a page-cache
  property, not a copy); multiple models route by name with idle unload.
- **Observability.** Per-request OTel spans from route to provider step;
  tokens/sec, time-to-first-token, queue depth, and KV occupancy emitted as
  metrics alongside `fino:train/track`'s conventions.

## 5. Batch Inference Over the Data Stack

Offline inference is a data-pipeline operation, and this is where the
universal data language pays off: a `Dataset`/DataFrame column goes in,
generations or embeddings come out as Arrow columns — embeddings as
`FixedSizeList<f32>` (the layout `column.toTensor()` and the sqlite vector
helpers already agree on), generations as utf8. The pipeline rides
`fino:data`'s worker-pool machinery, stays deterministic and resumable like
any loader, and writes Parquet. Embedding a corpus, scoring a dataset with a
judge model, and generating synthetic data are all the same shape: frame in,
frame out.

## 6. Sequencing

Three tracks with different dependencies:

- **Track A — no engine dependency.** The scheduler, continuous batching
  over the llama.cpp provider, streaming, cancellation, the OpenAI surface,
  the in-process provider loopback, and embeddings serving. This is a
  complete, useful serving product on its own.
- **Track B — needs `fino:data`.** Batch inference over
  Dataset/DataFrame (§5).
- **Track C — needs engine Phase 2.** The engine-backed provider with
  serving-owned paged KV and capture/replay decode; prefix caching;
  speculative decoding last (it needs a cheap draft model and the engine
  path to be worth accelerating).

## 7. Risks and Open Questions

- **Scheduler correctness under churn** (join/leave/cancel every iteration)
  is the hard part, not the HTTP surface; it needs a deterministic
  simulation harness (fake provider, scripted arrivals) before real load.
- **KV pressure policy** — eviction vs. admission throttling under memory
  pressure — needs load-test data, not intuition.
- **llama.cpp API churn**, same posture as the engine doc: pin known-good
  versions in the candidate-path probe.
- **OpenAI compat is a moving target**; version the implemented subset and
  test against real client libraries.
- **Module naming** (`fino:model/serve` vs. extending `fino:ai/model`) is
  open until the surface stabilizes.

## Sources

- Orca (iteration-level scheduling): https://www.usenix.org/conference/osdi22/presentation/yu
- vLLM / PagedAttention paper: https://arxiv.org/abs/2309.06180
- vLLM documentation: https://docs.vllm.ai/
- Text Generation Inference: https://huggingface.co/docs/text-generation-inference
- OpenAI API reference (the de facto wire standard): https://platform.openai.com/docs/api-reference
- llama.cpp: https://github.com/ggml-org/llama.cpp
