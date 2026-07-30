/**
 * Shape movement, indexing, and creation.
 *
 * `reshape` on contiguous storage is metadata only — a new handle over the same
 * buffer, no kernel. Everything else materialises through one strided-copy
 * primitive, which is why backends implement `copyStrided` rather than a
 * transpose, a slice, a concat, and an expand.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import type { DType } from '../dtype.ts';
import { checkScalarRange, isFloat } from '../dtype.ts';
import type { OpAttrs } from '../backend.ts';
import {
  broadcastReduceAxes,
  concatShape,
  contiguousStrides,
  expandShape,
  normalizeAxis,
  numel,
  permuteShape,
  resolveReshape,
  resolveSlices,
  sliceShape,
  transposeOrder,
  unravel,
} from '../shape.ts';
import type { ResolvedSlice, SliceSpec } from '../shape.ts';
import type { OpId, RefAccessor } from './registry.ts';
import { registerOp } from './registry.ts';
import type { Tensor } from '../tensor.ts';
import { dispatch, dispatchInto } from '../dispatch.ts';
import { computeStream } from '../dispatch.ts';
import { backendFor } from '../backend.ts';
import { allocStorage, Tensor as TensorClass } from '../tensor.ts';
import { currentGraph } from '../graph.ts';
import { sum as sumOp } from './reduce.ts';

/** Registered movement operation ids. */
export const MOVE: Record<string, OpId> = {};

/**
 * Copy elements from a strided source into a contiguous output.
 *
 * @internal
 */
function stridedCopyRef(inputs: readonly RefAccessor[], out: RefAccessor): void {
  const x = inputs[0]!;
  for (let i = 0; i < out.size; i++) out.set(i, x.get(i));
}

/** Reshape, which is metadata-only when the source is contiguous. */
MOVE.reshape = registerOp({
  name: 'reshape',
  group: 'movement',
  arity: 1,
  dtypeRule: (inputs) => inputs[0]!.dtype,
  shapeRule: (inputs, attrs) => attrs!.shape as readonly number[],
  enqueue: (backend, inputs, out, _attrs, stream) =>
    backend.copyStrided(inputs[0]!, out, stream),
  vjp: {
    saves: () => [],
    backward: (cot, _saved, attrs, needs) => [
      needs[0] ? reshape(cot, attrs!.inputShape as readonly number[]) : null,
    ],
  },
  refImpl: stridedCopyRef,
});

/** Transpose and permute, which always materialise in v1. */
MOVE.permute = registerOp({
  name: 'permute',
  group: 'movement',
  arity: 1,
  dtypeRule: (inputs) => inputs[0]!.dtype,
  shapeRule: (inputs, attrs) =>
    permuteShape(inputs[0]!.shape, attrs!.order as readonly number[]),
  enqueue: (backend, inputs, out, attrs, stream) => {
    // Re-express the source as a view with the output's shape and reordered
    // strides, so the backend's one strided copy performs the permutation.
    const src = inputs[0]!;
    const order = attrs!.order as readonly number[];
    const srcStrides = contiguousStrides(src.shape);
    backend.copyStrided(
      {
        buffer: src.buffer,
        dtype: src.dtype,
        shape: out.shape,
        strides: order.map((axis) => srcStrides[axis]!),
        offset: src.offset,
      },
      out,
      stream,
    );
  },
  vjp: {
    saves: () => [],
    backward: (cot, _saved, attrs, needs) => {
      if (!needs[0]) return [null];
      // The adjoint of a permutation is its inverse.
      const order = attrs!.order as readonly number[];
      const inverse = new Array<number>(order.length);
      for (let i = 0; i < order.length; i++) inverse[order[i]!] = i;
      return [permute(cot, inverse)];
    },
  },
  refImpl: (inputs, out, attrs) => {
    const x = inputs[0]!;
    const order = attrs!.order as readonly number[];
    const outShape = out.shape;
    const inStrides = contiguousStrides(x.shape);
    for (let i = 0; i < out.size; i++) {
      const coords = unravel(i, outShape);
      let flat = 0;
      for (let axis = 0; axis < order.length; axis++) {
        flat += coords[axis]! * inStrides[order[axis]!]!;
      }
      out.set(i, x.get(flat));
    }
  },
});

