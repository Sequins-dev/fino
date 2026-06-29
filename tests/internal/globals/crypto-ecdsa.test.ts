/**
 * Tests for ECDSA P-256 / P-384 / P-521 WebCrypto operations:
 * generateKey, exportKey('spki'), importKey('spki'), sign, and verify.
 *
 * All tests skip gracefully when OpenSSL is not available.
 */

import { describe, it } from 'fino:test/test';

const { crypto } = globalThis;
const cryptoAvailable = (globalThis as typeof globalThis & { cryptoAvailable?: boolean }).cryptoAvailable;
const skip = !cryptoAvailable && 'OpenSSL not available';

type CryptoKeyPair = { privateKey: CryptoKey; publicKey: CryptoKey };

const MSG = new TextEncoder().encode('fino ECDSA test message');

describe('ECDSA P-256 — generateKey', { skip }, () => {
  it('returns a key pair with correct key types', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    t.ok(typeof kp === 'object' && kp !== null, 'result is an object');
    t.ok(kp.privateKey instanceof CryptoKey, 'privateKey is a CryptoKey');
    t.ok(kp.publicKey instanceof CryptoKey, 'publicKey is a CryptoKey');
    t.equal(kp.privateKey.type, 'private', 'privateKey.type');
    t.equal(kp.publicKey.type, 'public', 'publicKey.type');
    t.equal(kp.privateKey.algorithm.name, 'ECDSA', 'privateKey algorithm name');
    t.equal(kp.publicKey.algorithm.name, 'ECDSA', 'publicKey algorithm name');
    t.ok(kp.privateKey.usages.includes('sign'), 'privateKey has sign usage');
    t.ok(kp.publicKey.usages.includes('verify'), 'publicKey has verify usage');
  });
});

describe('ECDSA P-256 — exportKey / importKey (spki)', { skip }, () => {
  it('exportKey("spki") returns 91-byte DER buffer', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    t.ok(spki instanceof ArrayBuffer, 'exportKey returns ArrayBuffer');
    t.equal(spki.byteLength, 91, 'P-256 SPKI is 91 bytes');
  });

  it('importKey("spki") round-trips through exportKey("spki")', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey) as ArrayBuffer;
    const importedPubKey = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', hash: 'SHA-256' }, true, ['verify']);
    t.ok(importedPubKey instanceof CryptoKey, 'importedPubKey is a CryptoKey');
    t.equal(importedPubKey.type, 'public', 'imported key type is "public"');

    // Re-export and compare bytes
    const spki2 = await crypto.subtle.exportKey('spki', importedPubKey) as ArrayBuffer;
    const b1 = new Uint8Array(spki);
    const b2 = new Uint8Array(spki2);
    t.equal(b1.length, b2.length, 'round-tripped SPKI is same length');
    let same = true;
    for (let i = 0; i < b1.length; i++) if (b1[i] !== b2[i]) { same = false; break; }
    t.ok(same, 'round-tripped SPKI bytes are identical');
  });

  it('importKey("spki") rejects wrong byte length', async (t) => {
    const short = new Uint8Array(90); // 1 byte too short
    try {
      await crypto.subtle.importKey('spki', short, { name: 'ECDSA', hash: 'SHA-256' }, true, ['verify']);
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'throws an Error on wrong length');
      t.ok((err as Error).message.includes('91'), 'error mentions expected length');
    }
  });

  it('importKey("spki") rejects mismatched curve prefix', async (t) => {
    const bad = new Uint8Array(91);
    bad[0] = 0x31; // wrong first byte
    try {
      await crypto.subtle.importKey('spki', bad, { name: 'ECDSA', hash: 'SHA-256' }, true, ['verify']);
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'throws an Error on wrong prefix');
      t.ok(
        (err as Error).message.toLowerCase().includes('p-256') ||
        (err as Error).message.toLowerCase().includes('header') ||
        (err as Error).message.toLowerCase().includes('match'),
        'error mentions SPKI mismatch: ' + (err as Error).message,
      );
    }
  });

  it('importKey("spki") rejects compressed EC point (0x02 marker)', async (t) => {
    // Build a plausible SPKI with correct prefix length but compressed point marker.
    // The P256_SPKI_PREFIX in openssl.ts is the first 26 bytes; byte 26 should be 0x04.
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey) as ArrayBuffer);
    spki[26] = 0x02; // flip uncompressed → compressed marker
    try {
      await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', hash: 'SHA-256' }, true, ['verify']);
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'throws an Error on compressed point');
      t.ok(
        (err as Error).message.toLowerCase().includes('uncompressed') ||
        (err as Error).message.toLowerCase().includes('0x04'),
        'error mentions uncompressed point requirement: ' + (err as Error).message,
      );
    }
  });
});

