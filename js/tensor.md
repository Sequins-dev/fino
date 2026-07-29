---
weight: 145
---
# Tensor

`fino:tensor` provides tensors, eager execution, and reverse-mode automatic
differentiation in pure TypeScript over a thin device-backend interface.

The engine is **experimental**. Its semantics are specified normatively in
`docs/tensor-contract.md`, and the `fino:tensor/graph` and `fino:tensor/backend`
surfaces carry weaker stability promises than the rest of the runtime — see §1 of
that document.

Only the reference CPU backend is currently registered. It is correct, and it is
the oracle every other backend is tested against, but it is a scalar TypeScript
implementation: it is a shipping fallback, not this engine's performance story.
GPU backends (Metal, Vulkan) are in progress.

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

## Devices

```ts
import { device, listDevices } from 'fino:tensor';

console.log(await listDevices());
const dev = await device('auto'); // or 'cpu', 'metal:1', …
```

`device('auto')` picks the highest-priority available backend and cannot fail,
because the reference CPU backend always registers. `FINO_TENSOR_DEVICE` pins the
choice, which is how the differential tests select a backend.

## Diagnostics

- `poolStats(device)` reports held, in-use, and leaked buffer counts.
- `FINO_TENSOR_SYNC=1` synchronises after every launch so a device error is
  attributed to the operation that caused it rather than to the next readback.
- `FINO_TENSOR_DEBUG=1` enables backend validation layers.

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
