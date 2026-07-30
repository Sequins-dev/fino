# Tensor Engine Contract

> Status: normative specification. Implementers of `fino:tensor`, any
> `fino:tensor/backend` implementation, and any consumer of `fino:tensor/graph`
> follow this document rather than inventing semantics.
>
> Every rule here has an acceptance-test shape named in §12. A rule without a
> test is a rule that will drift.

## 1. Scope and stability

`fino:tensor` is the stable user surface. `fino:tensor/graph` and
`fino:tensor/backend` are **experimental**: they are public because out-of-tree
backends, graph consumers, and fixed-function accelerator lowering all need
them, not because their shape is settled.

Promotion gate — these two modules stop being experimental only when **two
in-tree backends and one out-of-tree backend** pass the conformance suite.

Additive-versus-breaking, for this interface specifically:

- Adding an `EwOp` / `RedOp` / node-kind enum member is **additive**.
- Adding a required `DeviceBackend` method is **breaking** — out-of-tree
  implementations fail at call time, not at type-check time. Prefer a new
  capability flag plus an optional method.
- Widening an accepted dtype for an existing op is additive; narrowing is
  breaking.

## 2. Dtypes

```
'f64' | 'f32' | 'f16' | 'bf16' | 'i64' | 'i32' | 'u8' | 'bool'
```

| dtype | bytes | host array | notes |
|---|---|---|---|
| `f64` | 8 | `Float64Array` | reference/oracle, gradcheck, linalg. **CPU only** — no GPU this engine targets supports it. |
| `f32` | 4 | `Float32Array` | the default float dtype. |
| `f16` | 2 | `Uint16Array` (bits) | IEEE binary16. |
| `bf16` | 2 | `Uint16Array` (bits) | truncated binary32; 8-bit exponent, 7-bit mantissa. |
| `i64` | 8 | `BigInt64Array` | indices and interop only. **CPU only.** |
| `i32` | 4 | `Int32Array` | the default integer dtype. |
| `u8` | 1 | `Uint8Array` | |
| `bool` | 1 | `Uint8Array` | one byte per element, never bit-packed. Values are exactly 0 or 1. |

A backend declares the subset it supports in `caps.dtypes`. Requesting an
unsupported dtype throws — at tensor *creation*, not at the first operation,
because a device that cannot represent a dtype should say so when asked to hold
one and must never silently narrow a choice made deliberately.

`f16` and `bf16` are **storage** dtypes. Operations compute in `f32` internally
and round to the storage dtype on store. This is observable: a chain of `f16`
operations equals the same chain in `f32` with a round after each step, not a
fully `f16`-internal computation.

### 2.1 Promotion lattice

Rank order, lowest first:

```
bool  <  u8  <  i32  <  i64  <  {f16, bf16}  <  f32  <  f64
```

For two tensor operands, `promote(a, b)`:

1. If `a === b`, the result is `a`.
2. If both are floating, the higher-ranked wins, **except**
   `promote(f16, bf16) === 'f32'` — neither can represent the other's range, so
   promoting to either would lose information silently.
3. If exactly one is floating, that floating dtype wins. An integer operand never
   widens a float operand: `i64 + f16 → f16`.
4. Otherwise the higher-ranked wins.

`promote` is commutative and associative. Multi-operand operations fold it left
to right.

### 2.2 Weak scalars

A JS `number` operand is *weak*: it adopts the tensor's dtype rather than
promoting it. Given tensor dtype `T` and number `v`:

- `T` floating → result `T`. (`f16Tensor.mul(2.0)` stays `f16`.)
- `T` integral and `Number.isInteger(v)` → result `T`.
- `T` integral and `v` fractional → result `f32`.
- `T === 'bool'` and `v` integral → `i32`; fractional → `f32`.

A number outside the resulting dtype's range throws rather than wrapping.

### 2.3 Fixed result dtypes

- Comparisons and `logicalNot` → `bool`, always.
- `argmax`, `argmin` → `i32`.
- `any`, `all` → `bool`.
- `div` on two integral operands → `f32`. There is no integer division operator;
  floor division is `a.div(b).floor()` and is explicit about its cost.
- `mean` on an integral input → `f32`. `sum`/`prod` keep the input dtype and may
  overflow; that is the caller's choice.
- `cast(dtype)` is the only way to change dtype without an arithmetic reason.

## 3. Shapes and broadcasting

Shapes are `readonly number[]` of non-negative integers. Rank 0 (`[]`, one
element) is legal and is what a full reduction returns. Rank is capped at 8. Any
dimension may be 0; operations on empty tensors produce empty outputs without
dispatching a kernel.

Broadcasting follows NumPy/PyTorch: right-align, pad the shorter with leading 1s,
then per axis require equal sizes or one of them 1, taking the other operand's
size. A size-1 axis against a size-0 axis therefore yields 0 — the result stays
empty rather than becoming 1.

