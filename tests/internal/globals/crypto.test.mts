/**
 * Tests for fino:crypto — Web Crypto API backed by OpenSSL FFI.
 *
 * All tests skip gracefully when OpenSSL is not available, so the test suite
 * passes on systems without OpenSSL installed.
 */

import { describe, it } from 'fino:test/test';

type AesKeyAlgorithm = KeyAlgorithm & { length: number };
type SymbolRecord = Record<symbol, unknown>;

const { crypto } = globalThis;
const cryptoAvailable = (globalThis as typeof globalThis & { cryptoAvailable?: boolean }).cryptoAvailable;
const skip = !cryptoAvailable && 'OpenSSL not available';

// Helper: convert Uint8Array / ArrayBuffer to lowercase hex string
function toHex(data: ArrayBuffer | ArrayBufferView) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer ?? data);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

describe('getRandomValues', { skip }, () => {
  it('fills array with bytes', (t) => {
    const arr = new Uint8Array(32);
    const result = crypto.getRandomValues(arr);
    t.ok(result === arr, 'returns same TypedArray');
    const allZero = arr.every(b => b === 0);
    t.ok(!allZero, 'array is not all zeros');
  });

  it('different values each call', (t) => {
    const a = new Uint8Array(16);
    const b = new Uint8Array(16);
    crypto.getRandomValues(a);
    crypto.getRandomValues(b);
    const equal = a.every((v, i) => v === b[i]);
    t.ok(!equal, 'two calls produce different values');
  });

  it('works with Uint32Array', (t) => {
    const arr = new Uint32Array(4);
    crypto.getRandomValues(arr);
    t.ok(true, 'no throw for Uint32Array');
  });
});

describe('randomUUID', { skip }, () => {
  it('returns valid v4 UUID format', (t) => {
    const uuid = crypto.randomUUID();
    t.ok(typeof uuid === 'string', 'returns string');
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    t.ok(uuidRe.test(uuid), `valid v4 UUID: ${uuid}`);
  });

  it('different values each call', (t) => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    t.ok(a !== b, 'two UUIDs are different');
  });
});

describe('subtle.digest', { skip }, () => {
  it('SHA-256 empty string', async (t) => {
    const result = await crypto.subtle.digest('SHA-256', new Uint8Array(0));
    const hex = toHex(result);
    t.equal(hex, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'SHA-256("")');
  });

  it('SHA-256 "abc"', async (t) => {
    const data = new TextEncoder().encode('abc');
    const result = await crypto.subtle.digest('SHA-256', data);
    const hex = toHex(result);
    t.equal(hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'SHA-256("abc")');
  });

  it('SHA-1 "abc"', async (t) => {
    const data = new TextEncoder().encode('abc');
    const result = await crypto.subtle.digest('SHA-1', data);
    const hex = toHex(result);
    t.equal(hex, 'a9993e364706816aba3e25717850c26c9cd0d89d', 'SHA-1("abc")');
  });

  it('SHA-512 empty', async (t) => {
    const result = await crypto.subtle.digest('SHA-512', new Uint8Array(0));
    const hex = toHex(result);
    t.equal(
      hex,
      'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
      'SHA-512("")',
    );
  });

  it('returns ArrayBuffer', async (t) => {
    const result = await crypto.subtle.digest('SHA-256', new Uint8Array(4));
    t.ok(result instanceof ArrayBuffer, 'returns ArrayBuffer');
    t.equal(result.byteLength, 32, '32 bytes for SHA-256');
  });
});

