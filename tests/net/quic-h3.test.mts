import { describe, it } from 'fino:test/test';
import { quicAvailable, QuicStreamEvent } from 'fino:net/quic';
import type { QuicStream } from 'fino:net/quic';
import {
  fetch as h3Fetch,
  h3Available,
  requireH3,
  serve as h3Serve,
} from '../../js/net/http/h3.mts';
import { resolveH3ConnectAddress } from '../../js/internal/net/http/h3/resolve.mts';
import { serve as httpServe } from 'fino:net/http/server';
import { App } from 'fino:net/http/app';
import { H3ServerDriver } from '../../js/internal/net/http/h3/server.mts';
import { H3ClientSession } from '../../js/internal/net/http/h3/client.mts';
import { Nghttp3Session } from '../../js/internal/net/http/h3/session.mts';
import { QuicPipe } from './fixtures/quic/sim-harness.mts';

const available = quicAvailable && h3Available;
const TEST_CERT = 'tests/net/fixtures/test.crt';
const TEST_KEY = 'tests/net/fixtures/test.key';

function h3Pipe(): QuicPipe {
  return new QuicPipe({
    server: { alpnProtocols: ['h3'], connection: { maxIdleTimeoutMs: 0, streamIdleTimeoutMs: 0 } },
    client: { alpnProtocols: ['h3'], connection: { maxIdleTimeoutMs: 0, streamIdleTimeoutMs: 0 } },
  });
}

async function h3Handshake(pipe: QuicPipe) {
  const { client, server } = await pipe.handshake();
  return { client, server };
}

