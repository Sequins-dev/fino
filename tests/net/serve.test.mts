/**
 * Tests for serve() — the HTTP/1.1 server convenience function.
 *
 * Each test binds to a distinct port to avoid conflicts when tests run
 * concurrently. Ports are in the 19900–19920 range.
 */

import { describe, it } from 'boats:test/test';
import { serve } from 'boats:net/serve';
import { Request, Response } from 'boats:net/http';
import { Socket } from 'boats:net/socket';
import * as loop from 'boats:runtime/loop';
const encodeUtf8 = s => new TextEncoder().encode(s);
const decodeUtf8 = b => new TextDecoder().decode(b);

async function roundtrip(lp, port, rawRequest) {
  const sock = await Socket.connect(lp, { family: 'ipv4', ip: '127.0.0.1', port });
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
    const lp = loop.create();
    const server = serve(lp, { port: 19900 }, async (req) => {
      t.equal(req.method, 'GET', 'method is GET');
      t.equal(req.url, 'http://localhost:19900/', 'url parsed correctly');
      return new Response('hello');
    });

    const raw = 'GET / HTTP/1.1\r\nHost: localhost:19900\r\nConnection: close\r\n\r\n';
    const response = await roundtrip(lp, 19900, raw);

    t.ok(response.startsWith('HTTP/1.1 200'), 'status 200');
    t.ok(response.includes('content-length: 5'), 'content-length injected');
    t.ok(response.endsWith('hello'), 'body correct');

    await server.close();
    loop.destroy(lp);
  });

  it('POST request with body', async (t) => {
    const lp = loop.create();
    const server = serve(lp, { port: 19901 }, async (req) => {
      t.equal(req.method, 'POST', 'method is POST');
      const body = await req.text();
      t.equal(body, 'hello body', 'body received');
      return new Response('got it');
    });

    const raw = 'POST / HTTP/1.1\r\nHost: localhost:19901\r\nContent-Length: 10\r\nConnection: close\r\n\r\nhello body';
    const response = await roundtrip(lp, 19901, raw);

    t.ok(response.startsWith('HTTP/1.1 200'), 'status 200');
    t.ok(response.endsWith('got it'), 'body correct');

    await server.close();
    loop.destroy(lp);
  });

  it('handler throws → 500 response', async (t) => {
    const lp = loop.create();
    const server = serve(lp, { port: 19902 }, async (_req) => {
      throw new Error('boom');
    });

    const raw = 'GET / HTTP/1.1\r\nHost: localhost:19902\r\nConnection: close\r\n\r\n';
    const response = await roundtrip(lp, 19902, raw);

    t.ok(response.startsWith('HTTP/1.1 500'), '500 status on handler throw');

    await server.close();
    loop.destroy(lp);
  });

  it('content-length auto-injection', async (t) => {
    const lp = loop.create();
    const server = serve(lp, { port: 19903 }, async () => new Response('boats!'));

    const raw = 'GET / HTTP/1.1\r\nHost: localhost:19903\r\nConnection: close\r\n\r\n';
    const response = await roundtrip(lp, 19903, raw);

    t.ok(response.includes('content-length: 6'), 'content-length: 6 injected');
    t.ok(response.endsWith('boats!'), 'body correct');

    await server.close();
    loop.destroy(lp);
  });

  it('existing content-length not overwritten', async (t) => {
    const lp = loop.create();
    const server = serve(lp, { port: 19904 }, async () => {
      return new Response('hi', { headers: { 'content-length': '2' } });
    });

    const raw = 'GET / HTTP/1.1\r\nHost: localhost:19904\r\nConnection: close\r\n\r\n';
    const response = await roundtrip(lp, 19904, raw);

    const occurrences = (response.match(/content-length/g) || []).length;
    t.equal(occurrences, 1, 'content-length appears exactly once');

    await server.close();
    loop.destroy(lp);
  });

  it('Response.json() body', async (t) => {
    const lp = loop.create();
    const server = serve(lp, { port: 19905 }, async () => Response.json({ ok: true }));

    const raw = 'GET / HTTP/1.1\r\nHost: localhost:19905\r\nConnection: close\r\n\r\n';
    const response = await roundtrip(lp, 19905, raw);

    t.ok(response.includes('content-type: application/json'), 'content-type set');
    t.ok(response.includes('"ok":true'), 'json body present');

    await server.close();
    loop.destroy(lp);
  });

  it('null body response', async (t) => {
    const lp = loop.create();
    const server = serve(lp, { port: 19910 }, async () => new Response(null, { status: 204 }));

    const raw = 'GET / HTTP/1.1\r\nHost: localhost:19910\r\nConnection: close\r\n\r\n';
    const response = await roundtrip(lp, 19910, raw);

    t.ok(response.startsWith('HTTP/1.1 204'), '204 No Content');

    await server.close();
    loop.destroy(lp);
  });
});

describe('Connection management', () => {
  it('graceful shutdown via server.close()', async (t) => {
    const lp = loop.create();
    let handled = 0;
    const server = serve(lp, { port: 19906 }, async () => {
      handled++;
      return new Response('ok');
    });

    const raw = 'GET / HTTP/1.1\r\nHost: localhost:19906\r\nConnection: close\r\n\r\n';
    await roundtrip(lp, 19906, raw);
    await server.close();

    t.equal(handled, 1, 'exactly one request handled before shutdown');

    loop.destroy(lp);
  });

  it('Connection: close header injected correctly', async (t) => {
    const lp = loop.create();
    const server = serve(lp, { port: 19907 }, async () => new Response('bye'));

    const raw = 'GET / HTTP/1.1\r\nHost: localhost:19907\r\nConnection: close\r\n\r\n';
    const response = await roundtrip(lp, 19907, raw);

    t.ok(response.includes('connection: close'), 'connection: close injected');

    await server.close();
    loop.destroy(lp);
  });

  it('keep-alive — two requests on same connection', async (t) => {
    const lp = loop.create();
    let count = 0;
    const server = serve(lp, { port: 19908 }, async (req) => {
      count++;
      return new Response(`req${count}`);
    });

    const sock = await Socket.connect(lp, { family: 'ipv4', ip: '127.0.0.1', port: 19908 });
    const [reader, writer] = sock.split();

    await writer.write(encodeUtf8('GET / HTTP/1.1\r\nHost: localhost:19908\r\n\r\n'));

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

    await writer.write(encodeUtf8('GET / HTTP/1.1\r\nHost: localhost:19908\r\nConnection: close\r\n\r\n'));

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
    loop.destroy(lp);
  });

  it('concurrent connections', async (t) => {
    const lp = loop.create();
    let inFlight = 0;
    let maxConcurrent = 0;

    const server = serve(lp, { port: 19909 }, async (_req) => {
      inFlight++;
      if (inFlight > maxConcurrent) maxConcurrent = inFlight;
      await loop.timeout(lp, 10);
      inFlight--;
      return new Response('ok');
    });

    const raw = 'GET / HTTP/1.1\r\nHost: localhost:19909\r\nConnection: close\r\n\r\n';
    await Promise.all([
      roundtrip(lp, 19909, raw),
      roundtrip(lp, 19909, raw),
      roundtrip(lp, 19909, raw),
    ]);

    t.ok(maxConcurrent > 1, 'connections handled concurrently (max=' + maxConcurrent + ')');

    await server.close();
    loop.destroy(lp);
  });
});
