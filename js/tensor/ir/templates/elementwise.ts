/**
 * Elementwise kernel template.
 *
 * One template covers every unary, binary, and ternary elementwise operation,
 * plus casts and copies: the arithmetic is supplied as a callback that builds an
 * expression tree from already-loaded operand values, so adding an operation
 * costs an entry in the operation table rather than a new kernel.
 *
 * The chain is computed in registers between one load per input and one store,
 * which is also the shape a future fusion pass needs — a fused region is just a
 * deeper expression tree over more inputs.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/ir`; import from there.
 */
import { E, KernelBuilder } from '../builder.ts';
import { specKey } from '../key.ts';
import type { LayoutClass, OperandLayout } from '../layout.ts';
import type { Expr, KernelIR, ScalarDType, VecWidth } from '../types.ts';
import { isFloatScalar, typeKey, vt } from '../types.ts';

/** How one input is indexed relative to the output's flat index. */
export interface EwInput {
  /** Storage type of the buffer. */
  dtype: ScalarDType;
  /** Index pattern; see {@link OperandLayout}. */
  layout: LayoutClass;
  /**
   * Block size for the broadcast layouts.
   *
   * Emitted as a kernel parameter rather than baked, so one compiled kernel
   * serves every shape with the same layout class.
   */
  inner?: number;
}

/** Specialization of {@link ewKernel}. */
export interface EwSpec {
  /** Stable name for the operation, used in the kernel name and cache key. */
  op: string;
  /** Input operands, in order. */
  inputs: readonly EwInput[];
  /** Output storage type. */
  out: ScalarDType;
  /**
   * Type the arithmetic is performed in.
   *
   * Defaults to `f32` for float storage types, matching the contract's rule that
   * 16-bit dtypes are storage-only and compute happens in `f32`.
   */
  compute?: ScalarDType;
  /** Lanes per element; requires the element count to be divisible by it. */
  vec?: VecWidth;
  /** Workgroup size. */
  wg?: number;
  /**
   * Extra scalar parameters the arithmetic needs, such as an alpha or a
   * comparison threshold.
   */
  scalars?: readonly { name: string; type: 'f32' | 'i32' | 'u32' }[];
  /**
   * Build the output value from the loaded inputs.
   *
   * Receives values already converted to the compute type, and must return an
   * expression of the compute type. Nothing dialect-specific may appear here.
   */
  body: (inputs: Expr[], ctx: EwContext) => Expr;
}

/** Helpers available to an {@link EwSpec.body}. */
export interface EwContext {
  /** The builder, for temporaries. */
  b: KernelBuilder;
  /** Read one of the declared extra scalars. */
  scalar: (name: string) => Expr;
  /** The compute value type. */
  compute: ScalarDType;
  /** A literal in the compute type. */
  lit: (value: number) => Expr;
}

/** The compute type for a storage type, per the contract's storage-only rule. */
export function computeTypeFor(storage: ScalarDType): ScalarDType {
  if (storage === 'f16' || storage === 'bf16') return 'f32';
  if (storage === 'bool' || storage === 'u8') return 'u32';
  return storage;
}

/**
 * Build an elementwise kernel.
 */
