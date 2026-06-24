/**
 * Tests for the global `fetch()` function.
 *
 * Uses fino:serve to spin up local HTTP servers so no external network is
 * required. Each test uses a distinct port in the 19801–19823 range.
 */

import { describe, it } from 'fino:test/test';
import { serveHttp } from 'fino:net/http/server';
import { compress, brotliAvailable } from 'fino:compress';

type Server = ReturnType<typeof serve>;
type Handler = (req: Request) => Response | Promise<Response>;

async function withServer<T>(port: number, handler: Handler, fn: (url: string, srv: Server) => Promise<T>): Promise<T> {
  const srv = serveHttp({ port, hostname: '127.0.0.1' }, handler);
  const url = `http://127.0.0.1:${port}`;
  try {
    return await fn(url, srv);
  } finally {
    await srv.close();
  }
}

describe('Basic GET / POST', () => {
  it('basic GET returns 200', async (t) => {
    await withServer(19801,
      () => new Response('hello world', { status: 200 }),
      async (url) => {
        const res = await fetch(url);
        t.equal(res.status, 200, 'status 200');
        t.ok(res.ok, 'ok');
        t.equal(await res.text(), 'hello world', 'body text');
      },
    );
  });

  it('response.url is set to the request URL', async (t) => {
    await withServer(19802,
      () => new Response('ok'),
      async (url) => {
        const res = await fetch(url);
        t.equal(res.url, url, 'url matches');
        t.equal(res.redirected, false, 'not redirected');
      },
    );
  });

  it('resolves relative string URLs against globalThis.location', async (t) => {
    await withServer(19824,
      (req) => new Response(new URL(req.url).pathname),
      async (url) => {
        const previousLocation = (globalThis as any).location;
        (globalThis as any).location = new URL(url + '/base/page.html');
        try {
          const res = await fetch('/relative/path');
          t.equal(await res.text(), '/relative/path', 'relative path is requested');
          t.equal(res.url, url + '/relative/path', 'response URL is absolute');
        } finally {
          (globalThis as any).location = previousLocation;
        }
      },
    );
  });

  it('response headers are accessible', async (t) => {
    await withServer(19803,
      () => new Response('body', { headers: { 'x-custom': 'fino' } }),
      async (url) => {
        const res = await fetch(url);
        t.equal(res.headers.get('x-custom'), 'fino', 'custom header');
      },
    );
  });

  it('POST sends body and receives echo', async (t) => {
    await withServer(19804,
      async (req) => {
        const body = await req.text();
        return new Response(body, { status: 201, headers: { 'x-method': req.method } });
      },
      async (url) => {
        const res = await fetch(url, {
          method: 'POST',
          body: 'payload data',
          headers: { 'content-type': 'text/plain' },
        });
        t.equal(res.status, 201, 'status 201');
        t.equal(res.headers.get('x-method'), 'POST', 'method was POST');
        t.equal(await res.text(), 'payload data', 'body echoed');
      },
    );
  });

  it('response.json() parses JSON body', async (t) => {
    await withServer(19805,
      () => Response.json({ hello: 'world' }),
      async (url) => {
        const data = await (await fetch(url)).json();
        t.equal(data.hello, 'world', 'json parsed');
      },
    );
  });

  it('204 No Content has null body', async (t) => {
    await withServer(19806,
      () => new Response(null, { status: 204 }),
      async (url) => {
        const res = await fetch(url);
        t.equal(res.status, 204, 'status 204');
        t.equal(res.body, null, 'body is null');
      },
    );
  });
});

