/**
 * Tests for fino:net/tls — TLS socket layer.
 *
 * These tests use the local HTTPS server fixtures so they do not depend on
 * public DNS or external network availability.
 */

import { describe, it } from 'fino:test/test';
import { serve } from 'fino:net/http/server';
import { Response } from 'fino:net/http';
import { TlsSocket } from 'fino:net/tls';

const tlsAvailable = (globalThis as typeof globalThis & { tlsAvailable?: boolean }).tlsAvailable;
const skip = !tlsAvailable && 'OpenSSL (libssl) not available';

const CERT_PATH = new URL('./fixtures/test.crt', import.meta.url).pathname;
const KEY_PATH  = new URL('./fixtures/test.key', import.meta.url).pathname;

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
  it('connects to a local TLS server and exposes an open socket', { skip }, async (t) => {
    const server = serve(
      { port: 0, hostname: '127.0.0.1', tls: { cert: CERT_PATH, key: KEY_PATH } },
      () => new Response('ok'),
    );

    try {
      const tls = await TlsSocket.connect(
        { family: 'ipv4', ip: '127.0.0.1', port: server.port },
        { hostname: 'localhost', rejectUnauthorized: false },
      );
      t.ok(!tls.closed, 'TlsSocket is open');
      t.equal(tls.negotiatedProtocol, null, 'no ALPN is negotiated by default');
      tls.close();
      t.ok(tls.closed, 'TlsSocket is closed');
    } finally {
      await server.close();
    }
  });

  it('TlsReader/TlsWriter pipe request and response bytes over loopback TLS', { skip }, async (t) => {
    const server = serve(
      { port: 0, hostname: '127.0.0.1', tls: { cert: CERT_PATH, key: KEY_PATH } },
      (req) => new Response('tls:' + new URL(req.url).pathname),
    );

    try {
      const tls = await TlsSocket.connect(
        { family: 'ipv4', ip: '127.0.0.1', port: server.port },
        { hostname: 'localhost', rejectUnauthorized: false },
      );
      const [reader, writer] = tls.split();
      await writer.write(encodeUtf8(`GET /pipe HTTP/1.1\r\nHost: localhost:${server.port}\r\nConnection: close\r\n\r\n`));
      await writer.close();

      const response = await readAll(reader);
      await reader.close();

      t.ok(response.startsWith('HTTP/1.1 200'), 'got HTTP response over TLS');
      t.ok(response.includes('\r\n\r\n'), 'response has header terminator');
      t.ok(response.endsWith('tls:/pipe'), 'response body came from local TLS server');
    } finally {
      await server.close();
    }
  });

  it('close() works without split and is idempotent', { skip }, async (t) => {
    const server = serve(
      { port: 0, hostname: '127.0.0.1', tls: { cert: CERT_PATH, key: KEY_PATH } },
      () => new Response('unused'),
    );

    try {
      const tls = await TlsSocket.connect(
        { family: 'ipv4', ip: '127.0.0.1', port: server.port },
        { hostname: 'localhost', rejectUnauthorized: false },
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

  it('rejects the local self-signed certificate by default', { skip }, async (t) => {
    const server = serve(
      { port: 0, hostname: '127.0.0.1', tls: { cert: CERT_PATH, key: KEY_PATH } },
      () => new Response('unreachable'),
    );

    try {
      await t.rejects(
        () => TlsSocket.connect(
          { family: 'ipv4', ip: '127.0.0.1', port: server.port },
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
    const server = serve(
      { port: 0, hostname: '127.0.0.1', tls: { cert: CERT_PATH, key: KEY_PATH } },
      () => new Response('accepted'),
    );

    try {
      const tls = await TlsSocket.connect(
        { family: 'ipv4', ip: '127.0.0.1', port: server.port },
        { hostname: 'localhost', rejectUnauthorized: false },
      );
      t.ok(!tls.closed, 'connected with rejectUnauthorized=false');
      tls.close();
    } finally {
      await server.close();
    }
  });
});
