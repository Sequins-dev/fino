/**
 * Tests for HTTP wire helpers, globals, and the HTTP/1.1 parser.
 */

import { describe, it } from 'fino:test/test';
import { parseRequest, parseResponse, serializeRequest, serializeResponse } from 'fino:net/http';
const encodeUtf8 = (s: string) => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView) => new TextDecoder().decode(b);

async function* source(str: string): AsyncIterable<Uint8Array> {
  yield encodeUtf8(str);
}

async function* chunkedSource(str: string, chunkSize: number): AsyncIterable<Uint8Array> {
  const bytes = encodeUtf8(str);
  let pos = 0;
  while (pos < bytes.byteLength) {
    const end = Math.min(pos + chunkSize, bytes.byteLength);
    yield bytes.subarray(pos, end);
    pos = end;
  }
}

async function collectBody(iter: AsyncIterable<Uint8Array> | AsyncIterable<ArrayBuffer> | null) {
  if (iter === null) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  for await (const chunk of iter) parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  if (parts.length === 0) return new Uint8Array(0);
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.byteLength; }
  return out;
}

describe('Headers', () => {
  it('empty constructor', (t) => {
    const h = new Headers();
    t.equal(h.get('x'), null, 'missing returns null');
    t.equal(h.has('x'), false);
  });

  it('construct from object', (t) => {
    const h = new Headers({ 'Content-Type': 'text/html', 'X-Foo': 'bar' });
    t.equal(h.get('content-type'), 'text/html', 'lowercased');
    t.equal(h.get('x-foo'), 'bar');
  });

  it('construct from entries array', (t) => {
    const h = new Headers([['Accept', 'text/html'], ['Accept', 'application/json']]);
    t.equal(h.get('accept'), 'text/html, application/json', 'multi-value joined');
  });

  it('append accumulates values', (t) => {
    const h = new Headers();
    h.append('set-cookie', 'a=1');
    h.append('set-cookie', 'b=2');
    t.equal(h.get('set-cookie'), 'a=1, b=2', 'joined for get()');
    const cookies = h.getSetCookie();
    t.equal(cookies.length, 2);
    t.equal(cookies[0], 'a=1');
    t.equal(cookies[1], 'b=2');
  });

  it('set replaces all values', (t) => {
    const h = new Headers([['x', '1'], ['x', '2']]);
    h.set('x', 'new');
    t.equal(h.get('x'), 'new', 'only one value remains');
  });

  it('has and delete', (t) => {
    const h = new Headers({ foo: 'bar' });
    t.equal(h.has('foo'), true);
    t.equal(h.has('FOO'), true, 'case-insensitive');
    h.delete('foo');
    t.equal(h.has('foo'), false, 'deleted');
    t.equal(h.get('foo'), null);
  });

  it('case-insensitive access', (t) => {
    const h = new Headers({ 'Content-Type': 'text/plain' });
    t.equal(h.get('content-type'), 'text/plain');
    t.equal(h.get('Content-Type'), 'text/plain');
    t.equal(h.get('CONTENT-TYPE'), 'text/plain');
    t.equal(h.has('CONTENT-TYPE'), true);
  });

  it('iteration is sorted by name', (t) => {
    const h = new Headers({ banana: '2', apple: '1', cherry: '3' });
    const names: string[] = [];
    for (const [name] of h) names.push(name);
    t.deepEqual(names, ['apple', 'banana', 'cherry'], 'sorted order');
  });

  it('keys, values, entries, forEach', (t) => {
    const h = new Headers({ b: '2', a: '1' });
    t.deepEqual([...h.keys()],    ['a', 'b']);
    t.deepEqual([...h.values()],  ['1', '2']);
    t.deepEqual([...h.entries()], [['a', '1'], ['b', '2']]);
    const seen: Array<[string, string]> = [];
    h.forEach((value, name) => seen.push([name, value]));
    t.deepEqual(seen, [['a', '1'], ['b', '2']]);
  });

  it('getSetCookie returns empty array when absent', (t) => {
    const h = new Headers({ 'content-type': 'text/html' });
    t.deepEqual(h.getSetCookie(), []);
  });

  it('empty name throws', (t) => {
    const h = new Headers();
    t.throws(() => h.append('', 'value'), null, 'empty name throws');
  });

  it('value with control chars throws', (t) => {
    const h = new Headers();
    t.throws(() => h.set('x', 'bad\nvalue'), null, 'newline in value throws');
    t.throws(() => h.set('x', 'bad\rvalue'), null, 'CR in value throws');
  });
});

