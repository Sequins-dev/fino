# Fino as a TypeScript Model Factory

> Status: research and direction-setting document — the strategy umbrella.
>
> Scope: this document deliberately excludes application-agent SDK
> comparisons. The question is whether Fino can become a
> serious TypeScript runtime for building, training, adapting, packaging, and
> executing models — and what, concretely, to build.
>
> The detailed designs live in scoped child documents (§6); this document
> owns the thesis, the gap analysis, the standards choices, the cross-cutting
> conventions, and the roadmap that ties the pieces together.

## 1. Thesis

Python is the default language for AI because it owns the model-factory stack:
data formats, tensor objects, accelerator execution, autodiff, graph capture,
compiler integration, model artifact formats, quantization, training loops,
distributed execution, notebooks, and model/dataset hubs.

Most JavaScript AI libraries live above that boundary. They wrap remote models,
stream text, call tools, orchestrate agents, or run already-exported inference
graphs. That is useful, but it does not make TypeScript a place where models
are made.

Fino should aim lower in the stack:

- a native tensor and device model;
- standards-first data and tensor interchange;
- model artifact readers for the formats people actually publish;
- CPU and accelerator execution backends;
- autodiff and training loops over the same tensor substrate;
- reproducible dataset, checkpoint, eval, and serving workflows.

The strongest path is not to clone PyTorch all at once. It is to build a small,
coherent, standards-compatible model-factory substrate that can load real data,
load real weights, run real kernels, train small models, fine-tune/adapt useful
components, export portable artifacts, and grow toward compiler-backed
execution.

Two constraints shape every design decision in this document family:

1. **Cross-platform, with no privileged vendor.** The same script must run on
   an Apple Silicon Mac, an arm64 or x86 Linux box, with or without a GPU, and
   pick up whatever acceleration the machine has. Neither macOS nor NVIDIA
   anchors the architecture: device selection is discovery, not configuration.
2. **Direct to hardware, with our own kernels.** The engine is not built over
   an inference library. Each platform is driven through *its own* lowest-level
   documented interface — Metal on Apple, Vulkan on Linux/Windows/Android, the
   CUDA driver API on NVIDIA — with no translation layer interposed, and the
   kernels running on them are ours, compiled at runtime from a
   dialect-neutral IR (MSL and CUDA C as text, SPIR-V emitted directly as
   binary). ggml is the benchmark bar, not a dependency; this engine is written
   to replace it.

The consequence worth stating up front: **the only abstraction in the design is
the one we own** — a generic tensor graph modelling framework above a thin,
native backend interface. That framework is also shaped from the start for the
second hardware class, fixed-function NPUs and TPUs, which consume whole graphs
instead of running arbitrary kernels. The full priority matrix, the rationale
for every accepted and rejected option, and the forward-compatibility design
live in [tensor-engine.md](./tensor-engine.md) §2.

The result is not "PyTorch, ported." It is a smaller, coherent engine that
exploits what Fino uniquely has — an async-native runtime, a fast FFI, true
parallelism without a GIL, durable workflows, and an existing serving/agent
stack — so that data loading, training, checkpointing, and serving live in one
process and one type system.

## 2. What "Model Factory" Means

A model factory is the full path from data to artifact:

1. Ingest data from local/remote storage.
2. Normalize it into efficient tabular, tensor, and media representations.
3. Transform it through streaming and batched pipelines.
4. Build model parameters as tensors with dtypes, shapes, and devices.
5. Execute tensor ops on CPU/GPU/accelerator backends.
6. Record gradients and update parameters.
7. Checkpoint weights, optimizer state, tokenizer/config metadata, and metrics.
8. Export or serve the result.

Python's advantage is that each layer has mature defaults:

- PyTorch exposes tensors, neural-network modules, autograd, optimizers, CUDA,
  MPS, XPU, distributed training, quantization, DLPack, data utilities, ONNX
  export, and profiler hooks in one ecosystem:
  https://docs.pytorch.org/docs/2.12/index.html.
- TensorFlow covers tensors, Keras model authoring, `tf.data`, custom training
  loops, distributed training, TensorBoard, and production ML pipelines:
  https://www.tensorflow.org/tutorials.
- JAX is built around composable transformations: autodiff, JIT compilation,
  vectorization, parallel execution, and array programming:
  https://docs.jax.dev/en/latest/.