/** Stretch size-1 axes. */
MOVE.expand = registerOp({
  name: 'expand',
  group: 'movement',
  arity: 1,
  dtypeRule: (inputs) => inputs[0]!.dtype,
  shapeRule: (inputs, attrs) =>
    expandShape(inputs[0]!.shape, attrs!.shape as readonly number[]),
  enqueue: (backend, inputs, out, _attrs, stream) => {
    // A broadcast read is the output's shape walked with zero strides on the
    // stretched axes, so no data is duplicated to perform it.
    const src = inputs[0]!;
    const own = contiguousStrides(src.shape);
    const rank = out.shape.length;
    const strides = new Array<number>(rank).fill(0);
    for (let i = 0; i < rank; i++) {
      const axis = src.shape.length - rank + i;
      if (axis < 0) continue;
      strides[i] = src.shape[axis] === 1 && out.shape[i] !== 1 ? 0 : own[axis]!;
    }
    backend.copyStrided(
      {
        buffer: src.buffer,
        dtype: src.dtype,
        shape: out.shape,
        strides,
        offset: src.offset,
      },
      out,
      stream,
    );
  },
  vjp: {
    saves: () => [],
    backward: (cot, _saved, attrs, needs) => {
      if (!needs[0]) return [null];
      const shape = attrs!.inputShape as readonly number[];
      const axes = broadcastReduceAxes(shape, cot.shape);
      const reduced = axes.length > 0 ? sumOp(cot, axes, true) : cot;
      return [reshape(reduced, shape)];
    },
  },
  refImpl: (inputs, out, attrs) => {
    const x = inputs[0]!;
    const target = out.shape;
    const rank = target.length;
    const own = contiguousStrides(x.shape);
    const strides = new Array<number>(rank).fill(0);
    for (let i = 0; i < rank; i++) {
      const axis = x.shape.length - rank + i;
      if (axis < 0) continue;
      strides[i] = x.shape[axis] === 1 && target[i] !== 1 ? 0 : own[axis]!;
    }
    for (let i = 0; i < out.size; i++) {
      const coords = unravel(i, target);
      let flat = 0;
      for (let axis = 0; axis < rank; axis++) flat += coords[axis]! * strides[axis]!;
      out.set(i, x.get(flat));
    }
    void attrs;
  },
});

/**
 * Take a strided sub-region.
 *
 * Like `permute` and `expand`, this is one strided copy over a re-expressed view of
 * the source: the start offsets fold into the view's offset and the steps multiply
 * into its strides, so no new backend operation is needed. Unlike `reshape` it always
 * materialises, since a slice of contiguous storage is not itself contiguous.
 */
MOVE.slice = registerOp({
  name: 'slice',
  group: 'movement',
  arity: 1,
  dtypeRule: (inputs) => inputs[0]!.dtype,
  shapeRule: (_inputs, attrs) => sliceShape(attrs!.resolved as readonly ResolvedSlice[]),
  enqueue: (backend, inputs, out, attrs, stream) => {
    const src = inputs[0]!;
    const resolved = attrs!.resolved as readonly ResolvedSlice[];
    const srcStrides = contiguousStrides(src.shape);
    let offset = src.offset;
    for (let axis = 0; axis < resolved.length; axis++) {
      offset += resolved[axis]!.start * srcStrides[axis]!;
    }
    backend.copyStrided(
      {
        buffer: src.buffer,
        dtype: src.dtype,
        shape: out.shape,
        strides: resolved.map((r, axis) => srcStrides[axis]! * r.step),
        offset,
      },
      out,
      stream,
    );
  },
  vjp: {
    saves: () => [],
    backward: (cot, _saved, attrs, needs) => {
      if (!needs[0]) return [null];
      // The adjoint of taking a sub-region is writing the cotangent back into zeros
      // at the positions it came from. One scatter-add per non-trivial axis restores
      // that axis to its full extent, which needs no gradient rule of its own: the
      // regions do not overlap, so accumulating is assigning.
      const shape = attrs!.inputShape as readonly number[];
      const resolved = attrs!.resolved as readonly ResolvedSlice[];
      let grad = cot;
      for (let axis = 0; axis < resolved.length; axis++) {
        const r = resolved[axis]!;
        if (r.start === 0 && r.step === 1 && r.size === shape[axis]) continue;
        const target = [...grad.shape];
        target[axis] = shape[axis]!;
        const zeros = zerosOf(target, grad.dtype, grad.device);
        const indices = arangeOf(r.size, 'i32', grad.device, r.start, r.step);
        grad = scatterAdd(zeros, indices, grad, axis);
      }
      return [grad];
    },
  },
  refImpl: (inputs, out, attrs) => {
    const x = inputs[0]!;
    const resolved = attrs!.resolved as readonly ResolvedSlice[];
    const inStrides = contiguousStrides(attrs!.inputShape as readonly number[]);
    const outShape = out.shape;
    for (let i = 0; i < out.size; i++) {
      const coords = unravel(i, outShape);
      let flat = 0;
      for (let axis = 0; axis < resolved.length; axis++) {
        const r = resolved[axis]!;
        flat += (r.start + coords[axis]! * r.step) * inStrides[axis]!;
      }
      out.set(i, x.get(flat));
    }
  },
});

