# Data and AI — What To Build Next

> Status: near-term execution plan, derived from the model-factory document
> family. The siblings describe the destination; this document describes the
> next few moves and why they are in this order.
>
> Parent: [typescript-model-factory.md](./typescript-model-factory.md).
> Siblings: [tensor-engine.md](./tensor-engine.md),
> [data-stack.md](./data-stack.md), [model-artifacts.md](./model-artifacts.md),
> [ml-workbench.md](./ml-workbench.md),
> [inference-serving.md](./inference-serving.md),
> [classical-ml.md](./classical-ml.md).
>
> This is a sequencing argument, not a schedule. Effort is given as relative
> size against work already in the repo, never as dates.

## 1. Where things actually stand

Verified against the loader registry and `js/`, not against the older docs:

**Landed and mature.**

- `fino:data/arrow` — the full columnar format, IPC stream/file, and the C
  Data Interface. Golden-tested against pyarrow.
- `fino:data/parquet` — read and write, with PLAIN, RLE/bit-packed dictionary,
  the DELTA family, byte-stream-split, page compression, statistics, and
  nested repetition/definition levels. Golden-tested.
- The reusable generics those needed: `internal:format/thrift` (compact,
  binary, and JSON protocols), `internal:compress/snappy`.
- `fino:ai/*` — roughly 17k lines: agents, tools, MCP, durable sessions,
  sqlite-vec memory, evals, skills, response caching, and Anthropic/OpenAI/
  llama.cpp providers.
- The substrate the model factory assumes: `fino:workflow` and
  `fino:task/durable`, `fino:jobs`, `fino:realm/pool` with genuine
  SharedArrayBuffer sharing, `Pointer.view` zero-copy over native memory,
  the FFI fast path with `structType` and `FfiCallback`, `fino:opentelemetry`,
  `fino:ui`, `fino:tty/tui`.

**Not started.** `fino:tensor` (any of it), `fino:data/frame`, Dataset /
DataLoader, `fino:model/artifacts`, `fino:model/hub`, `fino:text/tokenizer`,
`fino:ml` and `fino:ml/metrics`, `fino:tensor/linalg`, the serving scheduler,
`fino:viz`, `fino:train/track`, the notebook.

**The finding that drives everything below.** The format tier and the
application tier are both mature and *they do not touch each other*. There is
no `toTensor` anywhere in the tree, no shared dtype vocabulary, no display
protocol, and no reference to Arrow, Parquet, or datasets anywhere in
`fino:ai/eval` — which carries its own ad-hoc scorers instead. `fino:data`
itself is a 47-line re-export of the Arrow namespace.

So the columnar stack has no consumer inside the runtime, and the AI stack has
no data language. That gap is worth more than any new format, and closing it is
what the first two waves do.

## 2. Why not "the tensor engine next"

The older roadmap put the CUDA spike next. Three reasons that is wrong now:

1. **The mandate changed.** Cross-platform, no privileged vendor, and
   direct-to-hardware with our own kernels on each platform's native interface
   — Metal, Vulkan, the CUDA driver API — rather than an inference library in
   the middle ([tensor-engine.md](./tensor-engine.md) §1–2). NVIDIA is one
   target among peers, and the first GPU backend is Metal, because Apple
   Silicon is the development machine.
2. **The engine's real first question isn't CUDA.** It is whether the kernel IR
   is genuinely dialect-neutral and whether SPIR-V can be emitted from
   TypeScript. That question is answerable today on the dev Mac and it gates
   everything downstream, so it is the spike worth running — not a driver
   binding for hardware nobody here has.
3. **Nothing above the engine can consume it yet.** An engine with no
   DataFrame, no Dataset, no artifact reader, and no metrics is a math library.
   Every other document in the family is explicitly engine-independent; that
   value should be harvested in parallel, and it is what makes the engine land
   into a working stack instead of a vacuum.

The engine still matters, and its *portable core* is early (Wave 2) precisely
because so much else needs a numeric type to speak to. What is sequenced later
is per-platform backend work, not the tensor object model or the graph.

## 3. The waves

### Wave 1 — conventions and the connective tissue

Small, cheap, and expensive to retrofit. Everything later assumes these.

| Item | Why now | Size |
|---|---|---|
| `tensor-contract.md` + a first cut of the kernel IR | Dtype promotion, broadcast rules, view/copy semantics, RNG scheme, and the graph-partitioning rules for mixed-capability devices. Prerequisite for a *public* backend interface — see §4 — and the IR sketch is what the Phase 0 spike tests. | Writing only |
| Shared dtype/device vocabulary | Exported by `fino:tensor`, consumed by Arrow column conversion, artifact descriptors, collators. Nothing can interoperate before this exists. | Small |
| `fino:ml/metrics` | Pure TS, no dependencies, and it has a waiting consumer: it deletes the ad-hoc scorers in `fino:ai/eval` on day one. | Small |
| MIME display protocol | `[Symbol.for('fino.display')]()` adopted by Arrow `Table`/`RecordBatch`, `Tensor`, and eval reports. A convention, not a system — a few lines per type — and every later surface (viz, tracking, notebook) assumes it. | Small |

