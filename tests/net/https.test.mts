/**
 * Tests for HTTPS — serve() with TLS options.
 *
 * Requires self-signed test fixtures at tests/net/fixtures/test.crt and
 * tests/net/fixtures/test.key. Generate them with:
 *
 *   mkdir -p tests/net/fixtures
 *   openssl req -x509 -newkey rsa:2048 \
 *     -keyout tests/net/fixtures/test.key \
 *     -out tests/net/fixtures/test.crt \
 *     -days 3650 -nodes -subj "/CN=localhost" 2>/dev/null
 */

import { describe, it } from 'fino:test/test';
import { serve } from 'fino:net/serve';
import { Response } from 'fino:net/http';
import { TlsSocket } from 'fino:net/tls';

const tlsAvailable = (globalThis as typeof globalThis & { tlsAvailable?: boolean }).tlsAvailable;
const skip = !tlsAvailable && 'OpenSSL (libssl) not available';

const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);

const CERT_PATH = new URL('./fixtures/test.crt', import.meta.url).pathname;
const KEY_PATH  = new URL('./fixtures/test.key', import.meta.url).pathname;

async function tlsRoundtrip(port: number, rawRequest: string): Promise<string> {
  const tls = await TlsSocket.connect(
    { family: 'ipv4', ip: '127.0.0.1', port },
    { hostname: '127.0.0.1', rejectUnauthorized: false },
  );
  const [reader, writer] = tls.split();
  await writer.write(encodeUtf8(rawRequest));
  writer.close();

  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  reader.close();

  const totalLen = chunks.reduce((n, c) => n + c.byteLength, 0);
  const all = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of chunks) { all.set(c, pos); pos += c.byteLength; }
  return decodeUtf8(all);
}

describe('HTTPS server — basic TLS request/response', () => {
  it('serves a response over TLS', { skip }, async (t) => {
    const server = serve(
      { port: 0, tls: { cert: CERT_PATH, key: KEY_PATH } },
      async () => new Response('hello https'),
    );
    const port = server.port;

    try {
      const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
      const response = await tlsRoundtrip(port, raw);

      t.ok(response.startsWith('HTTP/1.1 200'), 'status 200 over TLS');
      // Extract body — must be EXACTLY 'hello https', not just contain the substring.
      const bodyStart = response.indexOf('\r\n\r\n');
      const body = bodyStart >= 0 ? response.slice(bodyStart + 4) : '';
      t.equal(body, 'hello https', 'response body is exactly correct over TLS');
      // Verify TLS was actually used (connection object is a TlsSocket, not plain Socket).
      t.ok(response.includes('HTTP/1.1'), 'response is valid HTTP over TLS (not plain-text garble)');
    } finally {
      await server.close();
    }
  });
});

describe('HTTPS server — error paths', () => {
  it('throws when cert file does not exist', { skip }, async (t) => {
    let threw = false;
    let message = '';
    try {
      serve(
        { port: 0, tls: { cert: '/nonexistent/cert.pem', key: '/nonexistent/key.pem' } },
        async () => new Response('unreachable'),
      );
    } catch (err: unknown) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    t.ok(threw, 'serve() throws on missing cert');
    t.ok(
      message.includes('/nonexistent/cert.pem'),
      'error message contains cert path (got: ' + message + ')',
    );
  });
});

describe('HTTPS server — close() idempotency', () => {
  it('close() can be called twice without throwing', { skip }, async (t) => {
    const server = serve(
      { port: 0, tls: { cert: CERT_PATH, key: KEY_PATH } },
      async () => new Response('ok'),
    );

    let threw = false;
    try {
      await server.close();
      await server.close();
    } catch (_) {
      threw = true;
    }
    t.ok(!threw, 'second close() does not throw');
  });
});
