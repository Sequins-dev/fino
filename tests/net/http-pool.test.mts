/**
 * H2ConnectionPool tests.
 *
 * Tests pool entry creation, concurrent stream multiplexing, GOAWAY eviction,
 * and HTTPS fetch() integration via ALPN negotiation.
 */

import { describe, it } from 'fino:test/test';
import { serve } from 'fino:net/http/server';
import { Socket } from 'fino:net/socket';
import { TlsSocket } from 'fino:net/tls';
import { Headers, Response } from 'fino:net/http';
import { h2Available, createPoolEntry } from 'fino:net/http/h2';
import { H2ConnectionPool } from 'internal:net/http/pool';
import { _fetchH2PoolHas, _resetFetchH2Pool } from 'internal:globals/fetch';
import * as loop from 'internal:runtime/loop';

const CERT_PATH = new URL('./fixtures/test.crt', import.meta.url).pathname;
const KEY_PATH  = new URL('./fixtures/test.key', import.meta.url).pathname;

const tlsAvailable = (globalThis as typeof globalThis & { tlsAvailable?: boolean }).tlsAvailable;
const skipHttps = (!h2Available || !tlsAvailable) && 'requires libnghttp2 + OpenSSL';

if (!h2Available && (globalThis as any).process?.env?.FINO_REQUIRE_H2 === '1') {
  throw new Error('FINO_REQUIRE_H2=1 but libnghttp2 is not available');
}

const skip = !h2Available && 'requires libnghttp2';

// ---------------------------------------------------------------------------
// Helper: connect a pool entry to a local h2c serve() server
// ---------------------------------------------------------------------------

async function connectPoolEntry(port: number, options?: { idleMs?: number }) {
  const sock = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port });
  const [reader, writer] = sock.split();
  return createPoolEntry(reader as any, writer, options);
}

function makeReq(url: string, method = 'GET', body?: string): Request {
  return new (globalThis as any).Request(url, {
    method,
    body: body !== undefined ? new TextEncoder().encode(body).buffer : undefined,
  });
}

// ---------------------------------------------------------------------------
// Pool entry — basic request/response
// ---------------------------------------------------------------------------

