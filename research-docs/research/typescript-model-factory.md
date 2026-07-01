# Fino as a TypeScript Model Factory

> Status: research and direction-setting document.
>
> Scope: this document deliberately excludes Node.js/npm compatibility and
> application-agent SDK comparisons. The question is whether Fino can become a
> serious TypeScript runtime for building, training, adapting, packaging, and
> executing models.

## 1. Thesis

Python is the default language for AI because it owns the model-factory stack:
data formats, tensor objects, accelerator execution, autodiff, graph capture,
compiler integration, model artifact formats, quantization, training loops,
distributed execution, notebooks, and model/dataset hubs.

Most JavaScript AI libraries live above that boundary. They wrap remote models,
stream text, call tools, orchestrate agents, or run already-exported inference
graphs. That is useful, but it does not make TypeScript a place where models are
made.

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

## 2. What "Model Factory" Means

A model factory is the full path from data to artifact:

1. Ingest data from local/remote storage.
2. Normalize it into efficient tabular, tensor, and media representations.
3. Transform it through streaming and batched pipelines.
4. Build model parameters as tensors with dtypes, shapes, strides, and devices.
5. Execute tensor ops on CPU/GPU/accelerator backends.
6. Record gradients and update parameters.
7. Checkpoint weights, optimizer state, tokenizer/config metadata, and metrics.
8. Export or serve the result.

Python's advantage is that each layer has mature defaults:

- PyTorch exposes tensors, neural-network modules, autograd, optimizers, CUDA,
  MPS, XPU, distributed training, quantization, DLPack, data utilities, ONNX
  export, and profiler hooks in one ecosystem. Its own docs describe PyTorch as
  an optimized tensor library for deep learning on GPUs and CPUs:
  https://docs.pytorch.org/docs/2.12/index.html.
- TensorFlow covers tensors, Keras model authoring, `tf.data`, custom training
  loops, distributed training, TensorBoard, TensorFlow Lite, TensorFlow Serving,
  XLA, model optimization, and production ML pipelines:
  https://www.tensorflow.org/tutorials.
- JAX is built around composable transformations: autodiff, JIT compilation,
  vectorization, parallel execution, and array programming:
  https://docs.jax.dev/en/latest/.
- Hugging Face Datasets and Transformers provide the shared dataset/model hub
  path: load data, preprocess, tokenize, train/fine-tune, save, publish, and
  run. Safetensors gives a safe, zero-copy-oriented tensor storage format:
  https://huggingface.co/docs/datasets/index,
  https://huggingface.co/docs/transformers/index, and
  https://huggingface.co/docs/safetensors/index.

The JS/Web ecosystem proves that pieces are viable outside Python:

- ONNX Runtime has a JavaScript API for running ONNX models:
  https://onnxruntime.ai/docs/get-started/with-javascript/.
- Transformers.js runs pretrained Transformers in JS environments using ONNX
  Runtime and browser/runtime backends:
  https://huggingface.co/docs/transformers.js/index.
- WebGPU and WGSL are standardized GPU compute surfaces:
  https://www.w3.org/TR/webgpu/ and https://www.w3.org/TR/WGSL/.
- WebNN standardizes a graph API for neural-network inference:
  https://www.w3.org/TR/webnn/.

The missing piece is a runtime that unifies these into a model-building
experience instead of treating them as isolated inference adapters.

## 3. Current Fino Substrate

Fino is not starting from zero. It already has several assets that matter for a
model-factory runtime:

- `ArrayBuffer`, typed arrays, and `SharedArrayBuffer` are already used heavily
  across runtime internals and realm transfer paths.
- `fino:ffi` can bind system libraries, pass pointers and struct layouts, and
  expose callbacks into JS. Existing modules use this for libc, SQLite, OpenSSL,
  nghttp2/nghttp3/ngtcp2, and llama.cpp.
- `fino:database/sqlite` provides embedded SQLite through system `libsqlite3`,
  including JS-implemented VFS support and vector helper hooks.
- `fino:ai/model/local` already contains an optional llama.cpp/GGUF adapter
  through FFI. That is inference-oriented, but it proves the artifact and native
  library integration style.
- Realms and `RealmPool` offer isolation and parallel placement that could
  become a data-loader, eval, kernel-worker, or distributed-training substrate.