export function ewKernel(spec: EwSpec): { ir: KernelIR; key: string } {
  const lanes: VecWidth = spec.vec ?? 1;
  const wg = spec.wg ?? 256;
  const compute = spec.compute ?? computeTypeFor(spec.out);
  const computeType = vt(compute, lanes);

  const b = new KernelBuilder(
    `ew_${spec.op}_${spec.inputs.map((i) => i.dtype).join('_')}_to_${spec.out}${lanes > 1 ? `x${lanes}` : ''}`,
    [wg, 1, 1],
  );

  spec.inputs.forEach((input, index) => {
    b.buffer(`in${index}`, vt(input.dtype, lanes), 'read');
  });
  b.buffer('out0', vt(spec.out, lanes), 'write');

  const count = b.param('n');
  // Broadcast block sizes are parameters, so shape changes reuse the kernel.
  const innerParams = spec.inputs.map((input, index) =>
    input.layout === 'outerBroadcast' || input.layout === 'innerBroadcast'
      ? b.param(`inner${index}`)
      : null,
  );
  const extraScalars = new Map<string, Expr>();
  for (const s of spec.scalars ?? []) extraScalars.set(s.name, b.param(s.name, s.type));

  b.gridStride(count, (i) => {
    const values = spec.inputs.map((input, index) => {
      const inner = innerParams[index];
      let index_: Expr;
      switch (input.layout) {
        case 'cont':
          index_ = i;
          break;
        case 'scalar':
          index_ = E.u32(0);
          break;
        case 'outerBroadcast':
          index_ = E.div(i, inner!);
          break;
        case 'innerBroadcast':
          index_ = E.mod(i, inner!);
          break;
        case 'strided':
          throw new Error(
            'strided elementwise operands need the stridedCopy template; collapse or copy first',
          );
      }
      const loaded = E.load(`in${index}`, index_);
      // Convert into the compute type; identical types make this a no-op below.
      return input.dtype === compute ? loaded : E.cast(computeType, loaded);
    });

    const ctx: EwContext = {
      b,
      scalar: (name) => {
        const expr = extraScalars.get(name);
        if (!expr) throw new Error(`elementwise kernel has no scalar '${name}'`);
        return expr;
      },
      compute,
      lit: (value) => E.const(computeType, value),
    };

    const result = spec.body(values, ctx);
    const stored = spec.out === compute ? result : E.cast(vt(spec.out, lanes), result);
    b.store('out0', i, stored);
  });

  const key = specKey('ew', {
    op: spec.op,
    in: spec.inputs.map((x) => `${x.dtype}:${layoutTag(x.layout)}`).join('+'),
    out: spec.out,
    compute,
    vec: lanes > 1 ? lanes : undefined,
    wg,
    scalars: (spec.scalars ?? []).map((s) => `${s.name}:${s.type}`).join(',') || undefined,
  });

  return { ir: b.build(), key };
}

/**
 * Short tag for a layout class in a cache key.
 *
 * @internal
 */
function layoutTag(layout: LayoutClass): string {
  switch (layout) {
    case 'cont':
      return 'c';
    case 'scalar':
      return 's';
    case 'outerBroadcast':
      return 'ob';
    case 'innerBroadcast':
      return 'ib';
    case 'strided':
      return 'st';
  }
}

/** Convert analysed operand layouts into {@link EwInput}s. */
export function inputsFromLayouts(
  dtypes: readonly ScalarDType[],
  layouts: readonly OperandLayout[],
): EwInput[] {
  return dtypes.map((dtype, index) => {
    const layout = layouts[index]!;
    return { dtype, layout: layout.class, inner: layout.inner };
  });
}

/** A named unary operation over the compute type. */
export type UnaryBuilder = (x: Expr, ctx: EwContext) => Expr;

/** A named binary operation over the compute type. */
export type BinaryBuilder = (a: Expr, b: Expr, ctx: EwContext) => Expr;

/**
 * Unary elementwise operations.
 *
 * These are the numerics, written once. `gelu` and `silu` are composed here
 * rather than being separate kernels because they are ordinary expression trees;
 * a fusion pass will inline them the same way.
 */
export const UNARY: Record<string, UnaryBuilder> = {
  neg: (x) => E.un('neg', x),
  abs: (x) => E.un('abs', x),
  exp: (x) => E.call('exp', x),
  log: (x) => E.call('log', x),
  sqrt: (x) => E.call('sqrt', x),
  rsqrt: (x) => E.call('rsqrt', x),
  sin: (x) => E.call('sin', x),
  cos: (x) => E.call('cos', x),
  tanh: (x) => E.call('tanh', x),
  floor: (x) => E.call('floor', x),
  ceil: (x) => E.call('ceil', x),
  round: (x) => E.call('round', x),
  relu: (x, ctx) => E.max(x, ctx.lit(0)),
  sigmoid: (x, ctx) => E.div(ctx.lit(1), E.add(ctx.lit(1), E.call('exp', E.un('neg', x)))),
  silu: (x, ctx) => E.mul(x, E.div(ctx.lit(1), E.add(ctx.lit(1), E.call('exp', E.un('neg', x))))),
  /**
   * Exact GELU via the tanh approximation, which is what reference
   * implementations use and what the oracle must therefore also use.
   */
  gelu: (x, ctx) => {
    const inner = E.mul(
      ctx.lit(0.7978845608028654),
      E.add(x, E.mul(ctx.lit(0.044715), E.mul(x, E.mul(x, x)))),
    );
    return E.mul(E.mul(ctx.lit(0.5), x), E.add(ctx.lit(1), E.call('tanh', inner)));
  },
  logicalNot: (x, ctx) => E.select(E.eq(x, ctx.lit(0)), ctx.lit(1), ctx.lit(0)),
};

