/**
 * Matrix multiplication.
 *
 * The gradient is expressed with transposed GEMMs rather than by materialising
 * transposed copies, which is why `GemmOpts` carries transpose flags: the
 * backward pass of a linear layer is two more matrix multiplies and no data
 * movement.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import { isFloat, promote } from '../dtype.ts';
import type { OpAttrs } from '../backend.ts';
import { matmulShape, numel } from '../shape.ts';
import type { OpId, RefAccessor } from './registry.ts';
import { registerOp } from './registry.ts';
import type { Tensor } from '../tensor.ts';
import { dispatch } from '../dispatch.ts';

/** Registered id for `gemm`. */
export const GEMM: { id: OpId } = { id: 0 };

/**
 * Hooks installed by the movement module, avoiding an import cycle.
 *
 * @internal
 */
let ops: {
  transpose(t: Tensor, a: number, b: number): Tensor;
  reshape(t: Tensor, shape: readonly number[]): Tensor;
  sumTo(t: Tensor, shape: readonly number[]): Tensor;
} | null = null;

/** Install the movement operations the matmul gradient needs. */
export function installLinalgHooks(value: NonNullable<typeof ops>): void {
  ops = value;
}

/**
 * @internal
 */
function need(): NonNullable<typeof ops> {
  if (!ops) throw new Error('linalg hooks are not installed');
  return ops;
}

GEMM.id = registerOp({
  name: 'gemm',
  group: 'gemm',
  arity: 2,
  dtypeRule: (inputs) => {
    const dtype = promote(inputs[0]!.dtype, inputs[1]!.dtype);
    return isFloat(dtype) ? dtype : 'f32';
  },
  shapeRule: (inputs) => matmulShape(inputs[0]!.shape, inputs[1]!.shape).out,
  enqueue: (backend, inputs, out, attrs, stream) => {
    const m = attrs!.m as number;
    const n = attrs!.n as number;
    const k = attrs!.k as number;
    backend.gemm(inputs[0]!, inputs[1]!, out, {
      m,
      n,
      k,
      batch: attrs!.batch as number,
      transA: attrs!.transA === true,
      transB: attrs!.transB === true,
    });
  },
  vjp: {
    saves: (inputs) => inputs,
    backward: (cot, [a, b], _attrs, needs) => {
      const { transpose, reshape, sumTo } = need();
      // For C = A @ B: dA = dC @ B^T, dB = A^T @ dC. Both are GEMMs.
      const lhs2d = a!.rank === 1 ? reshape(a!, [1, a!.shape[0]!]) : a!;
      const rhs2d = b!.rank === 1 ? reshape(b!, [b!.shape[0]!, 1]) : b!;
      const cot2d = reshapeCotangent(cot, a!, b!, lhs2d, rhs2d, reshape);

      let gradA: Tensor | null = null;
      if (needs[0]) {
        const bT = transpose(rhs2d, -2, -1);
        gradA = matmulRaw(cot2d, bT);
        // Undo any batch broadcasting the forward pass performed.
        gradA = sumTo(gradA, lhs2d.shape);
        if (a!.rank === 1) gradA = reshape(gradA, a!.shape);
      }
      let gradB: Tensor | null = null;
      if (needs[1]) {
        const aT = transpose(lhs2d, -2, -1);
        gradB = matmulRaw(aT, cot2d);
        gradB = sumTo(gradB, rhs2d.shape);
        if (b!.rank === 1) gradB = reshape(gradB, b!.shape);
      }
      return [gradA, gradB];
    },
  },
  refImpl: (inputs, out, attrs) => {
    const a = inputs[0]!;
    const b = inputs[1]!;
    const m = attrs!.m as number;
    const n = attrs!.n as number;
    const k = attrs!.k as number;
    const batch = attrs!.batch as number;
    // Batch strides are zero for an operand that broadcasts over the batch.
    const aBatch = numel(a.shape) === m * k ? 0 : m * k;
    const bBatch = numel(b.shape) === k * n ? 0 : k * n;
    for (let batchIndex = 0; batchIndex < batch; batchIndex++) {
      const aBase = batchIndex * aBatch;
      const bBase = batchIndex * bBatch;
      const outBase = batchIndex * m * n;
      for (let row = 0; row < m; row++) {
        for (let col = 0; col < n; col++) {
          // Accumulate in f64: this is the oracle, so precision beats speed.
          let total = 0;
          for (let i = 0; i < k; i++) {
            total += a.get(aBase + row * k + i) * b.get(bBase + i * n + col);
          }
          out.set(outBase + row * n + col, total);
        }
      }
    }
  },
});

/**
 * Reshape a cotangent to the two-dimensional form the gradient GEMMs expect.
 *
 * 1-D operands were promoted for the forward pass, so the cotangent needs the
 * matching promotion before it can be multiplied.
 *
 * @internal
 */
function reshapeCotangent(
  cot: Tensor,
  a: Tensor,
  b: Tensor,
  lhs2d: Tensor,
  rhs2d: Tensor,
  reshape: (t: Tensor, shape: readonly number[]) => Tensor,
): Tensor {
  if (a.rank > 1 && b.rank > 1) return cot;
  const m = lhs2d.shape[lhs2d.rank - 2]!;
  const n = rhs2d.shape[rhs2d.rank - 1]!;
  const batch = cot.shape.slice(0, Math.max(cot.rank - (a.rank > 1 ? 1 : 0) - (b.rank > 1 ? 1 : 0), 0));
  return reshape(cot, [...batch, m, n]);
}

/**
 * Dispatch a GEMM with attributes derived from the operand shapes.
 *
 * @internal
 */
function matmulRaw(a: Tensor, b: Tensor): Tensor {
  const info = matmulShape(a.shape, b.shape);
  return dispatch(GEMM.id, [a, b], {
    m: info.m,
    n: info.n,
    k: info.k,
    batch: Math.max(numel(info.batch), 1),
    transA: false,
    transB: false,
  });
}

/**
 * Matrix multiply.
 *
 * The last two axes form the matrix and leading axes broadcast. 1-D operands are
 * promoted for the operation and the promoted axis is dropped from the result.
 */
export function matmul(a: Tensor, b: Tensor): Tensor {
  const info = matmulShape(a.shape, b.shape);
  return dispatch(GEMM.id, [a, b], {
    m: info.m,
    n: info.n,
    k: info.k,
    batch: Math.max(numel(info.batch), 1),
    transA: false,
    transB: false,
  });
}