A size-1 axis is stretched by re-reading the same element; no data is copied.
Mismatched axes throw synchronously, naming both shapes and the axis index.

`matmul` is not elementwise: the last two axes form the matrix and all leading
axes broadcast. 1-D operands are promoted per PyTorch and the promoted axis is
removed from the result.

## 4. Layout, views, and copies

**Strides are not public.** `Tensor` exposes a logical shape only. Layout is owned
by the backend and appears solely in `TensorDesc`.

Consequences user code *can* depend on:

- `reshape` on contiguous storage returns a new `Tensor` sharing that storage. No
  copy, no kernel. Storage is reference-counted, so an aliasing handle keeps it
  alive and a collected handle releases exactly one reference.
- `transpose`, `permute`, `slice`, `expand`, and `concat` are graph operations,
  permitted to materialise a copy, and never pointer arithmetic the caller
  performs.
- No operation mutates its inputs. There is no in-place arithmetic, so no version
  counters and no aliasing hazards.
- `detach()` shares storage and drops the gradient edge. `clone()` copies.

## 5. Devices

```ts
interface Device { readonly type: string; readonly index: number }
```

`type` names the **backend** (`'cpu'`, `'metal'`, `'vulkan'`, …), not a vendor.
Devices are discovered through the registry, never assumed.

`device('auto')` walks registered providers in descending priority and takes the
first that yields a device, so an accelerator is preferred when present. The CPU
reference provider always succeeds, so `device('auto')` cannot fail.
`FINO_TENSOR_DEVICE` overrides the choice.

Resolution must agree between the synchronous and asynchronous paths.
Synchronous constructors — `nn` layers, initialisers — resolve the same default
that `await device()` returns, or a model's weights and its inputs would land on
different devices.

Every tensor in one operation must live on the same device; mixing throws.
`to(device)` is the only cross-device move and is **async**, because it is a
synchronisation point.

## 6. Execution and synchronization

Dispatch is eager and non-blocking. An operation records a graph node, allocates
its output from a stream-ordered pool, enqueues work, and returns.

The **only** synchronisation points are `await t.data()`, `await t.item()`,
`await t.to(other)`, and an explicit `backend.sync(stream)`.

Readback resolves a promise: a worker parks on a device fence and the event loop
keeps running.

Ordering guarantee: operations dispatched in program order on one device observe
each other's effects in that order. A backend whose kernels compile
asynchronously must still preserve that order — submission order is program
order, not completion order of compilations.

`data()` returns the dtype's host array. `f16`/`bf16` return a freshly converted
`Float32Array`, which is a copy, because there is no host half-float array type.

## 7. Numerical accuracy

The reference backend is the **oracle**. It accumulates every floating reduction
in `f64` regardless of storage dtype and rounds through the storage precision on
each store, so it models half precision faithfully rather than approximately.

Accelerated backends are compared against it as
`|got - want| <= atol + rtol * |want|`:

| dtype | rtol | atol |
|---|---|---|
| `f64` | 1e-12 | 1e-15 |
| `f32` | 1e-5 | 1e-7 |
| `f16` | 1e-2 | 1e-4 |
| `bf16` | 8e-2 | 1e-3 |

Reductions and `matmul` scale `atol` by `sqrt(reductionLength)`. Integer and
`bool` results must match exactly.

Not promised: bit-identical results across backends, a fixed reduction order, or
reproducibility across engine versions for reductions. Promised: results within
tolerance, determinism for a fixed (backend, version, shape, dtype), and no
silent NaN or infinity laundering — fast-math relaxations that change either are
disabled.

## 8. Randomness

All randomness flows through an explicit seeded `Generator`. There is no implicit
global state.

A `Generator` holds a 64-bit seed and a 64-bit offset. **splitmix64** advances and
mixes the seed; `split(n)` derives an independent substream.

Sampling is **counter-based**, not sequential: element `i` of an operation with
counter base `c` comes from `philox4x32_10(key, counter = c + (i >> 2))`, lane
`i & 3`. Dispatching a random operation advances the offset by `ceil(numel / 4)`.

That is what makes the scheme portable: any thread on any device computes element
`i` independently, so a GPU kernel and the reference implementation produce the
*same* stream rather than merely similarly distributed ones.

Derivations from a `u32` word `x`:

- uniform `f32` in `[0, 1)`: `(x >>> 8) * 2**-24`.
- normal: Box–Muller over two uniforms, with the first clamped away from zero.
- bernoulli(p): `uniform < p`.
- randint in `[lo, hi)`: the high word of `x * (hi - lo)` — no modulo bias.

Random operations record `{ key, counter }` as node attributes, so a recording
replays to identical values.

## 9. The recorded graph

The tape records every dispatched operation, forward and backward. It is a
*recording with a documented shape*, not a compiler IR.

Node fields, all stable: `op`, `inputs`/`outputs` as `ValueId`s (single-assignment,
since there are no in-place operations), `attrs` (JSON-representable only),
output `shapes` and `dtypes`, and `device`.

