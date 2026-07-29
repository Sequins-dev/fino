/**
 * Shape arithmetic and inference.
 *
 * The broadcasting rules here are normative (`docs/tensor-contract.md` §3) and
 * live in exactly one place: the kernel IR's layout classifier imports them
 * rather than restating them, because two copies of a broadcast rule is two
 * chances to disagree.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */

/** Maximum tensor rank. Beyond this, index arithmetic in kernels gets unwieldy. */
export const MAX_RANK = 8;

/** Element count of a shape. Rank 0 has exactly one element. */
export function numel(shape: readonly number[]): number {
  let n = 1;
  for (const d of shape) n *= d;
  return n;
}

/** Row-major strides for a shape, in elements. */
export function contiguousStrides(shape: readonly number[]): number[] {
  const strides = new Array<number>(shape.length);
  let acc = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    strides[i] = acc;
    acc *= shape[i]!;
  }
  return strides;
}

/** Validate a shape, throwing with the offending axis named. */
export function checkShape(shape: readonly number[]): void {
  if (shape.length > MAX_RANK) {
    throw new Error(`rank ${shape.length} exceeds the maximum of ${MAX_RANK}`);
  }
  for (let i = 0; i < shape.length; i++) {
    const d = shape[i]!;
    if (!Number.isInteger(d) || d < 0) {
      throw new Error(`axis ${i} has invalid size ${d}; sizes must be non-negative integers`);
    }
  }
}

/** Whether a shape has no elements. */
export function isEmpty(shape: readonly number[]): boolean {
  return shape.some((d) => d === 0);
}

/** Render a shape for error messages. */
export function formatShape(shape: readonly number[]): string {
  return `[${shape.join(', ')}]`;
}

/**
 * Broadcast two shapes.
 *
 * Right-aligns, pads the shorter with leading 1s, and takes the maximum per
 * axis. Contract §3.
 */
export function broadcastShapes(a: readonly number[], b: readonly number[]): number[] {
  const rank = Math.max(a.length, b.length);
  if (rank > MAX_RANK) {
    throw new Error(`broadcasting to rank ${rank} exceeds the maximum of ${MAX_RANK}`);
  }
  const out = new Array<number>(rank);
  for (let i = 0; i < rank; i++) {
    const da = a[a.length - rank + i] ?? 1;
    const db = b[b.length - rank + i] ?? 1;
    if (da !== db && da !== 1 && db !== 1) {
      throw new Error(
        `cannot broadcast ${formatShape(a)} with ${formatShape(b)}: axis ${i} has sizes ${da} and ${db}`,
      );
    }
    // A size-1 axis takes the other operand's size, which for a zero-sized axis
    // means the result stays empty rather than becoming 1.
    out[i] = da === 1 ? db : db === 1 ? da : da;
  }
  return out;
}

/** Broadcast several shapes together. */
export function broadcastAll(shapes: readonly (readonly number[])[]): number[] {
  if (shapes.length === 0) return [];
  return shapes.reduce<number[]>((acc, s) => broadcastShapes(acc, s), [...shapes[0]!]);
}

/**
 * Strides for reading an operand as if it had the output's shape.
 *
 * Broadcast axes get stride 0, which is what makes stretching a size-1 axis free
 * rather than a copy.
 */
export function broadcastStrides(
  operandShape: readonly number[],
  outShape: readonly number[],
): number[] {
  const base = contiguousStrides(operandShape);
  const rank = outShape.length;
  const out = new Array<number>(rank).fill(0);
  for (let i = 0; i < rank; i++) {
    const axis = operandShape.length - rank + i;
    if (axis < 0) continue;
    const size = operandShape[axis]!;
    out[i] = size === 1 && outShape[i] !== 1 ? 0 : base[axis]!;
  }
  return out;
}

/** Whether `from` can broadcast to `to` without changing `to`. */
export function broadcastsTo(from: readonly number[], to: readonly number[]): boolean {
  if (from.length > to.length) return false;
  for (let i = 0; i < from.length; i++) {
    const d = from[from.length - 1 - i]!;
    const t = to[to.length - 1 - i]!;
    if (d !== t && d !== 1) return false;
  }
  return true;
}

/**
 * Normalise a possibly negative axis index.
 *
 * Negative axes count from the end, as in NumPy. Rank 0 accepts axis 0 and -1 so
 * `sum(axis)` on a scalar is not a special case for callers.
 */
export function normalizeAxis(axis: number, rank: number, what = 'axis'): number {
  const effective = rank === 0 ? 1 : rank;
  const resolved = axis < 0 ? axis + effective : axis;
  if (resolved < 0 || resolved >= effective) {
    throw new Error(`${what} ${axis} is out of range for rank ${rank}`);
  }
  return rank === 0 ? 0 : resolved;
}

