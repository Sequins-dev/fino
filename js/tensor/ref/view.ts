/**
 * Host-memory accessor for the reference backend.
 *
 * Reads and writes go through f64 JS numbers, with `set` rounding through the
 * storage dtype. Reference kernels therefore accumulate at full precision and
 * round exactly where a real device would, which is what makes this an oracle
 * rather than an approximation.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/ref`; import from there.
 */
import type { DType } from '../dtype.ts';
import { bf16ToF32, f16ToF32, f32ToBf16, f32ToF16, roundToDType } from '../dtype.ts';
import type { RefAccessor } from '../ops/registry.ts';
import { contiguousStrides, numel, unravel } from '../shape.ts';

/** A reference-backend allocation: plain host memory. */
export interface RefBuffer {
  readonly byteLength: number;
  readonly bytes: ArrayBuffer;
}

/** Allocate host memory. */
export function refAlloc(bytes: number): RefBuffer {
  return { byteLength: bytes, bytes: new ArrayBuffer(bytes) };
}

/**
 * A strided view over host memory.
 */
export class RefView implements RefAccessor {
  readonly dtype: DType;
  readonly shape: readonly number[];
  readonly strides: readonly number[];
  readonly offset: number;
  readonly size: number;

  /**
   * Storage view. Half-precision dtypes are carried as raw bit patterns.
   *
   * @internal
   */
  #store: Float64Array | Float32Array | Int32Array | Uint16Array | Uint8Array | BigInt64Array;

  /**
   * Whether reads and writes need bit conversion.
   *
   * @internal
   */
  #half: 'f16' | 'bf16' | null;

  /**
   * Whether the view is contiguous, letting index arithmetic skip unravelling.
   *
   * @internal
   */
  #contiguous: boolean;

  constructor(
    buffer: ArrayBuffer,
    dtype: DType,
    shape: readonly number[],
    strides?: readonly number[],
    offset = 0,
  ) {
    this.dtype = dtype;
    this.shape = shape;
    this.strides = strides ?? contiguousStrides(shape);
    this.offset = offset;
    this.size = numel(shape);
    this.#half = dtype === 'f16' ? 'f16' : dtype === 'bf16' ? 'bf16' : null;
    this.#store = storeFor(dtype, buffer);
    const expected = contiguousStrides(shape);
    this.#contiguous = this.strides.every((s, i) => s === expected[i]);
  }

  /**
   * Storage offset for a flat logical index.
   *
   * @internal
   */
  #offsetOf(index: number): number {
    if (this.#contiguous) return this.offset + index;
    const coords = unravel(index, this.shape);
    let at = this.offset;
    for (let i = 0; i < coords.length; i++) at += coords[i]! * this.strides[i]!;
    return at;
  }

  get(index: number): number {
    return this.#read(this.#offsetOf(index));
  }

  set(index: number, value: number): void {
    this.#write(this.#offsetOf(index), value);
  }

  getAt(coords: readonly number[]): number {
    let at = this.offset;
    for (let i = 0; i < coords.length; i++) at += coords[i]! * this.strides[i]!;
    return this.#read(at);
  }

  setAt(coords: readonly number[], value: number): void {
    let at = this.offset;
    for (let i = 0; i < coords.length; i++) at += coords[i]! * this.strides[i]!;
    this.#write(at, value);
  }

  /**
   * @internal
   */
  #read(at: number): number {
    if (this.#half === 'f16') return f16ToF32(this.#store[at] as number);
    if (this.#half === 'bf16') return bf16ToF32(this.#store[at] as number);
    if (this.dtype === 'i64') return Number(this.#store[at] as bigint);
    return this.#store[at] as number;
  }

  /**
   * @internal
   */
  #write(at: number, value: number): void {
    if (this.#half === 'f16') {
      (this.#store as Uint16Array)[at] = f32ToF16(value);
      return;
    }
    if (this.#half === 'bf16') {
      (this.#store as Uint16Array)[at] = f32ToBf16(value);
      return;
    }
    if (this.dtype === 'i64') {
      (this.#store as BigInt64Array)[at] = BigInt(Math.trunc(value));
      return;
    }
    (this.#store as Float64Array)[at] = roundToDType(this.dtype, value);
  }

  /**
   * A broadcast-compatible reader over a target shape.
   *
   * Used by elementwise kernels, where operands are stretched to the output shape
   * without copying.
   */
  broadcastTo(target: readonly number[]): RefAccessor {
    const source = this;
    const rank = target.length;
    const strides = new Array<number>(rank).fill(0);
    for (let i = 0; i < rank; i++) {
      const axis = source.shape.length - rank + i;
      if (axis < 0) continue;
      strides[i] = source.shape[axis] === 1 && target[i] !== 1 ? 0 : source.strides[axis]!;
    }
    const size = numel(target);
    return {
      dtype: source.dtype,
      shape: target,
      size,
      get(index: number): number {
        const coords = unravel(index, target);
        let at = source.offset;
        for (let i = 0; i < rank; i++) at += coords[i]! * strides[i]!;
        return source.#read(at);
      },
      set(): void {
        throw new Error('a broadcast view is read-only');
      },
      getAt(coords: readonly number[]): number {
        let at = source.offset;
        for (let i = 0; i < rank; i++) at += coords[i]! * strides[i]!;
        return source.#read(at);
      },
      setAt(): void {
        throw new Error('a broadcast view is read-only');
      },
    };
  }
}

/**
 * Typed-array view matching a dtype's storage.
 *
 * @internal
 */
function storeFor(
  dtype: DType,
  buffer: ArrayBuffer,
): Float64Array | Float32Array | Int32Array | Uint16Array | Uint8Array | BigInt64Array {
  switch (dtype) {
    case 'f64':
      return new Float64Array(buffer);
    case 'f32':
      return new Float32Array(buffer);
    case 'f16':
    case 'bf16':
      return new Uint16Array(buffer);
    case 'i64':
      return new BigInt64Array(buffer);
    case 'i32':
      return new Int32Array(buffer);
    case 'u8':
    case 'bool':
      return new Uint8Array(buffer);
  }
}