describe('Request parsing basics', () => {
  it('GET request with no body', async (t) => {
    const req = await parseRequest(source(
      'GET /index.html HTTP/1.1\r\nHost: localhost\r\n\r\n'
    ));
    t.equal(req.method, 'GET');
    t.equal(req.url, 'http://localhost/index.html', 'url constructed from host + path');
    t.equal(req.version, 'HTTP/1.1');
    t.equal(req.headers.get('host'), 'localhost');
    const body = await collectBody(req.body);
    t.equal(body.byteLength, 0, 'no body');
  });

  it('GET with multiple headers', async (t) => {
    const req = await parseRequest(source(
      'GET / HTTP/1.1\r\nHost: example.com\r\nAccept: text/html\r\nConnection: keep-alive\r\n\r\n'
    ));
    t.equal(req.headers.get('host'), 'example.com');
    t.equal(req.headers.get('accept'), 'text/html');
    t.equal(req.headers.get('connection'), 'keep-alive');
  });

  it('POST request with Content-Length body', async (t) => {
    const bodyStr = 'hello=world';
    const req = await parseRequest(source(
      'POST /submit HTTP/1.1\r\nContent-Length: 11\r\nContent-Type: application/x-www-form-urlencoded\r\n\r\n' + bodyStr
    ));
    t.equal(req.method, 'POST');
    t.equal(req.url, '/submit', 'url is path when no host header');
    t.equal(req.headers.get('content-length'), '11');
    const data = await collectBody(req.body);
    t.equal(decodeUtf8(data), bodyStr);
  });

  it('header names are lowercased', async (t) => {
    const req = await parseRequest(source(
      'GET / HTTP/1.1\r\nContent-Type: text/plain\r\nX-Custom-Header: value\r\n\r\n'
    ));
    t.equal(req.headers.get('content-type'), 'text/plain');
    t.equal(req.headers.get('x-custom-header'), 'value');
  });

  it('header values are trimmed', async (t) => {
    const req = await parseRequest(source(
      'GET / HTTP/1.1\r\nHost:   example.com   \r\n\r\n'
    ));
    t.equal(req.headers.get('host'), 'example.com');
  });
});

describe('Chunked body', () => {
  it('POST request with chunked body', async (t) => {
    const raw =
      'POST /upload HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n' +
      '5\r\nhello\r\n' +
      '6\r\n world\r\n' +
      '0\r\n\r\n';
    const req = await parseRequest(source(raw));
    t.equal(req.method, 'POST');
    const data = await collectBody(req.body);
    t.equal(decodeUtf8(data), 'hello world');
  });

  it('chunked body with hex chunk sizes', async (t) => {
    const raw =
      'PUT /data HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n' +
      'a\r\n0123456789\r\n' +
      '0\r\n\r\n';
    const req = await parseRequest(source(raw));
    const data = await collectBody(req.body);
    t.equal(decodeUtf8(data), '0123456789');
  });

  it('chunked body split across tiny chunks', async (t) => {
    const raw =
      'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n' +
      '5\r\nhello\r\n0\r\n\r\n';
    const req = await parseRequest(chunkedSource(raw, 3));
    const data = await collectBody(req.body);
    t.equal(decodeUtf8(data), 'hello');
  });

  it('chunked body accepts extensions and parses trailers', async (t) => {
    const raw =
      'POST /upload HTTP/1.1\r\nTransfer-Encoding: gzip, chunked\r\n\r\n' +
      '5;sig=abc\r\nhello\r\n' +
      '0\r\nX-Checksum: ok\r\n\r\n';
    const req = await parseRequest(source(raw));
    t.equal(await req.text(), 'hello');
    const trailers = await req.trailers;
    t.equal(trailers.get('x-checksum'), 'ok');
  });

  it('invalid chunk sizes are rejected strictly', async (t) => {
    const req = await parseRequest(source(
      'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n' +
      '5x\r\nhello\r\n0\r\n\r\n'
    ));
    await t.rejects(() => req.text(), /Invalid chunk size/);
  });
});

