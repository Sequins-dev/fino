import { describe, it } from 'fino:test/test';
import { buildCorsHeaders, createSecurityHeaders, hashPassword, parseCookieHeader, randomBase64Url, randomBytes, randomInt, randomToken, sealCookie, serializeCookie, signCookie, unsealCookie, verifyCookie, verifyPassword } from 'fino:security';
import { issueToken as issueDirectToken, verifyToken as verifyDirectToken } from 'fino:security/token';
describe('fino:security core helpers', () => {
  it('generates base64url tokens and bounded integers', (t) => {
    const token = randomBase64Url(32);
    t.equal(/^[A-Za-z0-9_-]+$/.test(token), true, 'token is base64url');
    t.equal(token.includes('='), false, 'token is unpadded');
    for (let i = 0; i < 20; i++) {
      const value = randomInt(10, 20);
      t.equal(value >= 10 && value < 20, true, 'randomInt stays within range');
    }
  });
  it('rejects invalid random helper bounds', (t) => {
    t.throws(() => randomBytes(-1), /length must be a non-negative integer/, 'negative random byte length is rejected');
    t.throws(() => randomBytes(1.5), /length must be a non-negative integer/, 'fractional random byte length is rejected');
    t.throws(() => randomToken(Number.NaN), /length must be a non-negative integer/, 'invalid token byte count is rejected');
    t.throws(() => randomInt(10, 10), /max must be greater than min/, 'empty integer range is rejected');
    t.throws(() => randomInt(0, 2 ** 32 + 1), /range must be <= 2\^32 - 1/, 'too-large integer range is rejected');
  });
  it('builds security and CORS headers', (t) => {
    const headers = createSecurityHeaders();
    t.equal(headers['x-content-type-options'], 'nosniff', 'default content type guard is present');
    t.equal(headers['x-frame-options'], 'DENY', 'default frame guard is present');
    const cors = buildCorsHeaders({
      origin: 'https://app.example',
      allowOrigins: ['https://app.example'],
      methods: ['GET', 'POST'],
      allowHeaders: ['content-type'],
      credentials: true,
      maxAge: 600
    });
    t.equal(cors['access-control-allow-origin'], 'https://app.example', 'matching origin is reflected');
    t.equal(cors['access-control-allow-credentials'], 'true', 'credentials header is emitted');
    t.equal(cors['access-control-max-age'], '600', 'max age is emitted');
  });
  it('handles CORS denied, wildcard credential, predicate, and invalid list cases', (t) => {
    const denied = buildCorsHeaders({
      origin: 'https://evil.example',
      allowOrigins: ['https://app.example']
    });
    t.equal(denied['access-control-allow-origin'], undefined, 'denied origin is not reflected');
    t.equal(denied.vary, 'Origin', 'denied origin still varies on Origin');
    const wildcardCredentials = buildCorsHeaders({
      origin: 'https://app.example',
      allowOrigins: '*',
      credentials: true
    });
    t.equal(wildcardCredentials['access-control-allow-origin'], 'https://app.example', 'wildcard with credentials reflects origin');
    t.equal(wildcardCredentials['access-control-allow-credentials'], 'true', 'credentials header is emitted');
    const predicate = buildCorsHeaders({
      origin: 'https://api.example',
      allowOrigins: (origin) => origin.endsWith('.example'),
      methods: [],
      allowHeaders: []
    });
    t.equal(predicate['access-control-allow-origin'], 'https://api.example', 'predicate origin is reflected');
    t.equal(predicate['access-control-allow-methods'], undefined, 'empty method list is omitted');
    t.equal(predicate['access-control-allow-headers'], undefined, 'empty header list is omitted');
    t.throws(() => buildCorsHeaders({
      origin: 'https://app.example',
      allowOrigins: '*',
      methods: ['GET\r\nX: yes']
    }), /Invalid CORS method/, 'invalid CORS method is rejected');
    t.throws(() => buildCorsHeaders({
      origin: 'https://app.example',
      allowOrigins: '*',
      allowHeaders: ['x-ok\nx-bad']
    }), /Invalid CORS header name/, 'invalid CORS header name is rejected');
    t.throws(() => buildCorsHeaders({
      origin: 'https://app.example\r\nX: yes',
      allowOrigins: '*'
    }), /Invalid CORS origin/, 'invalid CORS origin is rejected');
    t.throws(() => buildCorsHeaders({
      origin: 'https://app.example',
      allowOrigins: '*',
      exposeHeaders: ['x-ok\r\nx-bad']
    }), /Invalid CORS header name/, 'invalid CORS exposed header is rejected');
  });
  it('supports disabling and overriding security headers', (t) => {
    const headers = createSecurityHeaders({
      frameOptions: false,
      strictTransportSecurity: false,
      referrerPolicy: 'strict-origin',
      crossOriginOpenerPolicy: false,
      contentSecurityPolicy: 'default-src \'self\'',
      permissionsPolicy: 'geolocation=()',
      extra: {
        'X-Content-Type-Options': 'custom-nosniff',
        'X-App-Policy': 'enabled'
      }
    });
    t.equal(headers['x-frame-options'], undefined, 'frame options can be disabled');
    t.equal(headers['strict-transport-security'], undefined, 'HSTS can be disabled');
    t.equal(headers['cross-origin-opener-policy'], undefined, 'COOP can be disabled');
    t.equal(headers['referrer-policy'], 'strict-origin', 'referrer policy can be customized');
    t.equal(headers['content-security-policy'], 'default-src \'self\'', 'CSP can be supplied');
    t.equal(headers['permissions-policy'], 'geolocation=()', 'permissions policy can be supplied');
    t.equal(headers['x-content-type-options'], 'custom-nosniff', 'extra headers override defaults');
    t.equal(headers['x-app-policy'], 'enabled', 'extra header names are normalized');
  });
  it('rejects security header names and values that can inject headers', (t) => {
    t.throws(() => createSecurityHeaders({ extra: { 'X-Ok\r\nX-Bad': 'enabled' } }), /Invalid HTTP header name/, 'invalid extra header name is rejected');
    t.throws(() => createSecurityHeaders({ frameOptions: 'DENY\r\nX-Bad: yes' as any }), /Invalid HTTP header value/, 'invalid default header override value is rejected');
    t.throws(() => createSecurityHeaders({ extra: { 'x-ok': 'enabled\nX-Bad: yes' } }), /Invalid HTTP header value/, 'invalid extra header value is rejected');
  });
  it('serializes, parses, signs, and verifies cookies', (t) => {
    const header = serializeCookie('sid', 'abc 123', {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/'
    });
    t.equal(header.includes('sid=abc%20123'), true, 'cookie value is encoded');
    t.equal(header.includes('HttpOnly'), true, 'HttpOnly is serialized');
    t.deepEqual(parseCookieHeader('sid=abc%20123; theme=dark'), {
      sid: 'abc 123',
      theme: 'dark'
    }, 'cookie header parses');
    const signed = signCookie('abc', 'secret-key');
    t.equal(verifyCookie(signed, 'secret-key'), 'abc', 'signed cookie verifies');
    t.equal(verifyCookie(signed + 'tamper', 'secret-key'), null, 'tampered cookie is rejected');
  });
  it('rejects cookie attributes that can inject headers', (t) => {
    t.throws(() => serializeCookie('sid', 'abc', { domain: 'example.com\r\nSet-Cookie: injected=1' }), /Invalid cookie Domain attribute/, 'domain CRLF injection is rejected');
    t.throws(() => serializeCookie('sid', 'abc', { path: '/\nX-Injected: yes' }), /Invalid cookie Path attribute/, 'path CRLF injection is rejected');
    t.throws(() => serializeCookie('sid', 'abc', { sameSite: 'Lax\r\nX-Injected: yes' as any }), /Invalid cookie SameSite attribute/, 'sameSite CRLF injection is rejected');
  });
  it('rejects invalid cookie expiration and browser policy attributes', (t) => {
    t.throws(() => serializeCookie('sid', 'abc', { maxAge: Number.NaN }), /Invalid cookie Max-Age attribute/, 'NaN maxAge is rejected');
    t.throws(() => serializeCookie('sid', 'abc', { maxAge: Infinity }), /Invalid cookie Max-Age attribute/, 'infinite maxAge is rejected');
    t.throws(() => serializeCookie('sid', 'abc', { expires: new Date(Number.NaN) }), /Invalid cookie Expires attribute/, 'invalid expires date is rejected');
    t.throws(() => serializeCookie('sid', 'abc', { sameSite: 'None' }), /SameSite=None requires Secure/, 'SameSite=None without Secure is rejected');
    t.throws(() => serializeCookie('__Secure-sid', 'abc'), /__Secure- cookies require Secure/, '__Secure- prefix requires Secure');
    t.throws(() => serializeCookie('__Host-sid', 'abc', {
      secure: true,
      path: '/app'
    }), /__Host- cookies require Path=\//, '__Host- prefix requires root path');
    t.throws(() => serializeCookie('__Host-sid', 'abc', {
      secure: true,
      path: '/',
      domain: 'example.com'
    }), /__Host- cookies must not include Domain/, '__Host- prefix rejects Domain');
    const host = serializeCookie('__Host-sid', 'abc', {
      secure: true,
      path: '/'
    });
    t.equal(host, '__Host-sid=abc; Path=/; Secure', 'valid __Host- cookie serializes');
  });
  it('rejects invalid CORS maxAge values', (t) => {
    t.throws(() => buildCorsHeaders({
      origin: 'https://app.example',
      allowOrigins: '*',
      maxAge: Number.NaN
    }), /Invalid CORS maxAge/, 'NaN maxAge is rejected');
    t.throws(() => buildCorsHeaders({
      origin: 'https://app.example',
      allowOrigins: '*',
      maxAge: -1
    }), /Invalid CORS maxAge/, 'negative maxAge is rejected');
    const cors = buildCorsHeaders({
      origin: 'https://app.example',
      allowOrigins: '*',
      maxAge: 10.9
    });
    t.equal(cors['access-control-max-age'], '10', 'finite maxAge is floored before serialization');
  });
  it('seals cookies and rejects tampering', (t) => {
    const sealed = sealCookie('sensitive', '0123456789abcdef0123456789abcdef');
    t.equal(unsealCookie(sealed, '0123456789abcdef0123456789abcdef'), 'sensitive', 'sealed cookie round trips');
    t.equal(unsealCookie(sealed.slice(0, -1) + 'x', '0123456789abcdef0123456789abcdef'), null, 'tampered cookie fails');
  });
});
describe('fino:security password helpers', () => {
  it('hashes and verifies PBKDF2 password records', (t) => {
    const record = hashPassword('correct horse battery staple', { iterations: 1e3 });
    t.equal(record.startsWith('pbkdf2$sha-256$1000$'), true, 'record encodes algorithm parameters');
    t.equal(verifyPassword('correct horse battery staple', record), true, 'correct password verifies');
    t.equal(verifyPassword('wrong password', record), false, 'wrong password fails');
  });
  it('supports non-default PBKDF2 parameters and rejects invalid options', (t) => {
    const record = hashPassword('secret', {
      iterations: 1e3,
      hash: 'sha-512',
      saltLength: 24,
      keyLength: 48
    });
    const parts = record.split('$');
    t.equal(record.startsWith('pbkdf2$sha-512$1000$'), true, 'record stores non-default algorithm parameters');
    t.equal(parts[3]!.length, 32, '24 salt bytes encode to 32 base64url chars');
    t.equal(parts[4]!.length, 64, '48 key bytes encode to 64 base64url chars');
    t.equal(verifyPassword('secret', record), true, 'non-default password record verifies');
    t.throws(() => hashPassword('secret', { iterations: 0 }), /iterations must be a positive integer/, 'zero iterations are rejected');
    t.throws(() => hashPassword('secret', { saltLength: 0 }), /saltLength must be a positive integer/, 'zero salt length is rejected');
    t.throws(() => hashPassword('secret', { keyLength: 0 }), /keyLength must be a positive integer/, 'zero key length is rejected');
  });
  it('rejects malformed PBKDF2 password records', (t) => {
    const valid = hashPassword('secret', { iterations: 1e3 });
    const [kind, hash, iterations, salt, derived] = valid.split('$') as [string, string, string, string, string];
    t.equal(verifyPassword('secret', ''), false, 'empty record is rejected');
    t.equal(verifyPassword('secret', `argon2$${hash}$${iterations}$${salt}$${derived}`), false, 'wrong record kind is rejected');
    t.equal(verifyPassword('secret', `${kind}$sha-999$${iterations}$${salt}$${derived}`), false, 'unsupported hash is rejected');
    t.equal(verifyPassword('secret', `${kind}$${hash}$0$${salt}$${derived}`), false, 'invalid iteration count is rejected');
    t.equal(verifyPassword('secret', `${kind}$${hash}$${iterations}$not+base64$${derived}`), false, 'malformed salt is rejected');
    t.equal(verifyPassword('secret', `${kind}$${hash}$${iterations}$${salt}$not+base64`), false, 'malformed derived key is rejected');
  });
});
describe('fino:security token helpers', () => {
  it('issues and verifies purpose-bound opaque tokens', (t) => {
    const token = issueDirectToken({
      sub: 'user-123',
      role: 'admin'
    }, 'token-secret', {
      purpose: 'session',
      expiresIn: 60
    });
    const payload = verifyDirectToken(token, 'token-secret', { purpose: 'session' });
    t.ok(payload !== null, 'token verifies');
    t.equal(payload!.sub, 'user-123', 'payload data round trips');
    t.equal(payload!.role, 'admin', 'additional payload fields round trip');
    t.equal(payload!.purpose, 'session', 'purpose is embedded');
    t.equal(typeof payload!.exp, 'number', 'expiration is embedded');
  });
  it('rejects tampered, malformed, expired, and purpose-mismatched tokens', (t) => {
    const token = issueDirectToken({ sub: 'user-123' }, 'token-secret', {
      purpose: 'session',
      expiresIn: 60
    });
    const payload = verifyDirectToken(token, 'token-secret', { purpose: 'session' });
    const exp = payload!.exp as number;
    const [body, sig] = token.split('.');
    const tamperedBody = body!.slice(0, -1) + (body!.endsWith('A') ? 'B' : 'A');
    t.equal(verifyDirectToken(`${tamperedBody}.${sig}`, 'token-secret', { purpose: 'session' }), null, 'tampered payload fails');
    t.equal(verifyDirectToken(token, 'wrong-secret', { purpose: 'session' }), null, 'wrong secret fails');
    t.equal(verifyDirectToken('not.a.token', 'token-secret'), null, 'malformed token fails');
    t.equal(verifyDirectToken(token, 'token-secret', { purpose: 'password-reset' }), null, 'purpose mismatch fails');
    t.equal(verifyDirectToken(token, 'token-secret', {
      purpose: 'session',
      now: exp + 1
    }), null, 'expired token fails');
    t.ok(verifyDirectToken(token, 'token-secret', {
      purpose: 'session',
      now: exp + 1,
      clockTolerance: 5
    }) !== null, 'clock tolerance is honored');
  });
  it('rejects invalid token issue and verify options', (t) => {
    t.throws(() => issueDirectToken({ sub: 'user-123' }, 'token-secret', { expiresIn: Number.NaN }), /expiresIn must be a finite number/, 'NaN expiresIn is rejected');
    t.throws(() => issueDirectToken({ sub: 'user-123' }, 'token-secret', { expiresIn: Infinity }), /expiresIn must be a finite number/, 'infinite expiresIn is rejected');
    t.throws(() => issueDirectToken({ sub: 'user-123' }, 'token-secret', { purpose: 1 as any }), /purpose must be a string/, 'non-string issue purpose is rejected');
    const token = issueDirectToken({ sub: 'user-123' }, 'token-secret', {
      purpose: 'session',
      expiresIn: 60
    });
    t.equal(verifyDirectToken(token, 'token-secret', { now: Number.NaN }), null, 'invalid verification time fails closed');
    t.equal(verifyDirectToken(token, 'token-secret', { clockTolerance: Number.NaN }), null, 'invalid clock tolerance fails closed');
    t.equal(verifyDirectToken(token, 'token-secret', { purpose: 1 as any }), null, 'non-string required purpose fails closed');
    t.equal(verifyDirectToken('abc.def', 'token-secret'), null, 'malformed signed payload fails closed');
  });
});
describe('fino:security encoding edge cases', () => {
  it('handles ArrayBufferView secrets with offsets through signed cookies', (t) => {
    const backing = new Uint8Array([
      9,
      115,
      101,
      99,
      114,
      101,
      116,
      9
    ]);
    const secretView = backing.subarray(1, 7);
    const equivalent = new TextEncoder().encode('secret');
    const signed = signCookie('view-secret', secretView);
    t.equal(verifyCookie(signed, equivalent), 'view-secret', 'view byteOffset and byteLength are honored');
  });
  it('normalizes short secrets through sealed cookies', (t) => {
    const sealed = sealCookie('normalized', 'short secret');
    t.equal(unsealCookie(sealed, 'short secret'), 'normalized', 'short secret normalizes consistently');
    t.equal(unsealCookie(sealed, 'other secret'), null, 'different normalized secret fails authentication');
  });
  it('rejects malformed base64url payloads and timing-safe mismatches through verifiers', (t) => {
    const signed = signCookie('hello', 'secret');
    const [payload, sig] = signed.split('.');
    t.equal(verifyCookie(`${payload}=${sig}`, 'secret'), null, 'non-canonical padded payload is rejected');
    t.equal(verifyCookie(`${payload}.${sig!.slice(0, -1)}x`, 'secret'), null, 'signature mismatch is rejected');
  });
});
