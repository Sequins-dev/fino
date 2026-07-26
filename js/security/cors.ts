/**
 * fino:security/cors - build CORS response headers from an origin policy.
 *
 * Fetch CORS protocol: https://fetch.spec.whatwg.org/#http-cors-protocol
 *
 * This module centralizes the small but easy-to-get-wrong rules around
 * reflected origins, wildcard origins, credentialed requests, preflight method
 * lists, and exposed response headers. It returns a plain header map so callers
 * can merge the result into any HTTP response type.
 *
 * The builder is intentionally policy-only: it does not inspect methods,
 * reject requests, or short-circuit preflight handling. Application code should
 * decide when to return a preflight response and should pass the incoming
 * `Origin` value to this module.
 *
 * @example
 * ```ts no_run
 * import { buildCorsHeaders } from 'fino:security/cors';
 *
 * const headers = buildCorsHeaders({
 *   origin: request.headers.get('origin'),
 *   allowOrigins: ['https://app.example'],
 *   methods: ['GET', 'POST', 'OPTIONS'],
 *   allowHeaders: ['authorization'],
 *   credentials: true,
 * });
 * ```
 */
import type { HeaderMap } from './headers.ts';
/**
 * Inputs for building CORS response headers for a request origin.
 *
 * The builder only reflects an origin when that origin is explicitly allowed.
 * Use it with the request `Origin` header for both simple responses and
 * preflight responses. Missing optional lists omit the related headers.
 *
 * ```ts no_run
 * import type { CorsOptions } from 'fino:security/cors';
 *
 * const options: CorsOptions = {
 *   origin: 'https://app.example',
 *   allowOrigins: ['https://app.example'],
 *   credentials: true,
 * };
 * ```
 */
export interface CorsOptions {
  /**
   * Request origin to evaluate.
   *
   * `null`, `undefined`, or an empty string means no origin is reflected. Pass
   * the exact `Origin` header value from the incoming request.
   *
   * ```ts no_run
   * import type { CorsOptions } from 'fino:security/cors';
   *
   * const options: CorsOptions = { origin: request.headers.origin, allowOrigins: '*' };
   * ```
   */
  origin?: string | null;
  /**
   * Allowed origins as `*`, an exact-match list, or a predicate.
   *
   * When credentials are enabled, wildcard allowance reflects the request
   * origin instead of returning `*`, matching browser CORS requirements.
   *
   * ```ts no_run
   * import type { CorsOptions } from 'fino:security/cors';
   *
   * const options: CorsOptions = { allowOrigins: (origin) => origin.endsWith('.example'), origin: 'https://api.example' };
   * ```
   */
  allowOrigins: string[] | '*' | ((origin: string) => boolean);
  /**
   * Methods advertised in `access-control-allow-methods`.
   *
   * Omit or pass an empty array to leave the header out.
   *
   * ```ts no_run
   * import type { CorsOptions } from 'fino:security/cors';
   *
   * const options: CorsOptions = { origin: 'https://app.example', allowOrigins: '*', methods: ['GET', 'POST'] };
   * ```
   */
  methods?: string[];
  /**
   * Request headers advertised in `access-control-allow-headers`.
   *
   * Omit or pass an empty array to leave the header out. Values are joined with
   * comma and space without further validation.
   *
   * ```ts no_run
   * import type { CorsOptions } from 'fino:security/cors';
   *
   * const options: CorsOptions = { origin: 'https://app.example', allowOrigins: '*', allowHeaders: ['authorization'] };
   * ```
   */
  allowHeaders?: string[];
  /**
   * Response headers advertised in `access-control-expose-headers`.
   *
   * Omit or pass an empty array to leave the header out.
   *
   * ```ts no_run
   * import type { CorsOptions } from 'fino:security/cors';
   *
   * const options: CorsOptions = { origin: 'https://app.example', allowOrigins: '*', exposeHeaders: ['x-request-id'] };
   * ```
   */
  exposeHeaders?: string[];
  /**
   * Whether to emit `access-control-allow-credentials: true`.
   *
   * Defaults to omitted. Browsers reject credentialed responses with wildcard
   * origins, so wildcard allowance reflects the request origin when enabled.
   *
   * ```ts no_run
   * import type { CorsOptions } from 'fino:security/cors';
   *
   * const options: CorsOptions = { origin: 'https://app.example', allowOrigins: '*', credentials: true };
   * ```
   */
  credentials?: boolean;
  /**
   * Preflight cache duration in seconds.
   *
   * `undefined` omits `access-control-max-age`; zero emits `0`. Values must
   * be finite and non-negative and are floored before serialization.
   *
   * ```ts no_run
   * import type { CorsOptions } from 'fino:security/cors';
   *
   * const options: CorsOptions = { origin: 'https://app.example', allowOrigins: '*', maxAge: 600 };
   * ```
   */
  maxAge?: number;
}
function originAllowed(origin: string, allow: CorsOptions['allowOrigins']): boolean {
  if (allow === '*') return true;
  if (typeof allow === 'function') return allow(origin);
  return allow.includes(origin);
}
function assertTokenList(values: string[] | undefined, label: string): void {
  if (!values) return;
  for (const value of values) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) {
      throw new Error(`Invalid CORS ${label}: ${value}`);
    }
  }
}
function assertOrigin(origin: string): void {
  if (/[\r\n]/.test(origin)) {
    throw new Error(`Invalid CORS origin: ${origin}`);
  }
}
/**
 * Build CORS response headers for an explicit request origin.
 *
 * The returned map always includes `vary: Origin`. It includes
 * `access-control-allow-origin` only when `origin` is non-empty and allowed.
 * List options are joined with comma and space. The function does not throw for
 * denied origins; it simply omits the allow-origin header.
 *
 * ```ts no_run
 * import { buildCorsHeaders } from 'fino:security/cors';
 *
 * const headers = buildCorsHeaders({
 *   origin: 'https://app.example',
 *   allowOrigins: ['https://app.example'],
 *   methods: ['GET', 'POST'],
 * });
 * ```
 */
export function buildCorsHeaders(options: CorsOptions): HeaderMap {
  assertTokenList(options.methods, 'method');
  assertTokenList(options.allowHeaders, 'header name');
  assertTokenList(options.exposeHeaders, 'header name');
  if (options.maxAge !== undefined && (!Number.isFinite(options.maxAge) || options.maxAge < 0)) {
    throw new Error('Invalid CORS maxAge');
  }
  const origin = options.origin ?? '';
  if (origin.length > 0) assertOrigin(origin);
  const headers: HeaderMap = { vary: 'Origin' };
  if (origin.length > 0 && originAllowed(origin, options.allowOrigins)) {
    headers['access-control-allow-origin'] =
      options.allowOrigins === '*' && !options.credentials ? '*' : origin;
  }
  if (options.methods && options.methods.length > 0) {
    headers['access-control-allow-methods'] = options.methods.join(', ');
  }
  if (options.allowHeaders && options.allowHeaders.length > 0) {
    headers['access-control-allow-headers'] = options.allowHeaders.join(', ');
  }
  if (options.exposeHeaders && options.exposeHeaders.length > 0) {
    headers['access-control-expose-headers'] = options.exposeHeaders.join(', ');
  }
  if (options.credentials) headers['access-control-allow-credentials'] = 'true';
  if (options.maxAge !== undefined)
    headers['access-control-max-age'] = String(Math.floor(options.maxAge));
  return headers;
}