/** Normalise and sort a list of axes, rejecting duplicates. */
export function normalizeAxes(
  axes: readonly number[] | undefined,
  rank: number,
): number[] {
  if (axes === undefined) return Array.from({ length: rank }, (_, i) => i);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const axis of axes) {
    const resolved = normalizeAxis(axis, rank);
    if (seen.has(resolved)) throw new Error(`axis ${axis} is repeated`);
    seen.add(resolved);
    out.push(resolved);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Output shape of a reduction over `axes`. */
export function reduceShape(
  shape: readonly number[],
  axes: readonly number[],
  keepDims: boolean,
): number[] {
  const drop = new Set(axes);
  const out: number[] = [];
  for (let i = 0; i < shape.length; i++) {
    if (drop.has(i)) {
      if (keepDims) out.push(1);
    } else {
      out.push(shape[i]!);
    }
  }
  return out;
}

/**
 * Resolve a reshape target, expanding a single `-1` placeholder.
 */
export function resolveReshape(
  from: readonly number[],
  to: readonly number[],
): number[] {
  const total = numel(from);
  const placeholders = to.filter((d) => d === -1).length;
  if (placeholders > 1) throw new Error('reshape accepts at most one -1');
  if (placeholders === 0) {
    if (numel(to) !== total) {
      throw new Error(
        `cannot reshape ${formatShape(from)} (${total} elements) to ${formatShape(to)} (${numel(to)})`,
      );
    }
    checkShape(to);
    return [...to];
  }
  const known = to.reduce((acc, d) => (d === -1 ? acc : acc * d), 1);
  if (known === 0 || total % known !== 0) {
    throw new Error(`cannot reshape ${formatShape(from)} to ${formatShape(to)}`);
  }
  const resolved = to.map((d) => (d === -1 ? total / known : d));
  checkShape(resolved);
  return resolved;
}

/** Apply a permutation to a shape. */
export function permuteShape(shape: readonly number[], order: readonly number[]): number[] {
  if (order.length !== shape.length) {
    throw new Error(`permutation of length ${order.length} does not match rank ${shape.length}`);
  }
  const seen = new Set<number>();
  return order.map((axis) => {
    const resolved = normalizeAxis(axis, shape.length, 'permutation entry');
    if (seen.has(resolved)) throw new Error(`permutation repeats axis ${resolved}`);
    seen.add(resolved);
    return shape[resolved]!;
  });
}

/** Permutation that swaps two axes, leaving the rest in order. */
export function transposeOrder(rank: number, a: number, b: number): number[] {
  const order = Array.from({ length: rank }, (_, i) => i);
  const i = normalizeAxis(a, rank);
  const j = normalizeAxis(b, rank);
  order[i] = j;
  order[j] = i;
  return order;
}

/** One axis of a slice. `end` is exclusive. */
export interface SliceSpec {
  start?: number;
  end?: number;
  step?: number;
}

/** A resolved slice axis. */
export interface ResolvedSlice {
  start: number;
  end: number;
  step: number;
  size: number;
}

/**
 * Resolve slice specs against a shape.
 *
 * Negative indices count from the end and out-of-range bounds clamp, matching
 * Python and NumPy so that `slice(0, 1000)` on a short axis is not an error.
 */
export function resolveSlices(
  shape: readonly number[],
  specs: readonly (SliceSpec | null)[],
): ResolvedSlice[] {
  if (specs.length > shape.length) {
    throw new Error(`slice has ${specs.length} axes but the tensor has rank ${shape.length}`);
  }
  return shape.map((size, axis) => {
    const spec = specs[axis] ?? null;
    if (!spec) return { start: 0, end: size, step: 1, size };
    const step = spec.step ?? 1;
    if (step === 0) throw new Error(`slice step on axis ${axis} must not be zero`);
    if (step < 0) throw new Error(`negative slice steps are not supported`);
    let start = spec.start ?? 0;
    let end = spec.end ?? size;
    if (start < 0) start += size;
    if (end < 0) end += size;
    start = Math.min(Math.max(start, 0), size);
    end = Math.min(Math.max(end, 0), size);
    const count = end > start ? Math.ceil((end - start) / step) : 0;
    return { start, end, step, size: count };
  });
}

/** Output shape of a resolved slice. */
export function sliceShape(resolved: readonly ResolvedSlice[]): number[] {
  return resolved.map((r) => r.size);
}

/** Output shape of concatenating shapes along an axis. */
export function concatShape(
  shapes: readonly (readonly number[])[],
  axis: number,
): number[] {
  if (shapes.length === 0) throw new Error('concat needs at least one tensor');
  const rank = shapes[0]!.length;
  const resolved = normalizeAxis(axis, rank);
  const out = [...shapes[0]!];
  for (let i = 1; i < shapes.length; i++) {
    const s = shapes[i]!;
    if (s.length !== rank) {
      throw new Error(`concat operand ${i} has rank ${s.length}, expected ${rank}`);
    }
    for (let a = 0; a < rank; a++) {
      if (a === resolved) continue;
      if (s[a] !== out[a]) {
        throw new Error(
          `concat operand ${i} has ${formatShape(s)}, incompatible with ${formatShape(shapes[0]!)} on axis ${a}`,
        );
      }
    }
    out[resolved]! += s[resolved]!;
  }
  return out;
}

/** Shape of an `expand`, which may only stretch size-1 axes. */
export function expandShape(from: readonly number[], to: readonly number[]): number[] {
  if (!broadcastsTo(from, to)) {
    throw new Error(`cannot expand ${formatShape(from)} to ${formatShape(to)}`);
  }
  checkShape(to);
  return [...to];
}

/** Matrix-multiply shape inference result. */
export interface MatmulShape {
  /** Output shape after removing any axes 1-D promotion added. */
  out: number[];
  /** Rows of the matrix operation. */
  m: number;
  /** Shared dimension. */
  k: number;
  /** Columns of the matrix operation. */
  n: number;
  /** Batch shape the leading axes broadcast to. */
  batch: number[];
  /** Whether `a` was a 1-D operand promoted to a row vector. */
  promotedA: boolean;
  /** Whether `b` was a 1-D operand promoted to a column vector. */
  promotedB: boolean;
}

/**
 * Infer the shape of `a @ b`.
 *
 * The last two axes form the matrix; leading axes broadcast. 1-D operands are
 * promoted for the duration of the operation and the promoted axis is removed
 * from the result, per PyTorch. Contract §3.
 */
export function matmulShape(a: readonly number[], b: readonly number[]): MatmulShape {
  if (a.length === 0 || b.length === 0) {
    throw new Error('matmul operands must have rank at least 1');
  }
  const promotedA = a.length === 1;
  const promotedB = b.length === 1;
  const lhs = promotedA ? [1, a[0]!] : a;
  const rhs = promotedB ? [b[0]!, 1] : b;

  const m = lhs[lhs.length - 2]!;
  const ka = lhs[lhs.length - 1]!;
  const kb = rhs[rhs.length - 2]!;
  const n = rhs[rhs.length - 1]!;
  if (ka !== kb) {
    throw new Error(
      `matmul shape mismatch: ${formatShape(a)} and ${formatShape(b)} disagree on the shared dimension (${ka} vs ${kb})`,
    );
  }

  const batch = broadcastShapes(lhs.slice(0, -2), rhs.slice(0, -2));
  const out = [...batch];
  if (!promotedA) out.push(m);
  if (!promotedB) out.push(n);
  return { out, m, k: ka, n, batch, promotedA, promotedB };
}

/**
 * Axes of `shape` that were broadcast to produce `target`.
 *
 * Backward passes need this: a gradient flowing back into a broadcast operand
 * must be summed over the axes broadcasting stretched, then reshaped. Getting
 * this wrong is the classic autodiff bug, so it is computed once here.
 */
export function broadcastReduceAxes(
  shape: readonly number[],
  target: readonly number[],
): number[] {
  const axes: number[] = [];
  const offset = target.length - shape.length;
  for (let i = 0; i < target.length; i++) {
    const own = i < offset ? 1 : shape[i - offset]!;
    if (own === 1 && target[i] !== 1) axes.push(i);
  }
  // Leading axes the operand does not have at all are always reduced.
  for (let i = 0; i < offset; i++) if (!axes.includes(i)) axes.push(i);
  axes.sort((x, y) => x - y);
  return axes;
}

/** Convert a flat index to per-axis coordinates. */
export function unravel(index: number, shape: readonly number[]): number[] {
  const coords = new Array<number>(shape.length);
  let rest = index;
  for (let i = shape.length - 1; i >= 0; i--) {
    const size = shape[i]!;
    coords[i] = rest % size;
    rest = Math.floor(rest / size);
  }
  return coords;
}

/** Convert per-axis coordinates to a flat offset using explicit strides. */
export function ravel(coords: readonly number[], strides: readonly number[]): number {
  let offset = 0;
  for (let i = 0; i < coords.length; i++) offset += coords[i]! * strides[i]!;
  return offset;
}
