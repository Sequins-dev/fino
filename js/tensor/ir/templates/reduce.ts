/**
 * Reduction, softmax, and normalisation kernels.
 *
 * Two shapes appear here. A plain reduction gives one thread per output element,
 * which parallelises over outputs and is right when there are many of them. Softmax
 * and layer norm instead give one *workgroup* per row, because a row must be
 * reduced before any of its outputs can be written, and rows are where the
 * parallelism lives in a transformer.
 *
 * The tree reductions are unrolled in TypeScript rather than expressed as a loop:
 * the workgroup size is baked into the kernel, so the number of halving steps is a
 * compile-time constant. That also avoids needing a decreasing loop form in the IR.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/ir`; import from there.
 */
import { E, KernelBuilder, unroll } from '../builder.ts';
import { specKey } from '../key.ts';
import type { Expr, KernelIR, ScalarDType } from '../types.ts';
import { vt } from '../types.ts';
import { computeTypeFor } from './elementwise.ts';

/** Reduction kinds with an associative fold. */
export type ReduceOp = 'sum' | 'mean' | 'max' | 'min' | 'prod' | 'any' | 'all';

/** How each reduction starts, folds, and finishes. */
interface ReduceShape {
  /** Identity value for the accumulator. */
  init: (lit: (value: number) => Expr) => Expr;
  /** Combine the accumulator with one element. */
  fold: (acc: Expr, value: Expr) => Expr;
  /** Optional final step, given the reduced extent. */
  finish?: (acc: Expr, count: Expr) => Expr;
}

/**
 * @internal
 */
const SHAPES: Record<ReduceOp, ReduceShape> = {
  sum: { init: (lit) => lit(0), fold: (acc, value) => E.add(acc, value) },
  mean: {
    init: (lit) => lit(0),
    fold: (acc, value) => E.add(acc, value),
    // The count arrives as a u32 parameter, so it converts before dividing.
    finish: (acc, count) => E.div(acc, E.cast(vt('f32'), count)),
  },
  max: { init: (lit) => lit(-Infinity), fold: (acc, value) => E.max(acc, value) },
  min: { init: (lit) => lit(Infinity), fold: (acc, value) => E.min(acc, value) },
  prod: { init: (lit) => lit(1), fold: (acc, value) => E.mul(acc, value) },
  any: {
    init: (lit) => lit(0),
    fold: (acc, value) => E.max(acc, E.select(E.ne(value, E.const(vt('f32'), 0)), E.const(vt('f32'), 1), E.const(vt('f32'), 0))),
  },
  all: {
    init: (lit) => lit(1),
    fold: (acc, value) => E.min(acc, E.select(E.ne(value, E.const(vt('f32'), 0)), E.const(vt('f32'), 1), E.const(vt('f32'), 0))),
  },
};

/** Specialization of {@link reduceKernel}. */
export interface ReduceSpec {
  op: ReduceOp;
  /** Input storage type. */
  dtype: ScalarDType;
  /** Output storage type; defaults to the input's. */
  out?: ScalarDType;
  wg?: number;
}

/**
 * Build a reduction kernel.
 *
 * Reduces a `[outer, reduce, inner]` view of the input to `[outer, inner]`. The
 * framework arranges for the reduced axes to occupy the middle run, reducing one
 * axis at a time when they are not contiguous, so this one kernel serves every
 * axis combination.
 *
 * Buffers are `in0` and `out0`; parameters are `n` (output count), `reduceSize`,
 * and `innerSize`.
 */
export function reduceKernel(spec: ReduceSpec): { ir: KernelIR; key: string } {
  const shape = SHAPES[spec.op];
  const outDtype = spec.out ?? (spec.op === 'mean' ? 'f32' : spec.dtype);
  const compute = spec.op === 'any' || spec.op === 'all' ? 'f32' : computeTypeFor(outDtype);
  const computeType = vt(compute);
  const wg = spec.wg ?? 256;

  const b = new KernelBuilder(`reduce_${spec.op}_${spec.dtype}_to_${outDtype}`, [wg, 1, 1]);
  b.buffer('in0', vt(spec.dtype), 'read');
  b.buffer('out0', vt(outDtype), 'write');
  const n = b.param('n');
  const reduceSize = b.param('reduceSize');
  const innerSize = b.param('innerSize');
  const lit = (value: number) => E.const(computeType, value);

  b.gridStride(n, (i) => {
    const outer = b.letTemp(vt('u32'), E.div(i, innerSize), 'o');
    const inner = b.letTemp(vt('u32'), E.mod(i, innerSize), 'in');
    const base = b.letTemp(
      vt('u32'),
      E.add(E.mul(E.mul(outer, reduceSize), innerSize), inner),
      'base',
    );
    b.var('acc', computeType, shape.init(lit));
    b.for('r', E.u32(0), reduceSize, E.u32(1), (r) => {
      const at = E.add(base, E.mul(r, innerSize));
      const loaded = E.cast(computeType, E.load('in0', at));
      b.assign('acc', shape.fold(E.var('acc'), loaded));
    });
    const result = shape.finish ? shape.finish(E.var('acc'), reduceSize) : E.var('acc');
    b.store('out0', i, E.cast(vt(outDtype), result));
  });

  return {
    ir: b.build(),
    key: specKey('reduce', { op: spec.op, dtype: spec.dtype, out: outDtype, compute, wg }),
  };
}

