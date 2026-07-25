import { describe, it } from 'fino:test/test';
import {
  exportPublicJwk,
  generateJwk,
  importJwk,
  jwkFromSecret,
  jwkThumbprint,
  jwtDecrypt,
  jwtEncrypt,
  jwtSign,
  jwtVerify,
  selectJwk,
} from 'fino:security';
const cryptoAvailable = (
  globalThis as typeof globalThis & {
    cryptoAvailable?: boolean;
  }
).cryptoAvailable;
describe('fino:security JWK helpers', () => {
  it('selects JWKs permissively when optional metadata is omitted', (t) => {
    const generic = {
      kty: 'oct',
      k: 'c2VjcmV0',
      kid: 'generic',
    };
    const restricted = {
      kty: 'oct',
      k: 'c2VjcmV0',
      kid: 'restricted',
      alg: 'HS384',
      use: 'enc',
      key_ops: ['encrypt'],
    };
    const keyWithoutAlg = {
      kty: 'oct',
      k: 'c2VjcmV0',
      kid: 'no-alg',
      use: 'sig',
      key_ops: ['verify'],
    };
    const keyWithoutUse = {
      kty: 'oct',
      k: 'c2VjcmV0',
      kid: 'no-use',
      alg: 'HS256',
      key_ops: ['verify'],
    };
    const keyWithoutOps = {
      kty: 'oct',
      k: 'c2VjcmV0',
      kid: 'no-ops',
      alg: 'HS256',
      use: 'sig',
    };
    t.equal(
      selectJwk([generic], {
        alg: 'HS256',
        use: 'sig',
        key_ops: ['verify'],
      })?.kid,
      'generic',
      'missing alg, use, and key_ops are permissive',
    );
    t.equal(
      selectJwk([restricted, keyWithoutAlg], {
        alg: 'HS256',
        use: 'sig',
        key_ops: ['verify'],
      })?.kid,
      'no-alg',
      'missing alg can match when other declared metadata matches',
    );
    t.equal(
      selectJwk([restricted, keyWithoutUse], {
        alg: 'HS256',
        use: 'sig',
        key_ops: ['verify'],
      })?.kid,
      'no-use',
      'missing use can match when other declared metadata matches',
    );
    t.equal(
      selectJwk([restricted, keyWithoutOps], {
        alg: 'HS256',
        use: 'sig',
        key_ops: ['verify'],
      })?.kid,
      'no-ops',
      'missing key_ops can match when other declared metadata matches',
    );
    t.equal(
      selectJwk([restricted], {
        alg: 'HS256',
        use: 'sig',
        key_ops: ['verify'],
      }),
      undefined,
      'declared incompatible alg, use, and key_ops do not match',
    );
  });
  it('generates, imports, exports, selects, and thumbprints keys', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping JWK crypto test');
      return;
    }
    const key = await generateJwk({
      kty: 'oct',
      alg: 'HS256',
      kid: 'sig-1',
      length: 256,
    });
    const imported = await importJwk(key, ['sign', 'verify']);
    const publicJwk = await exportPublicJwk(key);
    const thumbprint = await jwkThumbprint(key);
    t.equal(imported.type, 'secret', 'symmetric JWK imports as secret key');
    t.equal(publicJwk.k, undefined, 'public export strips symmetric key material');
    t.equal(typeof thumbprint, 'string', 'thumbprint is a string');
    t.equal(
      selectJwk(
        { keys: [key] },
        {
          kid: 'sig-1',
          alg: 'HS256',
        },
      )?.kid,
      'sig-1',
      'JWKS lookup selects matching key',
    );
  });
  it('computes RFC 7638 thumbprints from required public members only', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping JWK thumbprint vector test');
      return;
    }
    const rsaPublic = {
      kty: 'RSA',
      n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
      e: 'AQAB',
      alg: 'RS256',
      kid: 'ignored',
      use: 'sig',
    };
    t.equal(
      await jwkThumbprint(rsaPublic),
      'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs',
      'RFC 7638 RSA example thumbprint matches',
    );
    const withPrivateFields = {
      ...rsaPublic,
      d: 'private',
      p: 'private',
      q: 'private',
      key_ops: ['verify'],
    };
    t.equal(
      await jwkThumbprint(withPrivateFields),
      await jwkThumbprint(rsaPublic),
      'private fields and metadata do not affect thumbprint',
    );
    await t.rejects(
      () =>
        jwkThumbprint({
          kty: 'RSA',
          n: rsaPublic.n,
        }),
      /missing/i,
    );
  });
});
describe('fino:security JWT/JWE helpers', () => {
  it('signs and verifies HS256 JWTs with claim checks', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping JWT crypto test');
      return;
    }
    const key = await generateJwk({
      kty: 'oct',
      alg: 'HS256',
      kid: 'jwt-1',
      length: 256,
    });
    const token = await jwtSign(
      {
        sub: 'user-1',
        aud: 'api',
        iss: 'issuer',
      },
      key,
      {
        algorithm: 'HS256',
        expiresIn: 60,
        header: { kid: 'jwt-1' },
      },
    );
    const verified = await jwtVerify(
      token,
      { keys: [key] },
      {
        audience: 'api',
        issuer: 'issuer',
      },
    );
    t.equal(verified.payload.sub, 'user-1', 'subject is preserved');
    t.equal(verified.header.alg, 'HS256', 'header algorithm is preserved');
    await t.rejects(
      () => jwtVerify(token + 'tamper', { keys: [key] }),
      (err) =>
        err instanceof Error &&
        (err.message.includes('JWT signature verification failed') ||
          err.message.includes('Invalid compact JWT') ||
          err.message.includes('Invalid base64url string')),
      'tampered JWT is rejected',
    );
  });
  it('encrypts and decrypts compact JWE tokens', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping JWE crypto test');
      return;
    }
    const key = await generateJwk({
      kty: 'oct',
      alg: 'dir',
      kid: 'enc-1',
      length: 256,
    });
    const token = await jwtEncrypt(
      {
        sub: 'user-1',
        scope: 'read',
      },
      key,
      {
        algorithm: 'dir',
        encryption: 'A256GCM',
        header: { kid: 'enc-1' },
      },
    );
    const decrypted = await jwtDecrypt(token, { keys: [key] });
    t.equal(decrypted.payload.sub, 'user-1', 'JWE payload round trips');
    t.equal(decrypted.header.enc, 'A256GCM', 'JWE encryption is preserved');
    await t.rejects(
      () => jwtDecrypt(token.slice(0, -1) + 'x', { keys: [key] }),
      (err) =>
        err instanceof Error &&
        (err.message.includes('JWE decryption failed') ||
          err.message.includes('Invalid compact JWE')),
      'tampered JWE is rejected',
    );
  });
  it('encrypts and decrypts RSA-OAEP compact JWE tokens', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping RSA-OAEP JWE crypto test');
      return;
    }
    const key = await generateJwk({
      kty: 'RSA',
      alg: 'RSA-OAEP-256',
      kid: 'enc-rsa-1',
      modulusLength: 2048,
    });
    const token = await jwtEncrypt({ sub: 'user-2' }, key, {
      algorithm: 'RSA-OAEP-256',
      encryption: 'A256GCM',
      header: { kid: 'enc-rsa-1' },
    });
    const decrypted = await jwtDecrypt(token, { keys: [key] });
    t.equal(decrypted.payload.sub, 'user-2', 'RSA-OAEP JWE payload round trips');
    t.equal(decrypted.header.alg, 'RSA-OAEP-256', 'RSA-OAEP algorithm is preserved');
  });
  it('signs and verifies RSA, PSS, and ECDSA JWTs', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping asymmetric JWT crypto test');
      return;
    }
    const cases = [
      await generateJwk({
        kty: 'RSA',
        alg: 'RS256',
        kid: 'rs-1',
        modulusLength: 2048,
      }),
      await generateJwk({
        kty: 'RSA',
        alg: 'PS256',
        kid: 'ps-1',
        modulusLength: 2048,
      }),
      await generateJwk({
        kty: 'EC',
        alg: 'ES256',
        kid: 'es-1',
        namedCurve: 'P-256',
      }),
    ];
    for (const key of cases) {
      const algorithm = key.alg as 'RS256' | 'PS256' | 'ES256';
      const token = await jwtSign({ sub: algorithm }, key, {
        algorithm,
        header: { kid: key.kid },
      });
      const verified = await jwtVerify(token, { keys: [key] });
      t.equal(verified.payload.sub, algorithm, `${algorithm} round trips`);
    }
  });
  it('accepts raw ECDSA signatures beginning with the DER sequence byte', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping ECDSA signature encoding test');
      return;
    }
    const key = await generateJwk({
      kty: 'EC',
      alg: 'ES256',
      kid: 'raw-es-1',
      namedCurve: 'P-256',
    });
    const rawSignature = new Uint8Array(64);
    rawSignature[0] = 0x30;
    const sign = crypto.subtle.sign;
    try {
      crypto.subtle.sign = async () => rawSignature.buffer;
      const token = await jwtSign({ sub: 'ES256' }, key, {
        algorithm: 'ES256',
      });
      t.equal(token.split('.')[2]!.length, 86, '64-byte raw signature is encoded unchanged');
    } finally {
      crypto.subtle.sign = sign;
    }
  });
  it('validates JWT audience arrays, nbf, iat, and clock tolerance', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping JWT claim edge test');
      return;
    }
    const key = await generateJwk({
      kty: 'oct',
      alg: 'HS256',
      kid: 'claims-1',
      length: 256,
    });
    const token = await jwtSign(
      {
        sub: 'user-1',
        aud: ['api', 'admin'],
        exp: 1700000010,
        nbf: 1700000005,
      },
      key,
      {
        algorithm: 'HS256',
        issuedAt: 17e8,
        header: { kid: 'claims-1' },
      },
    );
    const verified = await jwtVerify(
      token,
      { keys: [key] },
      {
        audience: 'admin',
        now: 1700000005,
      },
    );
    t.equal(verified.payload.iat, 17e8, 'explicit iat is preserved');
    t.deepEqual(verified.payload.aud, ['api', 'admin'], 'audience array is preserved');
    await t.rejects(
      () =>
        jwtVerify(token, key, {
          audience: 'other',
          now: 1700000005,
        }),
      /audience/,
    );
    await t.rejects(() => jwtVerify(token, key, { now: 1700000004 }), /not active/);
    await jwtVerify(token, key, {
      now: 1700000004,
      clockTolerance: 1,
    });
    await t.rejects(() => jwtVerify(token, key, { now: 1700000011 }), /expired/);
  });
  it('validates JWT algorithm allowlists, required claims, typ, jti, and max age', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping JWT verification controls test');
      return;
    }
    const key = await generateJwk({
      kty: 'oct',
      alg: 'HS256',
      kid: 'controls-1',
      length: 256,
    });
    const token = await jwtSign(
      {
        sub: 'user-1',
        iss: 'issuer',
        jti: 'token-1',
      },
      key,
      {
        algorithm: 'HS256',
        issuedAt: 17e8,
        header: {
          kid: 'controls-1',
          typ: 'JWT',
        },
      },
    );
    const verified = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      requiredClaims: ['sub', 'iss', 'jti'],
      typ: 'JWT',
      jwtId: 'token-1',
      maxTokenAge: 60,
      now: 1700000030,
    });
    t.equal(verified.payload.sub, 'user-1', 'token verifies with all release controls');
    await t.rejects(() => jwtVerify(token, key, { algorithms: ['HS384'] }), /algorithm/i);
    await t.rejects(() => jwtVerify(token, key, { requiredClaims: ['aud'] }), /required claim/i);
    await t.rejects(() => jwtVerify(token, key, { typ: 'at+jwt' }), /typ/i);
    await t.rejects(() => jwtVerify(token, key, { jwtId: 'other' }), /jti/i);
    await t.rejects(
      () =>
        jwtVerify(token, key, {
          maxTokenAge: 10,
          now: 1700000011,
        }),
      /too old/i,
    );
  });
  it('selects JWT keys by kid and alg and rejects unsupported crit headers', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping JWT key selection test');
      return;
    }
    const wrong = await generateJwk({
      kty: 'oct',
      alg: 'HS256',
      kid: 'wrong',
      length: 256,
    });
    const right = await generateJwk({
      kty: 'oct',
      alg: 'HS256',
      kid: 'right',
      length: 256,
    });
    const token = await jwtSign({ sub: 'selected' }, right, {
      algorithm: 'HS256',
      issuedAt: false,
      header: { kid: 'right' },
    });
    const verified = await jwtVerify(token, { keys: [wrong, right] });
    t.equal(verified.payload.sub, 'selected', 'JWKS selection uses matching kid');
    await t.rejects(() => jwtVerify(token, { keys: [wrong] }), /No matching JWK/);
    const critToken = await jwtSign({ sub: 'crit' }, right, {
      algorithm: 'HS256',
      issuedAt: false,
      header: {
        kid: 'right',
        crit: ['exp'],
      },
    });
    await t.rejects(() => jwtVerify(critToken, { keys: [right] }), /crit/i);
  });
  it('rejects JWT algorithm confusion and wrong key intent', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping JWT confusion test');
      return;
    }
    const hmac = await generateJwk({
      kty: 'oct',
      alg: 'HS256',
      kid: 'hmac',
      length: 256,
    });
    const rsa = await generateJwk({
      kty: 'RSA',
      alg: 'RS256',
      kid: 'rsa',
      modulusLength: 2048,
    });
    const hmacToken = await jwtSign({ sub: 'hmac' }, hmac, {
      algorithm: 'HS256',
      issuedAt: false,
      header: { kid: 'hmac' },
    });
    const rsaToken = await jwtSign({ sub: 'rsa' }, rsa, {
      algorithm: 'RS256',
      issuedAt: false,
      header: { kid: 'rsa' },
    });
    await t.rejects(
      () => jwtVerify(hmacToken, rsa),
      /key|algorithm|JWK|signature/i,
      'HS token cannot verify with RSA key',
    );
    await t.rejects(
      () => jwtVerify(rsaToken, hmac),
      /key|algorithm|JWK|signature/i,
      'RS token cannot verify with oct key',
    );
    const encUse = {
      ...hmac,
      kid: 'hmac',
      use: 'enc',
    };
    const encryptOnly = {
      ...hmac,
      kid: 'hmac',
      key_ops: ['encrypt'],
    };
    await t.rejects(
      () => jwtVerify(hmacToken, { keys: [encUse] }),
      /No matching JWK|key/i,
      'enc use key is not selected for signature verification',
    );
    await t.rejects(
      () => jwtVerify(hmacToken, { keys: [encryptOnly] }),
      /No matching JWK|key/i,
      'encrypt-only key_ops are not selected for verification',
    );
  });
  it('rejects unsupported JWT algorithms and signs deterministic HS256 tokens', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping JWT algorithm rejection test');
      return;
    }
    const key = jwkFromSecret('release-audit-secret', 'HS256', 'deterministic');
    const first = await jwtSign(
      {
        iss: 'issuer',
        sub: 'subject',
      },
      key,
      {
        algorithm: 'HS256',
        issuedAt: false,
        header: { kid: 'deterministic' },
      },
    );
    const second = await jwtSign(
      {
        iss: 'issuer',
        sub: 'subject',
      },
      key,
      {
        algorithm: 'HS256',
        issuedAt: false,
        header: { kid: 'deterministic' },
      },
    );
    t.equal(first, second, 'fixed HS256 inputs produce a deterministic compact token');
    t.equal(
      (
        await jwtVerify(first, key, {
          issuer: 'issuer',
          subject: 'subject',
        })
      ).payload.sub,
      'subject',
    );
    const parts = first.split('.');
    const noneToken = [parts[0], parts[1], ''].join('.');
    await t.rejects(
      () => jwtVerify(noneToken.replace(parts[0]!, 'eyJhbGciOiJub25lIn0'), key),
      /Unsupported JWT algorithm/,
    );
  });
  it('rejects unsupported crit headers in compact JWE', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping JWE crit test');
      return;
    }
    const key = await generateJwk({
      kty: 'oct',
      alg: 'dir',
      kid: 'enc-crit',
      length: 256,
    });
    const token = await jwtEncrypt({ sub: 'user-1' }, key, {
      algorithm: 'dir',
      encryption: 'A256GCM',
      header: {
        kid: 'enc-crit',
        crit: ['zip'],
      },
    });
    await t.rejects(() => jwtDecrypt(token, { keys: [key] }), /crit/i);
  });
});
