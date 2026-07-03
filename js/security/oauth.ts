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
import { sealCookie, unsealCookie, serializeCookie, parseCookieHeader, type CookieOptions } from './cookie.ts';
import { randomBase64Url } from './random.ts';
import { jwtVerify, type JwtKeyInput, type JwtVerifyOptions } from './jwt.ts';
import { sha256Base64url } from '../internal/security/encoding.ts';

export interface OAuthProvider {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

/** Provider metadata returned by OAuth/OIDC discovery endpoints. */
export type OAuthMetadata = Record<string, unknown> & {
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  issuer?: string;
};

/** Fetch RFC 8414 OAuth authorization-server metadata for an issuer URL. */
export async function discoverOAuthMetadata(issuer: string | URL, options: { fetch?: typeof fetch } = {}): Promise<OAuthMetadata> {
  const url = new URL('/.well-known/oauth-authorization-server', issuer);
  const res = await (options.fetch ?? fetch)(url);
  if (!res.ok) throw new Error(`OAuth metadata discovery failed with HTTP ${res.status}`);
  return await res.json() as OAuthMetadata;
}

/** Fetch OpenID Provider metadata for an issuer URL. */
export async function discoverOpenIdProvider(issuer: string | URL, options: { fetch?: typeof fetch } = {}): Promise<OAuthMetadata> {
  const url = new URL('/.well-known/openid-configuration', issuer);
  const res = await (options.fetch ?? fetch)(url);
  if (!res.ok) throw new Error(`OIDC discovery failed with HTTP ${res.status}`);
  return await res.json() as OAuthMetadata;
}

export interface PkceMaterial {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** Create RFC 7636 S256 PKCE verifier and challenge material. */
export async function createPkce(options: { verifier?: string } = {}): Promise<PkceMaterial> {
  const verifier = options.verifier ?? randomBase64Url(32);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error('Invalid PKCE verifier');
  return { verifier, challenge: sha256Base64url(verifier), method: 'S256' };
}

/** Build an OAuth authorization-code redirect URL with PKCE parameters. */
export function authorizationUrl(options: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope?: string | readonly string[];
  state: string;
  nonce?: string;
  codeChallenge: string;
}): URL {
  const url = new URL(options.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  if (options.scope !== undefined) url.searchParams.set('scope', Array.isArray(options.scope) ? options.scope.join(' ') : options.scope);
  url.searchParams.set('state', options.state);
  if (options.nonce !== undefined) url.searchParams.set('nonce', options.nonce);
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url;
}

/** Exchange an authorization code for provider tokens. */
export async function exchangeAuthorizationCode(options: {
  provider: OAuthProvider;
  code: string;
  codeVerifier: string;
  fetch?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', options.code);
  body.set('redirect_uri', options.provider.redirectUri);
  body.set('client_id', options.provider.clientId);
  body.set('code_verifier', options.codeVerifier);
  if (options.provider.clientSecret !== undefined) body.set('client_secret', options.provider.clientSecret);
  const res = await (options.fetch ?? fetch)(options.provider.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!res.ok) throw new Error(`OAuth token exchange failed with HTTP ${res.status}`);
  return await res.json() as Record<string, unknown>;
}

/** Refresh an access token with a refresh token. */
export async function refreshAccessToken(options: {
  provider: OAuthProvider;
  refreshToken: string;
  fetch?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', options.refreshToken);
  body.set('client_id', options.provider.clientId);
  if (options.provider.clientSecret !== undefined) body.set('client_secret', options.provider.clientSecret);
  const res = await (options.fetch ?? fetch)(options.provider.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!res.ok) throw new Error(`OAuth token refresh failed with HTTP ${res.status}`);
  return await res.json() as Record<string, unknown>;
}

function setCookie(headers: Headers, value: string): void {
  (headers as Headers & { _appendTrusted?: (name: string, value: string) => void })._appendTrusted?.('set-cookie', value) ?? headers.append('set-cookie', value);
}

export function oauthLogin(options: {
  provider: OAuthProvider;
  secret: string | Uint8Array | ArrayBuffer;
  scope?: string | readonly string[];
  cookie?: string;
  cookieOptions?: CookieOptions;
  state?: string;
  nonce?: string;
  codeVerifier?: string;
  maxAgeSeconds?: number;
}) {
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
      codeChallenge: pkce.challenge
    });
    const sealed = sealCookie(JSON.stringify({ state, nonce, codeVerifier: pkce.verifier, exp: Math.floor(Date.now() / 1000) + maxAge }), options.secret);
    const res = new Response(null, { status: 302, headers: { location: url.toString() } });
    setCookie(res.headers, serializeCookie(cookie, sealed, { path: '/', httpOnly: true, sameSite: 'Lax', maxAge, ...options.cookieOptions }));
    return res;
  };
}

/** Create a callback handler that validates sealed state and exchanges code. */
export function oauthCallback(options: {
  provider: OAuthProvider;
  secret: string | Uint8Array | ArrayBuffer;
  cookie?: string;
  cookieOptions?: CookieOptions;
  fetch?: typeof fetch;
  onSuccess?: (result: { tokens: Record<string, unknown>; transaction: Record<string, unknown> }) => Response | Promise<Response>;
}) {
  const cookie = options.cookie ?? 'fino_oauth';
  return async function handleOAuthCallback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (code === null || state === null) return new Response('Missing OAuth callback parameters', { status: 400 });
    const unsafeCookie = (req as Request & { _getUnsafeHeader?: (name: string) => string | null })._getUnsafeHeader?.('cookie') ?? null;
    const cookies = parseCookieHeader(req.headers.get('cookie') ?? unsafeCookie ?? '');
    const raw = cookies[cookie];
    const unsealed = raw === undefined ? null : unsealCookie(raw, options.secret);
    if (unsealed === null) return new Response('Missing OAuth transaction', { status: 400 });
    const transaction = JSON.parse(unsealed) as Record<string, unknown>;
    if (transaction.state !== state) return new Response('Invalid OAuth state', { status: 400 });
    if (typeof transaction.exp === 'number' && Math.floor(Date.now() / 1000) > transaction.exp) return new Response('Expired OAuth transaction', { status: 400 });
    if (typeof transaction.codeVerifier !== 'string') return new Response('Invalid OAuth transaction', { status: 400 });
    const tokens = await exchangeAuthorizationCode({ provider: options.provider, code, codeVerifier: transaction.codeVerifier, fetch: options.fetch });
    const res = await (options.onSuccess?.({ tokens, transaction }) ?? Response.json({ tokens }));
    setCookie(res.headers, serializeCookie(cookie, '', { path: '/', ...options.cookieOptions, maxAge: 0, expires: new Date(0) }));
    return res;
  };
}

/** Verify an OIDC ID token using the existing JWT/JWKS verifier. */
export async function verifyIdToken(token: string, keys: JwtKeyInput, options: JwtVerifyOptions = {}) {
  return await jwtVerify(token, keys, { typ: ['JWT', 'jwt'], ...options });
}

/** Verify an HTTP `Authorization: Bearer <jwt>` header. */
export async function verifyBearerJwt(header: string | null, keys: JwtKeyInput, options: JwtVerifyOptions = {}) {
  if (header === null || !/^Bearer /i.test(header)) throw new Error('Expected Bearer authorization header');
  return await jwtVerify(header.slice(7).trim(), keys, options);
}

/** App middleware that validates a JWT bearer token and stores it on `ctx.user`. */
export function bearerAuth(keys: JwtKeyInput, options: JwtVerifyOptions = {}) {
  return async function bearerAuthMiddleware(ctx: { request: Request; user?: unknown }, next: () => Promise<Response>): Promise<Response> {
    try {
      ctx.user = await verifyBearerJwt(ctx.request.headers.get('authorization'), keys, options);
    } catch {
      return new Response('Unauthorized', { status: 401 });
    }
    return await next();
  };
}
