/**
* fino:security/headers - backend security header helpers.
*
* Builds conservative HTTP response headers for common browser-facing backend
* policies. The helpers only format configured header values; they do not
* inspect requests, enforce browser policy locally, or validate full CSP
* grammars. Applications should still test the resulting policy in target
* browsers.
*
* Learn more:
* - Content Security Policy: https://www.w3.org/TR/CSP3/
* - Referrer Policy: https://www.w3.org/TR/referrer-policy/
* - Strict-Transport-Security: https://www.rfc-editor.org/rfc/rfc6797
*/
/**
* Case-insensitive HTTP header map represented with lower-case names.
*
* Header builders in this module normalize names to lower-case and store one
* string value per header. Duplicate header semantics, such as appending
* multiple `Set-Cookie` values, are outside this simple map shape.
*
* ```ts no_run
* import type { HeaderMap } from 'fino:security/headers';
*
* const headers: HeaderMap = { 'x-content-type-options': 'nosniff' };
* ```
*/
export type HeaderMap = Record<string, string>;
/**
* Options controlling the default backend security headers.
*
* Omitted options use conservative defaults. Passing `false` disables headers
* that support opt-out. `extra` is merged last, so it can override defaults or
* add application-specific headers.
*
* ```ts no_run
* import type { SecurityHeadersOptions } from 'fino:security/headers';
*
* const options: SecurityHeadersOptions = {
*   frameOptions: 'SAMEORIGIN',
*   contentSecurityPolicy: "default-src 'self'",
* };
* ```
*/
export interface SecurityHeadersOptions {
  /**
  * Optional Content Security Policy value.
  *
  * The default is omitted because CSP must be tailored to the application.
  * Pass a string to emit `content-security-policy`, or `false` to make the
  * opt-out explicit.
  *
  * ```ts no_run
  * import { createSecurityHeaders } from 'fino:security/headers';
  *
  * createSecurityHeaders({ contentSecurityPolicy: "default-src 'self'" });
  * ```
  */
  contentSecurityPolicy?: string | false;
  /**
  * Value for `x-frame-options`, or `false` to omit it.
  *
  * Defaults to `DENY`. Use `SAMEORIGIN` when same-site framing is required.
  *
  * ```ts no_run
  * import type { SecurityHeadersOptions } from 'fino:security/headers';
  *
  * const options: SecurityHeadersOptions = { frameOptions: 'SAMEORIGIN' };
  * ```
  */
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false;
  /**
  * Value for `referrer-policy`, or `false` to omit it.
  *
  * Defaults to `no-referrer`. Choose a looser policy only when downstream
  * analytics or cross-origin flows need referrer data.
  *
  * ```ts no_run
  * import type { SecurityHeadersOptions } from 'fino:security/headers';
  *
  * const options: SecurityHeadersOptions = { referrerPolicy: 'strict-origin' };
  * ```
  */
  referrerPolicy?: string | false;
  /**
  * Value for `strict-transport-security`, or `false` to omit it.
  *
  * Defaults to `max-age=31536000; includeSubDomains`. Only emit HSTS on HTTPS
  * origins that are ready to enforce HTTPS for the configured scope.
  *
  * ```ts no_run
  * import type { SecurityHeadersOptions } from 'fino:security/headers';
  *
  * const options: SecurityHeadersOptions = { strictTransportSecurity: false };
  * ```
  */
  strictTransportSecurity?: string | false;
  /**
  * Value for `permissions-policy`, or `false` to omit it.
  *
  * The default is omitted because allowed browser features depend on the app.
  *
  * ```ts no_run
  * import type { SecurityHeadersOptions } from 'fino:security/headers';
  *
  * const options: SecurityHeadersOptions = { permissionsPolicy: 'geolocation=()' };
  * ```
  */
  permissionsPolicy?: string | false;
  /**
  * Value for `cross-origin-opener-policy`, or `false` to omit it.
  *
  * Defaults to `same-origin`, which helps isolate browsing contexts. Disable
  * or relax it only for integrations that require opener access.
  *
  * ```ts no_run
  * import type { SecurityHeadersOptions } from 'fino:security/headers';
  *
  * const options: SecurityHeadersOptions = { crossOriginOpenerPolicy: 'same-origin-allow-popups' };
  * ```
  */
  crossOriginOpenerPolicy?: string | false;
  /**
  * Additional headers merged after the defaults.
  *
  * Names are normalized to lower-case, and later values take precedence.
  *
  * ```ts no_run
  * import type { SecurityHeadersOptions } from 'fino:security/headers';
  *
  * const options: SecurityHeadersOptions = { extra: { 'x-robots-tag': 'noindex' } };
  * ```
  */
  extra?: HeaderMap;
}
function assertHeaderName(name: string): void {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new Error(`Invalid HTTP header name: ${name}`);
  }
}
function assertHeaderValue(value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error('Invalid HTTP header value');
  }
}
/**
* Build conservative security headers for backend HTTP responses.
*
* Defaults include `x-content-type-options: nosniff`, `x-frame-options: DENY`,
* `referrer-policy: no-referrer`, HSTS, and COOP. CSP and permissions policy
* are emitted only when supplied. Header names are lower-case and `extra`
* values override generated defaults.
*
* ```ts no_run
* import { createSecurityHeaders } from 'fino:security/headers';
*
* const headers = createSecurityHeaders({
*   contentSecurityPolicy: "default-src 'self'",
* });
* ```
*/
export function createSecurityHeaders(options: SecurityHeadersOptions = {}): HeaderMap {
  const headers: HeaderMap = { 'x-content-type-options': 'nosniff' };
  const frameOptions = options.frameOptions ?? 'DENY';
  if (frameOptions !== false) headers['x-frame-options'] = frameOptions;
  const referrerPolicy = options.referrerPolicy ?? 'no-referrer';
  if (referrerPolicy !== false) headers['referrer-policy'] = referrerPolicy;
  const hsts = options.strictTransportSecurity ?? 'max-age=31536000; includeSubDomains';
  if (hsts !== false) headers['strict-transport-security'] = hsts;
  const coop = options.crossOriginOpenerPolicy ?? 'same-origin';
  if (coop !== false) headers['cross-origin-opener-policy'] = coop;
  const csp = options.contentSecurityPolicy;
  if (typeof csp === 'string') headers['content-security-policy'] = csp;
  const permissionsPolicy = options.permissionsPolicy;
  if (typeof permissionsPolicy === 'string') headers['permissions-policy'] = permissionsPolicy;
  return mergeHeaders(headers, options.extra ?? {});
}
/**
* Merge header maps using lower-case names and later values taking precedence.
*
* `undefined` sets are skipped. Values are coerced with `String()`, so pass
* preformatted header values rather than arrays. This helper is best for
* single-value headers, not multi-value `Set-Cookie` output.
*
* ```ts no_run
* import { mergeHeaders } from 'fino:security/headers';
*
* const headers = mergeHeaders(
*   { 'X-Content-Type-Options': 'nosniff' },
*   { 'x-content-type-options': 'nosniff' },
* );
* ```
*/
export function mergeHeaders(...sets: Array<HeaderMap | undefined>): HeaderMap {
  const out: HeaderMap = {};
  for (const set of sets) {
    if (!set) continue;
    for (const key of Object.keys(set)) {
      const value = String(set[key]);
      assertHeaderName(key);
      assertHeaderValue(value);
      out[key.toLowerCase()] = value;
    }
  }
  return out;
}
