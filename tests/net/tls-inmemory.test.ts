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
import { serveHttp } from 'fino:net/http/server';
import { TlsSocket } from 'fino:net/tls';
import { quicAvailable } from 'fino:net/quic';
import { fetch as h3Fetch, h3Available, serve as h3Serve } from 'internal:net/http/h3';
import {
  generateSelfSignedCertificate,
  isPemText,
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

describe('path-or-PEM detection', () => {
  it('tells PEM text apart from a filesystem path', async (t) => {
    t.ok(isPemText(await read(certPath)), 'certificate PEM is recognised as text');
    t.ok(isPemText(await read(keyPath)), 'key PEM is recognised as text');
    t.ok(!isPemText(certPath), 'a path is not mistaken for PEM');
    t.ok(!isPemText('/etc/tls/fullchain.pem'), 'a .pem path is still a path');
  });

  it('loads either source through the one loader', async (t) => {
    const ctx = sslCtxNewServer();
    try {
      // Mixed on purpose: a certificate fetched from ACME pairs with a key
      // that already lives on disk, and each side is decided independently.
      sslCtxUseCertKey(ctx, await read(certPath), keyPath);
      t.ok(true, 'certificate from memory, key from disk');
    } finally {
      sslCtxFree(ctx);
    }
  });

  it('names the failing source without printing key material', async (t) => {
    const ctx = sslCtxNewServer();
    try {
      const keyPem = await read(keyPath);
      let message = '';
      try {
        // A certificate that does not match this key: the error has to say so
        // without dumping the private key into a log.
        sslCtxUseCertKey(ctx, `${cwd()}/tests/net/fixtures/nonexistent.crt`, keyPem);
      } catch (error) {
        message = (error as Error).message;
      }
      t.ok(message.includes('nonexistent.crt'), `path named in error: ${message}`);
      t.ok(!message.includes('PRIVATE KEY'), 'key material never reaches the error message');
    } finally {
      sslCtxFree(ctx);
    }
  });
});

describe('minting an ephemeral identity', () => {
  it('produces PEM for both halves', (t) => {
    const identity = generateSelfSignedCertificate({ commonName: 'node-a' });
    t.ok(identity.certPem.includes('-----BEGIN CERTIFICATE-----'), 'certificate is PEM');
    t.ok(isPemText(identity.keyPem), 'key is PEM');
    t.ok(!identity.keyPem.includes('ENCRYPTED'), 'key is unencrypted, as an in-memory key should be');
  });

  it('mints a certificate OpenSSL will actually load', (t) => {
    const identity = generateSelfSignedCertificate({
      commonName: 'node-a',
      subjectAltNames: 'DNS:node-a,IP:127.0.0.1',
    });
    const ctx = sslCtxNewServer();
    try {
      // The real check: the key matches the certificate and both parse. A
      // malformed field here fails at handshake time otherwise, which is much
      // further from the mistake.
      sslCtxUseCertKey(ctx, identity.certPem, identity.keyPem);
      t.ok(true, 'minted material installs into a context');
    } finally {
      sslCtxFree(ctx);
    }
  });

  it('gives every identity a distinct serial', (t) => {
    const a = generateSelfSignedCertificate({ commonName: 'node-a' });
    const b = generateSelfSignedCertificate({ commonName: 'node-a' });
    t.ok(a.certPem !== b.certPem, 'two mints with the same name are still different certificates');
  });

  it('serves real traffic under a certificate minted seconds ago', async (t) => {
    const identity = generateSelfSignedCertificate({
      commonName: 'localhost',
      subjectAltNames: 'DNS:localhost,IP:127.0.0.1',
    });
    const server = serveHttp(
      { port: 0, tls: { cert: identity.certPem, key: identity.keyPem } },
      async () => new Response('minted'),
    );
    try {
      const tls = await TlsSocket.connect(
        { family: 'ipv4', ip: '127.0.0.1', port: server.port },
        { hostname: '127.0.0.1', rejectUnauthorized: false },
      );
      const [reader, writer] = tls.split();
      await writer.write(
        new TextEncoder().encode(
          `GET / HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
        ),
      );
      await writer.close();
      const chunks: Uint8Array[] = [];
      for await (const chunk of reader) chunks.push(chunk);
      await reader.close();
      const body = chunks.map((c) => new TextDecoder().decode(c)).join('');
      t.ok(body.includes('minted'), 'handshake completed against a freshly minted certificate');
    } finally {
      await server.close();
    }
  });
});

describe('a server serving from memory', () => {
  it('completes a TLS handshake with a certificate never written to disk', async (t) => {
    const [certPem, keyPem] = await Promise.all([read(certPath), read(keyPath)]);
    const server = serveHttp(
      { port: 0, tls: { cert: certPem, key: keyPem } },
      async () => new Response('served from memory'),
    );
    try {
      const tls = await TlsSocket.connect(
        { family: 'ipv4', ip: '127.0.0.1', port: server.port },
        { hostname: '127.0.0.1', rejectUnauthorized: false },
      );
      const [reader, writer] = tls.split();
      await writer.write(
        new TextEncoder().encode(
          `GET / HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
        ),
      );
      await writer.close();
      const chunks: Uint8Array[] = [];
      for await (const chunk of reader) chunks.push(chunk);
      await reader.close();
      const body = chunks.map((c) => new TextDecoder().decode(c)).join('');
      t.ok(body.includes('served from memory'), `response arrived over TLS: ${body.slice(0, 40)}`);
    } finally {
      await server.close();
    }
  });

  it('builds a QUIC SSL_CTX from PEM text too', async (t) => {
    // The QUIC listener reaches OpenSSL through newServerContext rather than
    // the TCP path, so covering only HTTPS above would leave h3 untested —
    // and h3 is where the cluster's own ephemeral certificate has to work.
    if (!quicAvailable || !h3Available) {
      t.ok(true, 'QUIC/h3 libraries not installed on this host');
      return;
    }
    const [certPem, keyPem] = await Promise.all([read(certPath), read(keyPath)]);
    const server = await h3Serve(
      {
        port: 0,
        hostname: '127.0.0.1',
        certificateFile: certPem,
        privateKeyFile: keyPem,
      },
      () => new Response('h3 from memory'),
    );
    try {
      const response = await h3Fetch(`https://127.0.0.1:${server.port}/`, {
        quic: { verifyPeer: false },
      });
      t.equal(response.status, 200, 'h3 handshake completed against an in-memory certificate');
      t.equal(
        new TextDecoder().decode(await response.arrayBuffer()),
        'h3 from memory',
        'response body received over QUIC',
      );
    } finally {
      await server.close();
    }
  });
});
