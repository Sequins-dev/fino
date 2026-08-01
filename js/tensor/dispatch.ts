/**
 * The eager dispatch path.
 *
 * Every operation call goes through here: infer dtype and shape, take an output
 * buffer from the pool, append a graph node, build a gradient edge if anything
 * downstream could need one, and enqueue the work. Nothing waits on the device.
 *
 * The per-call cost is one `Tensor` and one `Storage` — both user-visible and
 * therefore unavoidable. Everything else is reused: descriptors come from a
 * scratch pool, the recording appends into typed columns, and operations are
 * looked up by dense integer index rather than by name.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import { DTYPE_BYTES } from './dtype.ts';
import type { Device, DeviceBackend, Stream, TensorDesc } from './backend.ts';
import { backendFor, formatDevice, requireDType, sameDevice } from './backend.ts';
import { buildGradNode, setNodeOutput } from './autograd.ts';
import { env } from 'internal:process';
import { currentGraph } from './graph.ts';
import type { Leaf, Pending } from './fusion.ts';
import { planChain } from './fusion.ts';
import { narrowOperands } from './amp.ts';
import { isFloat } from './dtype.ts';
import type { OpId } from './ops/registry.ts';
import { opById } from './ops/registry.ts';
import { numel } from './shape.ts';
import type { OpAttrs } from './backend.ts';
import { Storage, Tensor, allocStorage, installFusionHooks } from './tensor.ts';

/**
 * The compute stream per backend.
 *
 * v1 uses one compute stream. A second stream for host-to-device prefetch is
 * where a data loader will attach; more than two is where eager engines start to
 * rot, so they wait for a demonstrated need.
 *
 * @internal
 */
const streams = new WeakMap<DeviceBackend, Stream>();

/** The compute stream for a backend. */
export function computeStream(backend: DeviceBackend): Stream {
  let stream = streams.get(backend);
  if (!stream) {
    stream = backend.createStream();
    streams.set(backend, stream);
  }
  return stream;
}

/**
 * Reusable descriptors, indexed by operand position.
 *
 * Backends are contractually forbidden from retaining a descriptor past the
 * call, which is what makes this safe.
 *
 * @internal
 */
const scratch: TensorDesc[] = [];

/**
 * @internal
 */
function descAt(index: number): TensorDesc {
  let desc = scratch[index];
  if (!desc) {
    desc = {
      buffer: { byteLength: 0 },
      dtype: 'f32',
      shape: [],
      strides: [],
      offset: 0,
    };
    scratch[index] = desc;
  }
  return desc;
}

/**
 * Whether an operation is being dispatched, so nested dispatch does not reuse
 * the same scratch descriptors.
 *
 * A gradient rule dispatches operations, but only after the forward call has
 * returned, so nesting is shallow; the guard exists to make a violation loud
 * rather than silently corrupting operands.
 *
 * @internal
 */
let depth = 0;

/** Verify every operand agrees on device, and return it. */
function requireSameDevice(inputs: readonly Tensor[]): Device {
  const first = inputs[0]!.device;
  for (let i = 1; i < inputs.length; i++) {
    const device = inputs[i]!.device;
    if (!sameDevice(first, device)) {
      throw new Error(
        `operands are on different devices: ${formatDevice(first)} and ${formatDevice(device)}; move one with to()`,
      );
    }
  }
  return first;
}

/** Options for {@link dispatch}. */
export interface DispatchOptions {
  /**
   * Device for operations with no tensor inputs, such as `zeros` or `arange`.
   */
  device?: Device;
  /**
   * Reuse an input's storage for the output.
   *
   * Used by metadata-only operations such as a contiguous `reshape`, which need a
   * new handle rather than new memory.
   */
  aliasOf?: Tensor;
  /** Strides for an aliasing output. */
  strides?: readonly number[];
  /** Element offset for an aliasing output. */
  offset?: number;
}

/**
 * Re-enter dispatch with narrowed operands.
 *
 * Separate so the ordinary path has no branch to unwind: narrowing happens once, and
 * the recursive call sees operands that are already the right width.
 *
 * @internal
 */