- The runtime has built-in OpenTelemetry and profiling hooks, which matter for
  training and kernel performance.

The missing substrate is also clear:

- no first-class tensor object model;
- no shape/stride/dtype/device abstraction;
- no DLPack import/export;
- no Arrow table or record-batch layer;
- no Parquet/Arrow IPC reader;
- no safetensors reader/writer;
- no ONNX graph loader/runtime surface;
- no autodiff tape;
- no CPU kernel library;
- no WebGPU/native accelerator backend;
- no optimizer/training-loop/checkpoint API;
- no model config/tokenizer/data pipeline convention.

## 4. Gap Matrix

| Capability | Python maturity | JS/Web maturity | Fino today | Strategic value | Build difficulty |
|---|---:|---:|---:|---:|---:|
| Tensor object model | Very high | Medium | None | Critical | High |
| Dtype/device semantics | Very high | Medium | None | Critical | High |
| CPU tensor kernels | Very high | Medium | None | Critical | High |
| GPU execution | Very high | Medium via WebGPU/TF.js/ORT | None | Critical | Very high |
| Autodiff | Very high | Low/medium | None | Critical | Very high |
| Graph capture/JIT | Very high | Low | None | High | Very high |
| Arrow tables | Very high | Medium | None | High | Medium |
| Parquet/Arrow IPC | Very high | Medium | None | High | Medium/high |
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
training or a compiler. It needs stable memory semantics, a small operator set,
artifact loading, and a training loop that works for modest models.

## 5. Standards To Anchor On

### Apache Arrow

Arrow is the right in-memory tabular representation to build around. Its docs
describe a language-agnostic, standardized columnar format for structured
datasets, designed to improve analytical algorithms and movement between
systems: https://arrow.apache.org/overview/.

The C Data Interface is especially relevant to Fino because it defines a small,
ABI-stable set of C definitions for zero-copy sharing of Arrow data between
independent runtimes in the same process:
https://arrow.apache.org/docs/format/CDataInterface.html.

Fino implication:

- `fino:data/arrow` should expose Arrow arrays, schemas, record batches, and
  table streams in JS.
- It should support zero-copy `ArrayBuffer` ownership and export/import through
  Arrow C Data Interface structs via `fino:ffi`.
- Parquet can wait until Arrow arrays and IPC are real, but the public data API
  should be designed with Parquet-backed lazy datasets in mind.

### DLPack

DLPack is the right tensor interchange target. It defines a stable in-memory
tensor structure for exchange between frameworks and supports CPU, CUDA,
OpenCL, Vulkan, Metal, ROCm, WebGPU, Hexagon, and others:
https://dmlc.github.io/dlpack/latest/.

Fino implication:

- `fino:tensor` should be able to import/export DLPack capsules/structs through
  FFI-compatible handles.
- This gives Fino a path to interop with native libraries without committing
  early to one accelerator stack.
- DLPack should be treated as the boundary format, not the internal object model.

### Safetensors

Safetensors is a simple tensor storage format built to avoid pickle-style code
execution while keeping fast/zero-copy-friendly loading:
https://huggingface.co/docs/safetensors/index.

Fino implication:

- `fino:model/safetensors` is a near-term, high-leverage artifact reader.
- It should parse metadata, expose tensor names/dtypes/shapes/offsets, and
  materialize tensors lazily.
- Writer support can come later, but reader support unlocks real model weights.

### ONNX

ONNX is the portable graph/artifact format to support for inference and model
exchange: https://onnx.ai/onnx/intro/.

Fino implication:

- ONNX should not be the internal training graph in v1.
- A reader/inspector and an execution adapter are useful earlier than a full
  compiler.
- If Fino later adds graph lowering, ONNX is one external graph format to import
  and export, while the internal IR should stay independent.

### WebGPU and WebNN

WebGPU/WGSL give Fino a cross-platform GPU compute path with a real shader
language. WebNN gives an inference-oriented neural network graph API.

Fino implication:

- WebGPU is more relevant to training because it exposes general compute.
- WebNN is useful as an inference backend, but it is not enough for a model
  factory because it is a graph API rather than a general tensor/autodiff
  substrate.
- If Fino chooses one browser-aligned accelerator API, WebGPU should come first.

## 6. Architecture Proposal

### 6.1 `fino:tensor`

