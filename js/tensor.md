---
weight: 145
---
# Tensor

`fino:tensor` provides tensors, eager execution, and reverse-mode automatic
differentiation in pure TypeScript over a thin device-backend interface.

The engine is **experimental**. Its semantics are specified normatively in
`specs/tensor-contract.md`, and the `fino:tensor/graph` and `fino:tensor/backend`
surfaces carry weaker stability promises than the rest of the runtime — see §1 of
that document.

`device('auto')` prefers a GPU when one is present — Metal on Apple hardware,
Vulkan elsewhere — and falls back to the reference CPU backend:

```ts
import { device, listDevices, tensor } from 'fino:tensor';

console.log(await listDevices());
const x = await tensor([[1, 2], [3, 4]]);   // on the GPU, if there is one
const y = await tensor([1, 2], { device: 'cpu' }); // or pin it
```

Both GPU backends are tested differentially against the reference backend, which
is the oracle, and an MLP trains to convergence on each. The reference backend
always registers, so `device('auto')` cannot fail, but it is a scalar TypeScript
implementation and is not this engine's performance story.

`f64` and `i64` are CPU-only — no GPU this engine targets represents them — and
requesting one on a GPU is refused rather than narrowed. Gradient checking needs
`f64`, so it runs on the CPU by construction.

Discrete GPUs, whose device-local memory the host cannot address, are supported:
transfers stage through host-visible memory and an explicit copy. Set
`FINO_VULKAN_STAGING=1` to take that path on hardware that does not require it,
which is how it is tested here.

## Eager, non-blocking execution

Operations return immediately. The only place anything waits is reading values
back:

```ts
import { tensor } from 'fino:tensor';

const x = await tensor([[1, 2], [3, 4]]);
const w = await tensor([[0.5], [-0.5]]);

const y = x.matmul(w).relu();
console.log(await y.data());
```

`data()` and `item()` are the only synchronisation points, and both are
promise-shaped. A worker parks on a device fence while the event loop keeps
running, so a training loop can serve HTTP or stream logs between steps.

### Yield occasionally

Dispatch is non-blocking, and compilation happens off the main thread, so a GPU needs
the event loop to turn at least once after it first meets a kernel — otherwise the
compile cannot finish and the launches behind it cannot be submitted. Every real
program does this already: a training loop awaits its loss, a server awaits a request.
A loop that awaits nothing at all is refused with an explanation rather than growing
until the process dies.

## Disposal is not optional

Device memory is invisible to the garbage collector, so an eight-byte handle can
pin gigabytes. Use `tidy` or `using` from the first line you write:

```ts
import { tensor, tidy } from 'fino:tensor';

const x = await tensor([1, 2, 3]);

// Every intermediate is released; only the returned tensor survives.
const out = tidy(() => x.mul(2).add(1).exp().log());

// Or scope a single tensor.
{
  using scratch = x.mul(3);
  console.log(await scratch.sum().item());
}
```

A finalizer reclaims storage that was dropped without disposal and counts it in
`poolStats()`, so leaks are measurable — but it runs at the collector's
discretion, which is far too late for a loop.

### Call backward() inside the scope

A `tidy` scope disposes everything created inside it except what it returns — and the
tensors the tape saved for the backward pass were created inside it. So this is wrong:

```ts
const loss = tidy(() => model.forward(x).sub(y).pow(2).sum());
loss.backward();   // the saved activations are already gone
```

and this is right:

```ts
const loss = tidy(() => {
  const value = model.forward(x).sub(y).pow(2).sum();
  value.backward();
  return value;
});
```

Gradients on leaf parameters survive the scope; the intermediates do not, which is the
point.

## Automatic differentiation

Gradients are recorded at dispatch and computed by ordinary operations, so the
tape works identically on every backend:

```ts
import { tensor } from 'fino:tensor';

const w = await tensor([[1], [2]], { requiresGrad: true });
const x = await tensor([[3, 4]]);

const loss = x.matmul(w).relu().sum();
loss.backward();

console.log(await w.grad!.data()); // dL/dw
```

