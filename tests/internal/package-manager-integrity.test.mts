/**
 * Tests for verifyTarballIntegrity in internal:package_manager.
 *
 * These tests are hermetic: they compute SRI / SHA-1 over a known byte
 * sequence at runtime using the same openssl helpers the production code
 * uses, so they don't rely on external packages or network access.
 */

import { describe, it } from 'fino:test/test';
import { verifyTarballIntegrity } from '../../js/internal/package_manager.mts';
import * as openssl from '../../js/internal/openssl.mts';

// ---------------------------------------------------------------------------
// Helpers to derive correct digests for a test payload
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let b64 = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    b64 += chars[b0 >> 2]!;
    b64 += chars[((b0 & 3) << 4) | (b1 >> 4)]!;
    b64 += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)]! : '=';
    b64 += i + 2 < bytes.length ? chars[b2 & 63]! : '=';
  }
  return b64;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

const PAYLOAD = new TextEncoder().encode('fino test tarball payload');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyTarballIntegrity — SRI (dist.integrity)', () => {
  it('passes when sha256 SRI matches', (t) => {
    if (!openssl.cryptoAvailable) {
      t.ok(true, 'OpenSSL not available — skipping');
      return;
    }
    const digest = openssl.digest('sha-256', PAYLOAD);
    const integrity = `sha256-${toBase64(digest)}`;
    // Should not throw
    verifyTarballIntegrity(PAYLOAD, integrity, undefined, 'test-pkg@1.0.0');
    t.ok(true, 'valid sha256 integrity passed');
  });

  it('throws when sha256 SRI does not match', (t) => {
    if (!openssl.cryptoAvailable) {
      t.ok(true, 'OpenSSL not available — skipping');
      return;
    }
    const wrong = `sha256-${toBase64(new Uint8Array(32))}`;
    try {
      verifyTarballIntegrity(PAYLOAD, wrong, undefined, 'bad-pkg@1.0.0');
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'throws an Error');
      t.ok((err as Error).message.includes('bad-pkg'), 'error names the package');
    }
  });

  it('passes when sha512 SRI matches', (t) => {
    if (!openssl.cryptoAvailable) {
      t.ok(true, 'OpenSSL not available — skipping');
      return;
    }
    const digest = openssl.digest('sha-512', PAYLOAD);
    const integrity = `sha512-${toBase64(digest)}`;
    verifyTarballIntegrity(PAYLOAD, integrity, undefined, 'test-pkg@1.0.0');
    t.ok(true, 'valid sha512 integrity passed');
  });

  it('rejects unknown SRI algorithm without legacy shasum fallback', (t) => {
    if (!openssl.cryptoAvailable) {
      t.ok(true, 'OpenSSL not available — skipping');
      return;
    }
    t.throws(
      () => verifyTarballIntegrity(PAYLOAD, 'sha3-abc123', undefined, 'test-pkg@1.0.0'),
      /unsupported integrity algorithm/,
      'unknown algorithm rejected',
    );
  });
});

describe('verifyTarballIntegrity — shasum (dist.shasum, SHA-1 legacy)', () => {
  it('passes when SHA-1 hex matches', (t) => {
    if (!openssl.cryptoAvailable) {
      t.ok(true, 'OpenSSL not available — skipping');
      return;
    }
    const digest = openssl.digest('sha-1', PAYLOAD);
    const shasum = toHex(digest);
    verifyTarballIntegrity(PAYLOAD, undefined, shasum, 'test-pkg@1.0.0');
    t.ok(true, 'valid shasum passed');
  });

  it('throws when SHA-1 hex does not match', (t) => {
    if (!openssl.cryptoAvailable) {
      t.ok(true, 'OpenSSL not available — skipping');
      return;
    }
    const wrong = '0'.repeat(40); // all-zero SHA-1 — won't match
    try {
      verifyTarballIntegrity(PAYLOAD, undefined, wrong, 'sha1-fail-pkg@2.0.0');
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'throws an Error');
      t.ok((err as Error).message.includes('sha1-fail-pkg'), 'error names the package');
    }
  });

  it('integrity takes precedence over shasum when both are present', (t) => {
    if (!openssl.cryptoAvailable) {
      t.ok(true, 'OpenSSL not available — skipping');
      return;
    }
    const digest = openssl.digest('sha-256', PAYLOAD);
    const integrity = `sha256-${toBase64(digest)}`;
    // Pass a wrong shasum — should still pass because integrity wins
    verifyTarballIntegrity(PAYLOAD, integrity, '0'.repeat(40), 'test-pkg@1.0.0');
    t.ok(true, 'integrity took precedence over wrong shasum');
  });

  it('no-ops when neither integrity nor shasum is provided', (t) => {
    verifyTarballIntegrity(PAYLOAD, undefined, undefined, 'test-pkg@1.0.0');
    t.ok(true, 'undefined both fields is a no-op');
  });
});

