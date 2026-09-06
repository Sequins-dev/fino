/**
 * Tensor element types, promotion, and host-array mapping.
 *
 * The rules here are normative and are specified in `specs/tensor-contract.md`
 * §2. They are shared vocabulary rather than an implementation detail: Arrow
 * column conversion, artifact descriptors, and every backend agree on these
 * names and this lattice.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */

/** A tensor element type. */
export type DType = 'f64' | 'f32' | 'f16' | 'bf16' | 'i64' | 'i32' | 'u8' | 'bool';

/** Every dtype, in promotion-rank order. */
export const DTYPES: readonly DType[] = ['bool', 'u8', 'i32', 'i64', 'f16', 'bf16', 'f32', 'f64'];

/** Bytes one element occupies. Booleans are one byte, never bit-packed. */
export const DTYPE_BYTES: Readonly<Record<DType, number>> = {
  f64: 8,
  f32: 4,
  f16: 2,
  bf16: 2,
  i64: 8,
  i32: 4,
  u8: 1,
  bool: 1,
};

/**
 * Promotion rank.
 *
 * `f16` and `bf16` share a rank because neither dominates the other: they have
 * the same width but different exponent/mantissa splits.
 *
 * @internal
 */
const RANK: Readonly<Record<DType, number>> = {
  bool: 0,
  u8: 1,
  i32: 2,
  i64: 3,
  f16: 4,
  bf16: 4,
  f32: 5,
  f64: 6,
};

/** Whether a dtype is floating-point. */
export function isFloat(dtype: DType): boolean {
  return dtype === 'f64' || dtype === 'f32' || dtype === 'f16' || dtype === 'bf16';
}

/** Whether a dtype is an integer type (excludes `bool`). */
export function isInteger(dtype: DType): boolean {
  return dtype === 'i64' || dtype === 'i32' || dtype === 'u8';
}

/** Whether a dtype is signed. */
export function isSigned(dtype: DType): boolean {
  return isFloat(dtype) || dtype === 'i64' || dtype === 'i32';
}

/** The host typed-array constructor a dtype reads back into. */
export type HostArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | BigInt64Array
  | Uint16Array
  | Uint8Array;

/**
 * Allocate a host array of `count` elements for a dtype.
 *
 * `f16` and `bf16` have no host array type, so they are carried as raw bit
 * patterns in a `Uint16Array`. Readback converts them to `Float32Array`
 * instead; see `readback.ts`.
 */
export function hostArrayFor(dtype: DType, count: number): HostArray {
  switch (dtype) {
    case 'f64':
      return new Float64Array(count);
    case 'f32':
      return new Float32Array(count);
    case 'f16':
    case 'bf16':
      return new Uint16Array(count);
    case 'i64':
      return new BigInt64Array(count);
    case 'i32':
      return new Int32Array(count);
    case 'u8':
    case 'bool':
      return new Uint8Array(count);
  }
}

/**
 * Wrap an existing buffer as the host array for a dtype, without copying.
 */
export function viewAs(
  dtype: DType,
  buffer: ArrayBuffer,
  byteOffset = 0,
  count?: number,
): HostArray {
  const length = count ?? (buffer.byteLength - byteOffset) / DTYPE_BYTES[dtype];
  switch (dtype) {
    case 'f64':
      return new Float64Array(buffer, byteOffset, length);
    case 'f32':
      return new Float32Array(buffer, byteOffset, length);
    case 'f16':
    case 'bf16':
      return new Uint16Array(buffer, byteOffset, length);
    case 'i64':
      return new BigInt64Array(buffer, byteOffset, length);
    case 'i32':
      return new Int32Array(buffer, byteOffset, length);
    case 'u8':
    case 'bool':
      return new Uint8Array(buffer, byteOffset, length);
  }
}

/**
 * Promote two dtypes to the type an operation between them produces.
 *
 * Commutative and associative. Contract §2.1.
 */
