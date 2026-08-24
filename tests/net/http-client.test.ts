/**
 * Tests for fino:net/http/client.
 */
import { describe, it } from 'fino:test/test';
import { serve, serveHttp } from 'fino:net/http/server';
import { HttpClient } from 'fino:net/http/client';
import { EventSourceWriter } from 'fino:net/http/eventstream';
import { BytesWriter } from 'fino:stream';
import { MessageEvent } from 'fino:net/http/websocket';
import { h2Available } from '../../js/net/http/h2.ts';
import { h3Available, serve as h3Serve } from 'internal:net/http/h3';
import { quicAvailable } from 'fino:net/quic';
import { _fetchH2PoolHas, _resetFetchH2Pool } from 'internal:globals/fetch';
import type { Event, EventTarget } from 'internal:globals/eventtarget';
import * as loop from 'internal:runtime/loop';
import { compress } from 'fino:compress';
const CERT_PATH = new URL('./fixtures/test.crt', import.meta.url).pathname;
const KEY_PATH = new URL('./fixtures/test.key', import.meta.url).pathname;
const tlsAvailable = (
  globalThis as typeof globalThis & {
    tlsAvailable?: boolean;
  }
).tlsAvailable;
const skipH2 = (!h2Available || !tlsAvailable) && 'requires libnghttp2 + OpenSSL';
const skipH3 = (!quicAvailable || !h3Available) && 'requires QUIC + libnghttp3';
function waitForEvent<T extends Event>(
  target: EventTarget,
  name: string,
  timeoutMs = 5e3,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = loop.timeout(timeoutMs);
    timer
      .then(() => reject(new Error('waitForEvent timed out waiting for: ' + name)))
      .catch(() => {});
    target.addEventListener(
      name,
      function handler(event) {
        timer.cancel();
        target.removeEventListener(name, handler);
        resolve(event as T);
      },
      { once: true },
    );
  });
}
function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 1e3): Promise<T> {
  const timer = loop.timeout(timeoutMs);
  const guard = timer.then<T>(() => {
    throw new Error(message);
  });
  return Promise.race([promise, guard]).finally(() => timer.cancel());
}
describe('HttpClient over HTTP/1.1', { exclusive: true }, () => {
  it('request() returns rich response metadata and body helpers', async (t) => {
    const server = serveHttp({ port: 0 }, async (request) => {
      const body = JSON.stringify({
        method: request.method,
        path: new URL(request.url).pathname,
      });
      return new Response(
        {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode(body);
          },
        },
        {
          status: 201,
          headers: {
            'content-type': 'application/json',
            'x-test': 'client',
          },
          trailers: new Headers({ 'x-trailer': 'done' }),
        },
      );
    });
    const client = new HttpClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    try {
      const res = await client.request('/users', {
        method: 'POST',
        body: 'hello',
      });
      t.equal(res.status, 201);
      t.equal(res.headers.get('x-test'), 'client');
      t.equal(res.protocol, 'http/1.1');
      t.equal(res.session.protocol, 'http/1.1');
      t.equal(res.request.method, 'POST');
      t.equal(res.request.url, `http://127.0.0.1:${server.port}/users`);
      t.ok(res.connection, 'connection info is present');
      t.notEqual(
        res.session.id,
        res.connection?.id,
        'session identity differs from connection identity',
      );
      const json = (await res.json()) as {
        method: string;
        path: string;
      };
      t.deepEqual(json, {
        method: 'POST',
        path: '/users',
      });
      t.ok(res.timing.queueEnd >= res.timing.scheduledTime);
      t.ok(res.timing.responseHeadersEnd! >= res.timing.startTime);
      t.ok(res.timing.firstResponseByte! >= res.timing.responseHeadersEnd!);
      t.ok(res.timing.bodyEnd! >= res.timing.firstResponseByte!);
      t.equal((await res.trailers).get('x-trailer'), 'done');
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('bytes(), close(), and toFetchResponse() preserve single-consumption behavior', async (t) => {
    const server = serveHttp({ port: 0 }, async () => new Response('hello'));
    const client = new HttpClient();
    try {
      const res = await client.request(`http://127.0.0.1:${server.port}/bytes`);
      const bytes = await res.bytes();
      t.equal(new TextDecoder().decode(bytes), 'hello');
      await t.rejects(() => res.text(), /Body already consumed/);
      const second = await client.request(`http://127.0.0.1:${server.port}/fetch`);
      const fetchResponse = second.toFetchResponse();
      t.equal(fetchResponse.status, 200);
      t.equal(await fetchResponse.text(), 'hello');
      await t.rejects(() => second.text(), /Body already consumed/);
      const third = await client.request(`http://127.0.0.1:${server.port}/close`);
      await third.close();
      await t.rejects(() => third.text(), /Body already consumed/);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('fetch() returns a standard Response', async (t) => {
    const server = serveHttp({ port: 0 }, async () => Response.json({ ok: true }));
    const client = new HttpClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    try {
      const res = await client.fetch('/');
      t.equal(res.status, 200);
      t.deepEqual(await res.json(), { ok: true });
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('session() keeps a stable logical H1 session id across requests', async (t) => {
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const client = new HttpClient();
    try {
      const session = await client.session(`http://127.0.0.1:${server.port}`);
      const first = await session.request({ path: '/one' });
      await first.discard('consume');
      const second = await session.request({ path: '/two' });
      t.equal(first.session.id, session.id);
      t.equal(second.session.id, session.id);
      t.equal(
        first.connection?.id,
        second.connection?.id,
        'H1 reuses its physical connection after response EOF',
      );
      t.equal(second.connection?.reused, true);
      await second.discard('consume');
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('bounds H1 connections and pending acquisition fairly', async (t) => {
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const client = new HttpClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      connections: 2,
      maxPendingRequests: 1,
    });
    try {
      const session = await client.session('/');
      const first = await session.request({ path: '/one' });
      const second = await session.request({ path: '/two' });
      t.notEqual(first.connection?.id, second.connection?.id);
      const thirdPromise = session.request({ path: '/three' });
      t.deepEqual(session.capacity, { connections: 2, active: 2, pending: 1, limit: 2 });
      await t.rejects(() => session.request({ path: '/overflow' }), /queue is full/);
      await first.discard('consume');
      const third = await withTimeout(thirdPromise, 'queued H1 request was not released');
      t.equal(third.connection?.id, first.connection?.id, 'oldest waiter reuses released slot');
      await second.discard('consume');
      await third.discard('consume');
      t.equal(session.capacity.active, 0);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('applies headers/body-idle deadlines and content decoding policy', async (t) => {
    let releaseHeaders!: () => void;
    const headersGate = new Promise<void>((resolve) => {
      releaseHeaders = resolve;
    });
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const packed = compress(new TextEncoder().encode('compressed'), { format: 'gzip' });
    const server = serveHttp({ port: 0 }, async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/headers-timeout') {
        await headersGate;
        return new Response('late');
      }
      if (path === '/body-timeout') {
        return new Response({
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode('first');
            await bodyGate;
            yield new TextEncoder().encode('-late');
          },
        });
      }
      return new Response(packed, { headers: { 'content-encoding': 'gzip' } });
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const client = new HttpClient({ baseUrl: origin });
    try {
      await t.rejects(
        () => client.request('/connect-timeout', { timeouts: { connect: 0 } }),
        /connection timeout/,
      );
      await t.rejects(
        () => client.request('/headers-timeout', { timeouts: { headers: 20 } }),
        /headers timeout/,
      );
      const idle = await client.request('/body-timeout', { timeouts: { bodyIdle: 20 } });
      const iterator = idle.body![Symbol.asyncIterator]();
      t.equal(new TextDecoder().decode((await iterator.next()).value), 'first');
      await t.rejects(() => iterator.next(), /body idle timeout/);
      const total = await client.request('/body-timeout', { timeouts: { total: 20 } });
      await loop.timeout(40);
      t.equal(total.session.capacity.active, 0, 'total timeout releases an unread response');
      const decoded = await client.request('/compressed');
      t.equal(await decoded.text(), 'compressed');
      const encoded = await client.request('/compressed', { decompress: false });
      t.equal(encoded.headers.get('content-encoding'), 'gzip');
      t.deepEqual(await encoded.bytes(), packed);
    } finally {
      releaseHeaders();
      releaseBody();
      await client.close();
      await server.close();
    }
  });
  it('retries only replayable idempotent requests after a stale pooled connection', async (t) => {
    const server = serveHttp(
      { port: 0, idleTimeoutMs: 5 },
      async (request) => new Response(new URL(request.url).pathname),
    );
    const client = new HttpClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      retry: { attempts: 2 },
    });
    try {
      const first = await client.request('/first');
      await first.discard();
      await loop.timeout(20);
      const retried = await client.request('/retried');
      t.equal(await retried.text(), '/retried');
      t.equal(retried.request.attempt, 2);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
describe('HttpClient protocol sessions', { exclusive: true }, () => {
  it(
    'streams H2 responses before EOF and can discard one without closing the connection',
    { skip: skipH2 },
    async (t) => {
      await _resetFetchH2Pool();
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      let releaseDiscard!: () => void;
      const discardGate = new Promise<void>((resolve) => {
        releaseDiscard = resolve;
      });
      const server = serveHttp(
        {
          port: 0,
          tls: {
            cert: CERT_PATH,
            key: KEY_PATH,
          },
        },
        async (request) => {
          const path = new URL(request.url).pathname;
          if (path === '/stream') {
            async function* body() {
              yield new TextEncoder().encode('first');
              await streamGate;
              yield new TextEncoder().encode('-second');
            }
            return new Response(body());
          }
          if (path === '/discard') {
            async function* body() {
              yield new TextEncoder().encode('started');
              await discardGate;
              yield new TextEncoder().encode('-late');
            }
            return new Response(body());
          }
          return new Response('reused');
        },
      );
      const origin = `https://127.0.0.1:${server.port}`;
      const client = new HttpClient({
        baseUrl: origin,
        protocols: ['h2'],
        tls: { rejectUnauthorized: false },
      });
      try {
        const streaming = await withTimeout(
          client.request('/stream'),
          'HttpClient waited for H2 response EOF',
          250,
        );
        const iterator = streaming.body![Symbol.asyncIterator]();
        const first = await withTimeout(
          iterator.next(),
          'first H2 response chunk was not readable before EOF',
          250,
        );
        t.equal(new TextDecoder().decode(first.value), 'first');
        releaseStream();
        const second = await iterator.next();
        const end = await iterator.next();
        t.equal(new TextDecoder().decode(second.value), '-second');
        t.equal(end.done, true);

        const discarded = await withTimeout(
          client.request('/discard'),
          'discardable H2 response did not resolve at headers',
          250,
        );
        await discarded.close();
        const reused = await client.request('/after-discard');
        t.equal(await reused.text(), 'reused', 'discard keeps the H2 connection reusable');
        t.ok(_fetchH2PoolHas(origin), 'pooled H2 connection remains available');
      } finally {
        releaseStream();
        releaseDiscard();
        await client.close();
        await server.close();
        await _resetFetchH2Pool();
      }
    },
  );
  it(
    'HTTPS requests reuse the H2 pool and expose h2 protocol metadata',
    { skip: skipH2 },
    async (t) => {
      await _resetFetchH2Pool();
      let count = 0;
      const server = serveHttp(
        {
          port: 0,
          tls: {
            cert: CERT_PATH,
            key: KEY_PATH,
          },
          idleTimeoutMs: 25,
          headersTimeoutMs: 25,
        },
        async () => new Response(`h2:${++count}`),
      );
      const origin = `https://127.0.0.1:${server.port}`;
      const client = new HttpClient({
        baseUrl: origin,
        protocols: ['h2', 'http/1.1'],
        tls: { rejectUnauthorized: false },
      });
      try {
        const first = await client.request('/one');
        const connectionId = first.connection?.id;
        t.equal(first.protocol, 'h2');
        t.equal(first.session.protocol, 'h2');
        t.equal(await first.text(), 'h2:1');
        t.ok(_fetchH2PoolHas(origin), 'pool entry created');
        const second = await client.request('/two');
        t.equal(second.protocol, 'h2');
        t.equal(await second.text(), 'h2:2');
        t.ok(_fetchH2PoolHas(origin), 'pool entry reused');
        t.equal(second.connection?.id, connectionId);
        t.equal(second.connection?.reused, true);
        t.ok(typeof second.connection?.streamId === 'number');
      } finally {
        await client.close();
        await server.close();
        await _resetFetchH2Pool();
      }
    },
  );
  it('streams H2 uploads before the source reaches EOF', { skip: skipH2 }, async (t) => {
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let sawFirst!: () => void;
    const firstChunkSeen = new Promise<void>((resolve) => {
      sawFirst = resolve;
    });
    const server = serveHttp(
      {
        port: 0,
        tls: { cert: CERT_PATH, key: KEY_PATH },
      },
      async (request) => {
        const iterator = request.body![Symbol.asyncIterator]();
        const first = await iterator.next();
        t.equal(new TextDecoder().decode(first.value), 'first');
        sawFirst();
        const second = await iterator.next();
        t.equal(new TextDecoder().decode(second.value), '-second');
        return new Response('uploaded');
      },
    );
    const client = new HttpClient({
      baseUrl: `https://127.0.0.1:${server.port}`,
      protocols: ['h2'],
      tls: { rejectUnauthorized: false },
    });
    try {
      async function* body() {
        yield new TextEncoder().encode('first');
        await uploadGate;
        yield new TextEncoder().encode('-second');
      }
      const responsePromise = client.request('/upload', { method: 'POST', body: body() });
      await withTimeout(firstChunkSeen, 'H2 upload was buffered until EOF', 250);
      releaseUpload();
      const response = await responsePromise;
      t.equal(await response.text(), 'uploaded');
    } finally {
      releaseUpload();
      await client.close();
      await server.close();
      await _resetFetchH2Pool();
    }
  });
  it(
    'explicit H3 session performs requests and reconnect preserves session identity',
    { skip: skipH3 },
    async (t) => {
      let count = 0;
      const server = await h3Serve(
        {
          port: 0,
          hostname: '127.0.0.1',
          certificateFile: CERT_PATH,
          privateKeyFile: KEY_PATH,
        },
        (request) => new Response(`h3:${new URL(request.url).pathname}:${++count}`),
      );
      const client = new HttpClient({ tls: { rejectUnauthorized: false } });
      try {
        const session = await client.session(`https://127.0.0.1:${server.port}`, {
          protocol: 'h3',
        });
        const first = await session.request({ path: '/one' });
        t.equal(first.protocol, 'h3');
        t.equal(first.session.id, session.id);
        t.equal(await first.text(), 'h3:/one:1');
        await session.reconnect({ reason: 'test' });
        const second = await session.request({ path: '/two' });
        t.equal(second.protocol, 'h3');
        t.equal(second.session.id, session.id);
        t.equal(await second.text(), 'h3:/two:2');
        t.notEqual(
          first.connection?.id,
          second.connection?.id,
          'reconnect replaces transport identity',
        );
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
  it('explicit H3 session reuses one transport until reconnect', { skip: skipH3 }, async (t) => {
    const server = await h3Serve(
      {
        port: 0,
        hostname: '127.0.0.1',
        certificateFile: CERT_PATH,
        privateKeyFile: KEY_PATH,
      },
      (request) => new Response(`h3:${new URL(request.url).pathname}`),
    );
    const client = new HttpClient({ tls: { rejectUnauthorized: false } });
    try {
      const session = await client.session(`https://127.0.0.1:${server.port}`, { protocol: 'h3' });
      const first = await session.request({ path: '/one' });
      const firstConnectionId = first.connection?.id;
      t.equal(await first.text(), 'h3:/one');
      const second = await session.request({ path: '/two' });
      t.equal(await second.text(), 'h3:/two');
      t.equal(
        second.connection?.id,
        firstConnectionId,
        'sequential H3 requests reuse the active transport',
      );
      await session.reconnect({ reason: 'test' });
      const third = await session.request({ path: '/three' });
      t.equal(await third.text(), 'h3:/three');
      t.notEqual(
        third.connection?.id,
        firstConnectionId,
        'reconnect replaces the active transport',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it(
    'cancels H3 response streams without closing their connection',
    { skip: skipH3 },
    async (t) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const server = await h3Serve(
        {
          port: 0,
          hostname: '127.0.0.1',
          certificateFile: CERT_PATH,
          privateKeyFile: KEY_PATH,
        },
        (request) => {
          if (new URL(request.url).pathname === '/slow') {
            return new Response({
              [Symbol.asyncIterator]: async function* () {
                yield new TextEncoder().encode('started');
                await gate;
                yield new TextEncoder().encode('-late');
              },
            });
          }
          return new Response('reused');
        },
      );
      const client = new HttpClient({
        protocols: ['h3'],
        tls: { rejectUnauthorized: false },
        maxBufferedResponseBytes: 1024,
      });
      try {
        const session = await client.session(`https://127.0.0.1:${server.port}`, {
          protocol: 'h3',
        });
        const slow = await withTimeout(
          session.request({ path: '/slow' }),
          'H3 waited for body EOF',
        );
        const connectionId = slow.connection?.id;
        await slow.discard('cancel');
        const reused = await session.request({ path: '/after' });
        t.equal(await reused.text(), 'reused');
        t.equal(reused.connection?.id, connectionId);
        t.equal(reused.connection?.reused, true);
        const controller = new AbortController();
        const aborted = await session.request({ path: '/slow', signal: controller.signal });
        const abortedBody = aborted.text();
        controller.abort(new Error('stop H3 body'));
        await t.rejects(() => abortedBody, /stop H3 body/);
        const afterAbort = await session.request({ path: '/after-abort' });
        t.equal(await afterAbort.text(), 'reused');
        t.equal(afterAbort.connection?.id, connectionId);
      } finally {
        release();
        await client.close();
        await server.close();
      }
    },
  );
  it('resets an unread H3 response that exceeds its buffer bound', { skip: skipH3 }, async (t) => {
    const server = await h3Serve(
      {
        port: 0,
        hostname: '127.0.0.1',
        certificateFile: CERT_PATH,
        privateKeyFile: KEY_PATH,
      },
      (request) =>
        new Response(
          new URL(request.url).pathname === '/large' ? new Uint8Array(64).fill(65) : 'ok',
        ),
    );
    const client = new HttpClient({
      protocols: ['h3'],
      tls: { rejectUnauthorized: false },
      maxBufferedResponseBytes: 4,
    });
    try {
      const session = await client.session(`https://127.0.0.1:${server.port}`, {
        protocol: 'h3',
      });
      const large = await session.request({ path: '/large' });
      const connectionId = large.connection?.id;
      await t.rejects(() => large.bytes(), /buffer exceeded|buffered byte limit/);
      const after = await session.request({ path: '/after' });
      t.equal(await after.text(), 'ok');
      t.equal(after.connection?.id, connectionId);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
describe('HttpClient realtime helpers', () => {
  it('sse() receives events with inherited headers', async (t) => {
    let sawHeader = false;
    const server = serveHttp({ port: 0 }, async (request) => {
      sawHeader = request.headers.get('authorization') === 'Bearer test';
      const chunks: Uint8Array[] = [];
      const sink = new (class extends BytesWriter {
        protected async doWrite(buf: Uint8Array): Promise<void> {
          chunks.push(buf.slice());
        }
      })();
      const writer = new EventSourceWriter(sink);
      await writer.event({
        data: 'hello',
        id: '1',
      });
      return new Response(
        {
          [Symbol.asyncIterator]: async function* () {
            for (const chunk of chunks) yield chunk;
          },
        },
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const client = new HttpClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      headers: { authorization: 'Bearer test' },
    });
    try {
      const events = client.sse('/events');
      const message = await waitForEvent<MessageEvent>(events as unknown as EventTarget, 'message');
      t.equal(message.data, 'hello');
      t.equal(sawHeader, true);
      events.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('websocket() connects to H1 routes and rejects non-H1 sessions clearly', async (t) => {
    const server = serve({ port: 0 }, async (incoming) => {
      if (incoming.kind === 'websocket') {
        const socket = await incoming.accept({ protocol: 'chat.v1' });
        socket.addEventListener(
          'message',
          (event) => void socket.send(`echo:${(event as MessageEvent).data}`),
        );
        return;
      }
      await incoming.reject(new Response('no'));
    });
    const client = new HttpClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    try {
      const socket = await client.websocket('/chat', { protocols: ['chat.v1'] });
      const messagePromise = waitForEvent<MessageEvent>(
        socket as unknown as EventTarget,
        'message',
      );
      await socket.send('hi');
      const message = await messagePromise;
      t.equal(message.data, 'echo:hi');
      await socket.close();
      const h2Session = await client.session(`http://127.0.0.1:${server.port}`, { protocol: 'h2' });
      await t.rejects(
        () => h2Session.websocket('/chat'),
        /WebSocket over h2 requires Extended CONNECT, which is not supported yet/,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('webtransport() validates URLs and is restricted to explicit H3 sessions', async (t) => {
    const client = new HttpClient({ baseUrl: 'https://example.test' });
    try {
      await t.rejects(
        () => client.webtransport('http://example.test/wt'),
        /WebTransport requires https:/,
      );
      const h1Session = await client.session('https://example.test', { protocol: 'http/1.1' });
      await t.rejects(
        () => h1Session.webtransport('/wt'),
        /WebTransport over http\/1\.1 is not supported; use an h3 session/,
      );
      const h3Session = await client.session('https://example.test', { protocol: 'h3' });
      t.equal(h3Session.protocol, 'h3', 'H3 sessions are the supported WebTransport session type');
    } finally {
      await client.close();
    }
  });
});
