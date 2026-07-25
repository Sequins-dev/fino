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
> Scope: the tensor object model, the graph, execution semantics, hardware
> backends, kernel strategy, memory semantics, autodiff, and the public
> `fino:tensor` API family. Data loading, artifact formats, and workbench UX
> live in the sibling docs.
>
> **Revision note.** Three earlier positions are revised. CUDA/NVIDIA does not
> anchor the architecture. **ggml is not a backend** — this engine is written
> to replace it, which means owning our own kernels (§2.7). And there is no
> single portable GPU API in the middle: each platform is driven through *its
> own* lowest-level documented interface — Metal on Apple, Vulkan on
> Linux/Windows/Android, the CUDA driver API on NVIDIA — with no translation
> layer between us and the hardware. The only abstraction in the design is the
> one we own: a generic tensor graph framework above a thin, native backend
> interface.

## 1. The Shape of the Thing

Two layers, and the split is the whole architecture.

**Above: a generic tensor graph modelling framework.** Backend-neutral
TypeScript — the Tensor object model, dtype/shape/device semantics, the
recorded graph, autodiff, `nn`/`optim`, the kernel IR and template library,
fusion. This is where essentially all of the engine's code and all of its
semantics live, and it is hardware-agnostic by construction.

**Below: thin, native, close-to-hardware backends.** Each target is driven
through the lowest-level interface its platform actually documents. No
portability layer, no translation shim, no third-party runtime interposed.
Where a platform's own API *is* the abstraction (Metal, Vulkan, the CUDA
driver API), that is the floor we build on; going below it means undocumented
per-vendor kernel interfaces, which is not feasible and not useful.

The framework accelerates with whatever hardware is present. Today that means
GPUs. The interface is deliberately shaped so that the *other* class of
accelerator — fixed-function NPUs and TPUs, which do not run arbitrary kernels
and instead consume whole graphs — is a first-class backend category rather
than a retrofit (§2.6). That forward compatibility is a design constraint now,
not a later problem, because it determines the shape of the backend interface
and it is the second reason the recorded graph is public API (§6).

## 2. Execution Semantics and Backends

### 2.1 The execution model

A PyTorch-equivalent eager API where

```ts
const c = a.matmul(b).relu();
```

returns immediately, work is already in flight on the device by the time the
next statement runs, the executed graph is being recorded as it happens, and
the only synchronization points in the entire programming model are reading
values back out:

```ts
const loss = await lossTensor.item();   // the ONLY place anyone waits
```

- **Dispatch is eager and non-blocking.** Every op call performs real work
  immediately: it allocates an output buffer from a stream-ordered pool and
  enqueues a kernel on the device queue. Kernel launch is inherently
  asynchronous — the CPU cost is microseconds — so the JS thread never waits
  on the device during forward or backward.
- **The graph is recorded at dispatch time.** Each op appends a node (op kind,
  input/output handles, attributes) to a per-context tape. The tape serves
  five consumers: reverse-mode autodiff (§5), fusion codegen (§4),
  capture/replay (§3), whole-graph submission to fixed-function accelerators
  (§2.6), and — because it is public — whatever a user builds on it.
- **Synchronization is explicit and promise-shaped.** `await t.data()`,
  `await t.item()`, checkpointing, and cross-device transfer are the only
  sync points. "Blocking" means a worker on the runtime's blocking pool parks
  on a device fence and resolves a promise through the wake pipe — the event
  loop keeps running.

Python cannot make this pleasant — `tensor.item()` blocks the whole
interpreter, and asyncio and device queues live in different universes. Here
readback is just a promise, and the event loop can serve HTTP, stream logs, or
drive a dashboard while a step executes.

**Two backend classes, from the start.** Kernel-programmable devices (GPUs)
take work per op and compile our kernels. Fixed-function devices (NPUs/TPUs)
take a whole subgraph and run it with their own implementations. The eager API
is identical either way; on a graph-submitting backend, dispatch records and
submission happens at the next flush point, which is where evaluation was
going to happen anyway. The interface names the difference so higher layers
never guess.

### 2.2 The backend interface

Roughly 60–70 primitive ops plus orthogonal capability planes (memory,
ordering, kernel-compile, capture/replay, graph-submit). All handles are
opaque pointers. This interface is **public** (`fino:tensor/backend`) so
backends can be implemented out-of-tree.