`noGrad(fn)` disables recording for inference. Gradients accumulate into
`.grad` across calls, so zero them between steps.

Not supported in this version: in-place operations, higher-order gradients,
double backward, and distributed autograd.

## Dtypes and broadcasting

Element types are `f64`, `f32`, `f16`, `bf16`, `i64`, `i32`, `u8`, and `bool`.
Promotion follows the lattice in the contract: an integer operand never widens a
float operand, and a plain JS number adopts the tensor's dtype rather than
promoting it, so `f16Tensor.mul(2)` stays `f16`.

`f16` and `bf16` are storage types. Arithmetic happens in `f32` and rounds on
store, which is observable and intentional.

Shapes broadcast per NumPy rules, and rank 0 is a legal shape holding one
element. Strides are not part of the public surface: layout is owned by the
backend, and `reshape`, `transpose`, and `slice` are graph operations rather than
pointer arithmetic you perform.

## Indexing and slicing

```ts
const x = await tensor([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]);

x.slice([{ start: 1 }]);                    // rows 1 onwards, all columns
x.slice([null, { start: 1, step: 2 }]);     // every other column
x.slice([{ start: -2 }]);                   // the last two rows
x.narrow(1, 1, 2);                          // two columns from column 1
x.indexSelect(await tensor([2, 0], { dtype: 'i32' }), 0);  // rows by index
```

One specification per leading axis; `null`, or an axis past the end of the list,
takes that axis whole. Negative bounds count from the end, out-of-range bounds
clamp, and an inverted range is empty rather than an error — the same rules as
`Array.prototype.slice`. Steps must be positive; reversing an axis is not
supported.

A slice materialises rather than aliasing, because a strided region of contiguous
storage is not itself contiguous. It differentiates: the adjoint writes the
cotangent back into zeros at the positions it came from.

## Devices

```ts
import { device, listDevices } from 'fino:tensor';

console.log(await listDevices());
const dev = await device('auto'); // or 'cpu', 'metal:1', …
```

`device('auto')` picks the highest-priority available backend and cannot fail,
because the reference CPU backend always registers. `FINO_TENSOR_DEVICE` pins the
choice, which is how the differential tests select a backend.

### CPU matrix multiply

The CPU backend is a scalar TypeScript implementation — deliberately, since it is the
oracle every kernel is checked against — with one exception: matrix multiply goes
through whatever BLAS the platform has. Accelerate on macOS, OpenBLAS or BLIS on
Linux, `FINO_BLAS_LIBRARY` to name one directly. Matrix multiply is where nearly all
of a model's arithmetic lives and every platform already ships a tuned implementation,
so competing with it would be pointless; on this machine it is the difference between
600ms and 1ms for a 512x512 `f32` multiply.

It is used only where it cannot change an answer: `f32` and `f64`, contiguous
operands, no accumulation into the output. Anything else keeps the reference loop, and
so does a machine with no BLAS at all — `gpuUnavailableReasons()` has a counterpart in
`blasUnavailableReason()`. Everything other than matrix multiply is still scalar
TypeScript, so no other CPU figure from this engine should be read as performance.

### Moving between devices

```ts
const gpu = await device('auto');
const onGpu = await hostTensor.to(gpu);   // a tensor
await model.to(gpu);                      // a whole module, in place
```

A transfer is a readback followed by an upload, so it is a synchronisation point
and therefore `await`ed. Moving to the device a tensor already lives on returns the
same handle rather than copying.

Gradients do not flow back across a transfer: `backward()` is synchronous and a
transfer cannot be. A moved parameter keeps `requiresGrad` and accumulates its own
gradient on its new device, which makes `to` a setup operation rather than a
per-step one. `Module.to` disposes the tensors it replaces, so build the optimiser
*after* the move — it holds the parameters it was given, and those are the ones
left behind.

Bytes move rather than values, so an `f16` tensor crosses unchanged instead of
being widened and re-rounded. `f64` and `i64` exist only on the CPU, and moving one
to a GPU is refused rather than silently narrowed.

## Transformers