/** Binary elementwise operations. */
export const BINARY: Record<string, BinaryBuilder> = {
  add: (a, b) => E.add(a, b),
  sub: (a, b) => E.sub(a, b),
  mul: (a, b) => E.mul(a, b),
  div: (a, b) => E.div(a, b),
  pow: (a, b) => E.call('pow', a, b),
  maximum: (a, b) => E.max(a, b),
  minimum: (a, b) => E.min(a, b),
};

/** Comparison operations, which always produce a boolean-valued result. */
export const COMPARE: Record<string, BinaryBuilder> = {
  eq: (a, b) => E.eq(a, b),
  ne: (a, b) => E.ne(a, b),
  lt: (a, b) => E.lt(a, b),
  le: (a, b) => E.le(a, b),
  gt: (a, b) => E.gt(a, b),
  ge: (a, b) => E.ge(a, b),
};

/** Whether an operation name is a comparison. */
export function isCompare(op: string): boolean {
  return op in COMPARE;
}

/** Build the kernel for a unary operation. */
export function unaryKernel(
  op: string,
  input: EwInput,
  out: ScalarDType,
  options: { vec?: VecWidth; wg?: number } = {},
): { ir: KernelIR; key: string } {
  const build = UNARY[op];
  if (!build) throw new Error(`unknown unary elementwise operation '${op}'`);
  return ewKernel({
    op,
    inputs: [input],
    out,
    vec: options.vec,
    wg: options.wg,
    body: ([x], ctx) => build(x!, ctx),
  });
}

/** Build the kernel for a binary operation or comparison. */
export function binaryKernel(
  op: string,
  inputs: readonly [EwInput, EwInput],
  out: ScalarDType,
  options: { vec?: VecWidth; wg?: number } = {},
): { ir: KernelIR; key: string } {
  const compare = COMPARE[op];
  if (compare) {
    // Comparisons compute in the operand type but store a boolean, so the
    // compute type is pinned to the inputs rather than derived from the output.
    const compute = computeTypeFor(inputs[0].dtype);
    return ewKernel({
      op,
      inputs,
      out,
      compute,
      vec: options.vec,
      wg: options.wg,
      body: ([a, bb], ctx) =>
        E.select(compare(a!, bb!, ctx), ctx.lit(1), ctx.lit(0)),
    });
  }
  const build = BINARY[op];
  if (!build) throw new Error(`unknown binary elementwise operation '${op}'`);
  return ewKernel({
    op,
    inputs,
    out,
    vec: options.vec,
    wg: options.wg,
    body: ([a, bb], ctx) => build(a!, bb!, ctx),
  });
}

/** Build a cast/copy kernel. */
export function castKernel(
  from: ScalarDType,
  to: ScalarDType,
  options: { vec?: VecWidth; wg?: number } = {},
): { ir: KernelIR; key: string } {
  // Both sides convert through the wider of the two compute types so a
  // narrowing cast rounds once, at the store.
  const compute = isFloatScalar(from) || isFloatScalar(to) ? 'f32' : 'u32';
  return ewKernel({
    op: 'cast',
    inputs: [{ dtype: from, layout: 'cont' }],
    out: to,
    compute,
    vec: options.vec,
    wg: options.wg,
    body: ([x]) => x!,
  });
}

/** Key fragment for a value type, re-exported for template callers. */
export { typeKey };
