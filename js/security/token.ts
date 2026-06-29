/**
 * fino:security/token - HMAC-signed opaque JSON tokens.
 *
 * This module issues compact `payload.signature` tokens for workflows that
 * need tamper-evident JSON payloads without the full JWT/JWK stack. Tokens may
 * include a purpose marker and expiration timestamp, and verification returns
 * `null` for malformed, expired, mismatched, or tampered input.
 *
 * Tokens are authenticated but not encrypted. Anyone holding a token can decode
 * the JSON payload, so keep secrets out of it. Use separate purposes for
 * session, email verification, and password-reset flows to prevent accidental
 * token reuse across workflows.
 *
 * @example
 * ```ts no_run
 * import { issueToken, verifyToken } from 'fino:security/token';
 *
 * const token = issueToken({ sub: 'user-123' }, tokenSecret, {
 *   purpose: 'email-verify',
 *   expiresIn: 900,
 * });
 * const payload = verifyToken(token, tokenSecret, { purpose: 'email-verify' });
 * ```
 */

import { hmac } from '../internal/openssl.ts';
import { base64urlDecode, base64urlEncode, base64urlJson, parseBase64urlJson, timingSafeEqualString, toBytes, type BufferLike } from '../internal/security/encoding.ts';

/**
 * Options for issuing an HMAC-signed opaque JSON token.
 *
 * Tokens are authenticated but not encrypted: anyone holding the token can
 * base64url-decode and read the JSON payload. Use `purpose` to bind tokens to a
 * workflow, and `expiresIn` to add an expiration claim.
 *
 * ```ts no_run
 * import type { IssueTokenOptions } from 'fino:security/token';
 *
 * const options: IssueTokenOptions = { purpose: 'email-verify', expiresIn: 900 };
 * ```
 */
export interface IssueTokenOptions {
  /**
   * Lifetime in seconds from issuance time.
   *
   * When omitted, no `exp` claim is added and verification will not expire the
   * token. Negative values create already-expired tokens.
   *
   * ```ts no_run
   * import type { IssueTokenOptions } from 'fino:security/token';
   *
   * const options: IssueTokenOptions = { expiresIn: 60 };
   * ```
   */
  expiresIn?: number;
  /**
   * Optional purpose marker embedded in the payload.
   *
   * Verification can require the same purpose to prevent a token issued for one
   * flow from being reused in another.
   *
   * ```ts no_run
   * import type { IssueTokenOptions } from 'fino:security/token';
   *
   * const options: IssueTokenOptions = { purpose: 'password-reset' };
   * ```
   */
  purpose?: string;
}

/**
 * Options for verifying an HMAC-signed opaque JSON token.
 *
 * Verification checks the HMAC signature, optional expiration, and optional
 * purpose. Invalid, expired, or mismatched tokens return `null` rather than
 * throwing.
 *
 * ```ts no_run
 * import type { VerifyTokenOptions } from 'fino:security/token';
 *
 * const options: VerifyTokenOptions = { purpose: 'email-verify', clockTolerance: 30 };
 * ```
 */
export interface VerifyTokenOptions {
  /**
   * Required purpose value.
   *
   * When provided, the token payload must contain the same `purpose` string or
   * verification returns `null`.
   *
   * ```ts no_run
   * import type { VerifyTokenOptions } from 'fino:security/token';
   *
   * const options: VerifyTokenOptions = { purpose: 'password-reset' };
   * ```
   */
  purpose?: string;
  /**
   * Current Unix time in seconds.
   *
   * Defaults to `Date.now() / 1000`. Supplying it is useful for tests or
   * replaying verification at a known time.
   *
   * ```ts no_run
   * import type { VerifyTokenOptions } from 'fino:security/token';
   *
   * const options: VerifyTokenOptions = { now: 1_700_000_000 };
   * ```
   */
  now?: number;
  /**
   * Expiration grace period in seconds.
   *
   * Defaults to `0`. The value is added to `exp` during verification to allow
   * small clock skews.
   *
   * ```ts no_run
   * import type { VerifyTokenOptions } from 'fino:security/token';
   *
   * const options: VerifyTokenOptions = { clockTolerance: 30 };
   * ```
   */
  clockTolerance?: number;
}

/**
 * Issue a signed opaque JSON token as `payload.signature`.
 *
 * The payload is JSON-serialized and base64url-encoded, then signed with
 * HMAC-SHA-256. The returned token is tamper-evident but not encrypted, so do
 * not include secrets in the payload.
 *
 * ```ts no_run
 * import { issueToken } from 'fino:security/token';
 *
 * const token = issueToken({ sub: 'user-123' }, 'secret', {
 *   purpose: 'session',
 *   expiresIn: 3600,
 * });
 * ```
 */
export function issueToken(payload: Record<string, unknown>, secret: BufferLike, options: IssueTokenOptions = {}): string {
  if (options.expiresIn !== undefined && !Number.isFinite(options.expiresIn)) {
    throw new RangeError('expiresIn must be a finite number');
  }
  if (options.purpose !== undefined && typeof options.purpose !== 'string') {
    throw new TypeError('purpose must be a string');
  }
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    ...(options.purpose !== undefined ? { purpose: options.purpose } : {}),
    ...(options.expiresIn !== undefined ? { exp: now + options.expiresIn } : {}),
  };
  const encoded = base64urlJson(body);
  const sig = base64urlEncode(hmac('sha-256', toBytes(secret), toBytes(encoded)));
  return `${encoded}.${sig}`;
}

/**
 * Verify a signed opaque JSON token and return its JSON payload.
 *
 * Returns `null` for malformed tokens, signature mismatches, expired tokens,
 * JSON decode failures, or purpose mismatches. Signature comparison is
 * timing-safe. The returned payload includes any `purpose` or `exp` fields that
 * were embedded during issuance.
 *
 * ```ts no_run
 * import { issueToken, verifyToken } from 'fino:security/token';
 *
 * const token = issueToken({ sub: 'user-123' }, 'secret', { purpose: 'session' });
 * const payload = verifyToken(token, 'secret', { purpose: 'session' });
 * ```
 */
export function verifyToken(token: string, secret: BufferLike, options: VerifyTokenOptions = {}): Record<string, unknown> | null {
  if (options.now !== undefined && !Number.isFinite(options.now)) return null;
  if (options.clockTolerance !== undefined && (!Number.isFinite(options.clockTolerance) || options.clockTolerance < 0)) return null;
  if (options.purpose !== undefined && typeof options.purpose !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = base64urlEncode(hmac('sha-256', toBytes(secret), toBytes(parts[0]!)));
  if (!timingSafeEqualString(parts[1]!, expected)) return null;
  try {
    const payload = parseBase64urlJson(parts[0]!);
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const tolerance = options.clockTolerance ?? 0;
    if (typeof payload.exp === 'number' && now > payload.exp + tolerance) return null;
    if (options.purpose !== undefined && payload.purpose !== options.purpose) return null;
    return payload;
  } catch {
    try { base64urlDecode(parts[0]!); } catch {}
    return null;
  }
}
