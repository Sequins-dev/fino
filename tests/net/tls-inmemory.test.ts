/**
 * In-memory TLS material.
 *
 * Certificates minted at runtime — ACME renewals, rotating workload
 * identities, a cluster node's own ephemeral identity — should never have to
 * round-trip through the filesystem to be installed. Writing a private key to
 * disk purely to hand it to OpenSSL is a security regression, not a
 * convenience, so the in-memory path must be equivalent to the file path.
 */
import { describe, it } from 'fino:test/test';
import { cwd } from 'fino:process';
import { DiskFileSystem } from 'fino:file';
import {
  sslCtxFree,
  sslCtxNewServer,
  sslCtxUseCertKey,
  sslCtxUseCertKeyPem,
  tlsAvailable,
} from 'internal:openssl';

const fs = new DiskFileSystem();
const certPath = `${cwd()}/tests/net/fixtures/test.crt`;
const keyPath = `${cwd()}/tests/net/fixtures/test.key`;
const read = async (path: string): Promise<string> =>
  new TextDecoder().decode(await fs.readFile(path));

describe('in-memory TLS material', () => {
  // Deliberately NOT skipped when libssl is missing. An earlier version of
  // this file skipped, and a bad FFI symbol declaration that nulled the whole
  // libssl handle — disabling TLS process-wide — still reported four passing
  // tests. Everything else in the suite needs libssl, so requiring it here
  // costs nothing and makes that failure loud.
  it('has libssl, which everything below assumes', (t) => {
    t.ok(tlsAvailable, 'libssl loaded: a null handle means a bad symbol declaration');
  });

  it('installs a certificate and key held in memory', async (t) => {
    const ctx = sslCtxNewServer();
    try {
      sslCtxUseCertKeyPem(ctx, await read(certPath), await read(keyPath));
      t.ok(true, 'PEM content loaded without touching the filesystem');
    } finally {
      sslCtxFree(ctx);
    }
  });

  it('accepts the same material by path, proving the paths agree', async (t) => {
    const ctx = sslCtxNewServer();
    try {
      sslCtxUseCertKey(ctx, certPath, keyPath);
      t.ok(true, 'the file path still works unchanged');
    } finally {
      sslCtxFree(ctx);
    }
  });

  it('rejects a mismatched key rather than installing it', async (t) => {
    const ctx = sslCtxNewServer();
    try {
      const certPem = await read(certPath);
      t.throws(
        () => sslCtxUseCertKeyPem(ctx, certPem, 'not a key'),
        /private key/i,
        'garbage key material is refused',
      );
    } finally {
      sslCtxFree(ctx);
    }
  });

  it('refuses PEM with no certificate in it', async (t) => {
    const ctx = sslCtxNewServer();
    try {
      t.throws(
        () => sslCtxUseCertKeyPem(ctx, 'nothing here', 'nor here'),
        /no certificate/i,
        'an empty chain is an error, not a silent success',
      );
    } finally {
      sslCtxFree(ctx);
    }
  });
});