describe('ECDSA — PKCS8 private key export / import', { skip }, () => {
  it('P-256 private key round-trips through PKCS8 (sign with original, verify with imported)', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;

    const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    t.ok(pkcs8 instanceof ArrayBuffer, 'exportKey("pkcs8") returns ArrayBuffer');
    t.ok(pkcs8.byteLength > 50, 'PKCS8 DER is non-trivially sized');

    const importedPriv = await crypto.subtle.importKey(
      'pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
    );
    t.equal(importedPriv.type, 'private', 'imported pkcs8 key type is private');
    t.equal((importedPriv.algorithm as { namedCurve?: string }).namedCurve, 'P-256', 'namedCurve preserved');

    // Sign with original private, verify with original public
    const sig1 = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, MSG);
    const ok1 = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig1, MSG);
    t.ok(ok1, 'original sign + verify works');

    // Sign with imported private, verify with original public
    const sig2 = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, importedPriv, MSG);
    const ok2 = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig2, MSG);
    t.ok(ok2, 'imported pkcs8 key signs and original public key verifies');
  });

  it('P-384 private key round-trips through PKCS8', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    const importedPriv = await crypto.subtle.importKey(
      'pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-384' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, importedPriv, MSG);
    const ok  = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-384' }, kp.publicKey, sig, MSG);
    t.ok(ok, 'P-384 pkcs8 import → sign → verify succeeds');
  });

  it('exportKey("pkcs8") throws for a public key', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    try {
      await crypto.subtle.exportKey('pkcs8', kp.publicKey);
      t.fail('should have thrown — pkcs8 requires private key');
    } catch (err) {
      t.ok(err instanceof Error, 'throws Error');
      t.ok(
        (err as Error).message.toLowerCase().includes('private'),
        'error mentions private: ' + (err as Error).message,
      );
    }
  });
});

describe('ECDSA P-256 — sign / verify', { skip }, () => {
  it('sign + verify round-trip succeeds', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, MSG);
    t.ok(sig instanceof ArrayBuffer, 'sign returns ArrayBuffer');
    t.equal(sig.byteLength, 64, 'raw P-256 signature is 64 bytes');

    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig, MSG);
    t.ok(valid, 'valid signature verifies');
  });

  it('verify fails for tampered signature', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, MSG) as ArrayBuffer;
    const tampered = new Uint8Array(sig);
    tampered[0] ^= 0xff; // flip bits in first byte
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, tampered, MSG);
    t.ok(!valid, 'tampered signature does not verify');
  });

  it('verify fails for wrong message', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, MSG);
    const wrongMsg = new TextEncoder().encode('different message');
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig, wrongMsg);
    t.ok(!valid, 'signature does not verify for wrong message');
  });

  it('verify works with imported public key', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, MSG);
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey) as ArrayBuffer;
    const importedKey = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', hash: 'SHA-256' }, true, ['verify']);
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, importedKey, sig, MSG);
    t.ok(valid, 'imported public key verifies original signature');
  });

  it('sign() rejects with an Error when called with a public key (wrong usage)', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    try {
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, MSG);
      t.fail('should have thrown — public key does not have sign usage');
    } catch (err) {
      t.ok(err instanceof Error, 'throws an Error');
      t.ok(
        (err as Error).message.toLowerCase().includes('sign') ||
        (err as Error).message.toLowerCase().includes('usage'),
        'error mentions sign/usage: ' + (err as Error).message,
      );
    }
  });

  it('verify() rejects when called with a private key (wrong usage)', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, MSG);
    try {
      await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, sig, MSG);
      t.fail('should have thrown — private key does not have verify usage');
    } catch (err) {
      t.ok(err instanceof Error, 'throws an Error');
      t.ok(
        (err as Error).message.toLowerCase().includes('verify') ||
        (err as Error).message.toLowerCase().includes('usage'),
        'error mentions verify/usage: ' + (err as Error).message,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// P-384
// ---------------------------------------------------------------------------

describe('ECDSA P-384 — generateKey', { skip }, () => {
  it('returns a key pair with P-384 namedCurve', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-384', hash: 'SHA-384' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    t.ok(kp.privateKey instanceof CryptoKey, 'privateKey is CryptoKey');
    t.ok(kp.publicKey  instanceof CryptoKey, 'publicKey is CryptoKey');
    t.equal(kp.privateKey.algorithm.name, 'ECDSA', 'algorithm name');
    t.equal((kp.privateKey.algorithm as { namedCurve?: string }).namedCurve, 'P-384', 'private namedCurve');
    t.equal((kp.publicKey.algorithm  as { namedCurve?: string }).namedCurve, 'P-384', 'public namedCurve');
    t.ok(kp.privateKey.usages.includes('sign'),   'private has sign');
    t.ok(kp.publicKey.usages.includes('verify'), 'public has verify');
  });
});

describe('ECDSA P-384 — exportKey / importKey (spki)', { skip }, () => {
  it('exportKey("spki") returns 120-byte DER buffer', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    t.ok(spki instanceof ArrayBuffer, 'returns ArrayBuffer');
    t.equal(spki.byteLength, 120, 'P-384 SPKI is 120 bytes');
  });

  it('importKey("spki") round-trips (P-384)', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey) as ArrayBuffer;
    const imported = await crypto.subtle.importKey(
      'spki', spki, { name: 'ECDSA', namedCurve: 'P-384', hash: 'SHA-384' }, true, ['verify'],
    );
    t.equal(imported.type, 'public', 'imported type is public');
    t.equal((imported.algorithm as { namedCurve?: string }).namedCurve, 'P-384', 'imported namedCurve is P-384');
    const spki2 = new Uint8Array(await crypto.subtle.exportKey('spki', imported) as ArrayBuffer);
    const spki1 = new Uint8Array(spki);
    let same = spki1.length === spki2.length;
    for (let i = 0; same && i < spki1.length; i++) if (spki1[i] !== spki2[i]) same = false;
    t.ok(same, 'round-tripped SPKI bytes are identical');
  });
});