function dispatchNarrowed(
  op: OpId,
  inputs: readonly Tensor[],
  attrs: OpAttrs | null,
  options: DispatchOptions,
): Tensor {
  return dispatch(op, inputs, attrs, options);
}

/**
 * Run a deferred chain into its output's storage.
 *
 * Installed on `Tensor` rather than called from it, because the tensor module cannot
 * reach dispatch without a cycle.
 *
 * @internal
 */
/**
 * Whether elementwise work is deferred, resolved once.
 *
 * `FINO_TENSOR_FUSION=0` turns it off, which is how the two paths get compared and how
 * a suspected fusion bug is bisected without editing anything.
 *
 * @internal
 */
let fusion: boolean | null = null;
function fusionEnabled(): boolean {
  fusion ??= env.FINO_TENSOR_FUSION !== '0';
  return fusion;
}

/**
 * Take an operand's descriptor and a claim on its storage.
 *
 * @internal
 */
function captureLeaf(tensor: Tensor): Leaf {
  tensor.storage.retain();
  return {
    tensor,
    desc: tensor.describe({
      buffer: null as never,
      dtype: tensor.dtype,
      shape: [],
      strides: [],
      offset: 0,
    }),
    storage: tensor.storage,
  };
}

/**
 * Fused chains executed so far.
 *
 * A diagnostic, and the only way to tell from outside that fusion happened at all —
 * fusing changes when work runs, never what it computes, so nothing else observes it.
 *
 * @internal
 */
let chainRuns = 0;

/** Number of fused elementwise chains this process has executed. */
export function chainRunCount(): number {
  return chainRuns;
}

function runPendingChain(out: Tensor, pending: Pending): void {
  chainRuns++;
  const backend = out.backend;
  const stream = computeStream(backend);
  // Fresh descriptors: the shared scratch is reused between operands and these are all
  // live at once.
  const describe = (t: Tensor): TensorDesc =>
    t.describe({ buffer: null as never, dtype: t.dtype, shape: [], strides: [], offset: 0 });
  backend.elementwiseChain!(
    pending.steps,
    pending.leaves.map((leaf) => leaf.desc),
    describe(out),
    stream,
  );
}

installFusionHooks(runPendingChain);

/**
 * Decide whether an operation can join a fused chain, and build it if so.
 *
 * Refuses everything it is not certain about. Fusing changes when work happens, never
 * what the work is, so the conditions here are about keeping that true: the backend has
 * to be able to run a chain, every operand has to have the output's shape and type, and
 * the operation has to be one the chain vocabulary describes.
 *
 * @internal
 */
function planFusion(
  spec: OpSpec,
  inputs: readonly Tensor[],
  attrs: OpAttrs | null,
  shape: readonly number[],
  dtype: DType,
  backend: DeviceBackend,
): Pending | null {
  if (!fusionEnabled()) return null;
  if (spec.group !== 'elementwise') return null;
  if (typeof backend.elementwiseChain !== 'function') return null;
  // `cast` changes the storage type, and a chain computes throughout in one type.
  if (spec.name === 'cast') return null;
  if (!isFloat(dtype)) return null;
  for (const input of inputs) {
    if (input.dtype !== dtype) return null;
    // A strided operand would have to be indexed differently from the others.
    if (!input.contiguous) return null;
  }
  const scalar = attrs && typeof attrs.scalar === 'number' ? attrs.scalar : null;
  return planChain(
    spec.name as EwOp,
    inputs,
    scalar,
    attrs?.scalarSide === 'lhs',
    shape,
    captureLeaf,
  );
}

/**
 * Dispatch one operation.
 *
 * The single path every operation takes, so ordering, recording, gradient
 * construction, and memory all happen in one place and in one order.
 */