describe('HMAC', { skip }, () => {
  it('sign/verify round-trip', async (t) => {
    const keyBytes = new Uint8Array(32).fill(0x42);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

    const data = new TextEncoder().encode('hello world');
    const sig  = await crypto.subtle.sign({ name: 'HMAC' }, key, data);

    t.ok(sig instanceof ArrayBuffer, 'signature is ArrayBuffer');
    t.equal(sig.byteLength, 32, '32 bytes for HMAC-SHA256');

    const valid = await crypto.subtle.verify({ name: 'HMAC' }, key, sig, data);
    t.ok(valid, 'signature verifies');
  });

  it('verify — wrong data returns false', async (t) => {
    const keyBytes = new Uint8Array(32).fill(0x01);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

    const data      = new TextEncoder().encode('hello');
    const wrongData = new TextEncoder().encode('world');
    const sig       = await crypto.subtle.sign({ name: 'HMAC' }, key, data);
    const valid     = await crypto.subtle.verify({ name: 'HMAC' }, key, sig, wrongData);
    t.ok(!valid, 'wrong data fails verification');
  });

  it('HMAC-SHA256 known vector (RFC 4231 case 1)', async (t) => {
    const keyBytes = new Uint8Array(20).fill(0x0b);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const data = new TextEncoder().encode('Hi There');
    const sig  = await crypto.subtle.sign({ name: 'HMAC' }, key, data);
    t.equal(toHex(sig), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7', 'HMAC-SHA256 RFC4231 case 1');
  });

  it('HMAC-SHA256 known vector (RFC 4231 case 2 — "Jefe" key)', async (t) => {
    const keyBytes = new TextEncoder().encode('Jefe');
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const data = new TextEncoder().encode('what do ya want for nothing?');
    const sig  = await crypto.subtle.sign({ name: 'HMAC' }, key, data);
    t.equal(toHex(sig), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843', 'HMAC-SHA256 RFC4231 case 2');
  });

  it('HMAC-SHA384 known vector (RFC 4231 case 1)', async (t) => {
    const keyBytes = new Uint8Array(20).fill(0x0b);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-384' }, false, ['sign']);
    const data = new TextEncoder().encode('Hi There');
    const sig  = await crypto.subtle.sign({ name: 'HMAC' }, key, data);
    t.equal(
      toHex(sig),
      'afd03944d84895626b0825f4ab46907f15f9dadbe4101ec682aa034c7cebc59cfaea9ea9076ede7f4af152e8b2fa9cb6',
      'HMAC-SHA384 RFC4231 case 1',
    );
  });
});

describe('AES-GCM', { skip }, () => {
  it('256-bit encrypt/decrypt round-trip', async (t) => {
    const keyBytes = new Uint8Array(32);
    crypto.getRandomValues(keyBytes);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

    const iv        = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const plaintext = new TextEncoder().encode('secret message');

    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    t.ok(ciphertext instanceof ArrayBuffer, 'ciphertext is ArrayBuffer');
    t.equal(ciphertext.byteLength, plaintext.byteLength + 16, 'ciphertext length = plaintext + tag');

    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    t.equal(new TextDecoder().decode(decrypted), 'secret message', 'decrypted matches');
  });

  it('128-bit encrypt/decrypt round-trip', async (t) => {
    const keyBytes = new Uint8Array(16);
    crypto.getRandomValues(keyBytes);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt']);

    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const pt = new TextEncoder().encode('hello 128-bit');

    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
    const dt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    t.equal(new TextDecoder().decode(dt), 'hello 128-bit', 'round-trip');
  });

  it('wrong tag causes decryption failure', async (t) => {
    const keyBytes = new Uint8Array(32);
    crypto.getRandomValues(keyBytes);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

    const iv = new Uint8Array(12);
    const pt = new TextEncoder().encode('tamper me');

    const ct    = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
    const ctArr = new Uint8Array(ct);
    if (ctArr[0] !== undefined) ctArr[0] ^= 0xff;

    let threw = false;
    try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ctArr.buffer); } catch (_) { threw = true; }
    t.ok(threw, 'decryption throws on tampered ciphertext');
  });
});

describe('AES-CBC', { skip }, () => {
  it('256-bit encrypt/decrypt round-trip', async (t) => {
    const keyBytes = new Uint8Array(32);
    crypto.getRandomValues(keyBytes);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC', length: 256 }, false, ['encrypt', 'decrypt']);

    const iv = new Uint8Array(16);
    crypto.getRandomValues(iv);
    const pt = new TextEncoder().encode('AES-CBC test');

    const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, pt);
    t.ok(ct instanceof ArrayBuffer, 'ciphertext is ArrayBuffer');
    t.ok(ct.byteLength % 16 === 0, 'CBC output is multiple of block size');

    const dt = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ct);
    t.equal(new TextDecoder().decode(dt), 'AES-CBC test', 'round-trip');
  });

  it('AES-128-CBC known-answer vector (NIST CAVP)', async (t) => {
    // NIST CAVP AES-CBC 128-bit vector (first vector from CBCGFSbox128.rsp):
    //   Key:   00000000000000000000000000000000
    //   IV:    00000000000000000000000000000000
    //   PT:    f34481ec3cc627bacd5dc3fb08f273e6
    //   CT:    0336763e966d92595a567cc9ce537f5e
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(16).fill(0),
      { name: 'AES-CBC', length: 128 },
      false,
      ['encrypt'],
    );
    const iv = new Uint8Array(16).fill(0);
    const pt = new Uint8Array([0xf3,0x44,0x81,0xec,0x3c,0xc6,0x27,0xba,0xcd,0x5d,0xc3,0xfb,0x08,0xf2,0x73,0xe6]);
    const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, pt);
    // PKCS#7 padded output is 32 bytes; first 16 are the actual ciphertext.
    const ctHex = toHex(ct).slice(0, 32);
    t.equal(ctHex, '0336763e966d92595a567cc9ce537f5e', 'AES-128-CBC NIST known-answer');
  });
});