This is the keystone module. Everything else should depend on it.

Minimum object model:

```ts
type DType =
  | 'bool'
  | 'u8' | 'i8'
  | 'u16' | 'i16'
  | 'u32' | 'i32'
  | 'f16' | 'bf16' | 'f32' | 'f64';

type Device = 'cpu' | { type: 'webgpu'; id?: string } | { type: 'native'; name: string };

interface Tensor {
  readonly dtype: DType;
  readonly shape: readonly number[];
  readonly strides: readonly number[];
  readonly device: Device;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly requiresGrad: boolean;
  view(shape: readonly number[], strides?: readonly number[]): Tensor;
  contiguous(): Tensor;
  to(device: Device): Promise<Tensor>;
  data(): Promise<ArrayBufferView>;
}
```

Early operator set:

- creation: `tensor`, `zeros`, `ones`, `empty`, `randn`, `arange`;
- shape: `reshape`, `view`, `transpose`, `permute`, `slice`, `concat`;
- elementwise: `add`, `sub`, `mul`, `div`, `exp`, `log`, `relu`, `gelu`;
- reductions: `sum`, `mean`, `max`, `argmax`;
- linear algebra: `matmul`, `linear`;
- losses: `softmax`, `logSoftmax`, `crossEntropy`, `mseLoss`.

Design constraints:

- All tensors carry explicit dtype, shape, strides, and device.
- Views are first-class. Copying must be explicit or obvious.
- CPU tensors are backed by `ArrayBuffer` or external native memory with explicit
  lifetime ownership.
- Device tensors are opaque until transferred or read back.
- Broadcasting rules should match NumPy/PyTorch semantics.
- In-place mutation should be deferred. It complicates autograd and aliasing.

### 6.2 `fino:tensor/autograd`

Start with eager tape-based reverse-mode autodiff.

V1 requirements:

- gradients for the early operator set;
- `Parameter` wrapper;
- `noGrad(fn)`;
- `backward(loss)`;
- gradient accumulation and zeroing;
- basic grad checking utilities for tests.

Avoid in v1:

- dynamic control-flow graph optimization;
- higher-order gradients;
- distributed autograd;
- mutation-heavy APIs.

### 6.3 `fino:nn`

Provide a tiny neural network layer over `fino:tensor`.

V1 surface:

- `Module`;
- `Linear`;
- `Embedding`;
- `LayerNorm`;
- `Sequential`;
- `Dropout`;
- `parameters(module)`;
- `train()` / `eval()`;
- initializers.

This is intentionally smaller than PyTorch. Its purpose is to validate the
tensor/autograd substrate and support small models, adapters, classifiers, and
embedding models.

### 6.4 `fino:optim`

V1 optimizers:

- SGD with momentum;
- Adam;
- AdamW;
- gradient clipping;
- cosine and linear learning-rate schedules.

This is enough to train small models and fine-tune small heads/adapters.

### 6.5 `fino:data`

Data should be Arrow-first and streaming-first.

V1 surface:

- `Dataset<T>`;
- `IterableDataset<T>`;
- `DataLoader<T>` with batching, shuffling, prefetch, and worker realms;
- CSV source using existing `fino:format/csv`;
- JSONL source;
- Arrow `RecordBatch` source;
- `map`, `filter`, `batch`, `shuffle(bufferSize)`, `take`, `split`;
- deterministic seeds and snapshot metadata.

V2:

- Arrow IPC reader/writer;
- Parquet reader;
- mmap/lazy slicing;
- image/audio decode adapters;
- Hugging Face dataset manifest compatibility where possible.

### 6.6 `fino:model/artifacts`

V1:

- safetensors reader;
- GGUF metadata reader independent of llama.cpp;
- tokenizer/config JSON helpers;
- deterministic model cache layout;
- SHA-256 integrity checks;
- lazy tensor materialization.

V2:

- safetensors writer;
- ONNX inspector;
- ONNX Runtime adapter;
- GGUF quantization metadata mapping into Fino tensor dtypes or packed tensor
  descriptors.

### 6.7 Execution Backends

Fino should layer execution in phases:

1. Reference CPU backend in JS/typed arrays.
2. Native CPU backend through FFI for BLAS-like kernels.
3. WebGPU backend for matmul, elementwise ops, reductions, softmax, layer norm.
4. Optional native accelerator backends through DLPack and FFI.

