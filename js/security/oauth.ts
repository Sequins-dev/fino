/**
 * fino:security/oauth - OAuth/OIDC client helpers for application middleware.
 *
 * Useful references:
 * - OAuth 2.1 draft: https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1
 * - PKCE: https://www.rfc-editor.org/rfc/rfc7636
 * - Authorization server metadata: https://www.rfc-editor.org/rfc/rfc8414
 * - OpenID Connect Core: https://openid.net/specs/openid-connect-core-1_0.html
 *
 * This module implements the application-client side of OAuth: PKCE material,
 * authorization URLs, code exchange, refresh, sealed-cookie login state, and
 * JWT bearer validation. It is not an identity provider and intentionally does
 * not implement opaque-token introspection, DPoP, mTLS, device code, or dynamic
 * client registration.
 *
 * ```ts no_run
 * import { oauthLogin, oauthCallback } from 'fino:security/oauth';
 *
 * const provider = {
 *   authorizationEndpoint: 'https://issuer.example/authorize',
 *   tokenEndpoint: 'https://issuer.example/token',
 *   clientId: 'client',
 *   redirectUri: 'https://app.example/callback',
 * };
 * ```
 */
import {
  sealCookie,
  unsealCookie,
  serializeCookie,
  parseCookieHeader,
  type BufferLike,
  type CookieOptions,
} from './cookie.ts';
import { randomBase64Url } from './random.ts';
import { jwtVerify, type JwtKeyInput, type JwtVerifyOptions } from './jwt.ts';
import { sha256Base64url } from '../internal/security/encoding.ts';

/**
 * Static client configuration for one OAuth or OpenID Connect provider.
 */
export interface OAuthProvider {
  /** Authorization endpoint used to start the browser redirect flow. */
  authorizationEndpoint: string;
  /** Token endpoint used for authorization-code and refresh-token grants. */
  tokenEndpoint: string;
  /** Client identifier registered with the provider. */
  clientId: string;
  /** Optional confidential-client secret. Public PKCE clients omit this. */
  clientSecret?: string;
  /** Redirect URI registered with the provider and sent during code exchange. */
  redirectUri: string;
}

/** Provider metadata returned by OAuth/OIDC discovery endpoints. */
export type OAuthMetadata = Record<string, unknown> & {
  /** Authorization endpoint advertised by the provider. */
  authorization_endpoint?: string;
  /** Token endpoint advertised by the provider. */
  token_endpoint?: string;
  /** JWKS endpoint for OIDC and JWT validation. */
  jwks_uri?: string;
  /** Issuer identifier for OIDC token validation. */
  issuer?: string;
};

/**
 * Options for OAuth/OIDC discovery requests.
 */
export interface OAuthDiscoveryOptions {
  /** Fetch implementation used to load provider metadata. */
  fetch?: typeof fetch;
}

/**
 * Fetch RFC 8414 OAuth authorization-server metadata for an issuer URL.
 *
 * The issuer is resolved against `/.well-known/oauth-authorization-server`.
 * Non-success HTTP responses reject with an error that includes the response
 * status code.
 */
export async function discoverOAuthMetadata(
  issuer: string | URL,
  options: OAuthDiscoveryOptions = {},
): Promise<OAuthMetadata> {
  const url = new URL('/.well-known/oauth-authorization-server', issuer);
  const res = await (options.fetch ?? fetch)(url);
  if (!res.ok) throw new Error(`OAuth metadata discovery failed with HTTP ${res.status}`);
  return (await res.json()) as OAuthMetadata;
}

/**
 * Fetch OpenID Provider metadata for an issuer URL.
 *
 * The issuer is resolved against `/.well-known/openid-configuration`. The
 * returned object is intentionally loose because providers commonly include
 * extension metadata alongside the standard OIDC fields.
 */
export async function discoverOpenIdProvider(
  issuer: string | URL,
  options: OAuthDiscoveryOptions = {},
): Promise<OAuthMetadata> {
  const url = new URL('/.well-known/openid-configuration', issuer);
  const res = await (options.fetch ?? fetch)(url);
  if (!res.ok) throw new Error(`OIDC discovery failed with HTTP ${res.status}`);
  return (await res.json()) as OAuthMetadata;
}