export function promote(a: DType, b: DType): DType {
  if (a === b) return a;
  const floatA = isFloat(a);
  const floatB = isFloat(b);
  if (floatA && floatB) {
    // Neither f16 nor bf16 can represent the other, so widen past both.
    if ((a === 'f16' && b === 'bf16') || (a === 'bf16' && b === 'f16')) return 'f32';
    return RANK[a] >= RANK[b] ? a : b;
  }
  // An integer operand never widens a float operand.
  if (floatA) return a;
  if (floatB) return b;
  return RANK[a] >= RANK[b] ? a : b;
}

/** Promote a list of dtypes, left to right. */
export function promoteAll(dtypes: readonly DType[]): DType {
  if (dtypes.length === 0) throw new Error('promoteAll needs at least one dtype');
  return dtypes.reduce((acc, d) => promote(acc, d));
}

/**
 * Result dtype for an operation between a tensor and a JS number.
 *
 * Numbers are *weak*: they adopt the tensor's dtype rather than promoting it, so
 * `f16Tensor.mul(2)` stays `f16`. Contract §2.2.
 */
export function promoteScalar(dtype: DType, value: number): DType {
  if (isFloat(dtype)) return dtype;
  const integral = Number.isInteger(value);
  if (dtype === 'bool') return integral ? 'i32' : 'f32';
  return integral ? dtype : 'f32';
}

/** Inclusive value range a dtype can represent exactly, for range checks. */
export function rangeOf(dtype: DType): { min: number; max: number } {
  switch (dtype) {
    case 'bool':
      return { min: 0, max: 1 };
    case 'u8':
      return { min: 0, max: 255 };
    case 'i32':
      return { min: -2147483648, max: 2147483647 };
    case 'i64':
      // Beyond 2^53 a JS number cannot name an exact integer anyway.
      return { min: -9007199254740991, max: 9007199254740991 };
    case 'f16':
      return { min: -65504, max: 65504 };
    case 'bf16':
    case 'f32':
      return { min: -3.4028234663852886e38, max: 3.4028234663852886e38 };
    case 'f64':
      return { min: -Number.MAX_VALUE, max: Number.MAX_VALUE };
  }
}

/**
 * Check that a scalar is representable in a dtype, throwing if not.
 *
 * Silently wrapping an out-of-range literal is the kind of bug that shows up as
 * wrong numbers much later, so it is refused at the call site.
 */
export function checkScalarRange(dtype: DType, value: number): void {
  if (!Number.isFinite(value)) {
    if (isFloat(dtype)) return;
    throw new Error(`${value} is not representable in ${dtype}`);
  }
  const { min, max } = rangeOf(dtype);
  if (value < min || value > max) {
    throw new Error(`${value} is out of range for ${dtype} (${min} to ${max})`);
  }
  if (!isFloat(dtype) && !Number.isInteger(value)) {
    throw new Error(`${value} is not an integer, so it cannot be stored as ${dtype}`);
  }
}

// -- half-precision conversion ------------------------------------------------

/**
 * Scratch buffer for float bit manipulation.
 *
 * @internal
 */
const SCRATCH = new DataView(new ArrayBuffer(8));

/** Reinterpret an f32 value as its `u32` bit pattern. */
export function f32ToBits(value: number): number {
  SCRATCH.setFloat32(0, value, true);
  return SCRATCH.getUint32(0, true);
}

/** Reinterpret a `u32` bit pattern as an f32 value. */
export function bitsToF32(bits: number): number {
  SCRATCH.setUint32(0, bits >>> 0, true);
  return SCRATCH.getFloat32(0, true);
}

/**
 * Convert an f32 value to IEEE binary16 bits, rounding to nearest even.
 *
 * Handles subnormals and overflow-to-infinity explicitly; a naive
 * exponent-shift conversion gets both wrong, and the oracle's job is to be
 * right rather than fast.
 */