export function dispatch(
  op: OpId,
  inputs: readonly Tensor[],
  attrs: OpAttrs | null = null,
  options: DispatchOptions = {},
): Tensor {
  const spec = opById(op);
  for (const input of inputs) input.check();
  // Mixed precision narrows operands before anything else looks at them, so the shape
  // and dtype rules, the recorded node, and the gradient all describe what actually ran.
  const operands = narrowOperands(spec.name, inputs);
  if (operands !== inputs) return dispatchNarrowed(op, operands, attrs, options);

  const device = inputs.length > 0 ? requireSameDevice(inputs) : options.device;
  if (!device) {
    throw new Error(`operation '${spec.name}' has no tensor inputs, so it needs a device`);
  }
  const backend = backendFor(device);

  const dtype = spec.dtypeRule(inputs, attrs);
  requireDType(device, dtype);
  const shape = spec.shapeRule(inputs, attrs);
  const graph = currentGraph();
  const valueId = graph.nextValue();

  // A metadata-only result shares its input's storage.
  if (options.aliasOf) {
    const source = options.aliasOf;
    const out = source.alias({
      shape,
      dtype,
      strides: options.strides,
      offset: options.offset ?? source.offset,
      valueId,
      requiresGrad: false,
    });
    graph.append(
      spec.name,
      inputs.map((t) => t.valueId),
      [valueId],
      attrs,
      [shape],
      [dtype],
      device,
    );
    attachGrad(spec, inputs, out, attrs);
    return out;
  }

  const stream = computeStream(backend);
  const bytes = numel(shape) * DTYPE_BYTES[dtype];
  const storage: Storage = allocStorage(backend, device, Math.max(bytes, 1), stream);
  const out = new Tensor({ storage, shape, dtype, valueId });

  // Elementwise work is deferred where a backend can fuse it, so a chain of it becomes
  // one kernel instead of one launch and one pass over memory each. The result carries
  // the expression rather than its values; anything that needs them runs it first.
  const deferred = planFusion(spec, inputs, attrs, shape, dtype, backend);
  if (deferred) {
    out.setPending(deferred);
    graph.append(
      spec.name,
      inputs.map((t) => t.valueId),
      [valueId],
      attrs,
      [shape],
      [dtype],
      device,
    );
    attachGrad(spec, inputs, out, attrs);
    return out;
  }

  graph.append(
    spec.name,
    inputs.map((t) => t.valueId),
    [valueId],
    attrs,
    [shape],
    [dtype],
    device,
  );

  attachGrad(spec, inputs, out, attrs);

  // Empty results need no kernel; the allocation exists so the handle is valid.
  if (numel(shape) > 0) {
    depth++;
    try {
      const descs: TensorDesc[] = [];
      for (let i = 0; i < inputs.length; i++) {
        descs.push(inputs[i]!.describe(descAt(depth * 8 + i)));
      }
      const outDesc = out.describe(descAt(depth * 8 + inputs.length));
      spec.enqueue(backend, descs, outDesc, attrs, stream);
    } finally {
      depth--;
    }
  }

  return out;
}

/**
 * Attach the gradient edge, if one is needed.
 *
 * @internal
 */
function attachGrad(
  spec: ReturnType<typeof opById>,
  inputs: readonly Tensor[],
  out: Tensor,
  attrs: OpAttrs | null,
): void {
  const node = buildGradNode(spec, inputs, out);
  if (!node) return;
  node.attrs = attrs;
  out.gradFn = node;
  setNodeOutput(node, out);
}

/**
 * Dispatch an operation that writes into an existing tensor.
 *
 * Only creation operations use this — `fill`, `arange`, `random` — where the
 * output is the whole point and there are no inputs to differentiate.
 */
export function dispatchInto(
  op: OpId,
  out: Tensor,
  attrs: OpAttrs | null = null,
): Tensor {
  const spec = opById(op);
  out.check();
  const backend = backendFor(out.device);
  const stream = computeStream(backend);
  const graph = currentGraph();
  graph.append(spec.name, [], [out.valueId], attrs, [out.shape], [out.dtype], out.device);
  if (out.size > 0) {
    depth++;
    try {
      spec.enqueue(backend, [], out.describe(descAt(depth * 8)), attrs, stream);
    } finally {
      depth--;
    }
  }
  return out;
}
