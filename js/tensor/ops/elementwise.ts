/**
 * Elementwise operations.
 *
 * Each entry declares its dtype and shape rules, how it reaches a backend, its
 * gradient, and its reference kernel. The gradients are written as ordinary
 * dispatched operations, which is what keeps the tape portable across every
 * backend including the oracle.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import type { DType } from '../dtype.ts';
import { isFloat, promote, promoteScalar } from '../dtype.ts';
import type { EwOp, OpAttrs } from '../backend.ts';
import { broadcastAll, broadcastReduceAxes, numel } from '../shape.ts';
import type { OpId, RefAccessor } from './registry.ts';
import { registerOp } from './registry.ts';
import type { Tensor } from '../tensor.ts';
import { dispatch } from '../dispatch.ts';

/** Registered operation ids, so call sites index rather than look up by name. */
export const EW: Record<string, OpId> = {};

/**
 * Result dtype for an elementwise operation over tensor inputs.
 *
 * @internal
 */
function promoteInputs(inputs: readonly Tensor[], attrs: OpAttrs | null): DType {
  let dtype = inputs[0]!.dtype;
  for (let i = 1; i < inputs.length; i++) dtype = promote(dtype, inputs[i]!.dtype);
  // A scalar operand is weak: it adopts the tensor dtype rather than widening it.
  if (attrs && typeof attrs.scalar === 'number') {
    dtype = promoteScalar(dtype, attrs.scalar);
  }
  return dtype;
}

/**
 * Broadcast shape of the inputs.
 *
 * @internal
 */
function broadcastInputs(inputs: readonly Tensor[]): readonly number[] {
  return inputs.length === 1 ? inputs[0]!.shape : broadcastAll(inputs.map((t) => t.shape));
}

/**
 * Reduce a cotangent back to an operand's shape.
 *
 * A gradient flowing into a broadcast operand must be summed over the axes
 * broadcasting stretched, then reshaped. This is the classic autodiff bug, so
 * every rule that can broadcast routes through here.
 *
 * @internal
 */
function unbroadcast(grad: Tensor, shape: readonly number[]): Tensor {
  if (grad.shape.length === shape.length && grad.shape.every((d, i) => d === shape[i])) {
    return grad;
  }
  const axes = broadcastReduceAxes(shape, grad.shape);
  const summed = axes.length > 0 ? sumOver(grad, axes, true) : grad;
  return reshapeTo(summed, shape);
}

/**
 * Hooks other modules install so this one does not import them and form a cycle.
 *
 * @internal
 */
let ops: {
  sum(t: Tensor, axes: readonly number[], keepDims: boolean): Tensor;
  reshape(t: Tensor, shape: readonly number[]): Tensor;
} | null = null;

/** Install the operations elementwise gradients need. */
export function installElementwiseHooks(value: NonNullable<typeof ops>): void {
  ops = value;
}

/**
 * @internal
 */
function sumOver(t: Tensor, axes: readonly number[], keepDims: boolean): Tensor {
  if (!ops) throw new Error('elementwise hooks are not installed');
  return ops.sum(t, axes, keepDims);
}

/**
 * @internal
 */
function reshapeTo(t: Tensor, shape: readonly number[]): Tensor {
  if (!ops) throw new Error('elementwise hooks are not installed');
  return ops.reshape(t, shape);
}

/** Scalar operand carried as an attribute, or `null`. */
function scalarOf(attrs: OpAttrs | null): number | null {
  if (attrs && typeof attrs.scalar === 'number') return attrs.scalar;
  return null;
}

/**
 * Build a reference kernel for a unary operation.
 *
 * @internal
 */
function unaryRef(f: (x: number) => number) {
  return (inputs: readonly RefAccessor[], out: RefAccessor): void => {
    const x = inputs[0]!;
    for (let i = 0; i < out.size; i++) out.set(i, f(x.get(i)));
  };
}