`MultiHeadAttention` and `TransformerBlock` are composed from the same primitives as
everything else — matmul, softmax, layer norm, and the elementwise set. There is no
attention kernel and no fused softmax:

```ts
import { TransformerBlock } from 'fino:tensor/nn';

const block = new TransformerBlock(256, 8);   // width, heads
await block.to(dev);
const y = block.forward(x);                   // [batch, tokens, channels]
```

Attention is causal by default, which is what makes a decoder a decoder — a position
may read itself and earlier ones, never later. Masked weights are exactly zero, so
changing a token cannot perturb anything before it. Pass `causal: false` for an
encoder.

Heads are expressed by reshaping the channel axis and folding the head axis into the
batch, so every projection is one batched GEMM rather than a loop. The block is
pre-norm: normalisation before each sub-layer rather than after, which keeps the
residual path an identity and lets a deep stack train without a warmup schedule.

## Saving and loading

```ts
import { loadSafetensors, saveSafetensors, openSafetensors } from 'fino:tensor/io';

await saveSafetensors('checkpoint.safetensors', model.stateDict());

const weights = await loadSafetensors('checkpoint.safetensors', { device: dev });
model.loadStateDict(weights);
```

safetensors and NumPy `.npy` are supported, both of which store row-major,
contiguous, little-endian bytes — the layout a device already wants — so loading is
a read rather than a decode. An `f16` tensor crosses unchanged instead of being
widened and re-rounded.

`openSafetensors` parses the header and then reads tensors individually, so
inspecting a checkpoint or loading one shard costs only what it touches:

```ts
const file = await openSafetensors('model.safetensors');
console.log(file.list());                  // names, dtypes, shapes, byte lengths
const one = await file.read('layers.0.weight', dev);
await file.close();
```

A malformed header is rejected before anything is allocated: a dtype this engine
cannot represent, a byte range that disagrees with its shape, or a range past the end
of the file all fail with the tensor named.

GGUF is not supported. Its value is its quantised block formats, and loading one
means dequantising it — kernels this engine does not yet have. PyTorch `.pt` files
are pickled Python object graphs, whose unpickling executes arbitrary constructors by
design; convert to safetensors instead.

## Conformance

```ts no_run
import { runConformance, formatReport } from 'fino:tensor/conformance';

console.log(formatReport(await runConformance('auto')));
```

`fino:tensor/graph` and `fino:tensor/backend` are experimental, and the contract keeps
them that way until an out-of-tree backend passes this suite. It is the thing such a
backend can run without living in this repository.

Every case is an ordinary `fino:tensor` program compared against the reference
backend, so conforming means computing the right numbers rather than implementing an
interface a particular way. A report lists which registered operations no case
exercised, so a partial run says so instead of implying more than it checked — and
running it on the reference device proves only that the cases execute, since that
backend is what everything else is compared against.

## Performance, measured

`benchmarks/tensor/gpu.bench.ts` reports achieved rates rather than iterations per
second, so the numbers can be held against the hardware instead of only against
yesterday's run. On an Apple silicon development machine:

| | Metal | Vulkan (MoltenVK) |
|---|---|---|
| GEMM 1024³ | ~4800 GFLOP/s | ~4800 GFLOP/s |
| GEMM 512³ | ~2200 GFLOP/s | ~3600 GFLOP/s |
| elementwise | ~60 Gelem/s | ~55 Gelem/s |

None of this is claimed to be fast. It is claimed to be true, which is what makes it
possible to tell whether a change helped.

### Undefined is not the same as unspecified

`pow` used to lower straight to each dialect's own. SPIR-V says the result is undefined
when the base is negative, and the two implementations differ accordingly: MoltenVK
returns a usable number, lavapipe returns a NaN. Both are conformant, so the operation
could not be left to them, and it is now computed from the magnitude with the sign IEEE
gives it — matching `Math.pow` on every backend, for even, odd, fractional, and negative
exponents.

The general lesson is worth keeping: an operation the specification leaves undefined
will work on the driver it was written against and cannot be relied on anywhere else.