```ts
interface DeviceBackend {
  readonly caps: {
    class: 'kernel' | 'graph';          // programmable GPU vs fixed-function NPU
    kernelCompile: 'msl' | 'spirv' | 'cuda-c' | false;
    dispatch: 'per-op' | 'graph-flush';
    captureReplay: boolean;
    dtypes: DType[];
    subgroups: boolean; cooperativeMatrix: boolean;   // GEMM strategy inputs
    pinnedHost: boolean; unifiedMemory: boolean;
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
  supportsOp?(op: OpKind, operands: TensorDesc[]): boolean;
  // kernel plane (caps.class === 'kernel')
  compileKernel(ir: KernelIR, entry: string, cacheKey: string): Promise<Kernel>;
  launch(k: Kernel, grid: V3, block: V3, params: ArrayBuffer, shmem: number, s: Stream): void;
  // graph plane (caps.class === 'graph')
  compileGraph?(g: RecordedGraph, io: GraphIO): Promise<CompiledGraph>;
  runGraph?(cg: CompiledGraph, inputs: TensorDesc[], outputs: TensorDesc[], s: Stream): void;
  // capture plane (caps.captureReplay only)
  captureBegin(s: Stream): void;
  captureEnd(s: Stream): Executable;
  replay(x: Executable, s: Stream): void;
}
```

### 2.3 Priority matrix

Peers, not a hierarchy with a portable API on top. Each row is that platform's
own lowest documented interface.

| Priority | Target | Backend | Binding | Kernel dialect |
|---|---|---|---|---|
| P0 | Correctness oracle + universal fallback | TS reference | none | — |
| P0 | Dense CPU math | BLAS + LAPACK | dlopen OpenBLAS / Accelerate | — |
| P0 | **Apple GPU** (the dev platform) | **Metal-direct** | dlopen `libobjc.A.dylib` + Metal framework via `objc_msgSend` | MSL, runtime-compiled |
| P1 | **Linux / Windows / Android GPUs** (AMD, Intel, NVIDIA, Mali) | **Vulkan-direct** | dlopen `libvulkan.so.1` | SPIR-V, emitted from TS |
| P1 | **NVIDIA**, where the vendor libraries are decisive | **CUDA driver API** | dlopen `libcuda.so.1`, `libnvrtc`, `libcublasLt`, `libcudnn` | CUDA C via NVRTC |
| P2 | AMD / Intel native, if Vulkan proves insufficient | HIP / Level Zero | dlopen `libamdhip64` / `libze_loader` | HIP-C / SPIR-V |
| P3 | **Fixed-function NPUs and TPUs** | graph-submitting backends (§2.6) | per-vendor C APIs | none — graph in |

Sequencing logic: Metal first because Apple Silicon is the development machine,
so it is the only target that gives real GPU acceleration in the daily
iteration loop with no absent hardware and no translation layer. Vulkan second
because it is the breadth target — one backend for every non-Apple GPU. CUDA
third, for the things neither Metal nor Vulkan has an answer to (cuBLASLt
epilogues, cuDNN fused attention, the most mature tensor-core path).

**MoltenVK is explicitly not a shipping path.** It is a Vulkan-on-Metal
translation layer, which is precisely the kind of interposed abstraction this
design avoids — the Apple answer is Metal-direct. Its one legitimate use is as
a *development stand-in*: it lets the Vulkan backend be exercised on a Mac
before Linux GPU hardware is available. Likewise **lavapipe** (Mesa's software
Vulkan) is a CI correctness target for SPIR-V with no GPU present, not a
performance path.

### 2.4 Metal-direct

Metal has no C API, but the Objective-C *runtime* does: `libobjc.A.dylib`
exposes `objc_getClass`, `sel_registerName`, and `objc_msgSend` — plain C, and
on arm64 there are no fragile `_stret` variants to worry about. This is how
metal-rs and Julia bind Metal without writing Objective-C, and Fino's FFI can
do the same with one dlopen alias per selector signature. The pieces needed are
few and well-trodden: `MTLDevice`, `MTLCommandQueue`, `MTLBuffer`,
`MTLLibrary`/`MTLFunction`, `MTLComputePipelineState`, `MTLCommandBuffer`,
`MTLComputeCommandEncoder`, and `MTLSharedEvent` for the ordering plane.
Completion-handler blocks have a documented plain-C layout constructible with
`structType` + `FfiCallback`, or are avoided entirely by waiting on an
`MTLSharedEvent` from the blocking pool.

Two properties make it a good first target. Runtime MSL compilation
(`newLibraryWithSource:`) is a text dialect, so kernel emission is
string assembly — the simplest of the three lowerings. And Apple Silicon's
unified memory removes the H2D staging problem entirely on the dev machine,
which isolates variables while the rest of the engine stabilizes.

### 2.5 Vulkan-direct, with SPIR-V emitted from TypeScript

Vulkan is the breadth target: one backend covering AMD, Intel, NVIDIA, and ARM
Mali on Linux, plus Windows and Android. It is also the lowest portable
interface those platforms document — below it are per-vendor kernel ioctls.

