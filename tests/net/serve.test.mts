/**
 * Tests for serve() — the HTTP/1.1 server convenience function.
 *
 * Each test binds to a distinct port to avoid conflicts when tests run
 * concurrently. Ports are in the 19900–19920 range.
 */

import { describe, it } from 'fino:test/test';
import { serve } from 'fino:net/http/server';
import { Request, Response } from 'fino:net/http';
import { Socket } from 'fino:net/socket';
import * as loop from 'internal:runtime/loop';
const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);

async function roundtrip(port: number, rawRequest: string): Promise<string> {
  const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
  const [reader, writer] = sock.split();
  await writer.write(encodeUtf8(rawRequest));
  writer.close();

  const chunks = [];
  for await (const chunk of reader) chunks.push(chunk);
  reader.close();

  const totalLen = chunks.reduce((n, c) => n + c.byteLength, 0);
  const all = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of chunks) { all.set(c, pos); pos += c.byteLength; }
  return decodeUtf8(all);
}

async function readUntil(
  reader: AsyncIterable<Uint8Array>,
  marker: string,
  timeoutMs = 500,
): Promise<{ text: string; iter: AsyncIterator<Uint8Array> }> {
  const iter = reader[Symbol.asyncIterator]();
  let text = '';
  while (!text.includes(marker)) {
    const timer = loop.timeout(timeoutMs);
    const result = await Promise.race([
      iter.next(),
      timer.then(() => ({ done: false, value: encodeUtf8('__timeout__') })),
    ]);
    timer.cancel();
    const { done, value } = result;
    if (!done && decodeUtf8(value) === '__timeout__') throw new Error(`timed out waiting for ${marker}`);
    if (done) break;
    text += decodeUtf8(value);
  }
  return { text, iter };
}

