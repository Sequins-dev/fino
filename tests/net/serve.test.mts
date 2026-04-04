/**
 * Tests for serve() — the HTTP/1.1 server convenience function.
 *
 * Each test binds to a distinct port to avoid conflicts when tests run
 * concurrently. Ports are in the 19900–19920 range.
 */

import { describe, it } from 'fino:test/test';
import { serve } from 'fino:net/serve';
import { Request, Response } from 'fino:net/http';
import { Socket } from 'fino:net/socket';
import * as loop from 'fino:runtime/loop';
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

describe('Request / Response basics', () => {
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