describe('ECDSA P-384 — sign / verify', { skip }, () => {
  it('sign + verify round-trip (P-384)', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, kp.privateKey, MSG);
    t.ok(sig instanceof ArrayBuffer, 'sign returns ArrayBuffer');
    t.equal(sig.byteLength, 96, 'raw P-384 signature is 96 bytes (2 × 48)');
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-384' }, kp.publicKey, sig, MSG);
    t.ok(valid, 'valid P-384 signature verifies');
  });

  it('verify fails for tampered P-384 signature', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, kp.privateKey, MSG) as ArrayBuffer);
    sig[0] ^= 0xff;
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-384' }, kp.publicKey, sig, MSG);
    t.ok(!valid, 'tampered P-384 signature does not verify');
  });

  it('verify with imported P-384 public key succeeds', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig  = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, kp.privateKey, MSG);
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey) as ArrayBuffer;
    const pub  = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-384', hash: 'SHA-384' }, true, ['verify']);
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-384' }, pub, sig, MSG);
    t.ok(valid, 'imported P-384 public key verifies original signature');
  });
});

// ---------------------------------------------------------------------------
// P-521
// ---------------------------------------------------------------------------

describe('ECDSA P-521 — generateKey', { skip }, () => {
  it('returns a key pair with P-521 namedCurve', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-521', hash: 'SHA-512' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    t.ok(kp.privateKey instanceof CryptoKey, 'privateKey is CryptoKey');
    t.ok(kp.publicKey  instanceof CryptoKey, 'publicKey is CryptoKey');
    t.equal((kp.privateKey.algorithm as { namedCurve?: string }).namedCurve, 'P-521', 'private namedCurve');
    t.equal((kp.publicKey.algorithm  as { namedCurve?: string }).namedCurve, 'P-521', 'public namedCurve');
  });
});

describe('ECDSA P-521 — exportKey / importKey (spki)', { skip }, () => {
  it('exportKey("spki") returns 158-byte DER buffer', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-521' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    t.ok(spki instanceof ArrayBuffer, 'returns ArrayBuffer');
    t.equal(spki.byteLength, 158, 'P-521 SPKI is 158 bytes');
  });

  it('importKey("spki") round-trips (P-521)', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-521' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey) as ArrayBuffer;
    const imported = await crypto.subtle.importKey(
      'spki', spki, { name: 'ECDSA', namedCurve: 'P-521', hash: 'SHA-512' }, true, ['verify'],
    );
    t.equal(imported.type, 'public', 'imported type is public');
    t.equal((imported.algorithm as { namedCurve?: string }).namedCurve, 'P-521', 'imported namedCurve is P-521');
    const spki2 = new Uint8Array(await crypto.subtle.exportKey('spki', imported) as ArrayBuffer);
    const spki1 = new Uint8Array(spki);
    let same = spki1.length === spki2.length;
    for (let i = 0; same && i < spki1.length; i++) if (spki1[i] !== spki2[i]) same = false;
    t.ok(same, 'round-tripped P-521 SPKI bytes are identical');
  });
});

