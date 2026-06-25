/**
 * Tests for fino:net/http/client.
 */

import { describe, it } from 'fino:test/test';
import { serve, serveHttp } from 'fino:net/http/server';
import { HttpClient } from 'fino:net/http/client';
import { EventSourceWriter } from 'fino:net/http/eventstream';
import { BytesWriter } from 'fino:stream';
import { MessageEvent } from 'fino:net/http/websocket';
import { h2Available } from '../../js/net/http/h2.mts';
import { h3Available, serve as h3Serve } from 'internal:net/http/h3';
import { quicAvailable } from 'fino:net/quic';
import { _fetchH2PoolHas, _resetFetchH2Pool } from 'internal:globals/fetch';
import type { Event, EventTarget } from 'internal:globals/eventtarget';
import * as loop from 'internal:runtime/loop';

const CERT_PATH = new URL('./fixtures/test.crt', import.meta.url).pathname;
const KEY_PATH  = new URL('./fixtures/test.key', import.meta.url).pathname;
const tlsAvailable = (globalThis as typeof globalThis & { tlsAvailable?: boolean }).tlsAvailable;
const skipH2 = (!h2Available || !tlsAvailable) && 'requires libnghttp2 + OpenSSL';
const skipH3 = (!quicAvailable || !h3Available) && 'requires QUIC + libnghttp3';

function waitForEvent<T extends Event>(target: EventTarget, name: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = loop.timeout(timeoutMs);
    timer.then(() => reject(new Error('waitForEvent timed out waiting for: ' + name))).catch(() => {});
    target.addEventListener(name, function handler(event) {
      timer.cancel();
      target.removeEventListener(name, handler);
      resolve(event as T);
    }, { once: true });
  });
}

describe('HttpClient over HTTP/1.1', () => {
  it('request() returns rich response metadata and body helpers', async (t) => {
    const server = serveHttp({ port: 0 }, async (request) => {
      const body = JSON.stringify({
        method: request.method,
        path: new URL(request.url).pathname,
      });
      return new Response({
        [Symbol.asyncIterator]: async function* () {
          yield new TextEncoder().encode(body);
        },
      }, {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-test': 'client' },
        trailers: new Headers({ 'x-trailer': 'done' }),
      });
    });
    const client = new HttpClient({ baseUrl: `http://127.0.0.1:${server.port}` });

    try {
      const res = await client.request('/users', { method: 'POST', body: 'hello' });
      t.equal(res.status, 201);
      t.equal(res.headers.get('x-test'), 'client');
      t.equal(res.protocol, 'http/1.1');
      t.equal(res.session.protocol, 'http/1.1');
      t.equal(res.request.method, 'POST');
      t.equal(res.request.url, `http://127.0.0.1:${server.port}/users`);
      t.ok(res.connection, 'connection info is present');
      t.notEqual(res.session.id, res.connection?.id, 'session identity differs from connection identity');

      const json = await res.json() as { method: string; path: string };
      t.deepEqual(json, { method: 'POST', path: '/users' });
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
      const second = await session.request({ path: '/two' });
      t.equal(first.session.id, session.id);
      t.equal(second.session.id, session.id);
      t.notEqual(first.connection?.id, second.connection?.id, 'H1 opens per-request connections for now');
      await first.close();
      await second.close();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('HttpClient protocol sessions', () => {
  it('HTTPS requests reuse the H2 pool and expose h2 protocol metadata', { skip: skipH2 }, async (t) => {
    _resetFetchH2Pool();
    let count = 0;
    const server = serveHttp(
      { port: 0, tls: { cert: CERT_PATH, key: KEY_PATH }, idleTimeoutMs: 25, headersTimeoutMs: 25 },
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
      t.equal(first.protocol, 'h2');
      t.equal(first.session.protocol, 'h2');
      t.equal(await first.text(), 'h2:1');
      t.ok(_fetchH2PoolHas(origin), 'pool entry created');

      const second = await client.request('/two');
      t.equal(second.protocol, 'h2');
      t.equal(await second.text(), 'h2:2');
      t.ok(_fetchH2PoolHas(origin), 'pool entry reused');
    } finally {
      await client.close();
      await server.close();
      _resetFetchH2Pool();
    }
  });

  it('explicit H3 session performs requests and reconnect preserves session identity', { skip: skipH3 }, async (t) => {
    let count = 0;
    const server = await h3Serve({
      port: 0,
      hostname: '127.0.0.1',
      certificateFile: CERT_PATH,
      privateKeyFile: KEY_PATH,
    }, (request) => new Response(`h3:${new URL(request.url).pathname}:${++count}`));
    const client = new HttpClient({ tls: { rejectUnauthorized: false } });

    try {
      const session = await client.session(`https://127.0.0.1:${server.port}`, { protocol: 'h3' });
      const first = await session.request({ path: '/one' });
      t.equal(first.protocol, 'h3');
      t.equal(first.session.id, session.id);
      t.equal(await first.text(), 'h3:/one:1');

      await session.reconnect({ reason: 'test' });
      const second = await session.request({ path: '/two' });
      t.equal(second.protocol, 'h3');
      t.equal(second.session.id, session.id);
      t.equal(await second.text(), 'h3:/two:2');
      t.notEqual(first.connection?.id, second.connection?.id, 'reconnect replaces transport identity');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('explicit H3 session reuses one transport until reconnect', { skip: skipH3 }, async (t) => {
    const server = await h3Serve({
      port: 0,
      hostname: '127.0.0.1',
      certificateFile: CERT_PATH,
      privateKeyFile: KEY_PATH,
    }, (request) => new Response(`h3:${new URL(request.url).pathname}`));
    const client = new HttpClient({ tls: { rejectUnauthorized: false } });

    try {
      const session = await client.session(`https://127.0.0.1:${server.port}`, { protocol: 'h3' });
      const first = await session.request({ path: '/one' });
      const firstConnectionId = first.connection?.id;
      t.equal(await first.text(), 'h3:/one');

      const second = await session.request({ path: '/two' });
      t.equal(await second.text(), 'h3:/two');
      t.equal(second.connection?.id, firstConnectionId, 'sequential H3 requests reuse the active transport');

      await session.reconnect({ reason: 'test' });
      const third = await session.request({ path: '/three' });
      t.equal(await third.text(), 'h3:/three');
      t.notEqual(third.connection?.id, firstConnectionId, 'reconnect replaces the active transport');
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
      const sink = new class extends BytesWriter {
        protected async doWrite(buf: Uint8Array): Promise<void> { chunks.push(buf.slice()); }
      }();
      const writer = new EventSourceWriter(sink);
      await writer.event({ data: 'hello', id: '1' });
      return new Response({
        [Symbol.asyncIterator]: async function* () {
          for (const chunk of chunks) yield chunk;
        },
      }, { headers: { 'content-type': 'text/event-stream' } });
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
        socket.addEventListener('message', (event) => void socket.send(`echo:${(event as MessageEvent).data}`));
        return;
      }
      await incoming.reject(new Response('no'));
    });
    const client = new HttpClient({ baseUrl: `http://127.0.0.1:${server.port}` });

    try {
      const socket = await client.websocket('/chat', { protocols: ['chat.v1'] });
      const messagePromise = waitForEvent<MessageEvent>(socket as unknown as EventTarget, 'message');
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
