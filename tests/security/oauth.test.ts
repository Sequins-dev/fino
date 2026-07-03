import { describe, it } from 'fino:test/test';
import { createPkce, authorizationUrl, oauthLogin, oauthCallback, verifyBearerJwt } from 'fino:security/oauth';
import { generateJwk } from 'fino:security/jwk';
import { jwtSign } from 'fino:security/jwt';

describe('fino:security/oauth', () => {
  it('creates PKCE material and authorization URLs', async (t) => {
    const pkce = await createPkce({ verifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~' });
    t.equal(pkce.method, 'S256');
    t.equal(pkce.challenge, 'ImpiCd8pp4MveCNnbIS7-GXEtB0xF5HMIDoWqvGA5ig');

    const url = authorizationUrl({
      authorizationEndpoint: 'https://issuer.example/authorize',
      clientId: 'client-1',
      redirectUri: 'https://app.example/callback',
      scope: ['openid', 'email'],
      state: 'state-1',
      nonce: 'nonce-1',
      codeChallenge: pkce.challenge
    });
    t.equal(url.searchParams.get('response_type'), 'code');
    t.equal(url.searchParams.get('client_id'), 'client-1');
    t.equal(url.searchParams.get('scope'), 'openid email');
    t.equal(url.searchParams.get('code_challenge_method'), 'S256');
  });

  it('stores OAuth transaction state in a sealed cookie and clears it on callback', async (t) => {
    const login = oauthLogin({
      provider: {
        authorizationEndpoint: 'https://issuer.example/authorize',
        tokenEndpoint: 'https://issuer.example/token',
        clientId: 'client-1',
        redirectUri: 'https://app.example/callback'
      },
      secret: '0123456789abcdef0123456789abcdef',
      state: 'state-1',
      nonce: 'nonce-1',
      codeVerifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'
    });
    const loginResponse = await login(new Request('https://app.example/login'));
    t.equal(loginResponse.status, 302);
    const cookie = loginResponse.headers.getSetCookie().find((value) => value.startsWith('fino_oauth='));
    t.ok(cookie !== undefined, 'transaction cookie is set');

    const callback = oauthCallback({
      provider: {
        authorizationEndpoint: 'https://issuer.example/authorize',
        tokenEndpoint: 'https://issuer.example/token',
        clientId: 'client-1',
        redirectUri: 'https://app.example/callback'
      },
      secret: '0123456789abcdef0123456789abcdef',
      fetch: async (_url, init) => {
        t.equal(init?.method, 'POST');
        const body = new URLSearchParams(String(init?.body));
        t.equal(body.get('grant_type'), 'authorization_code');
        t.equal(body.get('code'), 'code-1');
        t.equal(body.get('code_verifier'), 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~');
        return Response.json({ access_token: 'access-1', token_type: 'Bearer' });
      },
      onSuccess: (result) => Response.json({ accessToken: result.tokens.access_token })
    });
    const callbackResponse = await callback(new Request('https://app.example/callback?code=code-1&state=state-1', {
      headers: { cookie: cookie!.split(';')[0]! }
    }));
    t.deepEqual(await callbackResponse.json(), { accessToken: 'access-1' });
    t.ok(callbackResponse.headers.getSetCookie().some((value) => value.startsWith('fino_oauth=') && value.includes('Max-Age=0')), 'transaction cookie is cleared');
  });

  it('verifies bearer JWTs', async (t) => {
    const key = await generateJwk({ kty: 'oct', alg: 'HS256', kid: 'k1' });
    const token = await jwtSign({ sub: 'user-1', aud: 'api', iss: 'https://issuer.example' }, key, {
      algorithm: 'HS256',
      header: { kid: 'k1' },
      expiresIn: 60
    });
    const result = await verifyBearerJwt(`Bearer ${token}`, key, {
      issuer: 'https://issuer.example',
      audience: 'api'
    });
    t.equal(result.payload.sub, 'user-1');
    await t.rejects(() => verifyBearerJwt('Basic nope', key), /Bearer/);
  });
});