describe('Key management', { skip }, () => {
  it('importKey/exportKey raw round-trip', async (t) => {
    const keyBytes = new Uint8Array(32).fill(0x77);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

    t.ok(key.extractable, 'key is extractable');
    t.equal(key.type, 'secret', 'type is secret');
    t.equal(key.algorithm.name, 'AES-GCM', 'algorithm name');
    t.equal((key.algorithm as AesKeyAlgorithm).length, 256, 'key length');

    const exported = await crypto.subtle.exportKey('raw', key);
    t.ok(exported instanceof ArrayBuffer, 'exported is ArrayBuffer');
    t.deepEqual(Array.from(new Uint8Array(exported)), Array.from(keyBytes), 'exported bytes match');
  });

  it('exportKey fails for non-extractable key', async (t) => {
    const keyBytes = new Uint8Array(32);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    let threw = false;
    try { await crypto.subtle.exportKey('raw', key); } catch (_) { threw = true; }
    t.ok(threw, 'throws when not extractable');
  });

  it('generateKey AES-GCM produces correct length', async (t) => {
    const key256 = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    t.equal((key256.algorithm as AesKeyAlgorithm).length, 256, '256-bit key');

    const key128 = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt', 'decrypt']);
    t.equal((key128.algorithm as AesKeyAlgorithm).length, 128, '128-bit key');
  });

  it('generateKey HMAC produces usable key', async (t) => {
    const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    t.equal(key.algorithm.name, 'HMAC', 'HMAC key');
    t.ok(key.usages.includes('sign'), 'has sign usage');

    const data = new TextEncoder().encode('test');
    const sig  = await crypto.subtle.sign({ name: 'HMAC' }, key, data);
    t.ok(sig instanceof ArrayBuffer, 'sign works');
  });
});

// ---------------------------------------------------------------------------
// PBKDF2
// ---------------------------------------------------------------------------

describe('PBKDF2', { skip }, () => {
  it('deriveBits — RFC 6070 case 1 (SHA-1)', async (t) => {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode('password'), { name: 'PBKDF2' }, false, ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode('salt'), iterations: 1, hash: 'SHA-1' },
      key, 160,
    );
    const hex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
    t.equal(hex, '0c60c80f961f0e71f3a9b524af6012062fe037a6', 'RFC 6070 case 1');
  });

  it('deriveBits — RFC 6070 case 2 (SHA-1, 2 iterations)', async (t) => {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode('password'), { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode('salt'), iterations: 2, hash: 'SHA-1' },
      key, 160,
    );
    const hex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
    t.equal(hex, 'ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957', 'RFC 6070 case 2');
  });

  it('deriveBits — SHA-256 1000 iterations', async (t) => {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode('password'), { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode('salt'), iterations: 1000, hash: 'SHA-256' },
      key, 256,
    );
    const hex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
    t.equal(hex, '632c2812e46d4604102ba7618e9d6d7d2f8128f6266b4a03264d2a0460b7dcb3', 'SHA-256 1000 iterations');
  });

  it('deriveKey — produces a usable AES-GCM key', async (t) => {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey('raw', enc.encode('my-password'), { name: 'PBKDF2' }, false, ['deriveKey']);
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode('my-salt'), iterations: 1000, hash: 'SHA-256' },
      baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    t.equal(aesKey.algorithm.name, 'AES-GCM', 'derived key is AES-GCM');
    t.equal((aesKey.algorithm as AesKeyAlgorithm).length, 256, 'key length is 256');
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode('hello pbkdf2'));
    const dt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
    t.equal(new TextDecoder().decode(dt), 'hello pbkdf2', 'round-trip with derived key');
  });
});