describe('Small chunks', () => {
  it('headers split across 1-byte chunks', async (t) => {
    const raw = 'GET /slow HTTP/1.1\r\nHost: x\r\n\r\n';
    const req  = await parseRequest(chunkedSource(raw, 1));
    t.equal(req.method, 'GET');
    t.equal(req.url, 'http://x/slow');
    t.equal(req.headers.get('host'), 'x');
  });

  it('body split across 1-byte chunks', async (t) => {
    const raw = 'POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello';
    const req  = await parseRequest(chunkedSource(raw, 1));
    const data = await collectBody(req.body);
    t.equal(decodeUtf8(data), 'hello');
  });

  it('headers and body in a single chunk', async (t) => {
    const raw = 'POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc';
    const req  = await parseRequest(source(raw));
    const data = await collectBody(req.body);
    t.equal(decodeUtf8(data), 'abc');
  });
});

describe('Response parsing', () => {
  it('200 OK with Content-Length body', async (t) => {
    const res = await parseResponse(source(
      'HTTP/1.1 200 OK\r\nContent-Length: 13\r\nContent-Type: text/plain\r\n\r\nHello, World!'
    ));
    t.equal(res.version, 'HTTP/1.1');
    t.equal(res.status, 200);
    t.equal(res.statusText, 'OK');
    t.equal(res.ok, true);
    t.equal(res.headers.get('content-type'), 'text/plain');
    const data = await collectBody(res.body);
    t.equal(decodeUtf8(data), 'Hello, World!');
  });

  it('404 response', async (t) => {
    const res = await parseResponse(source(
      'HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found'
    ));
    t.equal(res.status, 404);
    t.equal(res.statusText, 'Not Found');
    t.equal(res.ok, false, '404 is not ok');
    const data = await collectBody(res.body);
    t.equal(decodeUtf8(data), 'Not Found');
  });

  it('204 No Content has empty body', async (t) => {
    const res = await parseResponse(source(
      'HTTP/1.1 204 No Content\r\n\r\n'
    ));
    t.equal(res.status, 204);
    const data = await collectBody(res.body);
    t.equal(data.byteLength, 0, 'no body for 204');
  });

  it('304 Not Modified has empty body', async (t) => {
    const res = await parseResponse(source(
      'HTTP/1.1 304 Not Modified\r\nETag: "abc123"\r\n\r\n'
    ));
    t.equal(res.status, 304);
    const data = await collectBody(res.body);
    t.equal(data.byteLength, 0, 'no body for 304');
  });

  it('response with chunked Transfer-Encoding', async (t) => {
    const raw =
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
      '4\r\nWiki\r\n' +
      '5\r\npedia\r\n' +
      '0\r\n\r\n';
    const res = await parseResponse(source(raw));
    t.equal(res.status, 200);
    const data = await collectBody(res.body);
    t.equal(decodeUtf8(data), 'Wikipedia');
  });

  it('response with EOF-delimited body', async (t) => {
    const res = await parseResponse(source(
      'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nstream of data'
    ));
    const data = await collectBody(res.body);
    t.equal(decodeUtf8(data), 'stream of data');
  });

  it('1xx response has no body', async (t) => {
    const res = await parseResponse(source(
      'HTTP/1.1 100 Continue\r\n\r\n'
    ));
    t.equal(res.status, 100);
    const data = await collectBody(res.body);
    t.equal(data.byteLength, 0);
  });
});

