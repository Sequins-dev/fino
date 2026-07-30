/**
 * `fino:tensor` — tensors, eager execution, and automatic differentiation.
 *
 * A PyTorch-shaped API where dispatch is non-blocking and the only place anything
 * waits is reading values back:
 *
 * ```ts no_run
 * import { tensor, tidy } from 'fino:tensor';
 *
 * const x = await tensor([[1, 2], [3, 4]]);
 * const w = await tensor([[0.5], [-0.5]], { requiresGrad: true });
 *
 * const loss = tidy(() => x.matmul(w).relu().sum());
 * loss.backward();
 * console.log(await loss.item(), await w.grad!.data());
 * ```
 *
 * ## Disposal is not optional
 *
 * Device memory is invisible to the garbage collector, so an eight-byte handle
 * can pin gigabytes. Wrap work in `tidy`, or use `using`, from the first line you
 * write rather than after the first time you run out of memory. A finalizer
 * reclaims leaked storage eventually and counts it in `poolStats()`, but "eventually"
 * is not a memory strategy for a training loop.
 *
 * ## Status
 *
 * Experimental, and specified by `specs/tensor-contract.md`. `fino:tensor/graph`
 * and `fino:tensor/backend` are public so out-of-tree backends and graph
 * consumers can exist, and are the least settled part of the surface; see the
 * contract's §1 for what stability they do and do not promise.
 *
 * `device('auto')` prefers a GPU when one is present — Metal on Apple hardware,
 * Vulkan elsewhere — and falls back to the reference CPU backend, which always
 * registers and so cannot fail. The reference backend is the oracle every other
 * backend is differentially tested against, but it is a scalar TypeScript
 * implementation and should never be quoted as this engine's performance.
 *
 * `f64` and `i64` are CPU-only: no GPU this engine targets represents them, and
 * asking a GPU to hold one is refused rather than silently narrowed.
 */
import { registerBackend, registerDevice, resolveDevice } from './backend.ts';
import type { Device } from './backend.ts';
import { RefBackend, refProvider } from './ref/backend.ts';
import { metalProvider, vulkanProvider } from './gpu/index.ts';
import { fromHostValues, defaultDevice, setDefaultDevice } from './create.ts';
import { DTYPE_BYTES } from './dtype.ts';
import type { DType, HostArray } from './dtype.ts';
import { Tensor } from './tensor.ts';
import { checkShape, numel } from './shape.ts';
import { computeStream } from './dispatch.ts';
import { backendFor } from './backend.ts';
import { allocStorage } from './tensor.ts';
import { currentGraph } from './graph.ts';
import { installReadbackHooks, readScalar, readTensor } from './readback.ts';
import { to } from './transfer.ts';
import { poolFor } from './pool.ts';
import type { PoolStats } from './pool.ts';

// Registering the reference provider at import is what makes `device('auto')`
// unable to fail, and what lets everything above depend on `fino:tensor`
// unconditionally. The backend is also registered eagerly so `cpu:0` resolves
// without awaiting discovery, which synchronous layer constructors rely on.
registerBackend(refProvider);
registerDevice(new RefBackend());

// The GPU providers are registered but not probed: probing creates a device, which
// is too much to do at import. `device('auto')` and `listDevices()` probe on demand,
// and a provider that finds nothing simply yields no devices.
registerBackend(metalProvider);
registerBackend(vulkanProvider);

// Importing the operations registers every primitive and installs the Tensor
// methods.
import './ops/index.ts';
import { fillOf, reshape } from './ops/index.ts';

installReadbackHooks((t) => reshape(t, t.shape));

// -- readback methods ---------------------------------------------------------

Object.defineProperty(Tensor.prototype, 'data', {
  value: function data(this: Tensor): Promise<HostArray> {
    return readTensor(this);
  },
  writable: true,
  configurable: true,
});

Object.defineProperty(Tensor.prototype, 'item', {
  value: function item(this: Tensor): Promise<number> {
    return readScalar(this);
  },
  writable: true,
  configurable: true,
});

// A transfer reads back and re-uploads, so it belongs with the readback methods
// rather than the operations: it is a synchronisation point, not a recorded node.
Object.defineProperty(Tensor.prototype, 'to', {
  value: function toDevice(this: Tensor, target: 'auto' | string | Device): Promise<Tensor> {
    return to(this, target);
  },
  writable: true,
  configurable: true,
});

// -- creation -----------------------------------------------------------------

/** Options shared by the creation helpers. */
export interface CreateOptions {
  /** Element type. Defaults to `f32`. */
  dtype?: DType;
  /** Device, resolved through the registry. Defaults to `'auto'`. */
  device?: 'auto' | string | Device;
  /** Whether gradients should flow to the result. */
  requiresGrad?: boolean;
}

/**
 * Resolve creation options.
 *
 * @internal
 */
async function resolve(options: CreateOptions): Promise<{ dtype: DType; device: Device }> {
  return {
    dtype: options.dtype ?? 'f32',
    device: await resolveDevice(options.device ?? 'auto'),
  };
}

/** Nested array accepted by {@link tensor}. */
export type NestedArray = number | boolean | readonly NestedArray[];

/**
 * Infer the shape of a nested array, checking it is rectangular.
 *
 * @internal
 */
function inferShape(value: NestedArray): number[] {
  const shape: number[] = [];
  let node: NestedArray = value;
  while (Array.isArray(node)) {
    shape.push(node.length);
    if (node.length === 0) break;
    node = node[0]!;
  }
  return shape;
}

/**
 * Flatten a nested array, verifying it matches the inferred shape.
 *
 * @internal
 */
