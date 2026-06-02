import { hmac } from '../internal/openssl.mts';
import { base64urlDecode, base64urlEncode, base64urlJson, parseBase64urlJson, timingSafeEqualString, toBytes, type BufferLike } from '../internal/security/encoding.mts';

/** Options for issuing an HMAC-signed opaque JSON token. */
export interface IssueTokenOptions {
  expiresIn?: number;
  purpose?: string;
}

/** Options for verifying an HMAC-signed opaque JSON token. */
export interface VerifyTokenOptions {
  purpose?: string;
  now?: number;
  clockTolerance?: number;
}

/** Issue a signed opaque JSON token as `payload.signature`. */
export function issueToken(payload: Record<string, unknown>, secret: BufferLike, options: IssueTokenOptions = {}): string {
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

/** Verify a signed opaque JSON token, returning `null` when invalid, expired, or mismatched. */
export function verifyToken(token: string, secret: BufferLike, options: VerifyTokenOptions = {}): Record<string, unknown> | null {
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