- Hugging Face Datasets and Transformers provide the shared dataset/model hub
  path, and safetensors gives a safe, zero-copy-oriented tensor storage
  format: https://huggingface.co/docs/datasets/index,
  https://huggingface.co/docs/transformers/index,
  https://huggingface.co/docs/safetensors/index.

The JS/Web ecosystem proves that pieces are viable outside Python — ONNX
Runtime has a JavaScript API, Transformers.js runs pretrained models over it,
and WebGPU/WGSL/WebNN standardize GPU compute and NN-graph surfaces. The
missing piece is a runtime that unifies these into a model-building experience
instead of treating them as isolated inference adapters.

## 3. Current Fino Substrate

Fino is not starting from zero. The assets that matter, verified against the
runtime as it exists today:

- **The FFI fast path covers hot dispatch loops.** `fino:ffi` binds system
  libraries with pointers, buffers, struct-by-value layouts (`structType`),
  and C-function-pointer callbacks (`FfiCallback`). Int/pointer/buffer
  signatures compile to V8 Fast API calls with no marshalling
  (`src/ffi/fast.rs`). Existing modules use this for libc, SQLite, OpenSSL,
  nghttp2/nghttp3/ngtcp2, and llama.cpp/ggml (`js/ai/model/local.ts`).
- **Off-thread waiting and completion delivery exist.** `async: true` FFI
  symbols run on the global blocking pool and resolve promises via the
  per-isolate wake pipe (`src/async_rt/mod.rs`, `src/ffi/call.rs`). A device
  event wait declared `async: true` is exactly this mechanism — no new Rust
  completion machinery is required for asynchronous GPU readback.
- **Zero-copy parallelism for data loading exists.** SharedArrayBuffers are
  genuinely shared across thread realms (shared allocator in
  `src/runtime.rs`, SAB registry in `src/realm/serializer.rs`), and
  `fino:realm/pool` is a warm worker pool with load-based dispatch.
- **Zero-copy views over native memory exist.** `Pointer.view(ptr, len,
  { onRelease })` (`src/ffi/pointer.rs`) wraps native memory in an external
  ArrayBuffer without copying; the release callback fires on the JS thread
  after V8 frees the backing store, marshalled through the wake pipe. This is
  the substrate for zero-copy GPU readback from pinned host staging, Arrow
  buffers from native producers, mmap'd safetensors slices, and ggml tensor
  data.
- **Binary-format primitives exist.** `fino:format/flatbuffers` is a
  schema-less FlatBuffers reader/writer (the wire format Arrow IPC metadata
  is encoded in), `internal:format/thrift` is a generic compact-protocol
  codec, `fino:parsing/scanner` handles incremental binary scanning with
  hex-dump diagnostics, and this repo has a long habit of implementing wire
  formats from their specifications rather than importing them (Arrow IPC,
  Parquet, DNS, QUIC/HTTP-3 framing, the Postgres protocol) — the precedent
  the SPIR-V emitter relies on.
- **The columnar data tier is complete.** `fino:data/arrow` is the full Arrow
  columnar/IPC/C-Data stack and `fino:data/parquet` reads and writes Parquet
  with the full encoding set (PLAIN, RLE/bit-packed dictionary, the DELTA
  family, byte-stream-split), page compression, statistics, and nested
  repetition/definition levels — both golden-tested against pyarrow-generated
  fixtures. What is missing above them is consumers, not format support.
- **The supporting stack is broad**: full HTTP/1-2-3 + TLS for hub clients
  and serving, `fino:database/sqlite` (with JS VFS and vector helpers),
  `fino:compress` (gzip/deflate/brotli/zstd/lz4), `fino:workflow` (durable
  checkpointed runs),
  `fino:opentelemetry` + `fino:profiler`, `fino:ui` JSX, the V8 inspector
  REPL infrastructure, and the `fino:ai` agent/model/memory/eval family.

The missing substrate is equally clear: no tensor object model, no
dtype/device semantics, no kernels or accelerator backend, no autodiff, no
query/DataFrame layer, no Dataset/DataLoader, no safetensors reader, no
tokenizers, no optimizer/training-loop/checkpoint API, no notebook story.

Worth naming precisely, because it sets the near-term priority: the format
tier (Arrow, Parquet) and the application tier (`fino:ai/*` — agents, tools,
MCP, sqlite-vec memory, evals, sessions) are both mature and **they do not
touch each other**. There is no `toTensor`, no dtype vocabulary, no display
protocol, and no reference to Arrow or datasets anywhere in `fino:ai/eval`.
The columnar stack currently has no consumer inside the runtime. Connecting
those two tiers is worth more than any single new format, and it is the
organizing idea of the near-term plan
([next-steps.md](./next-steps.md)).