/**
 * PKCE verifier and challenge pair for an authorization-code flow.
 */
export interface PkceMaterial {
  /** High-entropy verifier retained server-side until the callback. */
  verifier: string;
  /** Base64url SHA-256 challenge sent to the authorization endpoint. */
  challenge: string;
  /** PKCE challenge method. Fino currently emits only `S256`. */
  method: 'S256';
}

/**
 * Options for `createPkce()`.
 */
export interface PkceOptions {
  /** Optional verifier to validate and derive instead of generating one. */
  verifier?: string;
}

/**
 * Create RFC 7636 S256 PKCE verifier and challenge material.
 *
 * Generated verifiers use 32 random bytes encoded as base64url. Supplied
 * verifiers must satisfy the RFC 7636 character set and 43-128 character
 * length constraints.
 */
export async function createPkce(options: PkceOptions = {}): Promise<PkceMaterial> {
  const verifier = options.verifier ?? randomBase64Url(32);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error('Invalid PKCE verifier');
  return { verifier, challenge: sha256Base64url(verifier), method: 'S256' };
}

/**
 * Inputs used to build an authorization-code redirect URL.
 */
export interface AuthorizationUrlOptions {
  /** Provider authorization endpoint. */
  authorizationEndpoint: string;
  /** Client identifier registered with the provider. */
  clientId: string;
  /** Redirect URI that will receive the callback. */
  redirectUri: string;
  /** Optional scopes, either pre-joined or supplied as individual tokens. */
  scope?: string | readonly string[];
  /** CSRF token that must match on callback. */
  state: string;
  /** Optional OIDC nonce to bind an ID token to this login attempt. */
  nonce?: string;
  /** PKCE S256 challenge derived from the retained verifier. */
  codeChallenge: string;
}

/**
 * Build an OAuth authorization-code redirect URL with PKCE parameters.
 *
 * The returned URL includes `response_type=code`, the provided `state`, and an
 * `S256` PKCE challenge. The function only constructs the URL; callers remain
 * responsible for storing the verifier until callback handling.
 */
