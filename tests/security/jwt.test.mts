import { describe, it } from 'fino:test/test';
import {
  exportPublicJwk,
  generateJwk,
  importJwk,
  jwkThumbprint,
  jwtDecrypt,
  jwtEncrypt,
  jwtSign,
  jwtVerify,
  selectJwk,
} from 'fino:security';

const cryptoAvailable = (globalThis as typeof globalThis & { cryptoAvailable?: boolean }).cryptoAvailable;

describe('fino:security JWK helpers', () => {
  it('generates, imports, exports, selects, and thumbprints keys', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping JWK crypto test');
      return;
    }

    const key = await generateJwk({ kty: 'oct', alg: 'HS256', kid: 'sig-1', length: 256 });
    const imported = await importJwk(key, ['sign', 'verify']);
    const publicJwk = await exportPublicJwk(key);
    const thumbprint = await jwkThumbprint(publicJwk);

    t.equal(imported.type, 'secret', 'symmetric JWK imports as secret key');
    t.equal(publicJwk.k, undefined, 'public export strips symmetric key material');
    t.equal(typeof thumbprint, 'string', 'thumbprint is a string');
    t.equal(selectJwk({ keys: [key] }, { kid: 'sig-1', alg: 'HS256' })?.kid, 'sig-1', 'JWKS lookup selects matching key');
  });
});

describe('fino:security JWT/JWE helpers', () => {
  it('signs and verifies HS256 JWTs with claim checks', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping JWT crypto test');
      return;
    }

    const key = await generateJwk({ kty: 'oct', alg: 'HS256', kid: 'jwt-1', length: 256 });
    const token = await jwtSign({ sub: 'user-1', aud: 'api', iss: 'issuer' }, key, {
      algorithm: 'HS256',
      expiresIn: 60,
      header: { kid: 'jwt-1' },
    });

    const verified = await jwtVerify(token, { keys: [key] }, {
      audience: 'api',
      issuer: 'issuer',
    });

    t.equal(verified.payload.sub, 'user-1', 'subject is preserved');
    t.equal(verified.header.alg, 'HS256', 'header algorithm is preserved');

    await t.rejects(
      () => jwtVerify(token + 'tamper', { keys: [key] }),
      (err) => err instanceof Error
        && (
          err.message.includes('JWT signature verification failed')
          || err.message.includes('Invalid compact JWT')
          || err.message.includes('Invalid base64url string')
        ),
      'tampered JWT is rejected',
    );
  });

  it('encrypts and decrypts compact JWE tokens', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping JWE crypto test');
      return;
    }

    const key = await generateJwk({ kty: 'oct', alg: 'dir', kid: 'enc-1', length: 256 });
    const token = await jwtEncrypt({ sub: 'user-1', scope: 'read' }, key, {
      algorithm: 'dir',
      encryption: 'A256GCM',
      header: { kid: 'enc-1' },
    });
    const decrypted = await jwtDecrypt(token, { keys: [key] });

    t.equal(decrypted.payload.sub, 'user-1', 'JWE payload round trips');
    t.equal(decrypted.header.enc, 'A256GCM', 'JWE encryption is preserved');

    await t.rejects(
      () => jwtDecrypt(token.slice(0, -1) + 'x', { keys: [key] }),
      (err) => err instanceof Error
        && (err.message.includes('JWE decryption failed') || err.message.includes('Invalid compact JWE')),
      'tampered JWE is rejected',
    );
  });

  it('encrypts and decrypts RSA-OAEP compact JWE tokens', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'OpenSSL not available; skipping RSA-OAEP JWE crypto test');
      return;
    }

    const key = await generateJwk({ kty: 'RSA', alg: 'RSA-OAEP-256', kid: 'enc-rsa-1', modulusLength: 2048 });
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
      await generateJwk({ kty: 'RSA', alg: 'RS256', kid: 'rs-1', modulusLength: 2048 }),
      await generateJwk({ kty: 'RSA', alg: 'PS256', kid: 'ps-1', modulusLength: 2048 }),
      await generateJwk({ kty: 'EC', alg: 'ES256', kid: 'es-1', namedCurve: 'P-256' }),
    ];

    for (const key of cases) {
      const algorithm = key.alg as 'RS256' | 'PS256' | 'ES256';
      const token = await jwtSign({ sub: algorithm }, key, { algorithm, header: { kid: key.kid } });
      const verified = await jwtVerify(token, { keys: [key] });
      t.equal(verified.payload.sub, algorithm, `${algorithm} round trips`);
    }
  });
});