### Wave 2 — the portable tensor core

`fino:tensor` on CPU only: object model with N-d shapes and broadcasting, the
TS autograd tape, `nn`/`optim`, the seeded `Generator`, `dispose`/`using`/
`tidy` scopes, the reference backend as a *shipping* fallback, BLAS/LAPACK via
dlopen for dense math, and `column.toTensor()`. Public surface:
`fino:tensor`, `fino:tensor/graph`, `fino:tensor/backend`, behind an
experimental marker.

This is a real but bounded slice — no GPU backend, no kernel codegen, no memory
pool, no streams, no platform libraries beyond CBLAS. It unblocks
`fino:ml/metrics` consumers, `fino:tensor/linalg`, PCA/linear/k-means,
`safetensors → Tensor`, and DataLoader collation. It is also the correctness
oracle every later backend is tested against, so none of it is throwaway: it
is engine Phase 1 work, pulled forward and made shippable.

It is worth being clear about what this wave does *not* prove. The GPU story —
our own kernels, on each platform's native API — is the engine's actual
substance ([tensor-engine.md](./tensor-engine.md) §4), and none of it is
exercised here. This wave buys the object model, the graph, autodiff, and a
usable classical-ML numerics tier; the Phase 0 spike, running in parallel, is
what buys confidence in the part that comes after.

Two things to hold onto while building it. The reference backend must stay the
*universal fallback*, so that a machine with no GPU and no BLAS still runs
`fino:tensor` — that property is what lets everything above depend on it
unconditionally. And it must be documented as reference-plus-BLAS, not as
"fino's tensor performance," or the first benchmark someone runs will set the
wrong expectation permanently.

### Wave 3 — make the data stack load-bearing

- **`fino:data/frame`** — the lazy DataFrame: expression plan, small
  vectorized operator set (filter, project, groupBy/agg, join, sort, limit),
  with predicate and projection pushdown into the Parquet reader. The row-group
  statistics are already parsed and currently unused.
- **`fino:data` proper** — `Dataset` / `IterableDataset` / `DataLoader` with
  `map/filter/shuffle/batch/take/split/interleave`, worker pipelines on
  `fino:realm/pool` writing collated batches into SAB slabs, seeded
  determinism, and `state()`/`restore()`.
- **Rewire the existing AI stack onto it**, which is the point of the wave:
  `fino:ai/eval` takes cases from a `Dataset` and scores with
  `fino:ml/metrics`; `fino:ai/memory` ingestion runs through the DataLoader;
  batch inference becomes frame-in / frame-out, with embeddings as Arrow
  `FixedSizeList<f32>` — the layout `column.toTensor()` and the sqlite vector
  helpers already agree on.

### Wave 4 — the artifact ecosystem

No GPU, no engine dependency beyond Wave 2's Tensor. `fino:model/artifacts`
(safetensors read/write, GGUF metadata independent of llama.cpp, npy/npz),
`fino:model/hub` with `models.lock`, and `fino:text/tokenizer`. Two things here
are genuinely unavailable in Python and worth leading with: reproducible
model resolution via a lockfile, and fetching a *single tensor* out of a remote
shard by HTTP Range because safetensors publishes per-tensor byte offsets.

### Wave 5 — the first real trained models

`fino:ml`: GBDT over dlopen'd XGBoost/LightGBM, preprocessing as DataFrame
transforms, `Pipeline`, train/test split and K-fold CV, plus `fino:train/track`
for runs and metric series. "Fit a boosted tree on a Parquet file, score it,
persist it, serve it" covers the majority of applied ML and needs no
accelerator at all. Linear/logistic/PCA/k-means and `fino:tensor/linalg` come
along on Wave 2's BLAS/LAPACK binding.

### Parallel tracks

These do not sit in the wave sequence but compete for the same attention, and
both are worth funding.

- **The two-dialect kernel spike** ([tensor-engine.md](./tensor-engine.md) §7),
  which is the highest-value single piece of work in this whole document and
  needs no hardware beyond the dev Mac. Emit one trivial kernel from the IR
  through *both* MSL (compiled by Metal via `objc_msgSend`, dispatched, read
  back through `MTLSharedEvent` → `async: true` → wake pipe) and TS-emitted
  SPIR-V (loaded through `vkCreateShaderModule`, via MoltenVK as a stand-in or
  lavapipe for GPU-less correctness). Doing both at once answers two questions
  that gate everything downstream: whether the IR is genuinely dialect-neutral
  rather than Metal-shaped, and whether emitting SPIR-V from TypeScript is as
  tractable as it looks. A "no" on either reshapes the engine's later phases,
  so run it early — ideally before Wave 2 is finished, certainly before Wave 3.
  The arm64-Linux deployment probe rides along cheaply.
