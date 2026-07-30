/**
 * Reductions, softmax, and normalisation.
 *
 * Reference reductions accumulate in f64 regardless of storage dtype, which is
 * what makes this the oracle rather than merely another implementation. Softmax
 * and layer norm are registered as primitives because accelerators want them
 * fused, and carry `decompose` so a device that cannot run the primitive still
 * gets correct results from an equivalent composition.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import type { DType } from '../dtype.ts';
import { isFloat } from '../dtype.ts';
import type { OpAttrs, RedOp } from '../backend.ts';
import { normalizeAxes, numel, reduceShape, unravel } from '../shape.ts';
import type { OpId, RefAccessor } from './registry.ts';
import { registerOp } from './registry.ts';
import type { Tensor } from '../tensor.ts';
import { dispatch } from '../dispatch.ts';
import {
  EW,
  add,
  addScalar,
  castTo,
  div,
  exp,
  geOp,
  log,
  mul,
  mulScalar,
  neg,
  sub,
} from './elementwise.ts';

/** Registered reduction ids. */
export const RED: Record<string, OpId> = {};

/**
 * Hooks installed by the movement module, to avoid an import cycle.
 *
 * @internal
 */
let ops: {
  expand(t: Tensor, shape: readonly number[]): Tensor;
  reshape(t: Tensor, shape: readonly number[]): Tensor;
} | null = null;

/** Install the movement operations reduction gradients need. */
export function installReduceHooks(value: NonNullable<typeof ops>): void {
  ops = value;
}

/**
 * @internal
 */
function expandTo(t: Tensor, shape: readonly number[]): Tensor {
  if (!ops) throw new Error('reduce hooks are not installed');
  return ops.expand(t, shape);
}

/**
 * @internal
 */
function reshapeTo(t: Tensor, shape: readonly number[]): Tensor {
  if (!ops) throw new Error('reduce hooks are not installed');
  return ops.reshape(t, shape);
}

/** Axes an attribute set names. */
function axesOf(attrs: OpAttrs | null, rank: number): number[] {
  const raw = attrs?.axes as readonly number[] | undefined;
  return normalizeAxes(raw, rank);
}

/** Whether reduced axes are retained as size 1. */
function keepDimsOf(attrs: OpAttrs | null): boolean {
  return attrs?.keepDims === true;
}

/**
 * Iterate the elements of `x` that reduce into one output position.
 *
 * @internal
 */
function forEachReduced(
  x: RefAccessor,
  axes: readonly number[],
  outIndex: number,
  outShape: readonly number[],
  keepDims: boolean,
  visit: (value: number, flat: number) => void,
): void {
  const reduced = new Set(axes);
  const inShape = x.shape;
  // Reconstruct the input coordinates this output position covers.
  const outCoords = unravel(outIndex, outShape);
  const base = new Array<number>(inShape.length).fill(0);
  let cursor = 0;
  for (let axis = 0; axis < inShape.length; axis++) {
    if (reduced.has(axis)) {
      if (keepDims) cursor++;
      continue;
    }
    base[axis] = outCoords[cursor++] ?? 0;
  }
  const axisList = [...reduced].sort((a, b) => a - b);
  const counts = axisList.map((axis) => inShape[axis]!);
  const total = counts.reduce((acc, n) => acc * n, 1);
  const coords = [...base];
  for (let i = 0; i < total; i++) {
    let rest = i;
    for (let k = axisList.length - 1; k >= 0; k--) {
      const size = counts[k]!;
      coords[axisList[k]!] = rest % size;
      rest = Math.floor(rest / size);
    }
    // Flat index over the input's logical shape.
    let flat = 0;
    for (let axis = 0; axis < inShape.length; axis++) {
      flat = flat * inShape[axis]! + coords[axis]!;
    }
    visit(x.get(flat), flat);
  }
}

