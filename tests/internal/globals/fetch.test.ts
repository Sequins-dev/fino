/**
 * Tests for the global `fetch()` function.
 *
 * Uses fino:serve to spin up local HTTP servers so no external network is
 * required. Servers bind ephemeral ports so repeated tests do not race with
 * ports that are still being released by the OS.
 */
import { describe, it } from 'fino:test/test';
import { serveHttp } from 'fino:net/http/server';
import { compress, brotliAvailable } from 'fino:compress';
type Server = ReturnType<typeof serve>;
type Handler = (req: Request) => Response | Promise<Response>;
function descriptor(target: object, key: PropertyKey): PropertyDescriptor {
  const desc = Object.getOwnPropertyDescriptor(target, key);
  if (desc === undefined) throw new Error(`missing descriptor for ${String(key)}`);
  return desc;
}
async function withServer<T>(
  handler: Handler,
  fn: (url: string, srv: Server) => Promise<T>,
): Promise<T> {
  const srv = serveHttp(
    {
      port: 0,
      hostname: '127.0.0.1',
    },
    handler,
  );
  const url = `http://127.0.0.1:${srv.port}`;
  try {
    return await fn(url, srv);
  } finally {
    await srv.close();
  }
}
describe('Fetch API WebIDL descriptors', () => {
  it('installs Fetch API globals as non-enumerable global properties', (t) => {
    for (const name of ['Headers', 'Request', 'Response']) {
      const desc = descriptor(globalThis, name);
      t.equal(desc.enumerable, false, `${name} global is non-enumerable`);
      t.equal(desc.writable, true, `${name} global is writable`);
      t.equal(desc.configurable, true, `${name} global is configurable`);
    }
    t.equal(
      descriptor(globalThis, 'fetch').enumerable,
      true,
      'fetch global operation is enumerable',
    );
  });
  it('sets function and constructor lengths', (t) => {
    t.equal(fetch.length, 1, 'fetch.length');
    t.equal(Headers.length, 0, 'Headers.length');
    t.equal(Request.length, 1, 'Request.length');
    t.equal(Response.length, 0, 'Response.length');
  });
  it('sets string tags for Fetch API objects', (t) => {
    t.equal(
      Object.prototype.toString.call(new Headers()),
      '[object Headers]',
      'Headers toStringTag',
    );
    t.equal(
      Object.prototype.toString.call(new Request('about:blank')),
      '[object Request]',
      'Request toStringTag',
    );
    t.equal(
      Object.prototype.toString.call(new Response()),
      '[object Response]',
      'Response toStringTag',
    );
  });
  it('exposes Fetch API prototype members as enumerable', (t) => {
    for (const [target, name] of [
      [Headers.prototype, 'append'],
      [Headers.prototype, 'getSetCookie'],
      [Request.prototype, 'url'],
      [Request.prototype, 'signal'],
      [Request.prototype, 'bodyUsed'],
      [Request.prototype, 'arrayBuffer'],
      [Request.prototype, 'textStream'],
      [Response.prototype, 'status'],
      [Response.prototype, 'bodyUsed'],
      [Response.prototype, 'arrayBuffer'],
      [Response.prototype, 'textStream'],
      [Response, 'json'],
    ] as const) {
      t.equal(descriptor(target, name).enumerable, true, `${String(name)} is enumerable`);
    }
    t.equal(
      Headers.prototype[Symbol.iterator],
      Headers.prototype.entries,
      'Headers iterator is entries',
    );
    t.equal(
      descriptor(Headers.prototype, Symbol.iterator).enumerable,
      false,
      'Headers iterator is non-enumerable',
    );
  });
  it('throws for required WebIDL arguments and exposes expected operation lengths', (t) => {
    const headers = new Headers();
    t.throws(() => headers.append(), TypeError, 'Headers.append requires arguments');
    t.throws(() => headers.delete(), TypeError, 'Headers.delete requires arguments');
    t.throws(() => headers.get(), TypeError, 'Headers.get requires arguments');
    t.throws(() => headers.has(), TypeError, 'Headers.has requires arguments');
    t.throws(() => headers.set(), TypeError, 'Headers.set requires arguments');
    t.equal(headers.forEach.length, 1, 'Headers.forEach.length');
    t.equal(Response.json.length, 1, 'Response.json.length');
    t.equal(Response.redirect.length, 1, 'Response.redirect.length');
    t.throws(() => Response.json(), TypeError, 'Response.json requires data');
    t.throws(() => Response.redirect(), TypeError, 'Response.redirect requires url');
  });
  it('exposes a Request signal and brands constant getters', (t) => {
    const request = new Request('about:blank');
    t.ok(request.signal instanceof AbortSignal, 'Request.signal is an AbortSignal');
    for (const name of [
      'destination',
      'referrer',
      'referrerPolicy',
      'mode',
      'credentials',
      'cache',
      'redirect',
      'integrity',
      'isReloadNavigation',
      'isHistoryNavigation',
      'duplex',
    ] as const) {
      t.throws(
        () => Reflect.get(Request.prototype, name, Request.prototype),
        TypeError,
        `${name} getter requires a Request receiver`,
      );
    }
  });
});
describe('fetch globals surface', () => {
  it('does not install fetchLater or FetchLaterResult', (t) => {
    t.equal('fetchLater' in globalThis, false, 'fetchLater is not installed');
    t.equal('FetchLaterResult' in globalThis, false, 'FetchLaterResult is not installed');
  });
});
describe('Basic GET / POST', () => {
  it('basic GET returns 200', async (t) => {
    await withServer(
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
    await withServer(
      () => new Response('ok'),
      async (url) => {
        const res = await fetch(url);
        t.equal(res.url, url, 'url matches');
        t.equal(res.redirected, false, 'not redirected');
      },
    );
  });
  it('resolves relative string URLs against globalThis.location', async (t) => {
    await withServer(
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
    await withServer(
      () => new Response('body', { headers: { 'x-custom': 'fino' } }),
      async (url) => {
        const res = await fetch(url);
        t.equal(res.headers.get('x-custom'), 'fino', 'custom header');
      },
    );
  });
  it('POST sends body and receives echo', async (t) => {
    await withServer(
      async (req) => {
        const body = await req.text();
        return new Response(body, {
          status: 201,
          headers: { 'x-method': req.method },
        });
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
    await withServer(
      () => Response.json({ hello: 'world' }),
      async (url) => {
        const data = await (await fetch(url)).json();
        t.equal(data.hello, 'world', 'json parsed');
      },
    );
  });
  it('204 No Content has null body', async (t) => {
    await withServer(
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
    const body = '﻿test=﻿';
    const request = new Request('about:blank', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const requestForm = await request.formData();
    t.equal(requestForm.get('﻿test'), '﻿');
    const response = new Response(body, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const responseForm = await response.formData();
    t.equal(responseForm.get('﻿test'), '﻿');
  });
  it('rejects empty multipart bodies without marking them used', async (t) => {
    const request = new Request('about:blank', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary="boundary"' },
    });
    await t.rejects(() => request.formData(), TypeError, 'empty multipart body rejects');
    t.equal(request.bodyUsed, false, 'bodyless request remains unused');
  });
  it('round-trips empty FormData bodies as empty FormData', async (t) => {
    const requestText = await new Request('about:blank', {
      method: 'POST',
      body: new FormData(),
    }).text();
    t.equal(requestText, '', 'empty FormData request text is empty');
    const responseText = await new Response(new FormData()).text();
    t.equal(responseText, '', 'empty FormData response text is empty');
    const request = new Request('about:blank', {
      method: 'POST',
      body: new FormData(),
    });
    const requestForm = await request.formData();
    t.ok(requestForm instanceof FormData, 'request parses as FormData');
    t.equal(Array.from(requestForm).length, 0, 'request form has no entries');
    const response = new Response(new FormData());
    const responseForm = await response.formData();
    t.ok(responseForm instanceof FormData, 'response parses as FormData');
    t.equal(Array.from(responseForm).length, 0, 'response form has no entries');
  });
  it('rejects malformed multipart closing boundaries', async (t) => {
    const body =
      '--Boundary_with_capital_letters\r\n' +
      'Content-Type: application/json\r\n' +
      'Content-Disposition: form-data; name="does_this_work"\r\n' +
      '\r\n' +
      'YES\r\n' +
      '--Boundary_with_capital_letters-Random junk';
    const response = new Response(new Blob([body]), {
      headers: { 'content-type': 'multipart/form-data; boundary=Boundary_with_capital_letters' },
    });
    await t.rejects(() => response.formData(), TypeError, 'malformed closing boundary rejects');
  });
  it('defaults multipart file parts without Content-Type to text/plain', async (t) => {
    const encoder = new TextEncoder();
    const prefix = encoder.encode(
      '--boundary\r\n' +
        'Content-Disposition: form-data; name="file"; filename="file.txt"\r\n' +
        '\r\n',
    );
    const content = new Uint8Array([5, 0, 255]);
    const suffix = encoder.encode('\r\n--boundary--\r\n');
    const body = new Uint8Array(prefix.byteLength + content.byteLength + suffix.byteLength);
    body.set(prefix, 0);
    body.set(content, prefix.byteLength);
    body.set(suffix, prefix.byteLength + content.byteLength);
    const response = new Response(new Blob([body]), {
      headers: { 'content-type': 'multipart/form-data; boundary="boundary"' },
    });
    const form = await response.formData();
    const file = form.get('file') as File;
    t.ok(file instanceof File, 'multipart filename part parses as File');
    t.equal(file.type, 'text/plain', 'missing file Content-Type defaults to text/plain');
    t.deepEqual(
      Array.from(new Uint8Array(await file.arrayBuffer())),
      Array.from(content),
      'multipart file bytes are preserved',
    );
  });
});
describe('Request BodyInit', () => {
  it('sets the default content type for string bodies', async (t) => {
    const request = new Request('https://example.com/', {
      method: 'POST',
      body: 'hello',
    });
    t.equal(request.headers.get('content-type'), 'text/plain;charset=UTF-8');
    t.equal(await request.text(), 'hello');
  });
  it('stringifies plain object bodies', async (t) => {
    const request = new Request('https://example.com/', {
      method: 'POST',
      body: { toString: () => 'hello' } as any,
    });
    t.equal(request.headers.get('content-type'), 'text/plain;charset=UTF-8');
    t.equal(await request.text(), 'hello');
  });
  it('accepts ArrayBufferView bodies using their view byte range', async (t) => {
    const bytes = new Uint8Array([0, 34, 104, 105, 34, 0]);
    const int8 = new Int8Array(bytes.buffer, 1, 4);
    const dataView = new DataView(bytes.buffer, 1, 4);
    t.equal(
      await new Request('https://example.com/', {
        method: 'POST',
        body: int8 as any,
      }).text(),
      '"hi"',
    );
    t.equal(
      await new Request('https://example.com/', {
        method: 'POST',
        body: dataView as any,
      }).text(),
      '"hi"',
    );
    const requestBytes = await new Request('https://example.com/', {
      method: 'POST',
      body: int8 as any,
    }).bytes();
    t.equal(requestBytes.byteLength, 4, 'bytes() returns the view length');
    t.equal(requestBytes.buffer.byteLength, 4, 'bytes() returns a tightly sized buffer');
  });
});
describe('Redirects', () => {
  it('301 redirect is followed and method becomes GET', async (t) => {
    let requestCount = 0;
    let finalMethod: string | undefined;
    await withServer(
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
        const res = await fetch(url, {
          method: 'POST',
          body: 'data',
        });
        t.equal(res.status, 200, 'final status 200');
        t.equal(res.redirected, true, 'redirected');
        t.equal(finalMethod, 'GET', 'method changed to GET');
        t.equal(res.url, url + '/final', 'final url');
      },
    );
  });
  it('302 redirect is followed', async (t) => {
    let count = 0;
    await withServer(
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
    await withServer(
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
    await withServer(
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
    await withServer(
      (req) =>
        new Response(null, {
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
    await withServer(
      () =>
        new Response(null, {
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
    await withServer(
      (req) => {
        count++;
        return new Response(null, {
          status: 302,
          headers: { location: new URL('/' + count, req.url).href },
        });
      },
      async (url) => {
        await t.rejects(() => fetch(url), /redirect/i, 'TypeError on too many redirects');
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
    const origin1 = serveHttp(
      { port: 0 },
      (_req) =>
        new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${origin2.port}/` },
        }),
    );
    try {
      await fetch(`http://127.0.0.1:${origin1.port}/`, {
        headers: { authorization: 'Bearer secret-token' },
      });
      t.equal(
        secondRequestHeaders!.get('authorization'),
        null,
        'Authorization header stripped on cross-origin redirect',
      );
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
      t.equal(
        secondRequestAuth,
        'Bearer secret-token',
        'Authorization header preserved on same-origin redirect',
      );
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
    const origin1 = serveHttp(
      { port: 0 },
      (_req) =>
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
      t.equal(
        secondRequestHeaders!.get('cookie'),
        null,
        'Cookie header stripped on cross-origin redirect',
      );
      t.equal(
        secondRequestHeaders!.get('cookie2'),
        null,
        'Cookie2 header stripped on cross-origin redirect',
      );
    } finally {
      await origin1.close();
      await origin2.close();
    }
  });
  it('Cookie and Cookie2 headers are filtered on same-origin redirect', async (t) => {
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
      t.equal(secondRequestCookie, null, 'Cookie header filtered before same-origin redirect');
      t.equal(secondRequestCookie2, null, 'Cookie2 header filtered before same-origin redirect');
    } finally {
      await server.close();
    }
  });
});
describe('AbortSignal', () => {
  it('pre-aborted signal rejects immediately', async (t) => {
    const signal = AbortSignal.abort();
    await withServer(
      () => new Response('never'),
      async (url) => {
        await t.rejects(() => fetch(url, { signal }), undefined, 'rejects with abort reason');
      },
    );
  });
  it('AbortSignal.timeout cancels a slow request', async (t) => {
    await withServer(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 2e3));
        return new Response('late');
      },
      async (url) => {
        const signal = AbortSignal.timeout(50);
        await t.rejects(() => fetch(url, { signal }), undefined, 'rejects when timeout fires');
      },
    );
  });
  it('AbortSignal fires after headers arrive but during body streaming', async (t) => {
    // The signal is created AFTER fetch starts, triggered mid-body so the
    // connection is already open. This tests that body streaming respects
    // cancellation and the connection is properly released.
    let controller!: AbortController;
    let releaseBody!: () => void;
    const bodyReleased = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const server = serveHttp({ port: 0 }, async () => {
      // Slow chunked body: send first chunk, then stall.
      async function* slowBody() {
        yield new TextEncoder().encode('first-chunk');
        await bodyReleased;
        yield new TextEncoder().encode('never-arrives');
      }
      // Transfer-Encoding: chunked enables true streaming (without it, serveHttp()
      // buffers the whole body to inject Content-Length, defeating the test).
      return new Response(slowBody() as any, { headers: { 'transfer-encoding': 'chunked' } });
    });
    try {
      controller = new AbortController();
      const fetchPromise = fetch(`http://127.0.0.1:${server.port}/`, { signal: controller.signal });
      const res = await fetchPromise;
      t.equal(res.status, 200, 'response headers received before abort');
      // Fire abort while reading the body.
      setTimeout(() => controller.abort(), 20);
      let threw = false;
      try {
        for await (const _ of res.body as unknown as AsyncIterable<Uint8Array>) {
        }
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
    for (const url of ['file:///tmp/fino-fetch.txt', 'javascript:alert(1)']) {
      await t.rejects(() => fetch(url), /non-HTTP\/S/i, `rejects ${url}`);
    }
  });
  it('accepts a Request object as input', async (t) => {
    await withServer(
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
    t.equal(res.type, 'basic', 'blob URL response type is basic');
    t.equal(res.headers.get('content-type'), 'text/plain', 'Blob type becomes Content-Type');
    URL.revokeObjectURL(url);
    await t.rejects(() => fetch(url), TypeError, 'revoked blob URL rejects');
  });
  it('supports single byte ranges for Blob object URLs', async (t) => {
    const url = URL.createObjectURL(
      new Blob(['A simple Hello, World! example'], { type: 'text/plain' }),
    );
    try {
      const res = await fetch(url, { headers: { range: 'bytes=9-21' } });
      t.equal(res.status, 206, 'range response is partial content');
      t.equal(res.type, 'basic', 'range response type is basic');
      t.equal(res.headers.get('content-type'), 'text/plain', 'Blob type is preserved');
      t.equal(res.headers.get('content-length'), '13', 'content length is range size');
      t.equal(res.headers.get('content-range'), 'bytes 9-21/30', 'content range is reported');
      t.equal(await res.text(), 'Hello, World!', 'body is sliced to the requested range');
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  it('rejects malformed Blob object URL ranges', async (t) => {
    for (const range of ['bytes=10-5', 'bytes=0-5,15-', 'bytes=-', 'bytes=100-']) {
      const url = URL.createObjectURL(new Blob(['Not much here'], { type: 'text/plain' }));
      try {
        await t.rejects(
          () => fetch(url, { headers: { range } }),
          TypeError,
          `invalid range ${range} rejects`,
        );
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  });
  it('fetches a Request created before its Blob object URL is revoked', async (t) => {
    const url = URL.createObjectURL(new Blob(['captured']));
    const request = new Request(url);
    URL.revokeObjectURL(url);
    t.equal(await (await fetch(request)).text(), 'captured', 'Request captured the Blob reference');
    t.equal(
      await (await fetch(request.clone())).text(),
      'captured',
      'cloned Request keeps the Blob reference',
    );
  });
  it('Host header is automatically set', async (t) => {
    let receivedHost: string | null = null;
    await withServer(
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
    await withServer(
      () => {
        const body = 'chunk1chunk2chunk3';
        return new Response(body, { headers: { 'transfer-encoding': 'chunked' } });
      },
      async (url) => {
        const text = await (await fetch(url)).text();
        t.equal(text, 'chunk1chunk2chunk3', 'chunked body assembled');
      },
    );
  });
  it('response.bytes() returns Uint8Array', async (t) => {
    await withServer(
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
    await withServer(
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
    await withServer(
      (req) => {
        seenModes.push(req.headers.get('origin') ?? 'no-origin');
        return new Response('visible body', { headers: { 'x-visible': 'yes' } });
      },
      async (url) => {
        const cors = await fetch(url, { mode: 'cors' });
        t.equal(cors.status, 200, 'cors mode returns normal response status');
        t.equal(cors.headers.get('x-visible'), 'yes', 'cors mode does not hide response headers');
        t.equal(
          await cors.text(),
          'visible body',
          'cors mode does not require CORS response headers',
        );
        const noCors = await fetch(url, { mode: 'no-cors' });
        t.equal(noCors.status, 200, 'no-cors mode returns normal response status');
        t.equal(
          noCors.headers.get('x-visible'),
          'yes',
          'no-cors mode does not produce opaque headers',
        );
        t.equal(
          await noCors.text(),
          'visible body',
          'no-cors mode does not produce an opaque body',
        );
        t.deepEqual(
          seenModes,
          ['no-origin', 'no-origin'],
          'mode options do not synthesize browser Origin headers',
        );
      },
    );
  });
  it('does not retain Set-Cookie or cache responses between fetch calls', async (t) => {
    let requestCount = 0;
    const cookies: Array<string | null> = [];
    await withServer(
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
        t.equal(
          await explicit.text(),
          'response-3',
          'explicit caller-provided cookie request succeeds',
        );
        t.equal(cookies[2], null, 'forbidden caller-provided Cookie header is filtered');
      },
    );
  });
  it('sends a streaming request body when duplex is half', async (t) => {
    let receivedBody = '';
    await withServer(
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
    await withServer(
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
        await fetch(url, {
          method: 'POST',
          body: 'original body',
        });
        t.equal(receivedBody, 'original body', '307 redirect preserves request body');
      },
    );
  });
  it('308 redirect preserves request body and method', async (t) => {
    let count = 0;
    let finalMethod: string | null = null;
    let receivedBody: string | null = null;
    await withServer(
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
        await fetch(url, {
          method: 'PATCH',
          body: 'patch data',
        });
        t.equal(finalMethod, 'PATCH', '308 preserves PATCH method');
        t.equal(receivedBody, 'patch data', '308 preserves request body');
      },
    );
  });
  it('redirect with relative Location header is followed', async (t) => {
    let count = 0;
    await withServer(
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
    await withServer(
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
          () =>
            fetch(url, {
              method: 'POST',
              body: body() as any,
              duplex: 'half',
            } as any),
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
    await t.rejects(() => fetch('not a valid url'), undefined, 'fetch with invalid URL rejects');
  });
  it('fetch with a blocked port throws TypeError before connecting', async (t) => {
    await t.rejects(
      () => fetch('http://127.0.0.1:25/'),
      TypeError,
      'blocked port rejects with TypeError',
    );
  });
});
describe('Compression', () => {
  it('sends Accept-Encoding header', async (t) => {
    let receivedEncoding: string | null = null;
    await withServer(
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
    await withServer(
      () => {
        const compressed = compress(new TextEncoder().encode(original), { format: 'gzip' });
        return new Response(compressed, {
          headers: {
            'content-type': 'text/plain',
            'content-encoding': 'gzip',
            'content-length': String(compressed.byteLength),
          },
        });
      },
      async (url) => {
        const res = await fetch(url);
        t.equal(res.headers.get('content-encoding'), null, 'content-encoding removed');
        t.equal(res.headers.get('content-length'), null, 'content-length removed');
        t.equal(await res.text(), original, 'body decompressed correctly');
      },
    );
  });
  it('user-set Accept-Encoding is filtered', async (t) => {
    let received: string | null = null;
    await withServer(
      (req) => {
        received = req.headers.get('accept-encoding');
        return new Response('ok');
      },
      async (url) => {
        await fetch(url, { headers: { 'accept-encoding': 'identity' } });
        t.ok(received, 'default Accept-Encoding is still sent');
        if (received === null) throw new Error('Accept-Encoding should be present');
        t.notEqual(received, 'identity', 'forbidden user Accept-Encoding is filtered');
        t.ok(received.includes('gzip'), 'default includes gzip');
      },
    );
  });
  it('uncompressed response passes through unchanged', async (t) => {
    await withServer(
      () => new Response('plain text'),
      async (url) => {
        t.equal(await (await fetch(url)).text(), 'plain text', 'uncompressed body unchanged');
      },
    );
  });
  it('HEAD response has no body (bodyless)', async (t) => {
    await withServer(
      () =>
        new Response('body content', {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'content-length': '12',
          },
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
    await withServer(
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
    await withServer(
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
    await withServer(
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
      () =>
        new Request('http://127.0.0.1/', {
          method: 'GET',
          body: 'hello',
        }),
      /body/i,
      'GET Request with body throws TypeError',
    );
  });
  it('Request constructor with HEAD body throws TypeError', (t) => {
    t.throws(
      () =>
        new Request('http://127.0.0.1/', {
          method: 'HEAD',
          body: 'hello',
        }),
      /body/i,
      'HEAD Request with body throws TypeError',
    );
  });
  it('GET request with body throws TypeError', async (t) => {
    await t.rejects(
      async () =>
        fetch('http://127.0.0.1:19824/', {
          method: 'GET',
          body: 'hello',
        }),
      /body/i,
      'GET with body throws TypeError',
    );
  });
  it('HEAD request with body throws TypeError', async (t) => {
    await t.rejects(
      async () =>
        fetch('http://127.0.0.1:19824/', {
          method: 'HEAD',
          body: 'hello',
        }),
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
describe('Response constructor validation', () => {
  it('validates status range and statusText bytes', (t) => {
    for (const status of [0, 100, 199, 600, 1e3]) {
      t.throws(
        () => new Response('', { status }),
        RangeError,
        `status ${status} is outside the Response constructor range`,
      );
    }
    for (const statusText of ['\n', 'Ā']) {
      t.throws(
        () => new Response('', { statusText }),
        TypeError,
        `statusText ${JSON.stringify(statusText)} is invalid`,
      );
    }
  });
  it('rejects bodies for null-body statuses', (t) => {
    for (const status of [204, 205, 304]) {
      t.throws(
        () => new Response('body', { status }),
        TypeError,
        `status ${status} cannot have a body`,
      );
      t.equal(new Response(null, { status }).body, null, `status ${status} accepts null body`);
    }
  });
  it('assigns default Content-Type for string bodies only when absent', (t) => {
    const response = new Response('body');
    t.equal(
      response.headers.get('content-type'),
      'text/plain;charset=UTF-8',
      'string body gets text/plain',
    );
    const overridden = new Response('body', { headers: { 'content-type': 'custom/type' } });
    t.equal(
      overridden.headers.get('content-type'),
      'custom/type',
      'explicit Content-Type is preserved',
    );
    const bytes = new Response(new Uint8Array());
    t.equal(
      bytes.headers.get('content-type'),
      null,
      'buffer body does not get a default Content-Type',
    );
  });
  it('keeps Response.error() as the status 0 network error special case', (t) => {
    const response = Response.error();
    t.equal(response.type, 'error', 'type is error');
    t.equal(response.status, 0, 'network error status remains 0');
    t.throws(() => response.headers.set('x-test', 'value'), TypeError, 'headers are immutable');
  });
  it('rejects locked or disturbed ReadableStream bodies', async (t) => {
    const locked = new ReadableStream();
    locked.getReader();
    t.throws(
      () => new Response(locked as any),
      TypeError,
      'locked response body stream is rejected',
    );
    const disturbed = new ReadableStream({
      pull: (controller) => controller.enqueue(new Uint8Array()),
    });
    const reader = disturbed.getReader();
    await reader.read();
    reader.releaseLock();
    t.throws(
      () => new Response(disturbed as any),
      TypeError,
      'disturbed response body stream is rejected',
    );
  });
  it('does not mark response bodyUsed merely by locking the stream', (t) => {
    const stream = new ReadableStream();
    const response = new Response(stream);
    const reader = stream.getReader();
    t.equal(response.bodyUsed, false, 'locking the stream is not disturbance');
    reader.cancel();
    t.equal(response.bodyUsed, true, 'canceling through the reader disturbs the stream');
  });
  it('marks response bodyUsed synchronously when piping starts', (t) => {
    const response = new Response(new ReadableStream());
    response.body!.pipeTo(new WritableStream({}, { highWaterMark: 0 })).catch(() => {});
    t.equal(response.bodyUsed, true, 'pipeTo disturbs the body synchronously');
  });
  it('does not observe Object.prototype.then while piping byte bodies', async (t) => {
    const originalThen = Object.prototype.then;
    const expected = new Uint8Array([1, 2, 3]);
    const injected = new Uint8Array([4, 5, 6]);
    const written: number[] = [];
    const writable = new WritableStream({
      write(chunk) {
        written.push(...Array.from(chunk));
      },
    });
    try {
      Object.prototype.then = function interceptedThen(resolve: (value: unknown) => void) {
        delete Object.prototype.then;
        resolve({
          done: false,
          value: injected,
        });
      };
      await new Response(expected).body!.pipeTo(writable);
      t.deepEqual(
        written,
        Array.from(expected),
        'byte body stream result is not thenable-intercepted',
      );
    } finally {
      if (originalThen === undefined) delete Object.prototype.then;
      else Object.prototype.then = originalThen;
    }
  });
  it('propagates response stream errors through formData before content-type rejection', async (t) => {
    const error = new Error('stream failed');
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      }),
    );
    await t.rejects(
      () => response.formData(),
      error,
      'stream error wins over unsupported content type',
    );
  });
});
async function readStringChunks(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return chunks;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}
describe('Body textStream', () => {
  it('streams Request and Response bodies as UTF-8 strings', async (t) => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello '));
          controller.enqueue(new TextEncoder().encode('world'));
          controller.close();
        },
      }),
    );
    t.equal(typeof response.textStream, 'function', 'Response exposes textStream');
    t.equal(response.bodyUsed, false, 'response starts unused');
    const responseStream = response.textStream();
    t.ok(responseStream instanceof ReadableStream, 'Response.textStream returns a ReadableStream');
    t.equal(response.bodyUsed, true, 'Response.textStream disturbs body immediately');
    t.equal(
      (await readStringChunks(responseStream)).join(''),
      'hello world',
      'response chunks decode as text',
    );
    const request = new Request('https://example.com/', {
      method: 'POST',
      body: 'hello world',
    });
    t.equal(typeof request.textStream, 'function', 'Request exposes textStream');
    const requestStream = request.textStream();
    t.equal(request.bodyUsed, true, 'Request.textStream disturbs body immediately');
    t.equal(
      (await readStringChunks(requestStream)).join(''),
      'hello world',
      'request chunks decode as text',
    );
  });
  it('returns fresh empty streams for null bodies without disturbing them', async (t) => {
    const response = new Response();
    const first = response.textStream();
    const second = response.textStream();
    t.notEqual(first, second, 'response null body returns fresh streams');
    t.equal(response.bodyUsed, false, 'response null body stays unused');
    t.deepEqual(await readStringChunks(first), [], 'first response stream is empty');
    t.deepEqual(await readStringChunks(second), [], 'second response stream is empty');
    const request = new Request('https://example.com/');
    const requestFirst = request.textStream();
    const requestSecond = request.textStream();
    t.notEqual(requestFirst, requestSecond, 'request null body returns fresh streams');
    t.equal(request.bodyUsed, false, 'request null body stays unused');
    t.deepEqual(await readStringChunks(requestFirst), [], 'first request stream is empty');
    t.deepEqual(await readStringChunks(requestSecond), [], 'second request stream is empty');
  });
  it('rejects consumed or locked bodies and always decodes as UTF-8', async (t) => {
    const consumedResponse = new Response('hello');
    await consumedResponse.text();
    t.throws(() => consumedResponse.textStream(), TypeError, 'consumed response rejects');
    const lockedResponse = new Response('hello');
    const reader = lockedResponse.body!.getReader();
    try {
      t.throws(() => lockedResponse.textStream(), TypeError, 'locked response rejects');
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array([104, 0, 105, 0]);
    const response = new Response(bytes, {
      headers: { 'content-type': 'text/plain; charset=utf-16le' },
    });
    t.equal(
      (await readStringChunks(response.textStream())).join(''),
      'h\0i\0',
      'charset is ignored for UTF-8 body text stream',
    );
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
  it('invalid method tokens throw', (t) => {
    for (const method of ['', 'IN VALID', 'GET\nX', 'POST()']) {
      t.throws(
        () => new Request('https://example.com/', { method }),
        TypeError,
        `${JSON.stringify(method)} is not an HTTP token`,
      );
    }
  });
});
describe('Request init validation', () => {
  it('rejects invalid and credentialed input URLs', (t) => {
    t.throws(() => new Request('http://:not a valid URL'), TypeError, 'invalid input URL throws');
    t.throws(
      () => new Request('http://user:pass@example.com/'),
      TypeError,
      'credentials in input URL throw',
    );
  });
  it('rejects invalid RequestInit enum values', (t) => {
    for (const option of [
      'referrerPolicy',
      'mode',
      'credentials',
      'cache',
      'redirect',
      'priority',
    ]) {
      t.throws(
        () => new Request('https://example.com/', { [option]: 'BAD' } as any),
        TypeError,
        `${option} rejects invalid values`,
      );
    }
  });
  it('accepts valid priority metadata and rejects invalid fetch priority before network', async (t) => {
    for (const priority of ['high', 'low', 'auto']) {
      new Request('https://example.com/', { priority } as any);
    }
    await t.rejects(
      () => fetch('http://127.0.0.1:19824/', { priority: 'invalid' as any }),
      TypeError,
      'invalid fetch priority rejects before connecting',
    );
  });
  it('rejects invalid RequestInit combinations', (t) => {
    t.throws(
      () => new Request('https://example.com/', { window: 'https://example.com/' } as any),
      TypeError,
      'window must be null when provided',
    );
    t.throws(
      () => new Request('https://example.com/', { mode: 'navigate' } as any),
      TypeError,
      'navigate mode is not allowed for constructed Requests',
    );
    t.throws(
      () =>
        new Request('https://example.com/', {
          mode: 'no-cors',
          method: 'PUT',
        } as any),
      TypeError,
      'no-cors accepts only simple methods',
    );
    t.throws(
      () =>
        new Request('https://example.com/', {
          mode: 'cors',
          cache: 'only-if-cached',
        } as any),
      TypeError,
      'only-if-cached requires same-origin mode',
    );
    new Request('test', {
      cache: 'only-if-cached',
      mode: 'same-origin',
    } as any);
  });
  it('rejects invalid referrer URLs', (t) => {
    t.throws(
      () => new Request('https://example.com/', { referrer: 'http://:not a valid URL' } as any),
      TypeError,
      'invalid referrer throws',
    );
  });
});
describe('Request header guards', () => {
  it('validates Headers constructor and lookup names', (t) => {
    t.throws(() => new Headers(1 as any), TypeError, 'primitive init throws');
    const headers = new Headers();
    for (const name of ['invalidĀ', {} as any]) {
      t.throws(() => headers.get(name as any), TypeError, 'get validates header name');
      t.throws(() => headers.has(name as any), TypeError, 'has validates header name');
      t.throws(() => headers.delete(name as any), TypeError, 'delete validates header name');
    }
  });
  it('filters forbidden request headers from init and later mutations', (t) => {
    const request = new Request('https://example.com/', {
      headers: {
        Cookie: 'sid=1',
        'Content-Length': '4',
        'X-Allowed': 'yes',
      },
    });
    t.equal(request.headers.get('cookie'), null, 'Cookie is filtered from init headers');
    t.equal(
      request.headers.get('content-length'),
      null,
      'Content-Length is filtered from init headers',
    );
    t.equal(request.headers.get('x-allowed'), 'yes', 'ordinary headers remain');
    request.headers.set('Host', 'example.com');
    request.headers.set('Proxy-Test', 'value');
    request.headers.set('X-Other', 'ok');
    t.equal(request.headers.get('host'), null, 'Host mutation is ignored');
    t.equal(request.headers.get('proxy-test'), null, 'Proxy-* mutation is ignored');
    t.equal(request.headers.get('x-other'), 'ok', 'ordinary mutation remains');
  });
  it('filters no-cors request headers to the safelist', (t) => {
    const request = new Request('https://example.com/', {
      mode: 'no-cors',
      headers: {
        'Content-Type': 'potato',
        Potato: 'value',
        Accept: 'text/html',
      },
    } as any);
    t.equal(request.headers.get('content-type'), null, 'unsafe Content-Type is filtered from init');
    t.equal(request.headers.get('potato'), null, 'non-safelisted init header is filtered');
    t.equal(request.headers.get('accept'), 'text/html', 'safelisted init header remains');
    request.headers.set('Content-Type', 'text/plain;charset=UTF-8');
    request.headers.set('X-Other', 'blocked');
    t.equal(
      request.headers.get('content-type'),
      'text/plain;charset=UTF-8',
      'safelisted Content-Type mutation remains',
    );
    t.equal(request.headers.get('x-other'), null, 'non-safelisted mutation is ignored');
  });
  it('filters forbidden method override request headers', (t) => {
    const forbiddenNames = ['x-http-method-override', 'x-http-method', 'x-method-override'];
    for (const name of forbiddenNames) {
      const request = new Request('https://example.com/');
      request.headers.append(name, 'GET, track');
      t.equal(request.headers.get(name), null, `${name} with forbidden override is filtered`);
      request.headers.append(name, '"TRACE"');
      t.equal(request.headers.get(name), '"TRACE"', `${name} with quoted token remains`);
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
      keepalive: false,
    };
    for (const [name, value] of Object.entries(defaults)) {
      t.equal((req as any)[name], value, `${name} default`);
      try {
        (req as any)[name] = 'changed';
      } catch (_) {}
      t.equal((req as any)[name], value, `${name} is read-only`);
    }
    t.equal('priority' in req, false, 'priority remains internal');
    t.equal('internalpriority' in req, false, 'internalpriority remains internal');
    t.equal('blocking' in req, false, 'blocking remains internal');
  });
});
describe('Request disturbed state', () => {
  it('rejects constructing from a consumed request body', async (t) => {
    const consumed = new Request('https://example.com/', {
      method: 'POST',
      body: 'body',
    });
    await consumed.text();
    t.throws(() => new Request(consumed), TypeError, 'consumed input body cannot be reused');
  });
  it('transfers input request body to the constructed request', async (t) => {
    const input = new Request('https://example.com/', {
      method: 'POST',
      body: 'body',
    });
    const originalBody = input.body;
    const copy = new Request(input);
    t.equal(input.bodyUsed, true, 'input request is disturbed');
    t.equal(input.body, originalBody, 'input body object stays stable');
    t.notEqual(copy.body, originalBody, 'constructed request gets a distinct body');
    t.equal(await copy.text(), 'body', 'constructed request receives input body bytes');
  });
  it('does not disturb input request when construction fails', (t) => {
    const input = new Request('https://example.com/', {
      method: 'POST',
      body: 'body',
    });
    t.throws(() => new Request(input, { method: 'GET' }), TypeError, 'GET cannot inherit a body');
    t.equal(input.bodyUsed, false, 'failed method validation leaves body unused');
    t.throws(
      () => new Request(input, { method: 'CONNECT' }),
      TypeError,
      'forbidden method fails before body transfer',
    );
    t.equal(input.bodyUsed, false, 'forbidden method leaves body unused');
  });
  it('validates streaming request body init options', (t) => {
    t.throws(
      () =>
        new Request('https://example.com/', {
          method: 'POST',
          body: new ReadableStream() as any,
        }),
      TypeError,
      'stream body requires duplex half',
    );
    t.throws(
      () =>
        new Request('https://example.com/', {
          method: 'POST',
          body: new ReadableStream() as any,
          duplex: 'half',
          keepalive: true,
        } as any),
      TypeError,
      'keepalive cannot use stream body',
    );
    const locked = new ReadableStream();
    locked.getReader();
    t.throws(
      () =>
        new Request('https://example.com/', {
          method: 'POST',
          body: locked as any,
          duplex: 'half',
        } as any),
      TypeError,
      'locked stream body is rejected',
    );
  });
  it('rejects constructing from a request whose body stream was read and released', async (t) => {
    const input = new Request('https://example.com/', {
      method: 'POST',
      body: 'body',
    });
    const reader = input.body!.getReader();
    await reader.read();
    reader.releaseLock();
    t.throws(() => new Request(input), TypeError, 'released reader leaves request body disturbed');
  });
  it('rejects constructing from a request whose body stream is locked', (t) => {
    const input = new Request('https://example.com/', {
      method: 'POST',
      body: 'body',
    });
    input.body!.getReader();
    t.throws(() => new Request(input), TypeError, 'locked input body cannot be transferred');
    t.equal(input.bodyUsed, false, 'lock-only failure does not mark the input body used');
  });
  it('fetching a Request synchronously consumes its non-empty body', async (t) => {
    const input = new Request('http://127.0.0.1:9/', {
      method: 'POST',
      body: 'body',
    });
    fetch(input).catch(() => {});
    t.equal(input.bodyUsed, true, 'fetch marks the request body used before network completion');
    await t.rejects(
      () => input.text(),
      TypeError,
      'body reader rejects after fetch consumes the request',
    );
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
    const srv = serveHttp(
      {
        port: 0,
        hostname: '127.0.0.1',
      },
      () => new Response(body),
    );
    const url = `http://127.0.0.1:${srv.port}`;
    try {
      const res = await fetch(url, { integrity: `sha256-${b64}` });
      t.equal(await res.text(), body, 'body text matches after integrity check');
    } finally {
      await srv.close();
    }
  });
  it('integrity check fails for wrong hash', async (t) => {
    const srv = serveHttp(
      {
        port: 0,
        hostname: '127.0.0.1',
      },
      () => new Response('hello integrity'),
    );
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
    const srv = serveHttp(
      {
        port: 0,
        hostname: '127.0.0.1',
      },
      (req) => {
        receivedReferer = req.headers.get('referer');
        return new Response(receivedReferer ?? '');
      },
    );
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
    const srv = serveHttp(
      {
        port: 0,
        hostname: '127.0.0.1',
      },
      (req) => {
        receivedReferer = req.headers.get('referer');
        return new Response(receivedReferer ?? '');
      },
    );
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
    const srv = serveHttp(
      { port: 0 },
      () =>
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
    const srv = serveHttp(
      { port: 0 },
      () =>
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