/**
 * Build a reference kernel for a binary operation, honouring broadcasting and a
 * scalar operand.
 *
 * @internal
 */
function binaryRef(f: (a: number, b: number) => number) {
  return (
    inputs: readonly RefAccessor[],
    out: RefAccessor,
    attrs: OpAttrs | null,
  ): void => {
    const scalar = scalarOf(attrs);
    const a = inputs[0]!;
    if (scalar !== null) {
      const rhs = attrs?.scalarSide !== 'lhs';
      for (let i = 0; i < out.size; i++) {
        const value = a.get(i);
        out.set(i, rhs ? f(value, scalar) : f(scalar, value));
      }
      return;
    }
    const b = inputs[1]!;
    const aBroadcast = broadcastReader(a, out.shape);
    const bBroadcast = broadcastReader(b, out.shape);
    for (let i = 0; i < out.size; i++) out.set(i, f(aBroadcast(i), bBroadcast(i)));
  };
}

/**
 * Reader that stretches an operand to the output shape.
 *
 * @internal
 */
function broadcastReader(
  operand: RefAccessor,
  target: readonly number[],
): (index: number) => number {
  const sameShape =
    operand.shape.length === target.length && operand.shape.every((d, i) => d === target[i]);
  if (sameShape) return (index) => operand.get(index);
  const rank = target.length;
  const strides = new Array<number>(rank).fill(0);
  const own = contiguousOf(operand.shape);
  for (let i = 0; i < rank; i++) {
    const axis = operand.shape.length - rank + i;
    if (axis < 0) continue;
    strides[i] = operand.shape[axis] === 1 && target[i] !== 1 ? 0 : own[axis]!;
  }
  const sizes = [...target];
  return (index) => {
    let rest = index;
    let flat = 0;
    for (let i = rank - 1; i >= 0; i--) {
      const size = sizes[i]!;
      const coord = rest % size;
      rest = Math.floor(rest / size);
      flat += coord * strides[i]!;
    }
    return operand.get(flat);
  };
}

/**
 * Contiguous strides, duplicated locally to keep this module free of a cycle
 * through `shape.ts`'s broader surface.
 *
 * @internal
 */
function contiguousOf(shape: readonly number[]): number[] {
  const strides = new Array<number>(shape.length);
  let acc = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    strides[i] = acc;
    acc *= shape[i]!;
  }
  return strides;
}

/** Definition of a unary operation. */
interface UnaryDef {
  name: EwOp;
  /** Reference implementation. */
  f: (x: number) => number;
  /**
   * Gradient, given the cotangent and whichever of input and output was saved.
   *
   * Omitted for non-differentiable operations.
   */
  grad?: (cot: Tensor, saved: readonly Tensor[]) => Tensor;
  /** Whether the rule needs the output rather than the input. */
  savesOutput?: boolean;
  /** Result dtype, when it is not the input's. */
  dtype?: DType;
}

/**
 * Register a unary operation.
 *
 * @internal
 */
function unary(def: UnaryDef): void {
  EW[def.name] = registerOp({
    name: def.name,
    group: 'elementwise',
    arity: 1,
    dtypeRule: (inputs) => {
      if (def.dtype) return def.dtype;
      // Transcendental functions on integers produce floats.
      const dtype = inputs[0]!.dtype;
      return isFloat(dtype) ? dtype : 'f32';
    },
    shapeRule: (inputs) => inputs[0]!.shape,
    enqueue: (backend, inputs, out, attrs, stream) =>
      backend.elementwise(def.name, inputs, out, attrs, stream),
    vjp: def.grad
      ? {
          saves: (inputs, output) => (def.savesOutput ? [output] : [inputs[0]!]),
          backward: (cot, saved, _attrs, needs) =>
            needs[0] ? [def.grad!(cot, saved)] : [null],
        }
      : undefined,
    refImpl: unaryRef(def.f),
  });
}