Elementwise operations are **not** bandwidth-bound. A write-only fill, a read-and-write
unary, and a two-read binary all take about the same time per element while moving one,
two, and three words, so the cost tracks elements rather than bytes; a
bytes-per-second figure alone would suggest a memory limit that is not the one being
hit. Giving each thread more elements changes nothing either, which rules out
scheduling. The generated kernels match hand-written Metal doing the same work, so
what remains is the width of a single operation — each thread handles one scalar, and
a `float4` version of the same hand-written kernel is about a fifth faster again.

### Measuring this correctly

The first version of these figures was three times too low, in a way worth recording
because the mistake is easy to repeat. Dispatch is non-blocking, so a timing loop has
to synchronise somewhere; reading the result back is the obvious way and it is wrong,
because for a sixteen-million-element tensor that folds sixty-four megabytes of
transfer into the timing. Divided across too few iterations it dominated, and made the
kernels look far slower than they are — slow enough that the gap appeared to be in the
generated code, which it was not.

The benchmark now drains the queue by reading a single element, and runs enough
iterations that fixed costs stop mattering.

### A second Vulkan implementation

Everything above runs on MoltenVK, which is Vulkan on top of Metal. That is one
implementation, and an implementation agreeing with itself proves less than it appears
to — the SPIR-V this engine emits is only as portable as the drivers that have consumed
it.

Mesa's lavapipe is a software Vulkan driver with an entirely separate SPIR-V compiler,
and it runs on this machine:

```sh
brew install mesa
VK_ICD_FILENAMES=/opt/homebrew/share/vulkan/icd.d/lvp_icd.aarch64.json   cargo run -- test 'tests/tensor/*.test.ts'
```

The whole conformance suite passes there, as do the differential, gradient, kernel, and
optimizer suites, and the miniature transformer trains to convergence. It is slow — it
is a CPU rasterising compute — but it is the only evidence so far that the emitted
SPIR-V is not simply MoltenVK-shaped.

It earned its keep immediately, on a defect no amount of running against MoltenVK would
have found: see `pow` below. Real non-Apple hardware is still untested.

## Diagnostics

- `poolStats(device)` reports held, in-use, and leaked buffer counts.
- `gpuUnavailableReasons()` explains why a GPU backend is absent.
- `FINO_TENSOR_SYNC=1` synchronises after every launch so a device error is
  attributed to the operation that caused it rather than to the next readback.
- `FINO_TENSOR_DEBUG=1` enables backend validation layers.

## Building models

`fino:tensor/nn` provides `Module`, the layers a transformer needs, the standard
losses, and seeded initialisers; `fino:tensor/optim` provides SGD, Adam, AdamW,
gradient clipping, and schedules.

```ts
import { Linear, mseLoss } from 'fino:tensor/nn';
import { Adam } from 'fino:tensor/optim';
import { Generator, tensor, tidy } from 'fino:tensor';

const model = new Linear(4, 1, { generator: new Generator(42) });
const optimizer = new Adam(model.parameters(), { lr: 0.01 });

const x = await tensor([[1, 2, 3, 4]]);
const y = await tensor([[1]]);

for (let step = 0; step < 100; step++) {
  tidy(() => mseLoss(model.forward(x), y).backward());
  optimizer.step();
  optimizer.zeroGrad();
}
```

Gradients written onto parameters survive the enclosing `tidy` scope, since the
parameters themselves do — so the loop above needs no `keep`.

Initialisation and dropout draw from an explicit `Generator`, so a run is
reproducible from one seed. Sampling is counter-based rather than sequential,
which is what lets a GPU kernel and the reference implementation produce the same
stream rather than merely similar distributions.

## Inspecting the graph

`fino:tensor/graph` exposes the recording: node kinds, traversal, a content hash,
and partitioning across devices of differing capability. It is the seam a fusion
pass, capture/replay, ONNX export, and fixed-function accelerator lowering all
attach to.

```ts
import { currentGraph } from 'fino:tensor';

const graph = currentGraph();
const start = graph.length;
// … run a step …
console.log(graph.slice(start, graph.length).hash());
```

Structurally identical steps hash equal, which is what a future capture/replay
pass keys on.