describe('H2PoolEntry — basic request/response', () => {
  it('sends a GET request and receives a 200 response', { skip }, async (t) => {
    const server = serve({ port: 0 }, async (_req) => new Response('hello pool'));
    const port = server.port;

    const entry = await connectPoolEntry(port);
    try {
      const url = `http://127.0.0.1:${port}/`;
      const res = await entry.send(makeReq(url));
      const text = await res.text();
      t.equal(res.status, 200, 'status 200');
      t.equal(text, 'hello pool', 'response body correct');
    } finally {
      entry.close();
      await server.close();
    }
  });

  it('sends a POST request with body and server echoes it', { skip }, async (t) => {
    const server = serve({ port: 0 }, async (req) => {
      const body = await req.text();
      return new Response(`echo:${body}`, { status: 201 });
    });
    const port = server.port;

    const entry = await connectPoolEntry(port);
    try {
      const url = `http://127.0.0.1:${port}/`;
      const res = await entry.send(makeReq(url, 'POST', 'pool-body'));
      const text = await res.text();
      t.equal(res.status, 201, 'status 201');
      t.equal(text, 'echo:pool-body', 'echoed correctly');
    } finally {
      entry.close();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Pool entry — concurrent multiplexing
// ---------------------------------------------------------------------------

describe('H2PoolEntry — concurrent streams', () => {
  it('concurrent requests on one session all complete', { skip }, async (t) => {
    let count = 0;
    const server = serve({ port: 0 }, async (req) => {
      const n = ++count;
      return new Response(`reply-${n}`);
    });
    const port = server.port;

    const entry = await connectPoolEntry(port);
    try {
      const url = `http://127.0.0.1:${port}/`;
      const reqs = Array.from({ length: 5 }, () => entry.send(makeReq(url)));
      const responses = await Promise.all(reqs);
      const texts = await Promise.all(responses.map(r => r.text()));

      t.equal(count, 5, 'server handled 5 requests');
      for (const r of responses) t.equal(r.status, 200, 'status 200');
      for (const text of texts) t.ok(text.startsWith('reply-'), `body: ${text}`);
    } finally {
      entry.close();
      await server.close();
    }
  });

  it('goingAway is false while entry is healthy', { skip }, async (t) => {
    const server = serve({ port: 0 }, async () => new Response('ok'));
    const port = server.port;

    const entry = await connectPoolEntry(port);
    try {
      t.ok(!entry.goingAway, 'initially not going away');
      await entry.send(makeReq(`http://127.0.0.1:${port}/`));
      t.ok(!entry.goingAway, 'still not going away after request');
    } finally {
      entry.close();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Pool entry — close / GOAWAY
// ---------------------------------------------------------------------------

describe('H2PoolEntry — close and GOAWAY', () => {
  it('close() marks entry as goingAway and rejects new sends', { skip }, async (t) => {
    const server = serve({ port: 0 }, async () => new Response('ok'));
    const port = server.port;

    const entry = await connectPoolEntry(port);
    entry.close();

    await new Promise<void>(r => setTimeout(r, 20));
    t.ok(entry.goingAway, 'goingAway after close()');

    let threw = false;
    try {
      await entry.send(makeReq(`http://127.0.0.1:${port}/`));
    } catch {
      threw = true;
    }
    t.ok(threw, 'send() throws after close()');
    await server.close();
  });

  it('idle timeout marks the entry goingAway and rejects new sends', { skip }, async (t) => {
    const server = serve({ port: 0 }, async () => new Response('ok'));
    const port = server.port;

    const entry = await connectPoolEntry(port, { idleMs: 10 });
    try {
      await loop.timeout(30);
      t.ok(entry.goingAway, 'idle timeout marks entry goingAway');
      await t.rejects(
        () => entry.send(makeReq(`http://127.0.0.1:${port}/`)),
        /going away/i,
        'idle entry rejects new sends',
      );
    } finally {
      entry.close();
      await server.close();
    }
  });

  it('peer GOAWAY rejects new streams and lets streams at or below lastStreamId finish', { skip }, async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const server = serve({ port: 0 }, async () => {
      await gate;
      return new Response('finished');
    });
    const port = server.port;

    const entry = await connectPoolEntry(port);
    try {
      const first = entry.send(makeReq(`http://127.0.0.1:${port}/first`));
      await loop.timeout(20);
      entry.handleGoaway(1, 0);
      t.ok(entry.goingAway, 'GOAWAY marks entry goingAway');
      await t.rejects(
        () => entry.send(makeReq(`http://127.0.0.1:${port}/after-goaway`)),
        /going away/i,
        'new streams are rejected after GOAWAY',
      );
      release();
      const res = await first;
      t.equal(await res.text(), 'finished', 'stream at lastStreamId completes');
    } finally {
      release();
      entry.close();
      await server.close();
    }
  });

  it('peer GOAWAY rejects active streams above lastStreamId', { skip }, async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const server = serve({ port: 0 }, async () => {
      await gate;
      return new Response('late');
    });
    const port = server.port;

    const entry = await connectPoolEntry(port);
    try {
      const first = entry.send(makeReq(`http://127.0.0.1:${port}/first`));
      const second = entry.send(makeReq(`http://127.0.0.1:${port}/second`));
      await loop.timeout(20);
      entry.handleGoaway(1, 0);

      await t.rejects(
        () => second,
        /GOAWAY/i,
        'stream above lastStreamId is rejected',
      );
      release();
      const res = await first;
      t.equal(await res.text(), 'late', 'stream at or below lastStreamId completes');
    } finally {
      release();
      entry.close();
      await server.close();
    }
  });

  it('transport close rejects an active stream and marks the entry goingAway', { skip }, async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const server = serve({ port: 0 }, async () => {
      await gate;
      return new Response('never');
    });
    const port = server.port;

    const entry = await connectPoolEntry(port);
    try {
      const pending = entry.send(makeReq(`http://127.0.0.1:${port}/slow`));
      await loop.timeout(20);
      entry.handleTransportError(new Error('synthetic transport closed'));
      await t.rejects(
        () => pending,
        /closed/i,
        'active stream rejects when transport closes',
      );
      t.ok(entry.goingAway, 'transport failure marks entry goingAway');
    } finally {
      release();
      entry.close();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// H2ConnectionPool — eviction
// ---------------------------------------------------------------------------

describe('H2ConnectionPool — eviction', () => {
  it('pool.get() returns undefined for a closed entry', { skip }, async (t) => {
    if (!H2ConnectionPool) {
      t.ok(true, 'H2ConnectionPool not exported (skipped)');
      return;
    }

    const server = serve({ port: 0 }, async () => new Response('ok'));
    const port = server.port;
    const pool = new H2ConnectionPool();

    const origin = `http://127.0.0.1:${port}`;
    const entry = await connectPoolEntry(port);
    pool.add(origin, entry);

    t.ok(pool.get(origin) === entry, 'pool.get() returns entry');

    entry.close();
    pool.evict(origin);
    t.ok(pool.get(origin) === undefined, 'pool.get() returns undefined after evict');

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// ALPN negotiation + HTTPS pool integration
// ---------------------------------------------------------------------------

describe('ALPN server-side negotiation', () => {
  it('TLS server negotiates h2 via ALPN when client offers it', { skip: skipHttps }, async (t) => {
    const server = serve(
      { port: 0, tls: { cert: CERT_PATH, key: KEY_PATH } },
      async (_req) => new Response('ok'),
    );
    const port = server.port;
    try {
      const tlsSock = await TlsSocket.connect(
        { family: 'ipv4', ip: '127.0.0.1', port },
        { hostname: '127.0.0.1', rejectUnauthorized: false, alpn: ['h2', 'http/1.1'] },
      );
      const proto = tlsSock.negotiatedProtocol;
      tlsSock.close();
      t.equal(proto, 'h2', `server negotiated h2 (got: ${proto})`);
    } finally {
      await server.close();
    }
  });

  it('TLS server falls back to http/1.1 when client does not offer h2', { skip: skipHttps }, async (t) => {
    const server = serve(
      { port: 0, tls: { cert: CERT_PATH, key: KEY_PATH } },
      async (_req) => new Response('ok'),
    );
    const port = server.port;
    try {
      const tlsSock = await TlsSocket.connect(
        { family: 'ipv4', ip: '127.0.0.1', port },
        { hostname: '127.0.0.1', rejectUnauthorized: false, alpn: ['http/1.1'] },
      );
      const proto = tlsSock.negotiatedProtocol;
      tlsSock.close();
      t.equal(proto, 'http/1.1', `server negotiated http/1.1 (got: ${proto})`);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Global fetch() HTTPS H2 pool integration
// ---------------------------------------------------------------------------

function httpsOrigin(port: number): string {
  return `https://127.0.0.1:${port}`;
}

describe('global fetch() — HTTPS H2 pool', () => {
  it('creates and reuses an ALPN-negotiated H2 pool entry', { skip: skipHttps }, async (t) => {
    _resetFetchH2Pool();
    let requests = 0;
    const server = serve(
      { port: 0, tls: { cert: CERT_PATH, key: KEY_PATH } },
      async () => new Response(`hit-${++requests}`),
    );
    const origin = httpsOrigin(server.port);

    try {
      const first = await fetch(`${origin}/one`, { tls: { rejectUnauthorized: false } } as any);
      t.equal(await first.text(), 'hit-1', 'first pooled fetch response');
      t.ok(_fetchH2PoolHas(origin), 'pool entry created after ALPN h2 fetch');

      const second = await fetch(`${origin}/two`, { tls: { rejectUnauthorized: false } } as any);
      t.equal(await second.text(), 'hit-2', 'second pooled fetch response');
      t.ok(_fetchH2PoolHas(origin), 'pool entry remains reusable');
      t.equal(requests, 2, 'server handled both requests');
    } finally {
      _resetFetchH2Pool();
      await server.close();
    }
  });

  it('keys pooled entries by origin port', { skip: skipHttps }, async (t) => {
    _resetFetchH2Pool();
    const serverA = serve(
      { port: 0, tls: { cert: CERT_PATH, key: KEY_PATH } },
      async () => new Response('a'),
    );
    const serverB = serve(
      { port: 0, tls: { cert: CERT_PATH, key: KEY_PATH } },
      async () => new Response('b'),
    );
    const originA = httpsOrigin(serverA.port);
    const originB = httpsOrigin(serverB.port);

    try {
      t.equal(await (await fetch(`${originA}/`, { tls: { rejectUnauthorized: false } } as any)).text(), 'a');
      t.ok(_fetchH2PoolHas(originA), 'first origin is pooled');
      t.ok(!_fetchH2PoolHas(originB), 'second origin is not populated by first fetch');

      t.equal(await (await fetch(`${originB}/`, { tls: { rejectUnauthorized: false } } as any)).text(), 'b');
      t.ok(_fetchH2PoolHas(originA), 'first origin remains pooled');
      t.ok(_fetchH2PoolHas(originB), 'second origin gets its own entry');
    } finally {
      _resetFetchH2Pool();
      await serverA.close();
      await serverB.close();
    }
  });

  it('evicts the pooled entry after server close tears down transport', { skip: skipHttps }, async (t) => {
    _resetFetchH2Pool();
    const server = serve(
      { port: 0, tls: { cert: CERT_PATH, key: KEY_PATH } },
      async () => new Response('ok'),
    );
    const origin = httpsOrigin(server.port);

    try {
      t.equal(await (await fetch(`${origin}/`, { tls: { rejectUnauthorized: false } } as any)).text(), 'ok');
      t.ok(_fetchH2PoolHas(origin), 'pool entry exists before close');
      await server.close();
      await loop.timeout(50);
      t.ok(!_fetchH2PoolHas(origin), 'pool entry is evicted after transport close');
    } finally {
      _resetFetchH2Pool();
      try { await server.close(); } catch {}
    }
  });

  it('carries response and request trailers over pooled H2', { skip: skipHttps }, async (t) => {
    _resetFetchH2Pool();
    let capturedRequestTrailer: string | null = null;
    const server = serve(
      { port: 0, tls: { cert: CERT_PATH, key: KEY_PATH } },
      async (req) => {
        const body = await req.text();
        capturedRequestTrailer = (await req.trailers).get('x-upload-checksum');
        return new Response(`echo:${body}`, {
          trailers: new Headers({ 'x-response-trailer': 'pooled' }),
        });
      },
    );
    const origin = httpsOrigin(server.port);

    try {
      const warm = await fetch(`${origin}/warm`, { tls: { rejectUnauthorized: false } } as any);
      await warm.text();
      t.ok(_fetchH2PoolHas(origin), 'warm request created pool entry');

      const res = await fetch(`${origin}/trailers`, {
        method: 'POST',
        body: 'payload',
        trailers: new Headers({ 'x-upload-checksum': 'abc123' }),
        tls: { rejectUnauthorized: false },
      } as any);
      t.equal(await res.text(), 'echo:payload', 'pooled request body echoed');
      t.equal(capturedRequestTrailer, 'abc123', 'server received pooled request trailer');
      t.equal((await res.trailers).get('x-response-trailer'), 'pooled', 'client received pooled response trailer');
    } finally {
      _resetFetchH2Pool();
      await server.close();
    }
  });
});
