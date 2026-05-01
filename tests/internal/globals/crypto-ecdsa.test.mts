/**
 * Tests for ECDSA P-256 WebCrypto operations: generateKey, exportKey('spki'),
 * importKey('spki'), sign, and verify.
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
    // The P256_SPKI_PREFIX in openssl.mts is the first 26 bytes; byte 26 should be 0x04.
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
