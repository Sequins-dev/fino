/**
 * Tests for ECDH WebCrypto operations: generateKey, deriveBits, deriveKey,
 * and SPKI / PKCS8 import/export for ECDH keys.
 *
 * All tests skip gracefully when OpenSSL is not available.
 */

import { describe, it } from 'fino:test/test';

const { crypto } = globalThis;
const cryptoAvailable = (globalThis as typeof globalThis & { cryptoAvailable?: boolean }).cryptoAvailable;
const skip = !cryptoAvailable && 'OpenSSL not available';

type CryptoKeyPair = { privateKey: CryptoKey; publicKey: CryptoKey };

// ---------------------------------------------------------------------------
// generateKey
// ---------------------------------------------------------------------------

describe('ECDH — generateKey', { skip }, () => {
  for (const namedCurve of ['P-256', 'P-384', 'P-521'] as const) {
    it(`generateKey ${namedCurve} returns correct key pair`, async (t) => {
      const kp = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve },
        true,
        ['deriveKey', 'deriveBits'],
      ) as CryptoKeyPair;
      t.ok(kp.privateKey instanceof CryptoKey, 'privateKey is CryptoKey');
      t.ok(kp.publicKey  instanceof CryptoKey, 'publicKey is CryptoKey');
      t.equal(kp.privateKey.type, 'private', 'private key type');
      t.equal(kp.publicKey.type,  'public',  'public key type');
      t.equal(kp.privateKey.algorithm.name, 'ECDH', 'algorithm name');
      t.equal((kp.privateKey.algorithm as { namedCurve?: string }).namedCurve, namedCurve, 'namedCurve on private');
      t.equal((kp.publicKey.algorithm  as { namedCurve?: string }).namedCurve, namedCurve, 'namedCurve on public');
      t.ok(kp.privateKey.usages.includes('deriveBits'), 'private has deriveBits');
      t.ok(!kp.publicKey.usages.includes('deriveBits'), 'public has no deriveBits');
    });
  }
});

// ---------------------------------------------------------------------------
// deriveBits
// ---------------------------------------------------------------------------