/** Definition of a binary operation. */
interface BinaryDef {
  name: EwOp;
  f: (a: number, b: number) => number;
  /**
   * Gradient with respect to each operand.
   *
   * `a` and `b` are the operands as the rule needs to see them: either two saved
   * tensors, or one saved tensor and a number when the call folded a scalar into
   * an attribute. Returning a gradient for a scalar operand is harmless — the
   * caller drops it, since there is no tensor to accumulate into.
   */
  grad?: (
    cot: Tensor,
    a: Tensor | number,
    b: Tensor | number,
    needs: readonly boolean[],
  ) => (Tensor | null)[];
  /** Whether the rule needs the operands at all. */
  needsOperands?: boolean;
  /** Fixed result dtype, for comparisons. */
  dtype?: DType;
}

/**
 * Register a binary operation.
 *
 * @internal
 */
function binary(def: BinaryDef): void {
  EW[def.name] = registerOp({
    name: def.name,
    group: 'elementwise',
    arity: 2,
    dtypeRule: (inputs, attrs) => def.dtype ?? promoteInputs(inputs, attrs),
    shapeRule: (inputs) => broadcastInputs(inputs),
    enqueue: (backend, inputs, out, attrs, stream) =>
      backend.elementwise(def.name, inputs, out, attrs, stream),
    vjp: def.grad
      ? {
          saves: (inputs) => (def.needsOperands === false ? [] : inputs),
          backward: (cot, saved, attrs, needs) => {
            const scalar = scalarOf(attrs);
            if (scalar === null) {
              return def.grad!(cot, saved[0] ?? 0, saved[1] ?? 0, needs);
            }
            // One tensor operand; the scalar sits on whichever side the call put it.
            const onLeft = attrs?.scalarSide === 'lhs';
            const grads = onLeft
              ? def.grad!(cot, scalar, saved[0] ?? 0, [false, needs[0] ?? false])
              : def.grad!(cot, saved[0] ?? 0, scalar, [needs[0] ?? false, false]);
            return [onLeft ? grads[1]! : grads[0]!];
          },
        }
      : undefined,
    refImpl: binaryRef(def.f),
  });
}


/**
 * Operand helpers for gradient rules.
 *
 * A binary operation's operands may be a tensor or a number, depending on whether
 * the call folded a scalar into an attribute. These accept either so a rule reads
 * the same in both cases.
 *
 * @internal
 */
function mulAny(a: Tensor | number, b: Tensor | number): Tensor {
  if (typeof a === 'number') {
    if (typeof b === 'number') throw new Error('a gradient needs at least one tensor operand');
    return mulScalar(b, a);
  }
  return mul(a, b);
}

/**
 * @internal
 */
function addAny(a: Tensor | number, value: number): Tensor | number {
  return typeof a === 'number' ? a + value : addScalar(a, value);
}

/**
 * @internal
 */
function powAny(a: Tensor | number, b: Tensor | number): Tensor {
  if (typeof a === 'number') {
    if (typeof b === 'number') return fillLike(b, a ** b);
    return dispatch(EW.pow!, [b], { scalar: a, scalarSide: 'lhs' });
  }
  return pow(a, b);
}

/**
 * @internal
 */
function geAny(a: Tensor | number, b: Tensor | number): Tensor {
  if (typeof a === 'number') {
    if (typeof b === 'number') throw new Error('a gradient needs at least one tensor operand');
    return dispatch(EW.ge!, [b], { scalar: a, scalarSide: 'lhs' });
  }
  return geOp(a, b);
}

/**
 * @internal
 */
function leAny(a: Tensor | number, b: Tensor | number): Tensor {
  if (typeof a === 'number') {
    if (typeof b === 'number') throw new Error('a gradient needs at least one tensor operand');
    return dispatch(EW.le!, [b], { scalar: a, scalarSide: 'lhs' });
  }
  return leOp(a, b);
}

/**
 * A tensor shaped like `t`, filled with a constant.
 *
 * @internal
 */