// ---------------------------------------------------------------------------
// HKDF
// ---------------------------------------------------------------------------

describe('HKDF', { skip }, () => {
  it('deriveBits — RFC 5869 test case 1 (SHA-256)', async (t) => {
    const ikm  = new Uint8Array(22).fill(0x0b);
    const salt = new Uint8Array([0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0a,0x0b,0x0c]);
    const info = new Uint8Array([0xf0,0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,0xf9]);
    const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info }, key, 336,
    );
    const hex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
    t.equal(
      hex,
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
      'RFC 5869 case 1 OKM',
    );
  });

  it('deriveBits — RFC 5869 test case 2 (SHA-256)', async (t) => {
    const ikm  = new Uint8Array(80); for (let i = 0; i < 80; i++) ikm[i]  = i;
    const salt = new Uint8Array(80); for (let i = 0; i < 80; i++) salt[i] = 0x60 + i;
    const info = new Uint8Array(80); for (let i = 0; i < 80; i++) info[i] = 0xb0 + i;
    const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info }, key, 656,
    );
    const hex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
    t.equal(
      hex,
      'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87',
      'RFC 5869 case 2 OKM',
    );
  });

  it('deriveKey — produces a usable AES-GCM key', async (t) => {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey('raw', enc.encode('input-key-material'), { name: 'HKDF' }, false, ['deriveKey']);
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('salt'), info: enc.encode('app-context') },
      baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    t.equal(aesKey.algorithm.name, 'AES-GCM', 'derived key is AES-GCM');
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode('hello hkdf'));
    const dt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
    t.equal(new TextDecoder().decode(dt), 'hello hkdf', 'round-trip with HKDF-derived key');
  });

  it('deriveKey — produces a usable AES-CBC key', async (t) => {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey('raw', enc.encode('aes-cbc-ikm'), { name: 'HKDF' }, false, ['deriveKey']);
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('salt'), info: enc.encode('cbc-context') },
      baseKey, { name: 'AES-CBC', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    t.equal(aesKey.algorithm.name, 'AES-CBC', 'derived key is AES-CBC');
    const iv = new Uint8Array(16);
    crypto.getRandomValues(iv);
    const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, aesKey, enc.encode('hello cbc'));
    const dt = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, ct);
    t.equal(new TextDecoder().decode(dt), 'hello cbc', 'round-trip with HKDF-derived AES-CBC key');
  });

  it('throws when requested key length exceeds 255 * hashLen (n > 255 guard)', async (t) => {
    const ikm = new TextEncoder().encode('input');
    const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
    // SHA-256 hashLen = 32 bytes; 256 * 32 = 8192 bytes + 1 = just over the limit
    const tooLarge = 256 * 32 + 1;
    try {
      await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new Uint8Array(0) }, key, tooLarge * 8);
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'throws an Error for oversized derivation');
      t.ok((err as Error).message.toLowerCase().includes('large') || (err as Error).message.includes('255'), 'error mentions the limit');
    }
  });
});

// ---------------------------------------------------------------------------
// Additional tests
// ---------------------------------------------------------------------------

describe('getRandomValues — additional', { skip }, () => {
  it('throws for Float32Array (disallowed type)', (t) => {
    t.throws(() => crypto.getRandomValues(new Float32Array(4)), null, 'Float32Array throws');
  });

  it('throws for Float64Array (disallowed type)', (t) => {
    t.throws(() => crypto.getRandomValues(new Float64Array(4)), null, 'Float64Array throws');
  });

  it('throws for buffers larger than 65536 bytes', (t) => {
    t.throws(() => crypto.getRandomValues(new Uint8Array(65537)), null, 'quota exceeded throws');
  });
});