describe('Body formData', () => {
  it('preserves a literal UTF-8 BOM in urlencoded field names', async (t) => {
    const body = '\uFEFFtest=\uFEFF';
    const request = new Request('about:blank', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const requestForm = await request.formData();
    t.equal(requestForm.get('\uFEFFtest'), '\uFEFF');

    const response = new Response(body, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const responseForm = await response.formData();
    t.equal(responseForm.get('\uFEFFtest'), '\uFEFF');
  });
});

describe('Redirects', () => {
  it('301 redirect is followed and method becomes GET', async (t) => {
    let requestCount = 0;
    let finalMethod: string | undefined;
    await withServer(19807,
      (req) => {
        requestCount++;
        if (requestCount === 1) {
          return new Response(null, {
            status: 301,
            headers: { location: new URL('/final', req.url).href },
          });
        }
        finalMethod = req.method;
        return new Response('done');
      },
      async (url) => {
        const res = await fetch(url, { method: 'POST', body: 'data' });
        t.equal(res.status, 200, 'final status 200');
        t.equal(res.redirected, true, 'redirected');
        t.equal(finalMethod, 'GET', 'method changed to GET');
        t.equal(res.url, url + '/final', 'final url');
      },
    );
  });

  it('302 redirect is followed', async (t) => {
    let count = 0;
    await withServer(19808,
      (req) => {
        count++;
        if (count === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: new URL('/target', req.url).href },
          });
        }
        return new Response('target reached');
      },
      async (url) => {
        const res = await fetch(url);
        t.equal(res.status, 200, 'status 200');
        t.equal(res.redirected, true, 'redirected');
        t.equal(await res.text(), 'target reached', 'body from target');
      },
    );
  });

  it('303 See Other changes method to GET', async (t) => {
    let count = 0;
    let method: string | undefined;
    await withServer(19809,
      (req) => {
        count++;
        if (count === 1) {
          return new Response(null, {
            status: 303,
            headers: { location: new URL('/get', req.url).href },
          });
        }
        method = req.method;
        return new Response('ok');
      },
      async (url) => {
        await fetch(url, { method: 'DELETE' });
        t.equal(method, 'GET', '303 changes to GET');
      },
    );
  });

  it('307 redirect preserves method', async (t) => {
    let count = 0;
    let finalMethod: string | undefined;
    await withServer(19810,
      (req) => {
        count++;
        if (count === 1) {
          return new Response(null, {
            status: 307,
            headers: { location: new URL('/kept', req.url).href },
          });
        }
        finalMethod = req.method;
        return new Response('ok');
      },
      async (url) => {
        await fetch(url, { method: 'PUT' });
        t.equal(finalMethod, 'PUT', '307 preserves PUT');
      },
    );
  });

  it("redirect: 'error' throws on redirect response", async (t) => {
    await withServer(19811,
      (req) => new Response(null, {
        status: 302,
        headers: { location: new URL('/other', req.url).href },
      }),
      async (url) => {
        await t.rejects(
          () => fetch(url, { redirect: 'error' }),
          /redirect/i,
          'TypeError on redirect',
        );
      },
    );
  });

  it("redirect: 'manual' returns opaque redirect response", async (t) => {
    await withServer(19812,
      () => new Response(null, {
        status: 302,
        headers: { location: 'http://example.com/other' },
      }),
      async (url) => {
        const res = await fetch(url, { redirect: 'manual' });
        // Per Fetch spec: opaqueredirect response has status 0, empty headers, null body
        t.equal(res.status, 0, 'opaque redirect has status 0');
        t.equal(res.redirected, false, 'not marked redirected');
        t.equal(res.headers.get('location'), null, 'headers are empty');
      },
    );
  });

  it('throws after too many redirects', async (t) => {
    let count = 0;
    await withServer(19813,
      (req) => {
        count++;
        return new Response(null, {
          status: 302,
          headers: { location: new URL('/' + count, req.url).href },
        });
      },
      async (url) => {
        await t.rejects(
          () => fetch(url),
          /redirect/i,
          'TypeError on too many redirects',
        );
      },
    );
  });
});

