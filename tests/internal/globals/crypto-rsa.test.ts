/**
 * Tests for RSA WebCrypto operations: RSA-OAEP (encrypt/decrypt),
 * RSA-PSS (sign/verify), RSASSA-PKCS1-v1_5 (sign/verify), and
 * SPKI / PKCS8 / JWK key serialization.
 *
 * All tests skip gracefully when OpenSSL is not available.
 * 2048-bit keys are used for speed; 4096 is tested where relevant.
 */

import { describe, it } from 'fino:test/test';

const { crypto } = globalThis;
const cryptoAvailable = (globalThis as typeof globalThis & { cryptoAvailable?: boolean }).cryptoAvailable;
const skip = !cryptoAvailable && 'OpenSSL not available';

type CryptoKeyPair = { privateKey: CryptoKey; publicKey: CryptoKey };

const MSG = new TextEncoder().encode('fino RSA test message — cryptographically sound!');

// ---------------------------------------------------------------------------
// RSA-OAEP — generateKey
// ---------------------------------------------------------------------------

describe('RSA-OAEP — generateKey', { skip }, () => {
  it('generates 2048-bit key pair with correct metadata', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([0x01, 0x00, 0x01]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt'],
    ) as CryptoKeyPair;
    t.ok(kp.privateKey instanceof CryptoKey, 'privateKey is CryptoKey');
    t.ok(kp.publicKey  instanceof CryptoKey, 'publicKey is CryptoKey');
    t.equal(kp.privateKey.type, 'private', 'privateKey.type');
    t.equal(kp.publicKey.type,  'public',  'publicKey.type');
    t.equal(kp.privateKey.algorithm.name, 'RSA-OAEP', 'algorithm name');
    t.equal((kp.privateKey.algorithm as { modulusLength?: number }).modulusLength, 2048, 'modulusLength');
    t.ok(kp.privateKey.usages.includes('decrypt'), 'private has decrypt');
    t.ok(kp.publicKey.usages.includes('encrypt'),  'public has encrypt');
  });
});

// ---------------------------------------------------------------------------
// RSA-OAEP — encrypt / decrypt
// ---------------------------------------------------------------------------

describe('RSA-OAEP — encrypt / decrypt', { skip }, () => {
  it('round-trip: encrypt then decrypt yields original plaintext', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt'],
    ) as CryptoKeyPair;
    const ct = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, kp.publicKey, MSG);
    t.ok(ct instanceof ArrayBuffer, 'ciphertext is ArrayBuffer');
    t.ok(ct.byteLength >= 256, 'ciphertext ≥ 256 bytes (RSA-2048 output)');
    const pt = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, kp.privateKey, ct);
    t.equal(new TextDecoder().decode(pt), new TextDecoder().decode(MSG), 'decrypted plaintext matches');
  });

  it('different ciphertexts from same key are all decryptable (probabilistic padding)', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt'],
    ) as CryptoKeyPair;
    const ct1 = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, kp.publicKey, MSG) as ArrayBuffer);
    const ct2 = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, kp.publicKey, MSG) as ArrayBuffer);
    // OAEP is randomized — two encryptions of the same message should differ.
    let different = false;
    for (let i = 0; i < ct1.length; i++) if (ct1[i] !== ct2[i]) { different = true; break; }
    t.ok(different, 'probabilistic OAEP produces different ciphertexts each time');
    const pt1 = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, kp.privateKey, ct1);
    const pt2 = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, kp.privateKey, ct2);
    t.equal(new TextDecoder().decode(pt1), new TextDecoder().decode(MSG), 'ct1 decrypts correctly');
    t.equal(new TextDecoder().decode(pt2), new TextDecoder().decode(MSG), 'ct2 decrypts correctly');
  });

  it('decrypt with wrong key rejects', async (t) => {
    const kp1 = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt'],
    ) as CryptoKeyPair;
    const kp2 = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt'],
    ) as CryptoKeyPair;
    const ct = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, kp1.publicKey, MSG);
    try {
      await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, kp2.privateKey, ct);
      t.fail('should have thrown — wrong key');
    } catch (err) {
      t.ok(err instanceof Error, 'rejects with Error when wrong key used');
    }
  });

  it('decrypt with the wrong OAEP label rejects', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt'],
    ) as CryptoKeyPair;
    const label = new TextEncoder().encode('label-a');
    const wrongLabel = new TextEncoder().encode('label-b');
    const ct = await crypto.subtle.encrypt({ name: 'RSA-OAEP', label }, kp.publicKey, MSG);

    await t.rejects(
      () => crypto.subtle.decrypt({ name: 'RSA-OAEP', label: wrongLabel }, kp.privateKey, ct),
      undefined,
      'OAEP label mismatch rejects',
    );

    const pt = await crypto.subtle.decrypt({ name: 'RSA-OAEP', label }, kp.privateKey, ct);
    t.equal(new TextDecoder().decode(pt), new TextDecoder().decode(MSG), 'matching OAEP label decrypts');
  });
});