describe('subtle.digest — additional', { skip }, () => {
  it('SHA-256 with algorithm object form', async (t) => {
    const data = new TextEncoder().encode('abc');
    const result = await crypto.subtle.digest({ name: 'SHA-256' }, data);
    const hex = toHex(result);
    t.equal(hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'SHA-256 object form');
  });

  it('SHA-384 "abc"', async (t) => {
    const data = new TextEncoder().encode('abc');
    const result = await crypto.subtle.digest('SHA-384', data);
    const hex = toHex(result);
    t.equal(hex, 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7', 'SHA-384("abc")');
  });
});

describe('HMAC — additional', { skip }, () => {
  it('HMAC with SHA-512', async (t) => {
    const keyBytes = new Uint8Array(64).fill(0x42);
    const key = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign', 'verify'],
    );
    const data = new TextEncoder().encode('hello');
    const sig = await crypto.subtle.sign({ name: 'HMAC' }, key, data);
    t.ok(sig instanceof ArrayBuffer, 'signature is ArrayBuffer');
    t.equal(sig.byteLength, 64, '64 bytes for HMAC-SHA512');
    const valid = await crypto.subtle.verify({ name: 'HMAC' }, key, sig, data);
    t.ok(valid, 'HMAC-SHA512 verifies');
  });
});

describe('AES-GCM — additional', { skip }, () => {
  it('encrypt/decrypt with additionalData (AAD)', async (t) => {
    const keyBytes = new Uint8Array(32);
    crypto.getRandomValues(keyBytes);
    const key = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    const iv  = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const aad       = new TextEncoder().encode('authenticated header');
    const plaintext = new TextEncoder().encode('secret body');

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad }, key, plaintext,
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad }, key, ciphertext,
    );
    t.equal(new TextDecoder().decode(decrypted), 'secret body', 'AAD round-trip');
  });
});

describe('AES-CBC — additional', { skip }, () => {
  it('128-bit generate + encrypt + decrypt', async (t) => {
    const key = await crypto.subtle.generateKey({ name: 'AES-CBC', length: 128 }, true, ['encrypt', 'decrypt']);
    t.equal((key.algorithm as AesKeyAlgorithm).length, 128, '128-bit key');
    const iv = new Uint8Array(16);
    crypto.getRandomValues(iv);
    const pt = new TextEncoder().encode('AES-CBC 128-bit test');
    const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, pt);
    t.ok(ct instanceof ArrayBuffer, 'ciphertext is ArrayBuffer');
    t.ok(ct.byteLength % 16 === 0, 'CBC output is multiple of block size');
    const dt = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ct);
    t.equal(new TextDecoder().decode(dt), 'AES-CBC 128-bit test', '128-bit round-trip');
  });
});

describe('getRandomValues — integer typed arrays', { skip }, () => {
  it('works with Int8Array', (t) => {
    const arr = new Int8Array(16);
    const result = crypto.getRandomValues(arr);
    t.ok(result === arr, 'returns same array');
  });

  it('works with Int16Array', (t) => {
    const arr = new Int16Array(8);
    const result = crypto.getRandomValues(arr);
    t.ok(result === arr, 'returns same array');
  });

  it('works with Int32Array', (t) => {
    const arr = new Int32Array(4);
    const result = crypto.getRandomValues(arr);
    t.ok(result === arr, 'returns same array');
  });

  it('works with Uint8ClampedArray', (t) => {
    const arr = new Uint8ClampedArray(16);
    const result = crypto.getRandomValues(arr);
    t.ok(result === arr, 'returns same array');
  });
});