The enabling move is how kernels get compiled. The conventional path is
GLSL → SPIR-V through shaderc/glslang, a C++ dependency that is not reliably
installed anywhere. The Fino-native path skips it: **emit SPIR-V binary
directly from TypeScript.** SPIR-V is a plain stream of 32-bit words with a
simple module structure — header, capabilities, extensions, decorations, type
declarations, then functions in SSA form. Assembling it in TS is the same
category of work this repo does routinely: `fino:format/flatbuffers`,
`internal:format/thrift`, the Arrow IPC codec, native Parquet, the DNS wire
format, QUIC and HTTP/3 framing, the Postgres wire protocol. It is arguably
*easier* to emit than a text dialect — there is no grammar to satisfy, just a
specified binary layout and SSA discipline.

The cost, honestly: Vulkan's setup surface is verbose — instance, physical
device selection, queue families, memory heaps and types, buffers, descriptor
set layouts, pipeline layouts, compute pipelines, command buffers, timeline
semaphores. All mechanical, a good fit for a TS builder layer, but a real body
of work before the first kernel runs. Two features matter for performance and
are extension- and vendor-dependent: **subgroup operations** (fast reductions)
and **cooperative matrix** (`VK_KHR_cooperative_matrix`, the portable route to
tensor-core-class GEMM). Both are queried into `caps`, and both have scalar
fallbacks, so functionality never depends on them — only speed does.

### 2.6 Designing now for NPUs and TPUs

Fixed-function AI accelerators are the eventual second hardware class, and they
work nothing like GPUs: they do not run arbitrary kernels. Their interfaces
consume a *graph* — a set of supported ops with supported shapes and dtypes —
compile it ahead of execution, and run it. Apple's ANE (through CoreML),
NVIDIA's TensorRT, Intel's NPU (through Level Zero / OpenVINO), Qualcomm's
Hexagon (QNN), AMD's XDNA, and Google's Edge TPU all share that shape.

Three consequences the design absorbs now, cheaply, rather than later,
expensively:

1. **`caps.class: 'kernel' | 'graph'`** exists from the first commit. A graph
   backend implements `compileGraph`/`runGraph` and no kernel plane; the engine
   never assumes a device can compile a kernel.
2. **`supportsOp` is part of the interface**, because fixed-function devices
   support a *subset* of ops, shapes, and dtypes, and the framework has to
   partition a graph into device-executable subgraphs with the remainder
   falling back to a kernel backend or the CPU. That partitioning belongs to
   the framework, is hardware-agnostic, and is the natural home for it.
3. **The recorded graph is a public, well-specified structure** (§6), because
   it is the lowering source for every such backend. A vendor graph API wants
   a graph; ours is the thing that gets lowered into theirs. This is the
   second independent reason `fino:tensor/graph` is public API, alongside
   fusion, ONNX export, and visualization.

None of this is built now. All of it is *shaped for* now, and the cost of
doing so is three fields and one optional method.

### 2.7 The CPU tier — and the one place "replace" is genuinely hard

Two distinct roles, deliberately separated.

**The reference backend** is pure TS: naive loops, the same primitive
interface, seedable RNG. It is the correctness oracle — CI-mandatory
differential tests for every op and every gradient on every other backend —
and it is also a *shipping* backend and the universal fallback. A machine with
no GPU and no BLAS still runs `fino:tensor`, just slowly. That property is what
lets the artifact, metrics, linalg, and DataFrame-to-tensor layers depend on
`fino:tensor` unconditionally, and it is why the CPU slice ships first (§7).