describe('ECDSA P-521 — sign / verify', { skip }, () => {
  it('sign + verify round-trip (P-521)', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-521' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-512' }, kp.privateKey, MSG);
    t.ok(sig instanceof ArrayBuffer, 'sign returns ArrayBuffer');
    t.equal(sig.byteLength, 132, 'raw P-521 signature is 132 bytes (2 × 66)');
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-512' }, kp.publicKey, sig, MSG);
    t.ok(valid, 'valid P-521 signature verifies');
  });

  it('verify fails for tampered P-521 signature', async (t) => {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-521' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-512' }, kp.privateKey, MSG) as ArrayBuffer);
    sig[0] ^= 0xff;
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-512' }, kp.publicKey, sig, MSG);
    t.ok(!valid, 'tampered P-521 signature does not verify');
  });

  it('cross-curve rejection: P-256 public key cannot verify P-384 signature', async (t) => {
    const kp256 = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const kp384 = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, kp384.privateKey, MSG);
    // P-256 raw sig is 64 bytes; a P-384 raw sig (96 bytes) will fail the
    // coordSize check in _rawSigToDer and return false or throw.
    try {
      const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp256.publicKey, sig, MSG);
      t.ok(!valid, 'cross-curve verify correctly returns false');
    } catch {
      t.ok(true, 'cross-curve verify correctly rejects with an error');
    }
  });
});

// ---------------------------------------------------------------------------
// EC JWK — ECDSA
// ---------------------------------------------------------------------------

describe('ECDSA — EC JWK export / import', { skip }, () => {
  it('P-256 public key JWK export has correct fields', async (t) => {
    const kp  = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey) as { kty: string; crv: string; x: string; y: string };
    t.equal(jwk.kty, 'EC', 'kty is EC');
    t.equal(jwk.crv, 'P-256', 'crv is P-256');
    t.ok(typeof jwk.x === 'string' && jwk.x.length > 0, 'x is a non-empty string');
    t.ok(typeof jwk.y === 'string' && jwk.y.length > 0, 'y is a non-empty string');
    t.ok(!('d' in jwk), 'd absent on public key JWK');
  });

  it('P-256 private key JWK export includes d field', async (t) => {
    const kp  = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey) as { kty: string; d?: string };
    t.equal(jwk.kty, 'EC', 'kty is EC');
    t.ok(typeof jwk.d === 'string' && jwk.d.length > 0, 'd is a non-empty string');
  });

  it('P-256 public key JWK round-trip: import and verify', async (t) => {
    const kp   = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const jwk  = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const imported = await crypto.subtle.importKey('jwk', jwk as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    t.equal(imported.type, 'public', 'imported type is public');
    const MSG = new TextEncoder().encode('jwk round-trip test');
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, MSG);
    const ok  = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, sig, MSG);
    t.ok(ok, 'signature verifies with JWK-imported public key');
  });

  it('P-256 private key JWK round-trip: import and sign', async (t) => {
    const kp      = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const jwkPriv = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const imported = await crypto.subtle.importKey('jwk', jwkPriv as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const MSG = new TextEncoder().encode('jwk private round-trip');
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, imported, MSG);
    const ok  = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig, MSG);
    t.ok(ok, 'JWK-imported private key signs; original public key verifies');
  });

  it('P-384 JWK round-trip (public + private)', async (t) => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const jwkPub  = await crypto.subtle.exportKey('jwk', kp.publicKey)  as { crv: string };
    const jwkPriv = await crypto.subtle.exportKey('jwk', kp.privateKey) as { crv: string; d?: string };
    t.equal(jwkPub.crv,  'P-384', 'public JWK crv is P-384');
    t.equal(jwkPriv.crv, 'P-384', 'private JWK crv is P-384');
    t.ok(typeof jwkPriv.d === 'string', 'private JWK has d');
    const importedPriv = await crypto.subtle.importKey('jwk', jwkPriv as BufferSource, { name: 'ECDSA', namedCurve: 'P-384' }, false, ['sign']);
    const MSG = new TextEncoder().encode('p384 jwk test');
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, importedPriv, MSG);
    const importedPub = await crypto.subtle.importKey('jwk', jwkPub as BufferSource, { name: 'ECDSA', namedCurve: 'P-384' }, true, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-384' }, importedPub, sig, MSG);
    t.ok(ok, 'P-384 JWK private/public round-trip verify succeeds');
  });
});