describe('Redirects — Authorization header security', () => {
  it('Authorization header is stripped on cross-origin redirect', async (t) => {
    // Simulate a cross-origin redirect: origin1 → origin2 (different port = different origin).
    let secondRequestHeaders: Headers | null = null;
    const origin2 = serveHttp({ port: 0 }, (req) => {
      secondRequestHeaders = req.headers;
      return new Response('final');
    });

    const origin1 = serveHttp({ port: 0 }, (_req) =>
      new Response(null, {
        status: 302,
        headers: { location: `http://127.0.0.1:${origin2.port}/` },
      }),
    );

    try {
      await fetch(`http://127.0.0.1:${origin1.port}/`, {
        headers: { authorization: 'Bearer secret-token' },
      });
      t.equal(secondRequestHeaders!.get('authorization'), null,
        'Authorization header stripped on cross-origin redirect');
    } finally {
      await origin1.close();
      await origin2.close();
    }
  });

  it('Authorization header is preserved on same-origin redirect', async (t) => {
    let secondRequestAuth: string | null = null;
    const server = serveHttp({ port: 0 }, (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/first') {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${server.port}/second` },
        });
      }
      secondRequestAuth = req.headers.get('authorization');
      return new Response('ok');
    });

    try {
      await fetch(`http://127.0.0.1:${server.port}/first`, {
        headers: { authorization: 'Bearer secret-token' },
      });
      t.equal(secondRequestAuth, 'Bearer secret-token',
        'Authorization header preserved on same-origin redirect');
    } finally {
      await server.close();
    }
  });

  it('Cookie and Cookie2 headers are stripped on cross-origin redirect', async (t) => {
    let secondRequestHeaders: Headers | null = null;
    const origin2 = serveHttp({ port: 0 }, (req) => {
      secondRequestHeaders = req.headers;
      return new Response('final');
    });

    const origin1 = serveHttp({ port: 0 }, (_req) =>
      new Response(null, {
        status: 302,
        headers: { location: `http://127.0.0.1:${origin2.port}/` },
      }),
    );

    try {
      await fetch(`http://127.0.0.1:${origin1.port}/`, {
        headers: {
          cookie: 'sid=secret',
          cookie2: '$Version="1"',
        },
      });
      t.equal(secondRequestHeaders!.get('cookie'), null, 'Cookie header stripped on cross-origin redirect');
      t.equal(secondRequestHeaders!.get('cookie2'), null, 'Cookie2 header stripped on cross-origin redirect');
    } finally {
      await origin1.close();
      await origin2.close();
    }
  });

  it('Cookie and Cookie2 headers are preserved on same-origin redirect', async (t) => {
    let secondRequestCookie: string | null = null;
    let secondRequestCookie2: string | null = null;
    const server = serveHttp({ port: 0 }, (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/first') {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${server.port}/second` },
        });
      }
      secondRequestCookie = req.headers.get('cookie');
      secondRequestCookie2 = req.headers.get('cookie2');
      return new Response('ok');
    });

    try {
      await fetch(`http://127.0.0.1:${server.port}/first`, {
        headers: {
          cookie: 'sid=secret',
          cookie2: '$Version="1"',
        },
      });
      t.equal(secondRequestCookie, 'sid=secret', 'Cookie header preserved on same-origin redirect');
      t.equal(secondRequestCookie2, '$Version="1"', 'Cookie2 header preserved on same-origin redirect');
    } finally {
      await server.close();
    }
  });
});

describe('AbortSignal', () => {
  it('pre-aborted signal rejects immediately', async (t) => {
    const signal = AbortSignal.abort();
    await withServer(19814,
      () => new Response('never'),
      async (url) => {
        await t.rejects(
          () => fetch(url, { signal }),
          undefined,
          'rejects with abort reason',
        );
      },
    );
  });

  it('AbortSignal.timeout cancels a slow request', async (t) => {
    await withServer(19815,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return new Response('late');
      },
      async (url) => {
        const signal = AbortSignal.timeout(50);
        await t.rejects(
          () => fetch(url, { signal }),
          undefined,
          'rejects when timeout fires',
        );
      },
    );
  });

  it('AbortSignal fires after headers arrive but during body streaming', async (t) => {
    // The signal is created AFTER fetch starts, triggered mid-body so the
    // connection is already open. This tests that body streaming respects
    // cancellation and the connection is properly released.
    let controller!: AbortController;
    let releaseBody!: () => void;
    const bodyReleased = new Promise<void>((resolve) => { releaseBody = resolve; });
    const server = serveHttp({ port: 0 }, async () => {
      // Slow chunked body: send first chunk, then stall.
      async function* slowBody() {
        yield new TextEncoder().encode('first-chunk');
        await bodyReleased;
        yield new TextEncoder().encode('never-arrives');
      }
      // Transfer-Encoding: chunked enables true streaming (without it, serveHttp()
      // buffers the whole body to inject Content-Length, defeating the test).
      return new Response(slowBody() as any, {
        headers: { 'transfer-encoding': 'chunked' },
      });
    });

    try {
      controller = new AbortController();
      const fetchPromise = fetch(`http://127.0.0.1:${server.port}/`, {
        signal: controller.signal,
      });

      const res = await fetchPromise;
      t.equal(res.status, 200, 'response headers received before abort');

      // Fire abort while reading the body.
      setTimeout(() => controller.abort(), 20);

      let threw = false;
      try {
        for await (const _ of res.body as unknown as AsyncIterable<Uint8Array>) { /* drain */ }
      } catch (_) {
        threw = true;
      }
      t.ok(threw, 'body reading throws when signal aborts mid-stream');
    } finally {
      releaseBody();
      await server.close();
    }
  });
});