/** Select whole slices along an axis; the embedding forward pass. */
MOVE.indexSelect = registerOp({
  name: 'indexSelect',
  group: 'indexing',
  arity: 2,
  dtypeRule: (inputs) => inputs[0]!.dtype,
  shapeRule: (inputs, attrs) => {
    const axis = normalizeAxis(attrs!.axis as number, inputs[0]!.rank);
    const shape = [...inputs[0]!.shape];
    // The index tensor's shape replaces the selected axis.
    return [...shape.slice(0, axis), ...inputs[1]!.shape, ...shape.slice(axis + 1)];
  },
  enqueue: (backend, inputs, out, attrs, stream) =>
    backend.indexSelect(inputs[0]!, inputs[1]!, out, attrs!.axis as number, stream),
  vjp: {
    saves: (inputs) => [inputs[1]!],
    backward: (cot, [indices], attrs, needs) => {
      if (!needs[0]) return [null, null];
      // The adjoint of a gather is a scatter-add: repeated indices accumulate.
      const shape = attrs!.inputShape as readonly number[];
      const axis = attrs!.axis as number;
      const zeros = zerosOf(shape, cot.dtype, cot.device);
      return [scatterAdd(zeros, indices!, cot, axis), null];
    },
  },
  refImpl: (inputs, out, attrs) => {
    const x = inputs[0]!;
    const indices = inputs[1]!;
    const axis = attrs!.axis as number;
    const rowSize = x.shape.slice(axis + 1).reduce((a, b) => a * b, 1);
    const outer = x.shape.slice(0, axis).reduce((a, b) => a * b, 1);
    const axisSize = x.shape[axis]!;
    const count = indices.size;
    for (let o = 0; o < outer; o++) {
      for (let i = 0; i < count; i++) {
        const raw = indices.get(i);
        const index = raw < 0 ? raw + axisSize : raw;
        if (index < 0 || index >= axisSize) {
          throw new Error(`index ${raw} is out of range for axis ${axis} of size ${axisSize}`);
        }
        for (let e = 0; e < rowSize; e++) {
          out.set((o * count + i) * rowSize + e, x.get((o * axisSize + index) * rowSize + e));
        }
      }
    }
  },
});

/** Accumulate slices into a destination along an axis. */
MOVE.scatterAdd = registerOp({
  name: 'scatterAdd',
  group: 'indexing',
  arity: 3,
  dtypeRule: (inputs) => inputs[0]!.dtype,
  shapeRule: (inputs) => inputs[0]!.shape,
  enqueue: (backend, inputs, out, attrs, stream) => {
    // The destination is copied into the output first, then accumulated into.
    backend.copyStrided(inputs[0]!, out, stream);
    backend.scatterAdd(out, inputs[1]!, inputs[2]!, attrs!.axis as number, stream);
  },
  vjp: {
    saves: (inputs) => [inputs[1]!],
    backward: (cot, [indices], attrs, needs) => [
      needs[0] ? cot : null,
      null,
      // The adjoint of scatter-add is a gather from the same positions.
      needs[2] ? indexSelect(cot, indices!, attrs!.axis as number) : null,
    ],
  },
  // The destination has already been copied into `out` by `enqueue`, so this
  // kernel accumulates in place and receives only the indices and the source.
  refImpl: (inputs, out, attrs) => {
    const indices = inputs[0]!;
    const src = inputs[1]!;
    const axis = attrs!.axis as number;
    const axisSize = out.shape[axis]!;
    const rowSize = out.shape.slice(axis + 1).reduce((a, b) => a * b, 1);
    const outer = out.shape.slice(0, axis).reduce((a, b) => a * b, 1);
    const count = indices.size;
    for (let o = 0; o < outer; o++) {
      for (let i = 0; i < count; i++) {
        const raw = indices.get(i);
        const index = raw < 0 ? raw + axisSize : raw;
        if (index < 0 || index >= axisSize) continue;
        for (let e = 0; e < rowSize; e++) {
          const at = (o * axisSize + index) * rowSize + e;
          out.set(at, out.get(at) + src.get((o * count + i) * rowSize + e));
        }
      }
    }
  },
});

