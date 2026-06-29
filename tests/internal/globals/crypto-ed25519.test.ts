/**
* Tests for Ed25519 WebCrypto operations:
* generateKey, raw/SPKI/PKCS8/JWK import/export, sign, and verify.
*
* All tests skip gracefully when OpenSSL is not available.
*/
import { describe, it } from 'fino:test/test';
const { crypto } = globalThis;
const cryptoAvailable = (globalThis as typeof globalThis & {
  cryptoAvailable?: boolean;
}).cryptoAvailable;
const skip = !cryptoAvailable && 'OpenSSL not available';
type CryptoKeyPair = {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
};
const MSG = new TextEncoder().encode('fino Ed25519 test message');
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
describe('Ed25519 — sign / verify', { skip }, () => {
  it('generates a key pair, signs, verifies, and rejects tampering', async (t) => {
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    t.equal(kp.privateKey.type, 'private', 'private key type');
    t.equal(kp.publicKey.type, 'public', 'public key type');
    t.equal(kp.privateKey.algorithm.name, 'Ed25519', 'private algorithm name');
    t.equal(kp.publicKey.algorithm.name, 'Ed25519', 'public algorithm name');
    t.ok(kp.privateKey.usages.includes('sign'), 'private key signs');
    t.ok(kp.publicKey.usages.includes('verify'), 'public key verifies');
    const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', kp.privateKey, MSG));
    t.equal(sig.byteLength, 64, 'Ed25519 signature is 64 bytes');
    t.equal(await crypto.subtle.verify('Ed25519', kp.publicKey, sig, MSG), true, 'signature verifies');
    sig[0] ^= 255;
    t.equal(await crypto.subtle.verify('Ed25519', kp.publicKey, sig, MSG), false, 'tampered signature fails');
  });
  it('enforces key type and usages', async (t) => {
    const signOnly = await crypto.subtle.generateKey('ED25519', true, ['sign']) as CryptoKeyPair;
    const verifyOnly = await crypto.subtle.generateKey('Ed25519', true, ['verify']) as CryptoKeyPair;
    await t.rejects(() => crypto.subtle.sign('Ed25519', signOnly.publicKey, MSG), (err) => err instanceof Error, 'public key cannot sign');
    await t.rejects(() => crypto.subtle.verify('Ed25519', signOnly.privateKey, new Uint8Array(64), MSG), (err) => err instanceof Error, 'private key cannot verify');
    await t.rejects(() => crypto.subtle.sign('Ed25519', verifyOnly.privateKey, MSG), (err) => err instanceof Error, 'private key without sign usage cannot sign');
  });
});
describe('Ed25519 — import / export', { skip }, () => {
  it('raw public key export/import round-trips', async (t) => {
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    t.equal(raw.byteLength, 32, 'raw Ed25519 public key is 32 bytes');
    const imported = await crypto.subtle.importKey('raw', raw, 'Ed25519', true, ['verify']);
    const sig = await crypto.subtle.sign('Ed25519', kp.privateKey, MSG);
    t.equal(await crypto.subtle.verify('Ed25519', imported, sig, MSG), true, 'imported raw public key verifies');
  });
  it('rejects raw private export/import and malformed raw public keys', async (t) => {
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    await t.rejects(() => crypto.subtle.exportKey('raw', kp.privateKey), (err) => err instanceof Error, 'raw private export is not supported');
    await t.rejects(() => crypto.subtle.importKey('raw', new Uint8Array(31), 'Ed25519', true, ['verify']), (err) => err instanceof Error, 'short raw public key rejects');
  });
  it('SPKI and PKCS8 round-trip through sign/verify', async (t) => {
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    t.ok(spki instanceof ArrayBuffer && spki.byteLength > 32, 'SPKI is DER bytes');
    t.ok(pkcs8 instanceof ArrayBuffer && pkcs8.byteLength > 32, 'PKCS8 is DER bytes');
    const publicKey = await crypto.subtle.importKey('spki', spki, 'Ed25519', true, ['verify']);
    const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
    const sig = await crypto.subtle.sign('Ed25519', privateKey, MSG);
    t.equal(await crypto.subtle.verify('Ed25519', publicKey, sig, MSG), true, 'DER imported keys verify');
  });
  it('OKP JWK public/private export/import round-trips', async (t) => {
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    const publicJwk = await crypto.subtle.exportKey('jwk', kp.publicKey) as {
      kty: string;
      crv: string;
      x: string;
      d?: string;
    };
    const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey) as {
      kty: string;
      crv: string;
      x: string;
      d: string;
    };
    t.equal(publicJwk.kty, 'OKP', 'public JWK kty');
    t.equal(publicJwk.crv, 'Ed25519', 'public JWK curve');
    t.equal(typeof publicJwk.x, 'string', 'public JWK has x');
    t.equal(publicJwk.d, undefined, 'public JWK omits d');
    t.equal(privateJwk.kty, 'OKP', 'private JWK kty');
    t.equal(privateJwk.crv, 'Ed25519', 'private JWK curve');
    t.equal(typeof privateJwk.d, 'string', 'private JWK has d');
    const publicKey = await crypto.subtle.importKey('jwk', publicJwk as BufferSource, 'Ed25519', true, ['verify']);
    const privateKey = await crypto.subtle.importKey('jwk', privateJwk as BufferSource, 'Ed25519', true, ['sign']);
    const sig = await crypto.subtle.sign('Ed25519', privateKey, MSG);
    t.equal(await crypto.subtle.verify('Ed25519', publicKey, sig, MSG), true, 'JWK imported keys verify');
  });
  it('raw public key matches JWK x coordinate', async (t) => {
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey) as {
      x: string;
    };
    const decoded = Uint8Array.from(atob(jwk.x.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - jwk.x.length % 4) % 4)), (c) => c.charCodeAt(0));
    t.equal(equalBytes(raw, decoded), true, 'raw public key equals JWK x');
  });
});
