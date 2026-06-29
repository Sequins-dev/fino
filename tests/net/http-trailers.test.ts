/**
* HTTP/1.1 and HTTP/2 trailer tests.
*/
import { describe, it } from 'fino:test/test';
import { serveHttp } from 'fino:net/http/server';
import { Socket } from 'fino:net/socket';
import { h2Available } from '../../js/net/http/h2.ts';
const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);
async function rawRoundtrip(port: number, rawRequest: string): Promise<string> {
  const sock = await Socket.connect({
    family: 'ipv4',
    ip: '127.0.0.1',
    port
  });
  const [reader, writer] = sock.split();
  await writer.write(encodeUtf8(rawRequest));
  writer.close();
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  reader.close();
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const all = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    all.set(c, pos);
    pos += c.byteLength;
  }
  return decodeUtf8(all);
}
// ---------------------------------------------------------------------------
// Response trailers — server sends them, client reads via res.trailers
// ---------------------------------------------------------------------------
describe('Response trailers — h1 server', () => {
  it('server sends response with static Headers trailer', async (t) => {
    const trailerHeaders = new Headers({ 'x-checksum': 'abc123' });
    const server = serveHttp({ port: 0 }, async (_req) => {
      return new Response('hello', { trailers: trailerHeaders });
    });
    const port = server.port;
    const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const resp = await rawRoundtrip(port, raw);
    t.ok(resp.includes('transfer-encoding: chunked'), 'TE header forced chunked');
    t.ok(!resp.includes('content-length'), 'no content-length when trailers set');
    t.ok(resp.includes('x-checksum: abc123'), 'trailer header present in body');
    await server.close();
  });
  it('server sends response with lazy trailer function', async (t) => {
    const server = serveHttp({ port: 0 }, async (_req) => {
      return new Response('world', { trailers: () => new Headers({ 'x-hash': 'deadbeef' }) });
    });
    const port = server.port;
    const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const resp = await rawRoundtrip(port, raw);
    t.ok(resp.includes('transfer-encoding: chunked'), 'TE header forced chunked');
    t.ok(resp.includes('x-hash: deadbeef'), 'lazy trailer header present');
    await server.close();
  });
  it('async trailer function is awaited before wire emit', async (t) => {
    const server = serveHttp({ port: 0 }, async (_req) => {
      return new Response('data', { trailers: async () => {
        // Simulate async computation (e.g. signing the body)
        return new Headers({ 'x-sig': 'async-sig' });
      } });
    });
    const port = server.port;
    const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const resp = await rawRoundtrip(port, raw);
    t.ok(resp.includes('x-sig: async-sig'), 'async trailer resolved and emitted');
    await server.close();
  });
});
// ---------------------------------------------------------------------------
// Response trailers — client reads them via res.trailers
// ---------------------------------------------------------------------------
describe('Response trailers — client fetch()', () => {
  it('fetch() resolves res.trailers after body consumed', async (t) => {
    const server = serveHttp({ port: 0 }, async (_req) => {
      return new Response('payload', { trailers: new Headers({ 'x-trailer': 'present' }) });
    });
    const port = server.port;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    await res.text();
    const trailers = await res.trailers;
    t.equal(trailers.get('x-trailer'), 'present', 'trailer header received by client');
    await server.close();
  });
  it('res.trailers resolves to empty Headers when no trailers sent', async (t) => {
    const server = serveHttp({ port: 0 }, async (_req) => {
      return new Response('plain');
    });
    const port = server.port;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    await res.text();
    const trailers = await res.trailers;
    t.ok(trailers instanceof Headers, 'trailers is Headers');
    t.equal([...trailers.entries()].length, 0, 'no trailer entries');
    await server.close();
  });
});
// ---------------------------------------------------------------------------
// Request trailers — client sends them, server reads via req.trailers
// ---------------------------------------------------------------------------
describe('Request trailers — h1', () => {
  it('server receives request trailers from raw chunked upload', async (t) => {
    let capturedTrailers: Headers | null = null;
    const server = serveHttp({ port: 0 }, async (req) => {
      const body = await req.text();
      capturedTrailers = await req.trailers;
      return new Response(`body=${body}`);
    });
    const port = server.port;
    // Manually craft a chunked request with trailers.
    const raw = `POST / HTTP/1.1\r\n` + `Host: localhost:${port}\r\n` + `Transfer-Encoding: chunked\r\n` + `Trailer: x-request-id\r\n` + `Connection: close\r\n` + `\r\n` + `5\r\n` + `hello\r\n` + `0\r\n` + `x-request-id: req-42\r\n` + `\r\n`;
    const resp = await rawRoundtrip(port, raw);
    t.ok(resp.includes('200'), 'server responded 200');
    t.ok(resp.includes('body=hello'), 'server received body');
    t.equal(capturedTrailers?.get('x-request-id'), 'req-42', 'server got request trailer');
    await server.close();
  });
  it('fetch() sends request with trailers via static Headers', async (t) => {
    let capturedTrailers: Headers | null = null;
    const server = serveHttp({ port: 0 }, async (req) => {
      const body = await req.text();
      capturedTrailers = await req.trailers;
      return new Response(`body=${body}`);
    });
    const port = server.port;
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      body: 'upload-data',
      trailers: new Headers({ 'x-sent-trailer': 'value1' })
    } as any);
    const text = await res.text();
    t.ok(text.includes('upload-data'), 'body received');
    t.equal(capturedTrailers?.get('x-sent-trailer'), 'value1', 'server got trailer sent by client');
    await server.close();
  });
});
// ---------------------------------------------------------------------------
// Wire format: confirm chunked framing and trailer block structure
// ---------------------------------------------------------------------------
describe('Trailer wire format', () => {
  it('chunked body + trailers terminates with 0\\r\\n<trailers>\\r\\n', async (t) => {
    const server = serveHttp({ port: 0 }, async (_req) => {
      return new Response('abc', { trailers: new Headers({ 'x-end': 'yes' }) });
    });
    const port = server.port;
    const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const resp = await rawRoundtrip(port, raw);
    // After header + CRLF, find the chunked body section.
    // Should contain "3\r\nabc\r\n0\r\nx-end: yes\r\n\r\n"
    t.ok(resp.includes('3\r\nabc\r\n0\r\n'), 'chunked body frame correct');
    t.ok(resp.includes('x-end: yes\r\n\r\n'), 'trailer block terminates with CRLF');
    await server.close();
  });
  it('response without trailers uses standard 0\\r\\n\\r\\n terminal', async (t) => {
    const server = serveHttp({ port: 0 }, async (_req) => {
      return new Response(null, { headers: { 'transfer-encoding': 'chunked' } });
    });
    const port = server.port;
    const raw = `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`;
    const resp = await rawRoundtrip(port, raw);
    t.ok(resp.includes('0\r\n\r\n'), 'standard terminal chunk present');
    await server.close();
  });
});
// ---------------------------------------------------------------------------
// Step 9 — HTTP/2 trailer cases
// ---------------------------------------------------------------------------
// H2 preface + empty SETTINGS frame
const _H2_PREFACE = new Uint8Array([
  80,
  82,
  73,
  32,
  42,
  32,
  72,
  84,
  84,
  80,
  47,
  50,
  46,
  48,
  13,
  10,
  13,
  10,
  83,
  77,
  13,
  10,
  13,
  10
]);
const _H2_SETTINGS_EMPTY = new Uint8Array([
  0,
  0,
  0,
  4,
  0,
  0,
  0,
  0,
  0
]);
// HEADERS: POST / (stream 1, END_HEADERS only — body+trailers follow)
const _H2_POST_HEADERS = new Uint8Array([
  0,
  0,
  14,
  1,
  4,
  0,
  0,
  0,
  1,
  131,
  132,
  134,
  65,
  9,
  108,
  111,
  99,
  97,
  108,
  104,
  111,
  115,
  116
]);
// DATA: "hello" on stream 1 (no END_STREAM)
const _H2_DATA_HELLO = new Uint8Array([
  0,
  0,
  5,
  0,
  0,
  0,
  0,
  0,
  1,
  104,
  101,
  108,
  108,
  111
]);
// HEADERS: trailer "x-trailer: test-value" on stream 1 (END_STREAM | END_HEADERS)
// HPACK: literal no-index new name
const _H2_TRAILER_HEADERS = new Uint8Array([
  0,
  0,
  22,
  1,
  5,
  0,
  0,
  0,
  1,
  0,
  9,
  120,
  45,
  116,
  114,
  97,
  105,
  108,
  101,
  114,
  10,
  116,
  101,
  115,
  116,
  45,
  118,
  97,
  108,
  117,
  101
]);
// HEADERS: GET / (stream 1, END_STREAM | END_HEADERS) — for response-trailer test
const _H2_GET_HEADERS = new Uint8Array([
  0,
  0,
  14,
  1,
  5,
  0,
  0,
  0,
  1,
  130,
  132,
  134,
  65,
  9,
  108,
  111,
  99,
  97,
  108,
  104,
  111,
  115,
  116
]);
async function h2RawRoundTrip(port: number, ...frames: Uint8Array[]): Promise<Uint8Array> {
  const sock = await Socket.connect({
    family: 'ipv4',
    ip: '127.0.0.1',
    port
  });
  const [reader, writer] = sock.split();
  const total = [
    _H2_PREFACE,
    _H2_SETTINGS_EMPTY,
    ...frames
  ].reduce((n, f) => n + f.byteLength, 0);
  const all = new Uint8Array(total);
  let pos = 0;
  for (const f of [
    _H2_PREFACE,
    _H2_SETTINGS_EMPTY,
    ...frames
  ]) {
    all.set(f, pos);
    pos += f.byteLength;
  }
  await writer.write(all);
  writer.close();
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  reader.close();
  const totalOut = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(totalOut);
  let outPos = 0;
  for (const c of chunks) {
    out.set(c, outPos);
    outPos += c.byteLength;
  }
  return out;
}
describe('HTTP/2 trailers', () => {
  it('server sends response with outgoing trailers without crashing', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async (_req) => {
      return new Response('data', { trailers: new Headers({ 'x-checksum': 'abc123' }) });
    });
    const port = server.port;
    const raw = await h2RawRoundTrip(port, _H2_GET_HEADERS);
    await server.close();
    t.ok(raw.byteLength >= 9, `server sent ${raw.byteLength} bytes (at least 1 frame)`);
    // Response HEADERS frame contains :status 200 HPACK-encoded (0x88)
    let found200 = false;
    for (let i = 0; i < raw.byteLength; i++) {
      if (raw[i] === 136) {
        found200 = true;
        break;
      }
    }
    t.ok(found200, ':status 200 found in response');
  });
  it('handler reads incoming H2 request trailers via req.trailers', async (t) => {
    if (!h2Available) return;
    let capturedTrailer: string | null = null;
    const server = serveHttp({ port: 0 }, async (req) => {
      const body = await req.text();
      const trailers = await req.trailers;
      capturedTrailer = trailers.get('x-trailer');
      return new Response(`body=${body}`);
    });
    const port = server.port;
    // Send: POST HEADERS (no end-stream) → DATA "hello" (no end-stream) → trailer HEADERS
    await h2RawRoundTrip(port, _H2_POST_HEADERS, _H2_DATA_HELLO, _H2_TRAILER_HEADERS);
    await server.close();
    t.equal(capturedTrailer, 'test-value', 'handler received x-trailer from H2 trailer frame');
  });
  it('req.trailers resolves to empty Headers when no trailers sent over H2', async (t) => {
    if (!h2Available) return;
    let capturedSize = -1;
    const server = serveHttp({ port: 0 }, async (req) => {
      const trailers = await req.trailers;
      capturedSize = [...trailers.entries()].length;
      return new Response('ok');
    });
    const port = server.port;
    // GET request with END_STREAM — no trailer HEADERS frame
    await h2RawRoundTrip(port, _H2_GET_HEADERS);
    await server.close();
    t.equal(capturedSize, 0, 'req.trailers resolved to empty Headers');
  });
});