describe('importKey / exportKey — JWK format (symmetric keys)', () => {
  it('AES-GCM 256 key round-trips via JWK', async (t) => {
    const keyBytes = new Uint8Array(32).fill(0x42);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const jwk = await crypto.subtle.exportKey('jwk', key) as { kty: string; k: string; alg: string; key_ops: string[] };
    t.equal(jwk.kty, 'oct', 'kty is oct');
    t.equal(jwk.alg, 'A256GCM', 'alg is A256GCM');
    t.ok(jwk.k.length > 0, 'k field present');
    t.ok(Array.isArray(jwk.key_ops), 'key_ops is array');
    // Re-import from JWK and confirm key material matches
    const reimported = await crypto.subtle.importKey('jwk', jwk as any, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    const reExported = await crypto.subtle.exportKey('raw', reimported);
    t.equal(new Uint8Array(reExported).length, 32, 'round-trip key length correct');
  });

  it('AES-GCM 128 key exports with correct alg', async (t) => {
    const keyBytes = new Uint8Array(16).fill(0x11);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM', length: 128 }, true, ['encrypt']);
    const jwk = await crypto.subtle.exportKey('jwk', key) as { alg: string };
    t.equal(jwk.alg, 'A128GCM', 'alg is A128GCM for 128-bit key');
  });

  it('HMAC SHA-256 key round-trips via JWK', async (t) => {
    const keyBytes = new Uint8Array(32).fill(0xAB);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', key) as { kty: string; alg: string };
    t.equal(jwk.kty, 'oct', 'kty is oct');
    t.equal(jwk.alg, 'HS256', 'alg is HS256');
  });

  it('importKey with "spki" format still throws (not yet implemented)', async (t) => {
    const keyBytes = new Uint8Array(32);
    let threw = false;
    try {
      await crypto.subtle.importKey('spki' as any, keyBytes, { name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    } catch (_) { threw = true; }
    t.ok(threw, 'spki format not yet supported');
  });

  it('exportKey with "pkcs8" format throws (not yet implemented)', async (t) => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    let threw = false;
    try {
      await crypto.subtle.exportKey('pkcs8' as any, key as CryptoKey);
    } catch (_) { threw = true; }
    t.ok(threw, 'pkcs8 format not yet supported');
  });
});

describe('wrapKey / unwrapKey', () => {
  it('wraps and unwraps a raw AES key with AES-GCM', async (t) => {
    const wrappingKeyBytes = new Uint8Array(32);
    crypto.getRandomValues(wrappingKeyBytes);
    const wrappingKey = await crypto.subtle.importKey('raw', wrappingKeyBytes, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);

    const targetKeyBytes = new Uint8Array(32).fill(0x55);
    const targetKey = await crypto.subtle.importKey('raw', targetKeyBytes, { name: 'AES-GCM', length: 256 }, true, ['encrypt']);

    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const wrapAlg = { name: 'AES-GCM', iv };

    const wrapped = await crypto.subtle.wrapKey('raw', targetKey, wrappingKey, wrapAlg);
    t.ok(wrapped instanceof ArrayBuffer, 'wrapped is ArrayBuffer');
    t.ok(wrapped.byteLength > 32, 'wrapped is larger than key (includes tag)');

    const unwrapped = await crypto.subtle.unwrapKey('raw', wrapped, wrappingKey, wrapAlg, { name: 'AES-GCM' }, true, ['encrypt']);
    const unwrappedBytes = new Uint8Array(await crypto.subtle.exportKey('raw', unwrapped));
    t.equal(unwrappedBytes.length, 32, 'unwrapped key length correct');
    let same = true;
    for (let i = 0; i < 32; i++) if (unwrappedBytes[i] !== 0x55) { same = false; break; }
    t.ok(same, 'unwrapped key material matches original');
  });

  it('wrapKey throws if key is not extractable', async (t) => {
    const wrappingKeyBytes = new Uint8Array(32);
    const wrappingKey = await crypto.subtle.importKey('raw', wrappingKeyBytes, { name: 'AES-GCM', length: 256 }, false, ['wrapKey']);
    const nonExtractable = await crypto.subtle.importKey('raw', new Uint8Array(32), { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = new Uint8Array(12);
    let threw = false;
    try {
      await crypto.subtle.wrapKey('raw', nonExtractable, wrappingKey, { name: 'AES-GCM', iv });
    } catch (_) { threw = true; }
    t.ok(threw, 'wrapKey throws for non-extractable key');
  });

  it('wraps and unwraps via JWK format', async (t) => {
    const wrappingKeyBytes = new Uint8Array(32);
    crypto.getRandomValues(wrappingKeyBytes);
    const wrappingKey = await crypto.subtle.importKey('raw', wrappingKeyBytes, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);

    const targetKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) as CryptoKey;
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);

    const wrapped = await crypto.subtle.wrapKey('jwk', targetKey, wrappingKey, { name: 'AES-GCM', iv });
    t.ok(wrapped.byteLength > 0, 'jwk-wrapped key has bytes');

    const unwrapped = await crypto.subtle.unwrapKey('jwk', wrapped, wrappingKey, { name: 'AES-GCM', iv }, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    t.ok(unwrapped != null && typeof (unwrapped as CryptoKey).algorithm === 'object', 'unwrapped is CryptoKey-like');

    // Verify the unwrapped key produces the same ciphertext as the original — key material survived.
    const testData = new TextEncoder().encode('verify-wrap-round-trip');
    const iv2 = new Uint8Array(12);
    crypto.getRandomValues(iv2);
    const ct1 = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv2 }, targetKey, testData));
    const ct2 = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv2 }, unwrapped, testData));
    t.equal(ct1.length, ct2.length, 'ciphertext lengths match');
    let same = true;
    for (let i = 0; i < ct1.length; i++) if (ct1[i] !== ct2[i]) { same = false; break; }
    t.ok(same, 'unwrapped JWK key produces identical ciphertext — key material intact');
  });
});