/** How one reduction behaves. */
interface ReduceDef {
  name: RedOp;
  /** Starting accumulator. */
  init: number;
  /** Fold one value in. */
  fold: (acc: number, value: number) => number;
  /** Final value from the accumulator and the element count. */
  finish?: (acc: number, count: number) => number;
  /** Result dtype, when it is not the input's. */
  dtype?: (input: DType) => DType;
  /** Gradient rule. */
  grad?: (
    cot: Tensor,
    saved: readonly Tensor[],
    attrs: OpAttrs | null,
    inputShape: readonly number[],
  ) => Tensor;
  /** What the gradient needs. */
  saves?: 'none' | 'input' | 'inputAndOutput';
}

/**
 * Register a reduction.
 *
 * @internal
 */
function reduction(def: ReduceDef): void {
  RED[def.name] = registerOp({
    name: def.name,
    group: 'reduce',
    arity: 1,
    dtypeRule: (inputs) => {
      const dtype = inputs[0]!.dtype;
      return def.dtype ? def.dtype(dtype) : dtype;
    },
    shapeRule: (inputs, attrs) =>
      reduceShape(inputs[0]!.shape, axesOf(attrs, inputs[0]!.rank), keepDimsOf(attrs)),
    enqueue: (backend, inputs, out, attrs, stream) =>
      backend.reduce(
        def.name,
        inputs[0]!,
        out,
        axesOf(attrs, inputs[0]!.shape.length),
        stream,
      ),
    vjp: def.grad
      ? {
          saves: (inputs, output) => {
            if (def.saves === 'none') return [];
            if (def.saves === 'inputAndOutput') return [inputs[0]!, output];
            return [inputs[0]!];
          },
          backward: (cot, saved, attrs, needs) => {
            if (!needs[0]) return [null];
            // The input shape is needed to re-expand; it is recoverable from a
            // saved input, and otherwise carried in the attributes.
            const shape =
              saved.length > 0
                ? saved[0]!.shape
                : ((attrs!.inputShape as readonly number[]) ?? cot.shape);
            return [def.grad!(cot, saved, attrs, shape)];
          },
        }
      : undefined,
    refImpl: (inputs, out, attrs) => {
      const x = inputs[0]!;
      const axes = axesOf(attrs, x.shape.length);
      const keepDims = keepDimsOf(attrs);
      for (let i = 0; i < out.size; i++) {
        let acc = def.init;
        let count = 0;
        forEachReduced(x, axes, i, out.shape, keepDims, (value) => {
          acc = def.fold(acc, value);
          count++;
        });
        out.set(i, def.finish ? def.finish(acc, count) : acc);
      }
    },
  });
}

/**
 * Restore reduced axes so a cotangent can broadcast back over the input.
 *
 * @internal
 */
function unreduce(
  cot: Tensor,
  attrs: OpAttrs | null,
  inputShape: readonly number[],
): Tensor {
  const axes = axesOf(attrs, inputShape.length);
  if (keepDimsOf(attrs)) return expandTo(cot, inputShape);
  // Put the reduced axes back as size 1, then stretch.
  const withAxes = [...inputShape];
  for (const axis of axes) withAxes[axis] = 1;
  return expandTo(reshapeTo(cot, withAxes), inputShape);
}

reduction({
  name: 'sum',
  init: 0,
  fold: (acc, value) => acc + value,
  saves: 'none',
  grad: (cot, _saved, attrs) =>
    unreduce(cot, attrs, (attrs!.inputShape as readonly number[]) ?? cot.shape),
});

reduction({
  name: 'mean',
  init: 0,
  fold: (acc, value) => acc + value,
  finish: (acc, count) => (count === 0 ? NaN : acc / count),
  dtype: (input) => (isFloat(input) ? input : 'f32'),
  saves: 'none',
  grad: (cot, _saved, attrs) => {
    const shape = (attrs!.inputShape as readonly number[]) ?? cot.shape;
    const count = numel(shape) / Math.max(cot.size, 1);
    return mulScalar(unreduce(cot, attrs, shape), 1 / count);
  },
});

reduction({
  name: 'prod',
  init: 1,
  fold: (acc, value) => acc * value,
  saves: 'inputAndOutput',
  // d/dx_i prod = prod / x_i, which is what the saved output buys.
  grad: (cot, [x, y], attrs) =>
    div(mul(unreduce(cot, attrs, x!.shape), unreduce(y!, attrs, x!.shape)), x!),
});