export function authorizationUrl(options: AuthorizationUrlOptions): URL {
  const url = new URL(options.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  if (options.scope !== undefined)
    url.searchParams.set(
      'scope',
      Array.isArray(options.scope) ? options.scope.join(' ') : options.scope,
    );
  url.searchParams.set('state', options.state);
  if (options.nonce !== undefined) url.searchParams.set('nonce', options.nonce);
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url;
}

/**
 * Options for exchanging an authorization code.
 */
export interface ExchangeAuthorizationCodeOptions {
  /** Provider configuration that supplies the token endpoint and client id. */
  provider: OAuthProvider;
  /** Authorization code received from the callback request. */
  code: string;
  /** PKCE verifier originally paired with the authorization redirect. */
  codeVerifier: string;
  /** Fetch implementation used to call the provider token endpoint. */
  fetch?: typeof fetch;
}

/**
 * Exchange an authorization code for provider tokens.
 *
 * The request uses the `authorization_code` grant and
 * `application/x-www-form-urlencoded` body encoding. Confidential clients send
 * `client_secret` when `provider.clientSecret` is present.
 */
export async function exchangeAuthorizationCode(
  options: ExchangeAuthorizationCodeOptions,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', options.code);
  body.set('redirect_uri', options.provider.redirectUri);
  body.set('client_id', options.provider.clientId);
  body.set('code_verifier', options.codeVerifier);
  if (options.provider.clientSecret !== undefined)
    body.set('client_secret', options.provider.clientSecret);
  const res = await (options.fetch ?? fetch)(options.provider.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`OAuth token exchange failed with HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Options for refreshing a provider access token.
 */
export interface RefreshAccessTokenOptions {
  /** Provider configuration that supplies the token endpoint and client id. */
  provider: OAuthProvider;
  /** Refresh token previously issued by the provider. */
  refreshToken: string;
  /** Fetch implementation used to call the provider token endpoint. */
  fetch?: typeof fetch;
}

/**
 * Refresh an access token with a refresh token.
 *
 * The request uses the `refresh_token` grant and returns the provider's token
 * response as a plain record so provider-specific fields are preserved.
 */
export async function refreshAccessToken(
  options: RefreshAccessTokenOptions,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', options.refreshToken);
  body.set('client_id', options.provider.clientId);
  if (options.provider.clientSecret !== undefined)
    body.set('client_secret', options.provider.clientSecret);
  const res = await (options.fetch ?? fetch)(options.provider.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`OAuth token refresh failed with HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function setCookie(headers: Headers, value: string): void {
  (
    headers as Headers & { _appendTrusted?: (name: string, value: string) => void }
  )._appendTrusted?.('set-cookie', value) ?? headers.append('set-cookie', value);
}

/**
 * Options for `oauthLogin()`.
 */
export interface OAuthLoginOptions {
  /** Provider configuration for redirect URL construction. */
  provider: OAuthProvider;
  /** Cookie sealing secret used to protect state, nonce, and verifier data. */
  secret: BufferLike;
  /** Optional scopes requested from the provider. */
  scope?: string | readonly string[];
  /** Transaction cookie name. Defaults to `fino_oauth`. */
  cookie?: string;
  /** Additional attributes for the transaction cookie. */
  cookieOptions?: CookieOptions;
  /** Optional fixed state value, mostly useful for tests. */
  state?: string;
  /** Optional fixed OIDC nonce, mostly useful for tests. */
  nonce?: string;
  /** Optional fixed PKCE verifier, mostly useful for tests. */
  codeVerifier?: string;
  /** Transaction lifetime in seconds. Defaults to 600. */
  maxAgeSeconds?: number;
}

/**
 * Create a login handler that redirects to the provider authorization URL.
 *
 * The handler stores OAuth transaction state in a sealed HTTP-only cookie and
 * returns a `302` response with a `Location` header pointing at the provider.
 */
export function oauthLogin(options: OAuthLoginOptions) {
  const cookie = options.cookie ?? 'fino_oauth';
  return async function handleOAuthLogin(_req: Request): Promise<Response> {
    const pkce = await createPkce({ verifier: options.codeVerifier });
    const state = options.state ?? randomBase64Url(24);
    const nonce = options.nonce ?? randomBase64Url(24);
    const maxAge = options.maxAgeSeconds ?? 600;
    const url = authorizationUrl({
      authorizationEndpoint: options.provider.authorizationEndpoint,
      clientId: options.provider.clientId,
      redirectUri: options.provider.redirectUri,
      scope: options.scope,
      state,
      nonce,
      codeChallenge: pkce.challenge,
    });
    const sealed = sealCookie(
      JSON.stringify({
        state,
        nonce,
        codeVerifier: pkce.verifier,
        exp: Math.floor(Date.now() / 1000) + maxAge,
      }),
      options.secret,
    );
    const res = new Response(null, { status: 302, headers: { location: url.toString() } });
    setCookie(
      res.headers,
      serializeCookie(cookie, sealed, {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        maxAge,
        ...options.cookieOptions,
      }),
    );
    return res;
  };
}

/**
 * Result passed to an OAuth callback success hook.
 */
export interface OAuthCallbackResult {
  /** Token response returned by the provider. */
  tokens: Record<string, unknown>;
  /** Unsealed transaction state saved by `oauthLogin()`. */
  transaction: Record<string, unknown>;
}

/**
 * Options for `oauthCallback()`.
 */
export interface OAuthCallbackOptions {
  /** Provider configuration for token exchange. */
  provider: OAuthProvider;
  /** Cookie sealing secret used to unseal transaction data. */
  secret: BufferLike;
  /** Transaction cookie name. Defaults to `fino_oauth`. */
  cookie?: string;
  /** Additional attributes used when clearing the transaction cookie. */
  cookieOptions?: CookieOptions;
  /** Fetch implementation used to call the provider token endpoint. */
  fetch?: typeof fetch;
  /** Optional hook that builds the final response after token exchange. */
  onSuccess?: (result: OAuthCallbackResult) => Response | Promise<Response>;
}

/**
 * Create a callback handler that validates sealed state and exchanges code.
 *
 * The returned handler rejects missing parameters, state mismatches, expired
 * transactions, and malformed transaction cookies with `400` responses. On
 * success it clears the transaction cookie and returns either `onSuccess()`
 * or a JSON response containing the provider tokens.
 */
export function oauthCallback(options: OAuthCallbackOptions) {
  const cookie = options.cookie ?? 'fino_oauth';
  return async function handleOAuthCallback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (code === null || state === null)
      return new Response('Missing OAuth callback parameters', { status: 400 });
    const unsafeCookie =
      (req as Request & { _getUnsafeHeader?: (name: string) => string | null })._getUnsafeHeader?.(
        'cookie',
      ) ?? null;
    const cookies = parseCookieHeader(req.headers.get('cookie') ?? unsafeCookie ?? '');
    const raw = cookies[cookie];
    const unsealed = raw === undefined ? null : unsealCookie(raw, options.secret);
    if (unsealed === null) return new Response('Missing OAuth transaction', { status: 400 });
    const transaction = JSON.parse(unsealed) as Record<string, unknown>;
    if (transaction.state !== state) return new Response('Invalid OAuth state', { status: 400 });
    if (typeof transaction.exp === 'number' && Math.floor(Date.now() / 1000) > transaction.exp)
      return new Response('Expired OAuth transaction', { status: 400 });
    if (typeof transaction.codeVerifier !== 'string')
      return new Response('Invalid OAuth transaction', { status: 400 });
    const tokens = await exchangeAuthorizationCode({
      provider: options.provider,
      code,
      codeVerifier: transaction.codeVerifier,
      fetch: options.fetch,
    });
    const res = await (options.onSuccess?.({ tokens, transaction }) ?? Response.json({ tokens }));
    setCookie(
      res.headers,
      serializeCookie(cookie, '', {
        path: '/',
        ...options.cookieOptions,
        maxAge: 0,
        expires: new Date(0),
      }),
    );
    return res;
  };
}

/**
 * Verify an OIDC ID token using the existing JWT/JWKS verifier.
 *
 * The helper defaults `typ` to `JWT`/`jwt` and otherwise forwards options to
 * `jwtVerify()`, including issuer, audience, algorithm, and clock settings.
 */
export async function verifyIdToken(
  token: string,
  keys: JwtKeyInput,
  options: JwtVerifyOptions = {},
) {
  return await jwtVerify(token, keys, { typ: ['JWT', 'jwt'], ...options });
}

/**
 * Verify an HTTP `Authorization: Bearer <jwt>` header.
 *
 * Missing or non-bearer headers reject before JWT verification. The returned
 * value is the decoded verification result from `jwtVerify()`.
 */
export async function verifyBearerJwt(
  header: string | null,
  keys: JwtKeyInput,
  options: JwtVerifyOptions = {},
) {
  if (header === null || !/^Bearer /i.test(header))
    throw new Error('Expected Bearer authorization header');
  return await jwtVerify(header.slice(7).trim(), keys, options);
}

/**
 * App middleware that validates a JWT bearer token and stores it on `ctx.user`.
 *
 * The middleware returns `401 Unauthorized` when verification fails. On
 * success it writes the verified JWT result to `ctx.user` and calls `next()`.
 */
export function bearerAuth(keys: JwtKeyInput, options: JwtVerifyOptions = {}) {
  return async function bearerAuthMiddleware(
    ctx: { request: Request; user?: unknown },
    next: () => Promise<Response>,
  ): Promise<Response> {
    try {
      ctx.user = await verifyBearerJwt(ctx.request.headers.get('authorization'), keys, options);
    } catch {
      return new Response('Unauthorized', { status: 401 });
    }
    return await next();
  };
}