The reference CPU backend is not the long-term performance story, but it is the
correctness story. Every accelerated kernel needs differential tests against it.

### 6.8 Graph and Compiler Layer

Do not start here.

A graph layer becomes useful after:

- tensor semantics are stable;
- enough ops exist to train non-trivial models;
- WebGPU/native kernels need fusion;
- export/import pressure is real.

When it arrives, it should be a small internal graph capture format that can
lower to:

- eager CPU execution;
- WebGPU kernels;
- ONNX export/import;
- possibly MLIR/IREE/TVM/OpenXLA-style compiler paths.

TVM and IREE are worth studying for compiler architecture. TVM is an ML
compiler stack for CPUs, GPUs, and accelerators (https://tvm.apache.org/docs/).
IREE focuses on MLIR-based deployment across hardware and execution
environments (https://iree.dev/). They are not v1 dependencies, but they set the
shape of the long-term compiler problem.

## 7. Product Wedges

### Wedge A: Local Small-Model Training

Goal: train real small models entirely in Fino.

Examples:

- logistic regression and MLP classifiers over tabular data;
- small CNN over MNIST/CIFAR-scale data;
- small Transformer language model for educational/regression use;
- embedding model head/adapters for domain-specific retrieval.

Why it matters:

- proves tensor/autograd/optimizer/data loop;
- creates benchmarkable correctness/performance targets;
- avoids giant-model infrastructure too early.

### Wedge B: Artifact-Native Inference and Inspection

Goal: load real model artifacts, inspect them, and execute or adapt parts of
them.

Examples:

- safetensors metadata browser;
- GGUF metadata and quantization inspector;
- ONNX graph inspector;
- load a safetensors linear head into `fino:nn`;
- convert selected tensors into Fino tensors.

Why it matters:

- connects Fino to real model repositories;
- avoids a toy-only tensor system;
- builds the path from downloaded weights to trainable components.

### Wedge C: Arrow Dataset Pipeline

Goal: make Fino good at feeding models.

Examples:

- CSV/JSONL to Arrow record batches;
- streaming transforms and batching;
- deterministic train/validation split;
- local sqlite/Arrow cache;
- realm-backed prefetch workers.

Why it matters:

- data loading is a major Python moat;
- Arrow aligns with cross-language tooling;
- Fino already has file, stream, sqlite, and realm primitives.

### Wedge D: WebGPU Kernels

Goal: make Fino visibly faster than pure JS for the core training path.

Start with:

- matmul;
- elementwise binary ops;
- reductions;
- softmax;
- layer norm;
- embedding lookup.

Why it matters:

- model factory work needs accelerator credibility;
- WebGPU is the most TypeScript-native compute target;
- a small kernel set supports useful models.

## 8. Recommended Roadmap

### Phase 0: Design Contracts

Deliverables:

- `research-docs/research/tensor-contract.md`;
- dtype/device/shape/stride semantics;
- broadcasting and view rules;
- memory ownership and lifetime rules;
- numerical accuracy policy;
- test oracle strategy against a reference implementation.

Exit criteria:

- implementers can build `Tensor` without inventing semantics;
- every public rule has an acceptance-test shape.

### Phase 1: Tensor Core

Deliverables:

- `fino:tensor`;
- CPU `ArrayBuffer` storage;
- reference kernels for the early operator set;
- random seeding;
- DLPack struct definitions and import/export design, even if only CPU works;
- focused tests for dtype, shape, broadcasting, views, and op correctness.

Exit criteria:

- train a linear regression model by manually computing gradients;
- all ops differentially test against simple scalar/array or known-value cases.

### Phase 2: Autograd, NN, Optimizers

Deliverables:

- eager reverse-mode autodiff;
- `fino:nn`;
- `fino:optim`;
- gradient checking;
- checkpoint save/load for tensors and module state.

Exit criteria:

- train logistic regression and a small MLP end-to-end;
- checkpoint and resume training with matching loss trajectory.

### Phase 3: Data and Artifacts

Deliverables:

- `fino:data` streaming `Dataset` and `DataLoader`;
- CSV and JSONL dataset sources;
- Arrow record-batch representation;
- safetensors reader;
- tokenizer/config helpers;
- deterministic cache layout.

Exit criteria:

- train a classifier from CSV/JSONL data;
- load safetensors weights lazily and materialize selected tensors;
- use realm workers for prefetch without changing user code.

### Phase 4: WebGPU Backend

Deliverables:

- WebGPU device abstraction;
- WGSL kernels for high-value ops;
- device transfer and readback;
- differential correctness tests against CPU;
- benchmark suite.

Exit criteria:

- WebGPU backend can train the Phase 2 MLP and run a small Transformer block;
- performance is measurably better than reference CPU for matrix-heavy ops.

### Phase 5: Model Graphs and ONNX

Deliverables:

- ONNX inspector;
- ONNX Runtime adapter or direct execution path;
- internal graph capture for `fino:nn` modules;
- graph export/import experiments.

Exit criteria:

- inspect and run a small ONNX model;
- capture a Fino module graph and execute it with the same outputs as eager mode.

### Phase 6: Compiler and Distributed Work

Deliverables:

- kernel fusion;
- graph lowering;
- distributed data loading over realms/cluster;
- sharded checkpoints;
- optional native accelerator libraries via FFI/DLPack.

Exit criteria:

- larger model training/adaptation becomes practical;
- Fino can place data loading and compute across local or remote workers.

## 9. What Not To Build First

Avoid these until the tensor/data base is real:

- a full PyTorch clone;
- a large agent framework expansion;
- provider SDK abstractions;
- distributed training;
- a custom compiler IR;
- ONNX as the internal training graph;
- broad model zoo APIs;
- quantization frameworks beyond artifact inspection.

These are not wrong goals. They are downstream of a working tensor runtime.

## 10. High-Confidence Suggestions

1. Start with `fino:tensor`, not `fino:ai`.
2. Make DLPack and Arrow C Data Interface first-class interop targets.
3. Build a safetensors reader early because it connects Fino to real weights.
4. Keep CPU reference kernels simple and correct; use them as the oracle for
   every accelerated backend.
5. Treat WebGPU as the first serious accelerator target.
6. Defer graph compilation until eager tensor/autograd is usable.
7. Use realms for data-loader workers and eval isolation before using them for
   distributed training.
8. Design every artifact format around lazy loading and explicit ownership.
9. Make checkpointing boring and deterministic from the start.
10. Measure against small, real training tasks instead of synthetic-only kernel
    demos.

## 11. Success Criteria

Fino becomes credible as a TypeScript model factory when it can:

- load tabular/text data into efficient batches;
- create tensors with explicit dtype/device semantics;
- run a useful op set on CPU and at least one accelerator;
- compute gradients and update parameters;
- train small models end-to-end;
- load safetensors and inspect GGUF/ONNX artifacts;
- checkpoint and resume training;
- export or serve the trained result;
- profile the full path.

The long-term ambition is larger: a TypeScript-first model factory where data,
models, training, artifacts, and serving live in one runtime. The near-term
proof is smaller and sharper: train useful small models, load real artifacts,
and accelerate the hot path without leaving Fino.

## Sources

- Apache Arrow overview: https://arrow.apache.org/overview/
- Apache Arrow C Data Interface:
  https://arrow.apache.org/docs/format/CDataInterface.html
- DLPack documentation: https://dmlc.github.io/dlpack/latest/
- Safetensors documentation: https://huggingface.co/docs/safetensors/index
- ONNX introduction: https://onnx.ai/onnx/intro/
- PyTorch documentation: https://docs.pytorch.org/docs/2.12/index.html
- TensorFlow tutorials and guide index: https://www.tensorflow.org/tutorials
- JAX documentation: https://docs.jax.dev/en/latest/
- Hugging Face Datasets: https://huggingface.co/docs/datasets/index
- Hugging Face Transformers: https://huggingface.co/docs/transformers/index
- ONNX Runtime JavaScript: https://onnxruntime.ai/docs/get-started/with-javascript/
- Transformers.js: https://huggingface.co/docs/transformers.js/index
- W3C WebGPU: https://www.w3.org/TR/webgpu/
- W3C WGSL: https://www.w3.org/TR/WGSL/
- W3C WebNN: https://www.w3.org/TR/webnn/
- Apache TVM documentation: https://tvm.apache.org/docs/
- IREE documentation: https://iree.dev/