- **`fino:ai/sandbox`** ([application-surface.md](./application-surface.md)
  §3, and the lead wedge in [vision.md](./vision.md) §4). Absent from the
  model-factory family entirely, small to build on primitives that already
  exist (`Realm.fromSource` + `ImportMap.deny` + `terminate()` deadline +
  captured output), and the one capability no other runtime can offer at all.

## 4. Consequences of a public graph and backend interface

`fino:tensor/graph` and `fino:tensor/backend` are public by intent — they are
core building blocks other work depends on, not engine internals. Consumers
already visible: the fusion pass, capture/replay, ONNX export, graph
visualization and profiling, and out-of-tree backends for devices nobody here
has bound.

What that costs, and how it is paid:

- **A public backend interface is the worst kind to churn**, because
  out-of-tree implementations break silently rather than at compile time. So
  `tensor-contract.md` moves from "good hygiene" to a hard prerequisite, and
  the whole family ships behind an explicit experimental marker until two
  in-tree backends and one out-of-tree implementation have exercised it. That
  is the point at which an interface stops being a guess.
- **The interface has to span two hardware classes from the first commit.**
  Programmable GPUs take work per op and compile our kernels; fixed-function
  NPUs and TPUs take a whole subgraph and run it with their own
  implementations. That is how CoreML/ANE, TensorRT, QNN, and OpenVINO
  actually work, so `caps.class`, `caps.kernelCompile`, `caps.dispatch`, a
  `supportsOp` probe, and an optional graph plane are part of the contract now
  — three fields and one optional method, versus a breaking change later
  ([tensor-engine.md](./tensor-engine.md) §2.6). Nothing fixed-function gets
  *built* soon; the interface just stops precluding it.
- **Graph partitioning becomes framework work.** Because fixed-function devices
  support only a subset of ops, shapes, and dtypes, splitting a graph into
  device-executable subgraphs with the remainder falling back belongs in the
  framework. It is hardware-agnostic, and it is a third independent reason the
  recorded graph is public: a vendor graph API wants a graph, and ours is what
  gets lowered into theirs.
- **The differential harness becomes the public conformance suite** — the thing
  an out-of-tree backend author runs to know they are correct. Worth building
  it as a shippable test kit rather than internal test files.

## 5. The forcing function

One script, written first as an aspirational failing test, because it forces
exactly Waves 1–4 and nothing else:

> A Parquet corpus is read and transformed through `fino:data/frame`, batch
> embedded with a local GGUF model across a `fino:realm/pool`, written to both
> sqlite-vec and Parquet, recalled by a `fino:ai` agent, traced end to end by
> `fino:opentelemetry` — and after `kill -9` mid-run it resumes from its
> `fino:workflow` checkpoint. Every boundary in the chain is an Arrow record
> batch or a Tensor.

Nothing in that chain introduces a private representation, and none of it is
reproducible in Python: no GIL means the embedding stage is real parallelism
rather than multiprocessing-and-pickle, the pipeline and the model live in one
process, and resumption is a runtime property rather than artisanal
checkpointing code. That is the demo, and it is also the integration test.

## 6. Open decisions

1. **When does non-Apple GPU hardware enter the picture?** The Apple container
   guest gets no GPU passthrough, so the Vulkan phase is
   performance-validation-blocked. Metal is fully covered by the dev machine;
   lavapipe gives GPU-less SPIR-V *correctness* in CI; but real AMD/Intel/NVIDIA
   Vulkan performance, and anything CUDA, needs hardware. Worth deciding
   deliberately rather than discovering late — this is the single biggest
   scheduling constraint on the engine's later phases.
2. **Does the SPIR-V emitter survive the spike?** It is now load-bearing rather
   than a hedge: nothing else gives vendor-neutral GPU coverage with our own
   kernels. If it fails, the options are per-vendor dialects only (MSL and
   CUDA C — forfeiting AMD, Intel, and Mali) or vendoring a compiler. Cheap to
   learn, very expensive to assume.
3. **Is the CPU SIMD gap acceptable?** TypeScript cannot emit vector
   instructions, so memory-bound CPU kernels are scalar loops. BLAS closes the
   gap for GEMM-dominated and tabular work, but CPU-bound LLM inference is a
   workload this engine cannot win without a narrow compiled artifact for CPU
   kernels — which would be a real philosophy decision, not a detail
   ([tensor-engine.md](./tensor-engine.md) §2.7).
4. **Promote generic codecs out of `internal:*`?** `internal:format/thrift` is a
   general-purpose codec currently visible only to builtins, and
   `internal:spirv` will be another — a SPIR-V emitter is broadly useful, like
   `fino:format/flatbuffers`. Each is a one-line loader change whenever an
   external consumer wants it.
5. **Module naming, before surfaces harden.** `fino:model/serve` versus
   extending `fino:ai/model` ([inference-serving.md](./inference-serving.md)
   §7); `fino:ml` versus `fino:tensor/ml`; whether `fino:train/track` is its
   own namespace or part of the workbench.