describe('verifyTarballIntegrity — malformed / unrecognised SRI (B3)', () => {
  it('throws when integrity string has no "-" separator and no shasum', (t) => {
    try {
      verifyTarballIntegrity(PAYLOAD, 'deadbeefnoseparator', undefined, 'bad-pkg@1.0.0');
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'throws an Error');
      t.ok((err as Error).message.includes('bad-pkg'), 'error names the package');
    }
  });

  it('throws when integrity uses an unsupported algorithm and no shasum', (t) => {
    t.throws(
      () => verifyTarballIntegrity(PAYLOAD, 'md5-deadbeef', undefined, 'test-pkg@1.0.0'),
      /unsupported integrity algorithm/,
      'unknown algorithm rejected without legacy shasum fallback',
    );
  });

  it('falls through to shasum when integrity has unknown algorithm and shasum is correct', (t) => {
    if (!openssl.cryptoAvailable) {
      t.ok(true, 'OpenSSL not available — skipping');
      return;
    }
    const digest = openssl.digest('sha-1', PAYLOAD);
    const shasum = toHex(digest);
    // Unknown algorithm + valid shasum → should pass via shasum fallback
    verifyTarballIntegrity(PAYLOAD, 'md5-anything', shasum, 'test-pkg@1.0.0');
    t.ok(true, 'fell through to shasum successfully');
  });

  it('falls through to shasum when integrity has no "-" and shasum is correct', (t) => {
    if (!openssl.cryptoAvailable) {
      t.ok(true, 'OpenSSL not available — skipping');
      return;
    }
    const digest = openssl.digest('sha-1', PAYLOAD);
    const shasum = toHex(digest);
    verifyTarballIntegrity(PAYLOAD, 'malformed', shasum, 'test-pkg@1.0.0');
    t.ok(true, 'fell through to shasum for malformed integrity');
  });
});

describe('B3 regression: verifyTarballIntegrity throws on mismatch (cleanup guard)', () => {
  it('verifyTarballIntegrity throws for sha256 mismatch with a multi-value SRI', (t) => {
    if (!openssl.cryptoAvailable) {
      t.ok(true, 'OpenSSL not available — skipping');
      return;
    }
    // This test locks in the behavior after the multi-value SRI fix: the first
    // token is verified, and a mismatch still throws (not silently passes).
    const wrongHash = toBase64(new Uint8Array(32)); // all-zero hash
    try {
      verifyTarballIntegrity(PAYLOAD, `sha256-${wrongHash} sha512-ignored`, undefined, 'mismatch-pkg@1.0.0');
      t.fail('should have thrown on wrong first-token hash');
    } catch (err) {
      t.ok(err instanceof Error, 'throws Error on mismatch');
      t.ok((err as Error).message.includes('mismatch-pkg'), 'error names the package');
    }
  });
});

describe('verifyTarballIntegrity — multi-value SRI (space-separated)', () => {
  it('uses only the first token from a multi-value SRI string', (t) => {
    if (!openssl.cryptoAvailable) {
      t.ok(true, 'OpenSSL not available — skipping');
      return;
    }
    const digest = openssl.digest('sha-256', PAYLOAD);
    const correctHash = toBase64(digest);
    // First token is correct sha256; second token is garbage — should pass on first
    verifyTarballIntegrity(PAYLOAD, `sha256-${correctHash} sha512-garbage`, undefined, 'test-pkg@1.0.0');
    t.ok(true, 'multi-value SRI: first token verified, garbage second token ignored');
  });

  it('throws when first token of multi-value SRI does not match', (t) => {
    if (!openssl.cryptoAvailable) {
      t.ok(true, 'OpenSSL not available — skipping');
      return;
    }
    const wrongHash = toBase64(new Uint8Array(32)); // all-zero hash
    try {
      verifyTarballIntegrity(PAYLOAD, `sha256-${wrongHash} sha512-ignored`, undefined, 'bad-pkg@1.0.0');
      t.fail('should have thrown on wrong first-token hash');
    } catch (err) {
      t.ok(err instanceof Error, 'throws an Error');
      t.ok((err as Error).message.includes('bad-pkg'), 'error names the package');
    }
  });
});
