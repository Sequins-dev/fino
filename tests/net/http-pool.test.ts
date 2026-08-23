/**
 * H2ConnectionPool tests.
 *
 * Tests pool entry creation, concurrent stream multiplexing, GOAWAY eviction,
 * and HTTPS fetch() integration via ALPN negotiation.
 */
import { describe, it } from 'fino:test/test';
import { serve, serveHttp } from 'fino:net/http/server';
import { Socket } from 'fino:net/socket';
import { TlsSocket } from 'fino:net/tls';
import { h2Available } from '../../js/net/http/h2.ts';
import { createPoolEntry } from '../../js/internal/net/http/pool.ts';
import { h3Available, serve as h3Serve } from '../../js/net/http/h3.ts';
import { quicAvailable } from 'fino:net/quic';
import { H2ConnectionPool } from '../../js/internal/net/http/pool.ts';
import {
  _fetchAltSvcHas,
  _fetchH2PoolHas,
  _fetchH3PoolHas,
  _closeFetchH2PoolEntryForTest,
  _resetFetchAltSvc,
  _resetFetchH2Pool,
  _resetFetchH3Pool,
  _setFetchH3HandshakeTimeoutForTest,
} from 'internal:globals/fetch';
import * as loop from 'internal:runtime/loop';
const CERT_PATH = new URL('./fixtures/test.crt', import.meta.url).pathname;
const KEY_PATH = new URL('./fixtures/test.key', import.meta.url).pathname;
const tlsAvailable = (
  globalThis as typeof globalThis & {
    tlsAvailable?: boolean;
  }
).tlsAvailable;
const skipHttps = (!h2Available || !tlsAvailable) && 'requires libnghttp2 + OpenSSL';
const skipGlobalH3 =
  (!quicAvailable || !h3Available || !tlsAvailable) && 'requires QUIC + libnghttp3 + OpenSSL';
