
/**
 * Benchmarks for fino:net/http
 *
 * Run with: cargo run -- --bench benchmarks/http.bench.ts
 */

import {
  _buildResponseHead,
  _headerTokenList,
  _parseHeaders,
  _parseResponseLine,
} from '../../../js/net/http/index.ts';
import { bench } from 'fino:bench';

const encodeUtf8 = (input: string): Uint8Array => new TextEncoder().encode(input);

// Pre-encoded wire bytes for parsing benchmarks
const GET_SIMPLE    = encodeUtf8('GET /path HTTP/1.1\r\nHost: example.com\r\nAccept: */*\r\n\r\n');
const GET_HEADERS   = encodeUtf8('GET /path HTTP/1.1\r\nHost: example.com\r\nAccept: application/json\r\nAccept-Encoding: gzip, deflate\r\nUser-Agent: surge-bench/1.0\r\nConnection: keep-alive\r\nAuthorization: Bearer tok123\r\n\r\n');
const RESP_HEADERS  = encodeUtf8('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 0\r\nCache-Control: max-age=3600\r\nX-Request-Id: abc123\r\nVary: Accept-Encoding\r\n\r\n');

bench('Headers', (b) => {
  b.group('construction', (g) => {
    g.measure('empty',          () => new Headers());
    g.measure('from object 2',  () => new Headers({ 'content-type': 'text/html', 'x-custom': 'value' }));
    g.measure('from object 5',  () => new Headers({ 'content-type': 'application/json', 'cache-control': 'no-cache', 'x-request-id': 'abc', 'authorization': 'Bearer tok', 'accept': '*/*' }));
    g.measure('from entries',   () => new Headers([['content-type', 'text/html'], ['accept', '*/*']]));
  });

  b.group('get', (g) => {
    const h3  = new Headers({ 'content-type': 'text/html', 'accept': '*/*', 'cache-control': 'no-cache' });
    const h10 = new Headers(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`x-header-${i}`, `value${i}`])));
    g.measure('get first of 3',    () => h3.get('accept'));
    g.measure('get last of 3',     () => h3.get('cache-control'));
    g.measure('get middle of 10',  () => h10.get('x-header-5'));
    g.measure('get missing',       () => h3.get('x-nonexistent'));
  });

  b.group('set / append', (g) => {
    const h = new Headers({ 'content-type': 'text/html' });
    g.measure('set existing',  () => h.set('content-type', 'application/json'));
    g.measure('set new',       () => h.set('x-key', 'value'));
    g.measure('append',        { setup: () => new Headers(), fn: (h) => h.append('x-key', 'value') });
  });

  b.group('has / delete', (g) => {
    const h = new Headers({ 'content-type': 'text/html', 'accept': '*/*' });
    g.measure('has existing',  () => h.has('content-type'));
    g.measure('has missing',   () => h.has('x-none'));
    g.measure('delete',        { setup: () => new Headers({ 'content-type': 'text/html', 'accept': '*/*' }), fn: (h) => { h.append('x-tmp', 'v'); h.delete('x-tmp'); } });
  });

  b.group('iteration', (g) => {
    const h5  = new Headers(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`x-h${i}`, `v${i}`])));
    const h10 = new Headers(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`x-h${i}`, `v${i}`])));
    g.measure('for-of 5',  () => { for (const [k, v] of h5) { /* noop */ void k; void v; } });
    g.measure('for-of 10', () => { for (const [k, v] of h10) { /* noop */ void k; void v; } });
    g.measure('keys()',    () => { for (const k of h5.keys()) { /* noop */ void k; } });
    g.measure('values()',  () => { for (const v of h5.values()) { /* noop */ void v; } });
  });
});

bench('Request construction', (b) => {
  b.measure('simple GET',       () => new Request('https://example.com/path'));
  b.measure('GET with headers', () => new Request('https://example.com', { headers: { 'Authorization': 'Bearer tok', 'Accept': 'application/json' } }));
  b.measure('POST with body',   () => new Request('https://api.example.com/data', { method: 'POST', body: '{"hello":"world"}', headers: { 'Content-Type': 'application/json' } }));
  b.measure('copy Request',     { setup: () => new Request('https://example.com/path'), fn: (r) => new Request(r) });
});

bench('Response construction', (b) => {
  b.measure('null body 200',    () => new Response(null, { status: 200 }));
  b.measure('string body',      () => new Response('OK', { status: 200 }));
  b.measure('JSON body',        () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  b.measure('Response.json()',  () => Response.json({ hello: 'world' }));
  b.measure('Response.error()', () => Response.error());
  b.measure('404 with headers', () => new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain', 'X-Error': 'true' } }));
});

bench('HTTP header parsing helpers', (b) => {
  b.measure('request headers', () => _parseHeaders(GET_SIMPLE));
  b.measure('many request headers', () => _parseHeaders(GET_HEADERS));
  b.measure('response headers', () => _parseHeaders(RESP_HEADERS));
  b.measure('token list', () => _headerTokenList('keep-alive, upgrade'));
});

bench('HTTP response helpers', (b) => {
  b.measure('parse status line', () => _parseResponseLine('HTTP/1.1 200 OK'));
  b.measure('build response head', () => _buildResponseHead(new Response('ok', {
    headers: { 'content-type': 'text/plain' },
  })));
});

// Note: serializeRequest / serializeResponse return async iterables whose
// next() methods are async. Consuming them over thousands of iterations in
// the bench spin loop triggers a Boa GC assertion (promise allocation pressure).
// The header-building cost is partially captured by the Request/Response
// construction benchmarks above and by parseRequest/parseResponse round-trips.
// These will be re-enabled once the underlying Boa GC issue is fixed.

// Note: body consumption (req.text(), req.json(), res.text(), res.json()) uses
// `for await` internally in #consumeBody(), which triggers the same Boa GC
// assertion. Additionally, Request/Response bodies are single-use, so setup()
// returning the same object across iterations would fail after the first read.
// These will be re-enabled once the underlying Boa GC issue is fixed.
