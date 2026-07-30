/**
 * Operation registration and Tensor method installation.
 *
 * Importing this module registers every primitive and attaches the operation
 * methods to `Tensor.prototype`. Methods are installed here rather than declared
 * on the class so `tensor.ts` stays free of the registry, which needs `Tensor`
 * itself — and so the method and free-function forms of every operation are the
 * same code rather than two paths that can drift.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import type { DType } from '../dtype.ts';
import { installAutogradHooks } from '../autograd.ts';
import { backward as runBackward } from '../autograd.ts';
import type { BackwardOptions } from '../autograd.ts';
import { Tensor } from '../tensor.ts';
import { normalizeAxis } from '../shape.ts';
import type { SliceSpec } from '../shape.ts';

import {
  EW,
  add,
  addScalar,
  castTo,
  cos,
  div,
  exp,
  geOp,
  leOp,
  log,
  maximum,
  minimum,
  mul,
  mulScalar,
  neg,
  pow,
  sigmoid,
  sign,
  sin,
  sub,
  where,
  installElementwiseHooks,
} from './elementwise.ts';
import {
  RED,
  logSoftmax,
  mean,
  meanAlong,
  rsqrt,
  softmax,
  sum,
  sumAlong,
  sumLeading,
  installReduceHooks,
} from './reduce.ts';
import { GEMM, matmul, installLinalgHooks } from './linalg.ts';
import {
  MOVE,
  arangeOf,
  concat,
  expand,
  fillOf,
  flatten,
  indexSelect,
  narrow,
  permute,
  reshape,
  scatterAdd,
  slice,
  sumTo,
  transpose,
  zerosOf,
} from './movement.ts';
import { dispatch } from '../dispatch.ts';

// Wire the cross-module hooks. Each module declares what it needs rather than
// importing its dependents, which is what keeps the registration order free of
// cycles.
installElementwiseHooks({ sum, reshape });
installReduceHooks({ expand, reshape });
installLinalgHooks({ transpose, reshape, sumTo });
installAutogradHooks({
  onesLike: (t) => fillOf(t.shape, t.dtype, t.device, 1),
  add: (a, b) => add(a, b),
  sumTo: (t, shape) => sumTo(t, shape),
});

/** Every registered operation id, grouped by family. */
export const OPS = { EW, RED, MOVE, GEMM } as const;

// -- Tensor methods -----------------------------------------------------------

/**
 * Attach a method to the prototype.
 *
 * @internal
 */
