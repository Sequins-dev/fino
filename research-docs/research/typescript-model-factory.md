# Fino as a TypeScript Model Factory

> Status: research and direction-setting document.
>
> Scope: this document deliberately excludes Node.js/npm compatibility and
> application-agent SDK comparisons. The question is whether Fino can become a
> serious TypeScript runtime for building, training, adapting, packaging, and
> executing models — and what, concretely, to build.

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

Two constraints shape every design decision in this document:

1. **Linux is the primary target.** Serious training and serving happen on
   Linux servers with NVIDIA GPUs. macOS is the development environment and
   must have good parity, but no Apple-first library can anchor the
   architecture.
2. **Peak efficiency through the deep platform APIs.** The engine binds the
   CUDA driver API, NVRTC, and cuBLASLt directly — not a convenience wrapper
   that caps the ceiling at whatever it chose to expose. Where a wrapper is
   used (ggml, for breadth), its bounds are stated explicitly and it is never
   the layer that limits the primary path.

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
  is encoded in), and `fino:parsing/scanner` handles incremental binary
  scanning with hex-dump diagnostics.
- **The supporting stack is broad**: full HTTP/1-2-3 + TLS for hub clients
  and serving, `fino:database/sqlite` (with JS VFS and vector helpers),
  `fino:compress`, `fino:workflow` (durable checkpointed runs),
  `fino:opentelemetry` + `fino:profiler`, `fino:ui` JSX, the V8 inspector
  REPL infrastructure, and the `fino:ai` agent/model/memory/eval family.

The missing substrate is equally clear: no tensor object model, no
dtype/device semantics, no kernels or accelerator backend, no autodiff, no
Parquet/query layer, no safetensors reader, no tokenizers, no
optimizer/training-loop/checkpoint API, no notebook story. (Arrow itself now
exists as `fino:data/arrow` — the columnar format, IPC, and C Data Interface.)

The binding style throughout what follows is the established idiom: dlopen
system-installed libraries with candidate-path fallback
(`js/internal/openssl.ts`), struct layouts and callbacks per
`js/ai/model/local.ts`. Nothing is vendored; the user's system determines
which backends light up.

## 4. Gap Matrix

| Capability | Python maturity | JS/Web maturity | Fino today | Strategic value | Build difficulty |
|---|---:|---:|---:|---:|---:|
| Tensor object model | Very high | Medium | None | Critical | High |
| Dtype/device semantics | Very high | Medium | None | Critical | High |
| CPU tensor kernels | Very high | Medium | None | Critical | High |
| GPU execution | Very high | Medium via WebGPU/TF.js/ORT | None | Critical | Very high |
| Autodiff | Very high | Low/medium | None | Critical | Very high |
| Graph capture/JIT | Very high | Low | None | High | Very high |
| Arrow tables | Very high | Medium | `fino:data/arrow` (full type coverage) | High | Medium |
| Arrow IPC + C Data Interface | Very high | Medium | `fino:data/arrow` (stream/file + CDI) | High | Medium/high |
| Parquet | Very high | Medium | None (DuckDB binding planned) | High | Medium/high |
| Dataset streaming | Very high | Low/medium | CSV only | High | Medium |
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

The first unavoidable conclusion: Fino cannot become a model factory through
provider APIs or agent abstractions. It needs a tensor/data/kernel base.

The second conclusion: the first useful version does not need distributed
training or a compiler. It needs stable memory semantics, a small operator
set, artifact loading, and a training loop that works for modest models.

## 5. Standards To Anchor On

