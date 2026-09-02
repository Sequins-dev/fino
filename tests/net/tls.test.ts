/**
 * Tests for fino:net/tls — TLS socket layer.
 *
 * These tests use the local HTTPS server fixtures so they do not depend on
 * public DNS or external network availability.
 */
import { describe, it } from 'fino:test/test';
import { serveHttp } from 'fino:net/http/server';
import { TlsSocket } from 'fino:net/tls';
import { Socket } from 'fino:net/socket';
import { h2Available } from '../../js/net/http/h2.ts';
const tlsAvailable = (
  globalThis as typeof globalThis & {
    tlsAvailable?: boolean;
  }
).tlsAvailable;
if (!tlsAvailable && (globalThis as any).process?.env?.FINO_REQUIRE_TLS === '1') {
  throw new Error('FINO_REQUIRE_TLS=1 but OpenSSL (libssl) is not available');
}
const skip = !tlsAvailable && 'OpenSSL (libssl) not available';
const skipAlpn =
  (!tlsAvailable || !h2Available) && 'requires OpenSSL + libnghttp2 ALPN server support';
const CERT_PATH = new URL('./fixtures/test.crt', import.meta.url).pathname;
const KEY_PATH = new URL('./fixtures/test.key', import.meta.url).pathname;
const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);
async function readAll(reader: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  const total = chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeUtf8(all);
}
describe('TlsSocket', () => {
  it('release baseline does not expose session reuse or renegotiation helpers', (t) => {
    const surface = TlsSocket.prototype as unknown as Record<string, unknown>;
    for (const name of ['getSession', 'setSession', 'renegotiate', 'setKeyCert']) {
      t.equal(surface[name], undefined, `${name} is not a public TlsSocket helper`);
    }
  });
  it('connects to a local TLS server and exposes an open socket', { skip }, async (t) => {
    const server = serveHttp(
      {
        port: 0,
        hostname: '127.0.0.1',
        tls: {
          cert: CERT_PATH,
          key: KEY_PATH,
        },
      },
      () => new Response('ok'),
    );
    try {
      const tls = await TlsSocket.connect(
        {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: server.port,
        },
        {
          hostname: 'localhost',
          rejectUnauthorized: false,
        },
      );
      t.ok(!tls.closed, 'TlsSocket is open');
      t.equal(tls.negotiatedProtocol, null, 'no ALPN is negotiated by default');
      tls.close();
      t.ok(tls.closed, 'TlsSocket is closed');
    } finally {
      await server.close();
    }
  });
  it(
    'TlsReader/TlsWriter pipe request and response bytes over loopback TLS',
    { skip },
    async (t) => {
      const server = serveHttp(
        {
          port: 0,
          hostname: '127.0.0.1',
          tls: {
            cert: CERT_PATH,
            key: KEY_PATH,
          },
        },
        (req) => new Response('tls:' + new URL(req.url).pathname),
      );
      try {
        const tls = await TlsSocket.connect(
          {
            family: 'ipv4',
            ip: '127.0.0.1',
            port: server.port,
          },
          {
            hostname: 'localhost',
            rejectUnauthorized: false,
          },
        );
        const [reader, writer] = tls.split();
        await writer.write(
          encodeUtf8(
            `GET /pipe HTTP/1.1\r\nHost: localhost:${server.port}\r\nConnection: close\r\n\r\n`,
          ),
        );
        await writer.close();
        const response = await readAll(reader);
        await reader.close();
        t.ok(response.startsWith('HTTP/1.1 200'), 'got HTTP response over TLS');
        t.ok(response.includes('\r\n\r\n'), 'response has header terminator');
        t.ok(response.endsWith('tls:/pipe'), 'response body came from local TLS server');
      } finally {
        await server.close();
      }
    },
  );
  it('close() works without split and is idempotent', { skip }, async (t) => {
    const server = serveHttp(
      {
        port: 0,
        hostname: '127.0.0.1',
        tls: {
          cert: CERT_PATH,
          key: KEY_PATH,
        },
      },
      () => new Response('unused'),
    );
    try {
      const tls = await TlsSocket.connect(
        {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: server.port,
        },
        {
          hostname: 'localhost',
          rejectUnauthorized: false,
        },
      );
      t.ok(!tls.closed, 'open before close');
      tls.close();
      t.ok(tls.closed, 'closed after close');
      tls.close();
      t.ok(tls.closed, 'double-close remains closed');
    } finally {
      await server.close();
    }
  });
  it(
    'releases split TLS ownership exactly once after an immediate socket close',
    { skip },
    async (t) => {
      const server = serveHttp(
        {
          port: 0,
          hostname: '127.0.0.1',
          tls: {
            cert: CERT_PATH,
            key: KEY_PATH,
          },
        },
        () => new Response('unused'),
      );
      try {
        const tls = await TlsSocket.connect(
          {
            family: 'ipv4',
            ip: '127.0.0.1',
            port: server.port,
          },
          {
            hostname: 'localhost',
            rejectUnauthorized: false,
          },
        );
        const [reader, writer] = tls.split();
        tls.close();
        await reader.close();
        await writer.close();
        t.ok(tls.closed, 'direct and split-half cleanup share one idempotent teardown');
      } finally {
        await server.close();
      }
    },
  );
  it('rejects the local self-signed certificate by default', { skip }, async (t) => {
    const server = serveHttp(
      {
        port: 0,
        hostname: '127.0.0.1',
        tls: {
          cert: CERT_PATH,
          key: KEY_PATH,
        },
      },
      () => new Response('unreachable'),
    );
    try {
      await t.rejects(
        () =>
          TlsSocket.connect(
            {
              family: 'ipv4',
              ip: '127.0.0.1',
              port: server.port,
            },
            { hostname: 'localhost' },
          ),
        /TLS handshake failed|certificate|verify|self-signed/i,
        'self-signed fixture is rejected when verification is enabled',
      );
    } finally {
      await server.close();
    }
  });
  it('rejectUnauthorized:false accepts the local self-signed certificate', { skip }, async (t) => {
    const server = serveHttp(
      {
        port: 0,
        hostname: '127.0.0.1',
        tls: {
          cert: CERT_PATH,
          key: KEY_PATH,
        },
      },
      () => new Response('accepted'),
    );
    try {
      const tls = await TlsSocket.connect(
        {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: server.port,
        },
        {
          hostname: 'localhost',
          rejectUnauthorized: false,
        },
      );
      t.ok(!tls.closed, 'connected with rejectUnauthorized=false');
      tls.close();
    } finally {
      await server.close();
    }
  });
  it('custom CA accepts the local self-signed certificate for localhost', { skip }, async (t) => {
    const server = serveHttp(
      {
        port: 0,
        hostname: '127.0.0.1',
        tls: {
          cert: CERT_PATH,
          key: KEY_PATH,
        },
      },
      () => new Response('trusted'),
    );
    let tls: TlsSocket | null = null;
    try {
      tls = await TlsSocket.connect(
        {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: server.port,
        },
        {
          hostname: 'localhost',
          ca: CERT_PATH,
        },
      );
      t.ok(!tls.closed, 'connected with custom CA');
      tls.close();
    } finally {
      await server.close();
    }
  });
  it('exposes peer certificate and verify metadata after handshake', { skip }, async (t) => {
    const server = serveHttp(
      {
        port: 0,
        hostname: '127.0.0.1',
        tls: {
          cert: CERT_PATH,
          key: KEY_PATH,
        },
      },
      () => new Response('trusted'),
    );
    let tls: TlsSocket | null = null;
    try {
      tls = await TlsSocket.connect(
        {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: server.port,
        },
        {
          hostname: 'localhost',
          ca: CERT_PATH,
        },
      );
      const certificate = tls.getPeerCertificate();
      const verify = tls.getVerifyResult();
      const info = tls.getPeerInfo();
      t.ok(certificate instanceof Uint8Array, 'peer certificate is returned as DER bytes');
      t.ok(certificate.byteLength > 0, 'peer certificate is non-empty');
      t.equal(verify.code, 0, 'verify code is success');
      t.equal(verify.reason, null, 'verify reason is null on success');
      t.equal(info.authorized, true, 'peer info reports authorized');
      t.equal(info.verify.code, 0, 'peer info carries verify result');
    } finally {
      tls?.close();
      await server.close();
    }
  });
  it('rejects partial client certificate options before connecting', { skip }, async (t) => {
    await t.rejects(
      () =>
        TlsSocket.connect(
          {
            family: 'ipv4',
            ip: '127.0.0.1',
            port: 9,
          },
          {
            cert: CERT_PATH,
          },
        ),
      /cert.*key|key.*cert/i,
      'cert without key is rejected before TCP connect',
    );
    await t.rejects(
      () =>
        TlsSocket.connect(
          {
            family: 'ipv4',
            ip: '127.0.0.1',
            port: 9,
          },
          {
            key: KEY_PATH,
          },
        ),
      /cert.*key|key.*cert/i,
      'key without cert is rejected before TCP connect',
    );
  });
  it('custom CA still rejects a hostname mismatch', { skip }, async (t) => {
    const server = serveHttp(
      {
        port: 0,
        hostname: '127.0.0.1',
        tls: {
          cert: CERT_PATH,
          key: KEY_PATH,
        },
      },
      () => new Response('unreachable'),
    );
    try {
      await t.rejects(
        () =>
          TlsSocket.connect(
            {
              family: 'ipv4',
              ip: '127.0.0.1',
              port: server.port,
            },
            {
              hostname: 'not-localhost.test',
              ca: CERT_PATH,
            },
          ),
        /hostname|certificate|verify|TLS handshake failed/i,
        'hostname mismatch is rejected even when the CA is trusted',
      );
    } finally {
      await server.close();
    }
  });
  it(
    'reports negotiated ALPN protocol when the client offers http/1.1',
    { skip: skipAlpn },
    async (t) => {
      const server = serveHttp(
        {
          port: 0,
          hostname: '127.0.0.1',
          tls: {
            cert: CERT_PATH,
            key: KEY_PATH,
          },
        },
        () => new Response('alpn'),
      );
      try {
        const tls = await TlsSocket.connect(
          {
            family: 'ipv4',
            ip: '127.0.0.1',
            port: server.port,
          },
          {
            hostname: 'localhost',
            rejectUnauthorized: false,
            alpn: ['http/1.1'],
          },
        );
        t.equal(tls.negotiatedProtocol, 'http/1.1', 'negotiated http/1.1');
        tls.close();
      } finally {
        await server.close();
      }
    },
  );
  it('prefers h2 when the client offers h2 before http/1.1', { skip: skipAlpn }, async (t) => {
    const server = serveHttp(
      {
        port: 0,
        hostname: '127.0.0.1',
        tls: {
          cert: CERT_PATH,
          key: KEY_PATH,
        },
      },
      () => new Response('alpn'),
    );
    try {
      const tls = await TlsSocket.connect(
        {
          family: 'ipv4',
          ip: '127.0.0.1',
          port: server.port,
        },
        {
          hostname: 'localhost',
          rejectUnauthorized: false,
          alpn: ['h2', 'http/1.1'],
        },
      );
      t.equal(
        tls.negotiatedProtocol,
        'h2',
        'server selects h2 from the offered ALPN preference list',
      );
      tls.close();
    } finally {
      await server.close();
    }
  });
  it('failed upgrade leaves the original socket caller-owned', { skip }, async (t) => {
    const listener = Socket.listen({
      family: 'ipv4',
      ip: '127.0.0.1',
      port: 0,
    });
    const acceptDone = (async () => {
      const conn = await listener.accept();
      conn.close();
    })();
    let sock: Socket | null = null;
    try {
      sock = await Socket.connect({
        family: 'ipv4',
        ip: '127.0.0.1',
        port: listener.address.port,
      });
      await t.rejects(
        () =>
          TlsSocket.upgrade(sock!, {
            hostname: 'localhost',
            rejectUnauthorized: false,
          }),
        /TLS handshake failed|wrong version|unexpected|handshake/i,
        'TLS upgrade rejects against a plaintext server',
      );
      t.ok(!sock.closed, 'failed upgrade does not close the caller-owned socket');
    } finally {
      if (sock && !sock.closed) sock.close();
      listener.close();
      await acceptDone.catch(() => {});
    }
  });
});