The tape holds **no tensor references**, so recording never keeps device memory
alive; only user handles and autodiff's saved tensors do.

`hash()` is a 64-bit content hash folded per node. It covers op kinds, dtypes,
shapes, attributes, and the *relative* input offsets rather than absolute ids, so
two structurally identical steps hash equal. A span's hash folds its nodes' own
hashes; combining two running-hash snapshots would be wrong, because FNV is not a
group and the difference between two states does not identify what lies between.

`markStep()` records a boundary. Ranges before the previous boundary may be
dropped once no gradient node refers into them.

### 9.1 Device classes and partitioning

`caps.class === 'kernel'` devices take work per operation and compile our
kernels. `caps.class === 'graph'` devices take a whole subgraph, compile it ahead
of execution, and support only a subset of operations, shapes, and dtypes.

`supportsOp(op, operands)` is **required** on every backend — trivially `true` for
a fully general one — so the partitioner never special-cases its absence.

`partition(graph, targets)` walks in topological order, assigns each node to the
highest-priority target that accepts it, falls back to the reference backend, and
merges adjacent same-target nodes. Each partition reports its crossing values,
which is where transfers go. v1 has no cost model; placement is
correctness-driven, and a region is never given to a target that cannot run every
node in it.

## 10. Memory and disposal

Device memory is invisible to the garbage collector, so disposal is explicit and
documented as the norm:

1. `using t = ...` / `t.dispose()` — deterministic, preferred.
2. `tidy(fn)` — disposes every tensor created inside except those returned or
   marked `keep()`. A gradient assigned to a leaf survives the scope, because the
   leaf it is attached to does.
3. Autodiff releases each gradient node's saved tensors as backward consumes them.
4. A `FinalizationRegistry` backstop releases **exactly one** reference for a
   handle dropped without disposal, and counts it so leaks are measurable. Exactly
   one matters: storage is shared by aliasing handles, and freeing it outright
   would be a use-after-free that appears only when the collector happens to run.

Freeing is stream-ordered: a buffer released on a stream is reusable by later work
on that stream without a fence, because the release is ordered behind its last
reader.

Using a disposed tensor throws.

## 11. Errors

Programmer errors — shape mismatch, dtype mismatch, wrong device, disposed
tensor, `item()` on a non-scalar, an unsupported dtype — throw **synchronously**,
with a JS stack pointing at the offending call.

One programmer error is the exception: an **out-of-range index** into a gather or
scatter. Detecting it requires reading index values, which on an accelerated
backend is a synchronisation point, so a kernel records the offending index and
the next synchronisation point raises it. The reference backend, executing inline,
still throws at dispatch.

Device errors surface **lazily**, at the next synchronisation point. That is the
price of non-blocking dispatch: the failing launch has long returned by the time
the device reports.

Two diagnostics recover precision: `FINO_TENSOR_SYNC=1` synchronises after every
launch, attributing an error to the exact operation; `FINO_TENSOR_DEBUG=1` enables
backend validation layers.

## 12. Acceptance-test shapes

| Area | Test shape |
|---|---|
| §2.1–2.3 promotion | every dtype pair through `promote`, asserting commutativity and the `f16`+`bf16` case; every fixed-result operation asserted |
| §2 dtype support | an unsupported dtype refused at creation, naming the device and what it does support |
| §2.2 weak scalars | each tensor dtype × {integral, fractional}, plus out-of-range throws |
| §3 broadcasting | shape-pair table incl. rank padding, size-1 stretch, 0-sized axes, rank-8 limit, mismatch throws; matmul incl. 1-D promotion and batch broadcast |
| §4 views | `reshape` shares storage (pool stats show no allocation); a collected alias leaves the original usable |
| §5 devices | `device('auto')` prefers an accelerator and cannot fail; the synchronous and asynchronous paths agree; cross-device operations throw |
| §6 sync | `data()`/`item()` correct; `item()` on a non-scalar throws; a timer fires while a device fence is outstanding |
| §7 accuracy | every operation × dtype × shape diffed against the oracle at the tolerance table; NaN/Inf preserved |
| §8 randomness | the same seed gives the same trajectory on every backend, element for element; `split` substreams decorrelated |
| §9 graph | recorded fields match dispatch; identical steps hash equal, different shapes differ; `markStep` truncation frees nodes; `partition` places every node and reports crossings |
| §10 memory | `tidy` disposes all but returned; pool stats return to baseline across a training step; the leak counter observes a deliberate leak |
| §11 errors | each programmer error throws synchronously; an out-of-range index is refused, at dispatch on the reference backend and at the next sync point on a GPU |

Gradients get their own oracle, independent of kernels: `gradCheck` compares
`backward()` cotangents against `f64` central finite differences on the reference
backend. Every operation with a gradient rule must appear in gradcheck coverage —
the harness fails if one does not. It runs on the CPU by construction, since `f64`
is where a difference quotient is meaningful and no GPU here provides it.