function fillLike(t: Tensor, value: number): Tensor {
  return addScalar(mulScalar(t, 0), value);
}

// -- unary --------------------------------------------------------------------

unary({ name: 'neg', f: (x) => -x, grad: (cot) => neg(cot) });
unary({
  name: 'abs',
  f: Math.abs,
  grad: (cot, [x]) => mul(cot, sign(x!)),
});
unary({
  name: 'exp',
  f: Math.exp,
  savesOutput: true,
  grad: (cot, [y]) => mul(cot, y!),
});
unary({
  name: 'log',
  f: Math.log,
  grad: (cot, [x]) => div(cot, x!),
});
unary({
  name: 'sqrt',
  f: Math.sqrt,
  savesOutput: true,
  grad: (cot, [y]) => div(cot, mulScalar(y!, 2)),
});
unary({
  name: 'rsqrt',
  f: (x) => 1 / Math.sqrt(x),
  savesOutput: true,
  // d/dx x^-1/2 = -1/2 x^-3/2 = -1/2 * y^3
  grad: (cot, [y]) => mulScalar(mul(cot, mul(y!, mul(y!, y!))), -0.5),
});
unary({ name: 'sin', f: Math.sin, grad: (cot, [x]) => mul(cot, cos(x!)) });
unary({ name: 'cos', f: Math.cos, grad: (cot, [x]) => neg(mul(cot, sin(x!))) });
unary({
  name: 'tanh',
  f: Math.tanh,
  savesOutput: true,
  // 1 - y^2
  grad: (cot, [y]) => mul(cot, subFrom(1, mul(y!, y!))),
});
unary({
  name: 'sigmoid',
  f: (x) => 1 / (1 + Math.exp(-x)),
  savesOutput: true,
  // y * (1 - y)
  grad: (cot, [y]) => mul(cot, mul(y!, subFrom(1, y!))),
});
unary({
  name: 'relu',
  f: (x) => (x > 0 ? x : 0),
  savesOutput: true,
  // The mask comes from the output, so the input need not be kept alive.
  grad: (cot, [y]) => mul(cot, castTo(gtScalar(y!, 0), cot.dtype)),
});
unary({
  name: 'silu',
  f: (x) => x / (1 + Math.exp(-x)),
  grad: (cot, [x]) => {
    const s = sigmoid(x!);
    // s + x * s * (1 - s)
    return mul(cot, add(s, mul(x!, mul(s, subFrom(1, s)))));
  },
});
unary({
  name: 'gelu',
  // The tanh approximation, which is what reference implementations use; the
  // oracle must match the kernels rather than be more exact than them.
  f: geluExact,
  grad: (cot, [x]) => mul(cot, geluGrad(x!)),
});
unary({
  name: 'erf',
  f: erf,
  // d/dx erf(x) = 2/sqrt(pi) * exp(-x^2)
  grad: (cot, [x]) => mul(cot, mulScalar(exp(neg(mul(x!, x!))), 2 / Math.sqrt(Math.PI))),
});
unary({ name: 'floor', f: Math.floor });
unary({ name: 'ceil', f: Math.ceil });
unary({ name: 'round', f: (x) => Math.round(x) });
unary({ name: 'logicalNot', f: (x) => (x === 0 ? 1 : 0), dtype: 'bool' });

// -- binary -------------------------------------------------------------------