if (!h2Available && (globalThis as any).process?.env?.FINO_REQUIRE_H2 === '1') {
  throw new Error('FINO_REQUIRE_H2=1 but libnghttp2 is not available');
}
if (
  (!quicAvailable || !h3Available || !tlsAvailable) &&
  (globalThis as any).process?.env?.FINO_REQUIRE_H3 === '1'
) {
  throw new Error('FINO_REQUIRE_H3=1 but QUIC + libnghttp3 + OpenSSL are not available');
}
const skip = !h2Available && 'requires libnghttp2';
// ---------------------------------------------------------------------------
// Helper: connect a pool entry to a local h2c serveHttp() server
// ---------------------------------------------------------------------------
async function connectPoolEntry(
  port: number,
  options?: {
    idleMs?: number;
    maxBufferedBodyBytes?: number;
  },
) {
  const sock = await Socket.connect({
    family: 'ipv4',
    ip: '127.0.0.1',
    port,
  });
  const [reader, writer] = sock.split();
  return createPoolEntry(reader as any, writer, options);
}
function makeReq(url: string, method = 'GET', body?: string): Request {
  return new (globalThis as any).Request(url, {
    method,
    body: body !== undefined ? new TextEncoder().encode(body).buffer : undefined,
  });
}
async function fetchWithTimeout(
  input: string,
  init: Record<string, unknown>,
  ms = 5e3,
): Promise<Response> {
  const controller = new AbortController();
  const timer = loop.timeout(ms);
  timer.then(
    function abortTimedOutFetch() {
      controller.abort(new Error('fetch timed out'));
    },
    () => {},
  );
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    } as any);
  } finally {
    timer.cancel();
  }
}
function timeout<T>(promise: Promise<T>, message: string, ms = 1e3): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guard = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
// ---------------------------------------------------------------------------
// Pool entry — basic request/response
// ---------------------------------------------------------------------------
describe('H2PoolEntry — basic request/response', () => {
  it('sends a GET request and receives a 200 response', { skip }, async (t) => {
    const server = serveHttp({ port: 0 }, async (_req) => new Response('hello pool'));
    const port = server.port;
    const entry = await connectPoolEntry(port);
    try {
      const url = `http://127.0.0.1:${port}/`;
      const res = await entry.send(makeReq(url));
      const text = await res.text();
      t.equal(res.status, 200, 'status 200');
      t.equal(text, 'hello pool', 'response body correct');
    } finally {
      await entry.close();
      await server.close();
    }
  });
  it('sends a POST request with body and server echoes it', { skip }, async (t) => {
    const server = serveHttp({ port: 0 }, async (req) => {
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
      await entry.close();
      await server.close();
    }
  });
  it('resolves after final headers and streams body chunks before EOF', { skip }, async (t) => {
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const server = serveHttp({ port: 0 }, async () => {
      async function* body() {
        yield new TextEncoder().encode('first');
        await bodyGate;
        yield new TextEncoder().encode('-second');
      }
      return new Response(body(), { headers: { 'content-type': 'text/plain' } });
    });
    const entry = await connectPoolEntry(server.port);
    let reader: ReadableStreamDefaultReader | null = null;
    try {
      const response = await timeout(
        entry.send(makeReq(`http://127.0.0.1:${server.port}/stream`)),
        'pooled H2 response did not resolve at headers',
        250,
      );
      t.equal(response.status, 200, 'status is available before body EOF');
      t.equal(response.version, 'HTTP/2', 'wire response reports the negotiated protocol');
      reader = response.body!.getReader();
      const first = await timeout(
        reader.read(),
        'first body chunk was not readable before EOF',
        250,
      );
      t.equal(
        new TextDecoder().decode(first.value),
        'first',
        'first chunk is delivered immediately',
      );
      releaseBody();
      const second = await reader.read();
      const end = await reader.read();
      t.equal(new TextDecoder().decode(second.value), '-second', 'second chunk is delivered');
      t.equal(end.done, true, 'body closes at END_STREAM');
    } finally {
      releaseBody();
      try {
        await reader?.cancel();
      } catch {}
      await entry.close();
      await server.close();
    }
  });
  it('cancels one response stream without closing the pooled connection', { skip }, async (t) => {
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const server = serveHttp({ port: 0 }, async (req) => {
      if (new URL(req.url).pathname === '/cancel') {
        async function* body() {
          yield new TextEncoder().encode('started');
          await bodyGate;
          yield new TextEncoder().encode('late');
        }
        return new Response(body());
      }
      return new Response('reused');
    });
    const entry = await connectPoolEntry(server.port);
    try {
      const response = await timeout(
        entry.send(makeReq(`http://127.0.0.1:${server.port}/cancel`)),
        'response did not resolve before cancellation',
        250,
      );
      await response.body!.cancel('not needed');
      t.equal(entry.activeStreams, 0, 'cancelled stream is released');
      const reused = await entry.send(makeReq(`http://127.0.0.1:${server.port}/after`));
      t.equal(await reused.text(), 'reused', 'another request reuses the connection');
      t.ok(!entry.goingAway, 'stream cancellation leaves the connection healthy');
    } finally {
      releaseBody();
      await entry.close();
      await server.close();
    }
  });
  it('faults an unread body that exceeds the configured stream buffer', { skip }, async (t) => {
    const server = serveHttp({ port: 0 }, async () => new Response('body-larger-than-limit'));
    const entry = await connectPoolEntry(server.port, { maxBufferedBodyBytes: 4 });
    try {
      const response = await entry.send(makeReq(`http://127.0.0.1:${server.port}/overflow`));
      await t.rejects(
        () => response.text(),
        /buffer|flow-control/i,
        'body reader observes bounded-queue overflow',
      );
      await loop.timeout(0);
      t.equal(entry.activeStreams, 0, 'overflowed stream is reset and released');
    } finally {
      await entry.close();
      await server.close();
    }
  });
  it('recognizes response trailers after a zero-byte body', { skip }, async (t) => {
    const server = serveHttp(
      { port: 0 },
      async () => new Response(null, { trailers: new Headers({ 'x-empty-trailer': 'done' }) }),
    );
    const entry = await connectPoolEntry(server.port);
    try {
      const response = await entry.send(makeReq(`http://127.0.0.1:${server.port}/trailers`));
      t.equal(await response.text(), '', 'zero-byte response body reaches EOF');
      t.equal(
        (await response.trailers).get('x-empty-trailer'),
        'done',
        'trailer block is not mistaken for another response header block',
      );
    } finally {
      await entry.close();
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
    const server = serveHttp({ port: 0 }, async (req) => {
      const n = ++count;
      return new Response(`reply-${n}`);
    });
    const port = server.port;
    const entry = await connectPoolEntry(port);
    try {
      const url = `http://127.0.0.1:${port}/`;
      const reqs = Array.from({ length: 5 }, () => entry.send(makeReq(url)));
      const responses = await Promise.all(reqs);
      const texts = await Promise.all(responses.map((r) => r.text()));
      t.equal(count, 5, 'server handled 5 requests');
      for (const r of responses) t.equal(r.status, 200, 'status 200');
      for (const text of texts) t.ok(text.startsWith('reply-'), `body: ${text}`);
    } finally {
      await entry.close();
      await server.close();
    }
  });
  it('goingAway is false while entry is healthy', { skip }, async (t) => {
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const port = server.port;
    const entry = await connectPoolEntry(port);
    try {
      t.ok(!entry.goingAway, 'initially not going away');
      await entry.send(makeReq(`http://127.0.0.1:${port}/`));
      t.ok(!entry.goingAway, 'still not going away after request');
    } finally {
      await entry.close();
      await server.close();
    }
  });
});
// ---------------------------------------------------------------------------
// Pool entry — close / GOAWAY
// ---------------------------------------------------------------------------
describe('H2PoolEntry — close and GOAWAY', () => {
  it('close() marks entry as goingAway and rejects new sends', { skip }, async (t) => {
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const port = server.port;
    const entry = await connectPoolEntry(port);
    await entry.close();
    await new Promise<void>((r) => setTimeout(r, 20));
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
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
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
      await entry.close();
      await server.close();
    }
  });
  it(
    'peer GOAWAY rejects new streams and lets streams at or below lastStreamId finish',
    { skip },
    async (t) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const server = serveHttp({ port: 0 }, async () => {
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
        await entry.close();
        await server.close();
      }
    },
  );
  it('peer GOAWAY rejects active streams above lastStreamId', { skip }, async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = serveHttp({ port: 0 }, async () => {
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
      await t.rejects(() => second, /GOAWAY/i, 'stream above lastStreamId is rejected');
      release();
      const res = await first;
      t.equal(await res.text(), 'late', 'stream at or below lastStreamId completes');
    } finally {
      release();
      await entry.close();
      await server.close();
    }
  });
  it(
    'transport close rejects an active stream and marks the entry goingAway',
    { skip },
    async (t) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const server = serveHttp({ port: 0 }, async () => {
        await gate;
        return new Response('never');
      });
      const port = server.port;
      const entry = await connectPoolEntry(port);
      try {
        const pending = entry.send(makeReq(`http://127.0.0.1:${port}/slow`));
        await loop.timeout(20);
        entry.handleTransportError(new Error('synthetic transport closed'));
        await t.rejects(() => pending, /closed/i, 'active stream rejects when transport closes');
        t.ok(entry.goingAway, 'transport failure marks entry goingAway');
      } finally {
        release();
        await entry.close();
        await server.close();
      }
    },
  );
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
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const port = server.port;
    const pool = new H2ConnectionPool();
    const origin = `http://127.0.0.1:${port}`;
    const entry = await connectPoolEntry(port);
    pool.add(origin, entry);
    t.ok(pool.get(origin) === entry, 'pool.get() returns entry');
    await entry.close();
    await pool.evict(origin);
    t.ok(pool.get(origin) === undefined, 'pool.get() returns undefined after evict');
    await server.close();
  });
});
// ---------------------------------------------------------------------------
// ALPN negotiation + HTTPS pool integration
// ---------------------------------------------------------------------------
describe('ALPN server-side negotiation', () => {
  it('TLS server negotiates h2 via ALPN when client offers it', { skip: skipHttps }, async (t) => {
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
      async (_req) => new Response('ok'),
    );
    const port = server.port;
    try {
      const tlsSock = await TlsSocket.connect(
        {
          family: 'ipv4',
          ip: '127.0.0.1',
          port,
        },
        {
          hostname: '127.0.0.1',
          rejectUnauthorized: false,
          alpn: ['h2', 'http/1.1'],
        },
      );
      const proto = tlsSock.negotiatedProtocol;
      tlsSock.close();
      t.equal(proto, 'h2', `server negotiated h2 (got: ${proto})`);
    } finally {
      await server.close();
    }
  });
  it(
    'TLS server falls back to http/1.1 when client does not offer h2',
    { skip: skipHttps },
    async (t) => {
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
        async (_req) => new Response('ok'),
      );
      const port = server.port;
      try {
        const tlsSock = await TlsSocket.connect(
          {
            family: 'ipv4',
            ip: '127.0.0.1',
            port,
          },
          {
            hostname: '127.0.0.1',
            rejectUnauthorized: false,
            alpn: ['http/1.1'],
          },
        );
        const proto = tlsSock.negotiatedProtocol;
        tlsSock.close();
        t.equal(proto, 'http/1.1', `server negotiated http/1.1 (got: ${proto})`);
      } finally {
        await server.close();
      }
    },
  );
});
// ---------------------------------------------------------------------------
// Global fetch() HTTPS H2 pool integration
// ---------------------------------------------------------------------------
function httpsOrigin(port: number): string {
  return `https://127.0.0.1:${port}`;
}
describe('global fetch() — HTTPS H2 pool', () => {
  it('creates and reuses an ALPN-negotiated H2 pool entry', { skip: skipHttps }, async (t) => {
    await _resetFetchH2Pool();
    let requests = 0;
    const server = serveHttp(
      {
        port: 0,
        tls: {
          cert: CERT_PATH,
          key: KEY_PATH,
        },
      },
      async () => new Response(`hit-${++requests}`),
    );
    const origin = `https://localhost:${server.port}`;
    try {
      const first = await fetch(`${origin}/one`, { tls: { rejectUnauthorized: false } } as any);
      t.equal(await first.text(), 'hit-1', 'first pooled fetch response');
      t.ok(_fetchH2PoolHas(origin), 'pool entry created after ALPN h2 fetch');
      const second = await fetch(`${origin}/two`, { tls: { rejectUnauthorized: false } } as any);
      t.equal(await second.text(), 'hit-2', 'second pooled fetch response');
      t.ok(_fetchH2PoolHas(origin), 'pool entry remains reusable');
      t.equal(requests, 2, 'server handled both requests');
    } finally {
      await _resetFetchH2Pool();
      await server.close();
    }
  });
  it(
    'handles concurrent requests on one ALPN-negotiated H2 session',
    { skip: skipHttps },
    async (t) => {
      await _resetFetchH2Pool();
      const seen = new Set<string>();
      const server = serveHttp(
        {
          port: 0,
          tls: {
            cert: CERT_PATH,
            key: KEY_PATH,
          },
        },
        async (req) => {
          const url = new URL(req.url);
          const id = url.searchParams.get('id') ?? '';
          seen.add(id);
          return Response.json({ id, path: url.pathname });
        },
      );
      const origin = httpsOrigin(server.port);
      try {
        const warm = await fetch(`${origin}/warm`, {
          tls: { rejectUnauthorized: false },
          protocol: 'h2',
        } as any);
        t.equal(
          await warm.text(),
          JSON.stringify({ id: '', path: '/warm' }),
          'warm-up response completes',
        );
        t.ok(_fetchH2PoolHas(origin), 'warm-up request created a pooled H2 entry');

        const count = 32;
        const responses = await Promise.all(
          Array.from({ length: count }, (_, i) => {
            return fetchWithTimeout(`${origin}/batch?id=${i}`, {
              tls: { rejectUnauthorized: false },
              protocol: 'h2',
            });
          }),
        );
        const bodies = await Promise.all(responses.map((response) => response.json()));
        for (const response of responses) {
          t.equal(response.status, 200, 'concurrent response status is 200');
        }
        const ids = bodies.map((body) => body.id).sort((a, b) => Number(a) - Number(b));
        t.deepEqual(
          ids,
          Array.from({ length: count }, (_, i) => String(i)),
          'all concurrent responses complete with the expected ids',
        );
        t.equal(seen.size, count + 1, 'server handled warm-up plus every concurrent request');
        t.ok(_fetchH2PoolHas(origin), 'pooled H2 entry remains reusable after concurrent requests');
      } finally {
        await _resetFetchH2Pool();
        await server.close();
      }
    },
  );
  it('keys pooled entries by origin port', { skip: skipHttps }, async (t) => {
    await _resetFetchH2Pool();
    const serverA = serveHttp(
      {
        port: 0,
        tls: {
          cert: CERT_PATH,
          key: KEY_PATH,
        },
      },
      async () => new Response('a'),
    );
    const serverB = serveHttp(
      {
        port: 0,
        tls: {
          cert: CERT_PATH,
          key: KEY_PATH,
        },
      },
      async () => new Response('b'),
    );
    const originA = httpsOrigin(serverA.port);
    const originB = httpsOrigin(serverB.port);
    try {
      t.equal(
        await (await fetch(`${originA}/`, { tls: { rejectUnauthorized: false } } as any)).text(),
        'a',
      );
      t.ok(_fetchH2PoolHas(originA), 'first origin is pooled');
      t.ok(!_fetchH2PoolHas(originB), 'second origin is not populated by first fetch');
      t.equal(
        await (await fetch(`${originB}/`, { tls: { rejectUnauthorized: false } } as any)).text(),
        'b',
      );
      t.ok(_fetchH2PoolHas(originA), 'first origin remains pooled');
      t.ok(_fetchH2PoolHas(originB), 'second origin gets its own entry');
    } finally {
      await _resetFetchH2Pool();
      await serverA.close();
      await serverB.close();
    }
  });
  it(
    'does not reuse client-certificate-authenticated H2 sessions without the same TLS identity',
    { skip: skipHttps },
    async (t) => {
      await _resetFetchH2Pool();
      const server = serveHttp(
        {
          port: 0,
          tls: {
            cert: CERT_PATH,
            key: KEY_PATH,
            ca: CERT_PATH,
            clientAuth: 'require',
          },
        },
        async (_req, session) =>
          new Response(session.tls?.authorized ? 'authorized' : 'anonymous', {
            status: session.tls?.authorized ? 200 : 401,
          }),
      );
      const origin = httpsOrigin(server.port);
      try {
        const first = await fetch(`${origin}/with-cert`, {
          protocol: 'h2',
          tls: { rejectUnauthorized: false, cert: CERT_PATH, key: KEY_PATH },
        } as any);
        t.equal(first.status, 200, 'cert-authenticated H2 request succeeds');
        t.equal(await first.text(), 'authorized', 'server sees client certificate');

        let secondStatus = 0;
        let secondRejected = false;
        try {
          const second = await fetch(`${origin}/without-cert`, {
            protocol: 'h2',
            tls: { rejectUnauthorized: false },
          } as any);
          secondStatus = second.status;
        } catch (_) {
          secondRejected = true;
        }
        t.ok(
          secondRejected || secondStatus !== 200,
          'request without client certificate does not reuse the authenticated H2 session',
        );
      } finally {
        await _resetFetchH2Pool();
        await server.close();
      }
    },
  );
  it(
    'evicts the pooled entry after server close tears down transport',
    { skip: skipHttps },
    async (t) => {
      await _resetFetchH2Pool();
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
        async () => new Response('ok'),
      );
      const origin = httpsOrigin(server.port);
      try {
        t.equal(
          await (await fetch(`${origin}/`, { tls: { rejectUnauthorized: false } } as any)).text(),
          'ok',
        );
        t.ok(_fetchH2PoolHas(origin), 'pool entry exists before close');
        t.ok(await _closeFetchH2PoolEntryForTest(origin), 'pool entry close is initiated');
        await server.close();
        t.ok(!_fetchH2PoolHas(origin), 'pool entry is evicted after transport close');
      } finally {
        await _resetFetchH2Pool();
        try {
          await server.close();
        } catch {}
      }
    },
  );
  it('carries response and request trailers over pooled H2', { skip: skipHttps }, async (t) => {
    await _resetFetchH2Pool();
    let capturedRequestTrailer: string | null = null;
    const server = serveHttp(
      {
        port: 0,
        tls: {
          cert: CERT_PATH,
          key: KEY_PATH,
        },
      },
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
      t.equal(
        (await res.trailers).get('x-response-trailer'),
        'pooled',
        'client received pooled response trailer',
      );
    } finally {
      await _resetFetchH2Pool();
      await server.close();
    }
  });
});
describe('global fetch() — HTTPS H3 Alt-Svc pool', () => {
  it(
    'discovers Alt-Svc and reuses one H3 session for later requests',
    { skip: skipGlobalH3 },
    async (t) => {
      await _resetFetchH2Pool();
      await _resetFetchH3Pool();
      await _resetFetchAltSvc();
      _setFetchH3HandshakeTimeoutForTest(50);
      let tlsRequests = 0;
      let h3Requests = 0;
      const server = serve(
        {
          port: 0,
          hostname: '127.0.0.1',
          tls: {
            cert: CERT_PATH,
            key: KEY_PATH,
            protocols: ['http/1.1'],
          },
          h3: true,
          idleTimeoutMs: 25,
          headersTimeoutMs: 25,
        },
        async (incoming) => {
          const accepted = await incoming.accept();
          const url = new URL(accepted.request.url);
          if (incoming.protocol === 'h3') {
            h3Requests++;
            await accepted.respond(new Response(`h3:${url.host}:${url.pathname}:${h3Requests}`));
            return;
          }
          await accepted.respond(
            new Response(`tls:${++tlsRequests}`, {
              headers: { 'alt-svc': `h3=":${server.port}"; ma=60` },
            }),
          );
        },
      );
      await server.ready;
      const origin = httpsOrigin(server.port);
      try {
        t.equal(
          await (
            await fetch(`${origin}/one`, { tls: { rejectUnauthorized: false } } as any)
          ).text(),
          'tls:1',
          'first request uses the advertised HTTPS transport',
        );
        t.ok(_fetchAltSvcHas(origin), 'Alt-Svc entry is cached');
        t.ok(!_fetchH3PoolHas(origin), 'H3 session is not opened until a later request');
        const second = await fetch(`${origin}/two`, { tls: { rejectUnauthorized: false } } as any);
        t.equal(
          await second.text(),
          `h3:127.0.0.1:${server.port}:/two:1`,
          'second request uses H3 and preserves original authority',
        );
        t.ok(_fetchH3PoolHas(origin), 'H3 pool entry is created for the origin');
        const third = await fetch(`${origin}/three`, { tls: { rejectUnauthorized: false } } as any);
        t.equal(
          await third.text(),
          `h3:127.0.0.1:${server.port}:/three:2`,
          'third request reuses pooled H3 session',
        );
        t.equal(tlsRequests, 1, 'only discovery request used HTTPS H1/H2 path');
        t.equal(h3Requests, 2, 'later requests reached H3 server');
      } finally {
        _setFetchH3HandshakeTimeoutForTest(null);
        await _resetFetchH3Pool();
        await _resetFetchAltSvc();
        await _resetFetchH2Pool();
        await server.close();
      }
    },
  );
  it(
    'multiplexes concurrent requests over one discovered H3 session',
    { skip: skipGlobalH3 },
    async (t) => {
      await _resetFetchH2Pool();
      await _resetFetchH3Pool();
      await _resetFetchAltSvc();
      let h3Requests = 0;
      const server = serve(
        {
          port: 0,
          hostname: '127.0.0.1',
          tls: {
            cert: CERT_PATH,
            key: KEY_PATH,
            protocols: ['http/1.1'],
          },
          h3: true,
          idleTimeoutMs: 25,
          headersTimeoutMs: 25,
        },
        async (incoming) => {
          const accepted = await incoming.accept();
          const url = new URL(accepted.request.url);
          if (incoming.protocol === 'h3') {
            h3Requests++;
            if (url.pathname === '/slow') await loop.timeout(20);
            await accepted.respond(new Response(`h3:${url.pathname}`));
            return;
          }
          await accepted.respond(
            new Response('warm', { headers: { 'alt-svc': `h3=":${server.port}"; ma=60` } }),
          );
        },
      );
      await server.ready;
      const origin = httpsOrigin(server.port);
      try {
        await (await fetch(`${origin}/warm`, { tls: { rejectUnauthorized: false } } as any)).text();
        const [a, b] = await Promise.all([
          fetch(`${origin}/slow`, { tls: { rejectUnauthorized: false } } as any),
          fetch(`${origin}/fast`, { tls: { rejectUnauthorized: false } } as any),
        ]);
        t.deepEqual([await a.text(), await b.text()].sort(), ['h3:/fast', 'h3:/slow']);
        t.equal(h3Requests, 2, 'both concurrent requests reached H3');
        t.ok(_fetchH3PoolHas(origin), 'one H3 pool entry remains');
      } finally {
        await _resetFetchH3Pool();
        await _resetFetchAltSvc();
        await _resetFetchH2Pool();
        await server.close();
      }
    },
  );
  it(
    'falls back and evicts broken automatic H3 alternatives',
    { skip: skipGlobalH3 },
    async (t) => {
      await _resetFetchH2Pool();
      await _resetFetchH3Pool();
      await _resetFetchAltSvc();
      _setFetchH3HandshakeTimeoutForTest(50);
      let tlsRequests = 0;
      const tls = serveHttp(
        {
          port: 0,
          tls: {
            cert: CERT_PATH,
            key: KEY_PATH,
            protocols: ['http/1.1'],
          },
          idleTimeoutMs: 25,
          headersTimeoutMs: 25,
        },
        async () =>
          new Response(`tls:${++tlsRequests}`, { headers: { 'alt-svc': 'h3=":9"; ma=60' } }),
      );
      const origin = httpsOrigin(tls.port);
      try {
        t.equal(
          await (
            await fetch(`${origin}/warm`, { tls: { rejectUnauthorized: false } } as any)
          ).text(),
          'tls:1',
        );
        t.ok(_fetchAltSvcHas(origin), 'broken Alt-Svc is cached before use');
        t.equal(
          await (
            await fetch(`${origin}/fallback`, { tls: { rejectUnauthorized: false } } as any)
          ).text(),
          'tls:2',
        );
        t.ok(_fetchAltSvcHas(origin), 'fallback response can advertise a fresh alternative');
        t.ok(!_fetchH3PoolHas(origin), 'broken H3 pool entry is not retained');
      } finally {
        _setFetchH3HandshakeTimeoutForTest(null);
        await _resetFetchH3Pool();
        await _resetFetchAltSvc();
        await _resetFetchH2Pool();
        await tls.close();
      }
    },
  );
  it('honors Alt-Svc clear and ma=0 eviction', { skip: skipGlobalH3 }, async (t) => {
    await _resetFetchH2Pool();
    await _resetFetchH3Pool();
    await _resetFetchAltSvc();
    const h3 = await h3Serve(
      {
        port: 0,
        hostname: '127.0.0.1',
        certificateFile: CERT_PATH,
        privateKeyFile: KEY_PATH,
      },
      () => new Response('h3'),
    );
    let header = `h3=":${h3.port}"; ma=60`;
    const tls = serveHttp(
      {
        port: 0,
        tls: {
          cert: CERT_PATH,
          key: KEY_PATH,
          protocols: ['http/1.1'],
        },
        idleTimeoutMs: 25,
        headersTimeoutMs: 25,
      },
      async () => new Response('tls', { headers: { 'alt-svc': header } }),
    );
    const origin = httpsOrigin(tls.port);
    try {
      await (
        await fetch(`${origin}/cache`, {
          protocol: 'http/1.1',
          tls: { rejectUnauthorized: false },
        } as any)
      ).text();
      t.ok(_fetchAltSvcHas(origin), 'Alt-Svc is cached');
      header = 'clear';
      await (
        await fetch(`${origin}/clear`, {
          protocol: 'http/1.1',
          tls: { rejectUnauthorized: false },
        } as any)
      ).text();
      t.ok(!_fetchAltSvcHas(origin), 'clear evicts cached Alt-Svc');
      header = `h3=":${h3.port}"; ma=60`;
      await (
        await fetch(`${origin}/cache-again`, {
          protocol: 'http/1.1',
          tls: { rejectUnauthorized: false },
        } as any)
      ).text();
      t.ok(_fetchAltSvcHas(origin), 'Alt-Svc is cached again');
      header = `h3=":${h3.port}"; ma=0`;
      await (
        await fetch(`${origin}/ma-zero`, {
          protocol: 'http/1.1',
          tls: { rejectUnauthorized: false },
        } as any)
      ).text();
      t.ok(!_fetchAltSvcHas(origin), 'ma=0 evicts cached Alt-Svc');
    } finally {
      await _resetFetchH3Pool();
      await _resetFetchAltSvc();
      await _resetFetchH2Pool();
      await tls.close();
      await h3.close();
    }
  });
  it(
    'protocol override controls automatic H3 and explicit H3 fallback',
    { skip: skipGlobalH3 },
    async (t) => {
      await _resetFetchH2Pool();
      await _resetFetchH3Pool();
      await _resetFetchAltSvc();
      _setFetchH3HandshakeTimeoutForTest(50);
      let tlsRequests = 0;
      const server = serve(
        {
          port: 0,
          hostname: '127.0.0.1',
          tls: {
            cert: CERT_PATH,
            key: KEY_PATH,
            protocols: ['http/1.1'],
          },
          h3: true,
          idleTimeoutMs: 25,
          headersTimeoutMs: 25,
        },
        async (incoming) => {
          const accepted = await incoming.accept();
          const url = new URL(accepted.request.url);
          if (incoming.protocol === 'h3') {
            await accepted.respond(new Response(`h3:${url.pathname}`));
            return;
          }
          await accepted.respond(
            new Response(`tls:${++tlsRequests}`, {
              headers: { 'alt-svc': `h3=":${server.port}"; ma=60` },
            }),
          );
        },
      );
      await server.ready;
      const origin = httpsOrigin(server.port);
      try {
        t.equal(
          await (
            await fetch(`${origin}/warm`, { tls: { rejectUnauthorized: false } } as any)
          ).text(),
          'tls:1',
        );
        t.equal(
          await (
            await fetch(`${origin}/bypass`, {
              protocol: 'http/1.1',
              tls: { rejectUnauthorized: false },
            } as any)
          ).text(),
          'tls:2',
          'http/1.1 override bypasses cached H3',
        );
        t.equal(
          await (
            await fetch(`${origin}/forced`, {
              protocol: 'h3',
              tls: { rejectUnauthorized: false },
            } as any)
          ).text(),
          'h3:/forced',
          'h3 override uses cached Alt-Svc',
        );
        await _resetFetchAltSvc();
        await _resetFetchH3Pool();
        t.equal(
          await (
            await fetch(`https://127.0.0.1:${server.port}/direct`, {
              protocol: 'h3',
              tls: { rejectUnauthorized: false },
            } as any)
          ).text(),
          'h3:/direct',
          'h3 override connects directly when no Alt-Svc is cached',
        );
        await t.rejects(
          () =>
            fetch(`https://127.0.0.1:9/fail`, {
              protocol: 'h3',
              tls: { rejectUnauthorized: false },
            } as any),
          undefined,
          'explicit h3 does not fallback',
        );
        t.equal(tlsRequests, 2, 'failed explicit h3 did not fall back to TLS');
      } finally {
        _setFetchH3HandshakeTimeoutForTest(null);
        await _resetFetchH3Pool();
        await _resetFetchAltSvc();
        await _resetFetchH2Pool();
        await server.close();
      }
    },
  );
  it(
    'keeps non-replayable request bodies on H1/H2 despite cached Alt-Svc',
    { skip: skipGlobalH3 },
    async (t) => {
      await _resetFetchH2Pool();
      await _resetFetchH3Pool();
      await _resetFetchAltSvc();
      let h3Requests = 0;
      const h3 = await h3Serve(
        {
          port: 0,
          hostname: '127.0.0.1',
          certificateFile: CERT_PATH,
          privateKeyFile: KEY_PATH,
        },
        () => {
          h3Requests++;
          return new Response('h3');
        },
      );
      const tls = serveHttp(
        {
          port: 0,
          tls: {
            cert: CERT_PATH,
            key: KEY_PATH,
            protocols: ['http/1.1'],
          },
          idleTimeoutMs: 25,
          headersTimeoutMs: 25,
        },
        async (request) =>
          new Response(`tls:${request.method}:${await request.text()}`, {
            headers: { 'alt-svc': `h3=":${h3.port}"; ma=60` },
          }),
      );
      const origin = httpsOrigin(tls.port);
      try {
        await (await fetch(`${origin}/warm`, { tls: { rejectUnauthorized: false } } as any)).text();
        t.ok(_fetchAltSvcHas(origin), 'Alt-Svc is cached');
        const body = {
          async *[Symbol.asyncIterator]() {
            yield new TextEncoder().encode('stream-body');
          },
        };
        const response = await fetch(`${origin}/upload`, {
          method: 'POST',
          body,
          tls: { rejectUnauthorized: false },
        } as any);
        t.equal(
          await response.text(),
          'tls:POST:stream-body',
          'streaming body stayed on HTTPS H1/H2 path',
        );
        t.equal(h3Requests, 0, 'H3 was not attempted for non-replayable body');
      } finally {
        await _resetFetchH3Pool();
        await _resetFetchAltSvc();
        await _resetFetchH2Pool();
        await tls.close();
        await h3.close();
      }
    },
  );
});
describe('global fetch() — protocol override', () => {
  it(
    'forces H2 when available and fails when ALPN does not negotiate h2',
    { skip: skipHttps },
    async (t) => {
      await _resetFetchH2Pool();
      const h2Server = serveHttp(
        {
          port: 0,
          tls: {
            cert: CERT_PATH,
            key: KEY_PATH,
          },
        },
        async () => new Response('h2-ok'),
      );
      const h1Server = serveHttp({ port: 0 }, async () => new Response('h1-only'));
      try {
        const h2Origin = httpsOrigin(h2Server.port);
        const h2Response = await fetch(`${h2Origin}/`, {
          protocol: 'h2',
          tls: { rejectUnauthorized: false },
        } as any);
        t.equal(
          await h2Response.text(),
          'h2-ok',
          'forced H2 request succeeds against H2-capable server',
        );
        t.ok(_fetchH2PoolHas(h2Origin), 'forced H2 request creates an H2 pool entry');
        await t.rejects(
          () =>
            fetch(`http://127.0.0.1:${h1Server.port}/`, {
              protocol: 'h2',
              tls: { rejectUnauthorized: false },
            } as any),
          /h2|ALPN/i,
          'forced H2 fails instead of downgrading to HTTP/1.1',
        );
      } finally {
        await _resetFetchH2Pool();
        await h2Server.close();
        await h1Server.close();
      }
    },
  );
});