The binding style throughout the child documents is the established idiom:
dlopen system-installed libraries with candidate-path fallback
(`js/internal/openssl.ts`), struct layouts and callbacks per
`js/ai/model/local.ts`. Nothing is vendored; the user's system determines
which backends light up.

## 4. Gap Matrix

| Capability | Python maturity | JS/Web maturity | Fino today | Strategic value | Build difficulty |
|---|---:|---:|---:|---:|---:|
| Tensor object model | Very high | Medium | None | Critical | High |
| Dtype/device semantics | Very high | Medium | None | Critical | High |
| CPU tensor kernels | Very high | Medium | None | Critical | High |
| GPU execution (own kernels) | Very high | Low — wrappers only | None | Critical | Very high |
| Autodiff | Very high | Low/medium | None | Critical | Very high |
| Graph capture/JIT | Very high | Low | None | High | Very high |
| Arrow tables | Very high | Medium | `fino:data/arrow` (full type coverage) | High | **Done** |
| Arrow IPC + C Data Interface | Very high | Medium | `fino:data/arrow` (stream/file + CDI) | High | **Done** |
| Parquet | Very high | Medium | `fino:data/parquet` (full encodings, nested, r/w) | High | **Done** |
| DataFrame / query layer | Very high | Low/medium | None | High | Medium |
| Dataset streaming | Very high | Low/medium | CSV/Arrow/Parquet formats, no Dataset API | High | Medium |
| Safetensors | Very high | Low/medium | None | High | Medium |
| GGUF loading | Medium/high | Low | llama.cpp adapter only | High | Medium |
| ONNX loading | High | Medium/high | None | High | High |
| Quantization | Very high | Low/medium | llama.cpp delegated only | High | Very high |
| Tokenizers | Very high | Medium | None | High | Medium |
| Optimizers | Very high | Low | None | Critical | Medium |
| Mixed precision | Very high | Low/medium | None | High | High |
| Distributed training | Very high | Low | Realm substrate only | Medium now, high later | Very high |
| Profiling | Very high | Medium | Runtime hooks exist | High | Medium |
| Checkpoints | Very high | Low/medium | SQLite/files only | High | Medium |
| Inference serving (batching/KV) | Very high | Low/medium | Single-request llama.cpp adapter | High | High |
| Classical ML (estimators, GBDT) | Very high | Low | None | High | Medium |
| Dense linear algebra | Very high | Low/medium | None | High | Medium |
| Hyperparameter search | Very high | Low | None | Medium | Low/medium |

The first unavoidable conclusion: Fino cannot become a model factory through
provider APIs or agent abstractions. It needs a tensor/data/kernel base.

The second conclusion: the first useful version does not need distributed
training or a compiler. It needs stable memory semantics, a small operator
set, artifact loading, and a training loop that works for modest models.

## 5. Standards To Anchor On

- **Apache Arrow** is the in-memory tabular representation and is already
  implemented as `fino:data/arrow` — the columnar format, IPC, and the C Data
  Interface (the ABI-stable zero-copy bridge to native libraries). Downstream
  work anchors on it rather than re-selecting a tabular standard.
