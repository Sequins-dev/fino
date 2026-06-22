/**
 * fino:security provides compact helpers for common backend security tasks.
 *
 * The module includes cryptographic random bytes and tokens, security and CORS
 * header builders, signed or sealed cookies, PBKDF2 password records, JWK/JWKS
 * utilities, compact JWT/JWE helpers, and signed opaque JSON tokens.
 *
 * Learn more:
 * - Fetch CORS protocol: https://fetch.spec.whatwg.org/#http-cors-protocol
 * - HTTP cookies: https://www.rfc-editor.org/rfc/rfc6265
 * - JSON Web Token: https://www.rfc-editor.org/rfc/rfc7519
 *
 * ```ts no_run
 * import { createSecurityHeaders, randomToken } from 'fino:security';
 *
 * const headers = createSecurityHeaders();
 * const token = randomToken();
 * ```
 */
export * from './random.mts';
export * from './headers.mts';
export * from './cors.mts';
export * from './cookie.mts';
export * from './token.mts';
export * from './password.mts';
export * from './jwk.mts';
export * from './jwt.mts';