/** Fill with a constant. */
MOVE.fill = registerOp({
  name: 'fill',
  group: 'creation',
  arity: 0,
  dtypeRule: (_inputs, attrs) => attrs!.dtype as DType,
  shapeRule: (_inputs, attrs) => attrs!.shape as readonly number[],
  enqueue: (backend, _inputs, out, attrs, stream) =>
    backend.fill(out, attrs!.value as number, stream),
  refImpl: (_inputs, out, attrs) => {
    const value = attrs!.value as number;
    for (let i = 0; i < out.size; i++) out.set(i, value);
  },
});

/** Fill with an arithmetic sequence. */
MOVE.arange = registerOp({
  name: 'arange',
  group: 'creation',
  arity: 0,
  dtypeRule: (_inputs, attrs) => attrs!.dtype as DType,
  shapeRule: (_inputs, attrs) => attrs!.shape as readonly number[],
  enqueue: (backend, _inputs, out, attrs, stream) =>
    backend.arange(out, attrs!.start as number, attrs!.step as number, stream),
  refImpl: (_inputs, out, attrs) => {
    const start = attrs!.start as number;
    const step = attrs!.step as number;
    for (let i = 0; i < out.size; i++) out.set(i, start + i * step);
  },
});

// -- public helpers -----------------------------------------------------------

/**
 * Reshape.
 *
 * Metadata-only when the source is contiguous: a new handle over the same
 * storage, with no kernel and no allocation.
 */
export function reshape(t: Tensor, shape: readonly number[]): Tensor {
  const resolved = resolveReshape(t.shape, shape);
  if (t.contiguous) {
    return dispatch(MOVE.reshape!, [t], { shape: resolved, inputShape: t.shape }, {
      aliasOf: t,
      strides: contiguousStrides(resolved),
      offset: t.offset,
    });
  }
  return dispatch(MOVE.reshape!, [t], { shape: resolved, inputShape: t.shape });
}

/** Flatten to one axis. */
export function flatten(t: Tensor): Tensor {
  return reshape(t, [t.size]);
}

/** Permute axes. */
export function permute(t: Tensor, order: readonly number[]): Tensor {
  return dispatch(MOVE.permute!, [t], { order, inputShape: t.shape });
}

/** Swap two axes, defaulting to the last two. */
export function transpose(t: Tensor, a = -2, b = -1): Tensor {
  if (t.rank < 2) return t;
  return permute(t, transposeOrder(t.rank, a, b));
}

/** Stretch size-1 axes to a larger shape. */
export function expand(t: Tensor, shape: readonly number[]): Tensor {
  return dispatch(MOVE.expand!, [t], { shape, inputShape: t.shape });
}

/**
 * Take a strided sub-region, one specification per leading axis.
 *
 * A `null` entry, or an axis past the end of the list, is taken whole. Negative
 * bounds count from the end, as they do in `Array.prototype.slice`.
 */
export function slice(t: Tensor, specs: readonly (SliceSpec | null)[]): Tensor {
  const resolved = resolveSlices(t.shape, specs);
  return dispatch(MOVE.slice!, [t], { resolved, inputShape: t.shape });
}

/** Take a strided range along one axis, leaving the others whole. */
export function narrow(t: Tensor, axis: number, start: number, size: number): Tensor {
  const resolved = normalizeAxis(axis, t.rank);
  const specs = new Array<SliceSpec | null>(resolved + 1).fill(null);
  specs[resolved] = { start, end: start + size };
  return slice(t, specs);
}