binary({
  name: 'add',
  f: (a, b) => a + b,
  needsOperands: false,
  grad: (cot, _a, _b, needs) => [needs[0] ? cot : null, needs[1] ? cot : null],
});
binary({
  name: 'sub',
  f: (a, b) => a - b,
  needsOperands: false,
  grad: (cot, _a, _b, needs) => [needs[0] ? cot : null, needs[1] ? neg(cot) : null],
});
binary({
  name: 'mul',
  f: (a, b) => a * b,
  grad: (cot, a, b, needs) => [
    needs[0] ? mul(cot, b) : null,
    needs[1] ? mul(cot, a) : null,
  ],
});
binary({
  name: 'div',
  f: (a, b) => a / b,
  grad: (cot, a, b, needs) => [
    needs[0] ? div(cot, b) : null,
    // -a / b^2
    needs[1] ? neg(div(mul(cot, a), mulAny(b, b))) : null,
  ],
});
binary({
  name: 'pow',
  f: Math.pow,
  grad: (cot, a, b, needs) => [
    // b * a^(b-1)
    needs[0]
      ? mul(mul(cot, typeof b === 'number' ? b : b), powAny(a, addAny(b, -1)))
      : null,
    // a^b * ln(a)
    needs[1] && typeof a !== 'number' ? mul(cot, mul(powAny(a, b), log(a))) : null,
  ],
});
binary({
  name: 'maximum',
  f: Math.max,
  grad: (cot, a, b, needs) => {
    const mask = castTo(geAny(a, b), cot.dtype);
    return [
      needs[0] ? mul(cot, mask) : null,
      needs[1] ? mul(cot, subFrom(1, mask)) : null,
    ];
  },
});
binary({
  name: 'minimum',
  f: Math.min,
  grad: (cot, a, b, needs) => {
    const mask = castTo(leAny(a, b), cot.dtype);
    return [
      needs[0] ? mul(cot, mask) : null,
      needs[1] ? mul(cot, subFrom(1, mask)) : null,
    ];
  },
});

for (const [name, f] of [
  ['eq', (a: number, b: number) => (a === b ? 1 : 0)],
  ['ne', (a: number, b: number) => (a !== b ? 1 : 0)],
  ['lt', (a: number, b: number) => (a < b ? 1 : 0)],
  ['le', (a: number, b: number) => (a <= b ? 1 : 0)],
  ['gt', (a: number, b: number) => (a > b ? 1 : 0)],
  ['ge', (a: number, b: number) => (a >= b ? 1 : 0)],
] as const) {
  binary({ name: name as EwOp, f: f as (a: number, b: number) => number, dtype: 'bool' });
}

/** Select elementwise between two tensors. */
EW.where = registerOp({
  name: 'where',
  group: 'elementwise',
  arity: 3,
  dtypeRule: (inputs) => promote(inputs[1]!.dtype, inputs[2]!.dtype),
  shapeRule: (inputs) => broadcastAll(inputs.map((t) => t.shape)),
  enqueue: (backend, inputs, out, attrs, stream) =>
    backend.elementwise('where', inputs, out, attrs, stream),
  vjp: {
    saves: (inputs) => [inputs[0]!],
    backward: (cot, [cond], _attrs, needs) => {
      const mask = castTo(cond!, cot.dtype);
      return [
        null,
        needs[1] ? mul(cot, mask) : null,
        needs[2] ? mul(cot, subFrom(1, mask)) : null,
      ];
    },
  },
  refImpl: (inputs, out) => {
    const c = broadcastReader(inputs[0]!, out.shape);
    const a = broadcastReader(inputs[1]!, out.shape);
    const b = broadcastReader(inputs[2]!, out.shape);
    for (let i = 0; i < out.size; i++) out.set(i, c(i) !== 0 ? a(i) : b(i));
  },
});

/** Element type conversion. */
EW.cast = registerOp({
  name: 'cast',
  group: 'elementwise',
  arity: 1,
  dtypeRule: (_inputs, attrs) => attrs!.dtype as DType,
  shapeRule: (inputs) => inputs[0]!.shape,
  enqueue: (backend, inputs, out, _attrs, stream) => backend.cast(inputs[0]!, out, stream),
  vjp: {
    saves: () => [],
    backward: (cot, _saved, attrs, needs) => [
      // Casting back is the adjoint; a narrowing cast loses information in both
      // directions, which is expected and matches PyTorch.
      needs[0] ? castTo(cot, attrs!.fromDType as DType) : null,
    ],
  },
  refImpl: (inputs, out) => {
    const x = inputs[0]!;
    for (let i = 0; i < out.size; i++) out.set(i, x.get(i));
  },
});

