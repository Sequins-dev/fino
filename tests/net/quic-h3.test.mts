import { describe, it } from 'fino:test/test';
import { quicAvailable } from 'fino:net/quic';
import { h3Available } from 'fino:net/http/h3';
import { H3ServerDriver } from '../../js/internal/net/http/h3/server.mts';
import { H3ClientSession } from '../../js/internal/net/http/h3/client.mts';
import { QuicPipe } from './fixtures/quic/sim-harness.mts';

const available = quicAvailable && h3Available;

function h3Pipe(): QuicPipe {
  return new QuicPipe({
    server: { alpnProtocols: ['h3'], connection: { maxIdleTimeoutMs: 0 } },
    client: { alpnProtocols: ['h3'], connection: { maxIdleTimeoutMs: 0 } },
  });
}

async function h3Handshake(pipe: QuicPipe) {
  const { client, server } = await pipe.handshake();
  return { client, server };
}

describe('HTTP/3 (h3 ALPN)', () => {
  it('h3Available is truthy when libnghttp3 is installed', async (t) => {
    if (!quicAvailable) return;
    t.ok(h3Available !== undefined, 'h3Available is exported');
    if (!h3Available) {
      t.ok(true, 'libnghttp3 not installed, skipping remaining H3 tests');
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
      const text = new TextDecoder().decode(await response.arrayBuffer());
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
      const text = new TextDecoder().decode(await response.arrayBuffer());
      t.equal(receivedBody, 'request-body-data', 'server received request body');
      t.equal(text, 'echo:request-body-data', 'response body echoes request');

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
      const received = new Uint8Array(await response.arrayBuffer());
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
      const text = new TextDecoder().decode(await response.arrayBuffer());
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
      const text = new TextDecoder().decode(await response.arrayBuffer());
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
      const received = new Uint8Array(await response.arrayBuffer());
      t.equal(received.byteLength, bodySize, 'client received all echoed bytes');
      t.ok(received.every((b, i) => b === (i & 0xff)), 'echoed bytes match original');

      session.close();
      clientConn.destroy();
      await pipe.pumpUntil(serverDone);
    } finally {
      await pipe.close();
    }
  });
});