describe('ECDH — deriveBits', { skip }, () => {
  it('P-256: both sides derive the same shared secret', async (t) => {
    const kpA = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const kpB = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const secretA = await crypto.subtle.deriveBits({ name: 'ECDH', public: kpB.publicKey }, kpA.privateKey, 256);
    const secretB = await crypto.subtle.deriveBits({ name: 'ECDH', public: kpA.publicKey }, kpB.privateKey, 256);
    t.equal(secretA.byteLength, 32, 'P-256 full shared secret is 32 bytes');
    const a = new Uint8Array(secretA);
    const b = new Uint8Array(secretB);
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    t.ok(same, 'both sides derive identical shared secret (Diffie-Hellman agreement)');
  });

  it('P-384: both sides derive the same shared secret', async (t) => {
    const kpA = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-384' }, true, ['deriveBits']) as CryptoKeyPair;
    const kpB = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-384' }, true, ['deriveBits']) as CryptoKeyPair;
    const secretA = await crypto.subtle.deriveBits({ name: 'ECDH', public: kpB.publicKey }, kpA.privateKey, 384);
    const secretB = await crypto.subtle.deriveBits({ name: 'ECDH', public: kpA.publicKey }, kpB.privateKey, 384);
    t.equal(secretA.byteLength, 48, 'P-384 full shared secret is 48 bytes');
    const a = new Uint8Array(secretA);
    const b = new Uint8Array(secretB);
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    t.ok(same, 'P-384 ECDH agreement correct');
  });

  it('P-521: both sides derive the same shared secret', async (t) => {
    const kpA = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-521' }, true, ['deriveBits']) as CryptoKeyPair;
    const kpB = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-521' }, true, ['deriveBits']) as CryptoKeyPair;
    const secretA = await crypto.subtle.deriveBits({ name: 'ECDH', public: kpB.publicKey }, kpA.privateKey, 528);
    const secretB = await crypto.subtle.deriveBits({ name: 'ECDH', public: kpA.publicKey }, kpB.privateKey, 528);
    t.equal(secretA.byteLength, 66, 'P-521 full shared secret is 66 bytes');
    const a = new Uint8Array(secretA);
    const b = new Uint8Array(secretB);
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    t.ok(same, 'P-521 ECDH agreement correct');
  });

  it('deriveBits truncates to requested byte count', async (t) => {
    const kpA = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const kpB = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const short = await crypto.subtle.deriveBits({ name: 'ECDH', public: kpB.publicKey }, kpA.privateKey, 128);
    t.equal(short.byteLength, 16, 'truncated to 128 bits = 16 bytes');
  });

  it('cross-curve derivation rejects', async (t) => {
    const kpA = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const kpB = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-384' }, true, ['deriveBits']) as CryptoKeyPair;
    try {
      await crypto.subtle.deriveBits({ name: 'ECDH', public: kpB.publicKey }, kpA.privateKey, 256);
      t.fail('should have thrown — mismatched curves');
    } catch (err) {
      t.ok(err instanceof Error, 'rejects with Error');
      t.ok(
        (err as Error).message.toLowerCase().includes('curve') ||
        (err as Error).message.toLowerCase().includes('match'),
        'error mentions curve mismatch: ' + (err as Error).message,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// deriveKey
// ---------------------------------------------------------------------------

describe('ECDH — deriveKey', { skip }, () => {
  it('derives an AES-GCM key and uses it for encrypt/decrypt', async (t) => {
    const kpA = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']) as CryptoKeyPair;
    const kpB = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']) as CryptoKeyPair;
    const aesA = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: kpB.publicKey }, kpA.privateKey,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    const aesB = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: kpA.publicKey }, kpB.privateKey,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    // Encrypt with A's key, decrypt with B's key — they should agree.
    const iv        = new Uint8Array(12);
    const plaintext = new TextEncoder().encode('ECDH deriveKey test');
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesA, plaintext);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesB, ct);
    t.equal(new TextDecoder().decode(pt), 'ECDH deriveKey test', 'decrypt with ECDH-derived key succeeds');
  });
});

// ---------------------------------------------------------------------------
// SPKI and PKCS8 for ECDH
// ---------------------------------------------------------------------------

describe('ECDH — SPKI public key round-trip', { skip }, () => {
  it('P-256 ECDH public key exports 91-byte SPKI and re-imports', async (t) => {
    const kp   = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    t.equal(spki.byteLength, 91, 'ECDH P-256 SPKI is 91 bytes');
    const imported = await crypto.subtle.importKey('spki', spki, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    t.equal(imported.type, 'public', 'imported type is public');
    t.equal(imported.algorithm.name, 'ECDH', 'algorithm name is ECDH');
    // Derive shared secret using original private + imported public — should work.
    const kpB = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const s1 = await crypto.subtle.deriveBits({ name: 'ECDH', public: kp.publicKey }, kpB.privateKey, 256);
    const s2 = await crypto.subtle.deriveBits({ name: 'ECDH', public: imported }, kpB.privateKey, 256);
    const a = new Uint8Array(s1); const b = new Uint8Array(s2);
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    t.ok(same, 'original and imported ECDH public key derive the same secret');
  });
});

describe('ECDH — PKCS8 private key round-trip', { skip }, () => {
  it('P-256 ECDH private key exports as PKCS8 and re-imports', async (t) => {
    const kp    = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    t.ok(pkcs8.byteLength > 50, 'PKCS8 DER non-trivially sized');
    const imported = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    t.equal(imported.type, 'private', 'imported type is private');
    t.equal(imported.algorithm.name, 'ECDH', 'algorithm name is ECDH');
    // Both should derive the same secret against a common peer.
    const kpB = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const s1 = await crypto.subtle.deriveBits({ name: 'ECDH', public: kpB.publicKey }, kp.privateKey, 256);
    const s2 = await crypto.subtle.deriveBits({ name: 'ECDH', public: kpB.publicKey }, imported, 256);
    const a = new Uint8Array(s1); const b = new Uint8Array(s2);
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    t.ok(same, 'original and PKCS8-imported ECDH private key derive the same secret');
  });
});

// ---------------------------------------------------------------------------
// ECDH EC JWK
// ---------------------------------------------------------------------------

describe('ECDH — EC JWK export / import', { skip }, () => {
  it('P-256 ECDH public key JWK has correct fields', async (t) => {
    const kp  = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey) as { kty: string; crv: string; x: string; y: string };
    t.equal(jwk.kty, 'EC',    'kty is EC');
    t.equal(jwk.crv, 'P-256', 'crv is P-256');
    t.ok(typeof jwk.x === 'string' && jwk.x.length > 0, 'x present');
    t.ok(typeof jwk.y === 'string' && jwk.y.length > 0, 'y present');
    t.ok(!('d' in jwk), 'd absent on public JWK');
  });

  it('P-256 ECDH JWK round-trip: derive same secret', async (t) => {
    const kpA = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const kpB = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const jwkPub = await crypto.subtle.exportKey('jwk', kpB.publicKey);
    const imported = await crypto.subtle.importKey('jwk', jwkPub as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const s1 = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: kpB.publicKey }, kpA.privateKey, 256));
    const s2 = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: imported }, kpA.privateKey, 256));
    let same = s1.length === s2.length;
    for (let i = 0; same && i < s1.length; i++) if (s1[i] !== s2[i]) same = false;
    t.ok(same, 'JWK-imported ECDH public key derives same secret');
  });

  it('P-256 ECDH private key JWK round-trip', async (t) => {
    const kpA = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const kpB = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const jwkPriv = await crypto.subtle.exportKey('jwk', kpA.privateKey) as { d?: string };
    t.ok(typeof jwkPriv.d === 'string', 'private JWK has d');
    const importedPriv = await crypto.subtle.importKey('jwk', jwkPriv as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const s1 = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: kpB.publicKey }, kpA.privateKey, 256));
    const s2 = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: kpB.publicKey }, importedPriv, 256));
    let same = s1.length === s2.length;
    for (let i = 0; same && i < s1.length; i++) if (s1[i] !== s2[i]) same = false;
    t.ok(same, 'JWK-imported ECDH private key derives same secret');
  });
});