describe('Misc', () => {
  it('supports data URLs and rejects other direct non-HTTP/S URL schemes', async (t) => {
    const data = await fetch('data:text/plain,hello');
    t.equal(data.status, 200, 'data URL status is OK');
    t.equal(data.type, 'basic', 'data URL response is basic');
    t.equal(data.headers.get('content-type'), 'text/plain', 'data URL MIME type is exposed');
    t.equal(await data.text(), 'hello', 'data URL body is decoded');

    for (const url of [
      'file:///tmp/fino-fetch.txt',
      'javascript:alert(1)',
    ]) {
      await t.rejects(
        () => fetch(url),
        /non-HTTP\/S/i,
        `rejects ${url}`,
      );
    }
  });

  it('accepts a Request object as input', async (t) => {
    await withServer(19816,
      async (req) => new Response(req.method + ':' + new URL(req.url).pathname),
      async (url) => {
        const req = new Request(url + '/path', { method: 'PATCH' });
        const text = await (await fetch(req as unknown as RequestInfo)).text();
        t.equal(text, 'PATCH:/path', 'Request object used');
      },
    );
  });

  it('fetches Blob object URLs and fails after revocation', async (t) => {
    const blob = new Blob(['blob body'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const res = await fetch(url);
    t.equal(await res.text(), 'blob body', 'blob URL body is returned');
    t.equal(res.headers.get('content-type'), 'text/plain', 'Blob type becomes Content-Type');

    URL.revokeObjectURL(url);
    await t.rejects(() => fetch(url), TypeError, 'revoked blob URL rejects');
  });

  it('fetches a Request created before its Blob object URL is revoked', async (t) => {
    const url = URL.createObjectURL(new Blob(['captured']));
    const request = new Request(url);
    URL.revokeObjectURL(url);
    t.equal(await (await fetch(request)).text(), 'captured', 'Request captured the Blob reference');
    t.equal(await (await fetch(request.clone())).text(), 'captured', 'cloned Request keeps the Blob reference');
  });

  it('Host header is automatically set', async (t) => {
    let receivedHost: string | null = null;
    await withServer(19817,
      (req) => {
        receivedHost = req.headers.get('host');
        return new Response('ok');
      },
      async (url) => {
        await fetch(url);
        t.ok(receivedHost, 'Host header present');
        if (receivedHost === null) throw new Error('Host header should be present');
        t.ok(receivedHost.startsWith('127.0.0.1'), 'Host is 127.0.0.1');
      },
    );
  });

  it('chunked response body is readable', async (t) => {
    await withServer(19818,
      () => {
        const body = 'chunk1chunk2chunk3';
        return new Response(body, {
          headers: { 'transfer-encoding': 'chunked' },
        });
      },
      async (url) => {
        const text = await (await fetch(url)).text();
        t.equal(text, 'chunk1chunk2chunk3', 'chunked body assembled');
      },
    );
  });

  it('response.bytes() returns Uint8Array', async (t) => {
    await withServer(19819,
      () => new Response('binary'),
      async (url) => {
        const bytes = await (await fetch(url)).bytes();
        t.ok(bytes instanceof Uint8Array, 'bytes() returns Uint8Array');
        t.equal(bytes.length, 6, 'correct byte count');
      },
    );
  });

  it('accepts non-enforced RequestInit compatibility options', async (t) => {
    let receivedMethod: string | undefined;
    await withServer(19831,
      (req) => {
        receivedMethod = req.method;
        return new Response('compat');
      },
      async (url) => {
        const res = await fetch(url, {
          mode: 'cors',
          credentials: 'include',
          cache: 'no-store',
          keepalive: true,
        });
        t.equal(res.status, 200, 'request succeeds with compatibility options');
        t.equal(receivedMethod, 'GET', 'compatibility options do not alter method');
        t.equal(await res.text(), 'compat', 'response body is delivered');
      },
    );
  });

  it('does not synthesize browser CORS or opaque responses from mode options', async (t) => {
    const seenModes: string[] = [];
    await withServer(19833,
      (req) => {
        seenModes.push(req.headers.get('origin') ?? 'no-origin');
        return new Response('visible body', {
          headers: { 'x-visible': 'yes' },
        });
      },
      async (url) => {
        const cors = await fetch(url, { mode: 'cors' });
        t.equal(cors.status, 200, 'cors mode returns normal response status');
        t.equal(cors.headers.get('x-visible'), 'yes', 'cors mode does not hide response headers');
        t.equal(await cors.text(), 'visible body', 'cors mode does not require CORS response headers');

        const noCors = await fetch(url, { mode: 'no-cors' });
        t.equal(noCors.status, 200, 'no-cors mode returns normal response status');
        t.equal(noCors.headers.get('x-visible'), 'yes', 'no-cors mode does not produce opaque headers');
        t.equal(await noCors.text(), 'visible body', 'no-cors mode does not produce an opaque body');

        t.deepEqual(seenModes, ['no-origin', 'no-origin'], 'mode options do not synthesize browser Origin headers');
      },
    );
  });

  it('does not retain Set-Cookie or cache responses between fetch calls', async (t) => {
    let requestCount = 0;
    const cookies: Array<string | null> = [];
    await withServer(19834,
      (req) => {
        requestCount++;
        cookies.push(req.headers.get('cookie'));
        return new Response(`response-${requestCount}`, {
          headers: {
            'cache-control': 'max-age=3600',
            'set-cookie': `sid=${requestCount}`,
          },
        });
      },
      async (url) => {
        const first = await fetch(url, {
          cache: 'force-cache',
          credentials: 'include',
          keepalive: true,
        });
        t.equal(await first.text(), 'response-1', 'first response is delivered normally');

        const second = await fetch(url, {
          cache: 'force-cache',
          credentials: 'include',
          keepalive: true,
        });
        t.equal(await second.text(), 'response-2', 'cache option does not reuse a prior response');
        t.deepEqual(cookies, [null, null], 'Set-Cookie is not retained as an implicit cookie jar');

        const explicit = await fetch(url, {
          headers: { cookie: 'sid=caller-provided' },
          credentials: 'omit',
        });
        t.equal(await explicit.text(), 'response-3', 'explicit caller-provided cookie request succeeds');
        t.equal(cookies[2], 'sid=caller-provided', 'explicit Cookie header remains caller controlled');
      },
    );
  });

  it('sends a streaming request body when duplex is half', async (t) => {
    let receivedBody = '';
    await withServer(19832,
      async (req) => {
        receivedBody = await req.text();
        return new Response('stream-ok');
      },
      async (url) => {
        async function* body() {
          yield new TextEncoder().encode('stream-');
          yield new TextEncoder().encode('body');
        }
        const res = await fetch(url, {
          method: 'POST',
          body: body() as any,
          duplex: 'half',
        } as any);
        t.equal(res.status, 200, 'streaming request receives response');
        t.equal(await res.text(), 'stream-ok', 'response body is delivered');
        t.equal(receivedBody, 'stream-body', 'server receives streamed request body');
      },
    );
  });
});

describe('Redirects — additional', () => {
  it('307 redirect preserves request body', async (t) => {
    let count = 0;
    let receivedBody: string | null = null;
    await withServer(19824,
      async (req) => {
        count++;
        if (count === 1) {
          return new Response(null, {
            status: 307,
            headers: { location: new URL('/target', req.url).href },
          });
        }
        receivedBody = await req.text();
        return new Response('ok');
      },
      async (url) => {
        await fetch(url, { method: 'POST', body: 'original body' });
        t.equal(receivedBody, 'original body', '307 redirect preserves request body');
      },
    );
  });

  it('308 redirect preserves request body and method', async (t) => {
    let count = 0;
    let finalMethod: string | null = null;
    let receivedBody: string | null = null;
    await withServer(19825,
      async (req) => {
        count++;
        if (count === 1) {
          return new Response(null, {
            status: 308,
            headers: { location: new URL('/dest', req.url).href },
          });
        }
        finalMethod = req.method;
        receivedBody = await req.text();
        return new Response('done');
      },
      async (url) => {
        await fetch(url, { method: 'PATCH', body: 'patch data' });
        t.equal(finalMethod, 'PATCH', '308 preserves PATCH method');
        t.equal(receivedBody, 'patch data', '308 preserves request body');
      },
    );
  });

  it('redirect with relative Location header is followed', async (t) => {
    let count = 0;
    await withServer(19826,
      (req) => {
        count++;
        if (count === 1) {
          // Relative Location (some servers send these)
          return new Response(null, {
            status: 302,
            headers: { location: '/relative-target' },
          });
        }
        return new Response('relative redirect worked');
      },
      async (url) => {
        const res = await fetch(url);
        t.equal(res.status, 200, 'followed relative redirect');
        t.equal(await res.text(), 'relative redirect worked', 'correct body');
      },
    );
  });

  it('307 redirect rejects a streaming request body instead of replaying it', async (t) => {
    let finalRequestSeen = false;
    await withServer(19833,
      (req) => {
        if (new URL(req.url).pathname === '/target') {
          finalRequestSeen = true;
          return new Response('unexpected');
        }
        return new Response(null, {
          status: 307,
          headers: { location: new URL('/target', req.url).href },
        });
      },
      async (url) => {
        async function* body() {
          yield new TextEncoder().encode('one-shot');
        }
        await t.rejects(
          () => fetch(url, { method: 'POST', body: body() as any, duplex: 'half' } as any),
          /streaming|replay/i,
          'streaming 307 redirect rejects',
        );
        t.equal(finalRequestSeen, false, 'redirect target is not called with a consumed body');
      },
    );
  });
});

describe('fetch — invalid URL', () => {
  it('fetch with invalid URL throws TypeError', async (t) => {
    await t.rejects(
      () => fetch('not a valid url'),
      undefined,
      'fetch with invalid URL rejects',
    );
  });
});

describe('Compression', () => {
  it('sends Accept-Encoding header', async (t) => {
    let receivedEncoding: string | null = null;
    await withServer(19820,
      (req) => {
        receivedEncoding = req.headers.get('accept-encoding');
        return new Response('ok');
      },
      async (url) => {
        await fetch(url);
        t.ok(receivedEncoding, 'Accept-Encoding header was sent');
        if (receivedEncoding === null) throw new Error('Accept-Encoding should be present');
        t.ok(receivedEncoding.includes('gzip'), 'includes gzip');
      },
    );
  });

  it('auto-decompresses gzip Content-Encoding', async (t) => {
    const original = 'Hello, compressed world!';
    await withServer(19821,
      () => {
        const compressed = compress(new TextEncoder().encode(original), { format: 'gzip' });
        return new Response(compressed, {
          headers: {
            'content-type':     'text/plain',
            'content-encoding': 'gzip',
            'content-length':   String(compressed.byteLength),
          },
        });
      },
      async (url) => {
        const res  = await fetch(url);
        t.equal(res.headers.get('content-encoding'), null, 'content-encoding removed');
        t.equal(res.headers.get('content-length'),   null, 'content-length removed');
        t.equal(await res.text(), original, 'body decompressed correctly');
      },
    );
  });

  it('user-set Accept-Encoding is preserved', async (t) => {
    let received: string | null = null;
    await withServer(19822,
      (req) => {
        received = req.headers.get('accept-encoding');
        return new Response('ok');
      },
      async (url) => {
        await fetch(url, { headers: { 'accept-encoding': 'identity' } });
        t.equal(received, 'identity', 'user Accept-Encoding not overwritten');
      },
    );
  });

  it('uncompressed response passes through unchanged', async (t) => {
    await withServer(19823,
      () => new Response('plain text'),
      async (url) => {
        t.equal(await (await fetch(url)).text(), 'plain text', 'uncompressed body unchanged');
      },
    );
  });

  it('HEAD response has no body (bodyless)', async (t) => {
    await withServer(19828,
      () => new Response('body content', {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-length': '12' },
      }),
      async (url) => {
        const res = await fetch(url, { method: 'HEAD' });
        t.equal(res.status, 200, 'status is 200');
        t.equal(res.body, null, 'HEAD response has null body');
        const text = await res.text();
        t.equal(text, '', 'HEAD response text() is empty string');
      },
    );
  });

  it('304 response is bodyless', async (t) => {
    await withServer(19829,
      () => new Response(null, { status: 304 }),
      async (url) => {
        const res = await fetch(url);
        t.equal(res.status, 304, 'status is 304');
        t.equal(res.body, null, '304 response has null body');
      },
    );
  });

  it('method normalization: lowercase method is uppercased', async (t) => {
    let receivedMethod: string | undefined;
    await withServer(19830,
      (req) => {
        receivedMethod = req.method;
        return new Response('ok');
      },
      async (url) => {
        await fetch(url, { method: 'get' });
        t.equal(receivedMethod, 'GET', 'lowercase method normalized to uppercase');
      },
    );
  });

  it('auto-decompresses brotli Content-Encoding (if brotli available)', async (t) => {
    if (!brotliAvailable) {
      t.ok(true, 'brotli not available, skipping');
      return;
    }
    const original = 'brotli compressed content';
    await withServer(19827,
      () => {
        const compressed = compress(new TextEncoder().encode(original), { format: 'brotli' });
        return new Response(compressed, {
          headers: {
            'content-type': 'text/plain',
            'content-encoding': 'br',
            'content-length': String(compressed.byteLength),
          },
        });
      },
      async (url) => {
        const res = await fetch(url);
        t.equal(await res.text(), original, 'brotli body decompressed correctly');
      },
    );
  });
});

describe('fetch() — body on GET/HEAD', () => {
  it('Request constructor with GET body throws TypeError', (t) => {
    t.throws(
      () => new Request('http://127.0.0.1/', { method: 'GET', body: 'hello' }),
      /body/i,
      'GET Request with body throws TypeError',
    );
  });

  it('Request constructor with HEAD body throws TypeError', (t) => {
    t.throws(
      () => new Request('http://127.0.0.1/', { method: 'HEAD', body: 'hello' }),
      /body/i,
      'HEAD Request with body throws TypeError',
    );
  });

  it('GET request with body throws TypeError', async (t) => {
    await t.rejects(
      async () => fetch('http://127.0.0.1:19824/', { method: 'GET', body: 'hello' }),
      /body/i,
      'GET with body throws TypeError',
    );
  });

  it('HEAD request with body throws TypeError', async (t) => {
    await t.rejects(
      async () => fetch('http://127.0.0.1:19824/', { method: 'HEAD', body: 'hello' }),
      /body/i,
      'HEAD with body throws TypeError',
    );
  });
});

describe('Response.redirect() status validation', () => {
  it('accepts valid redirect status codes', (t) => {
    for (const status of [301, 302, 303, 307, 308]) {
      const r = Response.redirect('https://example.com/', status);
      t.equal(r.status, status, `status ${status} accepted`);
    }
  });

  it('throws RangeError for invalid status codes', (t) => {
    for (const status of [200, 204, 400, 500, 0, 999]) {
      t.throws(
        () => Response.redirect('https://example.com/', status),
        /RangeError|invalid/i,
        `status ${status} throws`,
      );
    }
  });

  it('default status is 302', (t) => {
    const r = Response.redirect('https://example.com/');
    t.equal(r.status, 302, 'default redirect status is 302');
  });
});

describe('fetch() method normalization', () => {
  it('standard methods are uppercased', (t) => {
    const req = new Request('https://example.com/', { method: 'post' });
    t.equal(req.method, 'POST', 'post → POST');
  });

  it('PATCH is preserved as-is (not in normalization set)', (t) => {
    const req = new Request('https://example.com/', { method: 'patch' });
    t.equal(req.method, 'patch', 'patch is not uppercased (non-normalized method)');
  });

  it('custom methods are preserved', (t) => {
    const req = new Request('https://example.com/', { method: 'CUSTOM' });
    t.equal(req.method, 'CUSTOM', 'custom method preserved');
  });

  it('forbidden methods throw', (t) => {
    for (const method of ['CONNECT', 'TRACE', 'TRACK', 'connect', 'trace', 'track']) {
      t.throws(
        () => new Request('https://example.com/', { method }),
        TypeError,
        `${method} is forbidden`,
      );
    }
  });
});

describe('Request structure', () => {
  it('exposes read-only metadata defaults', (t) => {
    const req = new Request('https://example.com/');
    const defaults = {
      destination: '',
      referrer: 'about:client',
      referrerPolicy: '',
      mode: 'cors',
      credentials: 'same-origin',
      cache: 'default',
      redirect: 'follow',
      integrity: '',
      isReloadNavigation: false,
      isHistoryNavigation: false,
      duplex: 'half',
    };

    for (const [name, value] of Object.entries(defaults)) {
      t.equal((req as any)[name], value, `${name} default`);
      try {
        (req as any)[name] = 'changed';
      } catch (_) {
        // Getter-only properties throw on assignment in module strict mode.
      }
      t.equal((req as any)[name], value, `${name} is read-only`);
    }

    t.equal('priority' in req, false, 'priority remains internal');
    t.equal('internalpriority' in req, false, 'internalpriority remains internal');
    t.equal('blocking' in req, false, 'blocking remains internal');
  });
});

describe('Request disturbed state', () => {
  it('rejects constructing from a consumed request body', async (t) => {
    const consumed = new Request('https://example.com/', { method: 'POST', body: 'body' });
    await consumed.text();

    t.throws(
      () => new Request(consumed),
      TypeError,
      'consumed input body cannot be reused',
    );
  });

  it('transfers input request body to the constructed request', async (t) => {
    const input = new Request('https://example.com/', { method: 'POST', body: 'body' });
    const originalBody = input.body;
    const copy = new Request(input);

    t.equal(input.bodyUsed, true, 'input request is disturbed');
    t.equal(input.body, originalBody, 'input body object stays stable');
    t.notEqual(copy.body, originalBody, 'constructed request gets a distinct body');
    t.equal(await copy.text(), 'body', 'constructed request receives input body bytes');
  });

  it('does not disturb input request when construction fails', (t) => {
    const input = new Request('https://example.com/', { method: 'POST', body: 'body' });

    t.throws(
      () => new Request(input, { method: 'GET' }),
      TypeError,
      'GET cannot inherit a body',
    );
    t.equal(input.bodyUsed, false, 'failed method validation leaves body unused');

    t.throws(
      () => new Request(input, { method: 'CONNECT' }),
      TypeError,
      'forbidden method fails before body transfer',
    );
    t.equal(input.bodyUsed, false, 'forbidden method leaves body unused');
  });
});

describe('Integrity + referrerPolicy', () => {
  it('integrity check passes for matching SHA-256 hash', async (t) => {
    const body = 'hello integrity';
    const bodyBytes = new TextEncoder().encode(body);
    const hashBuffer = await crypto.subtle.digest('SHA-256', bodyBytes);
    const hashBytes = new Uint8Array(hashBuffer);

    // Base64-encode the hash
    let b64 = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (let i = 0; i < hashBytes.length; i += 3) {
      const b0 = hashBytes[i]!;
      const b1 = hashBytes[i + 1] ?? 0;
      const b2 = hashBytes[i + 2] ?? 0;
      b64 += chars[b0 >> 2]! + chars[((b0 & 3) << 4) | (b1 >> 4)]!;
      b64 += i + 1 < hashBytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)]! : '=';
      b64 += i + 2 < hashBytes.length ? chars[b2 & 63]! : '=';
    }

    const srv = serveHttp({ port: 0, hostname: '127.0.0.1' }, () => new Response(body));
    const url = `http://127.0.0.1:${srv.port}`;
    try {
      const res = await fetch(url, { integrity: `sha256-${b64}` });
      t.equal(await res.text(), body, 'body text matches after integrity check');
    } finally {
      await srv.close();
    }
  });

  it('integrity check fails for wrong hash', async (t) => {
    const srv = serveHttp({ port: 0, hostname: '127.0.0.1' }, () => new Response('hello integrity'));
    const url = `http://127.0.0.1:${srv.port}`;
    try {
      await t.rejects(
        () => fetch(url, { integrity: 'sha256-wronghash=' }),
        /integrity/i,
        'fetch rejects with TypeError when integrity does not match',
      );
    } finally {
      await srv.close();
    }
  });

  it("referrerPolicy: 'no-referrer' — no Referer header sent", async (t) => {
    let receivedReferer: string | null | undefined;
    const srv = serveHttp({ port: 0, hostname: '127.0.0.1' }, (req) => {
      receivedReferer = req.headers.get('referer');
      return new Response(receivedReferer ?? '');
    });
    const url = `http://127.0.0.1:${srv.port}`;
    try {
      const res = await fetch(url, {
        referrer: 'https://example.com/',
        referrerPolicy: 'no-referrer',
      });
      const text = await res.text();
      t.equal(text, '', 'no Referer header was sent (no-referrer policy)');
    } finally {
      await srv.close();
    }
  });

  it("referrerPolicy: 'origin' — Referer header is origin only", async (t) => {
    let receivedReferer: string | null | undefined;
    const srv = serveHttp({ port: 0, hostname: '127.0.0.1' }, (req) => {
      receivedReferer = req.headers.get('referer');
      return new Response(receivedReferer ?? '');
    });
    const url = `http://127.0.0.1:${srv.port}`;
    try {
      const res = await fetch(url, {
        referrer: 'https://example.com/some/page',
        referrerPolicy: 'origin',
      });
      const text = await res.text();
      t.equal(text, 'https://example.com/', 'Referer is origin only');
    } finally {
      await srv.close();
    }
  });
});