describe('subtle.digest — unsupported algorithm', { skip }, () => {
  it('digest with unknown algorithm throws', async (t) => {
    let threw = false;
    try {
      await crypto.subtle.digest('MD5' as any, new Uint8Array(4));
    } catch (_) {
      threw = true;
    }
    t.ok(threw, 'unsupported digest algorithm throws');
  });
});

describe('AES-GCM — wrong AAD causes decryption failure', { skip }, () => {
  it('decrypt with wrong AAD throws or returns wrong data', async (t) => {
    const keyBytes = new Uint8Array(32);
    crypto.getRandomValues(keyBytes);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const aad = new TextEncoder().encode('correct header');
    const wrongAad = new TextEncoder().encode('wrong header');
    const plaintext = new TextEncoder().encode('secret body');

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad }, key, plaintext,
    );

    let threw = false;
    try {
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: wrongAad }, key, ciphertext,
      );
    } catch (_) {
      threw = true;
    }
    t.ok(threw, 'decryption with wrong AAD fails');
  });
});

describe('Key management — additional', { skip }, () => {
  it('exportKey round-trip for HMAC key', async (t) => {
    const keyBytes = new Uint8Array(32).fill(0xAB);
    const key = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, true, ['sign', 'verify'],
    );
    const exported = await crypto.subtle.exportKey('raw', key);
    t.ok(exported instanceof ArrayBuffer, 'exported is ArrayBuffer');
    t.deepEqual(
      Array.from(new Uint8Array(exported)),
      Array.from(keyBytes),
      'exported HMAC key bytes match original',
    );
  });

  it('importKey rejects unsupported algorithm', async (t) => {
    const keyBytes = new Uint8Array(32);
    let threw = false;
    try {
      await crypto.subtle.importKey('raw', keyBytes, { name: 'RSA-OAEP' }, false, ['encrypt']);
    } catch (_) {
      threw = true;
    }
    t.ok(threw, 'unsupported algorithm throws');
  });

  it('PBKDF2 key is not extractable', async (t) => {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode('password'), { name: 'PBKDF2' }, false, ['deriveBits'],
    );
    t.equal(key.extractable, false, 'PBKDF2 key is not extractable');
  });

  it('CryptoKey [Symbol.toStringTag] is "CryptoKey"', async (t) => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    t.equal((key as unknown as SymbolRecord)[Symbol.toStringTag], 'CryptoKey');
  });

  it('CryptoKey.usages returns a frozen array', async (t) => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const usages = key.usages;
    t.ok(Object.isFrozen(usages), 'usages array is frozen');
    t.ok(Array.isArray(usages), 'usages is an array');
  });

  it('CryptoKey.usages returns a copy each time', async (t) => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const u1 = key.usages;
    const u2 = key.usages;
    t.ok(u1 !== u2, 'each call returns a different array reference');
  });
});

describe('crypto and subtle [Symbol.toStringTag]', { skip }, () => {
  it('crypto[Symbol.toStringTag] is "Crypto"', (t) => {
    t.equal((crypto as unknown as SymbolRecord)[Symbol.toStringTag], 'Crypto', 'crypto toStringTag');
  });

  it('crypto.subtle[Symbol.toStringTag] is "SubtleCrypto"', (t) => {
    t.equal((crypto.subtle as unknown as SymbolRecord)[Symbol.toStringTag], 'SubtleCrypto', 'subtle toStringTag');
  });
});

describe('getRandomValues — additional coverage', { skip }, () => {
  it('fills Int8Array', (t) => {
    const arr = new Int8Array(8);
    const result = crypto.getRandomValues(arr);
    t.ok(result === arr, 'returns same array');
    t.ok(arr instanceof Int8Array, 'still Int8Array');
  });

  it('fills Uint32Array', (t) => {
    const arr = new Uint32Array(4);
    crypto.getRandomValues(arr);
    const allZero = Array.from(arr).every(v => v === 0);
    t.ok(!allZero, 'not all zero');
  });

  it('works with non-zero byteOffset view', (t) => {
    const buf = new ArrayBuffer(16);
    const view = new Uint8Array(buf, 4, 8); // byteOffset=4, byteLength=8
    crypto.getRandomValues(view);
    // The first 4 bytes (before the view) should be 0
    const prefix = new Uint8Array(buf, 0, 4);
    t.deepEqual(Array.from(prefix), [0, 0, 0, 0], 'bytes before view unchanged');
  });
});