function method(name: string, fn: (this: Tensor, ...args: never[]) => unknown): void {
  Object.defineProperty(Tensor.prototype, name, {
    value: fn,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/** Unary methods that take no arguments. */
for (const [name, fn] of [
  ['neg', neg],
  ['exp', exp],
  ['log', log],
  ['sigmoid', sigmoid],
  ['sin', sin],
  ['cos', cos],
  ['sign', sign],
  ['rsqrt', rsqrt],
] as const) {
  method(name, function (this: Tensor) {
    return fn(this);
  });
}

for (const name of [
  'abs',
  'sqrt',
  'tanh',
  'relu',
  'gelu',
  'silu',
  'erf',
  'floor',
  'ceil',
  'round',
] as const) {
  const id = EW[name]!;
  method(name, function (this: Tensor) {
    return dispatch(id, [this]);
  });
}

/** Binary methods that accept a tensor or a number. */
for (const [name, fn] of [
  ['add', add],
  ['sub', sub],
  ['mul', mul],
  ['div', div],
  ['pow', pow],
  ['maximum', maximum],
  ['minimum', minimum],
  ['ge', geOp],
  ['le', leOp],
] as const) {
  method(name, function (this: Tensor, other: Tensor | number) {
    return fn(this, other);
  });
}

for (const name of ['eq', 'ne', 'lt', 'gt'] as const) {
  const id = EW[name]!;
  method(name, function (this: Tensor, other: Tensor | number) {
    return typeof other === 'number'
      ? dispatch(id, [this], { scalar: other, scalarSide: 'rhs' })
      : dispatch(id, [this, other]);
  });
}

method('logicalNot', function (this: Tensor) {
  return dispatch(EW.logicalNot!, [this]);
});

method('where', function (this: Tensor, a: Tensor, b: Tensor) {
  return where(this, a, b);
});

method('cast', function (this: Tensor, dtype: DType) {
  return castTo(this, dtype);
});

/** Reductions. */
method('sum', function (this: Tensor, axes?: readonly number[], keepDims?: boolean) {
  return sum(this, axes, keepDims ?? false);
});
method('mean', function (this: Tensor, axes?: readonly number[], keepDims?: boolean) {
  return mean(this, axes, keepDims ?? false);
});
for (const name of ['max', 'min', 'prod', 'any', 'all'] as const) {
  const id = RED[name]!;
  method(name, function (this: Tensor, axes?: readonly number[], keepDims?: boolean) {
    return dispatch(id, [this], {
      axes: axes ?? Array.from({ length: this.rank }, (_, i) => i),
      keepDims: keepDims ?? false,
      inputShape: this.shape,
    });
  });
}
for (const name of ['argmax', 'argmin'] as const) {
  const id = RED[name]!;
  method(name, function (this: Tensor, axis?: number) {
    const resolved = axis === undefined ? undefined : normalizeAxis(axis, this.rank);
    return dispatch(id, [this], {
      axes: resolved === undefined ? Array.from({ length: this.rank }, (_, i) => i) : [resolved],
      keepDims: false,
      inputShape: this.shape,
    });
  });
}

method('softmax', function (this: Tensor, axis?: number) {
  return softmax(this, axis ?? -1);
});
method('logSoftmax', function (this: Tensor, axis?: number) {
  return logSoftmax(this, axis ?? -1);
});

/** Linear algebra. */
method('matmul', function (this: Tensor, other: Tensor) {
  return matmul(this, other);
});

/** Movement. */
method('reshape', function (this: Tensor, shape: readonly number[]) {
  return reshape(this, shape);
});
method('flatten', function (this: Tensor) {
  return flatten(this);
});
method('permute', function (this: Tensor, order: readonly number[]) {
  return permute(this, order);
});
method('transpose', function (this: Tensor, a?: number, b?: number) {
  return transpose(this, a ?? -2, b ?? -1);
});
method('expand', function (this: Tensor, shape: readonly number[]) {
  return expand(this, shape);
});
method('slice', function (this: Tensor, specs: readonly (SliceSpec | null)[]) {
  return slice(this, specs);
});
method('narrow', function (this: Tensor, axis: number, start: number, size: number) {
  return narrow(this, axis, start, size);
});
method('indexSelect', function (this: Tensor, indices: Tensor, axis?: number) {
  return indexSelect(this, indices, axis ?? 0);
});
method('scatterAdd', function (this: Tensor, indices: Tensor, src: Tensor, axis?: number) {
  return scatterAdd(this, indices, src, axis ?? 0);
});

/** Autodiff. */
method('backward', function (this: Tensor, seed?: Tensor, options?: BackwardOptions) {
  runBackward(this, seed ?? null, options ?? {});
});
method('detach', function (this: Tensor) {
  return this.alias({
    shape: this.shape,
    dtype: this.dtype,
    strides: this.strides,
    offset: this.offset,
    valueId: this.valueId,
    requiresGrad: false,
    gradFn: null,
  });
});
method('clone', function (this: Tensor) {
  return dispatch(MOVE.reshape!, [this], { shape: this.shape, inputShape: this.shape });
});

export {
  add,
  addScalar,
  arangeOf,
  castTo,
  concat,
  cos,
  div,
  exp,
  expand,
  fillOf,
  flatten,
  geOp,
  indexSelect,
  leOp,
  log,
  logSoftmax,
  matmul,
  maximum,
  mean,
  meanAlong,
  minimum,
  mul,
  mulScalar,
  narrow,
  neg,
  permute,
  pow,
  reshape,
  rsqrt,
  scatterAdd,
  sigmoid,
  sign,
  slice,
  sin,
  softmax,
  sub,
  sum,
  sumAlong,
  sumLeading,
  sumTo,
  transpose,
  where,
  zerosOf,
};