describe('fetch() — redirect safety', () => {
  it('redirect to javascript: URL throws TypeError', async (t) => {
    // A server returning Location: javascript:... must NOT be followed.
    // Regression for the unsafe-redirect-protocol fix.
    const srv = serveHttp({ port: 0 }, () =>
      new Response(null, {
        status: 302,
        headers: { location: 'javascript:alert(1)' },
      }),
    );
    try {
      await t.rejects(
        () => fetch(`http://127.0.0.1:${srv.port}/`),
        /non-HTTP|javascript|redirect/i,
        'fetch throws when redirected to javascript: URL',
      );
    } finally {
      await srv.close();
    }
  });

  it('redirect to file: URL throws TypeError', async (t) => {
    const srv = serveHttp({ port: 0 }, () =>
      new Response(null, {
        status: 301,
        headers: { location: 'file:///etc/passwd' },
      }),
    );
    try {
      await t.rejects(
        () => fetch(`http://127.0.0.1:${srv.port}/`),
        /non-HTTP|file:|redirect/i,
        'fetch throws when redirected to file: URL',
      );
    } finally {
      await srv.close();
    }
  });

  it('HEAD request body is empty even when Content-Length is present', async (t) => {
    // Regression for the HEAD framing bug: parseResponse must honor the
    // request method and never attempt to read a body for HEAD responses.
    const srv = serveHttp({ port: 0 }, () => new Response('should-not-be-read'));
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/`, { method: 'HEAD' });
      t.equal(res.status, 200, 'HEAD returns 200');
      const body = await res.text();
      t.equal(body, '', 'HEAD response body is empty (no hang)');
    } finally {
      await srv.close();
    }
  });
});
