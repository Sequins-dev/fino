/**
 * Byte, base64url, digest, and timing-safe comparison helpers for security APIs.
 *
 * These helpers are shared by public `fino:security` modules for JWT, HMAC, and
 * related encoding tasks. They are implementation support only and should not
 * be emitted as their own generated documentation page.
 *
 * ## Example
 *
 * ```typescript no_run
 * import * as encoding from 'internal:security/encoding';
 *
 * const header = encoding.base64urlJson({ alg: 'HS256', typ: 'JWT' });
 * const parsed = encoding.parseBase64urlJson(header);
 * const digest = encoding.sha256Base64url('payload');
 * console.assert(parsed.alg === 'HS256' && digest.length > 0);
 * ```
 *
 * @internal
 */

import { digest } from '../openssl.mts';

/**
 * Byte-oriented inputs accepted by security encoding helpers.
 *
 * Strings are encoded as UTF-8. Existing `Uint8Array` instances are reused,
 * while other buffers and views become `Uint8Array` views over the same memory.
 *
 * ```typescript no_run
 * import { toBytes } from 'internal:security/encoding';
 * const bytes = toBytes('secret');
 * ```
 *
 * @internal
 */
export type BufferLike = string | Uint8Array | ArrayBuffer | ArrayBufferView;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Convert a string or binary view to bytes.
 *
 * Existing `Uint8Array` values are returned unchanged. `ArrayBuffer` and typed
 * array views share their backing storage, so callers must copy if mutation by
 * another owner is unsafe. Unsupported inputs throw `TypeError`.
 *
 * ```typescript no_run
 * import { toBytes } from 'internal:security/encoding';
 * const bytes = toBytes(new Uint16Array([0x6162]));
 * ```
 *
 * @internal
 */
export function toBytes(value: BufferLike): Uint8Array {
  if (typeof value === 'string') return textEncoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected string, ArrayBuffer, or ArrayBufferView');
}

/**
 * Decode UTF-8 bytes with the platform `TextDecoder`.
 *
 * Invalid byte sequences use replacement semantics rather than throwing. The
 * return value is always a string.
 *
 * ```typescript no_run
 * import { utf8 } from 'internal:security/encoding';
 * utf8(new Uint8Array([0x68, 0x69])); // 'hi'
 * ```
 *
 * @internal
 */
export function utf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

function bytesToBinary(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

function binaryToBytes(binary: string): Uint8Array {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Encode bytes as unpadded base64url.
 *
 * Accepts the same inputs as `toBytes`. Padding is always stripped and the
 * output alphabet is URL-safe, suitable for JWT and JWK fields.
 *
 * ```typescript no_run
 * import { base64urlEncode } from 'internal:security/encoding';
 * base64urlEncode('hello'); // 'aGVsbG8'
 * ```
 *
 * @internal
 */
export function base64urlEncode(data: BufferLike): string {
  return btoa(bytesToBinary(toBytes(data))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Decode canonical unpadded base64url into bytes.
 *
 * Rejects characters outside the base64url alphabet, impossible lengths, and
 * non-canonical encodings. Throws `Error` on malformed input.
 *
 * ```typescript no_run
 * import { base64urlDecode, utf8 } from 'internal:security/encoding';
 * utf8(base64urlDecode('aGVsbG8')); // 'hello'
 * ```
 *
 * @internal
 */
export function base64urlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid base64url string');
  if (value.length % 4 === 1) throw new Error('Invalid base64url string');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  let decoded: Uint8Array;
  try {
    decoded = binaryToBytes(atob(padded));
  } catch {
    throw new Error('Invalid base64url string');
  }
  if (base64urlEncode(decoded) !== value) throw new Error('Invalid base64url string');
  return decoded;
}

/**
 * JSON-stringify a value and encode it as unpadded base64url.
 *
 * Uses normal `JSON.stringify` semantics, including throwing for unsupported
 * cyclic structures. The result is useful for JOSE header and payload segments.
 *
 * ```typescript no_run
 * import { base64urlJson } from 'internal:security/encoding';
 * const encoded = base64urlJson({ alg: 'HS256' });
 * ```
 *
 * @internal
 */
export function base64urlJson(value: unknown): string {
  return base64urlEncode(JSON.stringify(value));
}

/**
 * Decode a base64url JSON object.
 *
 * Returns a plain record when the decoded JSON is a non-null object. Arrays,
 * scalars, invalid base64url, and invalid JSON throw.
 *
 * ```typescript no_run
 * import { base64urlJson, parseBase64urlJson } from 'internal:security/encoding';
 * const obj = parseBase64urlJson(base64urlJson({ typ: 'JWT' }));
 * ```
 *
 * @internal
 */
export function parseBase64urlJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(utf8(base64urlDecode(value)));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected encoded JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Return a SHA-256 digest encoded as unpadded base64url.
 *
 * The digest input is normalized with `toBytes`. Throws only if the underlying
 * OpenSSL digest helper is unavailable.
 *
 * ```typescript no_run
 * import { sha256Base64url } from 'internal:security/encoding';
 * const thumbprint = sha256Base64url('payload');
 * ```
 *
 * @internal
 */
export function sha256Base64url(bytes: BufferLike): string {
  return base64urlEncode(digest('sha-256', toBytes(bytes)));
}

/**
 * Normalize arbitrary secret material to a fixed byte length.
 *
 * Returns the original `Uint8Array` only when it already has the requested
 * length. Other inputs are SHA-256 digested and truncated to `bytes`, which
 * defaults to 32. This is not a password KDF.
 *
 * ```typescript no_run
 * import { normalizeSecretKey } from 'internal:security/encoding';
 * const key = normalizeSecretKey('shared secret', 32);
 * ```
 *
 * @internal
 */
export function normalizeSecretKey(key: BufferLike, bytes = 32): Uint8Array {
  const raw = toBytes(key);
  if (raw.byteLength === bytes) return raw;
  if (raw.byteLength > bytes) return digest('sha-256', raw).subarray(0, bytes);
  return digest('sha-256', raw).subarray(0, bytes);
}

/**
 * Compare two byte inputs without early exit.
 *
 * Length differences are included in the accumulated diff. This reduces timing
 * leakage for equality checks but does not hide surrounding application timing.
 *
 * ```typescript no_run
 * import { timingSafeEqual } from 'internal:security/encoding';
 * timingSafeEqual('left', new TextEncoder().encode('left')); // true
 * ```
 *
 * @internal
 */
export function timingSafeEqual(left: BufferLike, right: BufferLike): boolean {
  const a = toBytes(left);
  const b = toBytes(right);
  const len = Math.max(a.byteLength, b.byteLength);
  let diff = a.byteLength ^ b.byteLength;
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Compare two strings using UTF-8 byte equality without early exit.
 *
 * Returns `true` only when the strings encode to identical byte sequences.
 * Unicode normalization is not performed.
 *
 * ```typescript no_run
 * import { timingSafeEqualString } from 'internal:security/encoding';
 * timingSafeEqualString('token', 'token'); // true
 * ```
 *
 * @internal
 */
export function timingSafeEqualString(left: string, right: string): boolean {
  return timingSafeEqual(left, right);
}