// -- exported helpers ---------------------------------------------------------
//
// These are the free functions gradient rules above call. They also back the
// Tensor methods, so the two paths cannot diverge.

/** Negate. */
export function neg(t: Tensor): Tensor {
  return dispatch(EW.neg!, [t]);
}

/** Natural exponential. */
export function exp(t: Tensor): Tensor {
  return dispatch(EW.exp!, [t]);
}

/** Natural logarithm. */
export function log(t: Tensor): Tensor {
  return dispatch(EW.log!, [t]);
}

/** Logistic sigmoid. */
export function sigmoid(t: Tensor): Tensor {
  return dispatch(EW.sigmoid!, [t]);
}

/** Sine. */
export function sin(t: Tensor): Tensor {
  return dispatch(EW.sin!, [t]);
}

/** Cosine. */
export function cos(t: Tensor): Tensor {
  return dispatch(EW.cos!, [t]);
}

/** Sign, as -1, 0, or 1. */
export function sign(t: Tensor): Tensor {
  return sub(castTo(gtScalar(t, 0), t.dtype), castTo(ltScalar(t, 0), t.dtype));
}

/** Add, broadcasting. */
export function add(a: Tensor, b: Tensor | number): Tensor {
  return binaryCall(EW.add!, a, b);
}

/** Subtract, broadcasting. */
export function sub(a: Tensor, b: Tensor | number): Tensor {
  return binaryCall(EW.sub!, a, b);
}

/** Multiply, broadcasting. */
export function mul(a: Tensor, b: Tensor | number): Tensor {
  return binaryCall(EW.mul!, a, b);
}

/** Divide, broadcasting. */
export function div(a: Tensor, b: Tensor | number): Tensor {
  return binaryCall(EW.div!, a, b);
}

/** Raise to a power, broadcasting. */
export function pow(a: Tensor, b: Tensor | number): Tensor {
  return binaryCall(EW.pow!, a, b);
}

/** Elementwise maximum. */
export function maximum(a: Tensor, b: Tensor | number): Tensor {
  return binaryCall(EW.maximum!, a, b);
}

/** Elementwise minimum. */
export function minimum(a: Tensor, b: Tensor | number): Tensor {
  return binaryCall(EW.minimum!, a, b);
}

/** Greater-or-equal comparison. */
export function geOp(a: Tensor, b: Tensor | number): Tensor {
  return binaryCall(EW.ge!, a, b);
}

/** Less-or-equal comparison. */
export function leOp(a: Tensor, b: Tensor | number): Tensor {
  return binaryCall(EW.le!, a, b);
}

/** Convert to another dtype. */
export function castTo(t: Tensor, dtype: DType): Tensor {
  if (t.dtype === dtype) return t;
  return dispatch(EW.cast!, [t], { dtype, fromDType: t.dtype });
}

/** Select between two tensors by a boolean mask. */
export function where(cond: Tensor, a: Tensor, b: Tensor): Tensor {
  return dispatch(EW.where!, [cond, a, b]);
}

/**
 * Add a scalar.
 *
 * The scalar is an attribute rather than a materialised tensor, which removes an
 * allocation and a host-to-device copy per call and lets a fixed-function
 * backend see a constant rather than a phantom operand.
 */
export function addScalar(t: Tensor, value: number): Tensor {
  return dispatch(EW.add!, [t], { scalar: value, scalarSide: 'rhs' });
}

/** Multiply by a scalar. */
export function mulScalar(t: Tensor, value: number): Tensor {
  return dispatch(EW.mul!, [t], { scalar: value, scalarSide: 'rhs' });
}

/** Subtract a tensor from a scalar. */
export function subFrom(value: number, t: Tensor): Tensor {
  return dispatch(EW.sub!, [t], { scalar: value, scalarSide: 'lhs' });
}

