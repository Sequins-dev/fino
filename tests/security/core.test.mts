import { describe, it } from 'fino:test/test';
import {
  buildCorsHeaders,
  createSecurityHeaders,
  hashPassword,
  parseCookieHeader,
  randomBase64Url,
  randomBytes,
  randomInt,
  randomToken,
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

  it('supports non-default PBKDF2 parameters and rejects invalid options', (t) => {
    const record = hashPassword('secret', {
      iterations: 1_000,
      hash: 'sha-512',
      saltLength: 24,
      keyLength: 48,
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
    const valid = hashPassword('secret', { iterations: 1_000 });
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

  it('rejects invalid token issue and verify options', (t) => {
    t.throws(() => issueDirectToken({ sub: 'user-123' }, 'token-secret', { expiresIn: Number.NaN }), /expiresIn must be a finite number/, 'NaN expiresIn is rejected');
    t.throws(() => issueDirectToken({ sub: 'user-123' }, 'token-secret', { expiresIn: Infinity }), /expiresIn must be a finite number/, 'infinite expiresIn is rejected');
    t.throws(() => issueDirectToken({ sub: 'user-123' }, 'token-secret', { purpose: 1 as any }), /purpose must be a string/, 'non-string issue purpose is rejected');

    const token = issueDirectToken({ sub: 'user-123' }, 'token-secret', { purpose: 'session', expiresIn: 60 });

    t.equal(verifyDirectToken(token, 'token-secret', { now: Number.NaN }), null, 'invalid verification time fails closed');
    t.equal(verifyDirectToken(token, 'token-secret', { clockTolerance: Number.NaN }), null, 'invalid clock tolerance fails closed');
    t.equal(verifyDirectToken(token, 'token-secret', { purpose: 1 as any }), null, 'non-string required purpose fails closed');
    t.equal(verifyDirectToken('abc.def', 'token-secret'), null, 'malformed signed payload fails closed');
  });
});

describe('fino:security encoding edge cases', () => {
  it('handles ArrayBufferView secrets with offsets through signed cookies', (t) => {
    const backing = new Uint8Array([9, 115, 101, 99, 114, 101, 116, 9]);
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
