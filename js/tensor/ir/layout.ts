/**
 * Stride analysis that drives kernel specialization.
 *
 * Collapsing dimensions before classifying is what keeps the kernel count down:
 * a contiguous `[2,3,4,5]` elementwise op and a contiguous `[120]` one should
 * compile to the same kernel, and a bias add over any rank should reach the same
 * outer-broadcast kernel rather than the general strided one.
 *
 * The broadcast and stride rules themselves live in `internal:tensor/shape`,
 * which is normative; this module only classifies their results.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/ir`; import from there.
 */
import { broadcastShapes, broadcastStrides, contiguousStrides, numel } from '../shape.ts';

export { broadcastShapes, broadcastStrides, contiguousStrides, numel };

/** How an operand's indices relate to the output's flat index. */
export type LayoutClass =
  /** Same flat index as the output. */
  | 'cont'
  /** Index is `i / inner` — a leading axis repeated over a contiguous block. */
  | 'outerBroadcast'
  /** Index is `i % inner` — a trailing block repeated, as in a row-wise bias. */
  | 'innerBroadcast'
  /** Every element is the same one. */
  | 'scalar'
  /** Needs a per-axis divide-and-modulo index computation. */
  | 'strided';

/** One operand's access pattern relative to the output. */
export interface OperandLayout {
  class: LayoutClass;
  /**
   * Block size for the broadcast classes.
   *
   * For `outerBroadcast` the operand index is `i / inner`; for
   * `innerBroadcast` it is `i % inner`.
   */
  inner: number;
  /** Collapsed shape, for the strided class. */
  shape: readonly number[];
  /** Collapsed strides in elements, for the strided class. */
  strides: readonly number[];
}

/**
 * Collapse axes that are contiguous across every operand at once.
 *
 * Two adjacent output axes may merge only when every operand treats them as one
 * run, so the collapse is computed jointly rather than per operand.
 */
export function collapseAxes(
  outShape: readonly number[],
  operandStrides: readonly (readonly number[])[],
): { shape: number[]; strides: number[][] } {
  const rank = outShape.length;
  if (rank === 0) {
    return { shape: [1], strides: operandStrides.map(() => [0]) };
  }
  const shape: number[] = [outShape[0]!];
  const strides: number[][] = operandStrides.map((s) => [s[0]!]);
  for (let axis = 1; axis < rank; axis++) {
    const size = outShape[axis]!;
    const mergeable = operandStrides.every((s, k) => {
      const prev = strides[k]![strides[k]!.length - 1]!;
      // Mergeable when the previous stride is exactly this axis's span, or when
      // both are broadcast (stride 0 stays 0 across a merge).
      return prev === s[axis]! * size || (prev === 0 && s[axis]! === 0);
    });
    if (mergeable) {
      const last = shape.length - 1;
      shape[last] = shape[last]! * size;
      for (let k = 0; k < strides.length; k++) {
        strides[k]![last] = operandStrides[k]![axis]!;
      }
    } else {
      shape.push(size);
      for (let k = 0; k < strides.length; k++) strides[k]!.push(operandStrides[k]![axis]!);
    }
  }
  return { shape, strides };
}

/**
 * Classify how each operand is indexed relative to the flattened output.
 *
 * The returned classes pick which specialization of a template to emit, and they
 * are part of its cache key.
 */
export function classifyOperands(
  outShape: readonly number[],
  operandShapes: readonly (readonly number[])[],
): { layouts: OperandLayout[]; count: number } {
  const strides = operandShapes.map((s) => broadcastStrides(s, outShape));
  const collapsed = collapseAxes(outShape, strides);
  const count = numel(outShape);
  const contig = contiguousStrides(collapsed.shape);

  const layouts = collapsed.strides.map((operand, index): OperandLayout => {
    const shape = collapsed.shape;
    if (operand.every((s) => s === 0)) {
      return { class: 'scalar', inner: 1, shape, strides: operand };
    }
    if (operand.every((s, axis) => s === contig[axis]!)) {
      return { class: 'cont', inner: 1, shape, strides: operand };
    }
    // Outer broadcast: a leading run varies contiguously, trailing axes are
    // broadcast. Index is then `i / trailingSpan`.
    const firstZero = operand.findIndex((s) => s === 0);
    if (firstZero >= 0) {
      const leadingOk = operand
        .slice(0, firstZero)
        .every((s, axis) => s === contig[axis]! / spanOf(shape, firstZero));
      const trailingAllZero = operand.slice(firstZero).every((s) => s === 0);
      if (leadingOk && trailingAllZero) {
        return {
          class: 'outerBroadcast',
          inner: spanOf(shape, firstZero),
          shape,
          strides: operand,
        };
      }
      const leadingAllZero = operand.slice(0, firstZero + 1).every((s) => s === 0);
      const trailingContig = operand
        .slice(firstZero + 1)
        .every((s, axis) => s === contig[firstZero + 1 + axis]!);
      if (leadingAllZero && trailingContig && firstZero === 0) {
        return {
          class: 'innerBroadcast',
          inner: spanOf(shape, 1),
          shape,
          strides: operand,
        };
      }
    }
    void index;
    return { class: 'strided', inner: 1, shape, strides: operand };
  });

  return { layouts, count };
}

/**
 * Product of `shape[from..]`, the number of elements one step of axis
 * `from - 1` spans.
 *
 * @internal
 */
function spanOf(shape: readonly number[], from: number): number {
  let n = 1;
  for (let i = from; i < shape.length; i++) n *= shape[i]!;
  return n;
}

/** Key fragment describing a set of operand layouts. */
export function layoutKey(layouts: readonly OperandLayout[]): string {
  return layouts
    .map((l) => {
      switch (l.class) {
        case 'cont':
          return 'c';
        case 'scalar':
          return 's';
        case 'outerBroadcast':
          return 'ob';
        case 'innerBroadcast':
          return 'ib';
        case 'strided':
          return `st${l.shape.length}`;
      }
    })
    .join(',');
}