function flattenInto(value: NestedArray, shape: readonly number[], depth: number, out: number[]): void {
  if (depth === shape.length) {
    if (Array.isArray(value)) throw new Error('nested array is deeper than its first row');
    out.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error('nested array is shallower than its first row; rows must be rectangular');
  }
  if (value.length !== shape[depth]) {
    throw new Error(
      `nested array is ragged: expected ${shape[depth]} entries at depth ${depth}, found ${value.length}`,
    );
  }
  for (const item of value) flattenInto(item, shape, depth + 1, out);
}

/** Build a tensor from a nested array or a typed array. */
export async function tensor(
  values: NestedArray | ArrayLike<number>,
  options: CreateOptions & { shape?: readonly number[] } = {},
): Promise<Tensor> {
  const { dtype, device } = await resolve(options);
  let flat: number[];
  let shape: readonly number[];
  const flatArray =
    Array.isArray(values) &&
    values.every((v) => typeof v === 'number' || typeof v === 'boolean');
  if (flatArray) {
    // A flat array plus an explicit shape is the common case for generated data,
    // and does not need to be nested first.
    flat = (values as readonly (number | boolean)[]).map((v) =>
      typeof v === 'boolean' ? (v ? 1 : 0) : v,
    );
    shape = options.shape ?? [flat.length];
  } else if (Array.isArray(values) || typeof values === 'number' || typeof values === 'boolean') {
    shape = options.shape ?? inferShape(values as NestedArray);
    flat = [];
    flattenInto(values as NestedArray, shape, 0, flat);
  } else {
    const array = values as ArrayLike<number>;
    flat = Array.from(array);
    shape = options.shape ?? [flat.length];
  }
  checkShape(shape);
  if (flat.length !== numel(shape)) {
    throw new Error(
      `${flat.length} values do not fill shape [${shape.join(', ')}] (${numel(shape)} elements)`,
    );
  }
  return fromHostValues(flat, shape, dtype, device, options.requiresGrad ?? false);
}

/** A tensor of zeros. */
export async function zeros(
  shape: readonly number[],
  options: CreateOptions = {},
): Promise<Tensor> {
  const { dtype, device } = await resolve(options);
  const out = fillOf(shape, dtype, device, 0);
  out.requiresGrad = options.requiresGrad ?? false;
  return out;
}

/** A tensor of ones. */
export async function ones(
  shape: readonly number[],
  options: CreateOptions = {},
): Promise<Tensor> {
  const { dtype, device } = await resolve(options);
  const out = fillOf(shape, dtype, device, 1);
  out.requiresGrad = options.requiresGrad ?? false;
  return out;
}

/** A tensor filled with one value. */
export async function full(
  shape: readonly number[],
  value: number,
  options: CreateOptions = {},
): Promise<Tensor> {
  const { dtype, device } = await resolve(options);
  const out = fillOf(shape, dtype, device, value);
  out.requiresGrad = options.requiresGrad ?? false;
  return out;
}

/** Zeros shaped like an existing tensor. */
export function zerosLike(t: Tensor): Tensor {
  return fillOf(t.shape, t.dtype, t.device, 0);
}

/** Ones shaped like an existing tensor. */
export function onesLike(t: Tensor): Tensor {
  return fillOf(t.shape, t.dtype, t.device, 1);
}

/** A one-dimensional arithmetic sequence. */
export async function arange(
  count: number,
  options: CreateOptions & { start?: number; step?: number } = {},
): Promise<Tensor> {
  const { dtype, device } = await resolve(options);
  const { arangeOf } = await import('./ops/index.ts');
  return arangeOf(count, dtype, device, options.start ?? 0, options.step ?? 1);
}

/** Resolve a device specification. */
export async function device(spec: 'auto' | string | Device = 'auto'): Promise<Device> {
  return resolveDevice(spec);
}

/** Pool counters for a device, for leak and fragmentation diagnostics. */
export function poolStats(dev: Device): PoolStats {
  return poolFor(backendFor(dev)).stats();
}

// -- re-exports ---------------------------------------------------------------

export { Tensor } from './tensor.ts';
export { tidy, keep } from './tensor.ts';
export type { PoolStats } from './pool.ts';
export { noGrad, enableGrad, gradEnabled } from './autograd.ts';
export type { BackwardOptions } from './autograd.ts';
export type { DType, HostArray } from './dtype.ts';
export {
  DTYPES,
  DTYPE_BYTES,
  isFloat,
  isInteger,
  isSigned,
  promote,
  promoteScalar,
  f16ToF32,
  f32ToF16,
  bf16ToF32,
  f32ToBf16,
  roundToDType,
} from './dtype.ts';
export type { Device } from './backend.ts';
export { formatDevice, sameDevice, listDevices, registerBackend } from './backend.ts';
export { to } from './transfer.ts';
export type { SliceSpec } from './shape.ts';
export {
  MAX_RANK,
  broadcastShapes,
  broadcastAll,
  matmulShape,
  numel,
} from './shape.ts';
export { currentGraph } from './graph.ts';
export { gpuUnavailableReasons } from './gpu/index.ts';
export { Generator } from './generator.ts';
export { defaultDevice, setDefaultDevice } from './create.ts';
export {
  add,
  castTo as cast,
  concat,
  cos,
  div,
  exp,
  expand,
  flatten,
  indexSelect,
  log,
  logSoftmax,
  matmul,
  maximum,
  mean,
  minimum,
  mul,
  narrow,
  neg,
  permute,
  pow,
  reshape,
  rsqrt,
  scatterAdd,
  sigmoid,
  sign,
  sin,
  slice,
  softmax,
  sub,
  sum,
  transpose,
  where,
} from './ops/index.ts';