- **DLPack** is the tensor interchange boundary — a stable in-memory tensor
  structure supporting CPU, CUDA, Metal, Vulkan, ROCm, and others
  (https://dmlc.github.io/dlpack/latest/). It is the boundary format for
  interop with native libraries, not the internal object model.
- **Safetensors** is the near-term, high-leverage artifact format: metadata
  plus per-tensor byte offsets, designed for safe, lazy, zero-copy-friendly
  loading (https://huggingface.co/docs/safetensors/index).
- **ONNX** is the portable graph format to read and (later) execute for
  inference interop — never the internal training graph
  (https://onnx.ai/onnx/intro/).
- **MSL, SPIR-V, and CUDA C** are the three kernel-compilation targets, all
  reached at runtime with no offline toolchain: MSL through Metal's
  `newLibraryWithSource:`, CUDA C through NVRTC, and SPIR-V by emitting the
  binary format directly from TypeScript
  (https://registry.khronos.org/SPIR-V/). They are three lowerings of one
  dialect-neutral kernel IR, not three strategies.
- **WebGPU/WGSL** are *not* an accelerator target. An earlier revision of this
  document recommended them as the first one; that is revised twice over.
  There is no system-installed wgpu-native to dlopen, so binding it would mean
  vendoring a compiled artifact — and it sits *above* Vulkan and Metal, which
  is the opposite of the direct-to-hardware goal. The full backend priority
  matrix and the reasoning for every accepted and rejected option live in
  [tensor-engine.md](./tensor-engine.md) §2.

## 6. The Document Family

The concrete designs are split into scoped documents so each can be refined
independently. The tensor engine and its backends are one workstream;
inference serving and parts of classical ML layer over it; the rest is
general data-science infrastructure that ships independently and does not
wait on the engine. The integration bet across all of them: invest heavily
in the universal data infrastructure — Arrow, DataFrame, Tensor — so every
tool speaks the same data language and composes without representation
changes.

| Document | Scope | Engine dependency |
|---|---|---|
| [tensor-engine.md](./tensor-engine.md) | The graph framework and execution semantics; native backends (Metal, Vulkan+SPIR-V, CUDA driver API, CPU/BLAS) and the fixed-function NPU/TPU class; kernel IR and codegen; memory semantics; autodiff; the public `fino:tensor` API family; differential testing; `tensor-contract.md` | — (is the engine) |
| [data-stack.md](./data-stack.md) | Arrow-first data infra: `fino:format/thrift`, Snappy, `fino:data/parquet`, `fino:data/frame`, Dataset/DataLoader | None (only `column.toTensor()` crosses over) |
| [model-artifacts.md](./model-artifacts.md) | safetensors/GGUF/npy readers, the hub client + `models.lock`, tokenizers, ONNX interop | None (descriptor-producing) |
| [ml-workbench.md](./ml-workbench.md) | Notebook + display protocol, `fino:viz`, experiment tracking, hyperparameter sweeps, durable training | None |
| [inference-serving.md](./inference-serving.md) | Continuous-batching scheduler, KV-cache management, streaming, OpenAI-compatible surface, batch inference over Arrow | Layers over the engine; the near-term llama.cpp track doesn't wait on it |
| [classical-ml.md](./classical-ml.md) | LAPACK-backed linalg, sklearn-shaped estimators, GBDT via XGBoost/LightGBM, preprocessing over DataFrame, shared metrics | Linalg and linear models ride the engine's CPU substrate; GBDT/preprocessing/metrics don't wait |

Alongside them, [next-steps.md](./next-steps.md) is the near-term execution
plan: what to build in what order given what has actually landed, why that
order, and the decisions each wave forces. The documents above describe the
destination; that one describes the next few moves.

## 7. Unification: One Framework, Not a Pile of Libraries

The conventions that make these modules a single framework:

- **One dtype/device vocabulary**, exported by `fino:tensor`, used by Arrow
  column conversion, artifact descriptors, image decode, and collators.
- **Arrow RecordBatch is the tabular currency; Tensor is the numeric
  currency.** Frames, SQL results, dataset batches, and hub files
  produce/consume record batches; `column.toTensor()`, `image.toTensor()`,
  `artifacts.load() → Tensor` cross into numerics. The C Data Interface is
  the convention at every FFI boundary.
- **Async iterables + explicit disposal everywhere**; seeded determinism and
  `state()/restore()` on anything stateful; the MIME display protocol on
  anything showable.
- **Composition with the existing stack.** Train an embedding head with
  `fino:tensor/nn` → checkpoint via `fino:model/artifacts` → register it as
  the embedding provider for `fino:ai/memory` → agents recall with it — one
  process. `fino:ai/eval` datasets ride `fino:data`. A trained model mounts
  as an endpoint on `fino:net/http/app` in the same script that trained it,
  traced end-to-end by `fino:opentelemetry`.

The narrative against Python, stated plainly: **no GIL** — data loading,
augmentation, and serving are true parallelism over realms and shared memory,
not multiprocessing-and-pickle; **async-native training** — the event loop
serves a dashboard while a step runs, and every sync point is a promise;
**typed end-to-end** — schemas to frames to tensors in one type system;
**reproducible by default** — seeds, `models.lock`, content-addressed
artifacts, git-diffable notebooks; **durable by default** — training jobs
resume because workflows are checkpointed; **capability-sandboxed** — a
notebook or a data pipeline can be denied network or filesystem by the realm
import map, enforced in Rust. Python has the ecosystem; none of these
properties are retrofittable onto it.

## 8. Product Wedges

The proof points to build toward, in order of how sharply they validate the
substrate:

- **Local small-model training**: logistic regression and MLP classifiers
  over tabular data; a small CNN over MNIST/CIFAR-scale data; a small
  Transformer; embedding heads/adapters for domain-specific retrieval.
  Proves tensor/autograd/optimizer/data end-to-end with benchmarkable
  targets, without giant-model infrastructure.
- **Artifact-native inference and inspection**: safetensors metadata
  browsing (including remote-by-Range), GGUF and ONNX inspection, loading a
  safetensors head into `fino:tensor/nn`. Connects Fino to real model
  repositories and keeps the tensor system from being toy-only.
- **Arrow dataset pipelines**: Parquet/CSV/JSONL to record batches, streaming
  transforms, deterministic splits, realm-backed prefetch. Data loading is a
  major Python moat, and Fino's file/stream/sqlite/realm primitives are
  already good at it — this wedge is independently useful even without the
  tensor engine.
- **The same script, accelerated everywhere, on our own kernels**: one
  unmodified training script that runs on CPU on arm64 Linux, on Metal on an
  Apple Silicon Mac, and on Vulkan or CUDA on a Linux GPU box — because the
  device is discovered, not configured, and every one of those paths goes
  straight to the platform's own interface. Portable acceleration from a single
  self-contained binary is the credibility claim, and it is a sharper
  differentiator than raw step time on one vendor: PyTorch has the step time,
  but a PyTorch install is a per-platform wheel-and-driver negotiation.

## 9. Roadmap

Each phase's detail lives in the owning child document, and
[next-steps.md](./next-steps.md) sequences the immediate work in finer grain.
This is the cross-document shape:

- **Phase 0 — contracts and the two-dialect spike.** `tensor-contract.md` and
  a first cut of the kernel IR, then the decisive spike: one trivial kernel
  emitted through *both* MSL (native Metal on the dev machine) and
  TS-emitted SPIR-V, which simultaneously proves the IR is dialect-neutral and
  de-risks the SPIR-V emitter ([tensor-engine.md](./tensor-engine.md) §7).
  Plus the arm64-Linux deployment probe. In parallel, waiting on nothing: the
  shared conventions (dtype vocabulary, display protocol), `fino:ml/metrics`
  ([classical-ml.md](./classical-ml.md)), and the hub client and tokenizer
  ([model-artifacts.md](./model-artifacts.md)). The data-stack Phase 0
  (Thrift, Snappy, Parquet) is **done**.
- **Phase 1 — the portable core.** The tensor object model, TS tape,
  `nn`/`optim`, seeded `Generator`, the reference backend as shipping fallback,
  and BLAS/LAPACK for dense CPU math, with `fino:tensor`, `fino:tensor/graph`,
  and `fino:tensor/backend` public behind an experimental marker
  ([tensor-engine.md](./tensor-engine.md)). Alongside it the data consumers
  that have been waiting for a numeric type: `fino:data/frame` and
  Dataset/DataLoader ([data-stack.md](./data-stack.md)). **Exit: train an MLP
  and a small transformer on CPU on both macOS and arm64 Linux, every op and
  gradient differentially green against the oracle.**
- **Phase 2 — Metal-direct.** Our own kernels on Apple GPUs through
  `objc_msgSend` and runtime MSL ([tensor-engine.md](./tensor-engine.md)).
  **Exit: the Phase 1 script runs unmodified, GPU-accelerated, with per-op
  numbers against ggml-Metal on the same device.**
- **Phase 3 — Vulkan-direct.** The SPIR-V emitter hardened and the same
  templates lowered through it, covering every non-Apple GPU, then the tiled
  GEMM ([tensor-engine.md](./tensor-engine.md)). DataLoader hardening
  ([data-stack.md](./data-stack.md)); train/track/notebook UX and
  checkpoint/resume through `fino:workflow`
  ([ml-workbench.md](./ml-workbench.md)).
- **Phase 4 — fusion and step replay** ([tensor-engine.md](./tensor-engine.md)).
- **Phase 5 — CUDA-direct where it wins**: cuBLASLt epilogues and cuDNN fused
  attention, the things neither Metal nor Vulkan has an equivalent for
  ([tensor-engine.md](./tensor-engine.md)).
- **Phase 6 — the far end.** A tile DSL, data-parallel training, HIP or Level
  Zero if needed, the first fixed-function NPU/TPU backend, and eventually
  retiring the llama.cpp dependency for GGUF inference
  ([tensor-engine.md](./tensor-engine.md)); the ONNX Runtime adapter
  ([model-artifacts.md](./model-artifacts.md)); the Jupyter kernel
  ([ml-workbench.md](./ml-workbench.md)).
- **Parallel tracks (sequenced in their own docs).** Inference serving
  begins on the existing llama.cpp adapter — scheduler, OpenAI surface,
  streaming — independent of the engine
  ([inference-serving.md](./inference-serving.md)). Classical ML lands
  metrics immediately, GBDT + preprocessing once `fino:data/frame` exists,
  and linalg with the engine's Phase 1 BLAS binding
  ([classical-ml.md](./classical-ml.md)). Hyperparameter sweeps follow
  tracking ([ml-workbench.md](./ml-workbench.md)).
- **Later, in rough order:** `fino:media/image` (dlopen jpeg-turbo's `tj3*`
  C API + libpng; resize/normalize as tensor ops, augmentation transforms in
  the DataLoader) — required for vision datasets. Explicitly deferred:
  audio, distributed training beyond data-parallel, quantization frameworks
  beyond artifact inspection, HDF5.

## 10. What Not To Build First

Avoid these until the tensor/data base is real:

- a full PyTorch clone;
- a large agent framework expansion;
- provider SDK abstractions;
- distributed training beyond NCCL data-parallel;
- a custom compiler IR (the recorded tape + fusion codegen is not an IR
  project; keep it a peephole pass until export/import pressure is real);
- ONNX as the internal training graph;
- broad model zoo APIs;
- quantization frameworks beyond artifact inspection;
- hand-written GEMM/conv/attention kernels (vendor libraries own these).

And deliberately absent from the family, so their absence reads as chosen
rather than overlooked:

- Ray/Dask-style distributed compute — realms cover single-node parallelism;
  cross-node orchestration is a different product;
- feature stores and data-validation frameworks;
- sparse tensors and graph neural networks;
- an ANN index beyond the sqlite vector helpers (revisit only if
  `fino:ai/memory` hits scale limits);
- RL/post-training recipes — SFT/DPO are ordinary training loops once the
  engine matures, and training agents inside the same runtime that hosts
  them is a long-term direction, not a first move.

These are not wrong goals. They are downstream of a working tensor runtime.

## 11. Success Criteria

Fino becomes credible as a TypeScript model factory when it can:

- load tabular/text data into efficient batches;
- create tensors with explicit dtype/device semantics;
- run a useful op set on CPU everywhere, and accelerated on whatever device
  the host happens to have, through one discovered code path;
- compute gradients and update parameters;
- train small models end-to-end at PyTorch-eager-class step times;
- load safetensors and inspect GGUF/ONNX artifacts;
- checkpoint and resume training — including through a process kill;
- export or serve the trained result from the same process;
- serve a model behind an OpenAI-compatible streaming endpoint with
  continuous batching;
- fit, evaluate, and persist tabular models (linear, boosted trees) directly
  over Arrow data;
- profile the full path.

The long-term ambition is larger: a TypeScript-first model factory where
data, models, training, artifacts, and serving live in one runtime. The
near-term proof is smaller and sharper: train useful small models, load real
artifacts, and accelerate the hot path without leaving Fino.

## Sources

Per-area sources live in the child documents. The ecosystem references for
the strategy above:

- PyTorch documentation: https://docs.pytorch.org/docs/2.12/index.html
- TensorFlow tutorials and guide index: https://www.tensorflow.org/tutorials
- JAX documentation: https://docs.jax.dev/en/latest/
- Hugging Face Datasets: https://huggingface.co/docs/datasets/index
- Hugging Face Transformers: https://huggingface.co/docs/transformers/index
- Safetensors documentation: https://huggingface.co/docs/safetensors/index
- Apache Arrow overview: https://arrow.apache.org/overview/
- Apache Arrow C Data Interface: https://arrow.apache.org/docs/format/CDataInterface.html
- DLPack documentation: https://dmlc.github.io/dlpack/latest/
- ONNX introduction: https://onnx.ai/onnx/intro/
- W3C WebGPU: https://www.w3.org/TR/webgpu/ and WGSL: https://www.w3.org/TR/WGSL/