reduction({
  name: 'max',
  init: -Infinity,
  fold: (acc, value) => (value > acc ? value : acc),
  saves: 'inputAndOutput',
  // Route the gradient to the positions that achieved the maximum. Ties share it,
  // which differs from PyTorch's first-index rule but is the symmetric choice and
  // is what the contract specifies.
  grad: (cot, [x, y], attrs) => {
    const expanded = unreduce(y!, attrs, x!.shape);
    const mask = castTo(geOp(x!, expanded), cot.dtype);
    return mul(unreduce(cot, attrs, x!.shape), mask);
  },
});

reduction({
  name: 'min',
  init: Infinity,
  fold: (acc, value) => (value < acc ? value : acc),
  saves: 'inputAndOutput',
  grad: (cot, [x, y], attrs) => {
    const expanded = unreduce(y!, attrs, x!.shape);
    const mask = castTo(geOp(expanded, x!), cot.dtype);
    return mul(unreduce(cot, attrs, x!.shape), mask);
  },
});

reduction({
  name: 'any',
  init: 0,
  fold: (acc, value) => (acc !== 0 || value !== 0 ? 1 : 0),
  dtype: () => 'bool',
});

reduction({
  name: 'all',
  init: 1,
  fold: (acc, value) => (acc !== 0 && value !== 0 ? 1 : 0),
  dtype: () => 'bool',
});

/**
 * Register an index-returning reduction.
 *
 * @internal
 */
function argReduction(name: 'argmax' | 'argmin', better: (a: number, b: number) => boolean): void {
  RED[name] = registerOp({
    name,
    group: 'reduce',
    arity: 1,
    dtypeRule: () => 'i32',
    shapeRule: (inputs, attrs) =>
      reduceShape(inputs[0]!.shape, axesOf(attrs, inputs[0]!.rank), keepDimsOf(attrs)),
    enqueue: (backend, inputs, out, attrs, stream) =>
      backend.reduce(name, inputs[0]!, out, axesOf(attrs, inputs[0]!.shape.length), stream),
    // Index selection is not differentiable, and pretending otherwise would hide
    // a modelling error rather than help anyone.
    refImpl: (inputs, out, attrs) => {
      const x = inputs[0]!;
      const axes = axesOf(attrs, x.shape.length);
      const keepDims = keepDimsOf(attrs);
      for (let i = 0; i < out.size; i++) {
        let best = name === 'argmax' ? -Infinity : Infinity;
        let bestAt = 0;
        let position = 0;
        forEachReduced(x, axes, i, out.shape, keepDims, (value) => {
          if (better(value, best)) {
            best = value;
            bestAt = position;
          }
          position++;
        });
        out.set(i, bestAt);
      }
    },
  });
}

argReduction('argmax', (a, b) => a > b);
argReduction('argmin', (a, b) => a < b);

// -- softmax ------------------------------------------------------------------

/**
 * Register softmax or its logarithm.
 *
 * The reference implementation subtracts the row maximum before exponentiating,
 * which is not an optimisation: without it a row containing a large value
 * overflows to infinity and the result is all NaN.
 *
 * @internal
 */
