/**
 * internal:bytes — explicit byte views, owned copies, concatenation, and equality.
 *
 * This module provides protocol-neutral binary primitives for runtime builtins.
 * Its names encode the ownership contract: `asByteView` may alias caller-owned
 * storage, while `copyBytes`, `copyArrayBuffer`, and `concatBytes` always return
 * independently owned storage. Callers remain responsible for domain-specific
 * coercion, error messages, byte ordering, and resource policy.
 *
 * Concatenation accounts for the complete result before allocating it and can
 * enforce a caller-provided byte limit. The equality helpers separate ordinary
 * early-exit comparison from a comparison loop that visits every byte. JavaScript
 * engines do not guarantee constant-time execution, so `timingSafeEqualBytes`
 * only promises not to exit early based on byte contents.
 *
 * The functions are synchronous, side-effect free apart from their documented
 * allocations, and keep no process-global state. Owned results use ordinary
 * Realm-local JavaScript buffers. `asByteView` preserves the input backing store,
 * including shared storage when passed a SharedArrayBuffer-backed view.
 *
 * ```ts no_run
 * import { asByteView, concatBytes, copyBytes } from 'internal:bytes';
 *
 * const source = new Uint16Array([0x1234]);
 * const aliased = asByteView(source);
 * const owned = copyBytes(source);
 * const packet = concatBytes([owned, new Uint8Array([0xff])], { maxBytes: 64 });
 * ```
 *
 * @internal
 */

type ByteSource = ArrayBuffer | ArrayBufferView;

interface ConcatBytesOptions {
  readonly maxBytes?: number;
}

function byteLimit(options?: ConcatBytesOptions): number {
  const maxBytes = options?.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
  return maxBytes;
}

/**
 * Return a `Uint8Array` spanning exactly the bytes visible through `value`.
 *
 * An existing `Uint8Array` is returned unchanged. Other views preserve their
 * `byteOffset` and `byteLength`. The result aliases the input's backing storage;
 * mutations made through either owner are visible through the other. A view over
 * `SharedArrayBuffer` remains shared. Unsupported runtime values throw `TypeError`.
 */
export function asByteView(value: ByteSource): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('Expected an ArrayBuffer or ArrayBufferView');
}

/**
 * Copy exactly the bytes visible through `value` into an owned `Uint8Array`.
 *
 * The result never aliases the input, including when `value` is already a
 * `Uint8Array` or has zero length.
 */
export function copyBytes(value: ByteSource): Uint8Array {
  return new Uint8Array(asByteView(value));
}

/**
 * Copy a byte view into an exact-length, independently owned `ArrayBuffer`.
 *
 * Only the view's visible span is copied; bytes before its `byteOffset` or after
 * its `byteLength` are excluded.
 */
export function copyArrayBuffer(value: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(value.byteLength);
  new Uint8Array(result).set(value);
  return result;
}

/**
 * Concatenate `parts` into a newly allocated, independently owned byte array.
 *
 * The total is validated before allocation. When `options.maxBytes` is present,
 * a result larger than that limit throws `RangeError`; invalid limits and totals
 * outside JavaScript's safe-integer range also throw `RangeError`. Empty and
 * single-part inputs still return fresh storage so ownership never depends on
 * the number of parts.
 */
export function concatBytes(
  parts: readonly Uint8Array[],
  options?: ConcatBytesOptions,
): Uint8Array {
  const maxBytes = byteLimit(options);
  let total = 0;
  for (const part of parts) {
    if (part.byteLength > maxBytes - total) {
      throw new RangeError(`Concatenated bytes exceed maxBytes (${maxBytes})`);
    }
    total += part.byteLength;
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/**
 * Compare two byte spans for equality, returning immediately on a mismatch.
 *
 * This is the ordinary, efficient comparison for non-secret data. Both offsets
 * and visible lengths are respected. Shared inputs must not be concurrently
 * mutated while comparison is in progress.
 */
export function equalBytes(left: ByteSource, right: ByteSource): boolean {
  const a = asByteView(left);
  const b = asByteView(right);
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Compare two byte spans without exiting early based on their contents.
 *
 * Unequal lengths are compared across the longer span, treating missing bytes
 * as zero while preserving a length mismatch in the result. This reduces an
 * obvious timing side channel but cannot guarantee constant-time execution in
 * a JavaScript engine; callers must still avoid secret-dependent work around it
 * and must not concurrently mutate shared inputs during comparison.
 */
export function timingSafeEqualBytes(left: ByteSource, right: ByteSource): boolean {
  const a = asByteView(left);
  const b = asByteView(right);
  const length = Math.max(a.byteLength, b.byteLength);
  let different = a.byteLength === b.byteLength ? 0 : 1;
  for (let i = 0; i < length; i++) {
    different |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return different === 0;
}