/** Build an index-returning reduction, producing `i32` positions. */
export function argReduceKernel(spec: {
  op: 'argmax' | 'argmin';
  dtype: ScalarDType;
  wg?: number;
}): { ir: KernelIR; key: string } {
  const wg = spec.wg ?? 256;
  const compute = vt(computeTypeFor(spec.dtype));
  const better = spec.op === 'argmax';

  const b = new KernelBuilder(`${spec.op}_${spec.dtype}`, [wg, 1, 1]);
  b.buffer('in0', vt(spec.dtype), 'read');
  b.buffer('out0', vt('i32'), 'write');
  const n = b.param('n');
  const reduceSize = b.param('reduceSize');
  const innerSize = b.param('innerSize');

  b.gridStride(n, (i) => {
    const outer = b.letTemp(vt('u32'), E.div(i, innerSize), 'o');
    const inner = b.letTemp(vt('u32'), E.mod(i, innerSize), 'in');
    const base = b.letTemp(
      vt('u32'),
      E.add(E.mul(E.mul(outer, reduceSize), innerSize), inner),
      'base',
    );
    b.var('best', compute, E.const(compute, better ? -Infinity : Infinity));
    b.var('at', vt('u32'), E.u32(0));
    b.for('r', E.u32(0), reduceSize, E.u32(1), (r) => {
      const loaded = b.letTemp(
        compute,
        E.cast(compute, E.load('in0', E.add(base, E.mul(r, innerSize)))),
        'v',
      );
      // A strict comparison keeps the first extreme position, matching the
      // reference implementation's first-wins rule.
      const wins = better ? E.gt(loaded, E.var('best')) : E.lt(loaded, E.var('best'));
      b.if(wins, () => {
        b.assign('best', loaded);
        b.assign('at', r);
      });
    });
    b.store('out0', i, E.cast(vt('i32'), E.var('at')));
  });

  return { ir: b.build(), key: specKey('argreduce', { op: spec.op, dtype: spec.dtype, wg }) };
}

/**
 * Emit a shared-memory tree reduction over `red[0..wg)`.
 *
 * Unrolled because `wg` is a compile-time constant. Leaves the result in `red[0]`
 * and ends with a barrier, so every thread may read it.
 *
 * @internal
 */
function treeReduce(
  b: KernelBuilder,
  red: string,
  wg: number,
  lid: Expr,
  combine: (a: Expr, c: Expr) => Expr,
): void {
  const steps = Math.log2(wg);
  if (!Number.isInteger(steps)) {
    throw new Error(`workgroup size ${wg} must be a power of two for a tree reduction`);
  }
  unroll(steps, (step) => {
    const stride = wg >> (step + 1);
    b.barrier();
    b.if(E.lt(lid, E.u32(stride)), () => {
      b.shstore(
        red,
        lid,
        combine(E.shload(red, lid), E.shload(red, E.add(lid, E.u32(stride)))),
      );
    });
  });
  b.barrier();
}

/** Specialization of {@link softmaxKernel}. */
export interface SoftmaxSpec {
  dtype: ScalarDType;
  /** Emit log-softmax instead. */
  log?: boolean;
  wg?: number;
}

/**
 * Build a softmax kernel: one workgroup per row.
 *
 * Subtracts the row maximum before exponentiating. That is not an optimisation —
 * without it a row holding a large logit overflows to infinity and the whole row
 * becomes NaN, which is exactly the case a transformer hits.
 *
 * Buffers are `in0` and `out0`; parameters are `rows` and `cols`. Rows are
 * contiguous.
 */
export function softmaxKernel(spec: SoftmaxSpec): { ir: KernelIR; key: string } {
  const wg = spec.wg ?? 256;
  const compute = vt('f32');
  const b = new KernelBuilder(
    `${spec.log ? 'logsoftmax' : 'softmax'}_${spec.dtype}`,
    [wg, 1, 1],
  );
  b.buffer('in0', vt(spec.dtype), 'read');
  b.buffer('out0', vt(spec.dtype), 'write');
  const cols = b.param('cols');
  const red = b.shared('red', 'f32', wg);

  const lid = E.builtin('localId', 0);
  const row = E.builtin('groupId', 0);
  const base = b.let('base', vt('u32'), E.mul(row, cols));

  // Row maximum.
  b.var('m', compute, E.const(compute, -Infinity));
  b.for('c', lid, cols, E.u32(wg), (c) => {
    b.assign('m', E.max(E.var('m'), E.cast(compute, E.load('in0', E.add(base, c)))));
  });
  b.shstore(red, lid, E.var('m'));
  treeReduce(b, red, wg, lid, (a, c) => E.max(a, c));
  const peak = b.let('peak', compute, E.shload(red, E.u32(0)));

  // Sum of the shifted exponentials.
  b.var('acc', compute, E.const(compute, 0));
  b.for('c2', lid, cols, E.u32(wg), (c) => {
    const shifted = E.sub(E.cast(compute, E.load('in0', E.add(base, c))), peak);
    b.assign('acc', E.add(E.var('acc'), E.call('exp', shifted)));
  });
  // A barrier before reusing the scratch, so no thread overwrites a value another
  // is still reading.
  b.barrier();
  b.shstore(red, lid, E.var('acc'));
  treeReduce(b, red, wg, lid, (a, c) => E.add(a, c));
  const total = b.let('total', compute, E.shload(red, E.u32(0)));

  b.for('c3', lid, cols, E.u32(wg), (c) => {
    const at = E.add(base, c);
    const shifted = E.sub(E.cast(compute, E.load('in0', at)), peak);
    const value = spec.log
      ? E.sub(shifted, E.call('log', total))
      : E.div(E.call('exp', shifted), total);
    b.store('out0', at, E.cast(vt(spec.dtype), value));
  });

  return {
    ir: b.build(),
    key: specKey('softmax', { dtype: spec.dtype, log: spec.log ?? false, wg }),
  };
}