describe('Key usage validation', { skip }, () => {
  it('sign with a verify-only HMAC key throws', async (t) => {
    const key = await crypto.subtle.importKey(
      'raw', new Uint8Array(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    t.ok(key.usages.includes('verify') && !key.usages.includes('sign'), 'key has only verify usage');
    await t.rejects(
      () => crypto.subtle.sign('HMAC', key, new Uint8Array([1, 2, 3])),
      undefined,
      'sign with verify-only key rejects',
    );
  });
});

describe('digest — plain ArrayBuffer input', { skip }, () => {
  it('digest() accepts a plain ArrayBuffer', async (t) => {
    const data = new TextEncoder().encode('hello').buffer;
    t.ok(data instanceof ArrayBuffer, 'is ArrayBuffer');
    const hash = await crypto.subtle.digest('SHA-256', data);
    t.ok(hash instanceof ArrayBuffer, 'returns ArrayBuffer');
    t.equal(hash.byteLength, 32, 'SHA-256 is 32 bytes');
  });
});

describe('HKDF — edge cases', { skip }, () => {
  it('HKDF with empty salt and info', async (t) => {
    const enc = new TextEncoder();
    const rawKey = await crypto.subtle.importKey(
      'raw', enc.encode('secret'), { name: 'HKDF' }, false, ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new Uint8Array(0) },
      rawKey,
      256,
    );
    t.ok(bits instanceof ArrayBuffer, 'returns ArrayBuffer');
    t.equal(bits.byteLength, 32, '256 bits = 32 bytes');
  });
});

describe('deriveKey — PBKDF2 to HMAC', { skip }, () => {
  it('PBKDF2 can derive an HMAC key', async (t) => {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw', enc.encode('password'), { name: 'PBKDF2' }, false, ['deriveKey'],
    );
    const hmacKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: new Uint8Array(16), iterations: 1000, hash: 'SHA-256' },
      baseKey,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    t.equal(hmacKey.type, 'secret', 'derived HMAC key is secret type');
    t.ok(hmacKey.usages.includes('sign'), 'has sign usage');
    t.ok(hmacKey.usages.includes('verify'), 'has verify usage');
  });
});

describe('AES-GCM — non-default tagLength', { skip }, () => {
  it('encrypt/decrypt with tagLength: 96', async (t) => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode('hello tagLength');
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 96 },
      key,
      data,
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 96 },
      key,
      encrypted,
    );
    t.equal(new TextDecoder().decode(decrypted), 'hello tagLength', 'roundtrip with tagLength 96');
  });
});

describe('Key usage enforcement', { skip }, () => {
  it('encrypt with verify-only key throws', async (t) => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['decrypt']);
    const iv = new Uint8Array(12);
    await t.rejects(
      async () => crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(8)),
      undefined,
      'encrypt with decrypt-only key throws',
    );
  });

  it('sign with verify-only HMAC key throws', async (t) => {
    const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    await t.rejects(
      async () => crypto.subtle.sign('HMAC', key, new Uint8Array(8)),
      undefined,
      'sign with verify-only key throws',
    );
  });
});

describe('crypto.getRandomValues — BigInt typed arrays', () => {
  it('fills BigInt64Array with random bytes', (t) => {
    const arr = new BigInt64Array(4);
    const result = crypto.getRandomValues(arr);
    t.ok(result === arr, 'returns same view');
    t.equal(result.byteLength, 32, 'byteLength unchanged');
  });

  it('fills BigUint64Array with random bytes', (t) => {
    const arr = new BigUint64Array(2);
    const result = crypto.getRandomValues(arr);
    t.ok(result === arr, 'returns same view');
  });
});

describe('crypto.subtle — 192-bit AES key rejection', () => {
  it('importKey rejects 192-bit AES key', async (t) => {
    const key192 = new Uint8Array(24).fill(1); // 24 bytes = 192 bits
    await t.rejects(
      async () => crypto.subtle.importKey('raw', key192, 'AES-GCM', true, ['encrypt', 'decrypt']),
      /128|256|bits|length/i,
      '192-bit AES key importKey throws with key size error',
    );
  });
});