// ---------------------------------------------------------------------------
// RSA-OAEP — SPKI and PKCS8
// ---------------------------------------------------------------------------

describe('RSA-OAEP — SPKI / PKCS8 round-trip', { skip }, () => {
  it('SPKI export/import of public key: encrypt still works', async (t) => {
    const kp   = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt'],
    ) as CryptoKeyPair;
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    t.ok(spki instanceof ArrayBuffer && spki.byteLength > 200, 'SPKI is non-trivially sized');
    const importedPub = await crypto.subtle.importKey(
      'spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt'],
    );
    const ct = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, importedPub, MSG);
    const pt = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, kp.privateKey, ct);
    t.equal(new TextDecoder().decode(pt), new TextDecoder().decode(MSG), 'imported SPKI public key encrypts correctly');
  });

  it('PKCS8 export/import of private key: decrypt still works', async (t) => {
    const kp    = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt'],
    ) as CryptoKeyPair;
    const ct    = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, kp.publicKey, MSG);
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    t.ok(pkcs8 instanceof ArrayBuffer && pkcs8.byteLength > 100, 'PKCS8 is non-trivially sized');
    const importedPriv = await crypto.subtle.importKey(
      'pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt'],
    );
    const pt = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, importedPriv, ct);
    t.equal(new TextDecoder().decode(pt), new TextDecoder().decode(MSG), 'imported PKCS8 private key decrypts correctly');
  });
});

// ---------------------------------------------------------------------------
// RSA-PSS — sign / verify
// ---------------------------------------------------------------------------

describe('RSA-PSS — sign / verify', { skip }, () => {
  it('round-trip: sign then verify succeeds', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig = await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, kp.privateKey, MSG);
    t.ok(sig instanceof ArrayBuffer && sig.byteLength >= 256, 'signature is ArrayBuffer ≥ 256 bytes');
    const valid = await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, kp.publicKey, sig, MSG);
    t.ok(valid, 'valid RSA-PSS signature verifies');
  });

  it('tampered signature does not verify', async (t) => {
    const kp  = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, kp.privateKey, MSG) as ArrayBuffer);
    sig[0] ^= 0xff;
    const valid = await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, kp.publicKey, sig, MSG);
    t.ok(!valid, 'tampered RSA-PSS signature does not verify');
  });

  it('sign with SHA-384, verify succeeds', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-384' },
      true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig   = await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 48 }, kp.privateKey, MSG);
    const valid = await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 48 }, kp.publicKey, sig, MSG);
    t.ok(valid, 'RSA-PSS with SHA-384 verifies');
  });

  it('SPKI / PKCS8 round-trip for RSA-PSS', async (t) => {
    const kp    = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    const spki  = await crypto.subtle.exportKey('spki',  kp.publicKey);
    const importedPriv = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
    const importedPub  = await crypto.subtle.importKey('spki',  spki,  { name: 'RSA-PSS', hash: 'SHA-256' }, true,  ['verify']);
    const sig   = await crypto.subtle.sign  ({ name: 'RSA-PSS', saltLength: 32 }, importedPriv, MSG);
    const valid = await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, importedPub,  sig, MSG);
    t.ok(valid, 'RSA-PSS PKCS8/SPKI round-trip: imported keys sign and verify correctly');
  });

  it('enforces RSA-PSS sign and verify key usages', async (t) => {
    const signOnly = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign'],
    ) as CryptoKeyPair;
    const verifyOnly = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['verify'],
    ) as CryptoKeyPair;

    const sig = await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, signOnly.privateKey, MSG);
    await t.rejects(
      () => crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, verifyOnly.privateKey, MSG),
      /sign/i,
      'sign rejects private keys without sign usage',
    );
    await t.rejects(
      () => crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, signOnly.publicKey, sig, MSG),
      /verify/i,
      'verify rejects public keys without verify usage',
    );
  });
});

// ---------------------------------------------------------------------------
// RSASSA-PKCS1-v1_5 — sign / verify
// ---------------------------------------------------------------------------