describe('Response parsing — edge cases', () => {
  it('headers only (no body, connection close) produces empty body', async (t) => {
    // An HTTP/1.0-style response with no Content-Length and no body —
    // just headers then the connection closes. The parser should return
    // an empty body, not hang waiting for bytes.
    const res = await parseResponse(source(
      'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n'
    ));
    t.equal(res.status, 200, 'status 200');
    const data = await collectBody(res.body);
    // EOF body: 0 bytes since the source ended after the headers.
    t.equal(data.byteLength, 0, 'empty body on headers-only response');
  });

  it('OPTIONS * request is parsed with pathname /*, not malformed URL', async (t) => {
    // RFC 7230 §5.3.4: asterisk-form is valid for OPTIONS.
    // The parser should construct a parseable URL (not throw).
    const req = await parseRequest(source(
      'OPTIONS * HTTP/1.1\r\nHost: example.com\r\n\r\n'
    ));
    t.equal(req.method, 'OPTIONS', 'method is OPTIONS');
    // The URL must be parseable (not throw on new URL(req.url))
    const url = new URL(req.url);
    t.equal(url.host, 'example.com', 'host preserved');
    t.ok(url.pathname.includes('*'), 'asterisk preserved in URL');
  });

  it('duplicate identical Content-Length values produce correct body length', async (t) => {
    const res = await parseResponse(source(
      'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\nhello'
    ));
    const data = await collectBody(res.body);
    t.equal(new TextDecoder().decode(data), 'hello', 'body correct with duplicate identical CL');
  });

  it('malformed header lines are rejected', async (t) => {
    await t.rejects(
      () => parseRequest(source('GET / HTTP/1.1\r\nBad-Header\r\n\r\n')),
      /malformed header/i,
    );
  });

  it('invalid Content-Length values are rejected strictly', async (t) => {
    await t.rejects(
      () => parseRequest(source('POST / HTTP/1.1\r\nContent-Length: 5x\r\n\r\nhello')),
      /invalid Content-Length/i,
    );
  });
});

describe('HTTP/1 release hardening corpus', () => {
  it('parses valid requests fragmented at every byte', async (t) => {
    const raw =
      'POST /fragmented HTTP/1.1\r\n' +
      'Host: example.test\r\n' +
      'Content-Length: 11\r\n' +
      '\r\n' +
      'hello world';
    const req = await parseRequest(chunkedSource(raw, 1));

    t.equal(req.method, 'POST');
    t.equal(req.url, 'http://example.test/fragmented');
    t.equal(await req.text(), 'hello world');
  });

  it('accepts chunk extensions and exposes trailers after body consumption', async (t) => {
    const raw =
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
      '5;name=value;flag\r\nhello\r\n' +
      '6;ignored=true\r\n world\r\n' +
      '0\r\nDigest: sha-256=test\r\nX-Trailer: ok\r\n\r\n';
    const res = await parseResponse(chunkedSource(raw, 2));

    t.equal(await res.text(), 'hello world');
    const trailers = await res.trailers;
    t.equal(trailers.get('digest'), 'sha-256=test');
    t.equal(trailers.get('x-trailer'), 'ok');
  });

  it('accepts duplicate identical Content-Length values for requests', async (t) => {
    const req = await parseRequest(source(
      'POST /dupe HTTP/1.1\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\nhello'
    ));

    t.equal(req.headers.get('content-length'), '5, 5');
    t.equal(await req.text(), 'hello');
  });

  it('uses chunked Transfer-Encoding precedence over Content-Length', async (t) => {
    const req = await parseRequest(source(
      'POST /te-cl HTTP/1.1\r\n' +
      'Content-Length: 999\r\n' +
      'Transfer-Encoding: gzip, chunked\r\n' +
      '\r\n' +
      '5\r\nhello\r\n0\r\n\r\nGET /smuggled HTTP/1.1\r\n\r\n'
    ));

    t.equal(req.headers.get('content-length'), null, 'Content-Length removed after TE precedence');
    t.equal(await req.text(), 'hello');
  });

  it('treats HEAD, 204, and 304 responses as bodyless despite framing', async (t) => {
    const head = await parseResponse(source(
      'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello'
    ), 'HEAD');
    const noContent = await parseResponse(source(
      'HTTP/1.1 204 No Content\r\nContent-Length: 5\r\n\r\nhello'
    ));
    const notModified = await parseResponse(source(
      'HTTP/1.1 304 Not Modified\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n'
    ));

    t.equal((await collectBody(head.body)).byteLength, 0, 'HEAD response has no body');
    t.equal((await collectBody(noContent.body)).byteLength, 0, '204 response has no body');
    t.equal((await collectBody(notModified.body)).byteLength, 0, '304 response has no body');
  });

  it('rejects malformed smuggling-style framing inputs', async (t) => {
    await t.rejects(
      () => parseRequest(source('POST / HTTP/1.1\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello!')),
      /Conflicting Content-Length/i,
    );

    await t.rejects(
      () => parseRequest(source('POST / HTTP/1.1\r\nTransfer-Encoding: chunked, gzip\r\n\r\n0\r\n\r\n')),
      /Invalid Transfer-Encoding/i,
    );

    const req = await parseRequest(source(
      'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n' +
      '5\r\nhello\n0\r\n\r\n'
    ));
    await t.rejects(() => req.text(), /Expected CRLF after chunk data/);
  });
});

