/**
 * Tests for the global `fetch()` function.
 *
 * Uses boats:serve to spin up local HTTP servers so no external network is
 * required. Each test uses a distinct port in the 19801–19823 range.
 */

import { describe, it } from 'boats:test/test';
import { serve } from 'boats:net/serve';
import { Request, Response, Headers } from 'boats:net/http';
import * as loop from 'boats:runtime/loop';
import { gzip, brotliAvailable, brotliCompress } from 'boats:util/compression';

async function withServer(lp, port, handler, fn) {
  const srv = serve(lp, { port, hostname: '127.0.0.1' }, handler);
  const url = `http://127.0.0.1:${port}`;
  try {
    return await fn(url, srv);
  } finally {
    await srv.close();
  }
}

describe('Basic GET / POST', () => {
  it('basic GET returns 200', async (t) => {
    const lp = loop.create();
    await withServer(lp, 19801,
      () => new Response('hello world', { status: 200 }),
      async (url) => {
        const res = await fetch(url);
        t.equal(res.status, 200, 'status 200');
        t.ok(res.ok, 'ok');
        t.equal(await res.text(), 'hello world', 'body text');
      },
    );
    loop.destroy(lp);
  });

  it('response.url is set to the request URL', async (t) => {
    const lp = loop.create();
    await withServer(lp, 19802,
      () => new Response('ok'),
      async (url) => {
        const res = await fetch(url);
        t.equal(res.url, url, 'url matches');
        t.equal(res.redirected, false, 'not redirected');
      },
    );
    loop.destroy(lp);
  });

  it('response headers are accessible', async (t) => {
    const lp = loop.create();
    await withServer(lp, 19803,
      () => new Response('body', { headers: { 'x-custom': 'boats' } }),
      async (url) => {
        const res = await fetch(url);
        t.equal(res.headers.get('x-custom'), 'boats', 'custom header');
      },
    );
    loop.destroy(lp);
  });

  it('POST sends body and receives echo', async (t) => {
    const lp = loop.create();
    await withServer(lp, 19804,
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
    loop.destroy(lp);
  });

  it('response.json() parses JSON body', async (t) => {
    const lp = loop.create();
    await withServer(lp, 19805,
      () => Response.json({ hello: 'world' }),
      async (url) => {
        const data = await (await fetch(url)).json();
        t.equal(data.hello, 'world', 'json parsed');
      },
    );
    loop.destroy(lp);
  });

  it('204 No Content has null body', async (t) => {
    const lp = loop.create();
    await withServer(lp, 19806,
      () => new Response(null, { status: 204 }),
      async (url) => {
        const res = await fetch(url);
        t.equal(res.status, 204, 'status 204');
        t.equal(res.body, null, 'body is null');
      },
    );
    loop.destroy(lp);
  });
});

describe('Redirects', () => {
  it('301 redirect is followed and method becomes GET', async (t) => {
    const lp = loop.create();
    let requestCount = 0;
    let finalMethod;
    await withServer(lp, 19807,
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
    loop.destroy(lp);
  });

  it('302 redirect is followed', async (t) => {
    const lp = loop.create();
    let count = 0;
    await withServer(lp, 19808,
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
    loop.destroy(lp);
  });

  it('303 See Other changes method to GET', async (t) => {
    const lp = loop.create();
    let count = 0;
    let method;
    await withServer(lp, 19809,
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
    loop.destroy(lp);
  });

  it('307 redirect preserves method', async (t) => {
    const lp = loop.create();
    let count = 0;
    let finalMethod;
    await withServer(lp, 19810,
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
    loop.destroy(lp);
  });

  it("redirect: 'error' throws on redirect response", async (t) => {
    const lp = loop.create();
    await withServer(lp, 19811,
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
    loop.destroy(lp);
  });

  it("redirect: 'manual' returns opaque redirect response", async (t) => {
    const lp = loop.create();
    await withServer(lp, 19812,
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
    loop.destroy(lp);
  });

  it('throws after too many redirects', async (t) => {
    const lp = loop.create();
    let count = 0;
    await withServer(lp, 19813,
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
    loop.destroy(lp);
  });
});

describe('AbortSignal', () => {
  it('pre-aborted signal rejects immediately', async (t) => {
    const lp = loop.create();
    const signal = AbortSignal.abort();
    await withServer(lp, 19814,
      () => new Response('never'),
      async (url) => {
        await t.rejects(
          () => fetch(url, { signal }),
          undefined,
          'rejects with abort reason',
        );
      },
    );
    loop.destroy(lp);
  });

  it('AbortSignal.timeout cancels a slow request', async (t) => {
    const lp = loop.create();
    await withServer(lp, 19815,
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
    loop.destroy(lp);
  });
});

describe('Misc', () => {
  it('accepts a Request object as input', async (t) => {
    const lp = loop.create();
    await withServer(lp, 19816,
      async (req) => new Response(req.method + ':' + new URL(req.url).pathname),
      async (url) => {
        const req = new Request(url + '/path', { method: 'PATCH' });
        const text = await (await fetch(req)).text();
        t.equal(text, 'PATCH:/path', 'Request object used');
      },
    );
    loop.destroy(lp);
  });

  it('Host header is automatically set', async (t) => {
    const lp = loop.create();
    let receivedHost;
    await withServer(lp, 19817,
      (req) => {
        receivedHost = req.headers.get('host');
        return new Response('ok');
      },
      async (url) => {
        await fetch(url);
        t.ok(receivedHost, 'Host header present');
        t.ok(receivedHost.startsWith('127.0.0.1'), 'Host is 127.0.0.1');
      },
    );
    loop.destroy(lp);
  });

  it('chunked response body is readable', async (t) => {
    const lp = loop.create();
    await withServer(lp, 19818,
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
    loop.destroy(lp);
  });

  it('response.bytes() returns Uint8Array', async (t) => {
    const lp = loop.create();
    await withServer(lp, 19819,
      () => new Response('binary'),
      async (url) => {
        const bytes = await (await fetch(url)).bytes();
        t.ok(bytes instanceof Uint8Array, 'bytes() returns Uint8Array');
        t.equal(bytes.length, 6, 'correct byte count');
      },
    );
    loop.destroy(lp);
  });
});

describe('Redirects — additional', () => {
  it('307 redirect preserves request body', async (t) => {
    const lp = loop.create();
    let count = 0;
    let receivedBody: string | null = null;
    await withServer(lp, 19824,
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
    loop.destroy(lp);
  });

  it('308 redirect preserves request body and method', async (t) => {
    const lp = loop.create();
    let count = 0;
    let finalMethod: string | null = null;
    let receivedBody: string | null = null;
    await withServer(lp, 19825,
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
    loop.destroy(lp);
  });

  it('redirect with relative Location header is followed', async (t) => {
    const lp = loop.create();
    let count = 0;
    await withServer(lp, 19826,
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
    loop.destroy(lp);
  });
});

describe('fetch — invalid URL', () => {
  it('fetch with invalid URL throws TypeError', async (t) => {
    const lp = loop.create();
    try {
      await t.rejects(
        () => fetch('not a valid url'),
        undefined,
        'fetch with invalid URL rejects',
      );
    } finally {
      loop.destroy(lp);
    }
  });
});

describe('Compression', () => {
  it('sends Accept-Encoding header', async (t) => {
    const lp = loop.create();
    let receivedEncoding;
    await withServer(lp, 19820,
      (req) => {
        receivedEncoding = req.headers.get('accept-encoding');
        return new Response('ok');
      },
      async (url) => {
        await fetch(url);
        t.ok(receivedEncoding, 'Accept-Encoding header was sent');
        t.ok(receivedEncoding.includes('gzip'), 'includes gzip');
      },
    );
    loop.destroy(lp);
  });

  it('auto-decompresses gzip Content-Encoding', async (t) => {
    const lp = loop.create();
    const original = 'Hello, compressed world!';
    await withServer(lp, 19821,
      () => {
        const compressed = gzip(new TextEncoder().encode(original));
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
    loop.destroy(lp);
  });

  it('user-set Accept-Encoding is preserved', async (t) => {
    const lp = loop.create();
    let received;
    await withServer(lp, 19822,
      (req) => {
        received = req.headers.get('accept-encoding');
        return new Response('ok');
      },
      async (url) => {
        await fetch(url, { headers: { 'accept-encoding': 'identity' } });
        t.equal(received, 'identity', 'user Accept-Encoding not overwritten');
      },
    );
    loop.destroy(lp);
  });

  it('uncompressed response passes through unchanged', async (t) => {
    const lp = loop.create();
    await withServer(lp, 19823,
      () => new Response('plain text'),
      async (url) => {
        t.equal(await (await fetch(url)).text(), 'plain text', 'uncompressed body unchanged');
      },
    );
    loop.destroy(lp);
  });

  it('HEAD response has no body (bodyless)', async (t) => {
    const lp = loop.create();
    await withServer(lp, 19828,
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
    loop.destroy(lp);
  });

  it('304 response is bodyless', async (t) => {
    const lp = loop.create();
    await withServer(lp, 19829,
      () => new Response(null, { status: 304 }),
      async (url) => {
        const res = await fetch(url);
        t.equal(res.status, 304, 'status is 304');
        t.equal(res.body, null, '304 response has null body');
      },
    );
    loop.destroy(lp);
  });

  it('method normalization: lowercase method is uppercased', async (t) => {
    const lp = loop.create();
    let receivedMethod;
    await withServer(lp, 19830,
      (req) => {
        receivedMethod = req.method;
        return new Response('ok');
      },
      async (url) => {
        await fetch(url, { method: 'get' });
        t.equal(receivedMethod, 'GET', 'lowercase method normalized to uppercase');
      },
    );
    loop.destroy(lp);
  });

  it('auto-decompresses brotli Content-Encoding (if brotli available)', async (t) => {
    if (!brotliAvailable) {
      t.ok(true, 'brotli not available, skipping');
      return;
    }
    const lp = loop.create();
    const original = 'brotli compressed content';
    await withServer(lp, 19827,
      () => {
        const compressed = brotliCompress(new TextEncoder().encode(original));
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
    loop.destroy(lp);
  });
});

describe('fetch() — body on GET/HEAD', () => {
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
});