/** Select slices along an axis. */
export function indexSelect(t: Tensor, indices: Tensor, axis = 0): Tensor {
  const resolved = normalizeAxis(axis, t.rank);
  return dispatch(MOVE.indexSelect!, [t, indices], {
    axis: resolved,
    inputShape: t.shape,
  });
}

/** Accumulate `src` into `dest` at `indices` along an axis. */
export function scatterAdd(
  dest: Tensor,
  indices: Tensor,
  src: Tensor,
  axis = 0,
): Tensor {
  const resolved = normalizeAxis(axis, dest.rank);
  return dispatch(MOVE.scatterAdd!, [dest, indices, src], { axis: resolved });
}

/**
 * Concatenate along an axis.
 *
 * Composed rather than a primitive: each operand is scatter-added into a zero
 * tensor at its own index range. The regions do not overlap, so adding is
 * assigning, and the gradient falls out of `scatterAdd`'s adjoint for free — no
 * new backend operation and no new gradient rule.
 */
export function concat(tensors: readonly Tensor[], axis = 0): Tensor {
  if (tensors.length === 0) throw new Error('concat needs at least one tensor');
  if (tensors.length === 1) return tensors[0]!;
  const first = tensors[0]!;
  const resolved = normalizeAxis(axis, first.rank);
  const shape = concatShape(tensors.map((t) => t.shape), resolved);
  let dtype = first.dtype;
  for (const t of tensors) if (isFloat(t.dtype)) dtype = t.dtype;

  let acc = zerosOf(shape, dtype, first.device);
  let offset = 0;
  for (const t of tensors) {
    const size = t.shape[resolved]!;
    if (size > 0) {
      const indices = arangeOf(size, 'i32', first.device, offset, 1);
      acc = scatterAdd(acc, indices, t, resolved);
    }
    offset += size;
  }
  return acc;
}

/**
 * Sum a tensor down to a target shape.
 *
 * The inverse of broadcasting, used by gradient rules whose forward pass
 * stretched an operand.
 */
export function sumTo(t: Tensor, shape: readonly number[]): Tensor {
  if (t.rank === shape.length && t.shape.every((d, i) => d === shape[i])) return t;
  const axes = broadcastReduceAxes(shape, t.shape);
  const reduced = axes.length > 0 ? sumOp(t, axes, true) : t;
  return reshape(reduced, shape);
}

/**
 * Allocate a tensor without recording a creation operation.
 *
 * Used by `zeros`, `ones`, and gradient rules that need a fresh accumulator.
 *
 * @internal
 */
export function emptyTensor(
  shape: readonly number[],
  dtype: DType,
  device: Parameters<typeof backendFor>[0],
): Tensor {
  const backend = backendFor(device);
  const stream = computeStream(backend);
  const bytes = numel(shape) * (dtype === 'f64' || dtype === 'i64' ? 8 : dtype === 'f32' || dtype === 'i32' ? 4 : dtype === 'u8' || dtype === 'bool' ? 1 : 2);
  const storage = allocStorage(backend, device, Math.max(bytes, 1), stream);
  return new TensorClass({
    storage,
    shape,
    dtype,
    valueId: currentGraph().nextValue(),
  });
}

/** A tensor of zeros. */
export function zerosOf(
  shape: readonly number[],
  dtype: DType,
  device: Parameters<typeof backendFor>[0],
): Tensor {
  return fillOf(shape, dtype, device, 0);
}

/** A tensor filled with a constant. */
export function fillOf(
  shape: readonly number[],
  dtype: DType,
  device: Parameters<typeof backendFor>[0],
  value: number,
): Tensor {
  checkScalarRange(dtype, value);
  const out = emptyTensor(shape, dtype, device);
  return dispatchInto(MOVE.fill!, out, { value, shape, dtype });
}

/** A tensor holding an arithmetic sequence. */
export function arangeOf(
  count: number,
  dtype: DType,
  device: Parameters<typeof backendFor>[0],
  start = 0,
  step = 1,
): Tensor {
  const out = emptyTensor([count], dtype, device);
  return dispatchInto(MOVE.arange!, out, { start, step, shape: [count], dtype });
}