describe('Response multi-chunk', () => {
  it('response headers split across chunks', async (t) => {
    const raw = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi';
    const res  = await parseResponse(chunkedSource(raw, 5));
    t.equal(res.status, 200);
    const data = await collectBody(res.body);
    t.equal(decodeUtf8(data), 'hi');
  });
});

describe('Edge cases', () => {
  it('request with no host falls back to path as url', async (t) => {
    const req = await parseRequest(source('GET / HTTP/1.0\r\n\r\n'));
    t.equal(req.url, '/');
    t.equal(req.version, 'HTTP/1.0');
  });

  it('headers with duplicate names are joined', async (t) => {
    const req = await parseRequest(source(
      'GET / HTTP/1.1\r\nAccept: text/html\r\nAccept: application/json\r\n\r\n'
    ));
    t.equal(req.headers.get('accept'), 'text/html, application/json');
  });

  it('Content-Length: 0 produces empty body', async (t) => {
    const req = await parseRequest(source(
      'POST / HTTP/1.1\r\nContent-Length: 0\r\n\r\n'
    ));
    const data = await collectBody(req.body);
    t.equal(data.byteLength, 0);
  });

  it('two parsed requests share no state', async (t) => {
    const req1 = await parseRequest(source('POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nfoo'));
    const req2 = await parseRequest(source('POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nbar'));
    t.equal(decodeUtf8(await collectBody(req1.body)), 'foo');
    t.equal(decodeUtf8(await collectBody(req2.body)), 'bar');
  });

  it('parseRequest returns a Request instance', async (t) => {
    const req = await parseRequest(source('GET / HTTP/1.1\r\n\r\n'));
    t.ok(req instanceof Request, 'instanceof Request');
  });

  it('parseResponse returns a Response instance', async (t) => {
    const res = await parseResponse(source('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
    t.ok(res instanceof Response, 'instanceof Response');
  });
});

describe('Body consumption', () => {
  it('req.text() consumes body as string', async (t) => {
    const req = await parseRequest(source('POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello'));
    t.equal(await req.text(), 'hello');
  });

  it('req.json() parses JSON body', async (t) => {
    const payload = '{"ok":true,"n":42}';
    const req = await parseRequest(source(
      'POST / HTTP/1.1\r\nContent-Length: ' + payload.length + '\r\n\r\n' + payload
    ));
    const obj = await req.json();
    t.equal(obj.ok, true);
    t.equal(obj.n, 42);
  });

  it('req.arrayBuffer() returns ArrayBuffer', async (t) => {
    const req = await parseRequest(source('POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc'));
    const ab = await req.arrayBuffer();
    t.ok(ab instanceof ArrayBuffer, 'instanceof ArrayBuffer');
    t.equal(ab.byteLength, 3);
  });

  it('req.bytes() returns Uint8Array', async (t) => {
    const req = await parseRequest(source('POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc'));
    const bytes = await req.bytes();
    t.ok(bytes instanceof Uint8Array, 'instanceof Uint8Array');
    t.equal(bytes.byteLength, 3);
  });

  it('bodyUsed is false before consumption', async (t) => {
    const req = await parseRequest(source('POST / HTTP/1.1\r\nContent-Length: 2\r\n\r\nhi'));
    t.equal(req.bodyUsed, false);
  });

  it('bodyUsed is true after text()', async (t) => {
    const req = await parseRequest(source('POST / HTTP/1.1\r\nContent-Length: 2\r\n\r\nhi'));
    await req.text();
    t.equal(req.bodyUsed, true);
  });

  it('second body consumption throws', async (t) => {
    const req = await parseRequest(source('POST / HTTP/1.1\r\nContent-Length: 2\r\n\r\nhi'));
    await req.text();
    await t.rejects(() => req.text(), null, 'second text() rejects');
  });

  it('body is null for bodyless request', async (t) => {
    const req = await parseRequest(source('GET / HTTP/1.1\r\n\r\n'));
    t.equal(req.body, null, 'body is null for GET with no body');
    t.equal(req.bodyUsed, false);
  });

  it('res.text() consumes response body', async (t) => {
    const res = await parseResponse(source(
      'HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\nHello, World!'
    ));
    t.equal(await res.text(), 'Hello, World!');
  });

  it('Request.clone() tees streaming bodies and copies headers independently', async (t) => {
    async function* streamBody() {
      yield encodeUtf8('hello ');
      yield encodeUtf8('world');
    }
    const req = new Request('https://example.test/upload', {
      method: 'POST',
      headers: { 'x-source': 'original' },
      body: streamBody() as any,
    });
    const clone = req.clone();

    clone.headers.set('x-source', 'clone');

    t.equal(req.headers.get('x-source'), 'original', 'original headers are independent');
    t.equal(clone.headers.get('x-source'), 'clone', 'clone headers are mutable');
    t.equal(await req.text(), 'hello world', 'original body remains readable');
    t.equal(await clone.text(), 'hello world', 'clone body is independently readable');
  });

  it('Response.clone() preserves buffered bodies and copies headers independently', async (t) => {
    const res = new Response('payload', {
      status: 202,
      statusText: 'Accepted',
      headers: { 'x-source': 'original' },
    });
    const clone = res.clone();

    clone.headers.set('x-source', 'clone');

    t.equal(res.status, 202, 'status preserved on original');
    t.equal(clone.status, 202, 'status preserved on clone');
    t.equal(res.statusText, 'Accepted', 'statusText preserved on original');
    t.equal(clone.statusText, 'Accepted', 'statusText preserved on clone');
    t.equal(res.headers.get('x-source'), 'original', 'original headers are independent');
    t.equal(clone.headers.get('x-source'), 'clone', 'clone headers are mutable');
    t.equal(await res.text(), 'payload', 'original body remains readable');
    t.equal(await clone.text(), 'payload', 'clone body is independently readable');
  });

  it('clone() rejects after request or response body consumption', async (t) => {
    const req = new Request('/submit', { method: 'POST', body: 'done' });
    await req.text();
    t.throws(() => req.clone(), /disturbed Request/i);

    const res = new Response('done');
    await res.text();
    t.throws(() => res.clone(), /disturbed Response/i);
  });

  it('formData() parses application/x-www-form-urlencoded bodies with duplicates', async (t) => {
    const req = new Request('/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: 'name=Alice+Smith&tag=one&tag=two&encoded=%E2%9C%93',
    });

    const form = await req.formData();

    t.equal(form.get('name'), 'Alice Smith', 'plus signs decode to spaces');
    t.deepEqual(form.getAll('tag'), ['one', 'two'], 'duplicate fields are preserved');
    t.equal(form.get('encoded'), '✓', 'percent-encoded UTF-8 decodes');
  });

  it('formData() rejects unsupported incoming content types', async (t) => {
    const res = new Response('raw', { headers: { 'content-type': 'application/json' } });
    await t.rejects(() => res.formData(), /unsupported content-type/i);
  });

  it('constructed FormData bodies serialize as multipart/form-data', async (t) => {
    const form = new FormData();
    form.append('name', 'Alice');
    form.append('tag', 'one');
    form.append('tag', 'two');

    const req = new Request('http://example.test/form', { method: 'POST', body: form });
    const contentType = req.headers.get('content-type') ?? '';
    const serialized = decodeUtf8(await collectBody(req.body));

    t.ok(contentType.startsWith('multipart/form-data; boundary='), 'content-type includes generated boundary');
    t.ok(serialized.includes('name="name"\r\n\r\nAlice'), 'string field is serialized');
    t.ok(serialized.includes('name="tag"\r\n\r\none'), 'first duplicate field is serialized');
    t.ok(serialized.includes('name="tag"\r\n\r\ntwo'), 'second duplicate field is serialized');
  });
});

describe('Request constructor', () => {
  it('new Request(url) — default GET with no body', async (t) => {
    const req = new Request('http://example.com/path');
    t.equal(req.method, 'GET');
    t.equal(req.url, 'http://example.com/path');
    t.equal(req.body, null);
    t.equal(req.bodyUsed, false);
    t.ok(req instanceof Request);
  });

  it('new Request(url, { method, body }) — POST with string body', async (t) => {
    const req = new Request('https://api.example.com/data', {
      method: 'POST',
      body: 'hello',
      headers: { 'content-type': 'text/plain' },
    });
    t.equal(req.method, 'POST');
    t.equal(req.url, 'https://api.example.com/data');
    t.equal(req.headers.get('content-type'), 'text/plain');
    t.equal(await req.text(), 'hello');
  });

  it('new Request(url, { body: Uint8Array })', async (t) => {
    const req = new Request('/', { method: 'PUT', body: encodeUtf8('abc') });
    t.equal(await req.text(), 'abc');
  });

  it('new Request(anotherRequest) copies url', (t) => {
    const original = new Request('http://example.com/foo');
    const copy = new Request(original);
    t.equal(copy.url, 'http://example.com/foo');
  });
});

describe('Response constructor', () => {
  it('new Response() — empty body, status 200', (t) => {
    const res = new Response(null);
    t.equal(res.status, 200);
    t.equal(res.statusText, '');
    t.equal(res.ok, true);
    t.equal(res.body, null);
    t.equal(res.type, 'default');
    t.equal(res.redirected, false);
    t.ok(res instanceof Response);
  });

  it('new Response(body, init) — string body', async (t) => {
    const res = new Response('world', { status: 201, statusText: 'Created' });
    t.equal(res.status, 201);
    t.equal(res.statusText, 'Created');
    t.equal(res.ok, true);
    t.equal(await res.text(), 'world');
  });

  it('new Response(body, { headers }) — headers copied', (t) => {
    const res = new Response(null, {
      status: 204,
      headers: { 'x-powered-by': 'fino' },
    });
    t.equal(res.headers.get('x-powered-by'), 'fino');
    t.equal(res.ok, true);
  });
});

describe('Response static methods', () => {
  it('Response.json() — serialises data and sets content-type', async (t) => {
    const res = Response.json({ hello: 'world' });
    t.equal(res.status, 200);
    t.equal(res.ok, true);
    t.equal(res.headers.get('content-type'), 'application/json');
    const obj = await res.json();
    t.equal(obj.hello, 'world');
  });

  it('Response.json() respects init status', (t) => {
    const res = Response.json({}, { status: 201 });
    t.equal(res.status, 201);
  });

  it('Response.redirect() — creates redirect response', (t) => {
    const res = Response.redirect('https://example.com/new', 301);
    t.equal(res.status, 301);
    t.equal(res.headers.get('location'), 'https://example.com/new');
    t.equal(res.body, null);
  });

  it('Response.redirect() — defaults to 302', (t) => {
    const res = Response.redirect('https://example.com');
    t.equal(res.status, 302);
  });

  it('Response.error() — creates error response', (t) => {
    const res = Response.error();
    t.equal(res.status, 0);
    t.equal(res.type, 'error');
    t.equal(res.ok, false);
  });
});

describe('Request.from / Response.from', () => {
  it('Request.from() parses from async iterable', async (t) => {
    const req = await Request.from(source('GET /hello HTTP/1.1\r\nHost: example.com\r\n\r\n'));
    t.ok(req instanceof Request);
    t.equal(req.method, 'GET');
    t.equal(req.url, 'http://example.com/hello');
  });

  it('Response.from() parses from async iterable', async (t) => {
    const res = await Response.from(source('HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok'));
    t.ok(res instanceof Response);
    t.equal(res.status, 201);
    t.equal(res.statusText, 'Created');
    t.equal(await res.text(), 'ok');
  });
});

describe('Serialization', () => {
  it('serializeResponse — status-line + headers + body', async (t) => {
    const res = new Response('hello', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/plain' },
    });
    (res as any)._version = 'HTTP/1.1';
    const bytes = await collectBody(serializeResponse(res));
    const text  = decodeUtf8(bytes);
    t.ok(text.startsWith('HTTP/1.1 200 OK\r\n'), 'status line correct');
    t.ok(text.includes('content-type: text/plain\r\n'), 'header present');
    t.ok(text.endsWith('\r\nhello'), 'body appended after blank line');
  });

  it('serializeResponse — null body emits only head', async (t) => {
    const res = new Response(null, { status: 204 });
    (res as any)._version = 'HTTP/1.1';
    const bytes = await collectBody(serializeResponse(res));
    const text  = decodeUtf8(bytes);
    t.ok(text.startsWith('HTTP/1.1 204'), 'status line');
    t.ok(text.endsWith('\r\n\r\n'), 'ends with blank line, no body');
  });

  it('serializeRequest — request-line + Host + headers + body (chunked)', async (t) => {
    const req = new Request('http://example.com/path', {
      method: 'POST',
      body: 'data',
      headers: { 'content-type': 'application/json' },
    });
    const bytes = await collectBody(serializeRequest(req));
    const text  = decodeUtf8(bytes);
    t.ok(text.startsWith('POST /path HTTP/1.1\r\n'), 'request line');
    t.ok(text.includes('host: example.com\r\n'), 'auto-injected Host header');
    t.ok(text.includes('transfer-encoding: chunked\r\n'), 'chunked framing injected');
    t.ok(text.includes('content-type: application/json\r\n'), 'custom header');
    t.ok(text.includes('4\r\ndata\r\n'), 'body chunk present');
    t.ok(text.endsWith('0\r\n\r\n'), 'terminal chunk present');
  });

  it('serializeRequest — GET has no body', async (t) => {
    const req = new Request('http://example.com/');
    const bytes = await collectBody(serializeRequest(req));
    const text  = decodeUtf8(bytes);
    t.ok(text.startsWith('GET / HTTP/1.1\r\n'), 'request line');
    t.ok(text.endsWith('\r\n\r\n'), 'ends with blank line, no body');
  });

  it('round-trip: serialize then parse request', async (t) => {
    const original = new Request('http://example.com/submit', {
      method: 'POST',
      body: 'hello=world',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const parsed = await Request.from(serializeRequest(original));
    t.equal(parsed.method, 'POST');
    t.equal(parsed.url, 'http://example.com/submit');
    t.equal(parsed.headers.get('content-type'), 'application/x-www-form-urlencoded');
    t.equal(await parsed.text(), 'hello=world');
  });

  it('round-trip: serialize then parse response', async (t) => {
    const original = Response.json({ status: 'ok' }, { status: 201 });
    (original as any)._version = 'HTTP/1.1';
    const parsed = await Response.from(serializeResponse(original));
    t.equal(parsed.status, 201);
    t.equal(parsed.headers.get('content-type'), 'application/json');
    const obj = await parsed.json();
    t.equal(obj.status, 'ok');
  });
});