/** Compare against a scalar. */
export function gtScalar(t: Tensor, value: number): Tensor {
  return dispatch(EW.gt!, [t], { scalar: value, scalarSide: 'rhs' });
}

/** Compare against a scalar. */
export function ltScalar(t: Tensor, value: number): Tensor {
  return dispatch(EW.lt!, [t], { scalar: value, scalarSide: 'rhs' });
}

/**
 * Dispatch a binary operation, folding a number operand into an attribute.
 *
 * @internal
 */
function binaryCall(op: OpId, a: Tensor, b: Tensor | number): Tensor {
  if (typeof b === 'number') {
    return dispatch(op, [a], { scalar: b, scalarSide: 'rhs' });
  }
  const out = dispatch(op, [a, b]);
  return out;
}

/** Reduce a cotangent to an operand's shape after broadcasting. */
export { unbroadcast };

/** Number of elements, re-exported for gradient rules that scale by it. */
export { numel };

/**
 * GELU using the tanh approximation.
 *
 * @internal
 */
function geluExact(x: number): number {
  const inner = 0.7978845608028654 * (x + 0.044715 * x * x * x);
  return 0.5 * x * (1 + Math.tanh(inner));
}

/**
 * Gradient of {@link geluExact}, as a tensor expression.
 *
 * @internal
 */
function geluGrad(x: Tensor): Tensor {
  const c = 0.7978845608028654;
  const a = 0.044715;
  // inner = c * (x + a x^3)
  const x2 = mul(x, x);
  const x3 = mul(x2, x);
  const inner = mulScalar(add(x, mulScalar(x3, a)), c);
  const th = dispatch(EW.tanh!, [inner]);
  // d(inner)/dx = c * (1 + 3a x^2)
  const dInner = mulScalar(addScalar(mulScalar(x2, 3 * a), 1), c);
  // 0.5 (1 + tanh) + 0.5 x (1 - tanh^2) d(inner)
  const left = mulScalar(addScalar(th, 1), 0.5);
  const right = mulScalar(mul(mul(x, subFrom(1, mul(th, th))), dInner), 0.5);
  return add(left, right);
}

/**
 * Error function, to near double precision.
 *
 * A cheaper rational approximation would be accurate enough for `f32` *values*,
 * but not for gradient checking: the analytic derivative is exact, so a forward
 * pass carrying 1e-7 of approximation error makes the difference quotient
 * disagree with it by more than the gradient tolerance. Being accurate here is
 * what lets the gradient rule stay exact.
 *
 * Uses the Maclaurin series where it converges quickly and a continued fraction
 * for the tail.
 *
 * @internal
 */
function erf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (!Number.isFinite(x)) return x > 0 ? 1 : -1;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  if (z === 0) return x;
  if (z < 2.5) {
    // erf(z) = 2/sqrt(pi) * sum (-1)^n z^(2n+1) / (n! (2n+1))
    let term = z;
    let total = z;
    for (let n = 1; n < 200; n++) {
      term *= (-z * z) / n;
      const contribution = term / (2 * n + 1);
      total += contribution;
      if (Math.abs(contribution) < Math.abs(total) * 1e-18) break;
    }
    return sign * total * (2 / Math.sqrt(Math.PI));
  }
  // erfc(z) = exp(-z^2) / (z sqrt(pi)) * 1/(1 + 1/(2z^2)/(1 + 2/(2z^2)/(1 + ...)))
  // evaluated with the modified Lentz algorithm.
  const twoZSquared = 2 * z * z;
  let f = 1e-300;
  let c = f;
  let d = 0;
  for (let n = 1; n < 300; n++) {
    const a = n === 1 ? 1 : (n - 1) / twoZSquared;
    d = 1 + a * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    d = 1 / d;
    c = 1 + a / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-17) break;
  }
  const erfc = (Math.exp(-z * z) / (z * Math.sqrt(Math.PI))) * f;
  return sign * (1 - erfc);
}