/** Specialization of {@link layerNormKernel}. */
export interface LayerNormSpec {
  dtype: ScalarDType;
  /** Root-mean-square normalisation, which omits mean subtraction. */
  rms?: boolean;
  /** Whether a scale is applied. */
  weight?: boolean;
  /** Whether an offset is applied. */
  bias?: boolean;
  wg?: number;
}

/**
 * Build a layer-normalisation kernel: one workgroup per row.
 *
 * Buffers are `in0`, then `weight` and `bias` when present, then `out0`.
 * Parameters are `cols` and `epsilon`.
 */
export function layerNormKernel(spec: LayerNormSpec): { ir: KernelIR; key: string } {
  const wg = spec.wg ?? 256;
  const compute = vt('f32');
  const name = [
    spec.rms ? 'rmsnorm' : 'layernorm',
    spec.dtype,
    spec.weight ? 'w' : 'nw',
    spec.bias ? 'b' : 'nb',
  ].join('_');
  const b = new KernelBuilder(name, [wg, 1, 1]);
  b.buffer('in0', vt(spec.dtype), 'read');
  if (spec.weight) b.buffer('weight', vt(spec.dtype), 'read');
  if (spec.bias) b.buffer('bias', vt(spec.dtype), 'read');
  b.buffer('out0', vt(spec.dtype), 'write');
  const cols = b.param('cols');
  const epsilon = b.param('epsilon', 'f32');
  const red = b.shared('red', 'f32', wg);

  const lid = E.builtin('localId', 0);
  const row = E.builtin('groupId', 0);
  const base = b.let('base', vt('u32'), E.mul(row, cols));
  const colsF = b.let('colsF', compute, E.cast(compute, cols));

  // Mean, skipped entirely for the root-mean-square variant.
  b.var('mean', compute, E.const(compute, 0));
  if (!spec.rms) {
    b.var('sum', compute, E.const(compute, 0));
    b.for('c', lid, cols, E.u32(wg), (c) => {
      b.assign('sum', E.add(E.var('sum'), E.cast(compute, E.load('in0', E.add(base, c)))));
    });
    b.shstore(red, lid, E.var('sum'));
    treeReduce(b, red, wg, lid, (a, c) => E.add(a, c));
    b.assign('mean', E.div(E.shload(red, E.u32(0)), colsF));
  }

  // Variance about the mean, or the plain mean square for the rms variant.
  b.var('sq', compute, E.const(compute, 0));
  b.for('c2', lid, cols, E.u32(wg), (c) => {
    const centred = E.sub(E.cast(compute, E.load('in0', E.add(base, c))), E.var('mean'));
    b.assign('sq', E.add(E.var('sq'), E.mul(centred, centred)));
  });
  b.barrier();
  b.shstore(red, lid, E.var('sq'));
  treeReduce(b, red, wg, lid, (a, c) => E.add(a, c));
  const variance = b.let('variance', compute, E.div(E.shload(red, E.u32(0)), colsF));
  const scale = b.let('scale', compute, E.call('rsqrt', E.add(variance, epsilon)));

  b.for('c3', lid, cols, E.u32(wg), (c) => {
    const at = E.add(base, c);
    let value: Expr = E.mul(
      E.sub(E.cast(compute, E.load('in0', at)), E.var('mean')),
      scale,
    );
    if (spec.weight) value = E.mul(value, E.cast(compute, E.load('weight', c)));
    if (spec.bias) value = E.add(value, E.cast(compute, E.load('bias', c)));
    b.store('out0', at, E.cast(vt(spec.dtype), value));
  });

  return {
    ir: b.build(),
    key: specKey('layernorm', {
      dtype: spec.dtype,
      rms: spec.rms ?? false,
      weight: spec.weight ?? false,
      bias: spec.bias ?? false,
      wg,
    }),
  };
}

/** Workgroups a row-per-workgroup kernel needs. */
export function rowGrid(rows: number): [number, number, number] {
  return [rows, 1, 1];
}
