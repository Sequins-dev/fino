/**
 * Byte, base64url, digest, and timing-safe comparison helpers for security APIs.
 *
 * These helpers are shared by public `fino:security` modules for JWT, HMAC, and
 * related encoding tasks. They are implementation support only and should not
 * be emitted as their own generated documentation page.
 *
 * @internal
 */

import { digest } from '../openssl.mts';

/** @internal Byte-oriented inputs accepted by security encoding helpers. */
export type BufferLike = string | Uint8Array | ArrayBuffer | ArrayBufferView;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** @internal Convert a string or binary view to bytes without copying existing `Uint8Array` values. */
export function toBytes(value: BufferLike): Uint8Array {
  if (typeof value === 'string') return textEncoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected string, ArrayBuffer, or ArrayBufferView');
}

/** @internal Decode UTF-8 bytes with replacement semantics. */
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

/** @internal Encode bytes as unpadded base64url. */
export function base64urlEncode(data: BufferLike): string {
  return btoa(bytesToBinary(toBytes(data))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** @internal Decode canonical unpadded base64url, throwing on malformed input. */
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

/** @internal JSON-stringify a value and encode it as unpadded base64url. */
export function base64urlJson(value: unknown): string {
  return base64urlEncode(JSON.stringify(value));
}

/** @internal Decode base64url JSON and require a non-array object result. */
export function parseBase64urlJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(utf8(base64urlDecode(value)));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected encoded JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** @internal Return a SHA-256 digest encoded as unpadded base64url. */
export function sha256Base64url(bytes: BufferLike): string {
  return base64urlEncode(digest('sha-256', toBytes(bytes)));
}

/** @internal Normalize arbitrary secret material to a fixed number of bytes via SHA-256. */
export function normalizeSecretKey(key: BufferLike, bytes = 32): Uint8Array {
  const raw = toBytes(key);
  if (raw.byteLength === bytes) return raw;
  if (raw.byteLength > bytes) return digest('sha-256', raw).subarray(0, bytes);
  return digest('sha-256', raw).subarray(0, bytes);
}

/** @internal Compare two byte inputs without early exit; lengths are included in the comparison. */
export function timingSafeEqual(left: BufferLike, right: BufferLike): boolean {
  const a = toBytes(left);
  const b = toBytes(right);
  const len = Math.max(a.byteLength, b.byteLength);
  let diff = a.byteLength ^ b.byteLength;
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** @internal Compare two strings using the byte-oriented timing-safe equality helper. */
export function timingSafeEqualString(left: string, right: string): boolean {
  return timingSafeEqual(left, right);
}
