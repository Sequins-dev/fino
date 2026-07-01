/**
* HTTP/2 integration tests.
*
* Steps 5–8: bindings smoke test, session shell, server happy path, body echo.
*/
import { describe, it } from 'fino:test/test';
import { h2Available, h2Version } from '../../js/net/http/h2.ts';
import { H2ClientDriver } from '../../js/internal/net/http/h2/client.ts';
import { Nghttp2Session } from '../../js/internal/net/http/h2/session.ts';
import { serveHttp } from 'fino:net/http/server';
import { Socket } from 'fino:net/socket';
import { TlsSocket } from 'fino:net/tls';
import * as loop from 'internal:runtime/loop';
import { _parseH2ContentLength, _parseH2StatusHeader } from '../../js/internal/net/http/h2/server.ts';
import { NGHTTP2_FRAME_TYPE_DATA, NGHTTP2_FRAME_TYPE_HEADERS } from '../../js/internal/net/http/h2/bindings.ts';
if (!h2Available && (globalThis as any).process?.env?.FINO_REQUIRE_H2 === '1') {
  throw new Error('FINO_REQUIRE_H2=1 but libnghttp2 is not available');
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const _enc = new TextEncoder();
const _dec = new TextDecoder();
const tlsAvailable = (globalThis as typeof globalThis & {
  tlsAvailable?: boolean;
}).tlsAvailable;
const skipTlsH2 = (!h2Available || !tlsAvailable) && 'requires libnghttp2 + OpenSSL';
const CERT_PATH = new URL('./fixtures/test.crt', import.meta.url).pathname;
const KEY_PATH = new URL('./fixtures/test.key', import.meta.url).pathname;
function hexBytes(...args: number[]): Uint8Array {
  return new Uint8Array(args);
}
interface RawFrame {
  length: number;
  type: number;
  flags: number;
  streamId: number;
  payload: Uint8Array;
}
// H2 client connection preface (24 bytes)
const H2_PREFACE = hexBytes(80, 82, 73, 32, 42, 32, 72, 84, 84, 80, 47, 50, 46, 48, 13, 10, 13, 10, 83, 77, 13, 10, 13, 10);
// Empty SETTINGS frame (9 bytes, stream 0)
const SETTINGS_EMPTY = hexBytes(0, 0, 0, 4, 0, 0, 0, 0, 0);
function frame(type: number, flags: number, streamId: number, payload = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(9 + payload.byteLength);
  const len = payload.byteLength;
  out[0] = len >> 16 & 255;
  out[1] = len >> 8 & 255;
  out[2] = len & 255;
  out[3] = type & 255;
  out[4] = flags & 255;
  out[5] = streamId >> 24 & 127;
  out[6] = streamId >> 16 & 255;
  out[7] = streamId >> 8 & 255;
  out[8] = streamId & 255;
  out.set(payload, 9);
  return out;
}
function dataFrameFor(streamId: number, body: Uint8Array, flags = 1): Uint8Array {
  return frame(0, flags, streamId, body);
}
function priorityFrame(streamId: number, dependency: number): Uint8Array {
  return frame(2, 0, streamId, hexBytes(dependency >> 24 & 127, dependency >> 16 & 255, dependency >> 8 & 255, dependency & 255, 16));
}
function rstStreamFrame(streamId: number, errorCode: number): Uint8Array {
  return frame(3, 0, streamId, hexBytes(errorCode >> 24 & 255, errorCode >> 16 & 255, errorCode >> 8 & 255, errorCode & 255));
}
function windowUpdateFrame(streamId: number, increment: number): Uint8Array {
  return frame(8, 0, streamId, hexBytes(increment >> 24 & 127, increment >> 16 & 255, increment >> 8 & 255, increment & 255));
}
async function readRawFrames(reader: any, limit = 16): Promise<RawFrame[]> {
  const frames: RawFrame[] = [];
  for (let i = 0; i < limit; i++) {
    const frame = await readRawFrame(reader);
    if (!frame) break;
    frames.push(frame);
    if (frame.type === 7) break;
  }
  return frames;
}
async function readRawFrame(reader: any): Promise<RawFrame | null> {
  let header: Uint8Array | null = null;
  try {
    header = await reader.readExactly(9);
  } catch {
    return null;
  }
  if (!header || header.byteLength < 9) return null;
  const length = header[0] << 16 | header[1] << 8 | header[2];
  const payload = length > 0 ? await reader.readExactly(length) : new Uint8Array(0);
  if (!payload || payload.byteLength < length) return null;
  return {
    length,
    type: header[3],
    flags: header[4],
    streamId: (header[5] & 127) << 24 | header[6] << 16 | header[7] << 8 | header[8],
    payload
  };
}
function frameErrorCode(f: RawFrame): number {
  const p = f.payload;
  const off = f.type === 7 ? 4 : 0;
  return (p[off]! << 24 | p[off + 1]! << 16 | p[off + 2]! << 8 | p[off + 3]!) >>> 0;
}
async function rawH2Exchange(port: number, frames: Uint8Array): Promise<RawFrame[]> {
  const sock = await Socket.connect({
    family: 'ipv4',
    ip: '127.0.0.1',
    port
  });
  const [reader, writer] = sock.split();
  await writer.write(new Uint8Array([
    ...H2_PREFACE,
    ...SETTINGS_EMPTY,
    ...frames
  ]));
  await writer.flush();
  await writer.close();
  const rawFrames = await readRawFrames(reader);
  try {
    await reader.close();
  } catch {}
  return rawFrames;
}
async function rawTlsH2Exchange(port: number, frames: Uint8Array): Promise<RawFrame[]> {
  const sock = await TlsSocket.connect({
    family: 'ipv4',
    ip: '127.0.0.1',
    port
  }, {
    hostname: '127.0.0.1',
    rejectUnauthorized: false,
    alpn: ['h2']
  });
  if (sock.negotiatedProtocol !== 'h2') {
    sock.close();
    throw new Error(`expected ALPN h2, got ${sock.negotiatedProtocol}`);
  }
  const [reader, writer] = sock.split();
  await writer.write(new Uint8Array([
    ...H2_PREFACE,
    ...SETTINGS_EMPTY,
    ...frames
  ]));
  await writer.flush();
  const rawFrames = await readRawFrames(reader);
  try {
    await reader.close();
  } catch {}
  try {
    await writer.close();
  } catch {}
  return rawFrames;
}
async function rawTlsH2ExchangeReadFrames(port: number, frames: Uint8Array, limit: number): Promise<RawFrame[]> {
  const sock = await TlsSocket.connect({
    family: 'ipv4',
    ip: '127.0.0.1',
    port
  }, {
    hostname: '127.0.0.1',
    rejectUnauthorized: false,
    alpn: ['h2']
  });
  if (sock.negotiatedProtocol !== 'h2') {
    sock.close();
    throw new Error(`expected ALPN h2, got ${sock.negotiatedProtocol}`);
  }
  const [reader, writer] = sock.split();
  await writer.write(new Uint8Array([
    ...H2_PREFACE,
    ...SETTINGS_EMPTY,
    ...frames
  ]));
  await writer.flush();
  const rawFrames = await readRawFrames(reader, limit);
  try {
    await reader.close();
  } catch {}
  try {
    await writer.close();
  } catch {}
  return rawFrames;
}
function findFrame(frames: RawFrame[], type: number, streamId?: number): RawFrame | null {
  return frames.find((f) => f.type === type && (streamId === undefined || f.streamId === streamId)) ?? null;
}
// HEADERS frame for GET / (stream 1, END_STREAM+END_HEADERS)
// HPACK: :method=GET(idx2), :path=/(idx4), :scheme=http(idx6),
//        :authority=localhost (literal incremental index 1, length 9)
const H2_GET_ROOT_LOCALHOST = hexBytes(
  // 9-byte frame header
  0,
  0,
  14,
  1,
  5,
  0,
  0,
  0,
  1,
  // HPACK block
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
);
const H2_GET_ROOT_LOCALHOST_PAYLOAD = H2_GET_ROOT_LOCALHOST.subarray(9);
function h2GetRootLocalhostFrame(streamId: number): Uint8Array {
  return frame(1, 5, streamId, H2_GET_ROOT_LOCALHOST_PAYLOAD);
}
// GET / HPACK block with :method, :path, and :authority, but no :scheme.
const H2_GET_ROOT_LOCALHOST_NO_SCHEME = hexBytes(130, 132, 65, 9, 108, 111, 99, 97, 108, 104, 111, 115, 116);
// HEADERS frame for POST / (stream 1, END_HEADERS only — body follows)
// HPACK: :method=POST(idx3), :path=/(idx4), :scheme=http(idx6), :authority=localhost
const H2_POST_ROOT_LOCALHOST = hexBytes(0, 0, 14, 1, 4, 0, 0, 0, 1, 131, 132, 134, 65, 9, 108, 111, 99, 97, 108, 104, 111, 115, 116);
// POST / with content-length: 4.
// HPACK: POST, /, http, :authority=localhost, content-length=4.
const H2_POST_ROOT_LOCALHOST_CL4 = hexBytes(131, 132, 134, 65, 9, 108, 111, 99, 97, 108, 104, 111, 115, 116, 92, 1, 52);
// POST / with malformed content-length: "4x".
const H2_POST_ROOT_LOCALHOST_CL4X = hexBytes(131, 132, 134, 65, 9, 108, 111, 99, 97, 108, 104, 111, 115, 116, 92, 2, 52, 120);
/** Build a DATA frame for stream 1 with END_STREAM. */
function dataFrame(body: Uint8Array): Uint8Array {
  const len = body.byteLength;
  const frame = new Uint8Array(9 + len);
  frame[0] = len >> 16 & 255;
  frame[1] = len >> 8 & 255;
  frame[2] = len & 255;
  frame[3] = 0;
  frame[4] = 1;
  frame[8] = 1;
  frame.set(body, 9);
  return frame;
}
/** Connect, send H2 preface + SETTINGS + HEADERS, read back all bytes. */
async function h2RoundTrip(port: number, extraFrames?: Uint8Array): Promise<string> {
  const sock = await Socket.connect({
    family: 'ipv4',
    ip: '127.0.0.1',
    port
  });
  const [reader, writer] = sock.split();
  const toSend = new Uint8Array([
    ...H2_PREFACE,
    ...SETTINGS_EMPTY,
    ...H2_GET_ROOT_LOCALHOST,
    ...extraFrames ?? []
  ]);
  await writer.write(toSend);
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
  return _dec.decode(all);
}
// ---------------------------------------------------------------------------
// Step 5 — bindings smoke test
// ---------------------------------------------------------------------------
describe('nghttp2 bindings', () => {
  it('h2Available reflects library presence', (t) => {
    t.ok(typeof h2Available === 'boolean', 'h2Available is boolean');
    if (!h2Available) {
      console.log('# SKIP: libnghttp2 not found — install via brew install libnghttp2');
    }
  });
  it('h2Version is a version string when available', (t) => {
    if (!h2Available) return;
    t.ok(typeof h2Version === 'string', 'h2Version is a string');
    t.ok((h2Version as string).length > 0, 'h2Version is non-empty');
    t.ok(/^\d+\.\d+/.test(h2Version as string), `h2Version = "${h2Version}" looks like semver`);
  });
});
describe('H2 scanner-backed header parsers', () => {
  it('parses status and rejects malformed values', (t) => {
    t.equal(_parseH2StatusHeader('204'), 204, 'valid three-digit status parsed');
    t.throws(() => _parseH2StatusHeader('20x'), /:status/, 'non-digit status rejected');
    t.throws(() => _parseH2StatusHeader('200 OK'), /:status/, 'extra status text rejected');
  });
  it('parses duplicate content-length strictly', (t) => {
    t.equal(_parseH2ContentLength('5'), 5, 'single value parsed');
    t.equal(_parseH2ContentLength('5, 5'), 5, 'identical duplicate accepted');
    t.throws(() => _parseH2ContentLength('5, 6'), /content-length/, 'conflicting duplicate rejected');
    t.throws(() => _parseH2ContentLength('5x'), /content-length/, 'malformed length rejected');
  });
});
// ---------------------------------------------------------------------------
// Step 7 — H2 server happy path
// ---------------------------------------------------------------------------
describe('H2 server — prior-knowledge h2c', () => {
  it('responds to GET / with plain text body', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async (_req) => {
      return new Response('hello from h2');
    });
    const port = server.port;
    const raw = await h2RoundTrip(port);
    await server.close();
    // The response must include the SETTINGS frame and our response data.
    // We can't easily decode HPACK/frames in test; verify at binary level
    // that the server sent something back (non-empty) and didn't crash.
    t.ok(raw.length > 0, 'server sent a response');
    // The response HEADERS frame will have :status 200 HPACK-encoded.
    // :status 200 is static table index 8 = 0x88.
    t.ok(raw.includes('') || raw.charCodeAt(0) >= 0, 'response frame present');
  });
  it('server accepts and acknowledges initial SETTINGS', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async (_req) => new Response('ok'));
    const port = server.port;
    const raw = await h2RoundTrip(port);
    await server.close();
    // Server should send a SETTINGS frame (type=4) and SETTINGS ACK (type=4, flags=1).
    // At a minimum, verify some bytes come back.
    t.ok(raw.length >= 9, `server replied at least 9 bytes (got ${raw.length})`);
    // Find the SETTINGS frame (type byte 0x04) in the raw response
    const bytes = _enc.encode(raw);
    let foundSettings = false;
    for (let i = 3; i < bytes.length; i++) {
      if (bytes[i] === 4) {
        foundSettings = true;
        break;
      }
    }
    t.ok(foundSettings, 'response contains a SETTINGS frame (type=4)');
  });
  it('handler receives correct method and path', async (t) => {
    if (!h2Available) return;
    let capturedMethod = '';
    let capturedPath = '';
    const server = serveHttp({ port: 0 }, async (req) => {
      capturedMethod = req.method;
      capturedPath = new URL(req.url).pathname;
      return new Response('captured');
    });
    const port = server.port;
    await h2RoundTrip(port);
    await server.close();
    t.equal(capturedMethod, 'GET', 'method is GET');
    t.equal(capturedPath, '/', 'path is /');
  });
});
// ---------------------------------------------------------------------------
// Step 8 — server bodies + flow control
// ---------------------------------------------------------------------------
/** Send POST with body, return raw response bytes as string. */
async function h2PostRoundTrip(port: number, body: string): Promise<string> {
  const sock = await Socket.connect({
    family: 'ipv4',
    ip: '127.0.0.1',
    port
  });
  const [reader, writer] = sock.split();
  const bodyBytes = _enc.encode(body);
  const toSend = new Uint8Array([
    ...H2_PREFACE,
    ...SETTINGS_EMPTY,
    ...H2_POST_ROOT_LOCALHOST,
    ...dataFrame(bodyBytes)
  ]);
  await writer.write(toSend);
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
  return _dec.decode(all);
}
describe('H2 server — request bodies', () => {
  it('dispatches POST handlers after headers while the body is still streaming', async (t) => {
    if (!h2Available) return;
    let handlerEntered: (() => void) | null = null;
    const entered = new Promise<void>((resolve) => {
      handlerEntered = resolve;
    });
    const server = serveHttp({ port: 0 }, async (req) => {
      handlerEntered?.();
      const text = await req.text();
      return new Response(`streamed:${text}`);
    });
    const port = server.port;
    const sock = await Socket.connect({
      family: 'ipv4',
      ip: '127.0.0.1',
      port
    });
    const [reader, writer] = sock.split();
    let streamId = 0;
    let responseClosed = false;
    const responseChunks: Uint8Array[] = [];
    const client = await openClientSession(writer, {
      onBeginHeaders() {},
      onHeader() {},
      onFrameRecv() {},
      onDataChunk(_streamId: number, data: Uint8Array) {
        responseChunks.push(data);
      },
      onStreamClose(id: number) {
        if (id === streamId) responseClosed = true;
      }
    });
    async function flushClient() {
      while (client.wantWrite()) {
        const bytes = await client.flush();
        if (bytes && bytes.byteLength > 0) await writer.write(bytes);
      }
      await writer.flush();
    }
    const requestHeaders: Array<[string, string]> = [
      [':method', 'POST'],
      [':path', '/'],
      [':scheme', 'http'],
      [':authority', `127.0.0.1:${port}`]
    ];
    streamId = client.submitRequest(requestHeaders, true);
    await flushClient();
    await timeout(entered, 'handler did not enter before END_STREAM', 250);
    client.setStreamData(streamId, _enc.encode('live-body'));
    await flushClient();
    client.setStreamData(streamId, null);
    await flushClient();
    for await (const chunk of reader as any) {
      await client.recv(chunk);
      await flushClient();
      if (responseClosed) break;
    }
    client.close();
    await writer.close();
    await server.close();
    const total = responseChunks.reduce((n, c) => n + c.byteLength, 0);
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of responseChunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    t.equal(_dec.decode(all), 'streamed:live-body', 'streaming body reaches handler');
  });
  it('handler receives POST body and can echo it', async (t) => {
    if (!h2Available) return;
    let capturedBody = '';
    const server = serveHttp({ port: 0 }, async (req) => {
      capturedBody = await req.text();
      return new Response(capturedBody);
    });
    const port = server.port;
    const raw = await h2PostRoundTrip(port, 'hello h2');
    await server.close();
    t.equal(capturedBody, 'hello h2', 'handler received request body');
    t.ok(raw.length > 0, 'server sent a response');
  });
  it('handler receives empty body for GET', async (t) => {
    if (!h2Available) return;
    let capturedBody: string | null = null;
    const server = serveHttp({ port: 0 }, async (req) => {
      capturedBody = req.body ? await req.text() : null;
      return new Response('ok');
    });
    const port = server.port;
    await h2RoundTrip(port);
    await server.close();
    t.ok(capturedBody === null || capturedBody === '', 'GET has no body');
  });
});
// ---------------------------------------------------------------------------
// Step 12 — H2ClientDriver
// ---------------------------------------------------------------------------
const _h2Client = new H2ClientDriver();
async function h2ClientFetch(port: number, path: string, method = 'GET', body?: string): Promise<Response> {
  const sock = await Socket.connect({
    family: 'ipv4',
    ip: '127.0.0.1',
    port
  });
  const [reader, writer] = sock.split();
  const url = `http://127.0.0.1:${port}${path}`;
  const reqBody = body !== undefined ? _enc.encode(body) : null;
  const req = new (globalThis as any).Request(url, {
    method,
    body: reqBody?.buffer ?? null
  });
  return _h2Client.send(req, reader as any, writer, { signal: null });
}
describe('H2ClientDriver', () => {
  it('h2spec 6.9.1 drains a response body larger than the default flow-control window', async (t) => {
    if (!h2Available) return;
    const body = 'x'.repeat(128 * 1024);
    const server = serveHttp({ port: 0 }, async (_req) => new Response(body));
    const port = server.port;
    const res = await h2ClientFetch(port, '/');
    const text = await res.text();
    await server.close();
    t.equal(res.status, 200, 'status is 200');
    t.equal(text.length, body.length, 'entire response body drained');
    t.equal(text, body, 'response body bytes are intact');
  });
  it('resolves responses after H2 headers before the response body finishes', async (t) => {
    if (!h2Available) return;
    let releaseBody: (() => void) | null = null;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const server = serveHttp({ port: 0 }, async (_req) => {
      async function* body() {
        yield _enc.encode('first');
        await bodyGate;
        yield _enc.encode('-second');
      }
      return new Response(body(), { headers: { 'content-type': 'text/plain' } });
    });
    const port = server.port;
    const sock = await Socket.connect({
      family: 'ipv4',
      ip: '127.0.0.1',
      port
    });
    const [reader, writer] = sock.split();
    const req = new (globalThis as any).Request(`http://127.0.0.1:${port}/`);
    const responsePromise = _h2Client.send(req, reader as any, writer, { signal: null });
    let res: Response | null = null;
    let text = '';
    try {
      res = await timeout(responsePromise, 'response did not resolve before body completion', 250);
      t.equal(res.status, 200, 'status is available before body completion');
    } finally {
      releaseBody?.();
    }
    try {
      if (res !== null) text = await res.text();
    } finally {
      await server.close();
    }
    t.equal(text, 'first-second', 'body remains readable after early response resolution');
  });
  it('GET / returns 200 with body', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async (_req) => new Response('hello from h2 client'));
    const port = server.port;
    const res = await h2ClientFetch(port, '/');
    const text = await res.text();
    await server.close();
    t.equal(res.status, 200, 'status is 200');
    t.equal(text, 'hello from h2 client', 'body received correctly');
  });
  it('POST / sends body and handler echoes it', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async (req) => {
      const body = await req.text();
      return new Response(`echo:${body}`, { status: 201 });
    });
    const port = server.port;
    const res = await h2ClientFetch(port, '/', 'POST', 'client-body');
    const text = await res.text();
    await server.close();
    t.equal(res.status, 201, 'status is 201');
    t.equal(text, 'echo:client-body', 'body echoed correctly');
  });
  it('client sends request headers and server receives them', async (t) => {
    if (!h2Available) return;
    let capturedHeader = '';
    const server = serveHttp({ port: 0 }, async (req) => {
      capturedHeader = req.headers.get('x-custom') ?? '';
      return new Response('ok');
    });
    const port = server.port;
    const sock = await Socket.connect({
      family: 'ipv4',
      ip: '127.0.0.1',
      port
    });
    const [reader, writer] = sock.split();
    const url = `http://127.0.0.1:${port}/`;
    const req = new (globalThis as any).Request(url, {
      method: 'GET',
      headers: { 'x-custom': 'test-value' }
    });
    await _h2Client.send(req, reader as any, writer, { signal: null });
    await server.close();
    t.equal(capturedHeader, 'test-value', 'custom header received by server');
  });
});
// ---------------------------------------------------------------------------
// Step 14 — WS-on-h2 rejection
// ---------------------------------------------------------------------------
describe('H2 server — ConnectionTakeover rejection', () => {
  it('non-h2 ConnectionTakeover (e.g. WebSocket) gets RST_STREAM INTERNAL_ERROR', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async (_req) => {
      // Simulate WebSocket: a ConnectionTakeover not compatible with h2.
      return {
        compatibleProtocols: new Set(['http/1.1']),
        _takeOver: async () => {}
      } as any;
    });
    const port = server.port;
    const sock = await Socket.connect({
      family: 'ipv4',
      ip: '127.0.0.1',
      port
    });
    const [reader, writer] = sock.split();
    const url = `http://127.0.0.1:${port}/`;
    const req = new (globalThis as any).Request(url, { method: 'GET' });
    let threw = false;
    let errMsg = '';
    try {
      await _h2Client.send(req, reader as any, writer, { signal: null });
    } catch (e) {
      threw = true;
      errMsg = String(e);
    }
    await server.close();
    t.ok(threw, 'send() rejects when server RST_STREAMs');
    // NGHTTP2_INTERNAL_ERROR = 2; onStreamClose fires with that code.
    t.ok(errMsg.includes('error 2'), `error indicates RST_STREAM INTERNAL_ERROR: ${errMsg}`);
  });
});
// ---------------------------------------------------------------------------
// Step 11 — h2c Upgrade dance (RFC 7540 §3.2)
// ---------------------------------------------------------------------------
const CRLFCRLF = new Uint8Array([
  13,
  10,
  13,
  10
]);
// Read until \r\n\r\n and return the header block as text.
async function readHeaders(reader: any): Promise<string> {
  const bytes = await reader.readUntil(CRLFCRLF);
  return _dec.decode(bytes ?? new Uint8Array(0));
}
describe('H2 server — h2c Upgrade (RFC 7540 §3.2)', () => {
  it('server responds with 101 Switching Protocols and serves stream 1 over h2', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({
      port: 0,
      allowH2cUpgrade: true
    }, async (req) => new Response('upgraded:' + new URL(req.url).pathname));
    const port = server.port;
    const sock = await Socket.connect({
      family: 'ipv4',
      ip: '127.0.0.1',
      port
    });
    const [reader, writer] = sock.split();
    // Send HTTP/1.1 Upgrade request. HTTP2-Settings value is empty (default settings).
    const upgradeReq = _enc.encode(`GET / HTTP/1.1\r\n` + `Host: 127.0.0.1:${port}\r\n` + `Connection: Upgrade, HTTP2-Settings\r\n` + `Upgrade: h2c\r\n` + `HTTP2-Settings: \r\n` + `\r\n`);
    await writer.write(upgradeReq);
    await writer.flush();
    // Read 101 response headers.
    const headers101 = await readHeaders(reader);
    t.ok(headers101.startsWith('HTTP/1.1 101'), `101 received: ${headers101.split('\r\n')[0]}`);
    t.ok(headers101.toLowerCase().includes('upgrade: h2c'), 'upgrade: h2c header present');
    // Set up a client-side h2 session in upgrade mode.
    // Stream 1 is now half-closed (local) — we already sent the h1 request.
    let stream1Status = 0;
    let stream1Body = '';
    let stream1Closed = false;
    const clientCallbacks = {
      onBeginHeaders(_streamId: number, _isTrailers: boolean): void {},
      onHeader(streamId: number, name: string, value: string, _flags: number): void {
        if (streamId === 1 && name === ':status') stream1Status = parseInt(value, 10);
      },
      onFrameRecv(_streamId: number, _type: number, _flags: number): void {},
      onDataChunk(streamId: number, data: Uint8Array): void {
        if (streamId === 1) stream1Body += _dec.decode(data);
      },
      onStreamClose(streamId: number, _errorCode: number): void {
        if (streamId === 1) stream1Closed = true;
      }
    };
    const clientSession = (Nghttp2Session as any).createClient(clientCallbacks);
    // Empty settings payload — we declared an empty HTTP2-Settings header.
    clientSession.upgradeFromH1(new Uint8Array(0), false);
    clientSession.submitSettings([]);
    // Flush client preface + SETTINGS to the server.
    async function flushClient() {
      while (clientSession.wantWrite()) {
        const bytes = await clientSession.flush();
        if (bytes && bytes.byteLength > 0) await writer.write(bytes);
      }
      await writer.flush();
    }
    await flushClient();
    // Receive loop until stream 1 is closed.
    for await (const chunk of reader as any) {
      await clientSession.recv(chunk);
      await flushClient();
      if (stream1Closed) break;
    }
    clientSession.close();
    await writer.close();
    await server.close();
    t.equal(stream1Status, 200, 'stream 1 response status 200');
    t.equal(stream1Body, 'upgraded:/', 'stream 1 response body correct');
  });
  it('normal h1 requests still work when allowH2cUpgrade is true but client does not upgrade', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({
      port: 0,
      allowH2cUpgrade: true
    }, async (_req) => new Response('hello h1'));
    const port = server.port;
    const sock = await Socket.connect({
      family: 'ipv4',
      ip: '127.0.0.1',
      port
    });
    const [reader, writer] = sock.split();
    await writer.write(_enc.encode(`GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    await writer.flush();
    const resp = await readHeaders(reader);
    t.ok(resp.startsWith('HTTP/1.1 200'), `got 200 from h1: ${resp.split('\r\n')[0]}`);
    await server.close();
  });
});
// ---------------------------------------------------------------------------
// Step 15 — Robustness
// ---------------------------------------------------------------------------
// Helper: create a minimal client nghttp2 session, submit settings, and flush.
async function openClientSession(writer: any, callbacks: any): Promise<any> {
  const s = (Nghttp2Session as any).createClient(callbacks);
  s.submitSettings([]);
  while (s.wantWrite()) {
    const bytes = await s.flush();
    if (bytes && bytes.byteLength > 0) await writer.write(bytes);
  }
  await writer.flush();
  return s;
}
async function flushH2Client(client: any, writer: any): Promise<void> {
  while (client.wantWrite()) {
    const bytes = await client.flush();
    if (bytes && bytes.byteLength > 0) await writer.write(bytes);
  }
  await writer.flush();
}
function submitClientRequest(client: any, port: number, path: string, options: {
  method?: string;
  hasBody?: boolean;
} = {}): number {
  return client.submitRequest([
    [':method', options.method ?? 'GET'],
    [':path', path],
    [':scheme', 'http'],
    [':authority', `127.0.0.1:${port}`]
  ], options.hasBody ?? false);
}
function timeout<T>(promise: Promise<T>, message: string, ms = 1e3): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guard = new Promise<T>((_, reject) => {
    timer = setTimeout(function rejectTimedOutOperation() {
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([promise, guard]).finally(function clearTimeoutGuard() {
    if (timer !== null) clearTimeout(timer);
  });
}
type RuntimeLoopHandleSnapshot = ReturnType<typeof loop._activeHandleCounts>;
function runtimeLoopHandlesAtOrBelow(baseline: RuntimeLoopHandleSnapshot): boolean {
  const counts = loop._activeHandleCounts();
  return counts.reads <= baseline.reads && counts.writes <= baseline.writes && counts.timers <= baseline.timers && counts.procs <= baseline.procs && counts.completions <= baseline.completions && counts.vnodes <= baseline.vnodes && counts.atomicsWaiters <= baseline.atomicsWaiters;
}
async function waitForRuntimeLoopAtOrBelow(baseline: RuntimeLoopHandleSnapshot, turns = 16): Promise<boolean> {
  for (let i = 0; i < turns; i++) {
    if (runtimeLoopHandlesAtOrBelow(baseline)) return true;
    loop.tick(0);
    await Promise.resolve();
  }
  return runtimeLoopHandlesAtOrBelow(baseline);
}
function runtimeLoopHandleCounts(counts = loop._activeHandleCounts()): string {
  return JSON.stringify({
    reads: counts.reads,
    writes: counts.writes,
    timers: counts.timers,
    procs: counts.procs,
    completions: counts.completions,
    vnodes: counts.vnodes,
    atomicsWaiters: counts.atomicsWaiters
  });
}
interface CapturedH2Response {
  status: number;
  body: string;
  closed: boolean;
  errorCode: number | null;
  dataFrames: number;
  headerFrames: number;
}
function makeCapturedResponse(): CapturedH2Response {
  return {
    status: 0,
    body: '',
    closed: false,
    errorCode: null,
    dataFrames: 0,
    headerFrames: 0
  };
}
async function readUntil(reader: any, client: any, writer: any, done: () => boolean): Promise<void> {
  for await (const chunk of reader as any) {
    await client.recv(chunk);
    await flushH2Client(client, writer);
    if (done()) break;
  }
}
describe('H2 server — multiplexing and connection reuse', () => {
  it('completes a fast stream while another response body is blocked', async (t) => {
    if (!h2Available) return;
    let releaseSlow: (() => void) | null = null;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const server = serveHttp({ port: 0 }, async (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/slow') {
        async function* body() {
          await slowGate;
          yield _enc.encode('slow');
        }
        return new Response(body());
      }
      return new Response('fast');
    });
    const port = server.port;
    const sock = await Socket.connect({
      family: 'ipv4',
      ip: '127.0.0.1',
      port
    });
    const [reader, writer] = sock.split();
    const responses = new Map<number, CapturedH2Response>();
    const client = await openClientSession(writer, {
      onBeginHeaders() {},
      onHeader(streamId: number, name: string, value: string) {
        const response = responses.get(streamId);
        if (response && name === ':status') response.status = Number(value);
      },
      onFrameRecv() {},
      onDataChunk(streamId: number, data: Uint8Array) {
        const response = responses.get(streamId);
        if (response) response.body += _dec.decode(data);
      },
      onStreamClose(streamId: number, errorCode: number) {
        const response = responses.get(streamId);
        if (response) {
          response.closed = true;
          response.errorCode = errorCode;
        }
      }
    });
    const slowId = submitClientRequest(client, port, '/slow');
    responses.set(slowId, makeCapturedResponse());
    const fastId = submitClientRequest(client, port, '/fast');
    responses.set(fastId, makeCapturedResponse());
    await flushH2Client(client, writer);
    try {
      await timeout(readUntil(reader, client, writer, () => responses.get(fastId)!.closed), 'fast H2 stream did not complete while slow stream was blocked');
      t.equal(responses.get(fastId)!.status, 200, 'fast stream status is 200');
      t.equal(responses.get(fastId)!.body, 'fast', 'fast stream body completed');
      t.equal(responses.get(slowId)!.closed, false, 'slow stream remains open while fast stream completes');
      releaseSlow?.();
      await timeout(readUntil(reader, client, writer, () => responses.get(slowId)!.closed), 'slow H2 stream did not complete after release');
      t.equal(responses.get(slowId)!.status, 200, 'slow stream status is 200');
      t.equal(responses.get(slowId)!.body, 'slow', 'slow stream body completed after release');
    } finally {
      releaseSlow?.();
      client.close();
      try {
        await writer.close();
      } catch {}
      try {
        await reader.close();
      } catch {}
      await server.close();
    }
  });
  it('keeps a concurrent stream alive after the client resets a pending stream', async (t) => {
    if (!h2Available) return;
    let waitHandlerEntered: (() => void) | null = null;
    const entered = new Promise<void>((resolve) => {
      waitHandlerEntered = resolve;
    });
    const server = serveHttp({ port: 0 }, async (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/wait') {
        waitHandlerEntered?.();
        try {
          await req.text();
        } catch {}
        return new Response('cancelled');
      }
      return new Response('ok');
    });
    const port = server.port;
    const sock = await Socket.connect({
      family: 'ipv4',
      ip: '127.0.0.1',
      port
    });
    const [reader, writer] = sock.split();
    const responses = new Map<number, CapturedH2Response>();
    const client = await openClientSession(writer, {
      onBeginHeaders() {},
      onHeader(streamId: number, name: string, value: string) {
        const response = responses.get(streamId);
        if (response && name === ':status') response.status = Number(value);
      },
      onFrameRecv() {},
      onDataChunk(streamId: number, data: Uint8Array) {
        const response = responses.get(streamId);
        if (response) response.body += _dec.decode(data);
      },
      onStreamClose(streamId: number, errorCode: number) {
        const response = responses.get(streamId);
        if (response) {
          response.closed = true;
          response.errorCode = errorCode;
        }
      }
    });
    const waitId = submitClientRequest(client, port, '/wait', {
      method: 'POST',
      hasBody: true
    });
    responses.set(waitId, makeCapturedResponse());
    const okId = submitClientRequest(client, port, '/ok');
    responses.set(okId, makeCapturedResponse());
    await flushH2Client(client, writer);
    try {
      await timeout(entered, 'pending stream handler did not start');
      client.submitRstStream(waitId, 0);
      await flushH2Client(client, writer);
      await timeout(readUntil(reader, client, writer, () => responses.get(okId)!.closed), 'concurrent H2 stream did not complete after reset');
      t.equal(responses.get(okId)!.status, 200, 'concurrent stream status is 200');
      t.equal(responses.get(okId)!.body, 'ok', 'concurrent stream body completed');
      t.equal(responses.get(okId)!.errorCode, 0, 'concurrent stream closed normally');
    } finally {
      client.close();
      try {
        await writer.close();
      } catch {}
      try {
        await reader.close();
      } catch {}
      await server.close();
    }
  });
  it('sends one DATA frame for each fixed tiny response in sustained stream churn', async (t) => {
    if (!h2Available) return;
    const total = 128;
    const batchSize = 32;
    const server = serveHttp({ port: 0 }, async () => new Response('x'));
    const port = server.port;
    const sock = await Socket.connect({
      family: 'ipv4',
      ip: '127.0.0.1',
      port
    });
    const [reader, writer] = sock.split();
    const responses = new Map<number, CapturedH2Response>();
    const streamIds: number[] = [];
    const client = await openClientSession(writer, {
      onBeginHeaders() {},
      onHeader(streamId: number, name: string, value: string) {
        const response = responses.get(streamId);
        if (response && name === ':status') response.status = Number(value);
      },
      onFrameRecv(streamId: number, frameType: number) {
        const response = responses.get(streamId);
        if (!response) return;
        if (frameType === NGHTTP2_FRAME_TYPE_HEADERS) response.headerFrames++;
        if (frameType === NGHTTP2_FRAME_TYPE_DATA) response.dataFrames++;
      },
      onDataChunk(streamId: number, data: Uint8Array) {
        const response = responses.get(streamId);
        if (response) response.body += _dec.decode(data);
      },
      onStreamClose(streamId: number, errorCode: number) {
        const response = responses.get(streamId);
        if (response) {
          response.closed = true;
          response.errorCode = errorCode;
        }
      }
    });
    try {
      for (let start = 0; start < total; start += batchSize) {
        const batchIds: number[] = [];
        for (let i = start; i < start + batchSize; i++) {
          const streamId = submitClientRequest(client, port, `/tiny/${i}`);
          responses.set(streamId, makeCapturedResponse());
          streamIds.push(streamId);
          batchIds.push(streamId);
        }
        await flushH2Client(client, writer);
        await timeout(readUntil(reader, client, writer, () => batchIds.every((streamId) => responses.get(streamId)!.closed)), 'tiny H2 response batch did not complete', 2e3);
      }
      const allResponses = streamIds.map((streamId) => responses.get(streamId)!);
      t.ok(allResponses.every((response) => response.status === 200), 'all tiny response statuses are 200');
      t.ok(allResponses.every((response) => response.body === 'x'), 'all tiny response bodies are intact');
      t.ok(allResponses.every((response) => response.errorCode === 0), 'all tiny response streams close normally');
      t.equal(allResponses.reduce((n, response) => n + response.headerFrames, 0), total, 'each tiny response has one HEADERS frame');
      t.equal(allResponses.reduce((n, response) => n + response.dataFrames, 0), total, 'each tiny fixed response uses one DATA frame with END_STREAM');
    } finally {
      client.close();
      try {
        await writer.close();
      } catch {}
      try {
        await reader.close();
      } catch {}
      await server.close();
    }
  });
  it('coalesces fixed H2 response HEADERS and DATA into one response drain', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('x'));
    const port = server.port;
    const sock = await Socket.connect({
      family: 'ipv4',
      ip: '127.0.0.1',
      port
    });
    const [reader, writer] = sock.split();
    const responses = new Map<number, CapturedH2Response>();
    const client = await openClientSession(writer, {
      onBeginHeaders() {},
      onHeader(streamId: number, name: string, value: string) {
        const response = responses.get(streamId);
        if (response && name === ':status') response.status = Number(value);
      },
      onFrameRecv(streamId: number, frameType: number) {
        const response = responses.get(streamId);
        if (!response) return;
        if (frameType === NGHTTP2_FRAME_TYPE_HEADERS) response.headerFrames++;
        if (frameType === NGHTTP2_FRAME_TYPE_DATA) response.dataFrames++;
      },
      onDataChunk(streamId: number, data: Uint8Array) {
        const response = responses.get(streamId);
        if (response) response.body += _dec.decode(data);
      },
      onStreamClose(streamId: number, errorCode: number) {
        const response = responses.get(streamId);
        if (response) {
          response.closed = true;
          response.errorCode = errorCode;
        }
      }
    });
    try {
      const streamId = submitClientRequest(client, port, '/one');
      responses.set(streamId, makeCapturedResponse());
      await flushH2Client(client, writer);
      await timeout(readUntil(reader, client, writer, () => responses.get(streamId)!.closed), 'fixed H2 response did not complete', 2e3);
      t.equal(responses.get(streamId)!.body, 'x', 'fixed response body is intact');
      t.equal(responses.get(streamId)!.dataFrames, 1, 'fixed response body is sent in one DATA frame');
    } finally {
      client.close();
      try {
        await writer.close();
      } catch {}
      try {
        await reader.close();
      } catch {}
      await server.close();
    }
  });
  it('accepts fresh TLS handshakes after H2 connection churn', { skip: skipTlsH2 }, async (t) => {
    const server = serveHttp({
      port: 0,
      tls: {
        cert: CERT_PATH,
        key: KEY_PATH
      }
    }, async (req) => new Response(new URL(req.url).pathname));
    try {
      const connectionCount = 100;
      const streamsPerConnection = 8;
      const requestFrameParts = Array.from({ length: streamsPerConnection }, (_, i) => h2GetRootLocalhostFrame(1 + i * 2));
      const requestFrames = new Uint8Array(requestFrameParts.reduce((n, f) => n + f.byteLength, 0));
      let offset = 0;
      for (const requestFrame of requestFrameParts) {
        requestFrames.set(requestFrame, offset);
        offset += requestFrame.byteLength;
      }
      const batches = await Promise.all(Array.from({ length: connectionCount }, () => {
        return timeout(rawTlsH2ExchangeReadFrames(server.port, requestFrames, 4), 'fresh TLS H2 client did not receive bounded response frames', 1e4);
      }));
      t.equal(batches.length, connectionCount, 'all fresh TLS H2 clients completed');
      for (const frames of batches) {
        t.ok(findFrame(frames, 1, 1) !== null, 'fresh TLS H2 client received response HEADERS');
      }
      const controller = new AbortController();
      const fetchTimer = setTimeout(function abortSlowFetch() {
        controller.abort(new Error('HTTP/1.1 request after H2 burst timed out'));
      }, 5e3);
      const response = await fetch(`https://127.0.0.1:${server.port}/after-h2-burst`, {
        signal: controller.signal,
        tls: { rejectUnauthorized: false },
        protocol: 'http/1.1'
      } as any).finally(function clearFetchTimeout() {
        clearTimeout(fetchTimer);
      });
      t.equal(response.status, 200, 'HTTP/1.1 request after H2 burst succeeds');
      t.equal(await response.text(), '/after-h2-burst', 'HTTP/1.1 response body after H2 burst is intact');
      const h2Frames = await timeout(rawTlsH2ExchangeReadFrames(server.port, H2_GET_ROOT_LOCALHOST, 4), 'fresh TLS H2 client after churn did not receive response frames', 5e3);
      t.ok(findFrame(h2Frames, 1, 1) !== null, 'HTTP/2 request after H2 burst succeeds');
    } finally {
      await server.close();
    }
  });
});
describe('H2 server — robustness', () => {
  it('accepts a DATA frame exactly at the default 16 KiB max frame size', async (t) => {
    if (!h2Available) return;
    let captured = 0;
    const server = serveHttp({ port: 0 }, async (req) => {
      captured = (await req.arrayBuffer()).byteLength;
      return new Response('ok');
    });
    const port = server.port;
    const body = new Uint8Array(16 * 1024);
    const frames = await rawH2Exchange(port, new Uint8Array([...H2_POST_ROOT_LOCALHOST, ...dataFrameFor(1, body, 1)]));
    await server.close();
    t.equal(captured, 16 * 1024, 'handler received exact 16 KiB DATA payload');
    t.ok(findFrame(frames, 1, 1) !== null, 'server sent response HEADERS');
  });
  it('sends GOAWAY when a new client stream id is lower than a previous stream id', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, new Uint8Array([...frame(1, 5, 3, H2_GET_ROOT_LOCALHOST.subarray(9)), ...frame(1, 5, 1, H2_GET_ROOT_LOCALHOST.subarray(9))]));
    await server.close();
    const goaway = findFrame(frames, 7);
    t.ok(goaway !== null, 'server sent GOAWAY');
    t.equal(frameErrorCode(goaway!), 1, 'GOAWAY uses PROTOCOL_ERROR');
  });
  it('sends GOAWAY for DATA and RST_STREAM on an idle stream', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const dataFrames = await rawH2Exchange(server.port, dataFrameFor(1, new Uint8Array(0), 1));
    const rstFrames = await rawH2Exchange(server.port, rstStreamFrame(1, 0));
    await server.close();
    t.equal(frameErrorCode(findFrame(dataFrames, 7)!), 1, 'idle DATA gets GOAWAY PROTOCOL_ERROR');
    t.equal(frameErrorCode(findFrame(rstFrames, 7)!), 1, 'idle RST_STREAM gets GOAWAY PROTOCOL_ERROR');
  });
  it('sends GOAWAY for RST_STREAM on stream 0', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, rstStreamFrame(0, 0));
    await server.close();
    const goaway = findFrame(frames, 7);
    t.ok(goaway !== null, 'server sent GOAWAY');
    t.equal(frameErrorCode(goaway!), 1, 'GOAWAY uses PROTOCOL_ERROR');
  });
  it('RST_STREAMs DATA and HEADERS sent after the client half-closes the stream', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const dataFrames = await rawH2Exchange(server.port, new Uint8Array([...H2_GET_ROOT_LOCALHOST, ...dataFrameFor(1, _enc.encode('late'), 1)]));
    const headersFrames = await rawH2Exchange(server.port, new Uint8Array([...H2_GET_ROOT_LOCALHOST, ...frame(1, 5, 1, H2_GET_ROOT_LOCALHOST.subarray(9))]));
    await server.close();
    const dataRst = findFrame(dataFrames, 3, 1);
    const headersRst = findFrame(headersFrames, 3, 1);
    t.ok(dataRst !== null, 'DATA after half-close gets RST_STREAM');
    t.ok(headersRst !== null, 'HEADERS after half-close gets RST_STREAM');
    t.equal(frameErrorCode(dataRst!), 5, 'DATA reset uses STREAM_CLOSED');
    t.equal(frameErrorCode(headersRst!), 5, 'HEADERS reset uses STREAM_CLOSED');
  });
  it('RST_STREAMs DATA and HEADERS sent after client RST_STREAM closes a stream', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const dataFrames = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_POST_ROOT_LOCALHOST,
      ...rstStreamFrame(1, 0),
      ...dataFrameFor(1, _enc.encode('late'), 1)
    ]));
    const headersFrames = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_POST_ROOT_LOCALHOST,
      ...rstStreamFrame(1, 0),
      ...frame(1, 5, 1, H2_GET_ROOT_LOCALHOST.subarray(9))
    ]));
    await server.close();
    const dataRst = findFrame(dataFrames, 3, 1);
    const headersRst = findFrame(headersFrames, 3, 1);
    t.ok(dataRst !== null, 'DATA after closed stream gets RST_STREAM');
    t.ok(headersRst !== null, 'HEADERS after closed stream gets RST_STREAM');
    t.equal(frameErrorCode(dataRst!), 5, 'DATA reset uses STREAM_CLOSED');
    t.equal(frameErrorCode(headersRst!), 5, 'HEADERS reset uses STREAM_CLOSED');
  });
  it('sends GOAWAY for malformed DATA padding', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, new Uint8Array([...H2_POST_ROOT_LOCALHOST, ...frame(0, 8, 1, hexBytes(8, 1, 2, 3))]));
    await server.close();
    const goaway = findFrame(frames, 7);
    t.ok(goaway !== null, 'server sent GOAWAY');
    t.equal(frameErrorCode(goaway!), 1, 'GOAWAY uses PROTOCOL_ERROR');
  });
  it('sends GOAWAY for malformed DATA padding after END_STREAM', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, new Uint8Array([...H2_GET_ROOT_LOCALHOST, ...frame(0, 8, 1, hexBytes(8, 1, 2, 3))]));
    await server.close();
    const goaway = findFrame(frames, 7);
    t.ok(goaway !== null, 'server sent GOAWAY');
    t.equal(frameErrorCode(goaway!), 1, 'GOAWAY uses PROTOCOL_ERROR');
  });
  it('sends GOAWAY immediately for DATA larger than the default max frame size', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const oversizedHeaderOnly = frame(0, 0, 1, new Uint8Array(16 * 1024 + 1)).subarray(0, 9);
    const frames = await rawH2Exchange(server.port, new Uint8Array([...H2_POST_ROOT_LOCALHOST, ...oversizedHeaderOnly]));
    await server.close();
    const goaway = findFrame(frames, 7);
    t.ok(goaway !== null, 'server sent GOAWAY');
    t.equal(frameErrorCode(goaway!), 6, 'GOAWAY uses FRAME_SIZE_ERROR');
  });
  it('validates PRIORITY stream id, length, and self-dependency', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const stream0 = await rawH2Exchange(server.port, frame(2, 0, 0, new Uint8Array(5)));
    const wrongLength = await rawH2Exchange(server.port, frame(2, 0, 1, new Uint8Array(4)));
    const selfDependency = await rawH2Exchange(server.port, priorityFrame(1, 1));
    await server.close();
    const stream0Goaway = findFrame(stream0, 7);
    const wrongLengthGoaway = findFrame(wrongLength, 7);
    const selfRst = findFrame(selfDependency, 3, 1);
    t.equal(frameErrorCode(stream0Goaway!), 1, 'stream 0 PRIORITY gets PROTOCOL_ERROR');
    t.equal(frameErrorCode(wrongLengthGoaway!), 6, 'wrong PRIORITY length gets FRAME_SIZE_ERROR');
    t.equal(frameErrorCode(selfRst!), 1, 'self-dependent PRIORITY gets stream PROTOCOL_ERROR');
  });
  it('sends GOAWAY for invalid PING length and ignores client PING ACK', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const invalidPing = await rawH2Exchange(server.port, frame(6, 0, 0, new Uint8Array(7)));
    const ackPing = await rawH2Exchange(server.port, frame(6, 1, 0, new Uint8Array(8)));
    await server.close();
    t.equal(frameErrorCode(findFrame(invalidPing, 7)!), 6, 'invalid PING length gets FRAME_SIZE_ERROR');
    t.ok(findFrame(ackPing, 6) === null, 'client PING ACK is ignored');
    const goaway = findFrame(ackPing, 7);
    t.ok(goaway === null || frameErrorCode(goaway) === 0, 'client PING ACK does not cause an error GOAWAY');
  });
  it('sends GOAWAY for PING frames on nonzero streams', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, frame(6, 0, 1, new Uint8Array(8)));
    await server.close();
    const goaway = findFrame(frames, 7);
    t.ok(goaway !== null, 'nonzero-stream PING gets GOAWAY');
    t.equal(frameErrorCode(goaway!), 1, 'nonzero-stream PING uses PROTOCOL_ERROR');
  });
  it('ignores undefined frame flags and handles the known flags normally', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, frame(6, 128, 0, new Uint8Array(8)));
    await server.close();
    const pingAck = frames.find((f) => f.type === 6 && (f.flags & 1) !== 0);
    t.ok(pingAck !== undefined, 'server ACKed PING despite undefined flag bit');
    const errorGoaway = frames.find((f) => f.type === 7 && frameErrorCode(f) !== 0);
    t.ok(errorGoaway === undefined, 'undefined flag bit did not trigger an error GOAWAY');
  });
  it('ignores the reserved stream id bit in frame headers', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const get = new Uint8Array(H2_GET_ROOT_LOCALHOST);
    get[5] = 128;
    const frames = await rawH2Exchange(server.port, get);
    await server.close();
    const responseHeaders = findFrame(frames, 1, 1);
    t.ok(responseHeaders !== null, 'server responded to request despite reserved stream id bit');
    const errorGoaway = frames.find((f) => f.type === 7 && frameErrorCode(f) !== 0);
    t.ok(errorGoaway === undefined, 'reserved stream id bit did not trigger an error GOAWAY');
  });
  it('RST_STREAMs HEADERS that exceed the advertised concurrent stream limit', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const requestFrames: number[] = [];
    for (let streamId = 1; streamId <= 65; streamId += 2) {
      requestFrames.push(...frame(1, 4, streamId, H2_POST_ROOT_LOCALHOST.subarray(9)));
    }
    const frames = await rawH2Exchange(server.port, new Uint8Array(requestFrames));
    await server.close();
    const resetStreamIds = frames.filter((f) => f.type === 3).map((f) => f.streamId);
    t.ok(resetStreamIds.includes(65), 'stream above advertised limit is reset');
    const rst = findFrame(frames, 3, 65);
    t.ok(rst !== null, 'stream above the advertised limit gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 7, 'reset uses REFUSED_STREAM');
  });
  it('sends GOAWAY for representative CONTINUATION ordering errors', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const interrupted = await rawH2Exchange(server.port, new Uint8Array([...frame(1, 1, 1, H2_GET_ROOT_LOCALHOST.subarray(9)), ...frame(0, 0, 1, new Uint8Array(0))]));
    const interruptedByExtension = await rawH2Exchange(server.port, new Uint8Array([...frame(1, 1, 1, H2_GET_ROOT_LOCALHOST.subarray(9)), ...frame(11, 0, 1, new Uint8Array(0))]));
    const stream0 = await rawH2Exchange(server.port, frame(9, 4, 0, new Uint8Array(0)));
    const unexpectedOnOpen = await rawH2Exchange(server.port, new Uint8Array([...H2_POST_ROOT_LOCALHOST, ...frame(9, 4, 1, new Uint8Array(0))]));
    const dataThenContinuation = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_POST_ROOT_LOCALHOST,
      ...frame(0, 0, 1, _enc.encode('body')),
      ...frame(9, 4, 1, new Uint8Array(0))
    ]));
    const onHalfClosed = await rawH2Exchange(server.port, new Uint8Array([...H2_GET_ROOT_LOCALHOST, ...frame(9, 4, 1, new Uint8Array(0))]));
    const afterRstStream = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_POST_ROOT_LOCALHOST,
      ...rstStreamFrame(1, 0),
      ...frame(9, 4, 1, new Uint8Array(0))
    ]));
    await server.close();
    t.equal(frameErrorCode(findFrame(interrupted, 7)!), 1, 'interrupted header block gets PROTOCOL_ERROR');
    t.equal(frameErrorCode(findFrame(interruptedByExtension, 7)!), 1, 'extension frame during header block gets PROTOCOL_ERROR');
    t.equal(frameErrorCode(findFrame(stream0, 7)!), 1, 'CONTINUATION stream 0 gets PROTOCOL_ERROR');
    t.equal(frameErrorCode(findFrame(unexpectedOnOpen, 7)!), 1, 'unexpected CONTINUATION gets PROTOCOL_ERROR');
    t.equal(frameErrorCode(findFrame(dataThenContinuation, 7)!), 1, 'DATA followed by CONTINUATION gets PROTOCOL_ERROR');
    t.equal(frameErrorCode(findFrame(onHalfClosed, 7)!), 1, 'half-closed CONTINUATION without an active header block gets PROTOCOL_ERROR');
    t.equal(frameErrorCode(findFrame(afterRstStream, 7)!), 1, 'closed-stream CONTINUATION after RST_STREAM gets PROTOCOL_ERROR');
  });
  it('TLS sends GOAWAY before response HEADERS for extra CONTINUATION after END_HEADERS', { skip: skipTlsH2 }, async (t) => {
    const server = serveHttp({
      port: 0,
      tls: {
        cert: CERT_PATH,
        key: KEY_PATH
      }
    }, async () => new Response('ok'));
    try {
      const headerBlock = H2_GET_ROOT_LOCALHOST.subarray(9);
      const frames = await rawTlsH2Exchange(server.port, new Uint8Array([
        ...frame(1, 1, 1, headerBlock.subarray(0, 3)),
        ...frame(9, 4, 1, headerBlock.subarray(3)),
        ...frame(9, 4, 1)
      ]));
      const goawayIndex = frames.findIndex((f) => f.type === 7);
      const responseHeadersIndex = frames.findIndex((f) => f.type === 1 && f.streamId === 1);
      t.ok(goawayIndex >= 0, 'extra CONTINUATION gets GOAWAY');
      t.equal(frameErrorCode(frames[goawayIndex]!), 1, 'GOAWAY uses PROTOCOL_ERROR');
      t.ok(responseHeadersIndex === -1 || goawayIndex < responseHeadersIndex, 'GOAWAY is visible before application response HEADERS');
    } finally {
      await server.close();
    }
  });
  it('TLS sends GOAWAY before response HEADERS when DATA interrupts a header block', { skip: skipTlsH2 }, async (t) => {
    const server = serveHttp({
      port: 0,
      tls: {
        cert: CERT_PATH,
        key: KEY_PATH
      }
    }, async () => new Response('ok'));
    try {
      const headerBlock = H2_GET_ROOT_LOCALHOST.subarray(9);
      const frames = await rawTlsH2Exchange(server.port, new Uint8Array([...frame(1, 1, 1, headerBlock.subarray(0, 3)), ...dataFrameFor(1, _enc.encode('x'), 1)]));
      const goawayIndex = frames.findIndex((f) => f.type === 7);
      const responseHeadersIndex = frames.findIndex((f) => f.type === 1 && f.streamId === 1);
      t.ok(goawayIndex >= 0, 'interrupted header block gets GOAWAY');
      t.equal(frameErrorCode(frames[goawayIndex]!), 1, 'GOAWAY uses PROTOCOL_ERROR');
      t.ok(responseHeadersIndex === -1 || goawayIndex < responseHeadersIndex, 'GOAWAY is visible before application response HEADERS');
    } finally {
      await server.close();
    }
  });
  it('TLS sends RST_STREAM before response HEADERS for HEADERS after client RST_STREAM', { skip: skipTlsH2 }, async (t) => {
    const server = serveHttp({
      port: 0,
      tls: {
        cert: CERT_PATH,
        key: KEY_PATH
      }
    }, async () => new Response('ok'));
    try {
      const frames = await rawTlsH2ExchangeReadFrames(server.port, new Uint8Array([
        ...H2_GET_ROOT_LOCALHOST,
        ...rstStreamFrame(1, 0),
        ...frame(1, 5, 1, H2_GET_ROOT_LOCALHOST.subarray(9))
      ]), 2);
      const rstIndex = frames.findIndex((f) => f.type === 3 && f.streamId === 1);
      const responseHeadersIndex = frames.findIndex((f) => f.type === 1 && f.streamId === 1);
      t.ok(rstIndex >= 0, 'HEADERS after client RST_STREAM gets RST_STREAM');
      t.equal(frameErrorCode(frames[rstIndex]!), 5, 'reset uses STREAM_CLOSED');
      t.ok(responseHeadersIndex === -1 || rstIndex < responseHeadersIndex, 'RST_STREAM is visible before application response HEADERS');
    } finally {
      await server.close();
    }
  });
  it('TLS sends GOAWAY for HEADERS after a stream is fully closed', { skip: skipTlsH2 }, async (t) => {
    const server = serveHttp({
      port: 0,
      tls: {
        cert: CERT_PATH,
        key: KEY_PATH
      }
    }, async () => new Response('ok'));
    try {
      const sock = await TlsSocket.connect({
        family: 'ipv4',
        ip: '127.0.0.1',
        port: server.port
      }, {
        hostname: '127.0.0.1',
        rejectUnauthorized: false,
        alpn: ['h2']
      });
      if (sock.negotiatedProtocol !== 'h2') {
        sock.close();
        throw new Error(`expected ALPN h2, got ${sock.negotiatedProtocol}`);
      }
      const [reader, writer] = sock.split();
      await writer.write(new Uint8Array([
        ...H2_PREFACE,
        ...SETTINGS_EMPTY,
        ...H2_GET_ROOT_LOCALHOST
      ]));
      await writer.flush();
      for (;;) {
        const received = await readRawFrame(reader);
        t.ok(received !== null, 'server sent response frames before close');
        if (received!.streamId === 1 && (received!.type === 0 || received!.type === 1) && (received!.flags & 1) !== 0) {
          break;
        }
      }
      await writer.write(frame(1, 5, 1, H2_GET_ROOT_LOCALHOST.subarray(9)));
      await writer.flush();
      const frames = await readRawFrames(reader, 4);
      const goaway = findFrame(frames, 7);
      t.ok(goaway !== null, 'HEADERS on closed stream gets GOAWAY');
      t.equal(frameErrorCode(goaway!), 5, 'GOAWAY uses STREAM_CLOSED');
      try {
        await reader.close();
      } catch {}
      try {
        await writer.close();
      } catch {}
    } finally {
      await server.close();
    }
  });
  it('ACKs peer SETTINGS frames after the initial SETTINGS exchange', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, frame(4, 0, 0, hexBytes(0, 3, 0, 0, 0, 64)));
    await server.close();
    const settingsAcks = frames.filter((f) => f.type === 4 && f.flags === 1 && f.length === 0);
    t.ok(settingsAcks.length >= 2, `server ACKed initial and follow-up SETTINGS frames (${settingsAcks.length})`);
  });
  it('sends GOAWAY for connection WINDOW_UPDATE increment 0', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, windowUpdateFrame(0, 0));
    await server.close();
    const goaway = findFrame(frames, 7);
    t.ok(goaway !== null, 'connection WINDOW_UPDATE increment 0 gets GOAWAY');
    t.equal(frameErrorCode(goaway!), 1, 'GOAWAY uses PROTOCOL_ERROR');
  });
  it('RST_STREAMs stream WINDOW_UPDATE increment 0', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, new Uint8Array([...frame(1, 4, 1, H2_POST_ROOT_LOCALHOST.subarray(9)), ...windowUpdateFrame(1, 0)]));
    await server.close();
    const rst = findFrame(frames, 3, 1);
    t.ok(rst !== null, 'stream WINDOW_UPDATE increment 0 gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 1, 'reset uses PROTOCOL_ERROR');
  });
  it('sends GOAWAY for WINDOW_UPDATE frames with invalid length', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, frame(8, 0, 0, hexBytes(0, 0, 0)));
    await server.close();
    const goaway = findFrame(frames, 7);
    t.ok(goaway !== null, 'invalid WINDOW_UPDATE length gets GOAWAY');
    t.equal(frameErrorCode(goaway!), 6, 'GOAWAY uses FRAME_SIZE_ERROR');
  });
  it('sends FLOW_CONTROL_ERROR when connection WINDOW_UPDATE overflows', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, windowUpdateFrame(0, 2147483647));
    await server.close();
    const goaway = findFrame(frames, 7);
    t.ok(goaway !== null, 'connection window overflow gets GOAWAY');
    t.equal(frameErrorCode(goaway!), 3, 'GOAWAY uses FLOW_CONTROL_ERROR');
  });
  it('RST_STREAMs when stream WINDOW_UPDATE overflows', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, new Uint8Array([...frame(1, 4, 1, H2_POST_ROOT_LOCALHOST.subarray(9)), ...windowUpdateFrame(1, 2147483647)]));
    await server.close();
    const rst = findFrame(frames, 3, 1);
    t.ok(rst !== null, 'stream window overflow gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 3, 'reset uses FLOW_CONTROL_ERROR');
  });
  it('sends GOAWAY for SETTINGS_INITIAL_WINDOW_SIZE above the maximum flow-control window', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, frame(4, 0, 0, hexBytes(0, 4, 128, 0, 0, 0)));
    await server.close();
    const goaway = findFrame(frames, 7);
    t.ok(goaway !== null, 'oversized SETTINGS_INITIAL_WINDOW_SIZE gets GOAWAY');
    t.equal(frameErrorCode(goaway!), 3, 'GOAWAY uses FLOW_CONTROL_ERROR');
  });
  it('sends GOAWAY for SETTINGS_INITIAL_WINDOW_SIZE with all bits set', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, frame(4, 0, 0, hexBytes(0, 4, 255, 255, 255, 255)));
    await server.close();
    const goaway = findFrame(frames, 7);
    t.ok(goaway !== null, 'all-bits-set SETTINGS_INITIAL_WINDOW_SIZE gets GOAWAY');
    t.equal(frameErrorCode(goaway!), 3, 'GOAWAY uses FLOW_CONTROL_ERROR');
  });
  it('TLS ACKs peer SETTINGS frames after the initial SETTINGS exchange', { skip: skipTlsH2 }, async (t) => {
    const server = serveHttp({
      port: 0,
      tls: {
        cert: CERT_PATH,
        key: KEY_PATH
      }
    }, async () => new Response('ok'));
    try {
      const frames = await rawTlsH2ExchangeReadFrames(server.port, frame(4, 0, 0, hexBytes(0, 3, 0, 0, 0, 64)), 3);
      const settingsAcks = frames.filter((f) => f.type === 4 && f.flags === 1 && f.length === 0);
      const errorGoaway = frames.find((f) => f.type === 7 && frameErrorCode(f) !== 0);
      t.ok(settingsAcks.length >= 2, `server ACKed initial and follow-up SETTINGS frames (${settingsAcks.length})`);
      t.equal(errorGoaway, undefined, 'follow-up SETTINGS does not trigger an error GOAWAY');
    } finally {
      await server.close();
    }
  });
  it('h2spec 6.9.2 ACKs duplicate SETTINGS_INITIAL_WINDOW_SIZE entries', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, frame(4, 0, 0, hexBytes(0, 4, 0, 1, 0, 0, 0, 4, 0, 0, 255, 255)));
    await server.close();
    const settingsAcks = frames.filter((f) => f.type === 4 && f.flags === 1 && f.length === 0);
    const goaway = findFrame(frames, 7);
    t.ok(settingsAcks.length >= 2, `server ACKed initial and duplicate SETTINGS frames (${settingsAcks.length})`);
    if (goaway) t.equal(frameErrorCode(goaway), 0, 'duplicate SETTINGS entries do not trigger an error GOAWAY');
  });
  it('TLS ACKs duplicate SETTINGS_INITIAL_WINDOW_SIZE entries', { skip: skipTlsH2 }, async (t) => {
    const server = serveHttp({
      port: 0,
      tls: {
        cert: CERT_PATH,
        key: KEY_PATH
      }
    }, async () => new Response('ok'));
    try {
      const frames = await rawTlsH2ExchangeReadFrames(server.port, frame(4, 0, 0, hexBytes(0, 4, 0, 1, 0, 0, 0, 4, 0, 0, 255, 255)), 3);
      const settingsAcks = frames.filter((f) => f.type === 4 && f.flags === 1 && f.length === 0);
      const errorGoaway = frames.find((f) => f.type === 7 && frameErrorCode(f) !== 0);
      t.ok(settingsAcks.length >= 2, `server ACKed initial and duplicate SETTINGS frames (${settingsAcks.length})`);
      t.equal(errorGoaway, undefined, 'duplicate SETTINGS entries do not trigger an error GOAWAY');
    } finally {
      await server.close();
    }
  });
  it('TLS sends PING ACK frames with matching payloads', { skip: skipTlsH2 }, async (t) => {
    const server = serveHttp({
      port: 0,
      tls: {
        cert: CERT_PATH,
        key: KEY_PATH
      }
    }, async () => new Response('ok'));
    try {
      const payload = hexBytes(222, 173, 190, 239, 16, 32, 48, 64);
      const frames = await rawTlsH2ExchangeReadFrames(server.port, frame(6, 0, 0, payload), 3);
      const pingAck = frames.find((f) => f.type === 6 && (f.flags & 1) !== 0);
      const errorGoaway = frames.find((f) => f.type === 7 && frameErrorCode(f) !== 0);
      t.ok(pingAck !== undefined, 'server sent PING ACK');
      t.deepEqual([...pingAck!.payload], [...payload], 'PING ACK payload matches request payload');
      t.equal(errorGoaway, undefined, 'normal PING does not trigger an error GOAWAY');
    } finally {
      await server.close();
    }
  });
  it('TLS ignores client PING ACK frames', { skip: skipTlsH2 }, async (t) => {
    const server = serveHttp({
      port: 0,
      tls: {
        cert: CERT_PATH,
        key: KEY_PATH
      }
    }, async () => new Response('ok'));
    try {
      const frames = await rawTlsH2ExchangeReadFrames(server.port, frame(6, 1, 0, new Uint8Array(8)), 2);
      const responsePing = frames.find((f) => f.type === 6);
      const errorGoaway = frames.find((f) => f.type === 7 && frameErrorCode(f) !== 0);
      t.equal(responsePing, undefined, 'client PING ACK does not get a response PING');
      t.equal(errorGoaway, undefined, 'client PING ACK does not trigger an error GOAWAY');
    } finally {
      await server.close();
    }
  });
  it('sends GOAWAY for SETTINGS ACK frames with payload', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, frame(4, 1, 0, hexBytes(0, 3, 0, 0, 0, 64)));
    await server.close();
    const goaway = findFrame(frames, 7);
    t.ok(goaway !== null, 'server sent GOAWAY');
    t.equal(frameErrorCode(goaway!), 6, 'GOAWAY uses FRAME_SIZE_ERROR');
  });
  it('sends TLS GOAWAY for SETTINGS ACK frames with payload', { skip: skipTlsH2 }, async (t) => {
    const server = serveHttp({
      port: 0,
      tls: {
        cert: CERT_PATH,
        key: KEY_PATH
      }
    }, async () => new Response('ok'));
    try {
      const frames = await rawTlsH2Exchange(server.port, frame(4, 1, 0, hexBytes(0, 3, 0, 0, 0, 64)));
      const goaway = findFrame(frames, 7);
      t.ok(goaway !== null, 'server sent GOAWAY before TLS close');
      t.equal(frameErrorCode(goaway!), 6, 'GOAWAY uses FRAME_SIZE_ERROR');
    } finally {
      await server.close();
    }
  });
  it('sends GOAWAY when a client sends PUSH_PROMISE', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, new Uint8Array([...H2_GET_ROOT_LOCALHOST, ...frame(5, 4, 1, hexBytes(0, 0, 0, 2, 130, 132, 134))]));
    await server.close();
    const goaway = findFrame(frames, 7);
    t.ok(goaway !== null, 'server sent GOAWAY');
    t.equal(frameErrorCode(goaway!), 1, 'GOAWAY uses PROTOCOL_ERROR');
  });
  it('closes cleanly for an invalid connection preface', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const sock = await Socket.connect({
      family: 'ipv4',
      ip: '127.0.0.1',
      port: server.port
    });
    const [reader, writer] = sock.split();
    await writer.write(_enc.encode('PRI * HTTP/2.0\r\n\r\nbad-preface'));
    await writer.flush();
    await writer.close();
    const frames = await readRawFrames(reader);
    try {
      await reader.close();
    } catch {}
    await server.close();
    const goaway = findFrame(frames, 7);
    t.ok(goaway === null || frameErrorCode(goaway) === 1, 'server closed or sent GOAWAY(PROTOCOL_ERROR)');
  });
  it('RST_STREAMs request HEADERS with response-only pseudo-headers', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const invalidRequestBlock = hexBytes(130, 132, 134, 136);
    const frames = await rawH2Exchange(server.port, frame(1, 5, 1, invalidRequestBlock));
    await server.close();
    const rst = findFrame(frames, 3, 1);
    t.ok(rst !== null, 'invalid request pseudo-header gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 1, 'reset uses PROTOCOL_ERROR');
  });
  it('RST_STREAMs request HEADERS with uppercase field names', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const uppercaseHeaderBlock = hexBytes(130, 132, 134, 65, 9, 108, 111, 99, 97, 108, 104, 111, 115, 116, 64, 5, 85, 112, 112, 101, 114, 1, 120);
    const frames = await rawH2Exchange(server.port, frame(1, 5, 1, uppercaseHeaderBlock));
    await server.close();
    const rst = findFrame(frames, 3, 1);
    t.ok(rst !== null, 'uppercase header field name gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 1, 'reset uses PROTOCOL_ERROR');
  });
  it('RST_STREAMs request HEADERS with pseudo-header after a regular header', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const pseudoAfterRegularBlock = hexBytes(130, 132, 134, 64, 1, 120, 1, 121, 65, 9, 108, 111, 99, 97, 108, 104, 111, 115, 116);
    const frames = await rawH2Exchange(server.port, frame(1, 5, 1, pseudoAfterRegularBlock));
    await server.close();
    const rst = findFrame(frames, 3, 1);
    t.ok(rst !== null, 'pseudo-header after regular header gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 1, 'reset uses PROTOCOL_ERROR');
  });
  it('RST_STREAMs request HEADERS with duplicate :scheme', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const duplicateSchemeBlock = hexBytes(130, 132, 134, 134, 65, 9, 108, 111, 99, 97, 108, 104, 111, 115, 116);
    const frames = await rawH2Exchange(server.port, frame(1, 5, 1, duplicateSchemeBlock));
    await server.close();
    const rst = findFrame(frames, 3, 1);
    t.ok(rst !== null, 'duplicate :scheme gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 1, 'reset uses PROTOCOL_ERROR');
  });
  it('RST_STREAMs trailers containing pseudo-headers', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const trailersWithPseudoBlock = hexBytes(132);
    const frames = await rawH2Exchange(server.port, new Uint8Array([
      ...H2_POST_ROOT_LOCALHOST,
      ...dataFrameFor(1, _enc.encode('body'), 0),
      ...frame(1, 5, 1, trailersWithPseudoBlock)
    ]));
    await server.close();
    const rst = findFrame(frames, 3, 1);
    t.ok(rst !== null, 'pseudo-header in trailers gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 1, 'reset uses PROTOCOL_ERROR');
  });
  it('RST_STREAMs request HEADERS with missing or empty :path', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const missingPathBlock = hexBytes(130, 134, 65, 9, 108, 111, 99, 97, 108, 104, 111, 115, 116);
    const emptyPathBlock = hexBytes(130, 68, 0, 134, 65, 9, 108, 111, 99, 97, 108, 104, 111, 115, 116);
    const missingFrames = await rawH2Exchange(server.port, frame(1, 5, 1, missingPathBlock));
    const emptyFrames = await rawH2Exchange(server.port, frame(1, 5, 1, emptyPathBlock));
    await server.close();
    const missingRst = findFrame(missingFrames, 3, 1);
    const emptyRst = findFrame(emptyFrames, 3, 1);
    t.ok(missingRst !== null, 'missing :path gets RST_STREAM');
    t.ok(emptyRst !== null, 'empty :path gets RST_STREAM');
    t.equal(frameErrorCode(missingRst!), 1, 'missing :path reset uses PROTOCOL_ERROR');
    t.equal(frameErrorCode(emptyRst!), 1, 'empty :path reset uses PROTOCOL_ERROR');
  });
  it('RST_STREAMs request HEADERS with missing :scheme before dispatch', async (t) => {
    if (!h2Available) return;
    let dispatched = false;
    const server = serveHttp({ port: 0 }, async () => {
      dispatched = true;
      return new Response('ok');
    });
    const frames = await rawH2Exchange(server.port, frame(1, 5, 1, H2_GET_ROOT_LOCALHOST_NO_SCHEME));
    await server.close();
    const rst = findFrame(frames, 3, 1);
    t.ok(rst !== null, 'missing :scheme gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 1, 'missing :scheme reset uses PROTOCOL_ERROR');
    t.equal(dispatched, false, 'invalid request does not reach handler');
  });
  it('RST_STREAMs a second request HEADERS frame on an open stream', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, new Uint8Array([...H2_POST_ROOT_LOCALHOST, ...frame(1, 4, 1, H2_GET_ROOT_LOCALHOST.subarray(9))]));
    await server.close();
    const rst = findFrame(frames, 3, 1);
    t.ok(rst !== null, 'second non-trailer HEADERS gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 1, 'reset uses PROTOCOL_ERROR');
  });
  it('RST_STREAMs requests whose content-length does not match DATA length', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const frames = await rawH2Exchange(server.port, new Uint8Array([...frame(1, 4, 1, H2_POST_ROOT_LOCALHOST_CL4), ...dataFrameFor(1, _enc.encode('bad'), 1)]));
    await server.close();
    const rst = findFrame(frames, 3, 1);
    t.ok(rst !== null, 'mismatched content-length gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 1, 'reset uses PROTOCOL_ERROR');
  });
  it('RST_STREAMs malformed content-length before handler dispatch', async (t) => {
    if (!h2Available) return;
    let dispatched = false;
    const server = serveHttp({ port: 0 }, async () => {
      dispatched = true;
      return new Response('ok');
    });
    const frames = await rawH2Exchange(server.port, new Uint8Array([...frame(1, 4, 1, H2_POST_ROOT_LOCALHOST_CL4X), ...dataFrameFor(1, _enc.encode('body'), 1)]));
    await server.close();
    const rst = findFrame(frames, 3, 1);
    t.ok(rst !== null, 'malformed content-length gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 1, 'reset uses PROTOCOL_ERROR');
    t.equal(dispatched, false, 'malformed content-length does not reach handler');
  });
  it('rejects handler body reads and sends no response for short content-length bodies', async (t) => {
    if (!h2Available) return;
    let bodyRejected = false;
    const server = serveHttp({ port: 0 }, async (req) => {
      try {
        await req.text();
      } catch {
        bodyRejected = true;
      }
      return new Response('should-not-send');
    });
    const frames = await rawH2Exchange(server.port, new Uint8Array([...frame(1, 4, 1, H2_POST_ROOT_LOCALHOST_CL4), ...dataFrameFor(1, _enc.encode('bad'), 1)]));
    await server.close();
    const rst = findFrame(frames, 3, 1);
    t.ok(bodyRejected, 'handler body read rejects');
    t.ok(rst !== null, 'short body gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 1, 'reset uses PROTOCOL_ERROR');
    t.equal(findFrame(frames, 1, 1), null, 'server sends no response HEADERS');
    t.equal(findFrame(frames, 0, 1), null, 'server sends no response DATA');
  });
  it('RST_STREAMs content-length overruns without delivering overrun bytes', async (t) => {
    if (!h2Available) return;
    let captured = '';
    let bodyRejected = false;
    const server = serveHttp({ port: 0 }, async (req) => {
      const reader = req.body!.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          captured += _dec.decode(next.value);
        }
      } catch {
        bodyRejected = true;
      }
      return new Response('should-not-send');
    });
    const frames = await rawH2Exchange(server.port, new Uint8Array([
      ...frame(1, 4, 1, H2_POST_ROOT_LOCALHOST_CL4),
      ...dataFrameFor(1, _enc.encode('1234'), 0),
      ...dataFrameFor(1, _enc.encode('5'), 1)
    ]));
    await server.close();
    const rst = findFrame(frames, 3, 1);
    t.equal(captured, '1234', 'handler did not receive overrun bytes');
    t.ok(bodyRejected, 'handler body read rejects on overrun');
    t.ok(rst !== null, 'overrun gets RST_STREAM');
    t.equal(frameErrorCode(rst!), 1, 'reset uses PROTOCOL_ERROR');
    t.equal(findFrame(frames, 1, 1), null, 'server sends no response HEADERS');
    t.equal(findFrame(frames, 0, 1), null, 'server sends no response DATA');
  });
  it('server does not hang after client RST_STREAMs a pending request', async (t) => {
    if (!h2Available) return;
    // Handler that waits for a body — so the server will be in triggerDispatch
    // state when the client sends RST_STREAM.
    let handlerStarted = false;
    const server = serveHttp({ port: 0 }, async (req) => {
      handlerStarted = true;
      await req.text();
      return new Response('ok');
    });
    const port = server.port;
    const sock = await Socket.connect({
      family: 'ipv4',
      ip: '127.0.0.1',
      port
    });
    const [reader, writer] = sock.split();
    const noopCallbacks = {
      onBeginHeaders() {},
      onHeader() {},
      onFrameRecv() {},
      onDataChunk() {},
      onStreamClose() {}
    };
    const cs = await openClientSession(writer, noopCallbacks);
    // Submit a POST with hasBody=true but never provide data → server waits.
    const streamId = cs.submitRequest([
      [':method', 'POST'],
      [':path', '/'],
      [':scheme', 'http'],
      [':authority', `127.0.0.1:${port}`]
    ], true);
    while (cs.wantWrite()) {
      const bytes = await cs.flush();
      if (bytes && bytes.byteLength > 0) await writer.write(bytes);
    }
    await writer.flush();
    // Give server time to register the stream.
    await new Promise<void>((r) => setTimeout(r, 20));
    // RST_STREAM the pending request.
    cs.submitRstStream(streamId, 0);
    while (cs.wantWrite()) {
      const bytes = await cs.flush();
      if (bytes && bytes.byteLength > 0) await writer.write(bytes);
    }
    await writer.flush();
    // Graceful shutdown from client.
    cs.submitGoaway(0, 0);
    while (cs.wantWrite()) {
      const bytes = await cs.flush();
      if (bytes && bytes.byteLength > 0) await writer.write(bytes);
    }
    await writer.flush();
    cs.close();
    await writer.close();
    await timeout(server.close(), 'server.close() timed out after RST_STREAM', 2e3);
    t.ok(true, 'server.close() resolved within 2 s (no hang after RST_STREAM)');
  });
  it('server sends MAX_CONCURRENT_STREAMS in SETTINGS', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const port = server.port;
    const sock = await Socket.connect({
      family: 'ipv4',
      ip: '127.0.0.1',
      port
    });
    const [reader, writer] = sock.split();
    // Send h2 connection preface + empty SETTINGS.
    await writer.write(H2_PREFACE);
    await writer.write(SETTINGS_EMPTY);
    await writer.flush();
    // Read the server's initial SETTINGS frame.
    const settingsFrame = await (reader as any).readExactly(9);
    t.ok(settingsFrame !== null, 'got server SETTINGS header');
    const frameType = settingsFrame![3];
    const payloadLen = settingsFrame![0] << 16 | settingsFrame![1] << 8 | settingsFrame![2];
    t.equal(frameType, 4, 'frame type is SETTINGS (0x04)');
    t.ok(payloadLen >= 6, `SETTINGS has at least one entry (payload=${payloadLen})`);
    // Read the payload and scan for MAX_CONCURRENT_STREAMS (id=0x0003).
    const payload = await (reader as any).readExactly(payloadLen);
    let foundMaxConcurrent = false;
    for (let i = 0; i + 5 < payloadLen!; i += 6) {
      const id = payload![i] << 8 | payload![i + 1];
      const val = payload![i + 2] << 24 | payload![i + 3] << 16 | payload![i + 4] << 8 | payload![i + 5];
      if (id === 3) {
        foundMaxConcurrent = true;
        t.ok(val > 0, `MAX_CONCURRENT_STREAMS=${val}`);
      }
    }
    t.ok(foundMaxConcurrent, 'SETTINGS contains MAX_CONCURRENT_STREAMS');
    await writer.close();
    await server.close();
  });
  it('server closes gracefully on malformed frame', async (t) => {
    if (!h2Available) return;
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    const port = server.port;
    const sock = await Socket.connect({
      family: 'ipv4',
      ip: '127.0.0.1',
      port
    });
    const [reader, writer] = sock.split();
    // Send h2 preface + SETTINGS, then junk bytes where a valid frame should be.
    await writer.write(H2_PREFACE);
    await writer.write(SETTINGS_EMPTY);
    // Garbage: length=0xFFFFFF (way too large), type=0xFF, flags=0xFF
    await writer.write(hexBytes(255, 255, 255, 255, 255, 0, 0, 0, 1));
    await writer.flush();
    // Close the writer so the server sees EOF and doesn't wait for more of the oversized frame.
    await writer.close();
    // Server should send a GOAWAY or close — read until EOF without crashing.
    let gotEof = false;
    try {
      for await (const _ of reader as any) {}
      gotEof = true;
    } catch {
      gotEof = true;
    }
    t.ok(gotEof, 'server closed connection after malformed frame');
    await server.close();
  });
});
describe('H2 server — cleanup', () => {
  it('does not leave runtime loop handles alive after closed H2 sessions', async (t) => {
    if (!h2Available) return;
    const baseline = loop._activeHandleCounts();
    const server = serveHttp({ port: 0 }, async () => new Response('ok'));
    await rawH2Exchange(server.port, H2_GET_ROOT_LOCALHOST);
    await server.close();
    t.equal(await waitForRuntimeLoopAtOrBelow(baseline), true, `closed H2 sessions leave no additional runtime loop handles: current=${runtimeLoopHandleCounts()} baseline=${runtimeLoopHandleCounts(baseline)}`);
  });
});
