import { describe, it } from 'fino:test/test';
import {
  buildCorsHeaders,
  createSecurityHeaders,
  hashPassword,
  parseCookieHeader,
  randomBase64Url,
  randomInt,
  sealCookie,
  serializeCookie,
  signCookie,
  unsealCookie,
  verifyCookie,
  verifyPassword,
} from 'fino:security';
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
      maxAge: 600,
    });

    t.equal(cors['access-control-allow-origin'], 'https://app.example', 'matching origin is reflected');
    t.equal(cors['access-control-allow-credentials'], 'true', 'credentials header is emitted');
    t.equal(cors['access-control-max-age'], '600', 'max age is emitted');
  });

  it('serializes, parses, signs, and verifies cookies', (t) => {
    const header = serializeCookie('sid', 'abc 123', {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
    });

    t.equal(header.includes('sid=abc%20123'), true, 'cookie value is encoded');
    t.equal(header.includes('HttpOnly'), true, 'HttpOnly is serialized');
    t.deepEqual(parseCookieHeader('sid=abc%20123; theme=dark'), { sid: 'abc 123', theme: 'dark' }, 'cookie header parses');

    const signed = signCookie('abc', 'secret-key');
    t.equal(verifyCookie(signed, 'secret-key'), 'abc', 'signed cookie verifies');
    t.equal(verifyCookie(signed + 'tamper', 'secret-key'), null, 'tampered cookie is rejected');
  });

  it('seals cookies and rejects tampering', (t) => {
    const sealed = sealCookie('sensitive', '0123456789abcdef0123456789abcdef');

    t.equal(unsealCookie(sealed, '0123456789abcdef0123456789abcdef'), 'sensitive', 'sealed cookie round trips');
    t.equal(unsealCookie(sealed.slice(0, -1) + 'x', '0123456789abcdef0123456789abcdef'), null, 'tampered cookie fails');
  });
});

describe('fino:security password helpers', () => {
  it('hashes and verifies PBKDF2 password records', (t) => {
    const record = hashPassword('correct horse battery staple', { iterations: 1_000 });

    t.equal(record.startsWith('pbkdf2$sha-256$1000$'), true, 'record encodes algorithm parameters');
    t.equal(verifyPassword('correct horse battery staple', record), true, 'correct password verifies');
    t.equal(verifyPassword('wrong password', record), false, 'wrong password fails');
  });
});

describe('fino:security token helpers', () => {
  it('issues and verifies purpose-bound opaque tokens', (t) => {
    const token = issueDirectToken({ sub: 'user-123', role: 'admin' }, 'token-secret', {
      purpose: 'session',
      expiresIn: 60,
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
      expiresIn: 60,
    });
    const payload = verifyDirectToken(token, 'token-secret', { purpose: 'session' });
    const exp = payload!.exp as number;
    const [body, sig] = token.split('.');
    const tamperedBody = body!.slice(0, -1) + (body!.endsWith('A') ? 'B' : 'A');

    t.equal(verifyDirectToken(`${tamperedBody}.${sig}`, 'token-secret', { purpose: 'session' }), null, 'tampered payload fails');
    t.equal(verifyDirectToken(token, 'wrong-secret', { purpose: 'session' }), null, 'wrong secret fails');
    t.equal(verifyDirectToken('not.a.token', 'token-secret'), null, 'malformed token fails');
    t.equal(verifyDirectToken(token, 'token-secret', { purpose: 'password-reset' }), null, 'purpose mismatch fails');
    t.equal(verifyDirectToken(token, 'token-secret', { purpose: 'session', now: exp + 1 }), null, 'expired token fails');
    t.ok(verifyDirectToken(token, 'token-secret', { purpose: 'session', now: exp + 1, clockTolerance: 5 }) !== null, 'clock tolerance is honored');
  });
});
