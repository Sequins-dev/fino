# Fino Tensor Engine

> Status: research and direction-setting document.
>
> Parent: [typescript-model-factory.md](./typescript-model-factory.md) — the
> model-factory strategy this engine anchors. Siblings:
> [data-stack.md](./data-stack.md), [model-artifacts.md](./model-artifacts.md),
> [ml-workbench.md](./ml-workbench.md),
> [inference-serving.md](./inference-serving.md),
> [classical-ml.md](./classical-ml.md).
>
> Scope: the tensor object model, execution model, accelerator backends,
> kernel strategy, memory semantics, autodiff, and the public `fino:tensor`
> API family. Data loading, artifact formats, and workbench UX live in the
> sibling docs. Cross-cutting conventions (dtype/device vocabulary,
> Arrow-as-tabular-currency, disposal/determinism/display) are defined in the
> parent.

## 1. The Execution Model

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
  tape serves three consumers: reverse-mode autodiff (§5), fusion codegen
  (§3), and capture/replay (§4). PyTorch records for autograd and then
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

## 2. Backend Architecture

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

### 2.1 Priority matrix

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
served by HIP), **WebGPU-first** (an earlier revision of the parent document
recommended WebGPU/WGSL as the first accelerator target; that is revised —
WebGPU's perf ceiling (no mature tensor-core path, no vendor GEMM library)
and the absence of an installed wgpu-native base make it a poor primary; a
WebGPU backend remains possible later behind the same interface, mostly for
browser alignment), and **any compiled C shim we'd have to ship** (a vendored
artifact; against the system-libraries philosophy).

### 2.2 CUDA-direct, the primary backend

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
~30 template kernels (§3). (An optional FFI improvement — f32/f64 scalar
support in the V8 Fast API path — would let float-attribute calls stay fast
too, but the design deliberately keeps floats out of hot signatures, so it is
a nicety.)

### 2.3 ggml, the breadth adapter — bounded on purpose

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

### 2.4 CPU

The pure-TS reference backend is the correctness oracle: naive loops, same
primitive interface, seedable RNG, CI-mandatory differential tests for every
op and every gradient on every accelerated backend. It is deliberately not
the fast CPU story. Fast CPU = dlopen BLAS for GEMM (`libopenblas.so.0` on
Linux; `Accelerate.framework` on macOS — dlopen-able, same CBLAS symbols)
plus ggml-CPU for the rest, via the adapter that exists anyway.

### 2.5 Metal-direct, later, without a shim

Metal has no C API, but the Objective-C *runtime* does: `libobjc.A.dylib`
exposes `objc_getClass`, `sel_registerName`, and `objc_msgSend` — plain C,
and on arm64 there are no fragile `_stret` variants to worry about. This is
how metal-rs and Julia bind Metal without writing Objective-C. Fino's FFI can
do the same: one dlopen alias per selector signature. Blocks (for completion
handlers) have a documented plain-C struct layout constructible with
`structType` + `FfiCallback` — or are avoided entirely by waiting on a
`MTLSharedEvent` from the blocking pool. Runtime MSL compilation
(`newLibraryWithSource:`) is the NVRTC analog, so the kernel-codegen path
(§3) ports. This is fiddly but philosophically clean and entirely in TS. It
is scheduled as a demand-gated upgrade: the Mac's job is development parity,
which ggml-Metal covers; Metal-direct happens only if Mac training throughput
turns out to matter.

## 3. Kernel Strategy: the Compiler Lives in TypeScript

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

## 4. Execution and Memory, Precisely

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

## 5. Autograd: a TypeScript Tape

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

## 6. Public API Shape

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

Two layers over this family are specced in sibling docs: dense linear
algebra (`fino:tensor/linalg`, LAPACK from the same BLAS binaries) and the
estimators above it in [classical-ml.md](./classical-ml.md); the serving
layer that drives forward-only inference at scale in
[inference-serving.md](./inference-serving.md).

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

## 7. Roadmap

The engine's slice of the parent roadmap:

- **Phase 0 — contracts and spikes.** `tensor-contract.md`; a CUDA spike on a
  Linux/NVIDIA box (bind ~25 driver symbols through `cuGetProcAddress`,
  NVRTC → cubin → launch round-trip, measure launch dispatch — target under
  ~3 µs/op, validate event-wait → wake-pipe readback end to end). The data
  track proceeds in parallel and does not wait on the engine — see
  [data-stack.md](./data-stack.md) and
  [model-artifacts.md](./model-artifacts.md).
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
- **Phase 3 — depth and Apple upgrade (engine slice).** Reduction/epilogue
  fusion; NCCL data-parallel; Metal-direct via `objc_msgSend` with runtime
  MSL, gated on demonstrated Mac demand. (DataLoader hardening and the
  train/track/notebook UX land in the sibling docs' Phase 3 slices.)
- **Phase 4 — breadth (engine slice).** HIP/ROCm as a symbol-mirror of the
  CUDA backend; ggml-Vulkan remains the consumer-hardware answer; the tile
  DSL exploration begins when fusion codegen hits its ceiling. (The ONNX
  Runtime adapter and the Jupyter kernel belong to
  [model-artifacts.md](./model-artifacts.md) and
  [ml-workbench.md](./ml-workbench.md).)

## 8. Risks and Open Questions

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
- **GC-invisible device memory** is the sharpest UX edge: scopes
  (`using`/`tidy`) must be the documented norm from the first example, or
  users will OOM the GPU with live-looking JS handles.

## Sources

- CUDA driver API: https://docs.nvidia.com/cuda/cuda-driver-api/
- NVRTC: https://docs.nvidia.com/cuda/nvrtc/
- cuBLASLt: https://docs.nvidia.com/cuda/cublas/#using-the-cublaslt-api
- cuDNN v9 graph API: https://docs.nvidia.com/deeplearning/cudnn/latest/developer/graph-api.html
- CUDA Graphs: https://docs.nvidia.com/cuda/cuda-c-programming-guide/#cuda-graphs
- HIP runtime API: https://rocm.docs.amd.com/projects/HIP/en/latest/
- NCCL: https://docs.nvidia.com/deeplearning/nccl/
- ggml (headers verified locally at /opt/homebrew/include/ggml*.h): https://github.com/ggml-org/ggml
- DLPack documentation: https://dmlc.github.io/dlpack/latest/
- PyTorch documentation: https://docs.pytorch.org/docs/2.12/index.html
- PyTorch CUDA semantics (the eager-async precedent): https://pytorch.org/docs/stable/notes/cuda.html
- Triton (the tile-DSL precedent): https://triton-lang.org/
- W3C WebGPU: https://www.w3.org/TR/webgpu/ and WGSL: https://www.w3.org/TR/WGSL/