function softmaxOp(name: 'softmax' | 'logSoftmax'): void {
  const isLog = name === 'logSoftmax';
  RED[name] = registerOp({
    name,
    group: 'reduce',
    arity: 1,
    dtypeRule: (inputs) => (isFloat(inputs[0]!.dtype) ? inputs[0]!.dtype : 'f32'),
    shapeRule: (inputs) => inputs[0]!.shape,
    enqueue: (backend, inputs, out, attrs, stream) =>
      backend.softmax(inputs[0]!, out, attrs!.axis as number, isLog, stream),
    vjp: {
      saves: (_inputs, output) => [output],
      backward: (cot, [y], attrs, needs) => {
        if (!needs[0]) return [null];
        const axis = attrs!.axis as number;
        if (isLog) {
          // cot - softmax(y) * sum(cot)
          const probabilities = exp(y!);
          const total = sumAlong(cot, axis);
          return [sub(cot, mul(probabilities, total))];
        }
        // y * (cot - sum(cot * y))
        const weighted = sumAlong(mul(cot, y!), axis);
        return [mul(y!, sub(cot, weighted))];
      },
    },
    decompose: (inputs, attrs) => {
      const axis = attrs!.axis as number;
      const x = inputs[0]!;
      const shifted = sub(x, maxAlong(x, axis));
      if (isLog) return sub(shifted, log(sumAlong(exp(shifted), axis)));
      const e = exp(shifted);
      return div(e, sumAlong(e, axis));
    },
    refImpl: (inputs, out, attrs) => {
      const x = inputs[0]!;
      const axis = attrs!.axis as number;
      const shape = x.shape;
      const axisSize = shape[axis]!;
      const inner = shape.slice(axis + 1).reduce((a, b) => a * b, 1);
      const outer = shape.slice(0, axis).reduce((a, b) => a * b, 1);
      for (let o = 0; o < outer; o++) {
        for (let i = 0; i < inner; i++) {
          const base = o * axisSize * inner + i;
          let peak = -Infinity;
          for (let a = 0; a < axisSize; a++) {
            const value = x.get(base + a * inner);
            if (value > peak) peak = value;
          }
          let total = 0;
          for (let a = 0; a < axisSize; a++) total += Math.exp(x.get(base + a * inner) - peak);
          const logTotal = Math.log(total);
          for (let a = 0; a < axisSize; a++) {
            const shifted = x.get(base + a * inner) - peak;
            out.set(base + a * inner, isLog ? shifted - logTotal : Math.exp(shifted) / total);
          }
        }
      }
    },
  });
}

softmaxOp('softmax');
softmaxOp('logSoftmax');

// -- layer normalisation ------------------------------------------------------

/**
 * Layer normalisation over the last axis, optionally affine.
 *
 * Registered as a primitive because it is bandwidth-bound and worth fusing, with
 * a composition available for backends that cannot run it directly.
 */
RED.layerNorm = registerOp({
  name: 'layerNorm',
  group: 'normalization',
  arity: 1,
  dtypeRule: (inputs) => (isFloat(inputs[0]!.dtype) ? inputs[0]!.dtype : 'f32'),
  shapeRule: (inputs) => inputs[0]!.shape,
  enqueue: (backend, inputs, out, attrs, stream) =>
    backend.layerNorm(
      inputs[0]!,
      inputs[1] ?? null,
      inputs[2] ?? null,
      out,
      attrs!.axisSize as number,
      attrs!.epsilon as number,
      attrs!.rms === true,
      stream,
    ),
  vjp: {
    saves: (inputs) => inputs,
    backward: (cot, saved, attrs, needs) => {
      const x = saved[0]!;
      const weight = saved[1] ?? null;
      const epsilon = attrs!.epsilon as number;
      const rms = attrs!.rms === true;
      // The normalised run may span several trailing axes, so its length comes
      // from the recorded attribute rather than from the last axis alone. The
      // statistics are still per-row, so the tensor is viewed as [rows, n].
      const n = attrs!.axisSize as number;
      const rows = Math.max(x.size / n, 1);
      const viewed = reshapeTo(x, [rows, n]);
      const axis = 1;

      // Recompute the normalised value rather than saving it: one extra pass over
      // activations is cheaper than holding a second copy of them.
      const rowMean = rms ? null : meanAlong(viewed, axis);
      const centred = rowMean ? sub(viewed, rowMean) : viewed;
      const variance = meanAlong(mul(centred, centred), axis);
      const scale = rsqrt(addScalar(variance, epsilon));
      const normalized = mul(centred, scale);

      // Fold the affine weight into the incoming cotangent, viewed the same way.
      const cotViewed = reshapeTo(cot, [rows, n]);
      const inner = weight ? mul(cotViewed, reshapeTo(weight, [1, n])) : cotViewed;
      const gradX = needs[0]
        ? reshapeTo(
            mulScalar(
              mul(
                scale,
                sub(
                  mulScalar(inner, n),
                  add(
                    sumAlong(inner, axis),
                    mul(normalized, sumAlong(mul(inner, normalized), axis)),
                  ),
                ),
              ),
              1 / n,
            ),
            x.shape,
          )
        : null;

      const out: (Tensor | null)[] = [gradX];
      if (saved.length > 1) {
        out.push(needs[1] ? sumLeading(mul(cotViewed, normalized), 2) : null);
      }
      if (saved.length > 2) out.push(needs[2] ? sumLeading(cotViewed, 2) : null);
      return out;
    },
  },
  refImpl: (inputs, out, attrs) => {
    const x = inputs[0]!;
    const rms = attrs!.rms === true;
    const epsilon = attrs!.epsilon as number;
    const hasWeight = attrs!.hasWeight === true;
    const hasBias = attrs!.hasBias === true;
    const weight = hasWeight ? inputs[1]! : null;
    const bias = hasBias ? inputs[hasWeight ? 2 : 1]! : null;
    const n = attrs!.axisSize as number;
    const rows = out.size / n;
    for (let row = 0; row < rows; row++) {
      const base = row * n;
      let mean = 0;
      if (!rms) {
        for (let i = 0; i < n; i++) mean += x.get(base + i);
        mean /= n;
      }
      let variance = 0;
      for (let i = 0; i < n; i++) {
        const centred = x.get(base + i) - mean;
        variance += centred * centred;
      }
      variance /= n;
      const scale = 1 / Math.sqrt(variance + epsilon);
      for (let i = 0; i < n; i++) {
        let value = (x.get(base + i) - mean) * scale;
        if (weight) value *= weight.get(i);
        if (bias) value += bias.get(i);
        out.set(base + i, value);
      }
    }
  },
});