describe('RSASSA-PKCS1-v1_5 — sign / verify', { skip }, () => {
  it('round-trip: sign then verify succeeds', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-V1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig   = await crypto.subtle.sign  ({ name: 'RSASSA-PKCS1-V1_5' }, kp.privateKey, MSG);
    const valid = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-V1_5' }, kp.publicKey,  sig, MSG);
    t.ok(valid, 'RSASSA-PKCS1-v1_5 signature verifies');
  });

  it('deterministic — same message gives same signature', async (t) => {
    const kp  = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-V1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const s1 = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-V1_5' }, kp.privateKey, MSG) as ArrayBuffer);
    const s2 = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-V1_5' }, kp.privateKey, MSG) as ArrayBuffer);
    let same = s1.length === s2.length;
    for (let i = 0; same && i < s1.length; i++) if (s1[i] !== s2[i]) same = false;
    t.ok(same, 'PKCS1-v1_5 signatures are deterministic');
  });

  it('tampered signature does not verify', async (t) => {
    const kp  = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-V1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-V1_5' }, kp.privateKey, MSG) as ArrayBuffer);
    sig[0] ^= 0xff;
    const valid = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-V1_5' }, kp.publicKey, sig, MSG);
    t.ok(!valid, 'tampered PKCS1-v1_5 signature does not verify');
  });
});

// ---------------------------------------------------------------------------
// RSA JWK — kty: 'RSA'
// ---------------------------------------------------------------------------

describe('RSA JWK — export public key', { skip }, () => {
  it('RSA-OAEP public JWK has correct fields', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt'],
    ) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey) as { kty: string; alg: string; n: string; e: string; d?: string };
    t.equal(jwk.kty, 'RSA', 'kty is RSA');
    t.equal(jwk.alg, 'RSA-OAEP-256', 'alg is RSA-OAEP-256');
    t.ok(typeof jwk.n === 'string' && jwk.n.length > 200, 'n present and non-trivial');
    t.ok(typeof jwk.e === 'string' && jwk.e.length > 0, 'e present');
    t.ok(!('d' in jwk), 'd absent on public JWK');
  });
});

describe('RSA JWK — export private key', { skip }, () => {
  it('RSA-OAEP private JWK has n, e, d, p, q, dp, dq, qi', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt'],
    ) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey) as {
      kty: string; n: string; e: string; d: string; p: string; q: string; dp: string; dq: string; qi: string;
    };
    t.equal(jwk.kty, 'RSA', 'kty is RSA');
    t.ok(typeof jwk.d  === 'string' && jwk.d.length  > 0, 'd present');
    t.ok(typeof jwk.p  === 'string' && jwk.p.length  > 0, 'p present');
    t.ok(typeof jwk.q  === 'string' && jwk.q.length  > 0, 'q present');
    t.ok(typeof jwk.dp === 'string' && jwk.dp.length > 0, 'dp present');
    t.ok(typeof jwk.dq === 'string' && jwk.dq.length > 0, 'dq present');
    t.ok(typeof jwk.qi === 'string' && jwk.qi.length > 0, 'qi present');
  });
});

describe('RSA JWK — public key round-trip', { skip }, () => {
  it('RSA-OAEP: export public JWK, import, encrypt with original private key still decrypts', async (t) => {
    const kp  = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt'],
    ) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const imported = await crypto.subtle.importKey('jwk', jwk as BufferSource, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
    t.equal(imported.type, 'public', 'imported type is public');
    const ct = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, imported, MSG);
    const pt = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, kp.privateKey, ct);
    t.equal(new TextDecoder().decode(pt), new TextDecoder().decode(MSG), 'JWK-imported public key encrypts correctly');
  });
});

describe('RSA JWK — private key round-trip', { skip }, () => {
  it('RSA-OAEP: export private JWK, import, decrypt succeeds', async (t) => {
    const kp  = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt'],
    ) as CryptoKeyPair;
    const ct  = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, kp.publicKey, MSG);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const imported = await crypto.subtle.importKey('jwk', jwk as BufferSource, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['decrypt']);
    t.equal(imported.type, 'private', 'imported type is private');
    const pt = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, imported, ct);
    t.equal(new TextDecoder().decode(pt), new TextDecoder().decode(MSG), 'JWK-imported private key decrypts correctly');
  });

  it('RSA-PSS: export/import private JWK, sign/verify round-trip', async (t) => {
    const kp  = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const jwkPriv = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const importedPriv = await crypto.subtle.importKey(
      'jwk', jwkPriv as BufferSource, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig   = await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, importedPriv, MSG);
    const valid = await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, kp.publicKey, sig, MSG);
    t.ok(valid, 'RSA-PSS: JWK-imported private key signs correctly');
  });
});