- **Apache Arrow** is the in-memory tabular representation: a
  language-agnostic, standardized columnar format
  (https://arrow.apache.org/overview/). The **C Data Interface** is
  especially relevant — a small, ABI-stable set of C struct definitions for
  zero-copy sharing between independent runtimes in the same process
  (https://arrow.apache.org/docs/format/CDataInterface.html), a natural fit
  for `fino:ffi`'s `structType`.
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
- **WebGPU/WGSL** are *not* the first accelerator target. An earlier revision
  of this document recommended them; that is revised here. WebGPU's perf
  ceiling (no mature tensor-core path, no vendor GEMM library) and the
  absence of an installed wgpu-native base make it a poor primary. The first
  accelerator is the CUDA driver API bound directly (§7); cross-vendor
  breadth is covered by ggml's backends; a WebGPU backend remains possible
  later behind the same interface, mostly for browser alignment.

## 6. The Execution Model

The goal is a PyTorch-equivalent eager API where

```ts
const c = a.matmul(b).relu();
```

returns immediately, the matmul and relu kernels are already enqueued on a GPU
stream by the time the next statement runs, the executed graph is being
recorded as it happens, and the only synchronization points in the entire
programming model are reading values back out:

```ts
const loss = await lossTensor.item();   // the ONLY place anyone waits
```

This is PyTorch's CUDA semantics, made honest about asynchrony by the host
language:

- **Dispatch is eager and non-blocking.** Every op call performs real work
  immediately: it allocates an output buffer from a stream-ordered pool and
  enqueues a kernel on the device stream. Kernel *launch* is inherently
  asynchronous — the CPU cost is microseconds — so the JS thread never waits
  on the GPU during forward or backward.
- **The graph is recorded at dispatch time.** Each op appends a node (op
  kind, input/output tensor handles, attributes) to a per-context tape. The
  tape serves three consumers: reverse-mode autodiff (§10), fusion codegen
  (§8), and capture/replay (§9). PyTorch records for autograd and then
  re-derives graphs for `torch.compile`; here one recording serves all three.
- **Synchronization is explicit and promise-shaped.** `await t.data()`,
  `await t.item()`, checkpointing, and cross-device transfer are the only
  sync points. "Blocking" means a worker on the runtime's blocking pool parks
  on a device event and resolves a promise through the wake pipe — the event
  loop keeps running. A training loop's natural cadence is one awaited scalar
  (the loss) per step.

Python cannot make this model pleasant — `tensor.item()` blocks the whole
interpreter, and asyncio and CUDA streams live in different universes. In
Fino the model is native: readback is just a promise, and the event loop can
serve HTTP, stream logs, or drive a dashboard while a step executes.

## 7. Backend Architecture

The engine is backend-neutral TypeScript — Tensor object model, autograd
tape, `nn`/`optim` — dispatching through a narrow backend interface: roughly
60–70 primitive ops plus orthogonal capability planes (memory, ordering,
kernel-compile, capture/replay). All handles are opaque pointers. Sketch:

```ts
interface DeviceBackend {
  readonly caps: {
    kernelCompile: false | 'cuda-c' | 'msl';
    captureReplay: boolean;
    dtypes: DType[]; pinnedHost: boolean;
  };
  // memory
  alloc(bytes: number, stream: Stream): DeviceBuffer;
  free(buf: DeviceBuffer, stream: Stream): void;
  copyH2D(dst: DeviceBuffer, src: BufferSource, s: Stream): void;
  copyD2H(dst: PinnedBuffer, src: DeviceBuffer, s: Stream): void;
  // ordering
  createStream(): Stream; createEvent(): Event;
  record(ev: Event, s: Stream): void; streamWait(s: Stream, ev: Event): void;
  eventDone(ev: Event): Promise<void>;          // async:true pool wait
  // ops (~60; TensorDesc = { buf, dtype, shape, strides })
  gemm(a: TensorDesc, b: TensorDesc, out: TensorDesc, o: GemmOpts, s: Stream): void;
  elementwise(op: EwOp, ins: TensorDesc[], out: TensorDesc, attrs: Attrs, s: Stream): void;
  reduce(op: RedOp, x: TensorDesc, out: TensorDesc, axes: number[], s: Stream): void;
  // ...norm, softmax, gather/scatter, optimizerStep; conv/sdpa caps-gated
  // codegen plane (caps.kernelCompile only)
  compileKernel(src: string, entry: string, cacheKey: string): Promise<Kernel>;
  launch(k: Kernel, grid: V3, block: V3, params: ArrayBuffer, shmem: number, s: Stream): void;
  // capture plane (caps.captureReplay only)
  captureBegin(s: Stream): void;
  captureEnd(s: Stream): Executable;
  replay(x: Executable, s: Stream): void;
}
```

### 7.1 Priority matrix

| Priority | Target | Backend | Binding |
|---|---|---|---|
| P0 | NVIDIA / Linux | **CUDA-direct** | dlopen `libcuda.so.1` + `libnvrtc` + `libcublasLt` (+ `libcudnn.so.9` later) |
| P0 | Apple dev machines | **ggml-Metal** | dlopen `libggml*` (in-repo precedent) |
| P0 | CPU everywhere | TS reference (oracle) + BLAS | dlopen OpenBLAS / Accelerate; ggml-CPU for non-GEMM |
| P2 | Apple, high perf | Metal-direct via `objc_msgSend` | dlopen `libobjc.A.dylib` + Metal framework |
| P2 | AMD servers | HIP mirror of the CUDA backend | dlopen `libamdhip64`, hipRTC, hipBLASLt |
| P3 | AMD/Intel consumer | ggml-Vulkan (same adapter) | — |

Rejected as primaries: **MLX/mlx-c** (Apple-first; its CUDA backend is young
and NVIDIA-only, and it would impose its lazy-graph model on our execution
semantics), **Vulkan-direct** (a second backend's worth of work — descriptor
sets, memory heaps, SPIR-V, per-vendor cooperative matrix quirks — to serve
hardware that is not the server training market; AMD servers are better
served by HIP), **WebGPU-first** (§5), and **any compiled C shim we'd have to
ship** (a vendored artifact; against the system-libraries philosophy).

### 7.2 CUDA-direct, the primary backend

Every library in the chain is a plain C ABI and present on real GPU servers.
(These claims come from domain knowledge of the CUDA stack, not local
verification — this design was researched on macOS; the Phase 0 spike on a
Linux box confirms them. They are conservative.)

- **`libcuda.so.1`** — the driver API, installed by the NVIDIA kernel driver
  itself. It is the only GPU library guaranteed present on every NVIDIA box,
  including containers run with `--gpus` (injected by
  nvidia-container-toolkit). It provides everything the backend needs:
  contexts, module loading, `cuLaunchKernel`, streams, events, stream-ordered
  memory pools (`cuMemAllocAsync`), pinned host memory, and CUDA Graphs. Two
  binding details matter: use the **primary context**
  (`cuDevicePrimaryCtxRetain`) so Fino composes with any other CUDA user
  in-process, and resolve entry points through **`cuGetProcAddress`** with
  explicit version numbers rather than dlsym-ing raw names — many driver
  symbols are versioned (`cuMemAlloc_v2`, `cuStreamBeginCapture_v2`, …) and
  the proc-address route is the future-proof one. That bootstrap is one
  function; the rest is TS.
- **`libnvrtc.so`** — runtime compilation of CUDA C. Compile to **cubin** for
  the exact `sm_XX` (`nvrtcGetCUBIN`, CUDA ≥ 11.2) so the driver never
  re-JITs. NVRTC is the one install requirement beyond the driver; it ships
  with every CUDA toolkit and every PyTorch/conda environment already on the
  box, and is redistributable.
- **`libcublasLt.so`** — GEMM. Prefer cuBLASLt over classic cuBLAS:
  heuristic-based algo selection, explicit workspace (fed from our pool), and
  **epilogue fusion** — bias add, GELU, ReLU fused into the GEMM for free
  (`CUBLASLT_EPILOGUE_GELU_BIAS` and friends). fp32/tf32/bf16/fp16 with
  tensor cores.
- **`libcudnn.so.9`** (phase 2) — the v9 *backend* ("graph") API is plain C:
  build descriptor graphs, finalize, execute. The friendly frontend is
  header-only C++ and is skipped; the descriptor verbosity is mechanical and
  a good fit for a TS builder layer. This buys fused convolution and fused
  flash attention (SDPA) — kernels nobody should hand-write.
- **`libcudart` is skipped entirely.** The driver API covers everything;
  depending only on driver + NVRTC minimizes the deployment footprint.

FFI fit: every call above is int/pointer-signatured → V8 Fast API dispatch.
Floats never appear in FFI signatures on the hot path: kernel scalar
arguments travel inside the `void**` params block passed to `cuLaunchKernel`
(an ArrayBuffer assembled in TS), and cuBLAS alpha/beta pass by pointer. The
v1 subset is the driver bootstrap (~25 symbols), NVRTC compile+cache,
cuBLASLt GEMM, the memory pool, pinned staging + async copies, events, and
~30 template kernels (§8). (An optional FFI improvement — f32/f64 scalar
support in the V8 Fast API path — would let float-attribute calls stay fast
too, but the design deliberately keeps floats out of hot signatures, so it is
a nicety.)

### 7.3 ggml, the breadth adapter — bounded on purpose

One adapter class over `ggml-backend.h` buys three targets at once: Metal on
Macs (dev parity), a fast SIMD/threaded CPU backend, and incidental Vulkan.
The headers were verified locally (`/opt/homebrew/include/ggml*.h`, installed
by the llama.cpp formula Fino already dlopens):

- Plain C throughout; a `ggml_backend_t` behaves like a stream (async tensor
  set/get, events); `ggml_backend_graph_plan_create/compute` provides cheap
  replay of a fixed graph — mapping cleanly onto the backend interface,
  including the capture plane.
- Its bounds, stated honestly: tensors cap at **4 dimensions**
  (`GGML_MAX_DIMS`, ggml.h); there is no run-one-op API, so dispatch must
  buffer recorded ops and build one `ggml_cgraph` per flush (acceptable — the
  engine records a graph anyway, and flush points are where evaluation
  happens); the op set is inference-shaped with training backward-ops
  covering the llama path (ggml-opt.h exists but is scaffolding-grade); and —
  decisive — **custom ops execute CPU callbacks only** (`ggml_map_custom*`),
  so ggml can never host our fused GPU kernels. That last fact is precisely
  why ggml is the breadth adapter and not the primary: choosing it as primary
  would cap efficiency at whatever ggml ships and forfeit the entire
  kernel-codegen strategy.

### 7.4 CPU

The pure-TS reference backend is the correctness oracle: naive loops, same
primitive interface, seedable RNG, CI-mandatory differential tests for every
op and every gradient on every accelerated backend. It is deliberately not
the fast CPU story. Fast CPU = dlopen BLAS for GEMM (`libopenblas.so.0` on
Linux; `Accelerate.framework` on macOS — dlopen-able, same CBLAS symbols)
plus ggml-CPU for the rest, via the adapter that exists anyway.

### 7.5 Metal-direct, later, without a shim

Metal has no C API, but the Objective-C *runtime* does: `libobjc.A.dylib`
exposes `objc_getClass`, `sel_registerName`, and `objc_msgSend` — plain C,
and on arm64 there are no fragile `_stret` variants to worry about. This is
how metal-rs and Julia bind Metal without writing Objective-C. Fino's FFI can
do the same: one dlopen alias per selector signature. Blocks (for completion
handlers) have a documented plain-C struct layout constructible with
`structType` + `FfiCallback` — or are avoided entirely by waiting on a
`MTLSharedEvent` from the blocking pool. Runtime MSL compilation
(`newLibraryWithSource:`) is the NVRTC analog, so the kernel-codegen path
(§8) ports. This is fiddly but philosophically clean and entirely in TS. It
is scheduled as a demand-gated upgrade: the Mac's job is development parity,
which ggml-Metal covers; Metal-direct happens only if Mac training throughput
turns out to matter.

## 8. Kernel Strategy: the Compiler Lives in TypeScript

Split the op set by roofline position.

**Math-bound ops — vendor libraries, never hand-written.** GEMM, linear, and
batched matmul go to cuBLASLt (with epilogue fusion); convolution and fused
attention go to cuDNN v9 in phase 2 (v1 composes attention from GEMM + a
fused softmax kernel). On Macs, ggml-Metal owns these in v1. Nobody beats
vendor GEMM casually; trying is a research project, not a runtime feature.

**Memory-bound ops — TS-generated kernels via NVRTC.** Roughly 30 primitives:
elementwise unary/binary with broadcasting, reductions, softmax/log-softmax,
layer/RMS-norm forward+backward, embedding gather / scatter-add, optimizer
updates, dropout, cast, transpose/copy. Their cost is bandwidth, and the win
is fusion. The pipeline:

1. **v1 — templates, not codegen.** Each op is a TS function returning CUDA C
   source specialized by dtype, contiguity/broadcast pattern (collapse
   dimensions first; specialize contiguous / outer-broadcast / general
   strided), and vector width (float4 loads when aligned). Grid-stride loops;
   two-pass or block-then-atomic reductions; Welford for norm statistics.
   A few KB of source per kernel. This alone reaches parity with PyTorch
   eager for these ops — PyTorch eager doesn't fuse either.
2. **Kernel cache, two tiers.** Key = hash of (canonical source, `sm_XX`,
   NVRTC version, flags). In-memory map of loaded `CUfunction`s; on-disk
   `~/.fino/kernels/<sm>/<hash>.cubin` so each kernel compiles once per
   machine and loads in under a millisecond thereafter. NVRTC compiles (tens
   to hundreds of ms) run on the blocking pool via `async: true`; because
   dispatch is asynchronous anyway, subsequent ops queue behind the compile
   without ever blocking the event loop. The ~30 v1 templates are pre-warmed
   at device init.
3. **v2 — fusion codegen over the recorded graph.** At flush time, a peephole
   pass finds maximal regions of elementwise ops (plus an optional leading
   gather or trailing reduction) sharing a shape domain and emits one kernel:
   load inputs once, compute the chain in registers, store outputs once.
   Classic wins: bias+GELU+residual+cast in one kernel instead of four; AdamW
   over a flattened parameter group as one launch instead of one per tensor;
   fused softmax-cross-entropy. The codegen is string assembly over the same
   template skeletons; the numerically hard 10% (stable reductions inside
   fused regions, shared-memory staging) stays in hand-written skeletons the
   fuser instantiates.
4. **v3+ direction — a tile DSL in TS.** A Triton-like tile/block-level
   builder API (TS has no operator overloading, so explicitly builder- or
   tagged-template-based) lowering to CUDA C, with inline PTX (`mma.sync`) or
   the WMMA header (suppliable to NVRTC as an in-memory header) for tensor
   cores. Realistic framing: CUDA-C-via-NVRTC captures nearly all of the
   memory-bound win; bespoke tensor-core kernels are deferred until cuDNN's
   fused SDPA proves insufficient.

The same template sources lower to MSL behind a thin dialect layer
(`__global__` → `kernel`, thread-index intrinsics, `threadgroup` memory) when
Metal-direct lands. The deep point: because the FFI is fast and compilation
is a system library, **the kernel compiler is ordinary TypeScript** — no
build step, no offline toolchain, inspectable at runtime. That is the
"everything in JS" philosophy applied to GPU codegen, and no other JS runtime
has it.

## 9. Execution and Memory, Precisely

**Dispatch (hot path, all sync fast-FFI).** Op recorded on the tape → output
buffer from the pool (`cuMemAllocAsync` on the stream) → params block written
into a reusable ArrayBuffer → `cuLaunchKernel(..., stream, params, 0)`.
Launches cost microseconds of CPU and return immediately.

**Readback (`await t.data()` / `t.item()`).**
`cuMemcpyDtoHAsync(pinnedStaging, devPtr, bytes, stream)` →
`cuEventRecord(ev, stream)` → `cuEventSynchronize(ev)` declared `async: true`
→ resolves on the blocking pool → wake pipe → `Pointer.view` over the pinned
staging buffer (zero-copy; the view's release callback recycles the staging
slot). The
in-flight readback table holds a strong reference to the tensor so its handle
cannot be finalized while a pool thread waits. A training loop keeps roughly
one waiter outstanding; the pool's default cap is irrelevant at that
occupancy.

**Memory.** v1 uses the driver's stream-ordered pool with the release
threshold set to infinity so the pool never returns memory to the OS mid-run
— which deletes the classic "write a caching allocator" project unless pool
telemetry someday shows fragmentation. Freeing is layered: explicit
`dispose()` / `using` / a `tidy(fn)` scope as the documented norm (an 8-byte
JS handle can pin gigabytes the GC cannot see), tape nodes releasing saved
tensors deterministically as backward consumes them, and a
FinalizationRegistry backstop (`js/globals/crypto.ts` precedent).

**Streams.** Exactly two in v1: a compute stream, and an H2D stream feeding a
pinned ring buffer for DataLoader prefetch, ordered into compute with
`cuEventRecord`/`cuStreamWaitEvent`. Multi-stream correctness is where eager
engines rot; more streams wait for a demonstrated need.

**Capture/replay (phase 2, the dispatch-overhead endgame).** Training steps
are repetitive, and the engine already hashes its recorded graph each step.
After K consecutive steps with an identical hash, the next step re-executes
inside `cuStreamBeginCapture`/`cuStreamEndCapture`, is instantiated once, and
every subsequent step is a single `cuGraphLaunch`. The recorded graph is both
the capture key/invalidator (shape or control-flow change → fall back to
eager, recount) and the static memory plan capture requires (activations
planned into a per-step arena with fixed offsets). Changing scalars —
learning rate, step count — live in device memory updated before launch,
never baked into the capture. The ggml adapter implements the same plane with
`graph_plan_create/compute`; one interface, two implementations.

**Errors.** Kernel failures surface lazily. Every driver call's `CUresult` is
checked (cheap); failures detected at sync points carry the recorded-graph
span for attribution; `FINO_CUDA_SYNC=1` inserts a synchronize after every
launch for exact blame during debugging.

## 10. Autograd: a TypeScript Tape

Reverse-mode autodiff is implemented in TypeScript over the backend interface
— not delegated to any backend's native autodiff.

- Each tensor carries `requiresGrad`, an optional grad node (op, saved
  inputs/metadata, backward function producing input cotangents via ordinary
  backend ops), and `.grad`.
- `loss.backward()` topologically sorts from the loss, accumulates
  cotangents, writes `.grad` on leaves, and drops tape nodes deterministically
  as they are consumed — which is also the intermediate-memory story.
  Backward is just more eager dispatch: it enqueues kernels on the same
  stream and never blocks.
- `noGrad(fn)` / `enableGrad(fn)` are a synchronous mode stack (recording is
  synchronous, so no async-context machinery is needed).
- v1 exclusions: no in-place ops (no version counters), no higher-order
  gradients, no double backward, no distributed autograd. A
  `customGrad(forward, vjp)` escape hatch comes later.

Why a TS tape rather than a native one: it is portable across every backend
including the reference oracle (grad-check validates the tape and the kernels
independently), it delivers the PyTorch-style `loss.backward()` UX directly
rather than a grad-of-function transform, and its overhead is dispatch-cost —
kernel time dominates, and capture/replay removes even the dispatch cost in
steady-state training.

## 11. Public API Shape

Module family (registered in `src/loader.rs` like every builtin):

```
fino:tensor            Tensor, creation ops, free-function ops, eval, noGrad, Generator
fino:tensor/nn         Module, Linear, Embedding, LayerNorm, Dropout, Sequential, functional, init
fino:tensor/optim      SGD, Adam, AdamW, clipping, LR schedules
fino:tensor/io         safetensors/GGUF/npy load-save wired to engine storage
internal:cuda          driver/NVRTC/cuBLASLt binding (candidate-path dlopen, availability flag)
internal:ggml-backend  the breadth adapter
internal:tensor/backend  the DeviceBackend interface + registry
internal:tensor/ref    the TS reference oracle
```

Core surface:

```ts
class Tensor {
  readonly dtype: DType;              // 'f32' | 'f16' | 'bf16' | 'i32' | ...
  readonly shape: readonly number[];
  readonly device: Device;            // { type: 'cuda' | 'metal' | 'cpu', index?: number }
  readonly requiresGrad: boolean;
  grad: Tensor | null;
  // ops (each also a free function): add, sub, mul, div, matmul, relu, gelu,
  // exp, log, sum, mean, max, argmax, softmax, reshape, transpose, permute,
  // slice, concat, cast, to(device)
  backward(grad?: Tensor): void;
  data(): Promise<TypedArray>;         // the only sync points
  item(): Promise<number>;
  detach(): Tensor;
  dispose(): void; [Symbol.dispose](): void;
}
```

Design constraints:

- All tensors carry explicit dtype, shape, and device. Broadcasting follows
  NumPy/PyTorch semantics.
- Strides are *not* on the public surface. The engine records ops against
  logical shapes; layout is backend-owned. `reshape`/`transpose`/`slice` are
  graph ops, not pointer arithmetic the user performs. (A debug namespace can
  expose physical layout.)
- Copying is explicit or obvious; in-place mutation is deferred — it
  complicates autograd and aliasing.
- All randomness flows through an explicit seeded `Generator`; the reference
  backend uses the same key-splitting scheme, so trajectories are comparable
  across backends.

`fino:tensor/nn` is intentionally smaller than PyTorch: `Module` (parameter
registration, `train()`/`eval()`, `stateDict()`/`loadStateDict()`), `Linear`,
`Embedding`, `LayerNorm`, `Dropout`, `Sequential`, a `functional` namespace
(relu/gelu/softmax/logSoftmax/crossEntropy/mseLoss), and initializers — enough
to validate the substrate and support small models, adapters, classifiers,
and embedding heads. `fino:tensor/optim` ships SGD with momentum, Adam,
AdamW, gradient clipping, and cosine/linear schedules; `optimizer.step()`
ends at a flush point, matching the one-eval-per-step cadence.

Semantics are fixed before implementation in a contract document
(`tensor-contract.md`: dtype promotion, broadcast rules, view/copy semantics,
numerical accuracy policy, RNG scheme) so implementers never invent
semantics, and every public rule has an acceptance-test shape.

## 12. The Data Stack

Data is Arrow-first and streaming-first. Three modules, chosen so that
exactly one heavyweight native dependency exists and everything else is
TypeScript.

- **`fino:data/arrow` — pure-TS Arrow (shipped).** Full columnar type coverage
  (every Arrow logical type: primitives incl. f16, all decimals, utf8/binary
  and their large/view variants, temporal and interval types, list/large-list/
  list-view/fixed-size-list, struct, map, sparse/dense union, dictionary with
  delta/replacement, run-end-encoded, and the extension mechanism), the Arrow
  IPC stream and file formats (with LZ4/ZSTD body compression via
  `fino:compress`) built on the generic `fino:format/flatbuffers`, and the
  **Arrow C Data Interface** (`fino:data/arrow/cdata`) — `ArrowSchema`/
  `ArrowArray` structs via `structType` with a complete format-string codec,
  aliasing native memory through `Pointer.view`. (libarrow is a C++ giant with
  a separate GLib C layer; nanoarrow is designed to be vendored — neither is a
  sane dlopen target. The struct layouts themselves are the standard; Fino
  speaks them directly.)
- **`fino:database/duckdb` + `fino:data/frame` — DuckDB via dlopen (planned).** `libduckdb`
  (plain C API, brew/apt installable) is the one big dependency, and it pays
  for Parquet (read *and* write), CSV/JSON readers, remote/S3 ranged reads,
  and a vectorized SQL engine — the pandas-plus-polars equivalent in one
  dylib. Implementing Parquet in TS (thrift metadata, eight encodings, page
  compression) is a multi-month project DuckDB has already shipped; don't.
  `fino:data/frame` is a *lazy* DataFrame that builds an expression plan and
  compiles to SQL (the ibis/polars-lazy approach — predicate and projection
  pushdown for free), materializing as Arrow record batches. Binding style
  and dispose conventions mirror `js/database/sqlite.ts`.
- **`fino:data` — Dataset/DataLoader.** `Dataset` (random access) and
  `IterableDataset` (async iterable) with `map/filter/shuffle(buffer)/batch/
  take/split/interleave`; sources from CSV/JSONL (existing modules), Arrow
  IPC, Parquet/SQL (DuckDB), sqlite, HTTP, and the hub. `DataLoader` runs the
  decode/augment/tokenize pipeline on `fino:realm/pool` workers writing
  collated batches into SharedArrayBuffer slabs (a ring allocator); the
  training realm receives `{sab, offset, shape, dtype}` descriptors —
  zero-copy across realms today. Determinism is first-class: one seed derives
  per-worker/per-epoch streams; loaders expose `state()`/`restore()` so
  `fino:workflow` can checkpoint mid-epoch position.

The flow `Parquet → DataFrame → Arrow batch → column.toTensor() → GPU` is
pointer-passing at every boundary via `Pointer.view`.

## 13. The Rest of the Platform

What Python actually relies on beyond the tensor library, and Fino's answer
to each — ranked by necessity:

- **Tokenizers — `fino:text/tokenizer`, pure TS.** A reality check ruled out
  every native path: HuggingFace `tokenizers` is Rust with no official C ABI,
  sentencepiece exposes C++ only, and llama.cpp's tokenizer serves GGUF
  vocabs only (kept as an adapter). BPE/WordPiece over `tokenizer.json` is
  string processing TS handles fine, and DataLoader workers parallelize
  dataset-scale tokenization anyway. tiktoken format support is a cheap add;
  Unigram and BPE *training* come later.
- **Model hub — `fino:model/hub`.** A HuggingFace Hub client on Fino's own
  HTTP stack: revision-resolving downloads, resumable ranged fetches, sha256
  verification, a content-addressed cache (`blobs/sha256/<digest>` + per-repo
  manifests), and a project-level **`models.lock`** pinning
  repo → commit → digests. Reproducible model resolution as a default is
  something Python does not have. Bonus enabled by safetensors: per-tensor
  byte offsets mean the client can fetch a *single tensor* from a remote
  shard via HTTP Range — remote weight browsing without downloading.
- **Artifacts — `fino:model/artifacts`.** Engine-agnostic safetensors
  (read/write), GGUF metadata (independent of llama.cpp), npy/npz (near-free
  with `fino:archive`), config/tokenizer JSON helpers; readers produce
  `{dtype, shape, byteRange}` descriptors the engine materializes lazily,
  with sha256 integrity checks and a deterministic cache layout.
- **Notebooks.** The moat is real; the answer is layered. First, a **display
  protocol**: Jupyter's MIME-bundle convention, adopted verbatim — anything
  showable (DataFrame, Tensor, chart, tracked run) implements
  `[Symbol.for('fino.display')]() → { 'text/html': ..., 'text/plain': ... }`.
  Then a **native notebook** (`fino notebook`): HTTP server + `fino:ui` JSX
  frontend; cells execute in a persistent thread realm driven by the existing
  V8 inspector infrastructure (restart = kill realm; capability narrowing per
  notebook — something Jupyter cannot do). The file format is **plain
  TypeScript with `// %%` cell markers** — git-diffable, runnable as a
  script, type-checked — with `.ipynb` import/export. A real Jupyter kernel
  (five ZeroMQ sockets + JSON + HMAC; libzmq is a clean C dlopen) is v2.
- **Visualization — `fino:viz`, kept light.** Vega-Lite spec emission as the
  core (`plot(df).mark('line').x('epoch').y('loss')` → VL JSON), rendered by
  the notebook frontend, exportable as standalone HTML, with a `fino:tty/tui`
  sparkline fallback for loss curves in a terminal. No rendering engine is
  built.
- **Experiment tracking — `fino:train` + `fino:train/track`.** A
  sqlite-backed local store (runs, params, metric series, artifacts sharing
  the content-addressed blob store, git commit + data snapshot metadata),
  dual-emitting metrics to `fino:opentelemetry`; `fino track ui` serves a
  local dashboard. Training loops integrate with `fino:workflow`:
  epochs/eval/checkpoint as checkpointed steps plus DataLoader state, so a
  killed job resumes exactly. Durable-by-default training is a genuine
  differentiator; PyTorch resume is artisanal.
- **Later, in rough order:** `fino:media/image` (dlopen jpeg-turbo's `tj3*`
  C API + libpng; resize/normalize as tensor ops) — required for vision
  datasets; `fino:model/onnx` over ONNX Runtime's stable C API (`OrtApi`) for
  exported-model inference interop; NCCL (`libnccl`, plain C) for multi-GPU
  data parallelism; classical-ML utilities over tensor ops. Explicitly
  deferred: audio, distributed training beyond data-parallel, quantization
  frameworks beyond artifact inspection, HDF5.

## 14. Unification: One Framework, Not a Pile of Libraries

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

## 15. Product Wedges

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
- **Accelerated training on the primary target**: the CUDA-direct backend
  training real (small) models on Linux at PyTorch-eager-class step times,
  with the same script running on a Mac. Accelerator credibility is what
  separates a model factory from a math library.

## 16. Roadmap

- **Phase 0 — contracts and spikes.** `tensor-contract.md`; a CUDA spike on a
  Linux/NVIDIA box (bind ~25 driver
  symbols through `cuGetProcAddress`, NVRTC → cubin → launch round-trip,
  measure launch dispatch — target under ~3 µs/op, validate event-wait →
  wake-pipe readback end to end). The data track starts here too, in
  parallel: DuckDB binding, Arrow core, hub client, tokenizer — none of it
  waits on the engine.
- **Phase 1 — the credibility slice.** CUDA-direct core (driver, NVRTC +
  two-tier cache, cuBLASLt with epilogues, memory pool, two streams, ~30
  template kernels, bf16+fp32) + the ggml adapter (Metal parity, fast CPU) +
  BLAS + the TS tape + `nn`/`optim` + the differential-test harness.
  **Exit: train an MLP and a small transformer on Linux/NVIDIA within ~1.2×
  of PyTorch eager step time; the same script trains unchanged on an M-series
  Mac via ggml-Metal; every op and grad passes differentially against the TS
  oracle.**
- **Phase 2 — peak-efficiency Linux.** cuDNN v9 graph API (conv, fused
  SDPA); CUDA Graphs step-replay with static memory planning; pointwise
  fusion codegen; fp16 with loss scaling. Exit: transformer step time at or
  better than PyTorch eager; dispatch overhead in single-digit microseconds
  per step under replay.
- **Phase 3 — depth and Apple upgrade.** DataLoader/train/track/notebook UX
  hardening; checkpoint/resume through `fino:workflow`; reduction/epilogue
  fusion; NCCL data-parallel; Metal-direct via `objc_msgSend` with runtime
  MSL, gated on demonstrated Mac demand.
- **Phase 4 — breadth.** HIP/ROCm as a symbol-mirror of the CUDA backend;
  ONNX Runtime adapter; ggml-Vulkan remains the consumer-hardware answer;
  the Jupyter kernel; the tile DSL exploration begins when fusion codegen
  hits its ceiling.

## 17. What Not To Build First

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

These are not wrong goals. They are downstream of a working tensor runtime.

## 18. Risks and Open Questions

- **CUDA-stack claims are knowledge-based until the Phase 0 spike.** This
  design was researched on macOS; library presence, `cuGetProcAddress`
  behavior, and dispatch-cost targets need confirmation on a real
  Linux/NVIDIA box before Phase 1 commits.
- **cuDNN v9 descriptor-graph verbosity** is mechanical but large; budget it
  honestly in Phase 2.
- **Capture/replay assumes shape-stable steps.** Dynamic shapes (variable
  sequence lengths without bucketing) fall back to eager; the fallback must
  stay correct and fast enough that replay is an optimization, not a
  requirement.
- **ggml API churn.** The adapter binds a moving C surface maintained by the
  llama.cpp project; pin known-good versions in the candidate-path probe and
  test against brew's current formula.
- **DuckDB C-API Arrow-export surface varies across 1.x**; validate the
  function set against the installed version and keep the data-chunk API as
  fallback.
- **GC-invisible device memory** is the sharpest UX edge: scopes
  (`using`/`tidy`) must be the documented norm from the first example, or
  users will OOM the GPU with live-looking JS handles.

## 19. Success Criteria

Fino becomes credible as a TypeScript model factory when it can:

- load tabular/text data into efficient batches;
- create tensors with explicit dtype/device semantics;
- run a useful op set on CPU and the CUDA-direct backend;
- compute gradients and update parameters;
- train small models end-to-end at PyTorch-eager-class step times;
- load safetensors and inspect GGUF/ONNX artifacts;
- checkpoint and resume training — including through a process kill;
- export or serve the trained result from the same process;
- profile the full path.

The long-term ambition is larger: a TypeScript-first model factory where
data, models, training, artifacts, and serving live in one runtime. The
near-term proof is smaller and sharper: train useful small models, load real
artifacts, and accelerate the hot path without leaving Fino.

## Sources

- CUDA driver API: https://docs.nvidia.com/cuda/cuda-driver-api/
- NVRTC: https://docs.nvidia.com/cuda/nvrtc/
- cuBLASLt: https://docs.nvidia.com/cuda/cublas/#using-the-cublaslt-api
- cuDNN v9 graph API: https://docs.nvidia.com/deeplearning/cudnn/latest/developer/graph-api.html
- CUDA Graphs: https://docs.nvidia.com/cuda/cuda-c-programming-guide/#cuda-graphs
- HIP runtime API: https://rocm.docs.amd.com/projects/HIP/en/latest/
- NCCL: https://docs.nvidia.com/deeplearning/nccl/
- ggml (headers verified locally at /opt/homebrew/include/ggml*.h): https://github.com/ggml-org/ggml
- Apache Arrow overview: https://arrow.apache.org/overview/
- Apache Arrow C Data Interface: https://arrow.apache.org/docs/format/CDataInterface.html
- DLPack documentation: https://dmlc.github.io/dlpack/latest/
- DuckDB C API: https://duckdb.org/docs/api/c/overview
- Safetensors documentation: https://huggingface.co/docs/safetensors/index
- ONNX introduction: https://onnx.ai/onnx/intro/
- ONNX Runtime C API: https://onnxruntime.ai/docs/api/c/
- HuggingFace Hub API: https://huggingface.co/docs/hub/api
- Hugging Face Datasets: https://huggingface.co/docs/datasets/index
- Jupyter messaging protocol: https://jupyter-client.readthedocs.io/en/latest/messaging.html
- Vega-Lite: https://vega.github.io/vega-lite/
- PyTorch documentation: https://docs.pytorch.org/docs/2.12/index.html
- PyTorch CUDA semantics (the eager-async precedent): https://pytorch.org/docs/stable/notes/cuda.html
- TensorFlow tutorials and guide index: https://www.tensorflow.org/tutorials
- JAX documentation: https://docs.jax.dev/en/latest/
- Triton (the tile-DSL precedent): https://triton-lang.org/
- W3C WebGPU: https://www.w3.org/TR/webgpu/ and WGSL: https://www.w3.org/TR/WGSL/