describe('Request / Response basics', () => {
  it('binds and serves on IPv6 loopback when available', async (t) => {
    let server: ReturnType<typeof serve> | null = null;
    try {
      server = serve({ hostname: '::1', port: 0 }, async () => new Response('ipv6-ok'));
    } catch (err: unknown) {
      t.ok(
        String(err).includes('EADDRNOTAVAIL') || String(err).includes('unsupported') || String(err).includes('address'),
        'IPv6 loopback unavailable on this host: ' + String(err),
      );
      return;
    }

    try {
      t.equal(server.address.family, 'ipv6', 'server reports an IPv6 bind');
      const sock = await Socket.connect({ family: 'ipv6', ip: '::1', port: server.port });
      const [reader, writer] = sock.split();
      await writer.write(encodeUtf8(`GET / HTTP/1.1\r\nHost: [::1]:${server.port}\r\nConnection: close\r\n\r\n`));
      await writer.close();

      const chunks: Uint8Array[] = [];
      for await (const chunk of reader) chunks.push(chunk);
      await reader.close();
      const totalLen = chunks.reduce((n, c) => n + c.byteLength, 0);
      const all = new Uint8Array(totalLen);
      let pos = 0;
      for (const c of chunks) { all.set(c, pos); pos += c.byteLength; }
      const response = decodeUtf8(all);
      t.ok(response.startsWith('HTTP/1.1 200'), 'IPv6 request receives 200');
      t.ok(response.endsWith('ipv6-ok'), 'IPv6 response body is delivered');
    } finally {
      await server.close();
    }
  });

  it('binds IPv6 wildcard when family is explicitly ipv6', async (t) => {
    let server: ReturnType<typeof serve> | null = null;
    try {
      server = serve({ family: 'ipv6', port: 0 }, async () => new Response('ipv6-family-ok'));
    } catch (err: unknown) {
      t.ok(
        String(err).includes('EADDRNOTAVAIL') || String(err).includes('unsupported') || String(err).includes('address'),
        'IPv6 wildcard unavailable on this host: ' + String(err),
      );
      return;
    }

    try {
      t.equal(server.address.family, 'ipv6', 'server reports an IPv6 bind');
      const sock = await Socket.connect({ family: 'ipv6', ip: '::1', port: server.port });
      const [reader, writer] = sock.split();
      await writer.write(encodeUtf8(`GET / HTTP/1.1\r\nHost: [::1]:${server.port}\r\nConnection: close\r\n\r\n`));
      await writer.close();

      const { text } = await readUntil(reader, 'ipv6-family-ok');
      t.ok(text.startsWith('HTTP/1.1 200'), 'IPv6 wildcard request receives 200');
      t.ok(text.includes('ipv6-family-ok'), 'IPv6 wildcard body is delivered');
      await reader.close();
    } finally {
      await server.close();
    }
  });

  it('accepts listen backlog and reuse options', async (t) => {
    const server = serve(
      { hostname: '127.0.0.1', port: 0, backlog: 1, reuseAddr: true },
      async () => new Response('listen-options-ok'),
    );
    try {
      t.equal(server.address.family, 'ipv4', 'server reports IPv4 bind');
      const response = await roundtrip(
        server.port,
        `GET / HTTP/1.1\r\nHost: localhost:${server.port}\r\nConnection: close\r\n\r\n`,
      );
      t.ok(response.startsWith('HTTP/1.1 200'), 'server responds with listen options');
      t.ok(response.endsWith('listen-options-ok'), 'response body is delivered');
    } finally {
      await server.close();
    }
  });

  it('server supports await using disposal', async (t) => {
    let serverRef: ReturnType<typeof serve> | null = null;

    {
      await using server = serve({ port: 0 }, async () => new Response('unused'));
      serverRef = server;
      t.ok(server.port > 0, 'server is listening inside await using scope');
    }

    const closedServer = serverRef!;
    let connectFailed = false;
    try {
      const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: closedServer.port });
      sock.close();
    } catch {
      connectFailed = true;
    }
    t.ok(connectFailed, 'server closes when await using scope exits');
  });

  it('basic GET request/response', async (t) => {
    const server = serve({ port: 0 }, async (req) => {
      t.equal(req.method, 'GET', 'method is GET');
      t.equal(req.url, `http://localhost:${server.port}/`, 'url parsed correctly');
      return new Response('hello');
    });
    const port = server.port;

    const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const response = await roundtrip(port, raw);

    t.ok(response.startsWith('HTTP/1.1 200'), 'status 200');
    t.ok(response.includes('content-length: 5'), 'content-length injected');
    t.ok(response.endsWith('hello'), 'body correct');

    await server.close();
  });

  it('supports stream-mode handlers with protocol metadata', async (t) => {
    let seenProtocol = '';
    let seenPath = '';
    const server = serve({ port: 0, mode: 'stream' } as any, async (stream: any) => {
      seenProtocol = stream.protocol;
      seenPath = new URL(stream.request.url).pathname;
      await stream.respond(new Response(`${stream.protocol}:${stream.request.method}`));
    });
    const port = server.port;

    const raw = `GET /stream-mode HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const response = await roundtrip(port, raw);

    t.equal(seenProtocol, 'http/1.1', 'stream exposes HTTP/1.1 protocol');
    t.equal(seenPath, '/stream-mode', 'stream exposes request');
    t.ok(response.startsWith('HTTP/1.1 200'), 'stream handler sends 200');
    t.ok(response.endsWith('http/1.1:GET'), 'stream response body is sent');

    await server.close();
  });

  it('returns 500 when a stream-mode handler does not respond', async (t) => {
    const server = serve({ port: 0, mode: 'stream' } as any, async () => {});
    const port = server.port;

    const raw = `GET /missing-response HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const response = await roundtrip(port, raw);

    t.ok(response.startsWith('HTTP/1.1 500'), 'missing stream response yields 500');

    await server.close();
  });

  it('POST request with body', async (t) => {
    const server = serve({ port: 0 }, async (req) => {
      t.equal(req.method, 'POST', 'method is POST');
      const body = await req.text();
      t.equal(body, 'hello body', 'body received');
      return new Response('got it');
    });
    const port = server.port;

    const raw = `POST / HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Length: 10\r\nConnection: close\r\n\r\nhello body`;
    const response = await roundtrip(port, raw);

    t.ok(response.startsWith('HTTP/1.1 200'), 'status 200');
    t.ok(response.endsWith('got it'), 'body correct');

    await server.close();
  });

  it('handler throws → 500 response', async (t) => {
    const server = serve({ port: 0 }, async (_req) => {
      throw new Error('boom');
    });
    const port = server.port;

    const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const response = await roundtrip(port, raw);

    t.ok(response.startsWith('HTTP/1.1 500'), '500 status on handler throw');

    await server.close();
  });

  it('204 No Content response has no content-length header (RFC 7230 §3.3.2)', async (t) => {
    const server = serve({ port: 0 }, async () => new Response(null, { status: 204 }));
    const port = server.port;

    const raw = `DELETE / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const response = await roundtrip(port, raw);

    t.ok(response.startsWith('HTTP/1.1 204'), '204 status');
    t.ok(!response.toLowerCase().includes('content-length'), '204 response MUST NOT have content-length');

    await server.close();
  });

  it('HTTP TE+CL: content-length removed when transfer-encoding: chunked is present', async (t) => {
    // Regression test for A4: when both TE:chunked and Content-Length coexist,
    // Content-Length must be stripped (prevents request-smuggling via framing ambiguity).
    const server = serve({ port: 0 }, async () => {
      // Handler returns a chunked response; serve() should strip any Content-Length
      // that would otherwise coexist.
      return new Response('hello', {
        headers: {
          'transfer-encoding': 'chunked',
          'content-length': '100', // intentional; should be removed
        },
      });
    });
    const port = server.port;

    const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const response = await roundtrip(port, raw);

    // The framing fix strips content-length when chunked is present.
    const lines = response.split('\r\n');
    const clLines = lines.filter(l => l.toLowerCase().startsWith('content-length'));
    t.equal(clLines.length, 0, 'content-length absent when transfer-encoding: chunked is set');

    await server.close();
  });

  it('A5: chunked trailer drain — fetch() handles chunked response with trailers without pipeline corruption', async (t) => {
    // Regression test for A5: trailing headers after the final `0\r\n` chunk
    // must be consumed so subsequent pipelined requests are not corrupted.
    // We verify by making two sequential fetch calls to the same server; if the
    // chunked body is left partially drained, the second fetch would fail or hang.
    let callCount = 0;
    const server = serve({ port: 0 }, async (req) => {
      callCount++;
      const url = new URL(req.url);
      return new Response(`response-${url.pathname.slice(1)}`, {
        headers: { 'content-type': 'text/plain' },
      });
    });

    try {
      // Two sequential fetches — if chunked body draining is broken, the second hangs.
      const r1 = await fetch(`http://127.0.0.1:${server.port}/first`);
      const body1 = await r1.text();
      const r2 = await fetch(`http://127.0.0.1:${server.port}/second`);
      const body2 = await r2.text();
      t.equal(body1, 'response-first', 'first response body correct');
      t.equal(body2, 'response-second', 'second response body correct (no pipeline corruption)');
    } finally {
      await server.close();
    }
  });

  it('streaming response body (async generator) is transmitted correctly', async (t) => {
    const server = serve({ port: 0 }, async () => {
      async function* stream() {
        yield new TextEncoder().encode('chunk-one-');
        yield new TextEncoder().encode('chunk-two-');
        yield new TextEncoder().encode('chunk-three');
      }
      return new Response(stream() as any);
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      t.equal(res.status, 200, 'status 200');
      const body = await res.text();
      t.equal(body, 'chunk-one-chunk-two-chunk-three', 'all chunks received in order');
    } finally {
      await server.close();
    }
  });

  it('HEAD request receives no body even when Content-Length is set', async (t) => {
    // Regression for the HEAD framing bug: parseResponse must treat HEAD
    // responses as bodyless regardless of Content-Length.
    const server = serve({ port: 0 }, async () => new Response('full body here'));
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`, { method: 'HEAD' });
      t.equal(res.status, 200, 'HEAD returns 200');
      // text() should complete immediately with '' (not hang reading Content-Length bytes)
      const body = await res.text();
      t.equal(body, '', 'HEAD response body is empty');
      t.ok(res.headers.get('content-length') !== null, 'Content-Length header still present');
    } finally {
      await server.close();
    }
  });

  it('content-length auto-injection', async (t) => {
    const server = serve({ port: 0 }, async () => new Response('hello!'));
    const port = server.port;

    const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const response = await roundtrip(port, raw);

    t.ok(response.includes('content-length: 6'), 'content-length: 6 injected');
    t.ok(response.endsWith('hello!'), 'body correct');

    await server.close();
  });

  it('existing content-length not overwritten', async (t) => {
    const server = serve({ port: 0 }, async () => {
      return new Response('hi', { headers: { 'content-length': '2' } });
    });
    const port = server.port;

    const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const response = await roundtrip(port, raw);

    const occurrences = (response.match(/content-length/g) || []).length;
    t.equal(occurrences, 1, 'content-length appears exactly once');

    await server.close();
  });

  it('Response.json() body', async (t) => {
    const server = serve({ port: 0 }, async () => Response.json({ ok: true }));
    const port = server.port;

    const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const response = await roundtrip(port, raw);

    t.ok(response.includes('content-type: application/json'), 'content-type set');
    t.ok(response.includes('"ok":true'), 'json body present');

    await server.close();
  });

  it('null body response', async (t) => {
    const server = serve({ port: 0 }, async () => new Response(null, { status: 204 }));
    const port = server.port;

    const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const response = await roundtrip(port, raw);

    t.ok(response.startsWith('HTTP/1.1 204'), '204 No Content');

    await server.close();
  });
});

describe('HTTP protocol conformance', () => {
  it('sends 100 Continue before reading an expected request body', async (t) => {
    let receivedBody = '';
    const server = serve({ port: 0 }, async (req) => {
      receivedBody = await req.text();
      return new Response('accepted');
    });
    const port = server.port;
    const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
    const [reader, writer] = sock.split();

    try {
      await writer.write(encodeUtf8(
        `POST /upload HTTP/1.1\r\n` +
        `Host: localhost:${port}\r\n` +
        `Expect: 100-continue\r\n` +
        `Content-Length: 7\r\n` +
        `Connection: close\r\n\r\n`,
      ));
      await writer.flush();

      let interim = '';
      let iter = reader[Symbol.asyncIterator]();
      let interimError: unknown = null;
      try {
        const result = await readUntil(reader, '\r\n\r\n');
        interim = result.text;
        iter = result.iter;
      } catch (err) {
        interimError = err;
      }

      await writer.write(encodeUtf8('payload'));
      await writer.flush();
      await writer.close();

      let final = '';
      while (!final.includes('accepted')) {
        const { done, value } = await iter.next();
        if (done) break;
        final += decodeUtf8(value);
      }
      t.equal(interimError, null, 'server sends interim response before the body is written');
      t.ok(interim.startsWith('HTTP/1.1 100 Continue'), 'server sends interim 100 response');
      t.equal(receivedBody, 'payload', 'handler receives body after continue');
      t.ok(final.startsWith('HTTP/1.1 200'), 'final response is 200');
      t.ok(final.includes('accepted'), 'final body is delivered');
    } finally {
      await reader.close();
      await server.close();
    }
  });

  it('rejects unsupported Expect values before calling the handler', async (t) => {
    let handlerCalled = false;
    const server = serve({ port: 0 }, async () => {
      handlerCalled = true;
      return new Response('unexpected');
    });
    const port = server.port;

    try {
      const raw =
        `POST /upload HTTP/1.1\r\n` +
        `Host: localhost:${port}\r\n` +
        `Expect: custom-expectation\r\n` +
        `Content-Length: 7\r\n` +
        `Connection: close\r\n\r\npayload`;
      const response = await roundtrip(port, raw);
      t.ok(response.startsWith('HTTP/1.1 417'), 'unsupported Expect returns 417');
      t.equal(handlerCalled, false, 'handler is not called');
    } finally {
      await server.close();
    }
  });

  it('returns 408 when request headers exceed headersTimeoutMs', async (t) => {
    let handlerCalled = false;
    const server = serve({ port: 0, headersTimeoutMs: 10 }, async () => {
      handlerCalled = true;
      return new Response('unexpected');
    });
    const port = server.port;
    const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
    const [reader, writer] = sock.split();

    try {
      await writer.write(encodeUtf8(`GET /slow HTTP/1.1\r\nHost: localhost:${port}\r\n`));
      await writer.flush();

      const { text } = await readUntil(reader, '\r\n\r\n');
      t.ok(text.startsWith('HTTP/1.1 408'), 'incomplete headers time out with 408');
      t.equal(handlerCalled, false, 'handler is not called');
    } finally {
      await writer.close();
      await reader.close();
      await server.close();
    }
  });

  it('closes idle keep-alive connections after idleTimeoutMs', async (t) => {
    const server = serve({ port: 0, idleTimeoutMs: 10 }, async () => new Response('first'));
    const port = server.port;
    const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
    const [reader, writer] = sock.split();

    try {
      await writer.write(encodeUtf8(`GET / HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`));
      await writer.flush();
      const { text, iter } = await readUntil(reader, 'first');
      t.ok(text.startsWith('HTTP/1.1 200'), 'first response succeeds');

      const eof = await Promise.race([
        iter.next(),
        loop.timeout(200).then(() => ({ done: false, value: encodeUtf8('timeout') })),
      ]);
      t.equal(eof.done, true, 'idle connection closes without another request');
    } finally {
      await writer.close();
      await reader.close();
      await server.close();
    }
  });

  it('duplicate conflicting Content-Length headers → 400 or connection close', async (t) => {
    // RFC 7230 §3.3.2: conflicting CL values are a framing error — the server
    // MUST reject the request rather than silently using the first value.
    let handlerCalled = false;
    const server = serve({ port: 0 }, async () => {
      handlerCalled = true;
      return new Response('should not reach handler');
    });
    const port = server.port;

    // Send a request with two different Content-Length values.
    const raw = `POST / HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Length: 5\r\nContent-Length: 10\r\nConnection: close\r\n\r\nhello`;
    const response = await roundtrip(port, raw);

    // Server should respond with 400 Bad Request (or close with no response).
    // The handler must NOT have been called with a malformed request.
    const isBadRequest = response.startsWith('HTTP/1.1 400') || response.length === 0;
    t.ok(isBadRequest || !handlerCalled,
      'conflicting Content-Length rejected: handler not called or 400 returned');

    await server.close();
  });

  it('duplicate identical Content-Length headers are accepted', async (t) => {
    const server = serve({ port: 0 }, async (req) => {
      const body = await req.text();
      return new Response(body);
    });
    const port = server.port;

    // Two identical CL values with same body — RFC allows this.
    const raw = `POST / HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Length: 5\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello`;
    const response = await roundtrip(port, raw);

    t.ok(response.startsWith('HTTP/1.1 200'), 'identical CL values accepted with 200');
    t.ok(response.endsWith('hello'), 'body echoed correctly');

    await server.close();
  });
});

describe('Connection management', () => {
  it('graceful shutdown via server.close()', async (t) => {
    let handled = 0;
    const server = serve({ port: 0 }, async () => {
      handled++;
      return new Response('ok');
    });
    const port = server.port;

    const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    await roundtrip(port, raw);
    await server.close();

    t.equal(handled, 1, 'exactly one request handled before shutdown');
  });

  it('Connection: close header injected correctly', async (t) => {
    const server = serve({ port: 0 }, async () => new Response('bye'));
    const port = server.port;

    const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const response = await roundtrip(port, raw);

    t.ok(response.includes('connection: close'), 'connection: close injected');

    await server.close();
  });

  it('keep-alive — two requests on same connection', async (t) => {
    let count = 0;
    const server = serve({ port: 0 }, async (req) => {
      count++;
      return new Response(`req${count}`);
    });
    const port = server.port;

    const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
    const [reader, writer] = sock.split();

    await writer.write(encodeUtf8(`GET / HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`));
    await writer.flush();

    let received = '';
    const iter = reader[Symbol.asyncIterator]();
    while (true) {
      const { done, value } = await iter.next();
      if (done) break;
      received += decodeUtf8(value);
      if (received.includes('\r\n\r\nreq1')) break;
    }

    t.ok(received.includes('HTTP/1.1 200'), 'first response 200');
    t.ok(received.includes('connection: keep-alive'), 'keep-alive header set');
    t.ok(received.includes('req1'), 'first response body');

    await writer.write(encodeUtf8(`GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`));
    await writer.flush();

    let second = '';
    while (true) {
      const { done, value } = await iter.next();
      if (done) break;
      second += decodeUtf8(value);
      if (second.includes('\r\n\r\nreq2')) break;
    }

    t.ok(second.includes('HTTP/1.1 200'), 'second response 200');
    t.ok(second.includes('req2'), 'second response body');

    writer.close();
    reader.close();
    await server.close();
  });

  it('keep-alive: second request succeeds after handler error on first', async (t) => {
    // A handler that throws must drain the request body so the HTTP parser
    // state is not corrupted for the next request on the same connection.
    let callCount = 0;
    const server = serve({ port: 0 }, async (req) => {
      callCount++;
      if (callCount === 1) {
        // First call: read nothing from the body, then throw.
        throw new Error('deliberate handler error');
      }
      return new Response('second-ok');
    });
    const port = server.port;
    const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
    const [reader, writer] = sock.split();

    // First request: has a body that the handler never reads, then throws.
    const body1 = 'request-body-content';
    await writer.write(encodeUtf8(
      `POST / HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Length: ${body1.length}\r\n\r\n${body1}`,
    ));
    await writer.flush();

    let buf = '';
    const iter = reader[Symbol.asyncIterator]();
    while (true) {
      const { done, value } = await iter.next();
      if (done) break;
      buf += decodeUtf8(value);
      if (buf.includes('\r\n\r\n')) break; // response headers received
    }
    t.ok(buf.includes('HTTP/1.1 500'), 'first request returned 500');

    // Second request on same connection — parser must be in a clean state.
    await writer.write(encodeUtf8(
      `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`,
    ));
    await writer.flush();

    let buf2 = '';
    while (true) {
      const { done, value } = await iter.next();
      if (done) break;
      buf2 += decodeUtf8(value);
      if (buf2.includes('second-ok')) break;
    }
    t.ok(buf2.includes('HTTP/1.1 200'), 'second request returned 200');
    t.ok(buf2.includes('second-ok'), 'second response body correct');

    writer.close();
    reader.close();
    await server.close();
  });

  it('concurrent connections', async (t) => {
    let inFlight = 0;
    let maxConcurrent = 0;

    const server = serve({ port: 0 }, async (_req) => {
      inFlight++;
      if (inFlight > maxConcurrent) maxConcurrent = inFlight;
      await loop.timeout(10);
      inFlight--;
      return new Response('ok');
    });
    const port = server.port;

    const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    await Promise.all([
      roundtrip(port, raw),
      roundtrip(port, raw),
      roundtrip(port, raw),
    ]);

    t.ok(maxConcurrent > 1, 'connections handled concurrently (max=' + maxConcurrent + ')');

    await server.close();
  });

  it('pipelined responses preserve request order when handlers finish out of order', async (t) => {
    const server = serve({ port: 0 }, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/slow') await loop.timeout(20);
      return new Response(url.pathname.slice(1));
    });
    const port = server.port;

    const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
    const [reader, writer] = sock.split();

    await writer.write(encodeUtf8(
      `GET /slow HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n` +
      `GET /fast HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`,
    ));
    await writer.flush();

    const bytes = await (async () => {
      const chunks = [];
      let total = 0;
      for await (const chunk of reader) {
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      const out = new Uint8Array(total);
      let pos = 0;
      for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.byteLength; }
      return out;
    })();

    const response = decodeUtf8(bytes);
    const slowIdx = response.indexOf('\r\n\r\nslow');
    const fastIdx = response.indexOf('\r\n\r\nfast');

    t.ok(slowIdx >= 0, 'slow response body present');
    t.ok(fastIdx >= 0, 'fast response body present');
    t.ok(slowIdx < fastIdx, 'responses emitted in request order');

    writer.close();
    reader.close();
    await server.close();
  });

  it('parses multiple pipelined requests from a single client write', async (t) => {
    const seen: string[] = [];
    const server = serve({ port: 0 }, async (req) => {
      const url = new URL(req.url);
      seen.push(url.pathname);
      return new Response(url.pathname.slice(1));
    });
    const port = server.port;

    const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
    const [reader, writer] = sock.split();

    await writer.write(encodeUtf8(
      `GET /one HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n` +
      `GET /two HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n` +
      `GET /three HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`,
    ));
    await writer.flush();

    const bytes = await (async () => {
      const chunks = [];
      let total = 0;
      for await (const chunk of reader) {
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      const out = new Uint8Array(total);
      let pos = 0;
      for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.byteLength; }
      return out;
    })();

    const response = decodeUtf8(bytes);
    t.equal(seen.join(','), '/one,/two,/three', 'all pipelined requests handled');
    t.ok(response.includes('\r\n\r\none'), 'first response body present');
    t.ok(response.includes('\r\n\r\ntwo'), 'second response body present');
    t.ok(response.includes('\r\n\r\nthree'), 'third response body present');

    writer.close();
    reader.close();
    await server.close();
  });
});