// -- helpers used by the gradient rules above ---------------------------------

/** Sum along one axis, keeping it as size 1. */
export function sumAlong(t: Tensor, axis: number): Tensor {
  return dispatch(RED.sum!, [t], {
    axes: [axis],
    keepDims: true,
    inputShape: t.shape,
  });
}

/** Mean along one axis, keeping it as size 1. */
export function meanAlong(t: Tensor, axis: number): Tensor {
  return dispatch(RED.mean!, [t], {
    axes: [axis],
    keepDims: true,
    inputShape: t.shape,
  });
}

/** Maximum along one axis, keeping it as size 1. */
export function maxAlong(t: Tensor, axis: number): Tensor {
  return dispatch(RED.max!, [t], {
    axes: [axis],
    keepDims: true,
    inputShape: t.shape,
  });
}

/** Sum over every axis but the last, which is how an affine gradient collapses. */
export function sumLeading(t: Tensor, rank: number): Tensor {
  const axes = Array.from({ length: rank - 1 }, (_, i) => i);
  if (axes.length === 0) return t;
  return dispatch(RED.sum!, [t], { axes, keepDims: false, inputShape: t.shape });
}

/** Reciprocal square root. */
export function rsqrt(t: Tensor): Tensor {
  return dispatch(EW.rsqrt!, [t]);
}

/** Sum a tensor completely or along axes. */
export function sum(
  t: Tensor,
  axes?: readonly number[],
  keepDims = false,
): Tensor {
  return dispatch(RED.sum!, [t], {
    axes: axes ?? Array.from({ length: t.rank }, (_, i) => i),
    keepDims,
    inputShape: t.shape,
  });
}

/** Mean of a tensor completely or along axes. */
export function mean(
  t: Tensor,
  axes?: readonly number[],
  keepDims = false,
): Tensor {
  return dispatch(RED.mean!, [t], {
    axes: axes ?? Array.from({ length: t.rank }, (_, i) => i),
    keepDims,
    inputShape: t.shape,
  });
}

/** Softmax along an axis. */
export function softmax(t: Tensor, axis = -1): Tensor {
  const resolved = axis < 0 ? t.rank + axis : axis;
  return dispatch(RED.softmax!, [t], { axis: resolved });
}

/** Log-softmax along an axis. */
export function logSoftmax(t: Tensor, axis = -1): Tensor {
  const resolved = axis < 0 ? t.rank + axis : axis;
  return dispatch(RED.logSoftmax!, [t], { axis: resolved });
}

/** Negate, re-exported so the loss helpers can build without another import. */
export { neg };