export function f32ToF16(value: number): number {
  const bits = f32ToBits(value);
  const sign = (bits >>> 16) & 0x8000;
  const exp = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;

  if (exp === 0xff) {
    // Infinity, or a NaN whose payload must stay non-zero.
    return sign | 0x7c00 | (mantissa !== 0 ? 0x200 : 0);
  }
  // Unbiased exponent shifted to the binary16 bias.
  let newExp = exp - 127 + 15;
  if (newExp >= 0x1f) return sign | 0x7c00;
  if (newExp <= 0) {
    // Subnormal, or too small to represent at all.
    if (newExp < -10) return sign;
    const sub = mantissa | 0x800000;
    const shift = 14 - newExp;
    const rounded = sub + (1 << (shift - 1)) + ((sub >>> shift) & 1);
    return sign | (rounded >>> shift);
  }
  // Round to nearest, ties to even.
  const roundBias = 0xfff + ((mantissa >>> 13) & 1);
  const rounded = mantissa + roundBias;
  if (rounded & 0x800000) {
    newExp += 1;
    if (newExp >= 0x1f) return sign | 0x7c00;
    return sign | (newExp << 10);
  }
  return sign | (newExp << 10) | (rounded >>> 13);
}

/** Convert IEEE binary16 bits to an f32 value. */
export function f16ToF32(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exp === 0) return sign * mantissa * 2 ** -24;
  if (exp === 0x1f) return mantissa === 0 ? sign * Infinity : NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exp - 15);
}

/**
 * Convert an f32 value to bfloat16 bits, rounding to nearest even.
 *
 * bfloat16 is the high 16 bits of the binary32 pattern, so this is a rounded
 * truncation rather than a re-encoding.
 */
export function f32ToBf16(value: number): number {
  const bits = f32ToBits(value);
  if (((bits >>> 23) & 0xff) === 0xff) {
    // Preserve infinities, and keep NaN payloads non-zero.
    const high = bits >>> 16;
    return (bits & 0x7fffff) !== 0 ? high | 0x40 : high;
  }
  const rounded = bits + 0x7fff + ((bits >>> 16) & 1);
  return (rounded >>> 16) & 0xffff;
}

/** Convert bfloat16 bits to an f32 value. */
export function bf16ToF32(bits: number): number {
  return bitsToF32((bits & 0xffff) << 16);
}

/**
 * Round a value through a dtype's storage precision.
 *
 * The reference backend calls this on every store so that a chain of `f16`
 * operations behaves like real half-precision arithmetic rather than `f32`
 * arithmetic reported as `f16`. The accuracy tolerances in the contract depend
 * on this being faithful.
 */
export function roundToDType(dtype: DType, value: number): number {
  switch (dtype) {
    case 'f64':
      return value;
    case 'f32':
      return Math.fround(value);
    case 'f16':
      return f16ToF32(f32ToF16(value));
    case 'bf16':
      return bf16ToF32(f32ToBf16(value));
    case 'bool':
      return value !== 0 ? 1 : 0;
    case 'u8':
      return clampInt(value, 0, 255);
    case 'i32':
      return clampInt(value, -2147483648, 2147483647);
    case 'i64':
      return Math.trunc(value);
  }
}

/**
 * Truncate towards zero and clamp, matching how a cast to a narrow integer
 * behaves on the accelerated backends.
 *
 * @internal
 */
function clampInt(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * The kernel-IR scalar type a tensor dtype is stored as.
 *
 * The IR has no `f64` or `i64`: no GPU backend in this engine supports either,
 * and the reference backend does not use the IR at all.
 */
export function irScalarFor(dtype: DType): 'f32' | 'f16' | 'bf16' | 'i32' | 'u8' | 'bool' {
  switch (dtype) {
    case 'f32':
      return 'f32';
    case 'f16':
      return 'f16';
    case 'bf16':
      return 'bf16';
    case 'i32':
      return 'i32';
    case 'u8':
      return 'u8';
    case 'bool':
      return 'bool';
    case 'f64':
    case 'i64':
      throw new Error(`${dtype} has no kernel-IR representation; it is CPU-only`);
  }
}