**Fast CPU** is dlopen BLAS for GEMM (`libopenblas.so.0` on Linux;
`Accelerate.framework` on macOS — dlopen-able, same CBLAS symbols), with
LAPACK arriving inside the same binaries at no extra deployment cost
(verified: brew's OpenBLAS installs `liblapack.dylib` beside `libblas.dylib`),
plus thread parallelism over `fino:realm/pool` and SharedArrayBuffer.

This is the weakest part of the replacement story and it should be said
plainly: **ggml-CPU is hand-written SIMD specialized per microarchitecture,
and TypeScript cannot emit SIMD.** There is no JS-visible vector intrinsic, so
memory-bound CPU kernels are scalar loops that V8 JITs reasonably but not
close to hand-tuned NEON or AVX-512. For GEMM-dominated work BLAS closes the
gap entirely, and for tabular and classical-ML workloads
([classical-ml.md](./classical-ml.md)) BLAS plus realm-pool parallelism is
genuinely sufficient. For CPU-bound LLM inference it is not, and pretending
otherwise would be dishonest: the engine's answer there is "use an
accelerator." If it ever becomes the binding constraint, the options are a
narrow compiled artifact for CPU kernels only — against the philosophy, and
therefore an explicit decision — or accepting the gap.

### 2.8 What role ggml and llama.cpp keep

None as a backend. Adapting `ggml-backend.h` would forfeit exactly what makes
this engine worth building: ggml's custom ops execute CPU callbacks only
(`ggml_map_custom*`), so it structurally cannot host our kernels, and choosing
it would cap efficiency at whatever ggml ships. Two bounded, non-architectural
roles remain:

- **The benchmark bar.** ggml is a well-optimized, widely-deployed
  implementation of the same workloads, so "within X% of ggml on this device"
  is a far more meaningful target than an abstract roofline figure. Its op
  coverage is also a useful checklist for ours.
- **The transitional inference provider.** `fino:ai/model/local` already binds
  llama.cpp and serves real GGUF models today. It stays until the engine can
  supersede it — see [inference-serving.md](./inference-serving.md), which
  treats it as transitional rather than a destination.

Separately and unaffected: **GGUF the file format** is worth reading, and
`fino:model/artifacts` reads it independently of ggml
([model-artifacts.md](./model-artifacts.md)). Reading a format is not
depending on an implementation.

### 2.9 Rejected, and why

- **ggml-backend as our backend** — §2.8.
- **MoltenVK as the Apple path** — a translation layer between us and Metal;
  Metal-direct is the answer. Retained only as a development stand-in (§2.3).
- **wgpu-native / WebGPU** — no system-installed base, so binding it means
  vendoring a compiled artifact; and it sits *above* Vulkan and Metal, adding
  a layer between us and the hardware for no benefit once we emit SPIR-V and
  MSL ourselves.
- **MLX/mlx-c** — Apple-first, and it would impose its lazy-graph model on our
  execution semantics.
- **OpenCL** — deprecated on Apple, uneven on modern NVIDIA, strictly
  worse-supported than Vulkan going forward.
- **SYCL/oneAPI** — C++ surface, Intel-centric; Level Zero is the
  close-to-hardware Intel option if one is ever needed.
- **shaderc/glslang for kernel compilation** — a C++ dependency that is not
  reliably installed, and unnecessary once SPIR-V is emitted directly.
- **Any compiled C shim we would have to ship** — a vendored artifact. The one
  place this may deserve reconsideration is vectorized CPU kernels (§2.7).

## 3. Execution and Memory, Precisely

**Dispatch (hot path, all sync fast-FFI).** Op recorded on the tape → output
buffer from the pool → params block written into a reusable ArrayBuffer →
kernel enqueued (an `MTLComputeCommandEncoder` dispatch, `vkCmdDispatch` into
a recorded command buffer, or `cuLaunchKernel`). Launches cost microseconds of
CPU and return immediately. On Vulkan, command-buffer recording and descriptor
updates are the dispatch overhead to watch — descriptor pools and push
constants for scalar params keep it low. On Metal, encoder reuse plays the
same role.

**Readback (`await t.data()` / `t.item()`).** Async D2H copy into pinned
staging → record a fence, timeline semaphore, or `MTLSharedEvent` → wait on it
through a symbol declared `async: true` → resolves on the blocking pool →
wake pipe → `Pointer.view` over the pinned staging buffer (zero-copy; the
view's release callback recycles the staging slot). The in-flight readback
table holds a strong reference to the tensor so its handle cannot be finalized
while a pool thread waits. A training loop keeps roughly one waiter
outstanding. On unified-memory Apple hardware the staging copy collapses
entirely.

**Memory.** A size-bucketed, stream-ordered pool over each backend's native
allocator: Vulkan device memory sub-allocated from a few large
`vkAllocateMemory` heaps (Vulkan's allocation count is limited, so
sub-allocation is mandatory rather than an optimization), `MTLBuffer` from
`MTLHeap`, CUDA's `cuMemAllocAsync` pool with the release threshold set high.
Pool telemetry decides whether fragmentation ever justifies more
sophistication. Freeing is layered: explicit `dispose()` / `using` / a
`tidy(fn)` scope as the documented norm (an 8-byte JS handle can pin gigabytes
the GC cannot see), tape nodes releasing saved tensors deterministically as
backward consumes them, and a FinalizationRegistry backstop
(`js/globals/crypto.ts` precedent).

**Streams.** Exactly two in v1: a compute stream, and an H2D stream feeding a
pinned ring buffer for DataLoader prefetch, ordered into compute with an
event. Multi-stream correctness is where eager engines rot; more wait for a
demonstrated need.

**Capture/replay (the dispatch-overhead endgame).** Training steps are
repetitive, and the engine already hashes its recorded graph each step. After K
consecutive steps with an identical hash, the step is instantiated once as an
executable and every subsequent step is a single submission. The recorded graph
is both the capture key/invalidator (shape or control-flow change → fall back
to eager, recount) and the static memory plan capture requires (activations
planned into a per-step arena at fixed offsets). Changing scalars — learning
rate, step count — live in device memory updated before launch, never baked
into the capture. On Metal and Vulkan this is a pre-recorded command
buffer resubmitted per step, which is simpler and cheaper than the CUDA Graphs
equivalent; on CUDA it is `cuStreamBeginCapture`/`cuGraphLaunch`.

**Errors.** Failures surface lazily. Every call's status is checked (cheap);
failures detected at sync points carry the recorded-graph span for
attribution; `FINO_TENSOR_SYNC=1` synchronizes after every launch for exact
blame. Vulkan validation layers and Metal's API validation are enabled under a
debug flag and are the primary development safety nets.

## 4. Kernel Strategy: the Framework *Is* the Compiler

Because no backend brings an op library, this is not an optimization phase —
it is the engine's substance. Split the op set by roofline position.

**Math-bound ops.** GEMM, batched matmul, convolution, fused attention. Where
the platform ships a library worth using, use it: cuBLASLt (with epilogue
fusion) and cuDNN on CUDA, CBLAS on CPU. On Metal, MPS is an option for GEMM
and is worth measuring against our own. **On Vulkan there is no vendor GEMM
library, so we write it** — the single hardest kernel in the engine. A
competent tiled implementation (shared-memory tiling, register blocking,
vectorized loads, double buffering, cooperative matrix where `caps` reports it)
reaches a respectable fraction of peak; matching hand-tuned cuBLAS is a career,
not a milestone. The honest target: **within a stated factor of the best
available library on platforms that have one, and best-available-anywhere on
platforms that do not.**

**Memory-bound ops — roughly 30 primitives.** Elementwise unary/binary with
broadcasting, reductions, softmax/log-softmax, layer/RMS-norm forward and
backward, embedding gather / scatter-add, optimizer updates, dropout, cast,
transpose/copy. Their cost is bandwidth and the win is fusion. Here there is no
vendor library to fight — PyTorch eager doesn't fuse either, so
template-quality kernels reach parity and fusion beats it.

The pipeline, over a **dialect-neutral kernel IR** so one template set serves
every target:

1. **Templates first.** Each op is a TS function emitting IR specialized by
   dtype, contiguity/broadcast pattern (collapse dimensions first; specialize
   contiguous / outer-broadcast / general strided), and vector width.
   Grid-stride loops; two-pass or block-then-atomic reductions; Welford for
   norm statistics. A few KB per kernel.
2. **Three lowerings, one numerics implementation.** MSL and CUDA C are text
   dialects; SPIR-V emits binary words. A thin per-dialect layer handles entry
   points, thread-index intrinsics, `threadgroup` vs `shared` vs `Workgroup`
   storage class, and subgroup intrinsics. Designing the IR against at least
   two dialects *before* implementing either is what keeps it honest — see the
   Phase 0 spike (§7).
3. **Kernel cache, two tiers.** Key = hash of (canonical IR, target, compiler
   version, flags). In-memory map of loaded kernel handles; on-disk
   `~/.fino/kernels/<target>/<hash>.bin` so each kernel compiles once per
   machine and loads in under a millisecond thereafter. Compiles run on the
   blocking pool via `async: true`; because dispatch is asynchronous anyway,
   subsequent ops queue behind a compile without ever blocking the event loop.
   Templates are pre-warmed at device init. On the SPIR-V path there is no
   external compiler in the loop at all — emission is our code — so "compile"
   is assembly plus `vkCreateShaderModule`.
4. **Fusion codegen over the recorded graph.** At flush time, a peephole pass
   finds maximal regions of elementwise ops (plus an optional leading gather or
   trailing reduction) sharing a shape domain and emits one kernel: load inputs
   once, compute the chain in registers, store outputs once. Classic wins:
   bias+GELU+residual+cast in one kernel instead of four; AdamW over a
   flattened parameter group as one launch instead of one per tensor; fused
   softmax-cross-entropy. The numerically hard 10% (stable reductions inside
   fused regions, shared-memory staging) stays in hand-written skeletons the
   fuser instantiates.
5. **A tile DSL, later.** A Triton-like tile/block-level builder API (TS has no
   operator overloading, so builder- or tagged-template-based) lowering to the
   same IR. This is where a serious fused-attention kernel eventually comes
   from on the Vulkan and Metal paths. Deferred until template-plus-fusion
   hits its ceiling.

The deep point: because the FFI is fast and kernel compilation is either a
platform library or a binary format we emit ourselves, **the compiler is
ordinary TypeScript** — no build step, no offline toolchain, inspectable and
modifiable at runtime. That is the "everything in JS" philosophy applied to GPU
codegen, it is why this engine can live inside a JS runtime at all, and it is
unreachable by wrapping someone else's kernels.

## 5. Autograd: a TypeScript Tape

Reverse-mode autodiff in TypeScript over the backend interface. There is no
native autodiff to delegate to, and that is the intended state: the tape is
ours and portable across every backend including the reference oracle.

- Each tensor carries `requiresGrad`, an optional grad node (op, saved
  inputs/metadata, backward function producing input cotangents via ordinary
  backend ops), and `.grad`.
- `loss.backward()` topologically sorts from the loss, accumulates cotangents,
  writes `.grad` on leaves, and drops tape nodes deterministically as they are
  consumed — which is also the intermediate-memory story. Backward is just
  more eager dispatch: it enqueues kernels on the same stream and never blocks.
- `noGrad(fn)` / `enableGrad(fn)` are a synchronous mode stack (recording is
  synchronous, so no async-context machinery is needed).
- v1 exclusions: no in-place ops (no version counters), no higher-order
  gradients, no double backward, no distributed autograd. A
  `customGrad(forward, vjp)` escape hatch comes later.

Why a TS tape: it is portable across every backend including the oracle
(grad-check validates the tape and the kernels independently), it delivers
`loss.backward()` directly rather than a grad-of-function transform, and its
overhead is dispatch-cost — kernel time dominates, and capture/replay removes
even that in steady-state training.

## 6. Public API Shape

```
fino:tensor            Tensor, creation ops, free-function ops, eval, noGrad, Generator
fino:tensor/graph      the recorded graph: node kinds, traversal, hashing, partition, compile/replay
fino:tensor/backend    the DeviceBackend interface, device registry, registration
fino:tensor/nn         Module, Linear, Embedding, LayerNorm, Dropout, Sequential, functional, init
fino:tensor/optim      SGD, Adam, AdamW, clipping, LR schedules
fino:tensor/io         safetensors/GGUF/npy load-save wired to engine storage
fino:tensor/linalg     LAPACK-backed decompositions (see classical-ml.md)
internal:tensor/ref    the TS reference oracle
internal:tensor/ir     the dialect-neutral kernel IR + template library
internal:metal         objc_msgSend binding + runtime MSL compilation
internal:spirv         the SPIR-V emitter
internal:vulkan        Vulkan loader/device/pipeline/command plumbing
internal:cuda          driver/NVRTC/cuBLASLt binding (candidate-path dlopen, availability flag)
```

**The graph and backend interfaces are public, deliberately.** They are core
building blocks other work depends on, not engine internals:

- `fino:tensor/graph` exposes the recorded tape as an inspectable, traversable
  structure with stable node kinds and a content hash, plus the partitioning
  used to split a graph across devices of different capability. Consumers: the
  fusion pass, capture/replay, **lowering to fixed-function accelerator graph
  APIs** (§2.6), ONNX export ([model-artifacts.md](./model-artifacts.md)),
  visualization and profiling ([ml-workbench.md](./ml-workbench.md)), and any
  user-built pass. The graph is not an IR project — it is a recording with a
  documented shape — but it is the seam where compilation, hardware lowering,
  and interchange all attach, so it is public from the start rather than
  extracted later under pressure.
- `fino:tensor/backend` exposes the interface *and* the registry, so a backend
  can be implemented and registered **out-of-tree** — including for hardware
  nobody here owns. The differential harness is the contract they test
  against.
- The *bindings* stay `internal:*` — platform plumbing with no stable surface.
  What is public is the interface they satisfy. (`internal:spirv` is a
  candidate for later promotion: a SPIR-V emitter is generally useful, like
  `fino:format/flatbuffers`.)

Publishing these raises the stakes on semantics: a public interface is a
stability commitment, and a backend interface is the worst kind to churn
because out-of-tree implementations break silently. Two mitigations:
`tensor-contract.md` is a prerequisite, not a nicety; and the family ships
behind an explicit experimental marker until two in-tree backends and one
out-of-tree implementation have exercised it — the point at which an interface
stops being a guess.

Core surface:

```ts
class Tensor {
  readonly dtype: DType;              // 'f32' | 'f16' | 'bf16' | 'i32' | ...
  readonly shape: readonly number[];
  readonly device: Device;            // { type: 'cpu' | 'metal' | 'vulkan' | 'cuda', index?: number }
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

- All tensors carry explicit dtype, shape, and device. Shapes are
  N-dimensional with NumPy/PyTorch broadcasting — no backend imposes a
  dimension ceiling, because no backend is someone else's.
- Device identity names the *backend*, and devices are discovered rather than
  assumed. `device('auto')` resolves through the registry by capability, so
  the same script runs on Metal, Vulkan, CUDA, or plain CPU without edits.
- Strides are *not* on the public surface. The engine records ops against
  logical shapes; layout is backend-owned. `reshape`/`transpose`/`slice` are
  graph ops, not pointer arithmetic the user performs. (A debug namespace can
  expose physical layout.)
- Copying is explicit or obvious; in-place mutation is deferred.
- All randomness flows through an explicit seeded `Generator`; the reference
  backend uses the same key-splitting scheme, so trajectories are comparable
  across backends.

`fino:tensor/nn` is intentionally smaller than PyTorch: `Module` (parameter
registration, `train()`/`eval()`, `stateDict()`/`loadStateDict()`), `Linear`,
`Embedding`, `LayerNorm`, `Dropout`, `Sequential`, a `functional` namespace
(relu/gelu/softmax/logSoftmax/crossEntropy/mseLoss), and initializers — enough
to validate the substrate and support small models, adapters, classifiers, and
embedding heads. `fino:tensor/optim` ships SGD with momentum, Adam, AdamW,
gradient clipping, and cosine/linear schedules.

Semantics are fixed before implementation in a contract document
(`tensor-contract.md`: dtype promotion, broadcast rules, view/copy semantics,
numerical accuracy policy, RNG scheme, and the graph-partitioning rules for
mixed-capability devices) so implementers never invent semantics, and every
public rule has an acceptance-test shape.

## 7. Roadmap

Sequenced so each phase leaves something useful standing, because the full
ambition is large and a plan that only pays off at the end is a plan that gets
abandoned.

- **Phase 0 — contracts and the two-dialect spike.**
  - `tensor-contract.md` and a first cut of the kernel IR.
  - **The decisive spike: one trivial kernel (elementwise add) through *both*
    a text dialect and the binary one.** Emit MSL, compile it with
    `newLibraryWithSource:` through `objc_msgSend`, dispatch on an
    `MTLComputeCommandEncoder`, read back through `MTLSharedEvent` →
    `async: true` → wake pipe. Then emit the same IR as SPIR-V words from
    TypeScript, load through `vkCreateShaderModule`, dispatch, read back
    through a fence. Doing both proves the IR is genuinely dialect-neutral
    rather than Metal-shaped, and it de-risks the SPIR-V emitter — the
    highest-stakes unknown in the design. The Metal half runs natively on the
    dev machine; the Vulkan half runs via MoltenVK as a stand-in, or lavapipe
    for GPU-less correctness.
  - The arm64-Linux deployment probe: candidate-path resolution for
    `libvulkan`/`libopenblas` under a minimal container image, LAPACK LP64 vs
    ILP64 detection, reference-oracle differential tests green on arm64.
  - In parallel, waiting on nothing: shared conventions, `fino:ml/metrics`,
    the hub client and tokenizer, the data-stack consumers
    ([next-steps.md](./next-steps.md)).
- **Phase 1 — the portable core (ships, useful immediately).** Tensor object
  model, N-d shapes with broadcasting, the TS tape, `nn`/`optim`, the seeded
  `Generator`, disposal scopes, the reference backend as shipping fallback,
  BLAS/LAPACK for dense math, `column.toTensor()`, and the differential-test
  harness. Public `fino:tensor`, `fino:tensor/graph`, `fino:tensor/backend`
  behind the experimental marker. **Exit: train an MLP and a small transformer
  on CPU on macOS and arm64 Linux; `fino:ml` and `fino:tensor/linalg` build on
  it unchanged.**
- **Phase 2 — Metal-direct.** The objc_msgSend binding, memory/queue/encoder
  plumbing, the ~30 memory-bound templates through the MSL lowering, the
  two-tier cache, GEMM (measured against MPS), and the ordering plane.
  **Exit: the unmodified Phase 1 training script runs GPU-accelerated on Apple
  Silicon through our own kernels, differentially green against the oracle,
  with per-op numbers against ggml-Metal on the same device.**
- **Phase 3 — Vulkan-direct.** The SPIR-V emitter hardened, Vulkan
  device/memory/descriptor/pipeline plumbing, the same templates through the
  SPIR-V lowering, then the tiled GEMM with subgroup and cooperative-matrix
  paths behind caps. **Exit: the same script runs on a non-Apple GPU through
  our own kernels; lavapipe conformance green in CI.**
- **Phase 4 — fusion and step replay.** Pointwise fusion over the recorded
  graph, reduction/epilogue fusion, pre-recorded command buffers for
  shape-stable steps, fp16/bf16 with loss scaling. **Exit: a fused chain
  measurably beating the same chain unfused, and dispatch overhead in
  single-digit microseconds per step under replay.**
- **Phase 5 — CUDA-direct where it wins.** Driver API + NVRTC, then cuBLASLt
  epilogues and cuDNN fused conv/SDPA — the things neither Metal nor Vulkan has
  an equivalent for. Same templates, new lowering, no semantic changes.
- **Phase 6 — the far end.** A tile DSL for serious fused attention;
  data-parallel training; HIP or Level Zero if Vulkan proves insufficient on
  AMD or Intel; **the first fixed-function backend** (§2.6) exercising the
  graph plane and the partitioner; and the milestone that closes the loop —
  enough op coverage and kernel quality to retire `fino:ai/model/local`'s
  llama.cpp dependency for real GGUF inference. This is the ambition, and it is
  honestly distant.

## 8. Risks and Open Questions

- **The SPIR-V emitter is the highest-stakes unknown.** Nothing else gives
  vendor-neutral GPU coverage with our own kernels. If it fails, the fallback
  is per-vendor dialects only (MSL and CUDA C), which forfeits AMD, Intel, and
  Mali entirely, or vendoring a compiler. This is exactly why Phase 0's spike
  is small, early, and paired with the MSL path. Encouraging priors: SPIR-V is
  a simple binary format and this repo has implemented harder ones from spec.
- **A dialect-neutral IR designed against one dialect isn't neutral.**
  Implementing Metal first risks baking Apple assumptions into the IR;
  the two-dialect Phase 0 spike is the mitigation, and it should stay a gate
  rather than becoming optional under schedule pressure.
- **GEMM quality is the performance ceiling on Vulkan**, where there is no
  vendor BLAS to fall back on. Set the target as a stated factor of the best
  available library and measure honestly per device; do not promise cuBLAS
  parity.
- **CPU SIMD is a real gap** (§2.7). TypeScript cannot emit vector
  instructions, so CPU-bound transformer inference is not a workload this
  engine wins. Document it rather than letting users discover it.
- **No GPU in the available Linux environment.** The Apple container guest gets
  no GPU passthrough. Mitigation is genuine but partial: the Mac gives real GPU
  performance via Metal, and lavapipe gives GPU-less SPIR-V correctness in CI.
  Real Linux GPU hardware is still needed to validate AMD/Intel/NVIDIA Vulkan
  performance, and NVIDIA hardware for anything CUDA.
- **`objc_msgSend` binding is fiddly**, particularly variadic and
  struct-returning selectors and block layouts. arm64 removes the worst of it
  (no `_stret`), and `MTLSharedEvent` avoids blocks on the hot path, but budget
  for it.
- **Vulkan's setup surface is large before the first kernel runs**, and
  per-vendor extension variance means fast paths are conditional. Keep scalar
  fallbacks mandatory so correctness never depends on an extension.
- **A public backend interface is hard to change.** Out-of-tree
  implementations break silently. Hence contract-first and the experimental
  marker.
- **The NPU/TPU class is designed-for but unproven.** The `class: 'graph'`
  shape is drawn from how CoreML, TensorRT, QNN, and OpenVINO actually work,
  but no such backend exists here yet, and graph partitioning across
  mixed-capability devices is genuinely hard. The commitment now is only that
  the interface does not preclude it.
- **Scope honesty.** This is a large, multi-phase program. The sequencing is
  designed so the CPU core pays for itself through classical ML and metrics,
  and Metal's elementwise tier pays for itself through real training, long
  before LLM-inference parity is in reach.
- **GC-invisible device memory** is the sharpest UX edge: scopes
  (`using`/`tidy`) must be the documented norm from the first example.

## Sources

- Metal Shading Language specification: https://developer.apple.com/metal/Metal-Shading-Language-Specification.pdf
- Metal API (compute pipelines, command encoders, shared events): https://developer.apple.com/documentation/metal
- Objective-C runtime reference (`objc_msgSend`, the binding route): https://developer.apple.com/documentation/objectivec/objective-c_runtime
- SPIR-V specification: https://registry.khronos.org/SPIR-V/
- Vulkan specification, compute pipelines and memory model: https://registry.khronos.org/vulkan/
- `VK_KHR_cooperative_matrix` (portable tensor-core-class GEMM): https://registry.khronos.org/vulkan/specs/latest/man/html/VK_KHR_cooperative_matrix.html
- Vulkan subgroup operations: https://www.khronos.org/blog/vulkan-subgroup-tutorial
- Mesa lavapipe (software Vulkan, GPU-less CI): https://docs.mesa3d.org/drivers/llvmpipe.html
- MoltenVK (development stand-in only): https://github.com/KhronosGroup/MoltenVK
- CUDA driver API: https://docs.nvidia.com/cuda/cuda-driver-api/
- NVRTC: https://docs.nvidia.com/cuda/nvrtc/
- cuBLASLt: https://docs.nvidia.com/cuda/cublas/#using-the-cublaslt-api
- cuDNN v9 graph API: https://docs.nvidia.com/deeplearning/cudnn/latest/developer/graph-api.html
- CUDA Graphs: https://docs.nvidia.com/cuda/cuda-c-programming-guide/#cuda-graphs
- HIP runtime API: https://rocm.docs.amd.com/projects/HIP/en/latest/
- Intel Level Zero (close-to-hardware Intel GPU/NPU): https://spec.oneapi.io/level-zero/latest/index.html
- CoreML / Apple Neural Engine (the fixed-function graph shape): https://developer.apple.com/documentation/coreml
- NVIDIA TensorRT (fixed-function graph shape): https://docs.nvidia.com/deeplearning/tensorrt/
- Qualcomm AI Engine Direct (QNN): https://docs.qualcomm.com/bundle/publicresource/topics/80-63442-50/introduction.html
- LAPACK: https://www.netlib.org/lapack/
- ggml (the benchmark bar, not a dependency): https://github.com/ggml-org/ggml
- DLPack documentation: https://dmlc.github.io/dlpack/latest/
- PyTorch documentation: https://docs.pytorch.org/docs/2.12/index.html
- PyTorch CUDA semantics (the eager-async precedent): https://pytorch.org/docs/stable/notes/cuda.html
- Triton (the tile-DSL precedent): https://triton-lang.org/