describe('HTTP/3 (h3 ALPN)', () => {
  it('public fetch resolves URL hostnames before QUIC connect and preserves SNI host', async (t) => {
    const seen: Array<{ hostname: string; family?: 4 | 6 }> = [];
    const resolved = await resolveH3ConnectAddress(
      new URL('https://example.test:9443/smoke'),
      async (hostname, opts) => {
        seen.push({ hostname, family: opts.family });
        return { address: '192.0.2.55', family: 4 };
      },
    );

    t.deepEqual(seen, [{ hostname: 'example.test', family: 4 }], 'hostname is resolved as IPv4');
    t.deepEqual(resolved.address, { family: 'ipv4', ip: '192.0.2.55', port: 9443 }, 'QUIC connect uses resolved IP');
    t.equal(resolved.serverName, 'example.test', 'SNI stays on the URL hostname');
  });

  it('public module exports availability, guard, client, and server helpers', (t) => {
    t.equal(typeof h3Available, 'boolean', 'h3Available is a boolean');
    t.equal(typeof requireH3, 'function', 'requireH3 is exported');
    t.equal(typeof h3Fetch, 'function', 'fetch is exported');
    t.equal(typeof h3Serve, 'function', 'serve is exported');
  });

  it('public helpers fail fast when libnghttp3 is unavailable', async (t) => {
    if (h3Available) {
      t.ok(requireH3(), 'requireH3 returns bindings when libnghttp3 is installed');
      return;
    }

    t.throws(() => requireH3(), /libnghttp3 not found/, 'requireH3 reports missing libnghttp3');
    await t.rejects(() => h3Fetch('https://127.0.0.1/'), /libnghttp3 not found/, 'fetch rejects before opening a connection');
    await t.rejects(() => h3Serve({
      port: 0,
      certificateFile: TEST_CERT,
      privateKeyFile: TEST_KEY,
    }, () => new Response('unused')), /libnghttp3 not found/, 'serve rejects before opening a listener');
  });

  it('h3Available is truthy when libnghttp3 is installed', async (t) => {
    if (!quicAvailable) return;
    t.ok(h3Available !== undefined, 'h3Available is exported');
    if (!h3Available) {
      t.ok(true, 'libnghttp3 not installed, skipping remaining H3 tests');
    }
  });

  it('public serve() and fetch() complete a real UDP GET round-trip', async (t) => {
    if (!available) return;

    const server = await h3Serve({
      port: 0,
      hostname: '127.0.0.1',
      certificateFile: TEST_CERT,
      privateKeyFile: TEST_KEY,
    }, (request) => {
      return new Response(`h3:${new URL(request.url).pathname}`, {
        headers: { 'x-h3-smoke': 'get' },
      });
    });

    try {
      const response = await h3Fetch(`https://127.0.0.1:${server.port}/smoke`, {
        quic: { verifyPeer: false },
      });
      t.equal(response.status, 200, 'GET response status');
      t.equal(response.headers.get('x-h3-smoke'), 'get', 'response header received');
      t.equal(new TextDecoder().decode(await response.arrayBuffer()), 'h3:/smoke', 'response body received');
    } finally {
      await server.close();
    }
  });

  it('public serve() and fetch() complete a real UDP POST round-trip', async (t) => {
    if (!available) return;

    let method = '';
    let body = '';
    const server = await h3Serve({
      port: 0,
      hostname: '127.0.0.1',
      certificateFile: TEST_CERT,
      privateKeyFile: TEST_KEY,
    }, async (request) => {
      method = request.method;
      body = await request.text();
      return new Response(`echo:${body}`);
    });

    try {
      const response = await h3Fetch(`https://127.0.0.1:${server.port}/upload`, {
        method: 'POST',
        body: new TextEncoder().encode('real-h3-body'),
        quic: { verifyPeer: false },
      });
      t.equal(response.status, 200, 'POST response status');
      t.equal(method, 'POST', 'server received POST method');
      t.equal(body, 'real-h3-body', 'server received POST body');
      t.equal(new TextDecoder().decode(await response.arrayBuffer()), 'echo:real-h3-body', 'client received echo response');
    } finally {
      await server.close();
    }
  });

  it('unified HTTP serve() can enable H3 accept mode', async (t) => {
    if (!available) return;

    const server = httpServe({
      port: 0,
      hostname: '127.0.0.1',
      tls: { cert: TEST_CERT, key: TEST_KEY },
      h3: true,
    } as any, async (incoming: any) => {
      const accepted = await incoming.accept();
      await accepted.respond(new Response(`protocol:${accepted.protocol}`));
    });

    try {
      await (server as any).ready;
      const response = await h3Fetch(`https://127.0.0.1:${server.port}/proto`, {
        quic: { verifyPeer: false },
      });
      t.equal(await response.text(), 'protocol:h3', 'unified accept mode handles H3 requests');
    } finally {
      await server.close();
    }
  });

  it('App.listen() exposes H3 protocol and session context', async (t) => {
    if (!available) return;

    const app = new App();
    app.get('/proto', (ctx) => new Response(`${ctx.protocol}:${ctx.session?.protocol ?? 'none'}`));

    const server = app.listen({
      port: 0,
      hostname: '127.0.0.1',
      tls: { cert: TEST_CERT, key: TEST_KEY },
      h3: true,
    } as any);

    try {
      await (server as any).ready;
      const response = await h3Fetch(`https://127.0.0.1:${server.port}/proto`, {
        quic: { verifyPeer: false },
      });
      t.equal(await response.text(), 'h3:h3', 'app context sees H3 protocol and session');
    } finally {
      await server.close();
    }
  });

  it('GET request/response round-trip', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (_req) =>
        new Response('hello h3', { headers: { 'content-type': 'text/plain' } }),
      );

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));

      t.equal(response.status, 200, 'response status is 200');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(text, 'hello h3', 'response body matches');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('POST with request body', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      let receivedBody = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        receivedBody = await req.text();
        return new Response(`echo:${receivedBody}`);
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/upload', {
        method: 'POST',
        body: new TextEncoder().encode('request-body-data'),
      }));

      t.equal(response.status, 200, 'response status is 200');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(receivedBody, 'request-body-data', 'server received request body');
      t.equal(text, 'echo:request-body-data', 'response body echoes request');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('streams request bodies to the server before EOF', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      let releaseSecondChunk!: () => void;
      const secondChunkReady = new Promise<void>((resolve) => { releaseSecondChunk = resolve; });
      let handlerEntered = false;
      let firstChunk = '';
      let responseText = '';

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        handlerEntered = true;
        const reader = req.body!.getReader();
        const first = await reader.read();
        firstChunk = first.done ? '' : new TextDecoder().decode(first.value);
        const chunks = [firstChunk];
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(new TextDecoder().decode(next.value));
        }
        return new Response(`echo:${chunks.join('')}`);
      });

      async function* requestBody() {
        yield new TextEncoder().encode('first-');
        await secondChunkReady;
        yield new TextEncoder().encode('second');
      }

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const requestPromise = session.request('https://localhost/upload', {
        method: 'POST',
        body: requestBody() as any,
      });

      await pipe.pumpUntilCondition(() => firstChunk !== '' ? true : null);
      t.equal(handlerEntered, true, 'handler is entered before request EOF');
      t.equal(firstChunk, 'first-', 'handler can read the first chunk before request EOF');

      releaseSecondChunk();
      const response = await pipe.pumpUntil(requestPromise);
      responseText = await response.text();
      t.equal(responseText, 'echo:first-second', 'server receives the complete streamed body');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('streams response bodies to the client before EOF', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      let releaseSecondChunk!: () => void;
      const secondChunkReady = new Promise<void>((resolve) => { releaseSecondChunk = resolve; });

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => {
        async function* body() {
          yield new TextEncoder().encode('first-');
          await secondChunkReady;
          yield new TextEncoder().encode('second');
        }
        return new Response(body() as any, {
          headers: { 'content-type': 'text/plain' },
        });
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/stream'));
      t.equal(response.status, 200, 'response resolves once headers arrive');

      const reader = response.body!.getReader();
      const first = await pipe.pumpUntil(reader.read());
      t.equal(first.done, false, 'first body read yields data');
      t.equal(new TextDecoder().decode(first.value), 'first-', 'client sees first chunk before response EOF');

      releaseSecondChunk();
      const second = await pipe.pumpUntil(reader.read());
      t.equal(second.done, false, 'second body read yields data');
      t.equal(new TextDecoder().decode(second.value), 'second', 'client sees second chunk after producer resumes');
      const done = await pipe.pumpUntil(reader.read());
      t.equal(done.done, true, 'stream closes after response EOF');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('custom request and response headers round-trip', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      let receivedHeader = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (req) => {
        receivedHeader = req.headers.get('x-custom') ?? '';
        return new Response('ok', { headers: { 'x-reply': 'from-server' } });
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/', {
        headers: { 'x-custom': 'my-value' },
      }));

      t.equal(receivedHeader, 'my-value', 'server received custom request header');
      t.equal(response.headers.get('x-reply'), 'from-server', 'client received custom response header');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('multiple concurrent requests on the same connection', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (req) => {
        const id = new URL(req.url).pathname.slice(1);
        return new Response(`response-${id}`);
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));

      const [r1, r2, r3] = await pipe.pumpUntil(Promise.all([
        session.request('https://localhost/1'),
        session.request('https://localhost/2'),
        session.request('https://localhost/3'),
      ]));

      t.equal(r1.status, 200, 'response 1 status');
      t.equal(r2.status, 200, 'response 2 status');
      t.equal(r3.status, 200, 'response 3 status');

      const [b1, b2, b3] = await Promise.all([
        r1.arrayBuffer().then((b) => new TextDecoder().decode(b)),
        r2.arrayBuffer().then((b) => new TextDecoder().decode(b)),
        r3.arrayBuffer().then((b) => new TextDecoder().decode(b)),
      ]);

      const bodies = [b1, b2, b3].sort();
      t.deepEqual(bodies, ['response-1', 'response-2', 'response-3'], 'all concurrent responses received');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('404 response for unknown route', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (_req) =>
        new Response('not found', { status: 404 }),
      );

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/missing'));

      t.equal(response.status, 404, 'server returned 404');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('empty body GET request', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (_req) =>
        new Response(null, { status: 204 }),
      );

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/empty'));

      t.equal(response.status, 204, 'server returned 204 with no body');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('binary response body preserved', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const original = new Uint8Array(256);
      for (let i = 0; i < 256; i++) original[i] = i;

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (_req) =>
        new Response(original, { headers: { 'content-type': 'application/octet-stream' } }),
      );

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/binary'));

      t.equal(response.status, 200, 'status 200');
      const received = new Uint8Array(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(received.byteLength, 256, 'received 256 bytes');
      t.ok(received.every((b, i) => b === original[i]), 'binary bytes match');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('server exception returns 500', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (_req) => {
        throw new Error('handler error');
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/crash'));

      t.equal(response.status, 500, 'uncaught handler error yields 500');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('request with trailers is dispatched by server', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      let receivedBody = '';
      let receivedTrailers: Array<[string, string]> = [];
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        receivedBody = await req.text();
        receivedTrailers = (req as any).trailerHeaders ?? [];
        return new Response(`echo:${receivedBody}`);
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/upload', {
        method: 'POST',
        body: new TextEncoder().encode('trailer-body'),
        trailers: [['x-checksum', '42']],
      }));

      t.equal(response.status, 200, 'server dispatched request with trailers');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(text, 'echo:trailer-body', 'server received body before trailers');
      t.deepEqual(receivedTrailers, [['x-checksum', '42']], 'server received request trailers');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('response with trailers is received by client', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (_req) =>
        new Response('body-with-trailers', { trailers: new Headers([['x-digest', 'sha256-abc']]) }),
      );

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));

      t.equal(response.status, 200, 'response with trailers resolves correctly');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(text, 'body-with-trailers', 'response body is complete');
      const trailers = await response.trailers;
      t.equal(trailers.get('x-digest'), 'sha256-abc', 'response trailer received by client');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('connection close rejects in-flight requests', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      // Handler returns a promise that never resolves — simulates a slow handler.
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => new Promise<Response>(() => {}));

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));

      // Submit the request and pump until the pipe settles (request headers
      // delivered to server, handler entered, no more QUIC traffic pending).
      const requestPromise = session.request('https://localhost/hang');
      await pipe.runUntilSettled();

      // Now destroy the server — it sends CONNECTION_CLOSE to the client.
      serverConn.destroy();

      await t.rejects(
        () => pipe.pumpUntil(requestPromise),
        /H3 stream (closed|reset)/,
        'in-flight request rejected when connection closes',
      );

      clientConn.destroy();
      await pipe.pumpUntil(serverDone).catch(() => {});
    } finally {
      await pipe.close();
    }
  });

  it('HEAD request is dispatched and returns headers', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (req) =>
        new Response(null, { status: 200, headers: { 'x-method': req.method } }),
      );

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/', { method: 'HEAD' }));

      t.equal(response.status, 200, 'HEAD response status is 200');
      t.equal(response.headers.get('x-method'), 'HEAD', 'server received HEAD method');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('POST with no body is dispatched correctly', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      let receivedBody = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        receivedBody = await req.text();
        return new Response(`echo:${receivedBody}`);
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/', { method: 'POST' }));

      t.equal(response.status, 200, 'bodyless POST returns 200');
      t.equal(receivedBody, '', 'server received empty body');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('response trailers on empty body are received by client', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (_req) =>
        new Response(new Uint8Array(0), { trailers: new Headers([['x-empty', 'yes']]) } as any),
      );

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));

      t.equal(response.status, 200, 'empty-body response with trailers resolves');
      const trailers = await response.trailers;
      t.equal(trailers.get('x-empty'), 'yes', 'trailer received on empty body response');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('connection close rejects multiple concurrent in-flight requests', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => new Promise<Response>(() => {}));

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));

      const p1 = session.request('https://localhost/hang1');
      const p2 = session.request('https://localhost/hang2');
      const p3 = session.request('https://localhost/hang3');
      await pipe.runUntilSettled();

      serverConn.destroy();

      const results = await pipe.pumpUntil(Promise.allSettled([p1, p2, p3]));
      const rejected = results.filter((r) => r.status === 'rejected');
      t.equal(rejected.length, 3, 'all 3 in-flight requests rejected when connection closes');

      clientConn.destroy();
      await pipe.pumpUntil(serverDone).catch(() => {});
    } finally {
      await pipe.close();
    }
  });

  it('handler can explicitly return 400 Bad Request', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (_req) =>
        new Response('Bad Request', { status: 400, headers: { 'x-reason': 'invalid-input' } }),
      );

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));

      t.equal(response.status, 400, 'client receives 400 from handler');
      t.equal(response.headers.get('x-reason'), 'invalid-input', '400 response headers forwarded');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('stream-level error on one stream does not kill concurrent requests', async (t) => {
    if (!available) return;

    // Sending a `connection` header triggers NGHTTP3_ERR_MALFORMED_HTTP_MESSAGING (-107) on the
    // server. Without the Bug 1 fix, the server calls this.close() which destroys the entire
    // nghttp3 session — killing all concurrent requests. With the fix, only the bad stream is
    // reset and the concurrent normal request completes normally.
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => new Response('alive'));

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));

      const [, goodResult] = await pipe.pumpUntil(Promise.allSettled([
        session.request('https://localhost/bad', { headers: new Headers([['connection', 'close']]) }),
        session.request('https://localhost/ok'),
      ]));

      t.equal(goodResult.status, 'fulfilled', 'normal request succeeds when bad stream triggers stream-level error');
      if (goodResult.status === 'fulfilled') {
        t.equal((goodResult as PromiseFulfilledResult<Response>).value.status, 200, 'normal request returns 200');
      }

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('te header with non-trailers value is rejected; te: trailers is allowed (RFC 9114 §4.2)', async (t) => {
    if (!available) return;

    // nghttp3 enforces the te: trailers-only rule at the protocol layer (stream error),
    // so the bad request is rejected before JS can send a 400. The good request must
    // complete normally — this also verifies stream isolation.
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      let teHeaderInHandler: string | null = 'not-called';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (req) => {
        teHeaderInHandler = req.headers.get('te');
        return new Response('ok');
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));

      const [badResult, goodResult] = await pipe.pumpUntil(Promise.allSettled([
        session.request('https://localhost/bad-te', { headers: new Headers([['te', 'gzip']]) }),
        session.request('https://localhost/good-te', { headers: new Headers([['te', 'trailers']]) }),
      ]));

      t.equal(badResult.status, 'rejected', 'te: gzip is rejected');
      t.equal(goodResult.status, 'fulfilled', 'te: trailers is allowed through');
      if (goodResult.status === 'fulfilled') {
        t.equal((goodResult as PromiseFulfilledResult<Response>).value.status, 200, 'te: trailers returns 200');
      }
      t.equal(teHeaderInHandler, null, 'te: trailers is not forwarded to handler (RFC 9114 §4.2)');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('session.close() while request is in-flight rejects cleanly without crash', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => new Response('ok'));

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));

      const requestPromise = session.request('https://localhost/');
      session.close();

      const [result] = await pipe.pumpUntil(Promise.allSettled([requestPromise]));
      t.ok(result.status === 'rejected' || result.status === 'fulfilled',
        'request settles without crashing');

      clientConn.destroy();
      await pipe.pumpUntil(serverDone).catch(() => {});
    } finally {
      await pipe.close();
    }
  });

  it('submit methods throw "session closed" after close(), not use-after-free', async (t) => {
    if (!available) return;

    const session = Nghttp3Session.createServer({
      onBeginHeaders() {}, onRecvHeader() {}, onEndHeaders() {},
      onBeginTrailers() {}, onRecvTrailer() {}, onEndTrailers() {},
      onRecvData() {}, onEndStream() {},
      onStreamClose() {}, onResetStream() {}, onAckedStreamData() {},
    });
    session.close();

    t.throws(() => session.submitResponse(0n, [[':status', '200']]),
      /session closed/, 'submitResponse throws after close');
    t.throws(() => session.submitRequest(0n, [[':method', 'GET'], [':path', '/'], [':scheme', 'https'], [':authority', 'localhost']]),
      /session closed/, 'submitRequest throws after close');
    t.throws(() => session.submitTrailers(0n, [['x-done', '1']]),
      /session closed/, 'submitTrailers throws after close');
    await t.rejects(() => session.drainWrites(), /session closed/, 'drainWrites rejects after close');
  });

  it('run() releases nghttp3 session when connection closes during setup', async (t) => {
    if (!available) return;

    // Destroy the server connection before H3ServerDriver.run() can open the mandatory
    // unidirectional streams, triggering the setup-failure path. With the Bug 2 fix,
    // the nghttp3 session is closed in the finally block. Without it, the session leaks.
    // Both cases complete without hanging — the test guards against future hangs.
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);
      clientConn.destroy();
      serverConn.destroy();

      const driver = new H3ServerDriver();
      await pipe.pumpUntil(driver.run(serverConn, () => new Response('ok')).catch(() => {}));

      t.ok(true, 'run() completes without hanging when connection closes during setup');
    } finally {
      await pipe.close();
    }
  });

  it('OPTIONS request with body is received by handler', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      let receivedBody = '';
      let receivedMethod = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        receivedMethod = req.method;
        receivedBody = await req.text();
        return new Response(null, { status: 204, headers: { allow: 'GET, HEAD, POST, OPTIONS' } });
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/', {
        method: 'OPTIONS',
        body: new TextEncoder().encode('xml-options-document'),
      }));

      t.equal(response.status, 204, 'OPTIONS response is 204');
      t.equal(receivedMethod, 'OPTIONS', 'handler sees OPTIONS method');
      t.equal(receivedBody, 'xml-options-document', 'server received OPTIONS body');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('request() after close() rejects immediately without unhandled rejection', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => new Response('ok'));

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      session.close();

      await t.rejects(
        () => session.request('https://localhost/'),
        /H3 session is closed/,
        'request() after close() rejects with closed error',
      );

      clientConn.destroy();
      await pipe.pumpUntil(serverDone).catch(() => {});
    } finally {
      await pipe.close();
    }
  });

  it('forbidden HTTP/1.1 response headers are stripped before sending to client (RFC 9114 §4.2)', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async () => {
        return new Response('ok', {
          headers: {
            'transfer-encoding': 'chunked',
            'connection': 'keep-alive',
            'x-custom': 'pass',
          },
        });
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));

      t.equal(response.status, 200, 'response status is 200');
      t.ok(!response.headers.has('transfer-encoding'), 'transfer-encoding is stripped');
      t.ok(!response.headers.has('connection'), 'connection is stripped');
      t.equal(response.headers.get('x-custom'), 'pass', 'non-forbidden headers pass through');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('sequential requests on the same session complete in order with correct bodies', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (req) => {
        const path = new URL(req.url).pathname;
        return new Response(`response:${path}`);
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));

      const r1 = await pipe.pumpUntil(session.request('https://localhost/first'));
      t.equal(r1.status, 200, 'first request status');
      const body1 = await r1.text();
      t.equal(body1, 'response:/first', 'first response body');

      const r2 = await pipe.pumpUntil(session.request('https://localhost/second'));
      t.equal(r2.status, 200, 'second request status');
      const body2 = await r2.text();
      t.equal(body2, 'response:/second', 'second response body');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('POST with content-type header delivers both header and body to handler', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      let receivedContentType: string | null = null;
      let receivedBody = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        receivedContentType = req.headers.get('content-type');
        receivedBody = await req.text();
        return new Response('ok');
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/upload', {
        method: 'POST',
        body: new TextEncoder().encode('hello world'),
        headers: { 'content-type': 'text/plain' },
      }));

      t.equal(response.status, 200, 'POST with content-type returns 200');
      t.equal(receivedContentType, 'text/plain', 'server received content-type header');
      t.equal(receivedBody, 'hello world', 'server received body');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('query string round-trips through :path', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      let receivedSearch = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (req) => {
        receivedSearch = new URL(req.url).search;
        return new Response('ok');
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/search?q=hello&page=2'));

      t.equal(response.status, 200, 'request with query string returns 200');
      t.equal(receivedSearch, '?q=hello&page=2', 'query string round-trips through :path');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('DELETE request without body is dispatched immediately', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (req) =>
        new Response(null, { status: 200, headers: { 'x-method': req.method } }),
      );

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/resource', { method: 'DELETE' }));

      t.equal(response.status, 200, 'DELETE returns 200');
      t.equal(response.headers.get('x-method'), 'DELETE', 'server received DELETE method');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('explicit content-length response header is forwarded to client', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (_req) =>
        new Response('hello', { headers: { 'content-length': '5', 'content-type': 'text/plain' } }),
      );

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));

      t.equal(response.status, 200, 'response status is 200');
      t.equal(response.headers.get('content-length'), '5', 'content-length is forwarded to client');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(text, 'hello', 'response body is correct');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('PUT request with body is dispatched correctly', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      let receivedMethod = '';
      let receivedBody = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        receivedMethod = req.method;
        receivedBody = await req.text();
        return new Response(`echo:${receivedBody}`);
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/resource', {
        method: 'PUT',
        body: new TextEncoder().encode('put-data'),
      }));

      t.equal(response.status, 200, 'PUT returns 200');
      t.equal(receivedMethod, 'PUT', 'server received PUT method');
      t.equal(receivedBody, 'put-data', 'server received PUT body');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(text, 'echo:put-data', 'response body echoes PUT request');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('concurrent requests with mixed body and no-body complete correctly', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        const body = await req.text();
        return new Response(body || 'empty', { headers: { 'x-method': req.method } });
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));

      const postBody = new Uint8Array(512).fill(0x41); // 512 'A's
      const [rGet, rPost, rDelete] = await pipe.pumpUntil(Promise.all([
        session.request('https://localhost/a'),
        session.request('https://localhost/b', { method: 'POST', body: postBody }),
        session.request('https://localhost/c', { method: 'DELETE' }),
      ]));

      t.equal(rGet.status, 200, 'GET returns 200');
      t.equal(rGet.headers.get('x-method'), 'GET', 'GET method echoed');
      t.equal(rPost.status, 200, 'POST returns 200');
      t.equal(rPost.headers.get('x-method'), 'POST', 'POST method echoed');
      const postText = new TextDecoder().decode(await rPost.arrayBuffer());
      t.equal(postText, 'A'.repeat(512), 'POST body echoed correctly');
      t.equal(rDelete.status, 200, 'DELETE returns 200');
      t.equal(rDelete.headers.get('x-method'), 'DELETE', 'DELETE method echoed');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('large body (100 KB) round-trip', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      let receivedByteCount = 0;
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        const ab = await req.arrayBuffer();
        receivedByteCount = ab.byteLength;
        return new Response(new Uint8Array(ab));
      });

      const bodySize = 100 * 1024;
      const payload = new Uint8Array(bodySize);
      for (let i = 0; i < bodySize; i++) payload[i] = i & 0xff;

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/large', {
        method: 'POST',
        body: payload,
      }));

      t.equal(response.status, 200, 'large body response status');
      t.equal(receivedByteCount, bodySize, 'server received all bytes');
      const received = new Uint8Array(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(received.byteLength, bodySize, 'client received all echoed bytes');
      t.ok(received.every((b, i) => b === (i & 0xff)), 'echoed bytes match original');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('HEAD response body is suppressed even when handler returns one', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () =>
        new Response('should-not-arrive', { headers: { 'content-length': '17' } }),
      );

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/', { method: 'HEAD' }));

      t.equal(response.status, 200, 'HEAD returns 200');
      t.equal(response.headers.get('content-length'), '17', 'content-length header forwarded');
      const body = new Uint8Array(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(body.byteLength, 0, 'body is empty for HEAD response');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('PATCH request with body is dispatched correctly', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      let receivedMethod = '';
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        receivedMethod = req.method;
        const body = await req.text();
        return new Response(`echo:${body}`, { headers: { 'x-method': req.method } });
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/item', {
        method: 'PATCH',
        body: new TextEncoder().encode('patch-payload'),
      }));

      t.equal(response.status, 200, 'PATCH returns 200');
      t.equal(response.headers.get('x-method'), 'PATCH', 'server received PATCH method');
      t.equal(receivedMethod, 'PATCH', 'server method matches');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(text, 'echo:patch-payload', 'response body echoes PATCH request');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('request trailers from client are received by the server handler', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      let receivedTrailers: Array<[string, string]> = [];
      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, async (req) => {
        await req.arrayBuffer();
        receivedTrailers = (req as any).trailerHeaders as Array<[string, string]>;
        return new Response('ok');
      });

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/', {
        method: 'POST',
        body: new TextEncoder().encode('body-data'),
        trailers: [['x-req-trailer', 'trailer-value'], ['x-seq', '42']],
      }));

      t.equal(response.status, 200, 'request with trailers returns 200');
      t.equal(receivedTrailers.length, 2, 'server received 2 trailer entries');
      const trailerMap = Object.fromEntries(receivedTrailers);
      t.equal(trailerMap['x-req-trailer'], 'trailer-value', 'x-req-trailer received');
      t.equal(trailerMap['x-seq'], '42', 'x-seq received');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('handler returning non-Response value sends 500 to client', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () => undefined as any);

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));

      t.equal(response.status, 500, 'non-Response handler yields 500');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('forbidden headers in response trailers are stripped (RFC 9114 §4.2)', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, () =>
        new Response('body', {
          trailers: new Headers([['transfer-encoding', 'chunked'], ['x-safe', 'yes']]),
        } as any),
      );

      const session = await pipe.pumpUntil(H3ClientSession.create(clientConn));
      const response = await pipe.pumpUntil(session.request('https://localhost/'));

      t.equal(response.status, 200, 'response with filtered trailers is 200');
      const text = new TextDecoder().decode(await pipe.pumpUntil(response.arrayBuffer()));
      t.equal(text, 'body', 'response body is correct');
      const trailers = await response.trailers;
      t.equal(trailers.get('x-safe'), 'yes', 'safe trailer is received');
      t.equal(trailers.get('transfer-encoding'), null, 'forbidden trailer is stripped');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });

  it('server closeWhenIdle sends GOAWAY and onShutdown rejects higher stream IDs', async (t) => {
    if (!available) return;

    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      // Raw server session — gives us direct access to closeWhenIdle().
      let serverSession!: Nghttp3Session;
      serverSession = Nghttp3Session.createServer({
        onBeginHeaders() {},
        onRecvHeader() {},
        onEndHeaders(sid) {
          // Dispatch response immediately on header completion — no body for GET requests.
          void (async () => {
            try {
              serverSession.submitResponse(sid, [[':status', '200']]);
              await serverSession.drainWrites();
            } catch { /* connection or session closed */ }
          })();
        },
        onBeginTrailers() {}, onRecvTrailer() {}, onEndTrailers() {},
        onRecvData() {}, onEndStream() {},
        onStreamClose() {}, onResetStream() {}, onAckedStreamData() {},
      });

      serverConn.addEventListener('stream', (event) => {
        const stream = (event as QuicStreamEvent).stream;
        const sid = BigInt(stream.id);
        void (async () => {
          try {
            if (stream.direction === 'bidirectional') {
              serverSession.addQuicStream(sid, stream.writer);
            }
            while (true) {
              const bytes = await stream.reader.read() as Uint8Array | null;
              const fin = bytes === null;
              await serverSession.readStream(sid, bytes ?? new Uint8Array(0), fin);
              if (fin) break;
            }
          } catch { /* session or connection closed */ }
        })();
      });

      const [ctrl, qenc, qdec] = await pipe.pumpUntil(Promise.all([
        serverConn.openUnidirectionalStream(),
        serverConn.openUnidirectionalStream(),
        serverConn.openUnidirectionalStream(),
      ])) as QuicStream[];
      for (const s of [ctrl, qenc, qdec]) serverSession.addQuicStream(BigInt(s.id), s.writer);
      serverSession.bindControlStream(BigInt(ctrl.id));
      serverSession.bindQpackStreams(BigInt(qenc.id), BigInt(qdec.id));
      // Create the client session before pumping server drainWrites so its 'stream'
      // listener is attached before the server's SETTINGS arrive on stream 3.
      const clientSessionPromise = H3ClientSession.create(clientConn);
      await pipe.pumpUntil(serverSession.drainWrites());
      const clientSession = await pipe.pumpUntil(clientSessionPromise);

      // Complete request 1 (stream 0) — server's onEndHeaders responds with 200.
      const req1 = await pipe.pumpUntil(clientSession.request('https://localhost/'));
      t.equal(req1.status, 200, 'request 1 succeeds before GOAWAY');
      await pipe.pumpUntil(req1.arrayBuffer());

      // Pump the GOAWAY through to the client. After this returns, onShutdown has
      // fired and #goawayLastStreamId is set — so request() throws before opening
      // a new stream, regardless of the conservative lastStreamId value nghttp3 sent.
      await pipe.pumpUntil(serverSession.closeWhenIdle());

      await t.rejects(
        () => clientSession.request('https://localhost/'),
        /GOAWAY/,
        'request after GOAWAY is rejected',
      );

      serverConn.destroy();
      clientConn.destroy();
    } finally {
      await pipe.close();
    }
  });

  it('server per-stream RESET_STREAM rejects only that request, not concurrent ones', async (t) => {
    if (!available) return;

    // Verifies that a QUIC RESET_STREAM sent by the server for one specific stream
    // rejects only that pending request — the other concurrent request on a different
    // stream completes normally, confirming stream isolation.
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      // Raw server session: stream 0 gets reset at the QUIC level, stream 4 responds normally.
      let serverSession!: Nghttp3Session;
      serverSession = Nghttp3Session.createServer({
        onBeginHeaders() {},
        onRecvHeader() {},
        onEndHeaders(sid) {
          void (async () => {
            try {
              serverSession.submitResponse(sid, [[':status', '200']]);
              await serverSession.drainWrites();
            } catch { /* connection or session closed */ }
          })();
        },
        onBeginTrailers() {}, onRecvTrailer() {}, onEndTrailers() {},
        onRecvData() {}, onEndStream() {},
        onStreamClose() {}, onResetStream() {}, onAckedStreamData() {},
      });

      serverConn.addEventListener('stream', (event) => {
        const stream = (event as QuicStreamEvent).stream;
        const sid = BigInt(stream.id);
        void (async () => {
          try {
            if (stream.direction === 'bidirectional' && sid === 0n) {
              // Reset stream 0 without processing it through nghttp3.
              // H3_REQUEST_CANCELLED = 0x010c signals an intentional server-side rejection.
              stream.reset(0x010c);
              return;
            }
            if (stream.direction === 'bidirectional') {
              serverSession.addQuicStream(sid, stream.writer);
            }
            while (true) {
              const bytes = await stream.reader.read() as Uint8Array | null;
              const fin = bytes === null;
              await serverSession.readStream(sid, bytes ?? new Uint8Array(0), fin);
              if (fin) break;
            }
          } catch { /* session or connection closed */ }
        })();
      });

      const [ctrl, qenc, qdec] = await pipe.pumpUntil(Promise.all([
        serverConn.openUnidirectionalStream(),
        serverConn.openUnidirectionalStream(),
        serverConn.openUnidirectionalStream(),
      ])) as QuicStream[];
      for (const s of [ctrl, qenc, qdec]) serverSession.addQuicStream(BigInt(s.id), s.writer);
      serverSession.bindControlStream(BigInt(ctrl.id));
      serverSession.bindQpackStreams(BigInt(qenc.id), BigInt(qdec.id));
      const clientSessionPromise = H3ClientSession.create(clientConn);
      await pipe.pumpUntil(serverSession.drainWrites());
      const clientSession = await pipe.pumpUntil(clientSessionPromise);

      const [resetResult, okResult] = await pipe.pumpUntil(Promise.allSettled([
        clientSession.request('https://localhost/reset'),
        clientSession.request('https://localhost/ok'),
      ]));

      t.equal(resetResult.status, 'rejected', 'stream 0 reset by server rejects that request');
      t.equal(okResult.status, 'fulfilled', 'concurrent request on stream 4 completes normally');
      if (okResult.status === 'fulfilled') {
        t.equal((okResult as PromiseFulfilledResult<Response>).value.status, 200, 'stream 4 request returns 200');
      }

      serverConn.destroy();
      clientConn.destroy();
    } finally {
      await pipe.close();
    }
  });

  it('CONNECT request is rejected with 405', async (t) => {
    if (!available) return;

    // Per RFC 9114 §4.4, CONNECT requests send HEADERS without FIN and omit :path/:scheme.
    // Without the noBody fix, startDispatch never fires for CONNECT and the client hangs.
    // We use a raw Nghttp3Session client because H3ClientSession.request() always includes
    // :path/:scheme, which nghttp3 rejects as malformed before our dispatch fix applies.
    //
    // Critical ordering: register the clientConn stream listener BEFORE any pumpUntil so
    // the server's unidirectional control/QPACK streams are captured as they arrive.
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      const driver = new H3ServerDriver();
      const serverDone = driver.run(serverConn, (_req) => new Response('ok'));

      let connectStatus = '';
      let resolveConnect!: () => void;
      const connectResponsePromise = new Promise<void>((resolve) => { resolveConnect = resolve; });

      const clientSession = Nghttp3Session.createClient({
        onBeginHeaders() {},
        onRecvHeader(_sid, _token, name, value) {
          if (name === ':status') { connectStatus = value; resolveConnect(); }
        },
        onEndHeaders() {}, onBeginTrailers() {}, onRecvTrailer() {}, onEndTrailers() {},
        onRecvData() {}, onEndStream() {},
        onStreamClose() {}, onResetStream() {}, onAckedStreamData() {},
      });

      // Register BEFORE pumpUntil — same ordering discipline as H3ClientSession.create().
      clientConn.addEventListener('stream', (event) => {
        const stream = (event as QuicStreamEvent).stream;
        const sid = BigInt(stream.id);
        void (async () => {
          try {
            while (true) {
              const bytes = await stream.reader.read() as Uint8Array | null;
              const fin = bytes === null;
              await clientSession.readStream(sid, bytes ?? new Uint8Array(0), fin);
              if (fin) break;
            }
          } catch { /* session or connection closed */ }
        })();
      });

      // Open and bind client's mandatory unidirectional streams, drain client SETTINGS.
      const [ctrl, qenc, qdec] = await pipe.pumpUntil(Promise.all([
        clientConn.openUnidirectionalStream(),
        clientConn.openUnidirectionalStream(),
        clientConn.openUnidirectionalStream(),
      ])) as QuicStream[];
      for (const s of [ctrl, qenc, qdec]) clientSession.addQuicStream(BigInt(s.id), s.writer);
      clientSession.bindControlStream(BigInt(ctrl.id));
      clientSession.bindQpackStreams(BigInt(qenc.id), BigInt(qdec.id));
      await pipe.pumpUntil(clientSession.drainWrites());

      // Open the CONNECT stream and read the server's 405 response.
      const connectStream = await pipe.pumpUntil(clientConn.openBidirectionalStream()) as QuicStream;
      const connectSid = BigInt(connectStream.id);
      clientSession.addQuicStream(connectSid, connectStream.writer);

      void (async () => {
        try {
          while (true) {
            const bytes = await connectStream.reader.read() as Uint8Array | null;
            const fin = bytes === null;
            await clientSession.readStream(connectSid, bytes ?? new Uint8Array(0), fin);
            if (fin) break;
          }
        } catch { /* stream reset or session closed */ }
      })();

      // Submit CONNECT with only :method and :authority (RFC 9114 §4.4).
      clientSession.submitRequest(connectSid, [
        [':method', 'CONNECT'],
        [':authority', 'localhost:443'],
      ]);
      await pipe.pumpUntil(clientSession.drainWrites());

      await pipe.pumpUntil(connectResponsePromise);
      t.equal(connectStatus, '405', 'server rejects CONNECT with 405');
      t.ok(!clientSession.isClosed, 'nghttp3 client session remains open after 405');

      clientSession.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone).catch(() => {});
    } finally {
      await pipe.close();
    }
  });

  it('GOAWAY onShutdown rejects in-flight requests with sid > lastStreamId', async (t) => {
    if (!available) return;

    // Timeline:
    //   1. reqA (stream 0) completes — server's last received bidi = 0.
    //   2. reqB (stream 4) and reqC (stream 8) submitted before any pump.
    //   3. closeWhenIdle() queued on server. Server has received only stream 0, so
    //      nghttp3_conn_shutdown sets lastStreamId = 4 (last received + 4 grace).
    //   4. Pump: GOAWAY(4) reaches client → onShutdown(4) →
    //        reqB sid=4: not rejected (4 > 4 is false; might have been in flight)
    //        reqC sid=8: rejected with GOAWAY error (8 > 4 is true)
    const pipe = h3Pipe();
    try {
      const { client: clientConn, server: serverConn } = await h3Handshake(pipe);

      let serverSession!: Nghttp3Session;
      serverSession = Nghttp3Session.createServer({
        onBeginHeaders() {},
        onRecvHeader() {},
        onEndHeaders(sid) {
          void (async () => {
            try {
              serverSession.submitResponse(sid, [[':status', '200']]);
              await serverSession.drainWrites();
            } catch { }
          })();
        },
        onBeginTrailers() {}, onRecvTrailer() {}, onEndTrailers() {},
        onRecvData() {}, onEndStream() {},
        onStreamClose() {}, onResetStream() {}, onAckedStreamData() {},
      });

      serverConn.addEventListener('stream', (event) => {
        const stream = (event as QuicStreamEvent).stream;
        const sid = BigInt(stream.id);
        void (async () => {
          try {
            if (stream.direction === 'bidirectional') {
              serverSession.addQuicStream(sid, stream.writer);
            }
            while (true) {
              const bytes = await stream.reader.read() as Uint8Array | null;
              const fin = bytes === null;
              await serverSession.readStream(sid, bytes ?? new Uint8Array(0), fin);
              if (fin) break;
            }
          } catch { }
        })();
      });

      const [ctrl, qenc, qdec] = await pipe.pumpUntil(Promise.all([
        serverConn.openUnidirectionalStream(),
        serverConn.openUnidirectionalStream(),
        serverConn.openUnidirectionalStream(),
      ])) as QuicStream[];
      for (const s of [ctrl, qenc, qdec]) serverSession.addQuicStream(BigInt(s.id), s.writer);
      serverSession.bindControlStream(BigInt(ctrl.id));
      serverSession.bindQpackStreams(BigInt(qenc.id), BigInt(qdec.id));
      const clientSessionPromise = H3ClientSession.create(clientConn);
      await pipe.pumpUntil(serverSession.drainWrites());
      const clientSession = await pipe.pumpUntil(clientSessionPromise);

      // Step 1: reqA (stream 0) completes.
      const reqA = clientSession.request('https://localhost/a');
      const respA = await pipe.pumpUntil(reqA);
      t.equal(respA.status, 200, 'reqA (stream 0) completes with 200 before GOAWAY');

      // Steps 2–3: submit reqB (stream 4) and reqC (stream 8), then queue GOAWAY —
      // all before pumping. Server has only received stream 0, so lastStreamId = 4.
      const reqB = clientSession.request('https://localhost/b');
      const reqC = clientSession.request('https://localhost/c');
      const goawayDone = serverSession.closeWhenIdle();

      let reqCError: unknown;
      const reqCSettled = reqC.then(
        () => { reqCError = new Error('reqC resolved instead of rejecting'); },
        (e: unknown) => { reqCError = e; },
      );

      // Step 4: pump until GOAWAY sent and reqC rejected.
      await pipe.pumpUntil(Promise.all([goawayDone, reqCSettled]));

      t.ok(reqCError instanceof Error, 'reqC was rejected');
      t.ok(
        reqCError instanceof Error && /GOAWAY/.test(reqCError.message),
        `reqC rejected with GOAWAY: ${String(reqCError)}`,
      );

      // Future requests also rejected via #goawayLastStreamId guard.
      await t.rejects(
        () => clientSession.request('https://localhost/d'),
        /GOAWAY/,
        'new request after GOAWAY is rejected immediately',
      );

      // reqB eventually fails via connection close (server session is closed,
      // no response will ever arrive). Destroy connections to settle it.
      const reqBDone = reqB.then(() => {}, () => {});
      serverConn.destroy();
      clientConn.destroy();
      await pipe.pumpUntil(reqBDone);
    } finally {
      await pipe.close();
    }
  });
});
